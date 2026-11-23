'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { HostShipMux } = require('./hostship-mux.js');
const { startReality } = require('./hostship-reality.js');
const { startTlsBackend, tlsWsUri } = require('./hostship-tls.js');
const { startCloudflareTunnel, cfWsUri, normalizeHostname } = require('./hostship-cloudflare.js');

const HOME = process.env.HOME || '/home/container';
const STATE_DIR = path.resolve(process.env.STATE_DIR || path.join(HOME, '.hostship-node'));
const IDENTITY_FILE = path.join(STATE_DIR, 'identity.json');
const PUBLIC_HOST = String(process.env.PUBLIC_HOST || '45.131.65.244').trim();
const PUBLIC_PORT = validPort(process.env.SERVER_PORT || process.env.PORT || '30376', 'SERVER_PORT');
const TLS_SNI = String(process.env.TLS_SNI || 'hostship-tls.invalid').trim().toLowerCase();
const CF_ORIGIN_PORT = validPort(process.env.CF_ORIGIN_PORT || '18080', 'CF_ORIGIN_PORT');
const CF_CONFIG_FILE = path.join(STATE_DIR, 'cloudflare.json');

function validPort(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(label + ' must be a TCP port in 1..65535');
  }
  return value;
}

function loadCloudflareConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CF_CONFIG_FILE, 'utf8'));
    try { fs.chmodSync(CF_CONFIG_FILE, 0o600); } catch {}
    return {
      token: String(parsed.token || '').trim(),
      hostname: normalizeHostname(parsed.hostname || '')
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { token: '', hostname: '' };
    throw new Error('Cloudflare config file is invalid; check .hostship-node/cloudflare.json');
  }
}

function normalizePath(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('WebSocket path cannot be empty');
  return raw.startsWith('/') ? raw : '/' + raw;
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function ensureIdentity() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  let old = {};
  try { old = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8')); } catch {}

  const identity = {
    uuid: process.env.UUID || old.uuid || crypto.randomUUID(),
    wsPath: normalizePath(process.env.WSPATH || old.wsPath || '/ws-' + randomToken(9)),
    subToken: process.env.SUB_TOKEN || old.subToken || randomToken(24),
    nodeId: process.env.NODE_ID || old.nodeId || 'hostship-01-native'
  };

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.uuid)) {
    throw new Error('persisted WS UUID is invalid');
  }
  if (identity.subToken.length < 20) throw new Error('persisted subscription token is invalid');

  const tmp = IDENTITY_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, IDENTITY_FILE);
  try { fs.chmodSync(IDENTITY_FILE, 0o600); } catch {}
  return identity;
}

function reservePort(excluded) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = Number(server.address().port);
      server.close(error => {
        if (error) return reject(error);
        if (excluded.has(port)) return reservePort(excluded).then(resolve, reject);
        excluded.add(port);
        resolve(port);
      });
    });
  });
}

function waitForPort(port, child, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      if (child.exitCode !== null) {
        reject(new Error('backend exited before listening; code=' + child.exitCode));
        return;
      }
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        socket.destroy();
        if (ok) return resolve();
        if (Date.now() >= deadline) return reject(new Error('backend listen timeout'));
        setTimeout(attempt, 150);
      };
      socket.setTimeout(700);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    };
    attempt();
  });
}

async function detectCountry() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      headers: { 'user-agent': 'hostship-bootstrap/2.0' },
      signal: ctl.signal
    });
    if (!response.ok) return '';
    const text = await response.text();
    const match = text.match(/(?:^|\n)loc=([A-Z]{2})(?:\n|$)/);
    return match ? match[1] : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Host-Ship multi-node mode requires Linux x86_64');
  }
  if (!PUBLIC_HOST) throw new Error('PUBLIC_HOST is empty');

  const identity = ensureIdentity();
  const cfFileConfig = loadCloudflareConfig();
  const CF_TUNNEL_TOKEN = String(process.env.CF_TUNNEL_TOKEN || cfFileConfig.token || '').trim();
  const CF_TUNNEL_HOSTNAME = normalizeHostname(
    process.env.CF_TUNNEL_HOSTNAME || cfFileConfig.hostname || ''
  );
  const country = await detectCountry();
  const prefix = country ? country + '-' : '';
  const realityLabel = prefix + 'HostShip-01-Reality';
  const tlsLabel = prefix + 'HostShip-01-TLS-WS';
  const cfLabel = prefix + 'HostShip-01-CF-Tunnel';

  if (CF_ORIGIN_PORT === PUBLIC_PORT) {
    throw new Error('CF_ORIGIN_PORT must differ from public allocation');
  }
  const excluded = new Set([PUBLIC_PORT, CF_ORIGIN_PORT]);
  const realityPort = await reservePort(excluded);
  const tlsPort = await reservePort(excluded);
  const httpPort = CF_ORIGIN_PORT;

  const reality = await startReality({
    backendPort: realityPort,
    publicHost: PUBLIC_HOST,
    publicPort: PUBLIC_PORT,
    label: realityLabel
  });

  if (String(reality.meta.sni || '').toLowerCase() === TLS_SNI) {
    throw new Error('REALITY target SNI conflicts with TLS fallback SNI');
  }

  const tlsBackend = await startTlsBackend({
    listenPort: tlsPort,
    backendPort: httpPort,
    sni: TLS_SNI
  });

  const tlsUri = tlsWsUri({
    uuid: identity.uuid,
    wsPath: identity.wsPath,
    publicHost: PUBLIC_HOST,
    publicPort: PUBLIC_PORT,
    sni: tlsBackend.sni,
    fingerprint: tlsBackend.fingerprint,
    label: tlsLabel
  });

  const cfUri = CF_TUNNEL_HOSTNAME ? cfWsUri({
    uuid: identity.uuid,
    wsPath: identity.wsPath,
    hostname: CF_TUNNEL_HOSTNAME,
    label: cfLabel
  }) : '';

  const configuredUris = [reality.uri, tlsUri];
  if (cfUri && CF_TUNNEL_TOKEN) configuredUris.push(cfUri);

  const cfRegistryReady = Boolean(cfUri && CF_TUNNEL_TOKEN);
  const backendEnv = {
    ...process.env,
    BACKEND_PORT: String(httpPort),
    LISTEN_HOST: '127.0.0.1',
    PUBLIC_HOST,
    PUBLIC_PORT: String(PUBLIC_PORT),
    PRIMARY_NODE_URI: reality.uri,
    PRIMARY_NODE_URIS: configuredUris.join('\n'),
    PRIMARY_TRANSPORT: 'tcp',
    PRIMARY_SECURITY: 'reality',
    PRIMARY_SNI: String(reality.meta.sni || ''),
    REGISTRY_ENABLED: cfRegistryReady ? '1' : '0',
    REGISTRY_FORCE_PUBLIC_PROOF: '1',
    REGISTRY_NODE_URI: cfRegistryReady ? cfUri : '',
    REGISTRY_ENDPOINT: cfRegistryReady ? 'https://' + CF_TUNNEL_HOSTNAME : '',
    REGISTRY_TRANSPORT: cfRegistryReady ? 'ws' : '',
    REGISTRY_SECURITY: cfRegistryReady ? 'tls' : '',
    REGISTRY_SNI: cfRegistryReady ? CF_TUNNEL_HOSTNAME : '',
    UUID: identity.uuid,
    WSPATH: identity.wsPath,
    SUB_TOKEN: identity.subToken,
    NODE_ID: identity.nodeId,
    NODE_NAME: String(process.env.NODE_NAME || 'HostShip-01-Reality'),
    HOSTSHIP_REALITY_MODE: '1'
  };

  const backend = spawn(process.execPath, [path.join(__dirname, 'hostship-backend.js')], {
    cwd: __dirname,
    env: backendEnv,
    stdio: ['ignore', 'inherit', 'inherit']
  });
  await waitForPort(httpPort, backend);

  const cloudflare = await startCloudflareTunnel({
    token: CF_TUNNEL_TOKEN,
    hostname: CF_TUNNEL_HOSTNAME
  });

  const mux = new HostShipMux({
    publicPort: PUBLIC_PORT,
    realityPort,
    tlsPort,
    httpPort,
    tlsSni: tlsBackend.sni
  });
  await mux.start();

  const base = 'http://' + PUBLIC_HOST + ':' + PUBLIC_PORT;
  const subUrl = base + '/' + identity.subToken + '/sub';
  const sub64Url = base + '/' + identity.subToken + '/sub64';

  console.log('='.repeat(78));
  console.log('HOSTSHIP_MULTI_NODE_READY node_count=' + configuredUris.length);
  console.log('PUBLIC_ENDPOINT ' + PUBLIC_HOST + ':' + PUBLIC_PORT);
  console.log('REALITY_TARGET_SNI ' + reality.meta.sni);
  console.log('TLS_FALLBACK_SNI ' + tlsBackend.sni);
  console.log('TLS_PIN_SHA256 ' + tlsBackend.fingerprint);
  console.log('REALITY_LINK_FINAL ' + reality.uri);
  console.log('TLS_WS_LINK_FINAL ' + tlsUri);
  if (cfUri && cloudflare) console.log('CF_TUNNEL_LINK_FINAL ' + cfUri);
  else console.log('CF_TUNNEL_STANDBY origin=http://127.0.0.1:' + httpPort);
  console.log('SUB_URL ' + subUrl);
  console.log('SUB64_URL ' + sub64Url);
  console.log('REGISTRY_PRIMARY ' + (cfRegistryReady ? 'cf-tunnel-public-proof' : 'disabled-until-cf-tunnel-ready'));
  console.log('='.repeat(78));

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('BOOTSTRAP_SHUTDOWN ' + signal);
    mux.close();
    try { tlsBackend.server.close(); } catch {}
    for (const child of [backend, reality.child, cloudflare?.child]) {
      try {
        if (child && child.exitCode === null) child.kill('SIGTERM');
      } catch {}
    }
    setTimeout(() => process.exit(0), 800).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  backend.once('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error('HTTP_BACKEND_EXIT code=' + String(code) + ' signal=' + String(signal || ''));
      shutdown('backend-exit');
      process.exitCode = code == null ? 1 : code;
    }
  });

  reality.child.once('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error('REALITY_BACKEND_EXIT code=' + String(code) + ' signal=' + String(signal || ''));
      shutdown('reality-exit');
      process.exitCode = code == null ? 1 : code;
    }
  });

  tlsBackend.server.once('close', () => {
    if (!shuttingDown) {
      console.error('TLS_BACKEND_EXIT');
      shutdown('tls-exit');
      process.exitCode = 1;
    }
  });
}

main().catch(error => {
  console.error('HOSTSHIP_MULTI_NODE_FATAL reason=' + String(error?.message || error));
  process.exitCode = 1;
});
