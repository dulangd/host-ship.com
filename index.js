'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const entry = path.join(__dirname, 'hostship-bootstrap.js');

if (typeof process.execve === 'function') {
  process.execve(process.execPath, [process.execPath, entry, ...process.argv.slice(2)], process.env);
  throw new Error('process.execve unexpectedly returned');
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  cwd: __dirname,
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code, signal) => {
  if (signal) {
    try { process.kill(process.pid, signal); } catch {}
    return;
  }
  process.exit(code ?? 1);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
