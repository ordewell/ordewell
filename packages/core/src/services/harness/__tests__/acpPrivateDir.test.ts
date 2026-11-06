import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { acpPrivateDir } from '../acpPrivateDir';

const refuse = vi.hoisted(() => ({ once: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (refuse.once) {
        refuse.once = false;
        throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' });
      }
      return actual.rmSync(...args);
    },
  };
});

afterEach(() => { refuse.once = false; });

describe('acpPrivateDir', () => {
  it('removes the directory and what it holds', () => {
    const dir = acpPrivateDir();
    dir.write('token.json', '{}');
    dir.remove();
    expect(existsSync(dir.path)).toBe(false);
  });

  // What Windows does while the process still has the directory as its cwd:
  // ProcessLifecycle frees it before the kill, so a throw would skip the kill.
  it('does not throw when the removal is refused, and removes the directory once it may', async () => {
    const dir = acpPrivateDir();
    dir.write('token.json', '{}');
    refuse.once = true;

    expect(() => dir.remove()).not.toThrow();
    await vi.waitFor(() => expect(existsSync(dir.path)).toBe(false));
  });
});
