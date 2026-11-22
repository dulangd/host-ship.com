'use strict';

const net = require('node:net');

const HTTP_METHODS = ['GET ', 'HEAD ', 'POST ', 'PUT ', 'OPTIONS ', 'PATCH ', 'DELETE '];
const MAX_PREFIX_BYTES = 128 * 1024;

function readUInt24BE(buffer, offset) {
  return (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
}

function collectTlsHandshake(buffer) {
  let offset = 0;
  const chunks = [];
  let total = 0;

  while (true) {
    if (buffer.length < offset + 5) return null;
    const type = buffer[offset];
    const major = buffer[offset + 1];
    if (type !== 0x16 || major !== 0x03) {
      return { complete: true, payload: Buffer.alloc(0) };
    }

    const length = buffer.readUInt16BE(offset + 3);
    if (length <= 0 || length > 65535) {
      return { complete: true, payload: Buffer.alloc(0) };
    }
    if (buffer.length < offset + 5 + length) return null;

    const payload = buffer.subarray(offset + 5, offset + 5 + length);
    chunks.push(payload);
    total += payload.length;
    const joined = Buffer.concat(chunks, total);

    if (joined.length >= 4) {
      const handshakeLength = readUInt24BE(joined, 1);
      if (joined[0] !== 0x01) return { complete: true, payload: joined };
      if (joined.length >= 4 + handshakeLength) {
        return { complete: true, payload: joined.subarray(0, 4 + handshakeLength) };
      }
    }

    offset += 5 + length;
    if (offset >= buffer.length) return null;
  }
}

function parseClientHelloSni(buffer) {
  const collected = collectTlsHandshake(buffer);
  if (collected == null) return null;
  const hello = collected.payload;
  if (hello.length < 4 || hello[0] !== 0x01) return { complete: true, sni: '' };

  const bodyLength = readUInt24BE(hello, 1);
  if (hello.length < 4 + bodyLength) return null;

  let p = 4;
  const end = 4 + bodyLength;
  if (p + 34 > end) return { complete: true, sni: '' };
  p += 34; // legacy_version + random

  if (p + 1 > end) return { complete: true, sni: '' };
  const sessionLen = hello[p++];
  if (p + sessionLen > end) return { complete: true, sni: '' };
  p += sessionLen;

  if (p + 2 > end) return { complete: true, sni: '' };
  const cipherLen = hello.readUInt16BE(p);
  p += 2;
  if (p + cipherLen > end) return { complete: true, sni: '' };
  p += cipherLen;

  if (p + 1 > end) return { complete: true, sni: '' };
  const compressionLen = hello[p++];
  if (p + compressionLen > end) return { complete: true, sni: '' };
  p += compressionLen;

  if (p === end) return { complete: true, sni: '' };
  if (p + 2 > end) return { complete: true, sni: '' };
  const extensionsLen = hello.readUInt16BE(p);
  p += 2;
  const extensionsEnd = Math.min(end, p + extensionsLen);

  while (p + 4 <= extensionsEnd) {
    const type = hello.readUInt16BE(p);
    const length = hello.readUInt16BE(p + 2);
    p += 4;
    if (p + length > extensionsEnd) break;

    if (type === 0x0000 && length >= 5) {
      let q = p;
      const listLength = hello.readUInt16BE(q);
      q += 2;
      const listEnd = Math.min(p + length, q + listLength);
      while (q + 3 <= listEnd) {
        const nameType = hello[q++];
        const nameLength = hello.readUInt16BE(q);
        q += 2;
        if (q + nameLength > listEnd) break;
        if (nameType === 0 && nameLength > 0) {
          return {
            complete: true,
            sni: hello.subarray(q, q + nameLength).toString('ascii').toLowerCase()
          };
        }
        q += nameLength;
      }
    }

    p += length;
  }

  return { complete: true, sni: '' };
}

function classifyPrefix(buffer) {
  if (!buffer.length) return null;

  const sample = buffer.toString('ascii', 0, Math.min(buffer.length, 16));
  let couldBeHttp = false;
  for (const method of HTTP_METHODS) {
    const prefix = sample.slice(0, Math.min(sample.length, method.length));
    if (method.startsWith(prefix)) {
      couldBeHttp = true;
      if (buffer.length >= method.length && sample.startsWith(method)) {
        return { type: 'http', sni: '' };
      }
    }
  }
  if (couldBeHttp) return null;

  if (buffer[0] === 0x16) {
    if (buffer.length < 3) return null;
    if (buffer[1] === 0x03) {
      const parsed = parseClientHelloSni(buffer);
      if (parsed == null) return null;
      return { type: 'tls', sni: parsed.sni || '' };
    }
  }

  return { type: 'raw', sni: '' };
}

function readPrefix(socket, timeoutMs = 6000) {
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
      if (data.length > MAX_PREFIX_BYTES) {
        finish(new Error('protocol prefix too large'));
        return;
      }
      const result = classifyPrefix(data);
      if (result) finish(null, { ...result, data });
    };
    const onError = error => finish(error);
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
  constructor({ publicPort, realityPort, tlsPort, httpPort, tlsSni }) {
    this.publicPort = Number(publicPort);
    this.realityPort = Number(realityPort);
    this.tlsPort = Number(tlsPort);
    this.httpPort = Number(httpPort);
    this.tlsSni = String(tlsSni || '').trim().toLowerCase();
    this.server = null;
    this.firstRouteLogged = new Set();
  }

  logRoute(name) {
    if (this.firstRouteLogged.has(name)) return;
    this.firstRouteLogged.add(name);
    console.log('MUX_ROUTE_READY route=' + name);
  }

  async start() {
    const ports = [this.publicPort, this.realityPort, this.tlsPort, this.httpPort];
    if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error('MUX ports must be valid TCP ports');
    }
    if (new Set(ports).size !== ports.length) {
      throw new Error('public, REALITY, TLS and HTTP ports must be distinct');
    }
    if (!this.tlsSni) throw new Error('TLS fallback SNI is empty');

    this.server = net.createServer(socket => this.handle(socket));
    this.server.on('error', error => {
      console.error('MUX_SERVER_ERROR reason=' + String(error.code || error.message || error));
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.publicPort, '0.0.0.0', resolve);
    });

    console.log(
      'MUX_READY public=0.0.0.0:' + this.publicPort +
      ' reality=127.0.0.1:' + this.realityPort +
      ' tls=127.0.0.1:' + this.tlsPort +
      ' http=127.0.0.1:' + this.httpPort +
      ' tls_sni=' + this.tlsSni
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
      this.logRoute('http');
      proxySocket(socket, this.httpPort, first.data);
      return;
    }

    if (first.type === 'tls' && first.sni === this.tlsSni) {
      this.logRoute('tls-ws');
      proxySocket(socket, this.tlsPort, first.data);
      return;
    }

    this.logRoute('reality');
    proxySocket(socket, this.realityPort, first.data);
  }

  close() {
    if (!this.server) return;
    try { this.server.close(); } catch {}
    this.server = null;
  }
}

module.exports = {
  HostShipMux,
  classifyPrefix,
  parseClientHelloSni
};
