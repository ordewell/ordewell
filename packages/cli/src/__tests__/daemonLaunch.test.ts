import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The standalone binary has no server file beside it: it is its own daemon,
// started as `<binary> __daemon ...` (ADR-0065). Which argv each mode spawns is
// the whole difference, so spawn and the binary check are what is faked here.
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: string[] }> }));
const sea = vi.hoisted(() => ({ value: false }));
/** When the spawned daemon first answers, on the (faked) clock. */
const ready = vi.hoisted(() => ({ at: 0 }));

vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[]) => {
      spawned.calls.push({ file, args });
      return Object.assign(new EventEmitter(), { pid: 4242, unref: () => {}, kill: () => true });
    }),
  };
});

// Down until something is spawned, so a start probes, spawns once and is done.
vi.mock('@ordewell/core', async (original) => {
  const actual = await original<typeof import('@ordewell/core')>();
  return { ...actual, isDaemonRunning: async () => spawned.calls.length > 0 && Date.now() >= ready.at, isSea: () => sea.value };
});

import { daemonCommand, startDaemon } from '../daemon';
import { handleWeb } from '../commands/web';

// `ordewell web` relays these to its child; left installed, a signal the
// worker gets after this file would reach a fake child that is long gone.
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
let baseline: Record<string, Array<(...a: unknown[]) => void>>;

beforeEach(() => {
  spawned.calls = [];
  sea.value = false;
  ready.at = 0;
  baseline = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s) as Array<(...a: unknown[]) => void>]));
});

afterEach(() => {
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal)) if (!baseline[signal].includes(listener as never)) process.off(signal, listener);
  }
});

describe('daemonCommand', () => {
  it('runs the server file under this Node outside the binary', () => {
    const command = daemonCommand(['--port', '5000'], () => '/opt/web/dist/server/main.js', false);
    expect(command).toEqual({ file: process.execPath, args: ['/opt/web/dist/server/main.js', '--port', '5000'] });
  });

  it('runs the binary itself as `__daemon` inside it, never looking for a server file', () => {
    const serverPath = vi.fn(() => '/nowhere/main.js');
    const command = daemonCommand(['--port', '5000', '--pid-file', '/tmp/p'], serverPath, true);
    expect(command).toEqual({ file: process.execPath, args: ['__daemon', '--port', '5000', '--pid-file', '/tmp/p'] });
    expect(serverPath).not.toHaveBeenCalled();
  });
});

describe('the commands that start a daemon, inside the binary', () => {
  it('`ordewell web` runs the binary as its foreground daemon', async () => {
    sea.value = true;
    await handleWeb(['--port', '5123']);
    expect(spawned.calls).toEqual([{ file: process.execPath, args: ['__daemon', '--port', '5123'] }]);
  });

  it('a background daemon gets the same arguments a server file would', async () => {
    sea.value = true;
    await startDaemon(5124, { detached: false, quiet: true });
    expect(spawned.calls).toHaveLength(1);
    const [{ file, args }] = spawned.calls;
    expect(file).toBe(process.execPath);
    expect(args[0]).toBe('__daemon');
    expect(args.slice(1, 3)).toEqual(['--port', '5124']);
    expect(args[3]).toBe('--pid-file');
    expect(args.slice(5)).toEqual(['--watch-parent', String(process.pid)]);
  });
});

// The terminal UI's first frame waits on this start; a silent wait reads as a hang (F4).
describe('a daemon start that takes a while', () => {
  afterEach(() => { vi.useRealTimers(); });

  const logged = async (answersAfterMs: number): Promise<string[]> => {
    vi.useFakeTimers();
    ready.at = Date.now() + answersAfterMs;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const started = startDaemon(5125, { detached: false });
      await vi.advanceTimersByTimeAsync(answersAfterMs + 1_000);
      await started;
      return log.mock.calls.map(([line]) => String(line));
    } finally {
      log.mockRestore();
    }
  };

  it('says once what it is still waiting for, and where the log is, before the daemon answers', async () => {
    const lines = await logged(8_000);
    const waiting = lines.filter((line) => line.startsWith('Still waiting'));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toContain('port 5125');
    expect(waiting[0]).toMatch(/Its log: .+/);
    expect(lines.at(-1)).toContain('Server started on http://127.0.0.1:5125');
  });

  it('says nothing more when the daemon answers at once', async () => {
    const lines = await logged(0);
    expect(lines.some((line) => line.startsWith('Still waiting'))).toBe(false);
  });
});
