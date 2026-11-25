'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const VERSION = '1.6.1';
const TAG = 'v' + VERSION;
const REPOSITORY = 'jacek4yang/rust-reality';
const ASSET = 'rust-reality-v' + VERSION + '-linux-x86_64-musl.tar.gz';
const RELEASE_BASE = 'https://github.com/' + REPOSITORY + '/releases/download/' + TAG;
const ASSET_URL = RELEASE_BASE + '/' + ASSET;
const SHA256SUMS_URL = RELEASE_BASE + '/SHA256SUMS';

const HOME = process.env.HOME || '/home/container';
const STATE_DIR = path.resolve(
  process.env.RR_STATE_DIR || path.join(HOME, '.hostship-node', 'reality', TAG)
);
const BINARY = path.join(STATE_DIR, 'rust-reality');
const CONFIG = path.join(STATE_DIR, 'config.json');
const CLIENT_META = path.join(STATE_DIR, 'client.json');

const SNI_CANDIDATES = [
  'www.nvidia.com',
  'www.microsoft.com',
  'www.apple.com',
  'www.cloudflare.com',
  'www.amazon.com',
  'www.ibm.com'
];

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs || 15000,
    env: opts.env || process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-3000);
    throw new Error(
      'command failed (' + result.status + '): ' + command + ' ' + args.join(' ') +
      (detail ? '\n' + detail : '')
    );
  }
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

async function atomicWrite(file, data, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, data, { mode });
  await fsp.rename(tmp, file);
  try { await fsp.chmod(file, mode); } catch {}
}

async function fetchBuffer(url, maxBytes = 128 * 1024 * 1024) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      let response;
      try {
        response = await fetch(url, {
          headers: { 'user-agent': 'hostship-reality/' + VERSION, accept: '*/*' },
          signal: ctl.signal,
          redirect: 'follow'
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error('download HTTP ' + response.status);
      const data = Buffer.from(new Uint8Array(await response.arrayBuffer()));
      if (!data.length) throw new Error('download was empty');
      if (data.length > maxBytes) throw new Error('download too large');
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
    }
  }
  throw new Error('download failed: ' + String(lastError?.message || lastError));
}

async function installBinary() {
  await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });

  try {
    const value = run(BINARY, ['--version'], { timeoutMs: 5000 }).stdout.trim();
    if (value === 'rust-reality ' + VERSION) {
      console.log('REALITY_BINARY_READY version=' + VERSION + ' source=cache');
      return;
    }
  } catch {}

  console.log('REALITY_BINARY_INSTALL version=' + VERSION);
  const sums = (await fetchBuffer(SHA256SUMS_URL, 1024 * 1024)).toString('utf8');
  const line = sums.split(/\r?\n/).find(x => x.trim().endsWith(ASSET));
  if (!line) throw new Error(ASSET + ' missing from SHA256SUMS');
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('invalid rust-reality SHA256 entry');

  const archive = await fetchBuffer(ASSET_URL);
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error('rust-reality archive SHA256 mismatch');

  const archivePath = path.join(STATE_DIR, ASSET);
  await atomicWrite(archivePath, archive, 0o600);
  run('tar', ['-xzf', archivePath, '-C', STATE_DIR], { timeoutMs: 20000 });
  await fsp.rm(archivePath, { force: true });

  if (!fs.existsSync(BINARY)) {
    const entries = await fsp.readdir(STATE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(STATE_DIR, entry.name, 'rust-reality');
      if (fs.existsSync(nested)) {
        await fsp.rename(nested, BINARY);
        break;
      }
    }
  }

  if (!fs.existsSync(BINARY)) throw new Error('rust-reality binary missing after extraction');
  await fsp.chmod(BINARY, 0o755);
  const version = run(BINARY, ['--version'], { timeoutMs: 5000 }).stdout.trim();
  if (version !== 'rust-reality ' + VERSION) throw new Error('unexpected rust-reality version: ' + version);
  console.log('REALITY_BINARY_READY version=' + VERSION + ' source=download');
}

function probeSni(sni) {
  try {
    const result = run(BINARY, [
      'probe-dest',
      '--target', sni + ':443',
      '--server-name', sni,
      '--timeout-ms', '4000'
    ], { timeoutMs: 6500 });
    const report = JSON.parse(result.stdout);
    if (report.compatible !== true) return null;
    return Number(report.totalMillis);
  } catch {
    return null;
  }
}

function selectSni() {
  const forced = String(process.env.RR_SNI || '').trim();
  if (forced) {
    const latency = probeSni(forced);
    if (latency == null) throw new Error('RR_SNI=' + forced + ' is not compatible/reachable');
    return forced;
  }

  for (const candidate of SNI_CANDIDATES) {
    const latency = probeSni(candidate);
    if (latency != null) {
      console.log('REALITY_TARGET_READY sni=' + candidate + ' probe_ms=' + latency);
      return candidate;
    }
  }
  throw new Error('no compatible REALITY cover SNI found');
}

function applyProfile(config, backendPort, listenHost = '127.0.0.1') {
  config.log = {
    level: String(process.env.RR_LOG_LEVEL || 'error').toLowerCase(),
    output: 'stderr'
  };
  config.network = config.network || {};
  config.network.dial = config.network.dial || {};
  config.network.dial.mode = 'ipv4Only';
  config.runtime = config.runtime || {};
  config.runtime.profile = 'dedicated';
  config.runtime.tuning = { mode: 'startup', objective: 'throughput' };

  if (!Array.isArray(config.inbounds) || !config.inbounds[0]) {
    throw new Error('generated REALITY config has no inbound');
  }
  config.inbounds[0].port = backendPort;
  config.inbounds[0].listen = { mode: 'ipv4Only', ipv4: listenHost };
  return config;
}

function checkConfig(file, selfTest = false) {
  run(BINARY, ['check', '--config', file], { timeoutMs: 10000 });
  if (selfTest) run(BINARY, ['self-test', '--config', file], { timeoutMs: 30000 });
}

async function generateIdentity(backendPort, listenHost = '127.0.0.1') {
  const sni = selectSni();
  const generated = run(BINARY, [
    'config', 'generate', 'standalone',
    '--listen', '127.0.0.1',
    '--port', String(backendPort),
    '--target', sni + ':443',
    '--server-name', sni
  ], { timeoutMs: 12000 });

  const config = applyProfile(JSON.parse(generated.stdout), backendPort, listenHost);
  const user = config?.inbounds?.[0]?.settings?.clients?.[0];
  const uuid = String(user?.id || '');
  const shortId = String(Array.isArray(user?.shortIds) ? user.shortIds[0] || '' : '');
  const match = generated.stderr.match(
    /REALITY public key for the client:\s*([A-Za-z0-9_-]{40,64})/
  );
  const publicKey = match ? match[1] : '';
  if (!uuid || !shortId || !publicKey) {
    throw new Error('rust-reality did not return complete client identity');
  }

  const tmp = path.join(STATE_DIR, '.config.' + process.pid + '.json');
  await atomicWrite(tmp, JSON.stringify(config, null, 2) + '\n');
  try { checkConfig(tmp, true); } finally { await fsp.rm(tmp, { force: true }); }

  const meta = { version: VERSION, uuid, shortId, publicKey, sni };
  await atomicWrite(CONFIG, JSON.stringify(config, null, 2) + '\n');
  await atomicWrite(CLIENT_META, JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

async function loadOrCreateIdentity(backendPort, listenHost = '127.0.0.1') {
  if (process.env.RR_REGENERATE === '1') {
    await Promise.all([CONFIG, CLIENT_META].map(file => fsp.rm(file, { force: true })));
  }

  const hasConfig = fs.existsSync(CONFIG);
  const hasMeta = fs.existsSync(CLIENT_META);
  if (!hasConfig && !hasMeta) return generateIdentity(backendPort, listenHost);
  if (!hasConfig || !hasMeta) {
    throw new Error('incomplete persisted REALITY state; set RR_REGENERATE=1 once');
  }

  const config = applyProfile(JSON.parse(await fsp.readFile(CONFIG, 'utf8')), backendPort, listenHost);
  const meta = JSON.parse(await fsp.readFile(CLIENT_META, 'utf8'));
  for (const key of ['uuid', 'shortId', 'publicKey', 'sni']) {
    if (!meta[key]) throw new Error('persisted REALITY metadata missing ' + key);
  }

  await atomicWrite(CONFIG, JSON.stringify(config, null, 2) + '\n');
  checkConfig(CONFIG, false);
  console.log('REALITY_IDENTITY_READY source=persisted sni=' + meta.sni);
  return meta;
}

function authority(host) {
  return net.isIP(host) === 6 ? '[' + host + ']' : host;
}

function realityUri(meta, publicHost, publicPort, label) {
  const query = new URLSearchParams({
    encryption: 'none',
    flow: 'xtls-rprx-vision',
    security: 'reality',
    sni: String(meta.sni),
    fp: 'chrome',
    pbk: String(meta.publicKey),
    sid: String(meta.shortId),
    type: 'tcp',
    headerType: 'none'
  });
  return (
    'vless://' + meta.uuid + '@' + authority(publicHost) + ':' + publicPort +
    '?' + query.toString() + '#' + encodeURIComponent(label || 'HostShip-01-Reality')
  );
}

function waitForListen(port, child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      if (child.exitCode !== null) {
        reject(new Error('rust-reality exited before listening; code=' + child.exitCode));
        return;
      }
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        socket.destroy();
        if (ok) return resolve();
        if (Date.now() >= deadline) return reject(new Error('REALITY backend listen timeout'));
        setTimeout(attempt, 200);
      };
      socket.setTimeout(700);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    };
    attempt();
  });
}

async function startReality({ backendPort, publicHost, publicPort, label, listenHost = '127.0.0.1' }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Host-Ship REALITY requires Linux x86_64');
  }
  await installBinary();
  const meta = await loadOrCreateIdentity(backendPort, listenHost);
  const child = spawn(BINARY, ['serve', '--config', CONFIG], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, RUST_BACKTRACE: process.env.RUST_BACKTRACE || '0' }
  });
  await waitForListen(backendPort, child);
  const uri = realityUri(meta, publicHost, publicPort, label);

  console.log(
    'REALITY_BACKEND_READY version=' + VERSION +
    ' listen=' + listenHost + ':' + backendPort +
    ' sni=' + meta.sni
  );
  return { child, meta, uri };
}

module.exports = { startReality, realityUri };
