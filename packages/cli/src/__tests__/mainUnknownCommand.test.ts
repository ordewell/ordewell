import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../versionCheck', async () => {
  const { vi: v } = await import('vitest');
  return { startHeadlessVersionCheck: v.fn(), startCliVersionCheck: v.fn() };
});
vi.mock('../utils/env', () => ({ loadEnvFile: vi.fn(), moveAutonomyToSettings: vi.fn() }));

const originalArgv = process.argv;
let err: string[];
let exits: Array<string | number | null | undefined>;

beforeEach(() => {
  err = [];
  exits = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => { exits.push(code); }) as never);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('ordewell <name that Object.prototype owns>', () => {
  // COMMANDS is a plain object, so a lookup by name reaches inherited members
  // and would run them as handlers instead of reporting an unknown command.
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('%s is an unknown command', async (name) => {
    vi.resetModules();
    process.argv = ['node', 'ordewell', name];
    await import('../main');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(err.join('\n')).toContain(`Unknown command: ${name}`);
    expect(exits).toEqual([1]);
  });
});
