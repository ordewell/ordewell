import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { IsolationRun, IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

/**
 * ADR-0054: "Each is `git revert -m 1` of a merge that landed the task." A
 * landing commits wherever the run's integration worktree has HEAD, so it
 * refuses to merge with the worktree off the integration branch, and records
 * only the merge it can read off the branch: anything else called its landing
 * would have a later revert take another task's work.
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
function tempDir(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-r4l-'))); temps.push(dir); return dir; }
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
function task(order: number, title: string): Task {
  return { id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' };
}
function isolation(repos?: string[]): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true, ...(repos ? { workspaceRepos: repos } : {}) }) });
}
async function worked(iso: IWorktreeIsolation, run: IsolationRun, t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
}
async function land(iso: IWorktreeIsolation, run: IsolationRun, t: Task, files: Record<string, string>): Promise<void> {
  await worked(iso, run, t, files);
  expect(await iso.integrate(t, run)).toBe('merged');
}
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };
const treeOf = (root: string, branch: string) => git(root, 'ls-tree', '--name-only', branch).split('\n').filter(Boolean).sort();

describe('a landing with the integration worktree off the integration branch', () => {
  async function firstLanded() {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const first = task(1, 'Add greeting');
    await land(iso, run, first, { 'greeting.txt': 'hi\n' });
    const firstLanding = git(root, 'rev-parse', integration);
    const dir = join(root, '.ordewell', 'worktrees', run.id, 'integration');
    return { root, iso, run, integration, first, firstLanding, dir };
  }

  it.each([
    ['on a review branch', 'on review', (dir: string) => git(dir, 'checkout', '-q', '-b', 'review')],
    ['detached', 'detached', (dir: string) => git(dir, 'checkout', '-q', '--detach')],
  ])('fails %s, naming where, merges nothing and records nothing', async (_name, where, move) => {
    const { root, iso, run, integration, firstLanding, dir } = await firstLanded();
    move(dir);
    const atHead = git(dir, 'rev-parse', 'HEAD');

    const second = task(2, 'Add farewell');
    await worked(iso, run, second, { 'farewell.txt': 'bye\n' });
    expect(await iso.integrate(second, run)).toBe('failed');

    expect(run.tasks[second.id].landingError).toContain(`${dir} is ${where}`);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(atHead);
    expect(git(root, 'rev-parse', integration)).toBe(firstLanding);
    expect(run.landings?.[second.id]).toBeUndefined();
    expect(run.tasks[second.id].repos['.'].landedTip).toBeUndefined();
    expect(run.landing).toBeUndefined();
  });

  it('lands once the branch is checked out there again, so a revert of it takes only its own work', async () => {
    const { root, iso, run, integration, first, firstLanding, dir } = await firstLanded();
    git(dir, 'checkout', '-q', '-b', 'review');

    const second = task(2, 'Add farewell');
    await worked(iso, run, second, { 'farewell.txt': 'bye\n' });
    expect(await iso.integrate(second, run)).toBe('failed');
    // Nothing landed, so there is nothing a revert could take, and above all not the first task's merge.
    expect(await iso.revert(run, [second.id], nothingInTheWay)).toMatchObject({ outcome: 'refused' });
    expect(git(root, 'rev-parse', integration)).toBe(firstLanding);

    git(dir, 'checkout', '-q', integration);
    expect(await iso.integrate(second, run)).toBe('merged');
    const secondLanding = git(root, 'rev-parse', integration);
    expect(secondLanding).not.toBe(firstLanding);
    expect(run.landings?.[second.id]).toEqual({ '.': [secondLanding] });

    expect(await iso.revert(run, [second.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
    expect(treeOf(root, integration)).toEqual(['README.md', 'greeting.txt']);
    expect(run.tasks[first.id].status).toBe('merged');
  });

  it('records nothing when the merge goes elsewhere after it looked', async () => {
    const { root, iso, run, integration, firstLanding } = await firstLanded();
    // The merge's own commit follows HEAD to another branch, past the check made before it.
    const hook = join(root, '.git', 'hooks', 'pre-merge-commit');
    writeFileSync(hook, '#!/bin/sh\ngit update-ref refs/heads/review HEAD\ngit symbolic-ref HEAD refs/heads/review\n');
    chmodSync(hook, 0o755);

    const second = task(2, 'Add farewell');
    await worked(iso, run, second, { 'farewell.txt': 'bye\n' });
    expect(await iso.integrate(second, run)).toBe('failed');

    expect(run.tasks[second.id].landingError).toContain('did not reach the integration branch');
    expect(git(root, 'rev-parse', integration)).toBe(firstLanding);
    expect(treeOf(root, 'review')).toContain('farewell.txt');
    expect(run.landings?.[second.id]).toBeUndefined();
    expect(run.landing).toBeUndefined();
  });

  it('puts the other repo of a group back, so a task lands in every repo or none', async () => {
    const root = tempDir();
    initRepo(join(root, 'api'));
    initRepo(join(root, 'web'));
    const iso = isolation(['api', 'web']);
    const run = await iso.startRun(root);
    await land(iso, run, task(1, 'Add one'), { 'api/one.txt': '1\n', 'web/one.txt': '1\n' });
    const [api, web] = run.repos;
    const apiTip = git(join(root, 'api'), 'rev-parse', api.integrationBranch);
    git(join(root, '.ordewell', 'worktrees', run.id, 'integration', 'web'), 'checkout', '-q', '-b', 'review');

    const second = task(2, 'Add two');
    await worked(iso, run, second, { 'api/two.txt': '2\n', 'web/two.txt': '2\n' });
    expect(await iso.integrate(second, run)).toBe('failed');

    expect(run.tasks[second.id].conflictRepo).toBe('web');
    expect(git(join(root, 'api'), 'rev-parse', api.integrationBranch)).toBe(apiTip);
    expect(treeOf(join(root, 'web'), web.integrationBranch)).not.toContain('two.txt');
    expect(run.landings?.[second.id]).toBeUndefined();
  });
});

describe('a saved run that already holds a wrong landing', () => {
  it('refuses a revert of a merge two tasks are recorded as landed by, from either side and together', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const first = task(1, 'Add greeting');
    const second = task(2, 'Add farewell');
    await land(iso, run, first, { 'greeting.txt': 'hi\n' });
    const firstLanding = git(root, 'rev-parse', integration);
    await land(iso, run, second, { 'farewell.txt': 'bye\n' });
    // As a landing made off the branch saved it: the tip it read was the task before's.
    run.landings![second.id] = { '.': [firstLanding] };
    run.tasks[second.id].repos['.'].landedTip = firstLanding;
    const tip = git(root, 'rev-parse', integration);

    for (const ids of [[second.id], [first.id], [first.id, second.id]]) {
      const preview = await iso.readLanded(run, ids);
      expect(preview).toMatchObject({ ok: false, reason: 'no-own-merge', error: expect.stringContaining('the same merge') });
      expect(await iso.revert(run, ids, nothingInTheWay)).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('the same merge') });
    }
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(treeOf(root, integration)).toEqual(['README.md', 'farewell.txt', 'greeting.txt']);
  });
});
