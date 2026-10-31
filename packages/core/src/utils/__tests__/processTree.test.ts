import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { killTree, spawnInOwnGroup, type KillTreeDeps } from '../processTree';

class FakeChild extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
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

/** A pid no real process group can have, so a stray signal reaches nothing. */
const UNUSED_PID = 2 ** 31 - 2;

describe('killTree on a runner that leads its own process group', () => {
  function leader() {
    const child = new FakeChild();
    child.pid = UNUSED_PID;
    const spawn = vi.fn((_detached: boolean) => child as unknown as ChildProcess);
    spawnInOwnGroup(spawn, 'linux');
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const h = harness({ platform: 'linux', killImpl: (pid, signal) => { signals.push([pid, signal]); } });
    return { child, spawn, signals, h };
  }

  it('is spawned detached, which on POSIX makes it the leader of a new group', () => {
    const { spawn, child } = leader();
    expect(spawn).toHaveBeenCalledWith(true);
    child.emit('exit', 0);
  });

  it('is not detached on Windows, where that opens a console and taskkill /T already walks the tree', () => {
    const spawn = vi.fn((_detached: boolean) => new FakeChild() as unknown as ChildProcess);
    spawnInOwnGroup(spawn, 'win32');
    expect(spawn).toHaveBeenCalledWith(false);
  });

  // The direct child is a CLI; the shells, MCP servers, test runs and dev
  // servers it started are what kept running after Stop.
  it('signals the whole group, not just the direct child', () => {
    const { child, signals, h } = leader();
    killTree(child as unknown as ChildProcess, h.deps);

    expect(signals).toEqual([[-UNUSED_PID, 'SIGTERM']]);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('exit', null, 'SIGTERM');
  });

  // A crash is not a cleanup. The leader's exitCode being set says only that
  // the leader is gone; the shells, dev servers and MCP servers it started are
  // still in the group, and Stop has to reach them.
  it('signals the group after the leader has already exited', () => {
    const { child, signals, h } = leader();
    child.exitCode = 1;
    killTree(child as unknown as ChildProcess, h.deps);

    // Members first — the leader is gone, so its id is ours only while the
    // group still answers — then SIGTERM, and again before the SIGKILL.
    expect(signals).toEqual([[-UNUSED_PID, 0], [-UNUSED_PID, 'SIGTERM']]);
    h.fireHardKill();
    expect(signals).toEqual([[-UNUSED_PID, 0], [-UNUSED_PID, 'SIGTERM'], [-UNUSED_PID, 0], [-UNUSED_PID, 'SIGKILL']]);
  });

  it('still escalates to SIGKILL after the leader exits, since what it started can outlive it', () => {
    const { child, signals, h } = leader();
    killTree(child as unknown as ChildProcess, h.deps);
    child.emit('exit', null, 'SIGTERM');

    expect(h.isScheduled()).toBe(true);
    h.fireHardKill();
    expect(signals).toEqual([[-UNUSED_PID, 'SIGTERM'], [-UNUSED_PID, 0], [-UNUSED_PID, 'SIGKILL']]);
  });

  it('drops the escalation when the leader exits and nothing is left in its group', () => {
    const { child, signals } = leader();
    const h = harness({
      platform: 'linux',
      killImpl: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      },
    });
    killTree(child as unknown as ChildProcess, h.deps);
    child.emit('exit', null, 'SIGTERM');

    expect(h.isScheduled()).toBe(false);
    expect(signals).toEqual([[-UNUSED_PID, 'SIGTERM'], [-UNUSED_PID, 0]]);
  });

  // A leader's pid is its group's id, and once the leader is gone and the
  // group empty that id can be handed to a stranger's group. Disposing a
  // long-exited runner must ask first, not signal and then ask.
  it('sends nothing to the group of a leader that exited once the group has emptied', () => {
    const { child, signals } = leader();
    const h = harness({
      platform: 'linux',
      killImpl: (pid, signal) => {
        signals.push([pid, signal]);
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      },
    });
    child.exitCode = 0;
    killTree(child as unknown as ChildProcess, h.deps);

    expect(signals.filter(([, signal]) => signal !== 0)).toEqual([]);
    expect(h.isScheduled()).toBe(false);
  });

  // A leader killed by a signal reports `exitCode` null and `signalCode` set;
  // it is as gone as one that exited with a code.
  it('treats a leader killed by a signal as exited: it probes before it signals', () => {
    const { child, signals } = leader();
    const h = harness({
      platform: 'linux',
      killImpl: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      },
    });
    child.signalCode = 'SIGKILL';
    killTree(child as unknown as ChildProcess, h.deps);

    expect(signals).toEqual([[-UNUSED_PID, 0]]);
    expect(h.isScheduled()).toBe(false);
  });

  it('checks the group still has members before the forced follow-up once its leader is gone', () => {
    const { child, signals } = leader();
    let members = true;
    const h = harness({
      platform: 'linux',
      killImpl: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 0 && !members) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      },
    });
    child.signalCode = 'SIGSEGV';
    killTree(child as unknown as ChildProcess, h.deps);
    expect(signals).toEqual([[-UNUSED_PID, 0], [-UNUSED_PID, 'SIGTERM']]);

    members = false;
    h.fireHardKill();
    expect(signals).toEqual([[-UNUSED_PID, 0], [-UNUSED_PID, 'SIGTERM'], [-UNUSED_PID, 0]]);
  });

  it('falls back to the direct child when the group cannot be signalled', () => {
    const { child } = leader();
    const h = harness({ platform: 'linux', killImpl: () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); } });
    killTree(child as unknown as ChildProcess, h.deps);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
  });

  it('is idempotent — a second stop sends nothing more', () => {
    const { child, signals, h } = leader();
    killTree(child as unknown as ChildProcess, h.deps);
    killTree(child as unknown as ChildProcess, h.deps);

    expect(signals).toHaveLength(1);
    child.emit('exit', null, 'SIGTERM');
  });
});

const posixIt = it.skipIf(process.platform === 'win32');

/** Polls until `pid` no longer exists. */
async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** The first line `proc` prints, as a pid. */
function firstPid(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const newline = out.indexOf('\n');
      if (newline >= 0) resolve(Number(out.slice(0, newline)));
    });
    proc.once('exit', () => reject(new Error(`exited before printing a pid: ${out}`)));
  });
}

/** Reads `proc`'s stdout one line at a time — for a host that prints more than a pid. */
function lines(proc: ChildProcess): () => Promise<string> {
  let buffer = '';
  const ready: string[] = [];
  let wake: (() => void) | null = null;
  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      ready.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
    wake?.();
    wake = null;
  });
  return async () => {
    while (ready.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
    return ready.shift()!;
  };
}

/** A shell that backgrounds a long sleep — the grandchild Stop used to miss — and prints its pid. */
const SHELL_WITH_GRANDCHILD = ['-c', 'sleep 30 & echo $!; wait'];

describe('onHostTeardown', () => {
  /** Runs `body` in a real host and reports what its teardown did. */
  function hostRunning(body: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-host-'));
    const host = join(dir, 'host.mts');
    writeFileSync(host, [
      `import { appendFileSync } from 'node:fs';`,
      `import { onHostTeardown, runnerGroups } from ${JSON.stringify(join(__dirname, '..', 'processTree.ts'))};`,
      `const said = (word) => () => appendFileSync(${JSON.stringify(join(dir, 'said'))}, word + ' ');`,
      ...body,
    ].join('\n'));
    const proc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', host], { stdio: ['ignore', 'pipe', 'inherit'] });
    return {
      proc,
      exited: new Promise<void>((resolve) => { proc.once('exit', () => resolve()); }),
      said: () => readFileSync(join(dir, 'said'), 'utf8').trim(),
      done: () => { proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); },
    };
  }

  it('runs what is still registered on a host\'s exit, once, and nothing a throw or a stopped one would skip', async () => {
    const h = hostRunning([
      `onHostTeardown(() => { throw new Error('already gone'); });`,
      `onHostTeardown(said('kept'));`,
      `const stopHearing = onHostTeardown(said('stopped'));`,
      `stopHearing();`,
      `process.exit(0);`,
    ]);
    try {
      await h.exited;
      expect(h.said()).toBe('kept');
    } finally {
      h.done();
    }
  });

  posixIt('runs it on a signal, once, with the signal still ending a host that has no handler of its own', async () => {
    const h = hostRunning([
      `onHostTeardown(said('kept'));`,
      `console.log(process.pid);`,
      `setInterval(() => {}, 1000);`,
    ]);
    try {
      await firstPid(h.proc);
      h.proc.kill('SIGTERM');
      await h.exited;
      expect(h.proc.signalCode).toBe('SIGTERM');
      expect(h.said()).toBe('kept');
    } finally {
      h.done();
    }
  });

  it('is no runner group: a session lease has nothing to hold it by', async () => {
    const h = hostRunning([
      `onHostTeardown(() => {});`,
      `console.log(runnerGroups().length);`,
    ]);
    try {
      expect(await firstPid(h.proc)).toBe(0);
    } finally {
      h.done();
    }
  });
});

describe('process groups, for real', () => {
  posixIt('Stop reaches a grandchild the runner started, and stdout still pipes', async () => {
    const proc = spawnInOwnGroup((detached) => spawn('sh', SHELL_WITH_GRANDCHILD, { detached, stdio: ['pipe', 'pipe', 'pipe'] }));
    const grandchild = await firstPid(proc);
    try {
      killTree(proc);
      expect(await gone(grandchild)).toBe(true);
    } finally {
      try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone, as it should be */ }
    }
  });

  // Ctrl-C reaches the terminal's foreground group, which a detached runner
  // has left — so the host has to pass the signal on to the groups it leads.
  posixIt.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('a host killed by %s takes its runners\' groups with it', async (signal) => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-host-'));
    const host = join(dir, 'host.mts');
    writeFileSync(host, [
      `import { spawn } from 'node:child_process';`,
      `import { spawnInOwnGroup } from ${JSON.stringify(join(__dirname, '..', 'processTree.ts'))};`,
      `const proc = spawnInOwnGroup((detached) => spawn('sh', ${JSON.stringify(SHELL_WITH_GRANDCHILD)}, { detached, stdio: ['ignore', 'pipe', 'inherit'] }));`,
      `proc.stdout.pipe(process.stdout);`,
    ].join('\n'));
    const hostProc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', host], { stdio: ['ignore', 'pipe', 'pipe'] });
    let grandchild = 0;
    try {
      grandchild = await firstPid(hostProc);
      const exited = new Promise<NodeJS.Signals | null>((resolve) => hostProc.once('exit', (_code, sig) => resolve(sig)));
      hostProc.kill(signal);
      expect(await exited).toBe(signal);
      expect(await gone(grandchild)).toBe(true);
    } finally {
      hostProc.kill('SIGKILL');
      if (grandchild) try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone, as it should be */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A crash is not a cleanup: the runner's group outlives it, and the host
  // must still reach it on the way out. The group leaves the host's books only
  // once it is empty, not the moment its leader exits.
  posixIt('a host killed after its runner crashed still takes the runner\'s group with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-host-'));
    const host = join(dir, 'crash-host.mts');
    writeFileSync(host, [
      `import { spawn } from 'node:child_process';`,
      `import { spawnInOwnGroup } from ${JSON.stringify(join(__dirname, '..', 'processTree.ts'))};`,
      `const proc = spawnInOwnGroup((detached) => spawn('sh', ['-c', 'sleep 30 & echo $!'], { detached, stdio: ['ignore', 'pipe', 'inherit'] }));`,
      `proc.stdout.pipe(process.stdout);`,
      `proc.on('exit', () => process.stdout.write('leader-exited\\n'));`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'));
    const hostProc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', host], { stdio: ['ignore', 'pipe', 'pipe'] });
    let grandchild = 0;
    try {
      const nextLine = lines(hostProc);
      grandchild = Number(await nextLine());
      expect(await nextLine()).toBe('leader-exited');
      const exited = new Promise<NodeJS.Signals | null>((resolve) => hostProc.once('exit', (_code, sig) => resolve(sig)));
      hostProc.kill('SIGTERM');
      expect(await exited).toBe('SIGTERM');
      expect(await gone(grandchild)).toBe(true);
    } finally {
      hostProc.kill('SIGKILL');
      if (grandchild) try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone, as it should be */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Once a crashed runner's group has emptied, its id is recyclable and no
  // longer the host's to signal on the way out.
  posixIt('a host killed after its runner\'s group emptied signals nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-host-'));
    const host = join(dir, 'empty-host.mts');
    writeFileSync(host, [
      `import { spawn } from 'node:child_process';`,
      `import { writeSync } from 'node:fs';`,
      `import { spawnInOwnGroup } from ${JSON.stringify(join(__dirname, '..', 'processTree.ts'))};`,
      `const kill = process.kill.bind(process);`,
      `process.kill = (pid, signal) => { if (pid < 0 && signal !== 0) writeSync(1, 'signalled ' + String(signal) + '\\n'); return kill(pid, signal); };`,
      `const proc = spawnInOwnGroup((detached) => spawn('sh', ['-c', 'sleep 0.3 & echo $!'], { detached, stdio: ['ignore', 'pipe', 'inherit'] }));`,
      `proc.stdout.pipe(process.stdout);`,
      `proc.on('exit', () => process.stdout.write('leader-exited\\n'));`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'));
    const hostProc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', host], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const nextLine = lines(hostProc);
      const grandchild = Number(await nextLine());
      expect(await nextLine()).toBe('leader-exited');
      expect(await gone(grandchild)).toBe(true);
      let rest = '';
      hostProc.stdout!.on('data', (chunk: Buffer) => { rest += chunk.toString(); });
      const exited = new Promise<void>((resolve) => hostProc.once('close', () => resolve()));
      hostProc.kill('SIGTERM');
      await exited;
      expect(rest).not.toContain('signalled');
    } finally {
      hostProc.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
