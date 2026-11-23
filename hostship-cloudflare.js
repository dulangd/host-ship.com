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

async function startCloudflareTunnel({ token, hostname }) {
  const tunnelToken = String(token || '').trim();
  const host = normalizeHostname(hostname);

  if (!tunnelToken && !host) {
    console.log('CF_TUNNEL_STANDBY ready_for_config=yes');
    return null;
  }
  if (!tunnelToken || !host) {
    console.log(
      'CF_TUNNEL_STANDBY ready_for_config=yes missing=' +
      (!tunnelToken ? 'token' : 'hostname')
    );
    return null;
  }

  await downloadBinary();

  const child = spawn(
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

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = code => finish(new Error('cloudflared exited early; code=' + code));
    const timer = setTimeout(() => finish(), 2500);
    child.once('exit', onExit);
  });

  console.log('CF_TUNNEL_PROCESS_READY hostname=' + host + ' protocol=http2');
  return { child, hostname: host };
}

module.exports = {
  startCloudflareTunnel,
  cfWsUri,
  normalizeHostname
};
