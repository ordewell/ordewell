import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTool } from '../run';
import { readTool } from '../read';
import { scratch } from './helpers';

describe('read', () => {
  it('prints lines as "N: line" and pages at 2000 lines with an offset to continue', async () => {
    const { context, worktree } = scratch();
    writeFileSync(path.join(worktree, 'big.txt'), Array.from({ length: 2500 }, (_, i) => `row ${i + 1}`).join('\n') + '\n');

    const first = await runTool(readTool, { path: 'big.txt' }, context);
    const lines = first.text.split('\n');
    expect(lines[0]).toBe('1: row 1');
    expect(lines[1999]).toBe('2000: row 2000');
    expect(first.text).toContain('offset=2001');
    expect(first.text).not.toContain('2001: row 2001');

    const second = await runTool(readTool, { path: 'big.txt', offset: 2001 }, context);
    expect(second.text.split('\n')[0]).toBe('2001: row 2001');
    expect(second.text).toContain('2500: row 2500');
    expect(second.text).toContain('End of file');
    expect(second.text).not.toContain('offset=');
  });

  it('honours a limit and handles CRLF files', async () => {
    const { context, worktree } = scratch();
    writeFileSync(path.join(worktree, 'a.txt'), 'one\r\ntwo\r\nthree\r\n');
    const result = await runTool(readTool, { path: 'a.txt', limit: 2 }, context);
    expect(result.text.split('\n').slice(0, 2)).toEqual(['1: one', '2: two']);
    expect(result.text).toContain('offset=3');
  });

  it('lists a directory, directories first with a trailing slash', async () => {
    const { context, worktree } = scratch();
    mkdirSync(path.join(worktree, 'src'));
    writeFileSync(path.join(worktree, 'b.txt'), '');
    writeFileSync(path.join(worktree, 'a.txt'), '');
    const result = await runTool(readTool, { path: '.' }, context);
    expect(result.text.split('\n')).toEqual(['src/', 'a.txt', 'b.txt']);
  });

  it('suggests nearby names for a missing file', async () => {
    const { context, worktree } = scratch();
    mkdirSync(path.join(worktree, 'src'));
    writeFileSync(path.join(worktree, 'src', 'ToolRunner.ts'), '');
    writeFileSync(path.join(worktree, 'src', 'unrelated.md'), '');
    const result = await runTool(readTool, { path: 'src/ToolRuner.ts' }, context);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('does not exist');
    expect(result.text).toContain('Did you mean');
    expect(result.text).toContain(path.join('src', 'ToolRunner.ts'));
    expect(result.text).not.toContain('unrelated.md');
  });

  it('reports a binary file instead of printing it', async () => {
    const { context, worktree } = scratch();
    writeFileSync(path.join(worktree, 'x.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00]));
    const result = await runTool(readTool, { path: 'x.bin' }, context);
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/binary file.*6 bytes/i);
    expect(result.text).not.toContain('1:');
  });

  it('truncates a very long line and pages at 50 KiB with a correct offset', async () => {
    const { context, worktree } = scratch();
    writeFileSync(path.join(worktree, 'wide.txt'), Array.from({ length: 100 }, () => 'x'.repeat(1500)).join('\n'));
    const result = await runTool(readTool, { path: 'wide.txt' }, context);
    const shownRows = result.text.split('\n').filter((l) => /^\d+: /.test(l)).length;
    expect(shownRows).toBeLessThan(100);
    expect(Buffer.byteLength(result.text)).toBeLessThan(51 * 1024);
    expect(result.text).toContain(`offset=${shownRows + 1}`);
  });

  it('reads outside the worktree only where the context allows', async () => {
    const { context, root } = scratch();
    const outside = path.join(root, 'elsewhere.txt');
    writeFileSync(outside, 'secret');
    const refused = await runTool(readTool, { path: outside }, context);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('outside');

    const allowed = await runTool(readTool, { path: outside }, { ...context, extraReadRoots: [root] });
    expect(allowed.text).toContain('1: secret');
  });

  // Creating a symlink needs a privilege Windows runners do not grant by default.
  it.skipIf(process.platform === 'win32')('refuses a symlink in the worktree that points outside it', async () => {
    const { context, worktree, root } = scratch();
    const outside = path.join(root, 'elsewhere.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(worktree, 'link.txt'));
    const viaLink = await runTool(readTool, { path: 'link.txt' }, context);
    expect(viaLink.isError).toBe(true);
    expect(viaLink.text).not.toContain('secret');
  });

  it('pages the full output a capped result was saved to', async () => {
    const { context, outputDir } = scratch();
    mkdirSync(outputDir, { recursive: true });
    const saved = path.join(outputDir, 'tool-1.txt');
    writeFileSync(saved, 'a\nb\n');
    expect((await runTool(readTool, { path: saved }, context)).text).toContain('2: b');
  });
});
