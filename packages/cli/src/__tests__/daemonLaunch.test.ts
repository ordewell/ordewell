import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The standalone binary has no server file beside it: it is its own daemon,
// started as `<binary> __daemon ...` (ADR-0065). Which argv each mode spawns is
// the whole difference, so spawn and the binary check are what is faked here.
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: string[] }> }));
const sea = vi.hoisted(() => ({ value: false }));

vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[]) => {
      spawned.calls.push({ file, args });
      return Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
    }),
  };
});

// Down until something is spawned, so a start probes, spawns once and is done.
vi.mock('@ordewell/core', async (original) => {
  const actual = await original<typeof import('@ordewell/core')>();
  return { ...actual, isDaemonRunning: async () => spawned.calls.length > 0, isSea: () => sea.value };
});

import { daemonCommand, startDaemon } from '../daemon';
import { handleWeb } from '../commands/web';

beforeEach(() => {
  spawned.calls = [];
  sea.value = false;
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
