import { spawn } from 'child_process';
import { Socket } from 'net';
import { runWindowsProbe } from './windowsProbeSupervisor';

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

/**
 * Run a discovery probe through the shell and end everything it started when
 * it times out, is cancelled, overflows its buffer or outlives its host.
 *
 * POSIX runs it in its own process group. Descendants that leave the group or
 * outlive its leader may survive: a recycled group ID cannot be signalled
 * safely. The exit hook runs on normal process exit, not SIGKILL.
 *
 * Windows runs it in a kill-on-close job of its own, which the host's one
 * long-lived supervisor creates and holds (ADR-0078, `windowsProbeSupervisor`):
 * closing that job ends every process the probe started, a `.cmd` shim's
 * included, and so does the shell's own exit, so a probe that answers and
 * leaves a child behind loses that child. Nothing is ever killed by PID or
 * name. If the job cannot be set up the probe fails, and the command never runs.
 */
export function discoveryExec(command: string, options: { timeout?: number; env: NodeJS.ProcessEnv; maxBuffer?: number; signal?: AbortSignal }): Promise<{ stdout: string }> {
  if (options.signal?.aborted) return Promise.reject(new Error('Discovery cancelled'));
  const limit = options.maxBuffer ?? 1024 * 1024;
  if (process.platform === 'win32') return runWindowsProbe(command, { ...options, maxBuffer: limit });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, { shell: true, env: options.env, detached: true, windowsHide: true });
    const overflow = () => {
      killTree(); finish(); releasePipes();
      if (!settled) { settled = true; reject(new Error('Discovery output exceeded maxBuffer')); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
      if (Buffer.byteLength(stdout) > limit) overflow();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => {
      stderr += data;
      if (Buffer.byteLength(stderr) > limit) overflow();
    });
    child.on('error', error => {
      finish();
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (code, signal) => {
      finish();
      if (settled) return;
      settled = true;
      if (code !== 0) reject(Object.assign(new Error(`Discovery command exited with ${code}`), { code, signal, killed: false, stdout, stderr }));
      else resolve({ stdout });
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
