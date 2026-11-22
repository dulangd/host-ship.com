'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOME = process.env.HOME || '/home/container';
const STATE_DIR = path.resolve(process.env.TLS_STATE_DIR || path.join(HOME, '.hostship-node', 'tls'));
const KEY_FILE = path.join(STATE_DIR, 'key.pem');
const CERT_FILE = path.join(STATE_DIR, 'cert.pem');
const META_FILE = path.join(STATE_DIR, 'meta.json');

function validSni(value) {
  const sni = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(sni) || !sni.includes('.')) {
    throw new Error('invalid TLS_SNI');
  }
  return sni;
}

async function privateWrite(file, content, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, content, { mode });
  await fsp.rename(tmp, file);
  try { await fsp.chmod(file, mode); } catch {}
}

function certificateFingerprint(certPem) {
  const cert = new crypto.X509Certificate(certPem);
  return crypto.createHash('sha256').update(cert.raw).digest('hex');
}

function generateCertificate(sni) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const configFile = path.join(STATE_DIR, 'openssl.cnf');
  const config = [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3_req',
    'prompt = no',
    '',
    '[dn]',
    'CN = ' + sni,
    '',
    '[v3_req]',
    'basicConstraints = critical,CA:FALSE',
    'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = @alt_names',
    '',
    '[alt_names]',
    'DNS.1 = ' + sni,
    ''
  ].join('\n');
  fs.writeFileSync(configFile, config, { mode: 0o600 });

  const result = spawnSync('openssl', [
    'req', '-x509',
    '-newkey', 'rsa:2048',
    '-sha256',
    '-nodes',
    '-days', '3650',
    '-config', configFile,
    '-keyout', KEY_FILE,
    '-out', CERT_FILE
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000
  });

  try { fs.rmSync(configFile, { force: true }); } catch {}

  if (result.error) throw new Error('openssl unavailable: ' + result.error.message);
  if (result.status !== 0) {
    throw new Error('openssl certificate generation failed: ' + String(result.stderr || '').trim().slice(-1000));
  }

  try { fs.chmodSync(KEY_FILE, 0o600); } catch {}
  try { fs.chmodSync(CERT_FILE, 0o600); } catch {}
}

async function ensureTlsCertificate(rawSni) {
  const sni = validSni(rawSni);
  let regenerate = false;

  try {
    const meta = JSON.parse(await fsp.readFile(META_FILE, 'utf8'));
    if (String(meta.sni || '').toLowerCase() !== sni) regenerate = true;
    if (!fs.existsSync(KEY_FILE) || !fs.existsSync(CERT_FILE)) regenerate = true;
  } catch {
    regenerate = true;
  }

  if (regenerate) {
    await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    generateCertificate(sni);
  }

  const key = await fsp.readFile(KEY_FILE, 'utf8');
  const cert = await fsp.readFile(CERT_FILE, 'utf8');
  const x509 = new crypto.X509Certificate(cert);
  if (!String(x509.subjectAltName || '').toLowerCase().includes('dns:' + sni)) {
    generateCertificate(sni);
  }

  const finalKey = await fsp.readFile(KEY_FILE, 'utf8');
  const finalCert = await fsp.readFile(CERT_FILE, 'utf8');
  const fingerprint = certificateFingerprint(finalCert);
  await privateWrite(
    META_FILE,
    JSON.stringify({ sni, fingerprintSha256: fingerprint }, null, 2) + '\n'
  );

  console.log('TLS_CERT_READY sni=' + sni + ' sha256=' + fingerprint);
  return { sni, key: finalKey, cert: finalCert, fingerprint };
}

function authority(host) {
  return net.isIP(host) === 6 ? '[' + host + ']' : host;
}

function tlsWsUri({ uuid, wsPath, publicHost, publicPort, sni, fingerprint, label }) {
  const query = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni,
    fp: 'chrome',
    alpn: 'http/1.1',
    pcs: fingerprint,
    vcn: sni,
    type: 'ws',
    path: wsPath,
    host: publicHost
  });
  return (
    'vless://' + uuid + '@' + authority(publicHost) + ':' + publicPort +
    '?' + query.toString() + '#' + encodeURIComponent(label || 'HostShip-01-TLS-WS')
  );
}

async function startTlsBackend({ listenPort, backendPort, sni }) {
  const certInfo = await ensureTlsCertificate(sni);
  const server = tls.createServer({
    key: certInfo.key,
    cert: certInfo.cert,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ALPNProtocols: ['http/1.1']
  }, socket => {
    socket.setNoDelay(true);
    const backend = net.createConnection({ host: '127.0.0.1', port: backendPort });
    backend.once('connect', () => {
      socket.pipe(backend);
      backend.pipe(socket);
    });
    backend.on('error', () => socket.destroy());
    socket.on('error', () => backend.destroy());
    socket.on('close', () => backend.destroy());
  });

  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', resolve);
  });

  console.log(
    'TLS_BACKEND_READY listen=127.0.0.1:' + listenPort +
    ' backend=127.0.0.1:' + backendPort +
    ' sni=' + certInfo.sni
  );
  return { server, ...certInfo };
}

module.exports = {
  ensureTlsCertificate,
  startTlsBackend,
  tlsWsUri
};
