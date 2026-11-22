'use strict';

const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');

process.env.TLS_STATE_DIR = '/tmp/hostship-tls-selftest-' + process.pid;

const { classifyPrefix, parseClientHelloSni } = require('./hostship-mux.js');
const { ensureTlsCertificate, tlsWsUri } = require('./hostship-tls.js');

function assert(condition, message) {
  if (!condition) throw new Error('SELF_TEST_FAILED ' + message);
}

async function captureClientHello(servername) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      socket.once('data', data => {
        resolve(data);
        socket.destroy();
        server.close();
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const client = tls.connect({
        host: '127.0.0.1',
        port,
        servername,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1']
      });
      client.on('error', () => {});
    });
  });
}

async function main() {
  assert(classifyPrefix(Buffer.from('GET /')).type === 'http', 'HTTP detection');
  assert(classifyPrefix(Buffer.from([0x01, 0x02, 0x03])).type === 'raw', 'raw detection');

  const hello = await captureClientHello('hostship-tls.invalid');
  const parsed = parseClientHelloSni(hello);
  assert(parsed && parsed.complete, 'TLS ClientHello parse');
  assert(parsed.sni === 'hostship-tls.invalid', 'TLS SNI extraction');
  const classified = classifyPrefix(hello);
  assert(classified && classified.type === 'tls', 'TLS classification');
  assert(classified.sni === 'hostship-tls.invalid', 'TLS classification SNI');

  const cert = await ensureTlsCertificate('hostship-tls.invalid');
  assert(/^[0-9a-f]{64}$/.test(cert.fingerprint), 'TLS certificate fingerprint');

  const uri = tlsWsUri({
    uuid: '1f7672c8-d15a-4174-a244-3a3e42b6e35b',
    wsPath: '/ws-test',
    publicHost: '45.131.65.244',
    publicPort: 30376,
    sni: cert.sni,
    fingerprint: cert.fingerprint,
    label: 'DE-HostShip-01-TLS-WS'
  });
  assert(uri.includes('security=tls'), 'TLS URI security');
  assert(uri.includes('type=ws'), 'TLS URI transport');
  assert(uri.includes('pcs=' + cert.fingerprint), 'TLS URI certificate pin');
  assert(!uri.includes('allowInsecure'), 'TLS URI must not use allowInsecure');

  fs.rmSync(process.env.TLS_STATE_DIR, { recursive: true, force: true });
  console.log('SELF_TEST_OK mux_tls_sni=yes cert_pin=yes tls_uri=yes');
}

main().catch(error => {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
});
