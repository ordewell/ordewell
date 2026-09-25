import { describe, it, expect, afterEach } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { linkPath } from '../worktreeLink';

const dirs: string[] = [];
function scratch(): { source: string; file: string; dir: string; out: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-link-')));
  dirs.push(root);
  const source = join(root, 'real');
  mkdirSync(join(source, 'state'), { recursive: true });
  writeFileSync(join(source, 'terraform.tfstate'), '{"v":1}\n');
  writeFileSync(join(source, 'state', 'inner.txt'), 'inner\n');
  const out = join(root, 'task');
  mkdirSync(out);
  return { source, file: join(source, 'terraform.tfstate'), dir: join(source, 'state'), out };
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('linkPath', () => {
  it('symlinks files and directories on POSIX', () => {
    const { file, dir, out } = scratch();
    expect(linkPath(file, join(out, 'terraform.tfstate'), 'linux')).toBe('symlink');
    expect(linkPath(dir, join(out, 'state'), 'darwin')).toBe('symlink');
    expect(lstatSync(join(out, 'terraform.tfstate')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(out, 'state'))).toBe(dir);
  });

  it('uses a junction for a directory on Windows', () => {
    const { dir, out } = scratch();
    expect(linkPath(dir, join(out, 'state'), 'win32')).toBe('junction');
    expect(readFileSync(join(out, 'state', 'inner.txt'), 'utf8')).toBe('inner\n');
  });

  it('hard-links a file on Windows, so an edit through it lands in the real file', () => {
    const { file, out } = scratch();
    const target = join(out, 'terraform.tfstate');
    expect(linkPath(file, target, 'win32')).toBe('hardlink');
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(statSync(target).ino).toBe(statSync(file).ino);
    writeFileSync(target, '{"v":2}\n');
    expect(readFileSync(file, 'utf8')).toBe('{"v":2}\n');
  });

  it('copies a file on Windows when a hard link is impossible, and says so', () => {
    const { file, out } = scratch();
    const target = join(out, 'terraform.tfstate');
    const crossVolume = () => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); };
    expect(linkPath(file, target, 'win32', crossVolume)).toBe('copy');
    expect(readFileSync(target, 'utf8')).toBe('{"v":1}\n');
    expect(statSync(target).ino).not.toBe(statSync(file).ino);
  });
});
