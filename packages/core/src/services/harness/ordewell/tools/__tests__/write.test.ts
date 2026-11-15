import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { editTool } from '../edit';
import { runTool } from '../run';
import { writeTool } from '../write';
import { scratch } from './helpers';

describe('write', () => {
  it('creates a file and its missing parent directories', async () => {
    const s = scratch();
    const result = await runTool(writeTool, { path: 'a/b/c.txt', content: 'hello\n' }, s.context);
    expect(result.isError).toBe(false);
    expect(readFileSync(path.join(s.worktree, 'a', 'b', 'c.txt'), 'utf8')).toBe('hello\n');
    expect(result.details).toMatchObject({ created: true, bytes: 6 });
  });

  it('overwrites an existing file and says so', async () => {
    const s = scratch();
    writeFileSync(path.join(s.worktree, 'f.txt'), 'old');
    const result = await runTool(writeTool, { path: 'f.txt', content: 'new' }, s.context);
    expect(readFileSync(path.join(s.worktree, 'f.txt'), 'utf8')).toBe('new');
    expect(result.details).toMatchObject({ created: false });
    expect(result.text).toContain('Overwrote');
  });

  it('refuses a directory target', async () => {
    const s = scratch();
    mkdirSync(path.join(s.worktree, 'd'));
    const result = await runTool(writeTool, { path: 'd', content: 'x' }, s.context);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('directory');
  });

  it('refuses a path outside the worktree, existing or not, and writes nothing', async () => {
    const s = scratch();
    const outside = path.join(s.root, 'outside.txt');
    for (const target of ['../outside.txt', outside, '../newdir/deep/x.txt']) {
      const result = await runTool(writeTool, { path: target, content: 'x' }, s.context);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('outside the worktree');
    }
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(path.join(s.root, 'newdir'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses a write through a symlink, dangling or not, that leaves the worktree', async () => {
    const s = scratch();
    const target = path.join(s.root, 'target.txt');
    symlinkSync(target, path.join(s.worktree, 'dangling'));
    const result = await runTool(writeTool, { path: 'dangling', content: 'x' }, s.context);
    expect(result.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
    symlinkSync(s.root, path.join(s.worktree, 'dirlink'));
    const viaDir = await runTool(writeTool, { path: 'dirlink/new.txt', content: 'x' }, s.context);
    expect(viaDir.isError).toBe(true);
    expect(existsSync(path.join(s.root, 'new.txt'))).toBe(false);
  });

  it('shares the per-file lock with edit, so a write and an edit in parallel both land in order', async () => {
    const s = scratch();
    writeFileSync(path.join(s.worktree, 'f.txt'), 'one');
    const [w, e] = await Promise.all([
      runTool(writeTool, { path: 'f.txt', content: 'two' }, s.context),
      runTool(editTool, { path: 'f.txt', oldString: 'two', newString: 'three' }, s.context),
    ]);
    expect(w.isError).toBe(false);
    expect(e.isError).toBe(false);
    expect(readFileSync(path.join(s.worktree, 'f.txt'), 'utf8')).toBe('three');
  });
});
