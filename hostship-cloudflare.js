'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const VERSION = '2026.10.7';
const SHA256 = '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872';
const DOWNLOAD_URL =
  'https://github.com/cloudflare/cloudflared/releases/download/' +
  VERSION + '/cloudflared-linux-amd64';

const HOME = process.env.HOME || '/home/container';
const STATE_DIR = path.resolve(
  process.env.CF_STATE_DIR || path.join(HOME, '.hostship-node', 'cloudflared', VERSION)
);
const BINARY = path.join(STATE_DIR, 'cloudflared');

function normalizeHostname(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!host) return '';
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || !host.includes('.')) {
    throw new Error('CF_TUNNEL_HOSTNAME invalid');
  }
  return host;
}

async function downloadBinary() {
  await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });

  if (fs.existsSync(BINARY)) {
    try {
      const data = await fsp.readFile(BINARY);
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      if (hash === SHA256) {
        await fsp.chmod(BINARY, 0o755);
        console.log('CF_BINARY_READY version=' + VERSION + ' source=cache');
        return;
      }
    } catch {}
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  let response;
  try {
    response = await fetch(DOWNLOAD_URL, {
      redirect: 'follow',
      headers: { 'user-agent': 'hostship-cloudflared-bootstrap/1' },
      signal: ctl.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error('cloudflared download HTTP ' + response.status);

  const data = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  if (hash !== SHA256) throw new Error('cloudflared SHA256 mismatch');

  const tmp = BINARY + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, data, { mode: 0o755 });
  await fsp.rename(tmp, BINARY);
  await fsp.chmod(BINARY, 0o755);
  console.log('CF_BINARY_READY version=' + VERSION + ' source=download');
}

function cfWsUri({ uuid, wsPath, hostname, label }) {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error('CF hostname missing');
  const q = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: host,
    fp: 'chrome',
    alpn: 'http/1.1',
    type: 'ws',
    path: wsPath,
    host
  });
  return (
    'vless://' + uuid + '@' + host + ':443?' + q.toString() +
    '#' + encodeURIComponent(label || 'HostShip-01-CF-Tunnel')
  );
}

async function waitForEdgeHealth(hostname, {
  child = null,
  timeoutMs = 120000,
  getSpawnError = () => null
} = {}) {
  const host = normalizeHostname(hostname);
  const url = 'https://' + host + '/health';
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'edge_not_reachable';

  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) {
      return { ready: false, reason: 'cloudflared_spawn_error=' + String(spawnError.code || spawnError.message || 'unknown') };
    }
    if (child && child.exitCode !== null) {
      return { ready: false, reason: 'cloudflared_exited_code=' + String(child.exitCode) };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'hostship-cloudflare-edge-check/1',
          'cache-control': 'no-cache'
        },
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) {
        lastReason = 'edge_http_' + response.status;
      } else {
        const health = await response.json();
        if (health && health.ok === true && health.service === 'hostship-native-node') {
          return { ready: true, health };
        }
        lastReason = 'unexpected_origin_health';
      }
    } catch (error) {
      lastReason = String(error?.name === 'AbortError' ? 'edge_request_timeout' : (error?.code || error?.message || 'edge_request_failed')).replace(/\\s+/g, '_').slice(0, 120);
    } finally {
      clearTimeout(timer);
    }

    await new Promise(resolve => setTimeout(resolve, 2500));
  }

  return { ready: false, reason: lastReason };
}

async function stopCloudflareTunnel(child) {
  if (!child || child.exitCode !== null) return;
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
    }, 4000);
    child.once('exit', done);
    try { child.kill('SIGTERM'); } catch { done(); }
  });
}

async function startCloudflareTunnel({ token, hostname, timeoutMs = 120000 }) {
  const tunnelToken = String(token || '').trim();
  const host = normalizeHostname(hostname);

  if (!tunnelToken && !host) {
    console.log('CF_TUNNEL_STANDBY ready_for_config=yes');
    return { configured: false, ready: false, child: null };
  }
  if (!tunnelToken || !host) {
    console.log(
      'CF_TUNNEL_STANDBY ready_for_config=yes missing=' +
      (!tunnelToken ? 'token' : 'hostname')
    );
    return { configured: false, ready: false, child: null };
  }

  let child = null;
  try {
    await downloadBinary();

    let spawnError = null;
    child = spawn(
      BINARY,
      ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--loglevel', 'warn', 'run'],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          TUNNEL_TOKEN: tunnelToken,
          TUNNEL_TRANSPORT_PROTOCOL: 'http2'
        }
      }
    );
    child.once('error', error => { spawnError = error; });

    const edge = await waitForEdgeHealth(host, {
      child,
      timeoutMs,
      getSpawnError: () => spawnError
    });

    if (!edge.ready) {
      await stopCloudflareTunnel(child);
      console.log('CF_TUNNEL_EDGE_FAILED hostname=' + host + ' reason=' + edge.reason);
      return { configured: true, ready: false, child: null, hostname: host, reason: edge.reason };
    }

    console.log('CF_TUNNEL_EDGE_READY hostname=' + host + ' origin_health=yes protocol=http2');
    return { configured: true, ready: true, child, hostname: host, health: edge.health };
  } catch (error) {
    if (child) await stopCloudflareTunnel(child);
    const reason = String(error?.message || error).replace(/\\s+/g, ' ').slice(0, 180);
    console.log('CF_TUNNEL_START_FAILED reason=' + reason);
    return { configured: true, ready: false, child: null, hostname: host, reason };
  }
}

module.exports = {
  startCloudflareTunnel,
  waitForEdgeHealth,
  stopCloudflareTunnel,
  cfWsUri,
  normalizeHostname
};
