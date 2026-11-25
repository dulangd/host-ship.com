'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { HostShipMux } = require('./hostship-mux.js');
const { startReality } = require('./hostship-reality.js');
const { startTlsBackend, tlsWsUri } = require('./hostship-tls.js');
const {
  startCloudflareTunnel,
  waitForEdgeHealth,
  stopCloudflareTunnel,
  cfWsUri,
  normalizeHostname
} = require('./hostship-cloudflare.js');

const HOME = process.env.HOME || '/home/container';
const STATE_DIR = path.resolve(process.env.STATE_DIR || path.join(HOME, '.hostship-node'));
const IDENTITY_FILE = path.join(STATE_DIR, 'identity.json');
const PUBLIC_HOST = String(process.env.PUBLIC_HOST || '45.131.65.244').trim();
const PUBLIC_PORT = validPort(process.env.SERVER_PORT || process.env.PORT || '30376', 'SERVER_PORT');
const TLS_SNI = String(process.env.TLS_SNI || 'hostship-tls.invalid').trim().toLowerCase();
const CF_ORIGIN_PORT = validPort(process.env.CF_ORIGIN_PORT || '18080', 'CF_ORIGIN_PORT');
const CF_CONFIG_FILE = path.join(STATE_DIR, 'cloudflare.json');
const directMode = /^(1|true|yes|on)$/i.test(String(process.env.HOSTSHIP_REALITY_DIRECT || '1').trim());

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
  const realityPort = directMode ? PUBLIC_PORT : await reservePort(excluded);
  const tlsPort = directMode ? null : await reservePort(excluded);
  const httpPort = CF_ORIGIN_PORT;

  const reality = await startReality({
    backendPort: realityPort,
    publicHost: PUBLIC_HOST,
    publicPort: PUBLIC_PORT,
    label: realityLabel,
    listenHost: directMode ? '0.0.0.0' : '127.0.0.1'
  });

  let tlsBackend = null;
  let tlsUri = '';
  if (!directMode) {
    if (String(reality.meta.sni || '').toLowerCase() === TLS_SNI) {
      throw new Error('REALITY target SNI conflicts with TLS fallback SNI');
    }

    tlsBackend = await startTlsBackend({
      listenPort: tlsPort,
      backendPort: httpPort,
      sni: TLS_SNI
    });

    tlsUri = tlsWsUri({
      uuid: identity.uuid,
      wsPath: identity.wsPath,
      publicHost: PUBLIC_HOST,
      publicPort: PUBLIC_PORT,
      sni: tlsBackend.sni,
      fingerprint: tlsBackend.fingerprint,
      label: tlsLabel
    });
  }

  const cfUri = CF_TUNNEL_HOSTNAME ? cfWsUri({
    uuid: identity.uuid,
    wsPath: identity.wsPath,
    hostname: CF_TUNNEL_HOSTNAME,
    label: cfLabel
  }) : '';

  const directUris = [reality.uri, ...(tlsUri ? [tlsUri] : [])];
  const configuredUris = directUris.slice();
  const cfConfigured = Boolean(cfUri && CF_TUNNEL_TOKEN);

  const backendEnv = {
    ...process.env,
    BACKEND_PORT: String(httpPort),
    LISTEN_HOST: '127.0.0.1',
    PUBLIC_HOST: directMode && CF_TUNNEL_HOSTNAME ? CF_TUNNEL_HOSTNAME : PUBLIC_HOST,
    PUBLIC_PORT: directMode && CF_TUNNEL_HOSTNAME ? '443' : String(PUBLIC_PORT),
    PUBLIC_TLS: directMode && CF_TUNNEL_HOSTNAME ? '1' : '0',
    PUBLIC_WS_HOST: directMode && CF_TUNNEL_HOSTNAME ? CF_TUNNEL_HOSTNAME : PUBLIC_HOST,
    PRIMARY_NODE_URI: reality.uri,
    PRIMARY_NODE_URIS: directUris.join('\n'),
    PRIMARY_TRANSPORT: 'tcp',
    PRIMARY_SECURITY: 'reality',
    PRIMARY_SNI: String(reality.meta.sni || ''),
    REGISTRY_ENABLED: '0',
    REGISTRY_FORCE_PUBLIC_PROOF: '1',
    REGISTRY_NODE_URI: '',
    REGISTRY_ENDPOINT: '',
    REGISTRY_DIRECT_ENDPOINT: directMode && CF_TUNNEL_HOSTNAME ? 'https://' + CF_TUNNEL_HOSTNAME : 'http://' + PUBLIC_HOST + ':' + PUBLIC_PORT,
    REGISTRY_TRANSPORT: '',
    REGISTRY_SECURITY: '',
    REGISTRY_SNI: '',
    UUID: identity.uuid,
    WSPATH: identity.wsPath,
    SUB_TOKEN: identity.subToken,
    NODE_ID: identity.nodeId,
    NODE_NAME: String(process.env.NODE_NAME || 'HostShip-01-Reality'),
    HOSTSHIP_REALITY_MODE: '1',
    HOSTSHIP_REALITY_DIRECT: directMode ? '1' : '0'
  };

  const cfBackendEnv = {
    ...backendEnv,
    PUBLIC_HOST: CF_TUNNEL_HOSTNAME,
    PUBLIC_PORT: '443',
    PUBLIC_TLS: '1',
    PUBLIC_WS_HOST: CF_TUNNEL_HOSTNAME,
    PRIMARY_NODE_URIS: directUris.concat(cfUri || []).filter(Boolean).join('\n'),
    REGISTRY_ENABLED: cfConfigured ? '1' : '0',
    REGISTRY_FORCE_PUBLIC_PROOF: '1',
    REGISTRY_NODE_URI: cfConfigured ? cfUri : '',
    REGISTRY_ENDPOINT: cfConfigured ? 'https://' + CF_TUNNEL_HOSTNAME : '',
    REGISTRY_TRANSPORT: cfConfigured ? 'ws' : '',
    REGISTRY_SECURITY: cfConfigured ? 'tls' : '',
    REGISTRY_SNI: cfConfigured ? CF_TUNNEL_HOSTNAME : '',
    NODE_NAME: 'HostShip-01-CF-Tunnel'
  };

  const mux = directMode ? null : new HostShipMux({
    publicPort: PUBLIC_PORT,
    realityPort,
    tlsPort,
    httpPort,
    tlsSni: tlsBackend.sni
  });

  let backend = null;
  let cloudflare = null;
  let cfActive = false;
  let shuttingDown = false;
  const intentionalStops = new WeakSet();

  async function stopProcess(child) {
    if (!child || child.exitCode !== null) return;
    intentionalStops.add(child);
    await new Promise(resolve => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.removeListener('exit', done);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        done();
      }, 5000);
      child.once('exit', done);
      try { child.kill('SIGTERM'); } catch { done(); }
    });
  }

  function spawnBackend(env) {
    return spawn(process.execPath, [path.join(__dirname, 'hostship-backend.js')], {
      cwd: __dirname,
      env,
      stdio: ['ignore', 'inherit', 'inherit']
    });
  }

  function watchBackend(child) {
    child.once('exit', (code, signal) => {
      if (!shuttingDown && !intentionalStops.has(child)) {
        console.error('HTTP_BACKEND_EXIT code=' + String(code) + ' signal=' + String(signal || ''));
        shutdown('backend-exit');
        process.exitCode = code == null ? 1 : code;
      }
    });
  }

  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('BOOTSTRAP_SHUTDOWN ' + signal);
    if (mux) mux.close();
    if (tlsBackend) { try { tlsBackend.server.close(); } catch {} }
    for (const child of [backend, reality.child, cloudflare?.child]) {
      try {
        if (child && child.exitCode === null) child.kill('SIGTERM');
      } catch {}
    }
    setTimeout(() => process.exit(0), 800).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  backend = spawnBackend(backendEnv);
  watchBackend(backend);
  await waitForPort(httpPort, backend);
  if (mux) await mux.start();

  const expectedSubscriptionNodes = directUris.length + 1;

  if (cfConfigured) {
    cloudflare = await startCloudflareTunnel({
      token: CF_TUNNEL_TOKEN,
      hostname: CF_TUNNEL_HOSTNAME,
      timeoutMs: 120000
    });

    if (cloudflare?.ready && cloudflare.child) {
      await stopProcess(backend);
      backend = spawnBackend(cfBackendEnv);
      watchBackend(backend);
      await waitForPort(httpPort, backend);

      const edgeAfterPublish = await waitForEdgeHealth(CF_TUNNEL_HOSTNAME, {
        child: cloudflare.child,
        timeoutMs: 45000
      });

      if (
        edgeAfterPublish.ready &&
        Number(edgeAfterPublish.health?.subscription_nodes) === expectedSubscriptionNodes
      ) {
        cfActive = true;
        configuredUris.push(cfUri);
        console.log('CF_TUNNEL_NODE_ACTIVE hostname=' + CF_TUNNEL_HOSTNAME + ' subscription_nodes=' + expectedSubscriptionNodes);
        cloudflare.child.once('exit', (code, signal) => {
          if (!shuttingDown) {
            console.error('CF_TUNNEL_PROCESS_EXIT code=' + String(code) + ' signal=' + String(signal || ''));
          }
        });
      } else {
        console.log(
          'CF_TUNNEL_ROLLBACK reason=' +
          String(edgeAfterPublish.reason || ('expected_' + expectedSubscriptionNodes + '_node_edge_health_not_confirmed'))
        );
        await stopProcess(backend);
        await stopCloudflareTunnel(cloudflare.child);
        cloudflare = null;
        backend = spawnBackend(backendEnv);
        watchBackend(backend);
        await waitForPort(httpPort, backend);
      }
    } else {
      console.log('CF_TUNNEL_NODE_DISABLED reason=' + String(cloudflare?.reason || 'edge_not_ready'));
      cloudflare = null;
    }
  } else {
    console.log('CF_TUNNEL_STANDBY origin=http://127.0.0.1:' + httpPort);
  }

  const base = directMode
    ? (cfActive ? 'https://' + CF_TUNNEL_HOSTNAME : '')
    : 'http://' + PUBLIC_HOST + ':' + PUBLIC_PORT;
  const subUrl = base + '/' + identity.subToken + '/sub';
  const sub64Url = base + '/' + identity.subToken + '/sub64';

  console.log('='.repeat(78));
  console.log((directMode ? 'HOSTSHIP_RUST_DIRECT_READY' : 'HOSTSHIP_MULTI_NODE_READY') + ' node_count=' + configuredUris.length);
  console.log('REALITY_CORE rust-reality/1.6.1');
  console.log('PUBLIC_ENDPOINT ' + PUBLIC_HOST + ':' + PUBLIC_PORT);
  console.log('REALITY_LISTEN ' + (directMode ? '0.0.0.0:' : '127.0.0.1:') + realityPort);
  console.log('REALITY_TARGET_SNI ' + reality.meta.sni);
  if (tlsBackend) {
    console.log('TLS_FALLBACK_SNI ' + tlsBackend.sni);
    console.log('TLS_PIN_SHA256 ' + tlsBackend.fingerprint);
  }
  console.log('REALITY_LINK_FINAL ' + reality.uri);
  if (tlsUri) console.log('TLS_WS_LINK_FINAL ' + tlsUri);
  if (cfActive) console.log('CF_TUNNEL_LINK_FINAL ' + cfUri);
  else console.log('CF_TUNNEL_STANDBY origin=http://127.0.0.1:' + httpPort);
  if (base) {
    console.log('SUB_URL ' + subUrl);
    console.log('SUB64_URL ' + sub64Url);
  } else {
    console.log('SUB_URL_UNAVAILABLE reason=CF_TUNNEL_NOT_ACTIVE');
  }
  console.log('REGISTRY_PRIMARY ' + (cfActive ? 'cf-tunnel-public-proof' : 'disabled-until-cf-tunnel-ready'));
  console.log('='.repeat(78));

  reality.child.once('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error('REALITY_BACKEND_EXIT code=' + String(code) + ' signal=' + String(signal || ''));
      shutdown('reality-exit');
      process.exitCode = code == null ? 1 : code;
    }
  });

  if (tlsBackend) {
    tlsBackend.server.once('close', () => {
      if (!shuttingDown) {
        console.error('TLS_BACKEND_EXIT');
        shutdown('tls-exit');
        process.exitCode = 1;
      }
    });
  }
}

main().catch(error => {
  console.error('HOSTSHIP_MULTI_NODE_FATAL reason=' + String(error?.message || error));
  process.exitCode = 1;
});
