'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;

const HOME = process.env.HOME || '/home/container';
const STATE_DIR = path.resolve(process.env.STATE_DIR || path.join(HOME, '.hostship-node'));
const IDENTITY_FILE = path.join(STATE_DIR, 'identity.json');
const OUTPUT_FILE = path.resolve(process.env.OUTPUT_FILE || path.join(HOME, 'deployment-output.txt'));
const TOKEN_FILE = path.resolve(process.env.REGISTRY_TOKEN_FILE || path.join(HOME, 'registry_token.txt'));
const REGISTRY_PROOF_FILE = path.join(STATE_DIR, 'registry-proof.txt');

function validPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writePrivate(file, text) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizePath(value) {
  const v = String(value || '').trim();
  if (!v) throw new Error('path cannot be empty');
  return v.startsWith('/') ? v : '/' + v;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function loadRegistryProof() {
  try {
    const saved = fs.readFileSync(REGISTRY_PROOF_FILE, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {}
  const proof = randomToken(32);
  writePrivate(REGISTRY_PROOF_FILE, proof + '\n');
  return proof;
}

function loadIdentity() {
  ensureDir(STATE_DIR);
  let old = {};
  try { old = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8')); } catch {}

  const identity = {
    uuid: process.env.UUID || old.uuid || crypto.randomUUID(),
    wsPath: normalizePath(process.env.WSPATH || old.wsPath || '/ws-' + randomToken(9)),
    subToken: process.env.SUB_TOKEN || old.subToken || randomToken(24),
    nodeId: process.env.NODE_ID || old.nodeId || 'hostship-01-native'
  };

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.uuid)) {
    throw new Error('UUID must be a UUID v4');
  }
  if (identity.subToken.length < 20) throw new Error('SUB_TOKEN too short');
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(identity.nodeId)) throw new Error('NODE_ID invalid');

  writePrivate(IDENTITY_FILE, JSON.stringify(identity, null, 2) + '\n');
  return identity;
}

let registryTokenSource = '';

function registryTokenCandidates() {
  const candidates = [
    process.env.REGISTRY_TOKEN_FILE,
    TOKEN_FILE,
    '/home/container/registry_token.txt',
    path.join(process.cwd(), 'registry_token.txt')
  ].filter(Boolean).map(p => path.resolve(String(p)));
  return [...new Set(candidates)];
}

function readRegistryToken() {
  const hostshipEnv = String(process.env.HOSTSHIP_REGISTER_TOKEN || '').trim();
  if (hostshipEnv) {
    registryTokenSource = 'env:HOSTSHIP_REGISTER_TOKEN';
    return hostshipEnv;
  }

  const registryEnv = String(process.env.REGISTRY_TOKEN || '').trim();
  if (registryEnv) {
    registryTokenSource = 'env:REGISTRY_TOKEN';
    return registryEnv;
  }

  for (const candidate of registryTokenCandidates()) {
    try {
      const fileToken = fs.readFileSync(candidate, 'utf8').replace(/^\\uFEFF/, '').trim();
      if (fileToken) {
        registryTokenSource = 'file:' + candidate;
        try { fs.chmodSync(candidate, 0o600); } catch {}
        return fileToken;
      }
    } catch {}
  }

  registryTokenSource = '';
  return '';
}

function logRegistryTokenDiagnostics() {
  const states = registryTokenCandidates().map(candidate => {
    try {
      const st = fs.statSync(candidate);
      return candidate + ':exists,size=' + st.size + ',file=' + (st.isFile() ? 'yes' : 'no');
    } catch (e) {
      return candidate + ':missing(' + String(e.code || 'error') + ')';
    }
  });
  console.log(
    'REGISTRY_TOKEN_DIAG cwd=' + process.cwd() +
    ' home=' + String(process.env.HOME || '') +
    ' candidates=[' + states.join(';') + ']'
  );
}

const identity = loadIdentity();
const registryProof = loadRegistryProof();
const registryProofSha256 = sha256Hex(registryProof);
const listenHost = process.env.LISTEN_HOST || '0.0.0.0';
const listenPort = validPort(
  process.env.BACKEND_PORT,
  validPort(process.env.SERVER_PORT, validPort(process.env.PORT, 30376))
);
const publicHost = String(process.env.PUBLIC_HOST || '45.131.65.244').trim();
const publicPort = validPort(process.env.PUBLIC_PORT, validPort(process.env.SERVER_PORT, listenPort));
const publicTls = envBool('PUBLIC_TLS', false);
const publicWsHost = String(process.env.PUBLIC_WS_HOST || publicHost).trim();
const allowPrivateTargets = envBool('ALLOW_PRIVATE_TARGETS', false);
const primaryNodeUri = String(process.env.PRIMARY_NODE_URI || '').trim();
const primaryTransport = String(process.env.PRIMARY_TRANSPORT || 'ws').trim().toLowerCase();
const primarySecurity = String(process.env.PRIMARY_SECURITY || (publicTls ? 'tls' : 'none')).trim().toLowerCase();
const primarySni = String(process.env.PRIMARY_SNI || '').trim();
const configuredNodeUris = String(process.env.PRIMARY_NODE_URIS || '')
  .split(/\r?\n/)
  .map(value => value.trim())
  .filter(value => value.startsWith('vless://'));

const registryBase = String(process.env.REGISTRY_URL || 'https://subscription-server-v2-production.up.railway.app').replace(/\/$/, '');
const registerPath = normalizePath(process.env.REGISTRY_REGISTER_PATH || '/api/v1/register');
const heartbeatPath = normalizePath(process.env.REGISTRY_HEARTBEAT_PATH || '/api/v1/heartbeat');
const heartbeatMinutes = Math.max(1, Number(process.env.REGISTRY_HEARTBEAT_MINUTES || 10) || 10);
const registryEnabled = envBool('REGISTRY_ENABLED', true);
const registryForcePublicProof = envBool('REGISTRY_FORCE_PUBLIC_PROOF', false);
const registryNodeUri = String(process.env.REGISTRY_NODE_URI || '').trim();
const registryEndpoint = String(process.env.REGISTRY_ENDPOINT || '').trim().replace(/\/$/, '');
const registryDirectEndpoint = String(process.env.REGISTRY_DIRECT_ENDPOINT || '').trim().replace(/\/$/, '');
const registryTransport = String(process.env.REGISTRY_TRANSPORT || primaryTransport || 'ws').trim().toLowerCase();
const registrySecurity = String(process.env.REGISTRY_SECURITY || primarySecurity || 'none').trim().toLowerCase();
const registrySni = String(process.env.REGISTRY_SNI || primarySni || '').trim();
const verboseTrafficLogs = envBool('VERBOSE_TRAFFIC_LOGS', false);
let registryToken = registryForcePublicProof ? '' : readRegistryToken();
let registryLeaseSeconds = 900;
let registryRegistered = false;
let registryAdditionalRegistered = false;
let registryAdditionalLastError = '';
let registryLastError = '';
let registryPermanentFailure = false;
let registrySkipLogged = false;
let registryRefreshTimer = null;
let registryRefreshRunning = false;

let countryCode = '';
let egressIp = '';
let nodeName = String(process.env.NODE_NAME || 'HostShip-01-Native').trim();
let firstProxySuccessLogged = false;
let activeConnections = 0;
let totalConnections = 0;
const rateLimitState = new Map();
let registryFailureCount = 0;
const REGISTRY_BACKOFF_BASE_MS = 60 * 1000;
const REGISTRY_BACKOFF_MAX_MS = 15 * 60 * 1000;
const MAX_PENDING_CLIENT_BYTES = 2 * 1024 * 1024;
const RETRYABLE_CONNECT_ERRORS = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'EAI_AGAIN'
]);

function trafficLog(message) {
  if (verboseTrafficLogs) console.log(message);
}

function rateLimitedLog(key, message, intervalMs = 30000) {
  const now = Date.now();
  const previous = rateLimitState.get(key) || 0;
  if (now - previous < intervalMs) return;
  rateLimitState.set(key, now);
  console.log(message);
}

const subPath = '/' + identity.subToken + '/sub';
const sub64Path = '/' + identity.subToken + '/sub64';
const nodePath = '/' + identity.subToken + '/node';
const expectedUuid = Buffer.from(identity.uuid.replace(/-/g, ''), 'hex');

function hostForUri(host) {
  return net.isIP(host) === 6 ? '[' + host + ']' : host;
}

function refreshNodeName() {
  const base = String(process.env.NODE_NAME || 'HostShip-01-Native').trim().replace(/^[A-Z]{2}-/i, '');
  nodeName = countryCode ? countryCode + '-' + base : base;
}

function nodeUri() {
  if (primaryNodeUri) return primaryNodeUri;
  const q = new URLSearchParams({
    encryption: 'none',
    security: publicTls ? 'tls' : 'none',
    type: 'ws',
    path: identity.wsPath,
    host: publicWsHost
  });
  if (publicTls) {
    q.set('sni', publicWsHost);
    q.set('fp', 'chrome');
    q.set('alpn', 'http/1.1');
  }
  return 'vless://' + identity.uuid + '@' + hostForUri(publicHost) + ':' + publicPort + '?' + q.toString() + '#' + encodeURIComponent(nodeName);
}

function subscriptionUris() {
  const values = configuredNodeUris.length ? configuredNodeUris : [nodeUri()];
  return [...new Set(values.filter(value => typeof value === 'string' && value.startsWith('vless://')))];
}

function subscriptionRaw() {
  return subscriptionUris().join('\n') + '\n';
}

function shadowrocketUri(standardUri) {
  const parsed = new URL(standardUri);
  const q = parsed.searchParams;
  const uuid = decodeURIComponent(parsed.username || '');
  const host = parsed.hostname;
  const port = parsed.port || '443';
  const authority = Buffer.from('none:' + uuid + '@' + hostForUri(host) + ':' + port, 'utf8')
    .toString('base64');
  const params = new URLSearchParams();
  const label = decodeURIComponent((parsed.hash || '').replace(/^#/, '')) || 'HostShip';

  params.set('remarks', label);
  params.set('udp', '1');

  const security = String(q.get('security') || '').toLowerCase();
  if (security === 'reality') {
    params.set('tls', '1');
    params.set('peer', q.get('sni') || '');
    params.set('xtls', '2');
    params.set('pbk', q.get('pbk') || '');
    params.set('sid', q.get('sid') || '');
    params.set('fp', q.get('fp') || 'chrome');
    const spx = q.get('spx');
    if (spx) params.set('spx', spx);
  } else if (security === 'tls') {
    params.set('tls', '1');
    params.set('peer', q.get('sni') || '');
    // Only the direct self-signed TLS node needs this legacy Shadowrocket bypass.
    // Cloudflare hostname certificates are publicly trusted and must stay verified.
    if (q.get('pcs')) params.set('allowInsecure', '1');
    params.set('obfs', q.get('type') === 'ws' ? 'websocket' : (q.get('type') || 'none'));
    if (q.get('path')) params.set('path', q.get('path'));
    if (q.get('host')) params.set('obfsParam', q.get('host'));
    if (q.get('alpn')) params.set('alpn', q.get('alpn'));
    params.set('fp', q.get('fp') || 'chrome');
  } else {
    params.set('tls', '0');
  }

  return 'vless://' + authority + '?' + params.toString();
}

function shadowrocketRaw() {
  return subscriptionUris().map(shadowrocketUri).join('\n') + '\n';
}

function isShadowrocketRequest(req) {
  const ua = String(req?.headers?.['user-agent'] || '');
  return /shadowrocket/i.test(ua);
}

function advertisedNodeSummary() {
  return subscriptionUris().map((uri, index) => {
    try {
      const parsed = new URL(uri);
      const query = parsed.searchParams;
      return {
        index: index + 1,
        security: query.get('security') || 'none',
        transport: query.get('type') || 'tcp',
        flow: query.get('flow') || '',
        sni: query.get('sni') || ''
      };
    } catch {
      return { index: index + 1, security: 'unknown', transport: 'unknown', flow: '', sni: '' };
    }
  });
}

function publicBase() {
  const scheme = publicTls ? 'https' : 'http';
  const defaultPort = (publicTls && publicPort === 443) || (!publicTls && publicPort === 80);
  return scheme + '://' + hostForUri(publicHost) + (defaultPort ? '' : ':' + publicPort);
}

function writeOutput() {
  const uris = subscriptionUris();
  const text = [
    'Host-Ship Multi Node',
    '====================',
    'status=ready',
    'provider=host-ship',
    'listen=' + listenHost + ':' + listenPort,
    'public=' + publicHost + ':' + publicPort,
    'primary_transport=' + (primaryTransport || 'ws'),
    'primary_security=' + (primarySecurity || 'none'),
    'country=' + (countryCode || 'pending'),
    'egress_ip=' + (egressIp || 'pending'),
    'node_id=' + identity.nodeId,
    'ws_path=' + identity.wsPath,
    'node_count=' + uris.length,
    '',
    ...uris.map((uri, index) => 'NODE_' + (index + 1) + '=' + uri),
    '',
    'SUB=' + publicBase() + subPath,
    'SUB64=' + publicBase() + sub64Path,
    ''
  ].join('\n');
  writePrivate(OUTPUT_FILE, text);
}

async function detectGeo() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      headers: { 'user-agent': 'hostship-node/1.0' },
      signal: ctl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.text();
    const m = Object.fromEntries(
      body.split(/\r?\n/).filter(Boolean).map(line => {
        const p = line.indexOf('=');
        return p > 0 ? [line.slice(0, p), line.slice(p + 1)] : [line, ''];
      })
    );
    if (/^[A-Z]{2}$/.test(String(m.loc || ''))) countryCode = String(m.loc);
    if (m.ip) egressIp = String(m.ip);
    refreshNodeName();
    writeOutput();
    console.log('GEO_READY country=' + (countryCode || 'unknown') + ' egress_ip=' + (egressIp || 'unknown'));
    return true;
  } catch (e) {
    console.log('GEO_PENDING reason=' + String(e.message || e));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body, token = '') {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'container-test-hostship/1.1'
    };
    if (token) {
      headers.authorization = 'Bearer ' + token;
      headers['x-registry-token'] = token;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + (text ? ' ' + text.slice(0, 200) : ''));
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function registryPayload() {
  const uri = registryNodeUri || nodeUri();
  const parsed = new URL(uri);
  const query = parsed.searchParams;
  const security = String(query.get('security') || registrySecurity || 'none').toLowerCase();
  const transport = String(query.get('type') || registryTransport || 'ws').toLowerCase();
  const address = parsed.hostname;
  const port = Number(parsed.port || (security === 'tls' ? 443 : 80));
  const sni = String(query.get('sni') || registrySni || '');

  return {
    kind: 'proxy',
    node_id: identity.nodeId,
    name: nodeName,
    provider: 'host-ship',
    protocol: 'vless',
    uri,
    priority: 80,
    address,
    port,
    transport,
    tls: security === 'tls',
    metadata: {
      location: countryCode || '',
      platform: 'Host-Ship.com',
      runtime: 'rust-reality 1.6.1 + NodeJS 24 + cloudflared',
      allocation: address + ':' + port,
      transport,
      security,
      sni
    }
  };
}

function publicRegistryPayload() {
  return {
    ...registryPayload(),
    endpoint: registryEndpoint || publicBase(),
    proof: registryProof
  };
}

function publicRegistryPayloadForUri(uri, nodeId, endpoint) {
  const parsed = new URL(uri);
  const query = parsed.searchParams;
  const security = String(query.get('security') || 'none').toLowerCase();
  const transport = String(query.get('type') || 'tcp').toLowerCase();
  const address = parsed.hostname;
  const port = Number(parsed.port || (security === 'tls' ? 443 : 80));
  const encodedLabel = String(parsed.hash || '').replace(/^#/, '');
  let name = 'HostShip-01-Reality';
  try { if (encodedLabel) name = decodeURIComponent(encodedLabel); } catch {}
  return {
    kind: 'proxy',
    node_id: nodeId,
    name,
    provider: 'host-ship',
    protocol: 'vless',
    uri,
    priority: 80,
    address,
    port,
    transport,
    tls: security === 'tls',
    metadata: {
      location: countryCode || '',
      platform: 'Host-Ship.com',
      runtime: 'rust-reality 1.6.1 + NodeJS 24 + cloudflared',
      allocation: address + ':' + port,
      transport,
      security,
      sni: String(query.get('sni') || ''),
      flow: String(query.get('flow') || '')
    },
    endpoint,
    proof: registryProof
  };
}

async function registerAdditionalNodes({ quiet = false } = {}) {
  if (!registryEnabled || !registryForcePublicProof || !registryDirectEndpoint || !registryProof) {
    registryAdditionalRegistered = false;
    registryAdditionalLastError = 'not_configured';
    return false;
  }
  const realityUri = subscriptionUris().find(uri => {
    try {
      const parsed = new URL(uri);
      return parsed.searchParams.get('security') === 'reality' &&
        parsed.searchParams.get('type') === 'tcp';
    } catch {
      return false;
    }
  });
  if (!realityUri) {
    registryAdditionalRegistered = false;
    registryAdditionalLastError = 'reality_uri_not_found';
    return false;
  }
  registryAdditionalLastError = '';
  const prefix = identity.nodeId.replace(/-native$/i, '');
  const nodeId = prefix + '-reality';
  try {
    await verifyRegistryEndpoint();
    const payload = publicRegistryPayloadForUri(realityUri, nodeId, registryDirectEndpoint);
    const responseText = await postJson(registryBase + '/api/v1/register-public', payload);
    const response = JSON.parse(responseText || '{}');
    if (
      response?.ok !== true ||
      response?.node_id !== nodeId ||
      response?.subscription_eligible !== true
    ) {
      throw new Error('registry did not confirm REALITY subscription registration');
    }
    const firstReady = !registryAdditionalRegistered;
    registryAdditionalRegistered = true;
    registryAdditionalLastError = '';
    if (!quiet || firstReady) {
      console.log('REGISTRY_READY node_id=' + nodeId + ' provider=host-ship mode=public-proof route=reality action=' + String(response.action || 'confirmed'));
    }
    return true;
  } catch (error) {
    registryAdditionalRegistered = false;
    const reason = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 220);
    registryAdditionalLastError = reason;
    rateLimitedLog(
      'registry-additional-failure',
      'REGISTRY_ADDITIONAL_DEFERRED node_id=' + nodeId + ' route=reality reason=' + reason,
      5 * 60 * 1000
    );
    return false;
  }
}

async function verifyRegistryEndpoint() {
  if (!registryEndpoint) return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const response = await fetch(registryEndpoint + '/health', {
      headers: { 'user-agent': 'hostship-public-proof/1', 'cache-control': 'no-cache' },
      signal: ctl.signal
    });
    if (!response.ok) throw new Error('registry endpoint health HTTP ' + response.status);
    const health = await response.json();
    if (health.registry_proof_sha256 !== registryProofSha256) {
      throw new Error('registry endpoint proof mismatch');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function registerNode({ quiet = false } = {}) {
  if (!registryEnabled || !registryNodeUri) {
    registryRegistered = false;
    if (!registrySkipLogged) {
      registrySkipLogged = true;
      console.log('REGISTRY_SKIPPED reason=cf_tls_ws_node_not_configured');
    }
    return false;
  }
  registryToken = registryForcePublicProof ? '' : readRegistryToken();
  const mode = registryToken ? 'bearer-token' : 'public-proof';
  try {
    if (!registryToken) await verifyRegistryEndpoint();
    let responseText = '';
    if (registryToken) {
      if (!quiet) console.log('REGISTRY_TOKEN_READY source=' + registryTokenSource);
      responseText = await postJson(registryBase + registerPath, registryPayload(), registryToken);
    } else {
      responseText = await postJson(registryBase + '/api/v1/register-public', publicRegistryPayload());
      try {
        const response = JSON.parse(responseText || '{}');
        const lease = Number(response.lease_seconds);
        if (Number.isFinite(lease) && lease >= 120) registryLeaseSeconds = lease;
      } catch {}
    }
    const firstReady = !registryRegistered;
    registryRegistered = true;
    registryLastError = '';
    registryFailureCount = 0;
    if (!quiet || firstReady) {
      console.log('REGISTRY_READY node_id=' + identity.nodeId + ' provider=host-ship mode=' + mode);
    }
    return true;
  } catch (e) {
    registryRegistered = false;
    const reason = String(e.message || e).replace(/\s+/g, ' ').slice(0, 220);
    registryLastError = reason;
    if (/HTTP 403\b.*uri rejected/i.test(reason)) {
      registryPermanentFailure = true;
      registryFailureCount = 8;
      rateLimitedLog(
        'registry-uri-rejected',
        'REGISTRY_REGISTER_REJECTED_PERMANENT mode=' + mode + ' reason=' + reason,
        60 * 60 * 1000
      );
      return false;
    }
    registryFailureCount = Math.min(registryFailureCount + 1, 8);
    const retryMs = Math.min(
      REGISTRY_BACKOFF_MAX_MS,
      REGISTRY_BACKOFF_BASE_MS * (2 ** (registryFailureCount - 1))
    );
    rateLimitedLog(
      'registry-failure',
      'REGISTRY_REGISTER_DEFERRED mode=' + mode +
      ' reason=' + reason +
      ' retry_in_seconds=' + Math.ceil(retryMs / 1000),
      5 * 60 * 1000
    );
    return false;
  }
}

async function heartbeat() {
  if (!registryEnabled || !registryNodeUri) return;
  if (registryForcePublicProof) {
    registryToken = '';
    await registerNode({ quiet: true });
    await registerAdditionalNodes({ quiet: true });
    return;
  }
  registryToken = readRegistryToken();
  if (!registryToken) {
    await registerNode({ quiet: true });
    return;
  }
  try {
    await postJson(registryBase + heartbeatPath, {
      node_id: identity.nodeId,
      status: 'online'
    }, registryToken);
    registryFailureCount = 0;
    registryRegistered = true;
  } catch (e) {
    console.log('REGISTRY_HEARTBEAT_RECOVER reason=' + String(e.message || e));
    await registerNode({ quiet: true });
  }
}

function registryRefreshDelayMs() {
  if (registryFailureCount > 0) {
    return Math.min(
      REGISTRY_BACKOFF_MAX_MS,
      REGISTRY_BACKOFF_BASE_MS * (2 ** (registryFailureCount - 1))
    );
  }
  if (registryToken) return heartbeatMinutes * 60000;
  const safeSeconds = Math.max(60, Math.floor(registryLeaseSeconds * 2 / 3));
  return safeSeconds * 1000;
}

function scheduleRegistryRefresh() {
  if (!registryEnabled || !registryNodeUri || registryPermanentFailure) return;
  if (registryRefreshTimer) clearTimeout(registryRefreshTimer);
  registryRefreshTimer = setTimeout(async () => {
    if (registryRefreshRunning) {
      scheduleRegistryRefresh();
      return;
    }
    registryRefreshRunning = true;
    try {
      if (!countryCode) await detectGeo();
      await heartbeat();
    } finally {
      registryRefreshRunning = false;
      scheduleRegistryRefresh();
    }
  }, registryRefreshDelayMs());
  registryRefreshTimer.unref();
}

function isPrivateIp(host) {
  if (net.isIP(host) === 4) {
    const p = host.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168);
  }
  if (net.isIP(host) === 6) {
    const h = host.toLowerCase();
    return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
  }
  return false;
}

function parseVlessRequest(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('invalid VLESS buffer');
  if (buf.length < 17) return null;

  let i = 0;
  const version = buf[i++];
  if (version !== 0) throw new Error('unsupported VLESS version');

  const id = buf.subarray(i, i + 16);
  i += 16;
  if (id.length !== 16 || !crypto.timingSafeEqual(id, expectedUuid)) {
    throw new Error('uuid mismatch');
  }

  if (i >= buf.length) return null;
  const optLen = buf[i++];
  if (i + optLen + 4 > buf.length) return null;
  i += optLen;

  const command = buf[i++];
  if (command !== 1) throw new Error('only TCP CONNECT is supported');

  const port = buf.readUInt16BE(i);
  i += 2;
  const atyp = buf[i++];
  let host = '';

  if (atyp === 1) {
    if (i + 4 > buf.length) return null;
    host = Array.from(buf.subarray(i, i + 4)).join('.');
    i += 4;
  } else if (atyp === 2) {
    if (i >= buf.length) return null;
    const len = buf[i++];
    if (!len) throw new Error('bad domain');
    if (i + len > buf.length) return null;
    host = buf.subarray(i, i + len).toString('utf8');
    i += len;
  } else if (atyp === 3) {
    if (i + 16 > buf.length) return null;
    const words = [];
    for (let n = 0; n < 8; n++) words.push(buf.readUInt16BE(i + n * 2).toString(16));
    host = words.join(':');
    i += 16;
  } else {
    throw new Error('unsupported address type');
  }

  if (!allowPrivateTargets && isPrivateIp(host)) throw new Error('private target blocked');
  return { version, host, port, payload: buf.subarray(i) };
}

function wsFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;

  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  return Buffer.concat([header, data]);
}

class WsPeer {
  constructor(socket, head, onBinary) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.onBinary = onBinary;
    this.closed = false;
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.maxBufferedBytes = 2 * 1024 * 1024;

    socket.on('data', chunk => this.feed(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => {
      this.closed = true;
      if (this.onClose) this.onClose();
    });

    if (head && head.length) process.nextTick(() => this.feed(head));
  }

  feed(chunk) {
    if (this.closed) return;
    if (this.buffer.length + chunk.length > this.maxBufferedBytes) return this.close(1009);
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (this.buffer.length < 2) return;

      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = !!(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);

      if (!masked) return this.close(1002);

      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > 1048576n) return this.close(1009);
        len = Number(big);
        off = 10;
      }

      if (len > 1048576) return this.close(1009);
      if (this.buffer.length < off + 4 + len) return;

      const mask = this.buffer.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.from(this.buffer.subarray(off, off + len));
      this.buffer = this.buffer.subarray(off + len);

      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        this.send(0xA, payload);
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x1) return this.close(1003);

      if (opcode === 0x2) {
        if (fin) this.onBinary(payload);
        else {
          this.fragmentOpcode = 2;
          this.fragments = [payload];
          this.fragmentBytes = payload.length;
        }
        continue;
      }

      if (opcode === 0 && this.fragmentOpcode === 2) {
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxBufferedBytes) return this.close(1009);
        this.fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.fragments, this.fragmentBytes);
          this.fragments = [];
          this.fragmentBytes = 0;
          this.fragmentOpcode = null;
          this.onBinary(msg);
        }
        continue;
      }

      return this.close(1002);
    }
  }

  send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    return this.socket.write(wsFrame(opcode, payload));
  }

  binary(payload) {
    return this.send(2, payload);
  }

  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    try {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      this.socket.write(wsFrame(8, p));
    } catch {}
    try { this.socket.end(); } catch {}
    setTimeout(() => {
      try { this.socket.destroy(); } catch {}
    }, 250).unref();
  }
}

function subscriptionHeaders() {
  return {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'pragma': 'no-cache',
    'x-content-type-options': 'nosniff',
    'profile-title': 'HostShip',
    'profile-update-interval': '24'
  };
}

function requestHandler(req, res) {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}

  if (pathname === '/') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    });
    return res.end('host-ship node ready\n');
  }

  if (pathname === '/health') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    return res.end(JSON.stringify({
      ok: true,
      service: 'hostship-native-node',
      provider: 'host-ship',
      runtime: process.version,
      listen_port: listenPort,
      public_host: publicHost,
      public_port: publicPort,
      endpoint: publicBase(),
      transport: primaryTransport || 'ws',
      tls: primarySecurity === 'tls',
      security: primarySecurity || 'none',
      sni: primarySni || null,
      node_id: identity.nodeId,
      country: countryCode || null,
      egress_ip: egressIp || null,
      geo: { country: countryCode || null, egress_ip: egressIp || null, verified: !!countryCode && !!egressIp },
      registry_proof_sha256: registryProofSha256,
      registry_configured: registryEnabled && !!registryNodeUri,
      registry_enabled: registryEnabled && !!registryNodeUri,
      registry_registered: registryRegistered,
      registry_additional_registered: registryAdditionalRegistered,
      registry_additional_last_error: registryAdditionalLastError || null,
      registry_last_error: registryLastError || null,
      registry_uri_security: registrySecurity || null,
      registry_auth_mode: registryForcePublicProof ? 'public-proof' : (readRegistryToken() ? 'bearer-token' : 'public-proof'),
      connections: { active: activeConnections, total: totalConnections },
      subscription_nodes: subscriptionUris().length,
      advertised_security: primarySecurity || 'none',
      advertised_nodes: advertisedNodeSummary(),
      verbose_traffic_logs: verboseTrafficLogs
    }));
  }

  if (pathname === nodePath) {
    res.writeHead(200, subscriptionHeaders());
    return res.end(nodeUri() + '\n');
  }

  if (pathname === subPath) {
    res.writeHead(200, subscriptionHeaders());
    return res.end(isShadowrocketRequest(req) ? shadowrocketRaw() : subscriptionRaw());
  }

  if (pathname === sub64Path) {
    res.writeHead(200, subscriptionHeaders());
    const raw = isShadowrocketRequest(req) ? shadowrocketRaw() : subscriptionRaw();
    return res.end(Buffer.from(raw, 'utf8').toString('base64') + '\n');
  }

  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end('Not Found\n');
}

const server = http.createServer(requestHandler);
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}

  const key = req.headers['sec-websocket-key'];
  trafficLog('WS_UPGRADE_SEEN host=' + String(req.headers.host || '') + ' path_match=' + (pathname === identity.wsPath ? 'yes' : 'no'));
  if (
    pathname !== identity.wsPath ||
    !key ||
    String(req.headers.upgrade || '').toLowerCase() !== 'websocket'
  ) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }

  const accept = crypto
    .createHash('sha1')
    .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  trafficLog('WS_UPGRADE_ACCEPTED');
  activeConnections++;
  totalConnections++;
  let connectionClosed = false;
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  let remote = null;
  let established = false;
  let handshakeComplete = false;
  let clientHandshakeBuffer = Buffer.alloc(0);
  let pendingClientChunks = [];
  let pendingClientBytes = 0;
  let connectRetryTimer = null;
  let outboundAttempts = 0;

  function queueClientData(data) {
    if (!data || !data.length) return true;
    pendingClientBytes += data.length;
    if (pendingClientBytes > MAX_PENDING_CLIENT_BYTES) {
      peer.close(1009);
      return false;
    }
    pendingClientChunks.push(Buffer.from(data));
    return true;
  }

  function flushClientData(target) {
    if (!target || target.destroyed || peer.closed) return;
    for (const chunk of pendingClientChunks) {
      const writable = target.write(chunk);
      if (!writable && !socket.destroyed) socket.pause();
    }
    pendingClientChunks = [];
    pendingClientBytes = 0;
  }

  function failOutbound(err) {
    rateLimitedLog(
      'outbound-fail',
      'VLESS_OUTBOUND_FAIL reason=' + String(err?.code || err?.message || 'unknown')
    );
    if (remote) {
      const failed = remote;
      remote = null;
      try { failed.destroy(); } catch {}
    }
    peer.close(1011);
  }

  function connectOutbound(info) {
    const maxAttempts = 3;

    function attemptConnect() {
      if (peer.closed) return;
      outboundAttempts += 1;
      const candidate = net.connect({ host: info.host, port: info.port });
      remote = candidate;

      candidate.setTimeout(60000, () => {
        const timeoutError = new Error('outbound connect timeout');
        timeoutError.code = 'ETIMEDOUT';
        candidate.destroy(timeoutError);
      });

      candidate.once('connect', () => {
        if (peer.closed || remote !== candidate) {
          candidate.destroy();
          return;
        }
        established = true;
        candidate.setTimeout(0);
        trafficLog('VLESS_OUTBOUND_READY');
        if (!firstProxySuccessLogged) {
          firstProxySuccessLogged = true;
          console.log(
            'PROXY_FIRST_SUCCESS target_port=' + info.port +
            ' target_family=' + (net.isIP(info.host) || 'domain')
          );
        }
        peer.binary(Buffer.from([info.version, 0]));
        flushClientData(candidate);
      });

      candidate.on('drain', () => {
        if (!socket.destroyed) socket.resume();
      });
      socket.on('drain', () => {
        if (remote === candidate && !candidate.destroyed) candidate.resume();
      });
      candidate.on('data', chunk => {
        if (!peer.binary(chunk)) candidate.pause();
      });
      candidate.on('end', () => peer.close());
      candidate.on('error', err => {
        if (remote !== candidate) return;
        if (
          !established &&
          !peer.closed &&
          RETRYABLE_CONNECT_ERRORS.has(String(err?.code || '')) &&
          outboundAttempts < maxAttempts
        ) {
          remote = null;
          try { candidate.destroy(); } catch {}
          const delayMs = 300 * outboundAttempts;
          rateLimitedLog(
            'outbound-retry',
            'VLESS_OUTBOUND_RETRY reason=' + String(err.code) +
            ' attempt=' + outboundAttempts + '/' + maxAttempts,
            10000
          );
          connectRetryTimer = setTimeout(attemptConnect, delayMs);
          return;
        }
        failOutbound(err);
      });
    }

    attemptConnect();
  }

  const peer = new WsPeer(socket, head, data => {
    if (established) {
      if (remote && !remote.destroyed) {
        const writable = remote.write(data);
        if (!writable && !socket.destroyed) socket.pause();
      }
      return;
    }

    if (handshakeComplete) {
      queueClientData(data);
      return;
    }

    clientHandshakeBuffer = Buffer.concat([clientHandshakeBuffer, data]);
    if (clientHandshakeBuffer.length > MAX_PENDING_CLIENT_BYTES) {
      rateLimitedLog('vless-handshake-large', 'VLESS_REJECT reason=handshake_too_large');
      return peer.close(1009);
    }

    let info;
    try {
      info = parseVlessRequest(clientHandshakeBuffer);
    } catch (e) {
      const reason = String(e.message || e);
      if (reason === 'uuid mismatch') {
        rateLimitedLog('vless-auth', 'VLESS_REJECT reason=uuid_mismatch');
      } else {
        rateLimitedLog('vless-protocol', 'VLESS_REJECT reason=' + reason);
      }
      return peer.close(1008);
    }

    if (!info) return;
    handshakeComplete = true;
    clientHandshakeBuffer = Buffer.alloc(0);
    if (!queueClientData(info.payload)) return;
    connectOutbound(info);
  });

  peer.onClose = () => {
    if (!connectionClosed) {
      connectionClosed = true;
      activeConnections = Math.max(0, activeConnections - 1);
    }
    if (connectRetryTimer) clearTimeout(connectRetryTimer);
    connectRetryTimer = null;
    const activeRemote = remote;
    remote = null;
    try { if (activeRemote) activeRemote.destroy(); } catch {}
  };
});

async function runStartupDiagnostics() {
  console.log('DIAG_ENV SERVER_PORT=' + String(process.env.SERVER_PORT || '') + ' PORT=' + String(process.env.PORT || '') + ' listen=' + listenHost + ':' + listenPort);

  try {
    const local = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: listenPort, path: '/health', timeout: 4000 }, res => {
        res.resume();
        res.statusCode === 200 ? resolve(res.statusCode) : reject(new Error('HTTP ' + res.statusCode));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    console.log('DIAG_LOCAL_HTTP_OK status=' + local);
  } catch (e) {
    console.log('DIAG_LOCAL_HTTP_FAIL reason=' + String(e.message || e));
  }

  let resolved = [];
  try {
    resolved = await dns.lookup(publicHost, { all: true });
    console.log('DIAG_DNS_OK host=' + publicHost + ' addresses=' + resolved.map(x => x.address + '/v' + x.family).join(','));
  } catch (e) {
    console.log('DIAG_DNS_FAIL host=' + publicHost + ' reason=' + String(e.code || e.message || e));
  }

  if (envBool('HOSTSHIP_REALITY_DIRECT', false)) {
    console.log('DIAG_PUBLIC_HAIRPIN_SKIP reason=public_port_is_raw_reality');
    return;
  }

  try {
    const publicProbe = await new Promise((resolve, reject) => {
      const req = http.get({
        host: publicHost,
        port: publicPort,
        path: '/health',
        headers: { Host: publicHost + ':' + publicPort },
        timeout: 5000
      }, res => {
        res.resume();
        res.statusCode === 200 ? resolve(res.statusCode) : reject(new Error('HTTP ' + res.statusCode));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    console.log('DIAG_PUBLIC_HAIRPIN_OK status=' + publicProbe);
  } catch (e) {
    console.log('DIAG_PUBLIC_HAIRPIN_FAIL reason=' + String(e.code || e.message || e) + ' note=hairpin_may_be_blocked');
  }
}

async function onListen() {
  refreshNodeName();
  writeOutput();

  console.log('SERVICE_READY HTTP/WS_BACKEND ' + listenHost + ':' + listenPort);
  console.log(
    'NATIVE_READY ' + publicHost + ':' + publicPort +
    ' transport=' + (primaryTransport || 'ws') +
    ' security=' + (primarySecurity || 'none')
  );
  console.log('NODE_ID ' + identity.nodeId);
  const startupUris = subscriptionUris();
  console.log('NODE_COUNT ' + startupUris.length);
  for (let i = 0; i < startupUris.length; i++) {
    console.log('NODE_LINK_' + (i + 1) + ' ' + startupUris[i]);
  }
  console.log('SUB_URL ' + publicBase() + subPath);
  console.log('SUB64_URL ' + publicBase() + sub64Path);

  await runStartupDiagnostics();
  await detectGeo();
  console.log('PRIMARY_LINK_FINAL ' + nodeUri());
  const finalUris = subscriptionUris();
  for (let i = 0; i < finalUris.length; i++) {
    console.log('NODE_LINK_FINAL_' + (i + 1) + ' ' + finalUris[i]);
  }

  await registerNode();
  await registerAdditionalNodes();
  scheduleRegistryRefresh();
}

if (process.env.HOSTSHIP_SELF_TEST === '1') {
  function selfAssert(condition, message) {
    if (!condition) throw new Error('SELF_TEST_FAILED ' + message);
  }

  const domain = Buffer.from('example.com', 'utf8');
  const payload = Buffer.from('early-client-payload', 'utf8');
  const request = Buffer.concat([
    Buffer.from([0]),
    expectedUuid,
    Buffer.from([0, 1, 1, 187, 2, domain.length]),
    domain,
    payload
  ]);

  let accumulated = Buffer.alloc(0);
  let parsed = null;
  let nextOffset = 0;
  for (let offset = 0; offset < request.length; offset += 3) {
    const chunk = request.subarray(offset, offset + 3);
    accumulated = Buffer.concat([accumulated, chunk]);
    parsed = parseVlessRequest(accumulated);
    nextOffset = offset + chunk.length;
    if (parsed) break;
  }

  selfAssert(!!parsed, 'fragmented VLESS request did not complete');
  selfAssert(parsed.host === 'example.com', 'domain parsing mismatch');
  selfAssert(parsed.port === 443, 'port parsing mismatch');

  // parseVlessRequest returns as soon as the header is complete. Bytes that arrive
  // in later WebSocket frames are queued separately by the live connection handler.
  const recoveredPayload = Buffer.concat([
    parsed.payload,
    request.subarray(nextOffset)
  ]);
  selfAssert(
    recoveredPayload.toString('utf8') === 'early-client-payload',
    'early payload was not preserved across fragmented frames'
  );

  const wrongUuidRequest = Buffer.from(request);
  wrongUuidRequest[1] ^= 0xff;
  let mismatchRejected = false;
  try {
    parseVlessRequest(wrongUuidRequest);
  } catch (error) {
    mismatchRejected = String(error.message || error) === 'uuid mismatch';
  }
  selfAssert(mismatchRejected, 'invalid UUID was not rejected');

  console.log('SELF_TEST_OK fragmented_handshake=yes early_payload=yes uuid_auth=yes');
} else {
  server.listen(listenPort, listenHost, () => {
    onListen().catch(e => console.log('STARTUP_ASYNC_FAILED reason=' + String(e.message || e)));
  });
}

function shutdown(signal) {
  console.log('SHUTDOWN ' + signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
