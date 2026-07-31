import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { killTree, type KillTreeDeps } from '../processTree';

class FakeChild extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  pid: number | undefined = 4242;
  kill = vi.fn((_signal?: NodeJS.Signals) => { this.killed = true; return true; });
}

/** Captures the scheduled hard kill so a test can fire it without timers. */
function harness(overrides: Partial<KillTreeDeps> = {}) {
  const child = new FakeChild();
  const taskkill = vi.fn((_f: string, _a: string[], cb: (e: Error | null) => void) => cb(null));
  let scheduled: (() => void) | null = null;
  const deps: KillTreeDeps = {
    execFileImpl: taskkill,
    setTimeoutImpl: (fn) => { scheduled = fn; return { unref: () => {} }; },
    clearTimeoutImpl: () => { scheduled = null; },
    ...overrides,
  };
  return {
    child, taskkill, deps,
    fireHardKill: () => scheduled?.(),
    isScheduled: () => scheduled !== null,
  };
}

describe('killTree on POSIX', () => {
  it('sends SIGTERM immediately and escalates to SIGKILL on the grace timer', () => {
    const h = harness({ platform: 'linux' });
    killTree(h.child as unknown as ChildProcess, h.deps);

    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(h.child.kill).toHaveBeenCalledTimes(1);

    h.fireHardKill();
    expect(h.child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('cancels the escalation when the process exits on its own', () => {
    const h = harness({ platform: 'linux' });
    killTree(h.child as unknown as ChildProcess, h.deps);

    h.child.emit('exit');
    expect(h.isScheduled()).toBe(false);
  });

  it('never reaches for taskkill', () => {
    const h = harness({ platform: 'darwin' });
    killTree(h.child as unknown as ChildProcess, h.deps);
    h.fireHardKill();
    expect(h.taskkill).not.toHaveBeenCalled();
  });
});

describe('killTree on Windows', () => {
  // `/T` is the whole point. Windows has no signals, so ChildProcess.kill
  // terminates only the direct child — which for a `.cmd` shim is cmd.exe, not
  // the agent. The agent survived, still holding the workspace and the
  // subscription, invisible to the surface that thought it had stopped.
  it('walks the process tree instead of terminating only the direct child', () => {
    const h = harness({ platform: 'win32' });
    killTree(h.child as unknown as ChildProcess, h.deps);

    expect(h.taskkill).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T'], expect.any(Function));
    expect(h.child.kill).not.toHaveBeenCalled();
  });

  it('escalates to a forced tree kill on the grace timer', () => {
    const h = harness({ platform: 'win32' });
    killTree(h.child as unknown as ChildProcess, h.deps);
    h.fireHardKill();

    expect(h.taskkill).toHaveBeenLastCalledWith('taskkill', ['/pid', '4242', '/T', '/F'], expect.any(Function));
  });

  it('does nothing for a process that never started, since there is no tree', () => {
    const h = harness({ platform: 'win32' });
    h.child.pid = undefined;
    killTree(h.child as unknown as ChildProcess, h.deps);
    expect(h.taskkill).not.toHaveBeenCalled();
  });

  it('ignores taskkill failure — every caller is on a dispose path', () => {
    const h = harness({
      platform: 'win32',
      execFileImpl: (_f, _a, cb) => cb(new Error('not found')),
    });
    expect(() => killTree(h.child as unknown as ChildProcess, h.deps)).not.toThrow();
  });
});

describe('killTree guards', () => {
  it('is a no-op for a null process', () => {
    const h = harness({ platform: 'linux' });
    expect(() => killTree(null, h.deps)).not.toThrow();
  });

  it('skips a process that already reported an exit code', () => {
    const h = harness({ platform: 'linux' });
    h.child.exitCode = 0;
    killTree(h.child as unknown as ChildProcess, h.deps);
    expect(h.child.kill).not.toHaveBeenCalled();
  });

  // Only a numeric exit code is evidence the process is gone. A test double or
  // a partially-initialised handle reports neither, and skipping a live process
  // costs an orphaned agent while a redundant kill costs nothing.
  it('treats an unknown exit code as still running', () => {
    const h = harness({ platform: 'linux' });
    (h.child as { exitCode: number | null | undefined }).exitCode = undefined;
    killTree(h.child as unknown as ChildProcess, h.deps);
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('is idempotent — a second call after killed does nothing', () => {
    const h = harness({ platform: 'linux' });
    killTree(h.child as unknown as ChildProcess, h.deps);
    killTree(h.child as unknown as ChildProcess, h.deps);
    expect(h.child.kill).toHaveBeenCalledTimes(1);
  });
});
