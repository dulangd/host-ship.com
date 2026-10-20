import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'index.js');
const execve = Reflect.get(process, 'execve');

if (typeof execve === 'function') {
  execve.call(process, process.execPath, [process.execPath, entry, ...process.argv.slice(2)], process.env);
  throw new Error('process.execve unexpectedly returned');
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
