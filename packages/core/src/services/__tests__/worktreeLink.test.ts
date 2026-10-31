import { describe, it, expect, afterEach } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { linkPath, mirrorDir } from '../worktreeLink';

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
function lexists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
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

describe('mirrorDir', () => {
  // A main checkout and a task checkout of the same repository, the main one with an installed node_modules.
  function checkouts(): { main: string; task: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-mirror-')));
    dirs.push(root);
    const main = join(root, 'main');
    const task = join(root, 'task');
    for (const checkout of [main, task]) {
      mkdirSync(join(checkout, 'packages', 'a'), { recursive: true });
      writeFileSync(join(checkout, 'packages', 'a', 'index.js'), `module.exports = '${checkout === main ? 'main' : 'task'}';\n`);
    }
    mkdirSync(join(main, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(main, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    return { main, task };
  }

  it('links a real package to the main copy and recreates a relative link so it resolves inside the task checkout', () => {
    const { main, task } = checkouts();
    symlinkSync('../packages/a', join(main, 'node_modules', 'a'));

    mirrorDir(join(main, 'node_modules'), join(task, 'node_modules'), { platform: 'linux', from: main, to: task });

    expect(lstatSync(join(task, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(realpathSync(join(task, 'node_modules', 'left-pad'))).toBe(join(main, 'node_modules', 'left-pad'));
    expect(readlinkSync(join(task, 'node_modules', 'a'))).toBe('../packages/a');
    expect(realpathSync(join(task, 'node_modules', 'a'))).toBe(join(task, 'packages', 'a'));
  });

  it("leaves tools' caches out, so a worktree makes its own instead of writing the main checkout's (ADR-0013)", () => {
    const { main, task } = checkouts();
    const caches = ['.cache', '.vite', '.vite-temp', '.vitest'];
    for (const cache of caches) mkdirSync(join(main, 'node_modules', cache, 'vitest'), { recursive: true });

    mirrorDir(join(main, 'node_modules'), join(task, 'node_modules'), { platform: 'linux', from: main, to: task });

    expect(readdirSync(join(task, 'node_modules'))).toEqual(['left-pad']);
  });

  it('goes one level into scope and .bin directories, so a scoped workspace link and a bin link resolve through the task checkout', () => {
    const { main, task } = checkouts();
    mkdirSync(join(main, 'node_modules', '@scope', 'real', 'nested'), { recursive: true });
    mkdirSync(join(main, 'node_modules', 'left-pad', 'bin'));
    writeFileSync(join(main, 'node_modules', 'left-pad', 'bin', 'pad'), '#!/bin/sh\n');
    symlinkSync('../../packages/a', join(main, 'node_modules', '@scope', 'a'));
    mkdirSync(join(main, 'node_modules', '.bin'));
    symlinkSync('../left-pad/bin/pad', join(main, 'node_modules', '.bin', 'pad'));

    mirrorDir(join(main, 'node_modules'), join(task, 'node_modules'), { platform: 'linux', from: main, to: task });

    expect(lstatSync(join(task, 'node_modules', '@scope')).isSymbolicLink()).toBe(false);
    expect(realpathSync(join(task, 'node_modules', '@scope', 'a'))).toBe(join(task, 'packages', 'a'));
    expect(lstatSync(join(task, 'node_modules', '@scope', 'real')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(task, 'node_modules', '@scope', 'real'))).toBe(join(main, 'node_modules', '@scope', 'real'));
    expect(lstatSync(join(task, 'node_modules', '.bin')).isSymbolicLink()).toBe(false);
    expect(readlinkSync(join(task, 'node_modules', '.bin', 'pad'))).toBe('../left-pad/bin/pad');
    expect(readFileSync(join(task, 'node_modules', '.bin', 'pad'), 'utf8')).toBe('#!/bin/sh\n');
  });

  it('points an absolute link into the main checkout at the same path in the task checkout, unless it leads into a node_modules', () => {
    const { main, task } = checkouts();
    const elsewhere = join(main, '..', 'global-cache');
    mkdirSync(elsewhere);
    symlinkSync(join(main, 'packages', 'a'), join(main, 'node_modules', 'a'));
    symlinkSync(join(main, 'node_modules', 'left-pad'), join(main, 'node_modules', 'pad-alias'));
    symlinkSync(elsewhere, join(main, 'node_modules', 'cached'));

    mirrorDir(join(main, 'node_modules'), join(task, 'node_modules'), { platform: 'linux', from: main, to: task });

    expect(readlinkSync(join(task, 'node_modules', 'a'))).toBe(join(task, 'packages', 'a'));
    expect(readlinkSync(join(task, 'node_modules', 'pad-alias'))).toBe(join(main, 'node_modules', 'left-pad'));
    expect(readlinkSync(join(task, 'node_modules', 'cached'))).toBe(elsewhere);
  });

  it('on Windows makes a relative workspace link an absolute junction into the task checkout, and a bin link a hard link', () => {
    const { main, task } = checkouts();
    mkdirSync(join(main, 'node_modules', '@scope'));
    symlinkSync('../../packages/a', join(main, 'node_modules', '@scope', 'a'));
    mkdirSync(join(main, 'node_modules', 'left-pad', 'bin'));
    writeFileSync(join(main, 'node_modules', 'left-pad', 'bin', 'pad'), '#!/bin/sh\n');
    mkdirSync(join(main, 'node_modules', '.bin'));
    symlinkSync('../left-pad/bin/pad', join(main, 'node_modules', '.bin', 'pad'));
    symlinkSync('../../packages/gone', join(main, 'node_modules', '@scope', 'gone'));

    const copied = mirrorDir(join(main, 'node_modules'), join(task, 'node_modules'), { platform: 'win32', from: main, to: task });

    // Junctions are symlinks with an absolute target as far as a POSIX test host can make one.
    expect(readlinkSync(join(task, 'node_modules', '@scope', 'a'))).toBe(join(task, 'packages', 'a'));
    expect(lstatSync(join(task, 'node_modules', '.bin', 'pad')).isSymbolicLink()).toBe(false);
    expect(statSync(join(task, 'node_modules', '.bin', 'pad')).ino).toBe(statSync(join(main, 'node_modules', 'left-pad', 'bin', 'pad')).ino);
    expect(lexists(join(task, 'node_modules', '@scope', 'gone'))).toBe(false);
    expect(copied).toEqual([]);
  });

  it('on Windows reports a bin link it had to copy', () => {
    const { main, task } = checkouts();
    mkdirSync(join(main, 'node_modules', '.bin'));
    symlinkSync('../left-pad/index.js', join(main, 'node_modules', '.bin', 'pad'));
    const crossVolume = () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };

    const copied = mirrorDir(join(main, 'node_modules'), join(task, 'node_modules'), { platform: 'win32', from: main, to: task, hardLink: crossVolume });

    expect(copied).toEqual([join('.bin', 'pad')]);
    expect(readFileSync(join(task, 'node_modules', '.bin', 'pad'), 'utf8')).toBe('module.exports = 1;\n');
  });

  it('repoints a workspace link to a package the main checkout no longer has, so the task resolves its own code', () => {
    const { main, task } = checkouts();
    // The link was installed when the package lived in the main checkout; the task has since moved it.
    symlinkSync('../packages/a', join(main, 'node_modules', 'a'));
    rmSync(join(main, 'packages', 'a'), { recursive: true });
    mkdirSync(join(task, 'packages', 'a'), { recursive: true });
    writeFileSync(join(task, 'packages', 'a', 'index.js'), 'module.exports = \'task\';\n');

    mirrorDir(join(main, 'node_modules'), join(task, 'node_modules'), { platform: 'linux', from: main, to: task });

    expect(realpathSync(join(task, 'node_modules', 'a'))).toBe(join(task, 'packages', 'a'));
    expect(readFileSync(join(task, 'packages', 'a', 'index.js'), 'utf8')).toBe('module.exports = \'task\';\n');
  });
});
