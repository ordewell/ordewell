import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask, createWorktreeIsolation } from '@ordewell/core';
import { PoolFileSystem } from '../PoolFileSystem';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

function repo(root: string, files: Record<string, string>): void {
  fs.mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: cleanEnv(), stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
}

/** Every symlink under `dir`, found without following one. */
function linksUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) found.push(full);
    else if (entry.isDirectory() && entry.name !== '.git') found.push(...linksUnder(full));
  }
  return found;
}

const isInside = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

let tmp: string;
let workspace: string;
let outside: string;
let taskWorkspace: string;

// A repo group whose loose paths include a link of the user's own that leads
// out of the workspace, with a task workspace prepared beside it: the shape in
// which shared-path links could widen what the planner reaches.
beforeAll(async () => {
  if (!hasGit) return;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-envelope-')));
  workspace = path.join(tmp, 'workspace');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_TOKEN_7f3a\n');
  repo(path.join(workspace, 'api'), { 'api.txt': 'api\n', '.gitignore': '.env\n' });
  repo(path.join(workspace, 'web'), { 'web.txt': 'web\n' });
  fs.writeFileSync(path.join(workspace, 'api', '.env'), 'API_KEY=1\n');
  fs.writeFileSync(path.join(workspace, 'NOTES.md'), 'NOTES_TOKEN_91c2\n');
  fs.symlinkSync(outside, path.join(workspace, 'ext'), 'dir');

  const isolation = createWorktreeIsolation({
    config: { worktreeIsolation: true, worktreeSetupCommand: undefined, workspaceRepos: [], worktreeLinks: [] },
    resolvePath: async () => process.env.PATH ?? '',
  });
  const run = await isolation.startRun(workspace);
  expect(run.shared).toEqual(['NOTES.md', 'ext']);
  taskWorkspace = (await isolation.prepare(createTask({ id: 't1', order: 1, title: 'Span repos', prompt: 'x' }), run)).cwd;
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function withoutRipgrep(): PoolFileSystem {
  const adapter = new PoolFileSystem(workspace);
  (adapter as unknown as { rgAvailable: Promise<boolean> }).rgAvailable = Promise.resolve(false);
  return adapter;
}

describe.skipIf(!hasGit)('the planner envelope beside a repo group\'s task workspaces (ADR-0008)', () => {
  it('links nothing out of the workspace: every link in a task workspace leads to the same path in the real one', () => {
    const links = linksUnder(taskWorkspace);
    expect(links.map((l) => path.relative(taskWorkspace, l)).sort()).toEqual(['NOTES.md', 'api/.env', 'ext']);
    for (const link of links) {
      const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
      expect(isInside(workspace, target), link).toBe(true);
      expect(isInside(path.join(workspace, '.ordewell'), target), link).toBe(false);
      expect(path.relative(workspace, target)).toBe(path.relative(taskWorkspace, link));
    }
  });

  it.each([
    ['ripgrep', () => new PoolFileSystem(workspace)],
    ['the POSIX fallback', withoutRipgrep],
  ])('searches with %s never enter a task workspace or follow a link out of the workspace', async (_name, adapter) => {
    const planner = adapter();

    const notes = await planner.grep('NOTES_TOKEN_91c2', { outputMode: 'files' });
    expect(notes.success).toBe(true);
    expect(notes.output).toContain('NOTES.md');
    expect(notes.output).not.toContain('.ordewell');

    const escaped = await planner.grep('OUTSIDE_TOKEN_7f3a', { outputMode: 'files' });
    expect(escaped.output).not.toContain('secret.txt');

    const listed = await planner.glob('**/*.txt');
    expect(listed.output).toContain('api.txt');
    expect(listed.output).not.toContain('.ordewell');
    expect(listed.output).not.toContain('secret.txt');
  });

  it('still asks before reading outside the workspace, with the task workspaces in place', async () => {
    const result = await new PoolFileSystem(workspace).readFile(path.join(outside, 'secret.txt'));
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/outside the workspace/);
  });
});
