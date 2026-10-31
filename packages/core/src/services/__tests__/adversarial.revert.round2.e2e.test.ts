import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { IsolationRun, IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

/**
 * ADR-0054: a revert "adds commits and rewrites nothing" on the integration
 * branch, and git commits to whatever HEAD says. Anyone may check something
 * else out in the run's own integration worktree, so a revert from there is
 * refused, in the preview too, and what it made is read off the branch.
 */

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function initRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}
const temps: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-revert-adv2-')));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});
function task(order: number, title: string): Task {
  return { id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' };
}
function isolation(repos?: string[]): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true, ...(repos ? { workspaceRepos: repos } : {}) }) });
}
async function land(iso: IWorktreeIsolation, run: IsolationRun, t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };
const treeOf = (root: string, branch: string) => git(root, 'ls-tree', '--name-only', branch).split('\n').filter(Boolean).sort();

describe('a revert with the integration worktree off the integration branch', () => {
  async function landedThenMoved(head: (dir: string) => void) {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const tip = git(root, 'rev-parse', integration);
    const dir = join(root, '.ordewell', 'worktrees', run.id, 'integration');
    head(dir);
    return { root, iso, run, integration, t, tip, dir };
  }

  it.each([
    ['on a review branch', 'on review', (dir: string) => git(dir, 'checkout', '-q', '-b', 'review')],
    ['detached', 'detached', (dir: string) => git(dir, 'checkout', '-q', '--detach')],
  ])('is refused %s, in the preview too, naming where, and changes nothing', async (_name, where, move) => {
    const { root, iso, run, integration, t, tip, dir } = await landedThenMoved(move);
    const settled: string[][] = [];

    const preview = await iso.readLanded(run, [t.id]);
    const result = await iso.revert(run, [t.id], { ...nothingInTheWay, settled: (ids) => settled.push([...ids]) });

    expect(preview).toMatchObject({ ok: false, reason: 'checked-out', error: expect.stringContaining(`${dir} is ${where}`) });
    expect(result).toMatchObject({ outcome: 'refused', reason: expect.stringContaining(`${dir} is ${where}`) });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(settled).toEqual([]);
    expect(run.tasks[t.id].status).toBe('merged');
    expect(run.landings?.[t.id]).toEqual({ '.': [tip] });
    expect(run.landing).toBeUndefined();
    expect(run.reverted).toBeUndefined();
  });

  it('goes through once the branch is checked out there again, and Merge all then brings nothing back', async () => {
    const { root, iso, run, integration, t, dir } = await landedThenMoved((d) => git(d, 'checkout', '-q', '-b', 'review'));
    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'refused' });

    git(dir, 'checkout', '-q', integration);
    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'in-branch' });

    git(root, 'branch', '-D', 'review');
    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(treeOf(root, integration)).toEqual(['README.md']);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(existsSync(join(root, 'greeting.txt'))).toBe(false);
  });

  it('fails and leaves the task landed when the worktree moves off the branch once it has looked', async () => {
    const { root, iso, run, integration, t, tip, dir } = await landedThenMoved(() => undefined);
    const settled: string[][] = [];

    // Saved just before the first commit: the last moment the revert could have looked.
    const result = await iso.revert(run, [t.id], { ...nothingInTheWay, persist: () => git(dir, 'checkout', '-q', '-b', 'review'), settled: (ids) => settled.push([...ids]) });

    expect(result).toMatchObject({ outcome: 'failed', repo: '.', error: expect.stringContaining(dir) });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(settled).toEqual([]);
    expect(run.tasks[t.id].status).toBe('merged');
    expect(run.landing).toBeUndefined();
    expect(run.reverted).toBeUndefined();
  });

  it('is not fooled by a worktree that moved off the branch and back while it committed', async () => {
    const { root, iso, run, integration, t, tip, dir } = await landedThenMoved(() => undefined);
    // Back on the branch by the time the commit has been made, as a look at HEAD afterwards would see it.
    const hook = join(root, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, `#!/bin/sh\ngit symbolic-ref HEAD refs/heads/${integration}\ngit reset -q --hard\n`);
    chmodSync(hook, 0o755);

    const result = await iso.revert(run, [t.id], { ...nothingInTheWay, persist: () => git(dir, 'checkout', '-q', '-b', 'review') });

    expect(result).toMatchObject({ outcome: 'failed', repo: '.' });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(run.tasks[t.id].status).toBe('merged');
  });

  it('puts the other repo of a group back when one worktree strays, and leaves nothing half reverted', async () => {
    const root = tempDir();
    initRepo(join(root, 'api'));
    initRepo(join(root, 'web'));
    const iso = isolation(['api', 'web']);
    const run = await iso.startRun(root);
    const t = task(1, 'Add one');
    await land(iso, run, t, { 'api/one.txt': '1\n', 'web/one.txt': '1\n' });
    const [api, web] = run.repos;
    const tips = { api: git(join(root, 'api'), 'rev-parse', api.integrationBranch), web: git(join(root, 'web'), 'rev-parse', web.integrationBranch) };

    const result = await iso.revert(run, [t.id], { ...nothingInTheWay, persist: () => git(join(root, '.ordewell', 'worktrees', run.id, 'integration', 'web'), 'checkout', '-q', '-B', 'review') });

    expect(result).toMatchObject({ outcome: 'failed', repo: 'web' });
    expect(git(join(root, 'api'), 'rev-parse', api.integrationBranch)).toBe(tips.api);
    expect(git(join(root, 'web'), 'rev-parse', web.integrationBranch)).toBe(tips.web);
    expect(run.tasks[t.id].status).toBe('merged');
    expect(run.landing).toBeUndefined();
  });
});
