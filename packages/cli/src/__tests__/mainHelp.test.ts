import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS as REGISTERED } from '../commands/registry';

/**
 * `ordewell <command> --help` through the real main.ts. Every handler in the
 * registry is swapped for a spy, so the test reads off what must not happen:
 * the handler runs, the daemon is started, or the version check pings.
 */
const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, ReturnType<typeof import('vitest').vi.fn>>(),
  versionCheck: undefined as unknown as ReturnType<typeof import('vitest').vi.fn>,
}));

vi.mock('../commands/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../commands/registry')>();
  const { vi: v } = await import('vitest');
  const COMMANDS = Object.fromEntries(Object.keys(real.COMMANDS).map((name) => {
    const spy = v.fn();
    hoisted.handlers.set(name, spy);
    return [name, spy];
  }));
  return { COMMANDS };
});
vi.mock('../versionCheck', async () => {
  const { vi: v } = await import('vitest');
  hoisted.versionCheck = v.fn();
  return { startHeadlessVersionCheck: hoisted.versionCheck, startCliVersionCheck: v.fn() };
});
vi.mock('../utils/env', () => ({ loadEnvFile: vi.fn(), moveAutonomyToSettings: vi.fn() }));
vi.mock('@ordewell/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ordewell/core')>()),
  migrateOldConfigDir: vi.fn(),
}));

// The mocked registry above has the real one's names, so a command added later is covered.
const NAMES = Object.keys(REGISTERED);

const originalArgv = process.argv;
let out: string[];
let err: string[];
let exits: Array<string | number | null | undefined>;

async function ordewell(...args: string[]): Promise<void> {
  vi.resetModules();
  process.argv = ['node', 'ordewell', ...args];
  await import('../main');
  // main() is not exposed and every effect it has here is synchronous or one
  // microtask away, so a few turns of the event loop settle it.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** The global help, or a command's own usage when it has one. */
const HELP_TEXT = /Ordewell: task orchestration for coding agents|^Usage: ordewell /m;

const calls = () => [...hoisted.handlers].filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name);

beforeEach(() => {
  out = [];
  err = [];
  exits = [];
  hoisted.handlers.forEach((spy) => spy.mockReset());
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => { exits.push(code); }) as never);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  hoisted.versionCheck?.mockClear();
});

describe('ordewell <command> --help', () => {
  it('has commands to check', () => {
    expect(NAMES.length).toBeGreaterThan(40);
    expect(NAMES).toContain('update');
    expect(NAMES).toContain('tui');
  });

  describe.each(['--help', '-h'])('%s', (flag) => {
    it.each(NAMES)('%s prints usage and never runs the command or the version check', async (name) => {
      await ordewell(name, flag);

      expect(out.join('\n')).toMatch(HELP_TEXT);
      expect(calls()).toEqual([]);
      expect(hoisted.versionCheck).not.toHaveBeenCalled();
      expect(exits).toEqual([]);
      expect(err).toEqual([]);
    });

    it.each(NAMES)('%s still finds the flag after other arguments', async (name) => {
      await ordewell(name, 'some-id', '--session-id', 's1', flag);

      expect(out.join('\n')).toMatch(HELP_TEXT);
      expect(calls()).toEqual([]);
    });
  });

  it('prints update’s own usage, listing --dry-run', async () => {
    await ordewell('update', '--help');

    const text = out.join('\n');
    expect(text).toContain('Usage: ordewell update [--dry-run]');
    expect(text).toContain('--dry-run');
  });

  describe('free text', () => {
    it('hands a quoted sentence that merely contains --help to the command', async () => {
      await ordewell('plan', '--goal', 'document what --help does');

      expect(hoisted.handlers.get('plan')).toHaveBeenCalledWith(['--goal', 'document what --help does']);
      expect(out).toEqual([]);
    });

    it('treats a flag’s value as text even when it is exactly -h', async () => {
      await ordewell('add-task', '--title', '-h');

      expect(hoisted.handlers.get('add-task')).toHaveBeenCalledWith(['--title', '-h']);
    });

    it('treats an inline --goal=--help as text', async () => {
      await ordewell('plan', '--goal=--help');

      expect(hoisted.handlers.get('plan')).toHaveBeenCalledWith(['--goal=--help']);
    });

    it('stops looking at a -- separator', async () => {
      await ordewell('continue', '3', '--', '--help');

      expect(hoisted.handlers.get('continue')).toHaveBeenCalledWith(['3', '--', '--help']);
      expect(out).toEqual([]);
    });
  });

  it('still reports an unknown command rather than printing help for it', async () => {
    await ordewell('bogus', '--help');

    expect(err.join('\n')).toContain('Unknown command: bogus');
    expect(exits).toEqual([1]);
    expect(out).toEqual([]);
  });
});

describe('the top level', () => {
  it.each(['--help', '-h'])('%s prints the global help', async (flag) => {
    await ordewell(flag);

    expect(out.join('\n')).toContain('Ordewell: task orchestration for coding agents');
    expect(calls()).toEqual([]);
    expect(hoisted.versionCheck).not.toHaveBeenCalled();
  });

  it.each(['--version', '-v', 'version'])('%s prints the version', async (flag) => {
    await ordewell(flag);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+/);
    expect(calls()).toEqual([]);
  });

  it('suggests -- for a command typed with a long dash', async () => {
    await ordewell('—help');

    expect(err.join('\n')).toContain('Unknown command: —help');
    expect(err.join('\n')).toContain('Did you mean --help?');
    expect(exits).toEqual([1]);
    expect(calls()).toEqual([]);
  });

  it('runs a command that is given no help flag', async () => {
    await ordewell('retry', '3');

    expect(hoisted.handlers.get('retry')).toHaveBeenCalledWith(['3']);
    expect(hoisted.versionCheck).toHaveBeenCalledTimes(1);
  });
});
