import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { editTool } from '../edit';
import { runTool } from '../run';
import { scratch } from './helpers';

function setup(content: string, name = 'f.txt') {
  const s = scratch();
  const file = path.join(s.worktree, name);
  writeFileSync(file, content);
  const edit = (args: Record<string, unknown>) => runTool(editTool, { path: name, ...args }, s.context);
  return { ...s, file, edit, content: () => readFileSync(file, 'utf8') };
}

describe('edit matching', () => {
  it('replaces an exact, unique match', async () => {
    const t = setup('alpha\nbeta\ngamma\n');
    const result = await t.edit({ oldString: 'beta', newString: 'BETA' });
    expect(result.isError).toBe(false);
    expect(t.content()).toBe('alpha\nBETA\ngamma\n');
    expect(result.details).toMatchObject({ replacements: 1, tier: 'exact' });
  });

  it('refuses an ambiguous match and says how to fix it', async () => {
    const t = setup('x = 1\ny = 1\n');
    const result = await t.edit({ oldString: '= 1', newString: '= 2' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('found 2 matches, add surrounding context or set replaceAll');
    expect(t.content()).toBe('x = 1\ny = 1\n');
  });

  it('replaces every match with replaceAll', async () => {
    const t = setup('x = 1\ny = 1\n');
    const result = await t.edit({ oldString: '= 1', newString: '= 2', replaceAll: true });
    expect(t.content()).toBe('x = 2\ny = 2\n');
    expect(result.details).toMatchObject({ replacements: 2 });
  });

  it('matches through curly quotes, dashes and special spaces (tier 2), keeping the rest of the file', async () => {
    const t = setup('say “hello” — it’s fine\nnext\n');
    const result = await t.edit({ oldString: 'say "hello" - it\'s fine', newString: 'say hi' });
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ tier: 'normalized' });
    expect(t.content()).toBe('say hi\nnext\n');
  });

  it('matches lines that differ only in trailing whitespace (tier 3)', async () => {
    const t = setup('function f() {  \n  return 1;\t\n}\n');
    const result = await t.edit({ oldString: 'function f() {\n  return 1;\n}', newString: 'const f = () => 1;' });
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ tier: 'trailing-whitespace' });
    expect(t.content()).toBe('const f = () => 1;\n');
  });

  it('first tier with a hit wins, even if a later tier would match more', async () => {
    const t = setup('a - b\na – b\n');
    const result = await t.edit({ oldString: 'a - b', newString: 'X' });
    expect(result.isError).toBe(false);
    expect(t.content()).toBe('X\na – b\n');
  });

  it('says the edit may already be applied when newString is in the file', async () => {
    const t = setup('const answer = 42;\n');
    const result = await t.edit({ oldString: 'const answer = 41;', newString: 'const answer = 42;' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('newString is already in the file');
  });

  it('offers the closest lines when nothing matches', async () => {
    const t = setup('import a from "a";\nconst totalCount = items.length;\nexport default a;\n');
    const result = await t.edit({ oldString: 'const totalcount = items.size;', newString: 'x' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Closest lines');
    expect(result.text).toContain('2: const totalCount = items.length;');
  });

  it('refuses an edit that changes nothing, and an empty oldString', async () => {
    const t = setup('abc\n');
    expect((await t.edit({ oldString: 'abc', newString: 'abc' })).text).toContain('identical');
    expect((await t.edit({ oldString: '', newString: 'abc' })).text).toContain('empty');
  });

  it('preserves CRLF line endings when the model writes LF', async () => {
    const t = setup('one\r\ntwo\r\nthree\r\n');
    await t.edit({ oldString: 'one\ntwo', newString: 'uno\ndos\ndos-bis' });
    expect(t.content()).toBe('uno\r\ndos\r\ndos-bis\r\nthree\r\n');
  });

  it('keeps LF files LF and mixed files as they were outside the edit', async () => {
    const t = setup('a\r\nb\nc\r\n');
    await t.edit({ oldString: 'b', newString: 'B' });
    expect(t.content()).toBe('a\r\nB\nc\r\n');
  });

  it('reports a missing file and a directory', async () => {
    const t = setup('x');
    expect((await runTool(editTool, { path: 'nope.txt', oldString: 'a', newString: 'b' }, t.context)).text).toContain('does not exist');
    expect((await runTool(editTool, { path: '.', oldString: 'a', newString: 'b' }, t.context)).text).toContain('directory');
  });

  it('serializes parallel edits to one file so none is lost', async () => {
    const t = setup(Array.from({ length: 20 }, (_, i) => `<line${i}>`).join('\n') + '\n');
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => t.edit({ oldString: `<line${i}>`, newString: `<LINE${i}>` })));
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(t.content()).toBe(Array.from({ length: 20 }, (_, i) => `<LINE${i}>`).join('\n') + '\n');
  });
});

describe('edit confinement', () => {
  it('refuses a path outside the worktree, absolute or via ..', async () => {
    const t = setup('x');
    const outside = path.join(t.root, 'outside.txt');
    writeFileSync(outside, 'keep');
    for (const target of [outside, '../outside.txt']) {
      const result = await runTool(editTool, { path: target, oldString: 'keep', newString: 'gone' }, t.context);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('outside the worktree');
    }
    expect(readFileSync(outside, 'utf8')).toBe('keep');
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink that leads out of the worktree', async () => {
    const t = setup('x');
    const outside = path.join(t.root, 'outside.txt');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, path.join(t.worktree, 'escape.txt'));
    const result = await runTool(editTool, { path: 'escape.txt', oldString: 'keep', newString: 'gone' }, t.context);
    expect(result.text).toContain('outside the worktree');
    expect(readFileSync(outside, 'utf8')).toBe('keep');
  });
});
