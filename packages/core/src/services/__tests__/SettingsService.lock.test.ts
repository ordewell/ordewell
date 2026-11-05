import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SettingsService } from '../SettingsService';
import { patient } from '../../testing';

/** The lock file every test here uses. */
const LOCK_NAME = 'settings.json.lock';

/** What another process does while this one works the lock; reset after each test. */
let other: {
  /** Called before each look at the lock's age, with how many looks there have been. */
  beforeLook?: (count: number) => void;
  /** Tokens a read of the lock reports in turn, in place of the file's own. */
  tokens?: string[];
  /** Whether removing the lock is refused, as a handle denying it would. */
  refuseRemoval?: boolean;
} | null = null;

/** Runs in place of the swap's rename, as another process would act while it happens; reset after each test. */
let duringSwap: ((to: string) => void) | null = null;

/** How many times the age of the lock was looked at, and how many times it was asked for. */
let looks = 0;
let attempts = 0;
let reads = 0;

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isLock = (p: fs.PathLike): boolean => String(p).endsWith(LOCK_NAME);
  const refused = (operation: string, target: fs.PathLike): NodeJS.ErrnoException => {
    const err: NodeJS.ErrnoException = new Error(`EPERM: operation not permitted, ${operation} '${String(target)}'`);
    err.code = 'EPERM';
    return err;
  };
  return {
    ...actual,
    openSync: ((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      // Only a protocol that keeps going round asks for the lock this many times.
      if (other?.refuseRemoval && isLock(p) && ++attempts > 40) throw new Error('a lock it cannot remove was taken again and again');
      return actual.openSync(p, flags, mode);
    }) as typeof actual.openSync,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      duringSwap?.(String(to));
      actual.renameSync(from, to);
    },
    readFileSync: ((p: fs.PathLike, opts?: unknown) => {
      if (other?.tokens && isLock(p)) return other.tokens[reads++ % other.tokens.length];
      return actual.readFileSync(p, opts as fs.ObjectEncodingOptions);
    }) as typeof actual.readFileSync,
    statSync: ((p: fs.PathLike, opts?: unknown) => {
      if (other?.beforeLook && isLock(p)) other.beforeLook(++looks);
      return actual.statSync(p, opts as Parameters<typeof actual.statSync>[1]);
    }) as typeof actual.statSync,
    unlinkSync: ((p: fs.PathLike) => {
      if (other?.refuseRemoval && isLock(p)) throw refused('unlink', p);
      return actual.unlinkSync(p);
    }) as typeof actual.unlinkSync,
  };
});

describe('SettingsService — a stale lock is taken over, never moved aside', () => {
  let dir: string;
  let file: string;
  let lock: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-settings-lock-'));
    file = path.join(dir, 'settings.json');
    lock = `${file}.lock`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    other = null;
    duringSwap = null;
    looks = 0;
    attempts = 0;
    reads = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A lock a process left behind by dying, long past the stale age. */
  function staleLock(): void {
    fs.writeFileSync(lock, 'dead');
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, longAgo, longAgo);
  }

  // A lock another process has taken over in the instant this one looks is a
  // different lock — another token, another mtime — and is waited on, not
  // removed as the stale one it replaced.
  it('does not remove a lock that changed under its second look', () => {
    staleLock();
    let takenOverAt: number | undefined;
    other = {
      beforeLook: (count) => {
        if (count !== 2 || takenOverAt !== undefined) return;
        fs.rmSync(lock);
        fs.writeFileSync(lock, 'live-b');
        takenOverAt = Date.now();
      },
    };

    new SettingsService(file).setEnabledRunners(['codex']);

    // It went ahead only once the takeover's own lock had gone stale.
    expect(Date.now() - (takenOverAt ?? 0)).toBeGreaterThanOrEqual(2_000);
    expect(new SettingsService(file).getEnabledRunners()).toEqual(['codex']);
  }, patient(10_000));

  // A save suspended past the stale age has its lock taken over by another
  // process; on waking it must not remove the lock that is no longer its own.
  it('leaves the lock another process took over while it swapped', () => {
    duringSwap = (to) => {
      if (to !== file) return;
      fs.rmSync(lock);
      fs.writeFileSync(lock, 'other');
    };

    new SettingsService(file).setEnabledRunners(['codex']);

    expect(fs.readFileSync(lock, 'utf8')).toBe('other');
  });

  it('releases its own lock', () => {
    new SettingsService(file).setEnabledRunners(['codex']);
    expect(fs.existsSync(lock)).toBe(false);
  });

  // A lock that is there but cannot be removed must be said: retrying it for
  // ever freezes the process that is saving, and the refusal is the only thing
  // that tells the user why.
  it('surfaces a lock it cannot remove instead of retrying for ever', () => {
    staleLock();
    other = { refuseRemoval: true };

    let raised: unknown;
    try {
      new SettingsService(file).setEnabledRunners(['codex']);
    } catch (err) {
      raised = err;
    }

    expect(raised).toBeInstanceOf(Error);
    expect((raised as Error).message).toMatch(/EPERM/);
    expect(attempts).toBeLessThan(40);
  });

  // A lock another process keeps replacing as this one looks is never the same
  // lock twice: the wait ends with an error naming the lock, not with a spin.
  it('gives up on a lock that never stops moving, naming it', () => {
    staleLock();
    other = { tokens: ['dead', 'other'] };
    // A clock that advances on its own makes the bound reachable in a test.
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 500));

    let raised: unknown;
    try {
      new SettingsService(file).setEnabledRunners(['codex']);
    } catch (err) {
      raised = err;
    }

    expect(raised).toBeInstanceOf(Error);
    expect((raised as Error).message).toContain(lock);
    expect((raised as Error).message).toMatch(/10 seconds/);
  }, patient(10_000));
});
