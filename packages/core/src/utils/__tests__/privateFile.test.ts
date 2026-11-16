import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writePrivateFile } from '../privateFile';

const isWindows = process.platform === 'win32';

/** The codes the next renames fail with, one each, before renames go through again. */
const refuse = vi.hoisted(() => ({ codes: [] as string[] }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      const code = refuse.codes.shift();
      if (code) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
      return actual.renameSync(...args);
    },
  };
});

let dir = '';

describe('writePrivateFile', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-private-'));
  });

  afterEach(() => {
    refuse.codes = [];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!isWindows)('renames again when Windows refuses for a moment, as a scanner holding the file makes it', () => {
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 'old');
    refuse.codes = ['EPERM', 'EBUSY', 'EACCES'];

    writePrivateFile(file, 'new');

    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['secret']);
  });

  it('gives up on a rename refused every time, says why, and leaves no temp file', () => {
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 'old');
    refuse.codes = Array.from({ length: 6 }, () => 'EPERM');

    expect(() => writePrivateFile(file, 'new')).toThrow(/EPERM/);

    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['secret']);
    // Only Windows waits a refusal out; elsewhere it is a real one at once.
    expect(refuse.codes).toHaveLength(isWindows ? 1 : 5);
  });

  it('writes the content', () => {
    const file = path.join(dir, 'secret');
    writePrivateFile(file, 'abc');
    expect(fs.readFileSync(file, 'utf8')).toBe('abc');
  });

  it('creates the parent directory owner-only', () => {
    if (isWindows) return;
    const file = path.join(dir, 'nested', 'deep', 'secret');
    writePrivateFile(file, 'abc');
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('creates a file readable only by its owner', () => {
    if (isWindows) return;
    const file = path.join(dir, 'secret');
    writePrivateFile(file, 'abc');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing world-readable file to 0600', () => {
    if (isWindows) return;
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o644);

    writePrivateFile(file, 'new');

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
  });

  it('leaves no temp file behind', () => {
    const file = path.join(dir, 'secret');
    writePrivateFile(file, 'abc');
    expect(fs.readdirSync(dir)).toEqual(['secret']);
  });

  it('does not follow a symlink planted at the target', () => {
    if (isWindows) return;
    const elsewhere = path.join(dir, 'elsewhere');
    const file = path.join(dir, 'secret');
    fs.writeFileSync(elsewhere, 'original');
    fs.symlinkSync(elsewhere, file);

    writePrivateFile(file, 'new');

    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('original');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
  });
});
