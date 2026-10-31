import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { IsolationRun, IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

/**
 * Probes of the four #12 fixes from outside, and of the paths they touched:
 * handoff removes the integration worktrees a revert needs, a no-op retry over
 * a group landing is read per repo, and a crash rollback is held to each repo's
 * own revert count.
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-r4-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
function task(order: number, title: string, dependencies: string[] = []): Task {
  return { id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies, subtasks: [], assignedRunner: 'claude-code' };
}
const group = () => { const root = tempDir(); initRepo(join(root, 'api')); initRepo(join(root, 'web')); return root; };
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

describe('REGRESSION: a revert after handoff', () => {
  it('reverts a single repo with no integration worktree, and makes none', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const integration = run.repos[0].integrationBranch;
    expect(git(root, 'worktree', 'list', '--porcelain')).toContain('integration');
    await iso.handoff(run);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('integration');
    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
    expect(treeOf(root, integration)).toEqual(['README.md']);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('integration');
  });

  it('leaves the branch alone if someone checks it out after it looked', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const integration = run.repos[0].integrationBranch;
    await iso.handoff(run);
    const tip = git(root, 'rev-parse', integration);

    const result = await iso.revert(run, [t.id], { ...nothingInTheWay, persist: () => git(root, 'checkout', '-q', integration) });

    expect(result).toMatchObject({ outcome: 'failed', repo: '.' });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(git(root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(run.landing).toBeUndefined();
  });

  it('reverts both repos of a group after handoff', async () => {
    const root = group();
    const iso = isolation(['api', 'web']);
    const run = await iso.startRun(root);
    const t = task(1, 'Touch both');
    await land(iso, run, t, { 'api/one.txt': '1\n', 'web/one.txt': '1\n' });
    await iso.handoff(run);
    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
    expect(treeOf(join(root, 'api'), run.repos[0].integrationBranch)).toEqual(['README.md']);
    expect(treeOf(join(root, 'web'), run.repos[1].integrationBranch)).toEqual(['README.md']);
  });
});

describe('REGRESSION: the no-op retry fix, per repo', () => {
  it('is not merged until every repo it landed in is merged into the base branch', async () => {
    const root = group();
    const iso = isolation(['api', 'web']);
    const run = await iso.startRun(root);
    const t = task(1, 'Touch both');
    await land(iso, run, t, { 'api/one.txt': '1\n', 'web/one.txt': '1\n' });
    // Retry that changes nothing: a new record with changed=false and the old landings.
    const again = await iso.prepare(t, run);
    expect(await iso.integrate(t, run)).toBe('merged');
    expect(run.tasks[t.id].repos['api'].changed).toBe(false);
    expect(run.tasks[t.id].repos['web'].changed).toBe(false);
    expect((await iso.readLanded(run, [t.id]))).toMatchObject({ ok: true, inBranch: [] });
    // Merge only api's integration branch into api's base branch.
    git(join(root, 'api'), 'merge', '--no-edit', run.repos[0].integrationBranch);
    expect(await iso.findInHead(run)).toEqual([]);
    expect(run.tasks[t.id].inHead).toBeUndefined();
    // And after the second, the task is merged.
    git(join(root, 'web'), 'merge', '--no-edit', run.repos[1].integrationBranch);
    expect(await iso.findInHead(run)).toEqual([t.id]);
    expect(run.tasks[t.id].inHead).toBe(true);
    void again;
  });
});

describe('REGRESSION: the per-repo rollback fix', () => {
  it('rolls back a repo that made its own reverts and keeps one that got an extra commit', async () => {
    const root = group();
    const iso = isolation(['api', 'web']);
    const run = await iso.startRun(root);
    const [api, web] = run.repos;
    const first = task(1, 'Touch both');
    const second = task(2, 'Touch web again');
    await land(iso, run, first, { 'api/one.txt': '1\n', 'web/one.txt': '1\n' });
    await land(iso, run, second, { 'web/two.txt': '2\n' });
    const webTip = git(root, '-C', 'web', 'rev-parse', web.integrationBranch);
    const saved = structuredClone(run);
    await iso.revert(run, [first.id, second.id], { ...nothingInTheWay, persist: () => Object.assign(saved, structuredClone(run)) });
    // api made 1 revert, web 2: each repo is held to its own commits.
    expect(Object.values(saved.landing?.reverts ?? {}).map((r) => r.commits.length)).toEqual([1, 2]);
    // A crash after: api made its 1 revert and one extra plain commit follows.
    git(join(root, '.ordewell', 'worktrees', run.id, 'integration', 'api'), 'commit', '-q', '--allow-empty', '-m', 'mine');
    const apiMoved = git(root, '-C', 'api', 'rev-parse', api.integrationBranch);
    await isolation(['api', 'web']).pruneOrphans(saved);
    // api (1 revert + 1 user commit) is held; web (exactly its 2 reverts) is rolled back.
    expect(git(root, '-C', 'api', 'rev-parse', api.integrationBranch)).toBe(apiMoved);
    expect(saved.landing).toBeDefined();
    expect(git(root, '-C', 'web', 'rev-parse', web.integrationBranch)).toBe(webTip);
  });
});
