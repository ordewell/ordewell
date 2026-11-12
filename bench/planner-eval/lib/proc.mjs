/** Child processes, ports and waiting, shared by the drivers. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Run a command to completion; output is kept for the error message, never printed. */
export function run(command, args, { cwd, env = process.env, timeoutMs = 30 * 60_000, input, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], shell });
    let out = '';
    const keep = (d) => { out = (out + d).slice(-40_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    if (input !== undefined) {
      // A child that exits without reading its input closes the pipe; that is its exit status's to report.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

export async function must(command, args, opts) {
  const r = await run(command, args, opts);
  if (r.code !== 0) throw new Error(`${command} ${args.join(' ')} exited ${r.code}: ${r.out.slice(-1500)}`);
  return r.out;
}

export function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns something truthy, or throw naming `what` once `timeoutMs` passes. */
export async function until(what, timeoutMs, probe, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Whether `name` is an executable on PATH. */
export function onPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (env.PATH ?? '').split(path.delimiter).some((dir) => exts.some((ext) => {
    try {
      fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}
