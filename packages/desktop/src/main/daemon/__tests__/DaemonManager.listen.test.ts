import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonProbe, DaemonStopOutcome } from '@ordewell/core/daemon-client';
import type { DaemonStatus } from '../../../shared/bridge';
import { DaemonManager, type DaemonManagerDeps, type OwnedProcess } from '../DaemonManager';
import type { LiveRun } from '../liveRuns';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

import { pidNamedIn } from '../forkDaemon';

const PORT = 3742;
const CONTRACT = 1;

interface Child extends OwnedProcess {
  readonly pid: number;
  /** What the daemon does once it listens: write its PID file, then answer. */
  listen(): void;
  exit(code?: number): void;
  stopped: boolean;
}

/**
 * A port, the PID file beside it, and the children forked onto it. A child
 * holds the port only once the test says it listens, as a starting daemon
 * does; until then every probe is a connection refused, which `refused`
 * counts.
 */
function world(options: { pidFile?: { read(): Promise<number | undefined>; write(pid: number): void } } = {}) {
  let holder: DaemonProbe = { kind: 'unreachable' };
  let written: number | undefined;
  const pidFile = options.pidFile ?? {
    read: async () => written,
    write: (pid: number) => { written = pid; },
  };
  let nextPid = 700;
  const children: Child[] = [];
  const counts = { refused: 0 };
  const answer = { asDaemon: (pid: number): DaemonProbe => ({ kind: 'daemon', identity: { pid, version: '9.9.9', contract: CONTRACT } }) };

  const probe = vi.fn(async (): Promise<DaemonProbe> => {
    if (holder.kind === 'unreachable') counts.refused += 1;
    return holder;
  });
  const pidFileOwner = vi.fn(() => pidFile.read());
  const fork = vi.fn((): OwnedProcess => {
    const pid = nextPid++;
    const listeners: Array<(code: number) => void> = [];
    const leave = (code: number): void => {
      if (holder.kind === 'daemon' && holder.identity.pid === pid) holder = { kind: 'unreachable' };
      for (const listener of listeners) listener(code);
    };
    const child: Child = {
      pid,
      stopped: false,
      onExit: (cb) => { listeners.push(cb); },
      listen: () => {
        holder = answer.asDaemon(pid);
        pidFile.write(pid);
      },
      exit: (code = 1) => leave(code),
      stop: vi.fn(async () => {
        child.stopped = true;
        leave(0);
      }),
    };
    children.push(child);
    return child;
  });

  return {
    probe,
    fork,
    pidFileOwner,
    children,
    counts,
    answer,
    set(next: DaemonProbe) { holder = next; },
    writePidFile: (pid: number) => pidFile.write(pid),
  };
}

type World = ReturnType<typeof world>;

const managers: DaemonManager[] = [];
const dirs: string[] = [];

function manager(w: World, overrides: Partial<DaemonManagerDeps> = {}): { daemon: DaemonManager; statuses: DaemonStatus[] } {
  const daemon = new DaemonManager({
    port: PORT,
    app: { version: '0.12.3', contract: CONTRACT },
    probe: w.probe,
    fork: w.fork,
    pidFileOwner: w.pidFileOwner,
    stopExternal: vi.fn(async (): Promise<DaemonStopOutcome> => ({ kind: 'no-pid-file' })),
    liveRuns: vi.fn(async (): Promise<LiveRun[] | undefined> => []),
    logPath: '/tmp/server.log',
    pollMs: 1,
    listenPollMs: 1,
    readyTimeoutMs: 2_000,
    heartbeatMs: 60_000,
    reconnectMs: 60_000,
    ...overrides,
  });
  managers.push(daemon);
  const statuses: DaemonStatus[] = [];
  daemon.onStatus((status) => statuses.push(status));
  return { daemon, statuses };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(managers.splice(0).map((daemon) => daemon.shutdown()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Started and waiting: forked, and the PID file read a few times with nothing in it yet. */
async function waiting(w: World): Promise<Child> {
  await vi.waitFor(() => expect(w.children).toHaveLength(1));
  const reads = w.pidFileOwner.mock.calls.length;
  await vi.waitFor(() => expect(w.pidFileOwner.mock.calls.length).toBeGreaterThan(reads + 5));
  return w.children[0]!;
}

/** A PID no process holds: one that has just exited. */
function deadPid(): number {
  const gone = spawnSync(process.execPath, ['-e', '']);
  if (gone.pid === undefined) throw new Error('no child to take a PID from');
  return gone.pid;
}

describe('DaemonManager: a start learns its child listens from the PID file', () => {
  it('asks nothing over TCP until its child names itself in the PID file, then confirms with one probe', async () => {
    const w = world();
    const { daemon } = manager(w);
    const connecting = daemon.connect();
    const child = await waiting(w);
    // The probe before the fork found the port free; nothing has been refused since.
    expect(w.probe).toHaveBeenCalledTimes(1);
    expect(w.counts.refused).toBe(1);

    child.listen();
    await connecting;
    expect(w.probe).toHaveBeenCalledTimes(2);
    expect(w.counts.refused).toBe(1);
    expect(daemon.current()).toEqual({ state: 'connected', port: PORT, owned: true, daemon: { contract: CONTRACT, version: '9.9.9' } });
  });

  it('does not take a stale PID file, left by a daemon that died, for its child listening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-pidfile-'));
    dirs.push(dir);
    const file = join(dir, 'server.pid');
    const stale = deadPid();
    writeFileSync(file, String(stale));
    const w = world({ pidFile: { read: () => pidNamedIn(file), write: (pid) => writeFileSync(file, String(pid)) } });
    const { daemon } = manager(w);
    const connecting = daemon.connect();
    const child = await waiting(w);
    expect(await pidNamedIn(file)).toBe(stale);
    expect(w.probe).toHaveBeenCalledTimes(1);
    expect(daemon.current()).toMatchObject({ state: 'connecting', starting: true });

    child.listen();
    await connecting;
    expect(w.probe).toHaveBeenCalledTimes(2);
    expect(daemon.current()).toMatchObject({ state: 'connected', owned: true });
  });

  it('says where the daemon it starts writes, while it waits for it', async () => {
    const w = world();
    const { daemon } = manager(w);
    const connecting = daemon.connect();
    const child = await waiting(w);
    expect(daemon.current()).toEqual({ state: 'connecting', port: PORT, starting: true, logPath: '/tmp/server.log' });
    child.listen();
    await connecting;
  });

  it('gives up after 15 s, as before: the child stopped and the same failure shown', async () => {
    vi.useFakeTimers();
    const w = world();
    const { daemon } = manager(w, { readyTimeoutMs: undefined, listenPollMs: undefined, pollMs: undefined });
    const connecting = daemon.connect();
    await vi.advanceTimersByTimeAsync(14_900);
    expect(daemon.current()).toMatchObject({ state: 'connecting', starting: true });
    await vi.advanceTimersByTimeAsync(200);
    await connecting;
    expect(daemon.current()).toEqual({ state: 'failed', port: PORT, message: 'The bundled daemon did not answer within 15s.', logPath: '/tmp/server.log' });
    expect(w.children[0]?.stop).toHaveBeenCalledTimes(1);
    // The probe before the fork, and the one at the deadline that judged the port.
    expect(w.probe).toHaveBeenCalledTimes(2);
  });

  it('fails as before when its child exits before it listens', async () => {
    const w = world();
    const { daemon } = manager(w);
    const connecting = daemon.connect();
    const child = await waiting(w);
    child.exit(1);
    await connecting;
    expect(daemon.current()).toMatchObject({ state: 'failed', message: 'The bundled daemon exited before it answered.' });
    expect(w.probe).toHaveBeenCalledTimes(2);
  });

  it('shows port-taken when another program takes the port and the child loses the bind', async () => {
    const w = world();
    const { daemon } = manager(w);
    const connecting = daemon.connect();
    const child = await waiting(w);
    w.set({ kind: 'unverifiable' });
    child.exit(1);
    await connecting;
    expect(daemon.current()).toEqual({ state: 'port-taken', port: PORT });
    expect(daemon.owned).toBe(false);
  });

  it('shows port-taken at the deadline when another program holds the port and the child never exits', async () => {
    const w = world();
    // Taken in the moment between the probe that found it free and the fork.
    const fork = (): OwnedProcess => {
      const child = w.fork();
      w.set({ kind: 'unverifiable' });
      return child;
    };
    const { daemon } = manager(w, { fork, readyTimeoutMs: 40 });
    await daemon.connect();
    expect(daemon.current()).toEqual({ state: 'port-taken', port: PORT });
  });

  it('attaches to a daemon someone else started, found by the first probe, without forking or reading the PID file', async () => {
    const w = world();
    w.set({ kind: 'daemon', identity: { pid: 42, version: '0.12.1', contract: CONTRACT } });
    const { daemon } = manager(w);
    await daemon.connect();
    expect(daemon.current()).toEqual({ state: 'connected', port: PORT, owned: false, daemon: { contract: CONTRACT, version: '0.12.1' } });
    expect(w.fork).not.toHaveBeenCalled();
    expect(w.pidFileOwner).not.toHaveBeenCalled();
  });

  it('judges a daemon that won the port race as a stranger: its PID in the file is not the child listening', async () => {
    const w = world();
    const { daemon } = manager(w);
    const connecting = daemon.connect();
    const child = await waiting(w);
    // Another client's daemon took the port and wrote its own PID file; this app's child loses the bind.
    w.set({ kind: 'daemon', identity: { pid: 42, version: '0.12.1', contract: CONTRACT } });
    w.writePidFile(42);
    const reads = w.pidFileOwner.mock.calls.length;
    await vi.waitFor(() => expect(w.pidFileOwner.mock.calls.length).toBeGreaterThan(reads + 3));
    expect(w.probe).toHaveBeenCalledTimes(1);
    child.exit(1);
    await connecting;
    expect(daemon.current()).toMatchObject({ state: 'connected', owned: false });
  });

  it('keeps ownership while its first handshake sees an old token', async () => {
    const w = world();
    const { daemon, statuses } = manager(w);
    const connecting = daemon.connect();
    const child = await waiting(w);
    child.listen();
    const listening = w.probe.getMockImplementation()!;
    w.probe.mockImplementationOnce(async () => ({ kind: 'unauthorized', tokenPresented: true }));
    w.probe.mockImplementation(listening);
    await connecting;
    expect(daemon.current()).toMatchObject({ state: 'connected', owned: true });
    expect(statuses.some((status) => status.state === 'unauthorized')).toBe(false);
  });

  it('stops its child and shows a token refusal that persists to the deadline', async () => {
    const w = world();
    const fork = (): OwnedProcess => {
      const child = w.fork() as Child;
      child.listen();
      w.probe.mockResolvedValue({ kind: 'unauthorized', tokenPresented: true });
      return child;
    };
    const { daemon } = manager(w, { fork, readyTimeoutMs: 60 });
    await daemon.connect();
    expect(daemon.current()).toEqual({ state: 'unauthorized', port: PORT, tokenPresented: true });
    expect(w.children[0]?.stop).toHaveBeenCalledTimes(1);
    expect(daemon.owned).toBe(false);
  });

  it('keeps waiting when the PID file cannot be read, rather than failing the start', async () => {
    const w = world();
    let broken = true;
    const read = w.pidFileOwner.getMockImplementation()!;
    w.pidFileOwner.mockImplementation(async () => {
      if (broken) throw new Error('EACCES');
      return read();
    });
    const { daemon } = manager(w);
    const connecting = daemon.connect();
    const child = await waiting(w);
    expect(w.probe).toHaveBeenCalledTimes(1);
    broken = false;
    child.listen();
    await connecting;
    expect(daemon.current()).toMatchObject({ state: 'connected', owned: true });
  });
});

describe('pidNamedIn', () => {
  it('reads the PID a file names, and nothing from a missing or garbled one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-pidfile-'));
    dirs.push(dir);
    const file = join(dir, 'server-4000.pid');
    expect(await pidNamedIn(file)).toBeUndefined();
    writeFileSync(file, '1234\n');
    expect(await pidNamedIn(file)).toBe(1234);
    writeFileSync(file, 'not a pid');
    expect(await pidNamedIn(file)).toBeUndefined();
    writeFileSync(file, '-5');
    expect(await pidNamedIn(file)).toBeUndefined();
  });
});
