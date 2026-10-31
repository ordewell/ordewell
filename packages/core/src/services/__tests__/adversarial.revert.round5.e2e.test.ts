import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { IsolationRun, IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { revertScope } from '../taskRevert';

/**
 * ADR-0054: "All or nothing": a revert knows its commits by what it saved and
 * by the line they stand in, and "the rollback moves a branch only when what
 * sits on the tip is that revert's own commits": a count would take anyone's
 * commit for its own. Nor does it take in, or lose, what is uncommitted in the
 * integration worktree.
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
function tempDir(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-r5-'))); temps.push(dir); return dir; }
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
function task(order: number, title: string): Task {
  return { id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' };
}
function isolation(): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
}
async function land(iso: IWorktreeIsolation, run: IsolationRun, t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };

/** A commit on the branch from outside the queue, with the tree it already has and no worktree of its own. */
function plainCommitOn(root: string, branch: string, message: string): string {
  const parent = git(root, 'rev-parse', branch);
  const commit = git(root, 'commit-tree', `${branch}^{tree}`, '-p', parent, '-m', message);
  git(root, 'update-ref', `refs/heads/${branch}`, commit, parent);
  return commit;
}

async function landedRun() {
  const root = initRepo(tempDir());
  const iso = isolation();
  const run = await iso.startRun(root);
  const integration = run.repos[0].integrationBranch;
  const first = task(1, 'Add greeting');
  await land(iso, run, first, { 'greeting.txt': 'hi\n' });
  const dir = join(root, '.ordewell', 'worktrees', run.id, 'integration');
  return { root, iso, run, integration, first, dir, tip: git(root, 'rev-parse', integration) };
}

describe('what a revert takes for its own commits', () => {
  it('does not take a plain commit on the branch for the one it made elsewhere', async () => {
    const { root, iso, run, integration, first, dir } = await landedRun();
    let user = '';

    const result = await iso.revert(run, [first.id], {
      ...nothingInTheWay,
      persist: () => {
        if (user) return;
        git(dir, 'checkout', '-q', '-b', 'review');
        user = plainCommitOn(root, integration, 'user commit');
      },
    });

    expect(result).toMatchObject({ outcome: 'failed', repo: '.', error: expect.stringContaining(dir) });
    expect(git(root, 'rev-parse', integration)).toBe(user);
    expect(git(root, 'show', `${integration}:greeting.txt`)).toBe('hi');
    expect(run.tasks[first.id].status).toBe('merged');
    expect(run.landings?.[first.id]).toBeDefined();
    expect(run.reverted).toBeUndefined();
    expect(run.landing).toBeDefined();
  });

  it('stops at a plain commit that gets between its own, and leaves the branch to the user', async () => {
    const { root, iso, run, integration, first, dir } = await landedRun();
    const second = task(2, 'Add farewell');
    await land(iso, run, second, { 'farewell.txt': 'bye\n' });
    let saves = 0;

    const result = await iso.revert(run, [first.id, second.id], {
      ...nothingInTheWay,
      persist: () => { if (++saves === 2) git(dir, 'commit', '-q', '--allow-empty', '-m', 'mine'); },
    });

    expect(result).toMatchObject({ outcome: 'failed', repo: '.' });
    expect(git(root, 'log', '--format=%s', integration).split('\n')).toContain('mine');
    expect(run.tasks[first.id].status).toBe('merged');
    expect(run.tasks[second.id].status).toBe('merged');
    expect(run.reverted).toBeUndefined();
    expect(run.landing).toBeDefined();
  });

  it('does not roll a plain commit away in a crash rollback, whatever a count would allow', async () => {
    const { root, run, integration, first, tip } = await landedRun();
    run.landing = { taskId: first.id, tips: { '.': tip }, reverts: { '.': { commits: [] } } };
    const user = plainCommitOn(root, integration, 'user commit');

    await isolation().pruneOrphans(run);

    expect(git(root, 'rev-parse', integration)).toBe(user);
    expect(run.landing).toBeDefined();
  });

  it('does not roll a plain commit away that follows the commits it saved', async () => {
    const { root, iso, run, integration, first } = await landedRun();
    const saved = structuredClone(run);
    await iso.revert(run, [first.id], { ...nothingInTheWay, persist: () => Object.assign(saved, structuredClone(run)) });
    const user = plainCommitOn(root, integration, 'user commit');

    await isolation().pruneOrphans(saved);

    expect(git(root, 'rev-parse', integration)).toBe(user);
    expect(saved.landing).toBeDefined();
  });

  it('does not roll away a commit that only says it reverts the merge', async () => {
    const { root, run, integration, first, tip } = await landedRun();
    run.landing = { taskId: first.id, tips: { '.': tip }, reverts: { '.': { commits: [] } } };
    const user = plainCommitOn(root, integration, `This reverts the merge ${tip}, which landed it.`);

    await isolation().pruneOrphans(run);

    expect(git(root, 'rev-parse', integration)).toBe(user);
    expect(run.landing).toBeDefined();
  });
  it('does not move a branch that has fallen behind the tip it saved forward to it', async () => {
    const { root, iso, run, integration, dir, tip } = await landedRun();
    const second = task(2, 'Add farewell');
    await land(iso, run, second, { 'farewell.txt': 'bye\n' });
    const landedTip = git(root, 'rev-parse', integration);
    run.landing = { taskId: second.id, tips: { '.': landedTip }, reverts: { '.': { commits: [] } } };
    git(dir, 'reset', '-q', '--hard', tip);

    await isolation().pruneOrphans(run);

    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(run.landing).toBeDefined();
  });
});

describe('changes in the integration worktree', () => {
  it('leaves a staged change on another path staged, in the preview and the revert', async () => {
    const { root, iso, run, integration, first, dir } = await landedRun();
    writeFileSync(join(dir, 'README.md'), 'user staged\n');
    git(dir, 'add', 'README.md');

    expect(await iso.readLanded(run, [first.id])).toMatchObject({ ok: true });
    expect(await iso.revert(run, [first.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(git(root, 'show', `${integration}:README.md`)).toBe('hello');
    expect(git(dir, 'show', ':README.md')).toBe('user staged');
    expect(git(dir, 'status', '--porcelain')).toBe('M  README.md');
    expect(existsSync(join(dir, 'greeting.txt'))).toBe(false);
  });

  it('leaves a change not staged on another path as it is', async () => {
    const { root, iso, run, integration, first, dir } = await landedRun();
    writeFileSync(join(dir, 'README.md'), 'user unstaged\n');

    expect(await iso.revert(run, [first.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(git(root, 'ls-tree', '--name-only', integration)).toBe('README.md');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('user unstaged\n');
  });

  it.each([
    ['staged', true],
    ['not staged', false],
  ])('fails over a change %s on a path the revert touches, naming it, and puts the branch back', async (_name, staged) => {
    const { root, iso, run, integration, first, dir, tip } = await landedRun();
    writeFileSync(join(dir, 'greeting.txt'), 'the user\'s\n');
    if (staged) git(dir, 'add', 'greeting.txt');

    const result = await iso.revert(run, [first.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'failed', task: { taskId: first.id }, error: expect.stringContaining('greeting.txt') });
    expect(result).toMatchObject({ error: expect.stringContaining(dir) });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(readFileSync(join(dir, 'greeting.txt'), 'utf8')).toBe('the user\'s\n');
    expect(run.landing).toBeUndefined();
    expect(run.tasks[first.id].status).toBe('merged');
  });

  it('is not stopped by an untracked file, which goes in no commit', async () => {
    const { root, iso, run, integration, first, dir } = await landedRun();
    writeFileSync(join(dir, 'notes.txt'), 'mine\n');

    expect(await iso.revert(run, [first.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(git(root, 'ls-tree', '--name-only', integration)).toBe('README.md');
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('mine\n');
  });
});

describe('a landed dependent that left the plan', () => {
  it('goes with the task, so nothing of it stays on the branch', async () => {
    const { root, iso, run, integration, first } = await landedRun();
    const gone = task(2, 'Add farewell');
    await land(iso, run, gone, { 'farewell.txt': 'bye\n' });
    run.landedOn = { [gone.id]: [first.id] };

    const scope = revertScope(first.id, { tasks: [first], run, live: new Set(), resolvers: () => [] });
    expect(scope).toEqual({ taskIds: [first.id, gone.id] });
    const result = await iso.revert(run, scope.taskIds, nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: gone.id }, { taskId: first.id }] });
    expect(git(root, 'ls-tree', '--name-only', integration)).toBe('README.md');
    expect(run.landings?.[gone.id]).toBeUndefined();
    expect(run.landedOn?.[gone.id]).toBeUndefined();
  });
});
