/**
 * Starts mock-provider.mjs on a port the OS picks (`--port 0`) and resolves with
 * the port it reports on its ready line, so two checkouts' runs on one machine
 * never contend for the documented default (3799).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVIDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-provider.mjs');
const READY = /mock provider listening on http:\/\/127\.0\.0\.1:(\d+)\/v1/;

/** @returns {Promise<{ port: number, child: import('node:child_process').ChildProcess }>} */
export function startMock(extraArgs = [], { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROVIDER, '--port', '0', ...extraArgs], { stdio: ['ignore', 'pipe', 'inherit'] });
    let seen = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('the mock provider never reported its port')); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      seen += chunk;
      const match = READY.exec(seen);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.removeAllListeners('data');
      child.stdout.resume();
      resolve({ port: Number(match[1]), child });
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the mock provider exited at startup (${code})`)); });
  });
}
