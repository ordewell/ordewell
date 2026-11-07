import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ordewell update` through the real main.ts and registry, with every way it
 * could start a program or reach the network recorded instead of done.
 */
const hoisted = vi.hoisted(() => ({ started: [] as string[] }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const record = (kind: string) => (command: string, ...rest: unknown[]) => {
    hoisted.started.push(`${kind} ${command} ${Array.isArray(rest[0]) ? (rest[0] as string[]).join(' ') : ''}`.trim());
    throw new Error(`${kind} ${command} must not run in this test`);
  };
  return { ...real, spawn: record('spawn'), spawnSync: record('spawnSync'), exec: record('exec'), execSync: record('execSync'), execFile: record('execFile'), execFileSync: record('execFileSync') };
});
vi.mock('../versionCheck', () => ({ startHeadlessVersionCheck: vi.fn(), startCliVersionCheck: vi.fn() }));
vi.mock('../utils/env', () => ({ loadEnvFile: vi.fn(), moveAutonomyToSettings: vi.fn() }));
vi.mock('@ordewell/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ordewell/core')>()),
  migrateOldConfigDir: vi.fn(),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let out: string[];
let err: string[];

async function ordewell(...args: string[]): Promise<void> {
  vi.resetModules();
  process.exitCode = undefined;
  process.argv = ['node', 'ordewell', ...args];
  await import('../main');
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
  out = [];
  err = [];
  hoisted.started.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ordewell update', () => {
  it.each(['--dryrun', '--dry_run', '-n', '--dry-run=1', '--force'])('refuses %s: exit 1, nothing started', async (option) => {
    await ordewell('update', option);

    expect(process.exitCode).toBe(1);
    expect(err).toEqual([
      `Unknown option: ${option}`,
      'Run `ordewell update --help` for usage.',
    ]);
    expect(out).toEqual([]);
    expect(hoisted.started).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an unknown option even beside --dry-run', async () => {
    await ordewell('update', '--dry-run', '--dryrun');

    expect(process.exitCode).toBe(1);
    expect(err[0]).toBe('Unknown option: --dryrun');
    expect(out).toEqual([]);
  });

  it('refuses a stray word, which would otherwise start a real update', async () => {
    await ordewell('update', 'now');

    expect(process.exitCode).toBe(1);
    expect(err).toEqual(['Unexpected argument: now', 'Run `ordewell update --help` for usage.']);
    expect(hoisted.started).toEqual([]);
  });

  it('--help prints usage and exits 0 without starting anything', async () => {
    await ordewell('update', '--help');

    expect(process.exitCode).toBeUndefined();
    expect(out.join('\n')).toContain('Usage: ordewell update [--dry-run]');
    expect(err).toEqual([]);
    expect(hoisted.started).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('--dry-run still names the command it would run, and runs none of it', async () => {
    await ordewell('update', '--dry-run');

    // This copy is a source checkout or an npm one, depending on where the
    // suite runs: either says what it would do, and neither runs anything.
    expect(process.exitCode ?? 0).toBe(0);
    expect(out.join('\n')).toMatch(/Would run: |source checkout|npx|installed in the project/);
    expect(err).toEqual([]);
    expect(hoisted.started.filter((s) => /curl|brew|npm\b.*install/.test(s))).toEqual([]);
  });
});
