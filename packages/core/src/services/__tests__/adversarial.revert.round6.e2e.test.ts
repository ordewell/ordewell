import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import type { IsolationRun, IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { IRunner } from '../../interfaces/IRunner';
import { createTask, type Task } from '../../models/Task';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';

/**
 * ADR-0054: "Merged means ... the user's branch contains every merge that
 * landed the task, whatever the current record changed", and a throwaway
 * checkout of the integration tip is a review, not the user's branch. A
 * retry (or a continue) lands a task again under a new record, and the record
 * the `inHead` flag was saved on goes with the old one; the merge the user
 * already merged is still in their branch, so the revert must still refuse it
 * and print its command. Reverting it again would let a later Merge all take
 * work out of the user's branch, which Ordewell never writes to.
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
function tempDir(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-r6-'))); temps.push(dir); return dir; }
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

describe('a landing found merged, whose record a later attempt replaced', () => {
  it('is still work in the user\'s branch, and is not re-reverted from another checkout', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const base = run.repos[0].baseRef;
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    const firstMerge = git(root, 'rev-parse', integration);

    // The user pressed Merge all while the run went on: the work is theirs now.
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(await iso.findInHead(run)).toEqual([landed.id]);
    expect(run.tasks[landed.id].inHead).toBe(true);

    // They carry on elsewhere, on a branch cut before that merge.
    git(root, 'checkout', '-q', '-b', 'elsewhere', base);

    // A retry (Mark not done, then Retry, or a Continue) lands the task again:
    // `prepare` drops the record the flag was on and starts a new one from the
    // current tip, which then lands a merge of its own.
    await land(iso, run, landed, { 'second.txt': 'again\n' });
    expect(git(root, 'ls-tree', '--name-only', 'main').split('\n')).toContain('greeting.txt');

    expect(await iso.readLanded(run, [landed.id])).toMatchObject({
      ok: true,
      inBranch: [{ task: { taskId: landed.id }, repo: '.', commit: firstMerge }],
    });
    expect(await iso.revert(run, [landed.id], nothingInTheWay)).toMatchObject({ outcome: 'in-branch' });

    // What Merge all would bring next leaves the work the user already merged.
    git(root, 'checkout', '-q', 'main');
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(git(root, 'ls-tree', '--name-only', 'main').split('\n')).toContain('greeting.txt');
  });
});

describe('whether a landing reached the user\'s branch', () => {
  const landed = () => task(1, 'Add greeting');
  async function oneLanding() {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = landed();
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    return { root, iso, run, t, integration: run.repos[0].integrationBranch, base: run.repos[0].baseRef, merge: git(root, 'rev-parse', run.repos[0].integrationBranch) };
  }

  it('is git\'s answer for a branch merged by hand that the user has left, with nothing saved about it', async () => {
    const { root, iso, run, t, integration, merge } = await oneLanding();
    git(root, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(root, 'mine.txt'), 'mine\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'mine');
    git(root, 'merge', '-q', '--no-ff', '--no-edit', integration);
    git(root, 'checkout', '-q', 'main');

    expect(run.tasks[t.id].inHead).toBeUndefined();
    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: true, inBranch: [{ commit: merge }] });
    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'in-branch' });
  });

  it('follows the branch back: a merge the user took out again can be reverted, whatever was saved', async () => {
    const { root, iso, run, t, base } = await oneLanding();
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    await iso.findInHead(run);
    expect(run.tasks[t.id].inHead).toBe(true);

    git(root, 'reset', '-q', '--hard', base);

    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: true, inBranch: [] });
    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
  });

  it('is not a branch cut from the integration tip, checked out or not, though that stops a revert until it goes', async () => {
    const { root, iso, run, t, integration } = await oneLanding();
    git(root, 'branch', 'review', integration);
    git(root, 'checkout', '-q', '-b', 'reading', integration);
    git(root, 'checkout', '-q', 'main');

    expect(await iso.findInHead(run)).toEqual([]);
    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: true, inBranch: [{ heldBy: ['reading', 'review'], merged: false }] });

    git(root, 'branch', '-D', 'reading', 'review');
    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: true, inBranch: [] });
  });

  it('is not one of Ordewell\'s own branches, whatever they merged', async () => {
    const { root, iso, run, t, integration, base } = await oneLanding();
    git(root, 'branch', `ordewell/${run.id}/another`, base);
    git(root, 'checkout', '-q', `ordewell/${run.id}/another`);
    writeFileSync(join(root, 'other.txt'), 'other\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'other');
    git(root, 'merge', '-q', '--no-ff', '--no-edit', integration);
    git(root, 'checkout', '-q', 'main');

    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: true, inBranch: [] });
  });

  it('is the first-parent line of a detached HEAD where the run has no base branch', async () => {
    const root = initRepo(tempDir());
    git(root, 'checkout', '-q', '--detach');
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = landed();
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const merge = git(root, 'rev-parse', run.repos[0].integrationBranch);
    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: true, inBranch: [] });

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: true, inBranch: [{ commit: merge }] });

    // A branch cut from there holds the same merge, off its line, once HEAD has left it.
    git(root, 'branch', 'kept');
    git(root, 'checkout', '-q', 'main');
    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: true, inBranch: [{ commit: merge }] });
  });
});

describe('a change staged between two revert commits', () => {
  it('does not ride into the next revert commit, or into a rollback', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const first = task(1, 'Add one');
    const second = task(2, 'Add two');
    await land(iso, run, first, { 'one.txt': '1\n' });
    await land(iso, run, second, { 'two.txt': '2\n' });
    const dir = join(root, '.ordewell', 'worktrees', run.id, 'integration');
    const tip = git(root, 'rev-parse', integration);
    let staged = false;

    // Each commit is built from its parent, so the index is in none of them.
    const result = await iso.revert(run, [first.id, second.id], {
      ...nothingInTheWay,
      persist: () => {
        if ((run.landing?.reverts?.['.']?.commits.length ?? 0) !== 1 || staged) return;
        staged = true;
        writeFileSync(join(dir, 'README.md'), 'user staged mid-revert\n');
        git(dir, 'add', 'README.md');
      },
    });

    expect(result).toMatchObject({ outcome: 'reverted' });
    expect(git(root, 'show', `${integration}:README.md`)).toBe('hello');
    expect(git(root, 'rev-parse', integration)).not.toBe(tip);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('README.md');
    expect(git(dir, 'show', ':README.md')).toBe('user staged mid-revert');
  });

  it('holds the branch rather than lose a change to a file the rollback has to put back', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const first = task(1, 'Add one');
    const second = task(2, 'Add two');
    await land(iso, run, first, { 'one.txt': '1\n' });
    await land(iso, run, second, { 'two.txt': '2\n' });
    const dir = join(root, '.ordewell', 'worktrees', run.id, 'integration');
    const tip = git(root, 'rev-parse', integration);

    // The newest goes first, so `two.txt` has left the tree by the second commit,
    // and judged again at the end the revert is refused and has to roll back.
    let judged = 0;
    const result = await iso.revert(run, [first.id, second.id], {
      ...nothingInTheWay,
      refusal: () => (judged++ > 0 ? 'Another plan was loaded.' : null),
      persist: () => {
        if ((run.landing?.reverts?.['.']?.commits.length ?? 0) !== 2 || git(dir, 'diff', '--cached', '--name-only')) return;
        writeFileSync(join(dir, 'two.txt'), 'the user\'s two\n');
        git(dir, 'add', 'two.txt');
      },
    });

    expect(result).toMatchObject({ outcome: 'failed', error: expect.stringContaining('could not be put back') });
    expect(git(dir, 'show', ':two.txt')).toBe('the user\'s two');
    expect(run.landing).toBeDefined();
    expect(await iso.mergeIntoCheckedOut(run)).toMatchObject({ outcome: 'blocked' });

    // Cleared, the next turn takes the commits off and the branch is as it was.
    git(dir, 'rm', '-q', '--cached', 'two.txt');
    rmSync(join(dir, 'two.txt'));
    expect(await iso.readLanded(run, [first.id])).toMatchObject({ ok: true });
    expect(await iso.revert(run, [first.id, second.id], { ...nothingInTheWay, refusal: () => 'stop here' })).toMatchObject({ outcome: 'refused' });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(run.landing).toBeUndefined();
  });
});

/**
 * The same loss through the user's own controls, with the real pipeline:
 * Merge all while the run goes on, Mark not done, Retry/Force start (a new
 * record), then a revert from another checkout. The last Merge all must not
 * take the work the user merged first out of their branch.
 */
describe('the user\'s own steps after Merge all', () => {
  it('do not let a later revert and Merge all remove work already merged', async () => {
    const root = initRepo(tempDir());
    const isolation = createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' });
    const sessions: FakeRunnerSession[] = [];
    const attempts: Record<string, number> = {};
    const runner: IRunner = {
      spawn: vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
        const n = (attempts[opts.taskId] = (attempts[opts.taskId] ?? 0) + 1);
        const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
        sessions.push(session);
        setTimeout(() => {
          if (opts.taskId === 't1') {
            writeFileSync(join(opts.cwd!, n === 1 ? 'one.txt' : 'third.txt'), `by t1 ${n}\n`);
            session.reportComplete({ status: 'done', summary: '' });
          } else {
            writeFileSync(join(opts.cwd!, 'two.txt'), 't2\n');
            // Keeps the run open while the user presses Merge all; it never reports.
          }
        }, 5);
        return session;
      }),
      stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
    };
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig({ maxParallelSessions: 2 }), notifications: fakeNotification(),
      runner, output: new BufferedTaskOutputSource(), isolation, workspaceRoot: () => root,
    });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'One', prompt: 'write one' }),
      createTask({ id: 't2', order: 2, title: 'Two', prompt: 'write two' }),
    ]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'), { timeout: 20000 });
    await vi.waitFor(() => expect(orchestrator.getAttempt('t2')?.phase).toBe('running'), { timeout: 20000 });

    expect(await orchestrator.mergeRun()).toEqual({ outcome: 'merged' });
    const run = orchestrator.runs.current!;
    const base = run.repos[0].baseRef;
    expect(git(root, 'ls-tree', '--name-only', 'main').split('\n')).toContain('one.txt');

    // The user goes on with their own work elsewhere, then retries the task.
    git(root, 'checkout', '-q', '-b', 'elsewhere', base);
    await orchestrator.markTaskIncomplete('t1');
    await orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'), { timeout: 20000 });

    // The first merge is in the user's branch; the preview must say so.
    expect(await orchestrator.revertPreview('t1')).toMatchObject({ revertible: false, reason: 'in-branch' });
    expect(await orchestrator.revertTask('t1')).toMatchObject({ outcome: 'in-branch' });

    git(root, 'checkout', '-q', 'main');
    await orchestrator.mergeRun();
    expect(git(root, 'ls-tree', '--name-only', 'main').split('\n')).toContain('one.txt');
    orchestrator.stop();
  }, 60000);
});
