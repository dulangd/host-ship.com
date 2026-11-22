'use strict';

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HostShipMux } = require('./hostship-mux.js');
const { startReality } = require('./hostship-reality.js');

const HOME = process.env.HOME || '/home/container';
const PUBLIC_HOST = String(process.env.PUBLIC_HOST || '45.131.65.244').trim();
const PUBLIC_PORT = validPort(process.env.SERVER_PORT || process.env.PORT || '30376', 'SERVER_PORT');

function validPort(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(label + ' must be a TCP port in 1..65535');
  }
  return value;
}

function reservePort(excluded) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = Number(server.address().port);
      server.close(err => {
        if (err) return reject(err);
        if (excluded.has(port)) return reservePort(excluded).then(resolve, reject);
        excluded.add(port);
        resolve(port);
      });
    });
  });
}

function waitForPort(port, child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      if (child.exitCode !== null) {
        reject(new Error('HTTP backend exited before listening; code=' + child.exitCode));
        return;
      }
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        socket.destroy();
        if (ok) return resolve();
        if (Date.now() >= deadline) return reject(new Error('HTTP backend listen timeout'));
        setTimeout(attempt, 150);
      };
      socket.setTimeout(600);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    };
    attempt();
  });
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Host-Ship REALITY mode requires Linux x86_64');
  }
  if (!PUBLIC_HOST) throw new Error('PUBLIC_HOST is empty');

  const excluded = new Set([PUBLIC_PORT]);
  const realityPort = await reservePort(excluded);
  const httpPort = await reservePort(excluded);

  const label = String(process.env.RR_NODE_NAME || 'HostShip-01-Reality').trim() || 'HostShip-01-Reality';
  const reality = await startReality({
    backendPort: realityPort,
    publicHost: PUBLIC_HOST,
    publicPort: PUBLIC_PORT,
    label
  });

  const mux = new HostShipMux({
    publicPort: PUBLIC_PORT,
    realityPort,
    httpPort
  });
  await mux.start();

  const backendEnv = {
    ...process.env,
    BACKEND_PORT: String(httpPort),
    LISTEN_HOST: '127.0.0.1',
    PUBLIC_HOST,
    PUBLIC_PORT: String(PUBLIC_PORT),
    PRIMARY_NODE_URI: reality.uri,
    PRIMARY_TRANSPORT: 'tcp',
    PRIMARY_SECURITY: 'reality',
    PRIMARY_SNI: String(reality.meta.sni || ''),
    NODE_NAME: String(process.env.NODE_NAME || 'HostShip-01-Reality'),
    HOSTSHIP_REALITY_MODE: '1'
  };

  const backend = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd: __dirname,
    env: backendEnv,
    stdio: ['ignore', 'inherit', 'inherit']
  });
  await waitForPort(httpPort, backend);

  console.log('='.repeat(78));
  console.log('HOSTSHIP_REALITY_READY');
  console.log('PUBLIC_ENDPOINT ' + PUBLIC_HOST + ':' + PUBLIC_PORT);
  console.log('TRANSPORT raw TCP');
  console.log('HTTP_MANAGEMENT same-port /health + subscription');
  console.log('REALITY_LINK_FINAL ' + reality.uri);
  console.log('='.repeat(78));

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('BOOTSTRAP_SHUTDOWN ' + signal);
    mux.close();
    for (const child of [backend, reality.child]) {
      try {
        if (child && child.exitCode === null) child.kill('SIGTERM');
      } catch {}
    }
    setTimeout(() => process.exit(0), 600).unref();
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
}

main().catch(error => {
  console.error('HOSTSHIP_REALITY_FATAL reason=' + String(error?.message || error));
  process.exitCode = 1;
});
