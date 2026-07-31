import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';

/**
 * Stopping an agent process, on every platform.
 *
 * POSIX gets the escalation it always had: SIGTERM, then SIGKILL after a grace
 * period. Windows has no signals — `ChildProcess.kill` calls TerminateProcess
 * on the direct child only — and on Windows the direct child is frequently not
 * the agent. A `claude.cmd` shim launched through cmd.exe puts an interpreter
 * between Ordewell and the `node cli.js` doing the work, so terminating the child
 * left the real agent running: still holding the workspace, still spending the
 * user's subscription, invisible to the surface that thought it had stopped.
 * `taskkill /T` walks the tree instead.
 *
 * Both paths are best-effort and idempotent by construction. A process that has
 * already exited is not an error here — every caller is on a dispose path.
 */

/** Grace period between the polite stop and the forced one. */
const HARD_KILL_DELAY_MS = 5000;

export interface KillTreeDeps {
  platform?: NodeJS.Platform;
  /** Runs `taskkill`. Injected so the Windows path is testable off Windows. */
  execFileImpl?: (file: string, args: string[], cb: (err: Error | null) => void) => void;
  /** Schedules the forced kill. Injected so tests need no timers. */
  setTimeoutImpl?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimeoutImpl?: (handle: unknown) => void;
}

function defaultExecFile(file: string, args: string[], cb: (err: Error | null) => void): void {
  execFile(file, args, (err) => cb(err ?? null));
}

/**
 * Terminate `proc` and everything it started.
 *
 * Returns immediately; the forced follow-up (SIGKILL, or `taskkill /F`) is
 * scheduled and unref'd, so a disposed session is never the reason the host
 * process refuses to exit.
 */
export function killTree(proc: ChildProcess | null, deps: KillTreeDeps = {}): void {
  // `typeof … === 'number'`, not `!== null`: only a numeric exit code is
  // positive evidence the process is gone. A running child reports null, and an
  // object that reports neither is treated as running — the cost of a redundant
  // kill is nothing, the cost of skipping a live one is an orphaned agent.
  if (!proc || proc.killed || typeof proc.exitCode === 'number') return;

  const platform = deps.platform ?? process.platform;
  const setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms) as unknown as { unref?: () => void });
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  if (platform === 'win32') {
    // No pid means the process never started; there is no tree to walk.
    if (typeof proc.pid !== 'number') return;
    const pid = proc.pid;
    const run = deps.execFileImpl ?? defaultExecFile;

    // `/T` is the whole point: without it this is the TerminateProcess call
    // that already failed to reach the agent. The unforced pass first gives a
    // console app a chance to flush; `/F` follows if it did not take.
    run('taskkill', ['/pid', String(pid), '/T'], () => { /* exit code is not news */ });
    const hardKill = setTimeoutImpl(() => {
      run('taskkill', ['/pid', String(pid), '/T', '/F'], () => { /* already gone */ });
    }, HARD_KILL_DELAY_MS);
    hardKill.unref?.();
    proc.once('exit', () => clearTimeoutImpl(hardKill));
    return;
  }

  try {
    proc.kill('SIGTERM');
    const hardKill = setTimeoutImpl(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }, HARD_KILL_DELAY_MS);
    hardKill.unref?.();
    proc.once('exit', () => clearTimeoutImpl(hardKill));
  } catch {
    // Process already gone — nothing to clean up.
  }
}
