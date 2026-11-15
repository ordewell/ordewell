import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { globTool, globToRegExp } from '../glob';
import { grepTool } from '../grep';
import { runTool } from '../run';
import type { ToolContext } from '../types';
import { scratch } from './helpers';

function installed(tool: string): boolean {
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// CI names rg in ORDEWELL_REQUIRE_TOOLS: there a missing rg fails instead of skipping.
const REQUIRED = new Set((process.env.ORDEWELL_REQUIRE_TOOLS ?? '').split(/[\s,]+/).filter(Boolean));
const haveRg = installed('rg') || REQUIRED.has('rg');

function put(root: string, file: string, content = 'x\n', age = 0): void {
  const abs = path.join(root, file);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (age) utimesSync(abs, new Date(Date.now() - age), new Date(Date.now() - age));
}

function project() {
  const s = scratch();
  put(s.worktree, 'src/a.ts', 'const needle = 1;\nconst other = 2;\n', 3000);
  put(s.worktree, 'src/b.ts', 'export const NEEDLE = 3;\n', 2000);
  put(s.worktree, 'src/deep/c.md', 'needle in prose\n', 1000);
  put(s.worktree, 'node_modules/pkg/index.js', 'needle\n');
  put(s.worktree, 'ignored/secret.ts', 'needle\n');
  put(s.worktree, '.gitignore', 'ignored/\n');
  return s;
}

/** A PATH that has git and grep but no rg, so the fallback runs whatever the host has. */
function pathWithoutRg(root: string): string {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of ['grep', 'git']) {
    const real = execFileSync('which', [tool], { encoding: 'utf8' }).trim();
    if (!existsSync(path.join(bin, tool))) symlinkSync(real, path.join(bin, tool));
  }
  return bin;
}

const withRg = (s: ReturnType<typeof scratch>): ToolContext => s.context;
const withoutRg = (s: ReturnType<typeof scratch>): ToolContext => ({ ...s.context, env: { ...process.env, PATH: pathWithoutRg(s.root) } });

describe('globToRegExp', () => {
  it('matches the shapes models write', () => {
    expect(globToRegExp('**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/deep/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false);
    expect(globToRegExp('src/**/*.{ts,md}').test('src/deep/c.md')).toBe(true);
    expect(globToRegExp('test_?.py').test('x/test_1.py')).toBe(true);
    expect(globToRegExp('a.ts').test('bats')).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('grep and glob without ripgrep', () => {
  it('grep falls back to grep, with path:line: text rows', async () => {
    const s = project();
    const result = await runTool(grepTool, { pattern: 'needle', ignoreCase: true }, withoutRg(s));
    expect(result.isError).toBe(false);
    const rows = result.text.split('\n');
    expect(rows).toContain('src/a.ts:1: const needle = 1;');
    expect(rows).toContain('src/b.ts:1: export const NEEDLE = 3;');
    expect(result.text).not.toContain('node_modules');
    expect(result.details?.engine).toContain('grep');
  });

  it('grep filters by an anchored glob and a path', async () => {
    const s = project();
    const anchored = await runTool(grepTool, { pattern: 'needle', glob: 'src/*.ts' }, withoutRg(s));
    expect(anchored.text).toBe('src/a.ts:1: const needle = 1;');
    const inPath = await runTool(grepTool, { pattern: 'needle', path: 'src/deep' }, withoutRg(s));
    expect(inPath.text).toBe('src/deep/c.md:1: needle in prose');
  });

  it('grep reports no matches, and refuses a path outside the worktree', async () => {
    const s = project();
    expect((await runTool(grepTool, { pattern: 'zzzzqqq' }, withoutRg(s))).text).toBe('No matches found.');
    const outside = await runTool(grepTool, { pattern: 'x', path: '..' }, withoutRg(s));
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('outside the folders');
  });

  it('glob lists matching files newest first, skipping node_modules and gitignored files', async () => {
    const s = project();
    execFileSync('git', ['init', '-q'], { cwd: s.worktree });
    const result = await runTool(globTool, { pattern: '**/*.{ts,md}' }, withoutRg(s));
    expect(result.isError).toBe(false);
    expect(result.text.split('\n')).toEqual(['src/deep/c.md', 'src/b.ts', 'src/a.ts']);
  });

  it('glob walks the directory when it is not a git checkout', async () => {
    const s = project();
    const result = await runTool(globTool, { pattern: 'src/**/*.ts' }, withoutRg(s));
    expect(result.text.split('\n')).toEqual(['src/b.ts', 'src/a.ts']);
    expect((await runTool(globTool, { pattern: '*.nothing' }, withoutRg(s))).text).toBe('No files matched.');
  });
});

describe.skipIf(!haveRg)('grep and glob with ripgrep', () => {
  it('grep returns path:line: text rows, honouring .gitignore and skipping node_modules', async () => {
    expect(installed('rg'), 'rg is missing, and ORDEWELL_REQUIRE_TOOLS requires it').toBe(true);
    const s = project();
    const result = await runTool(grepTool, { pattern: 'needle', ignoreCase: true }, withRg(s));
    expect(result.isError).toBe(false);
    expect(result.text.split('\n').sort()).toEqual(['src/a.ts:1: const needle = 1;', 'src/b.ts:1: export const NEEDLE = 3;', 'src/deep/c.md:1: needle in prose']);
    expect(result.details?.engine).toBe('ripgrep');
  });

  it('grep names the file even when it is given one file, and takes an anchored glob', async () => {
    const s = project();
    expect((await runTool(grepTool, { pattern: 'other', path: 'src/a.ts' }, withRg(s))).text).toBe('src/a.ts:2: const other = 2;');
    expect((await runTool(grepTool, { pattern: 'needle', glob: 'src/*.ts' }, withRg(s))).text).toBe('src/a.ts:1: const needle = 1;');
  });

  it('grep reads a literal pattern literally', async () => {
    const s = project();
    put(s.worktree, 'lit.txt', 'a.b(c\n');
    expect((await runTool(grepTool, { pattern: 'a.b(c', literal: true }, withRg(s))).text).toBe('lit.txt:1: a.b(c');
  });

  it('glob sorts by modification time and honours .gitignore', async () => {
    const s = project();
    const result = await runTool(globTool, { pattern: '**/*.{ts,md}' }, withRg(s));
    expect(result.text.split('\n')).toEqual(['src/deep/c.md', 'src/b.ts', 'src/a.ts']);
  });
});
