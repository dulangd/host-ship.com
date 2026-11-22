'use strict';

const net = require('node:net');

function classifyPrefix(buffer) {
  const methods = ['GET ', 'HEAD ', 'POST ', 'PUT ', 'OPTIONS ', 'PATCH ', 'DELETE '];
  if (!buffer.length) return null;
  const sample = buffer.toString('ascii', 0, Math.min(buffer.length, 16));
  for (const method of methods) {
    const prefix = sample.slice(0, Math.min(sample.length, method.length));
    if (method.startsWith(prefix)) return buffer.length >= method.length ? 'http' : null;
  }
  return 'raw';
}

function readPrefix(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const finish = (err, value) => {
      if (done) return;
      done = true;
      cleanup();
      socket.pause();
      if (err) reject(err);
      else resolve(value);
    };
    const onData = chunk => {
      data = Buffer.concat([data, chunk]);
      const type = classifyPrefix(data);
      if (type) return finish(null, { type, data });
      if (data.length >= 16) return finish(null, { type: 'raw', data });
    };
    const onError = err => finish(err);
    const onClose = () => finish(new Error('client closed before protocol detection'));
    const timer = setTimeout(() => finish(new Error('protocol detection timeout')), timeoutMs);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.resume();
  });
}

function proxySocket(client, backendPort, initial) {
  const backend = net.createConnection({ host: '127.0.0.1', port: backendPort });
  let connected = false;

  backend.once('connect', () => {
    connected = true;
    if (initial && initial.length) backend.write(initial);
    client.pipe(backend);
    backend.pipe(client);
    client.resume();
  });

  backend.on('error', () => client.destroy());
  client.on('error', () => backend.destroy());
  client.on('close', () => {
    if (connected && !backend.destroyed) backend.destroy();
  });
}

class HostShipMux {
  constructor({ publicPort, realityPort, httpPort }) {
    this.publicPort = Number(publicPort);
    this.realityPort = Number(realityPort);
    this.httpPort = Number(httpPort);
    this.server = null;
  }

  async start() {
    const ports = [this.publicPort, this.realityPort, this.httpPort];
    if (ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) {
      throw new Error('MUX ports must be valid TCP ports');
    }
    if (new Set(ports).size !== ports.length) {
      throw new Error('public, REALITY backend and HTTP backend ports must be distinct');
    }

    this.server = net.createServer(socket => this.handle(socket));
    this.server.on('error', err => {
      console.error('MUX_SERVER_ERROR reason=' + String(err.code || err.message || err));
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.publicPort, '0.0.0.0', resolve);
    });

    console.log(
      'MUX_READY public=0.0.0.0:' + this.publicPort +
      ' raw=reality@127.0.0.1:' + this.realityPort +
      ' http=127.0.0.1:' + this.httpPort
    );
    return this;
  }

  async handle(socket) {
    socket.setNoDelay(true);
    socket.on('error', () => {});
    let first;
    try {
      first = await readPrefix(socket);
    } catch {
      socket.destroy();
      return;
    }

    if (first.type === 'http') {
      proxySocket(socket, this.httpPort, first.data);
      return;
    }
    proxySocket(socket, this.realityPort, first.data);
  }

  close() {
    if (!this.server) return;
    try { this.server.close(); } catch {}
    this.server = null;
  }
}

module.exports = { HostShipMux, classifyPrefix };
