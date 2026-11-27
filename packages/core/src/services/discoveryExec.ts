import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { Socket } from 'net';

const execAsync = promisify(exec);
const activeProbes = new Set<() => void>();
const stopOnExit = () => { for (const stop of activeProbes) stop(); };
function watchProbe(stop: () => void): void {
  if (activeProbes.size === 0) process.once('exit', stopOnExit);
  activeProbes.add(stop);
}
function unwatchProbe(stop: () => void): void {
  activeProbes.delete(stop);
  if (activeProbes.size === 0) process.removeListener('exit', stopOnExit);
}

/** Run POSIX probes in their own process group. On Windows retain Node's
 * original exec behavior: it stops only the direct shell on timeout/abort.
 * A safe Windows tree lifetime requires a native job object (not taskkill on
 * a PID that could already have been reused). On POSIX, descendants that leave
 * the group or outlive its leader may survive: a recycled group ID cannot be
 * signalled safely. The exit hook runs on normal process exit, not SIGKILL.
 */
export function discoveryExec(command: string, options: { timeout?: number; env: NodeJS.ProcessEnv; maxBuffer?: number; signal?: AbortSignal }): Promise<{ stdout: string }> {
  if (process.platform === 'win32') {
    return execAsync(command, { windowsHide: true, timeout: options.timeout, env: options.env, ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }), signal: options.signal })
      .then(({ stdout }) => ({ stdout: String(stdout) }));
  }
  if (options.signal?.aborted) return Promise.reject(new Error('Discovery cancelled'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, { shell: true, env: options.env, detached: true, windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
      if (Buffer.byteLength(stdout) > (options.maxBuffer ?? 1024 * 1024)) {
        killTree(); finish(); releasePipes();
        if (!settled) { settled = true; reject(new Error('Discovery output exceeded maxBuffer')); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => {
      stderr += data;
      if (Buffer.byteLength(stderr) > (options.maxBuffer ?? 1024 * 1024)) {
        killTree(); finish(); releasePipes();
        if (!settled) { settled = true; reject(new Error('Discovery output exceeded maxBuffer')); }
      }
    });
    child.on('error', error => { finish(); if (!settled) { settled = true; reject(error); } });
    child.on('close', (code, signal) => {
      finish();
      if (settled) return;
      settled = true;
      if (code !== 0) reject(Object.assign(new Error(`Discovery command exited with ${code}`), { code, signal, killed: false, stdout, stderr })); else resolve({ stdout });
    });
    const killTree = () => {
      if (!child.pid) return;
      try {
        // After exit the leader's ID can be reused, even while a detached
        // descendant holds a pipe. Bound the wait but never signal that ID.
        if (child.exitCode !== null || child.signalCode !== null) return;
        process.kill(-child.pid, 'SIGKILL');
      } catch { /* Already exited. */ }
    };
    const releasePipes = () => {
      for (const stream of [child.stdout, child.stderr]) {
        stream.removeAllListeners('data');
        stream.resume();
        if (stream instanceof Socket) stream.unref();
      }
      child.stdin.destroy();
    };
    const cancel = () => { if (settled) return; settled = true; killTree(); finish(); releasePipes(); reject(new Error('Discovery cancelled')); };
    const finish = () => { if (timer) clearTimeout(timer); unwatchProbe(killTree); options.signal?.removeEventListener('abort', cancel); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    watchProbe(killTree);
    if (options.timeout) timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      finish();
      releasePipes();
      reject(Object.assign(new Error(`Discovery command timed out after ${options.timeout}ms`), { killed: true, signal: 'SIGKILL' }));
    }, options.timeout);
  });
}
