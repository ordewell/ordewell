// Part of GitWorktreeIsolation.revert.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: gitWorktreeRevertKit.ts

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { IsolationRun, IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import { removeDir } from '../../testing';
import { taskIsolationsOf } from '../isolationRecord';
import { revertScope } from '../taskRevert';
import { git, initRepo, temps, tempDir, task, isolation, land, nothingInTheWay } from './gitWorktreeRevertKit';

afterEach(async () => {
  while (temps.length) await removeDir(temps.pop()!);
});

describe('what stands in a revert\'s way', () => {
  it('names where the integration branch is checked out, before anything moves', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    await iso.handoff(run);
    git(root, 'checkout', '-q', integration);
    const tip = git(root, 'rev-parse', integration);

    const read = await iso.readLanded(run, [t.id]);
    const result = await iso.revert(run, [t.id], nothingInTheWay);

    const reason = `The integration branch is checked out in ${root}, and a revert has to commit to it. Check out another branch there first. Nothing was reverted.`;
    expect(read).toEqual({ ok: false, reason: 'checked-out', error: reason });
    expect(result).toEqual({ outcome: 'refused', reason });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(run.tasks[t.id].status).toBe('merged');
    expect(run.landing).toBeUndefined();
  });

  it('names another worktree that has the branch checked out, and not its own', async () => {
    const root = initRepo(tempDir());
    const review = join(tempDir(), 'review');
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: true });
    await iso.handoff(run);
    git(root, 'worktree', 'add', '-q', review, integration);

    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: false, reason: 'checked-out', error: expect.stringContaining(`checked out in ${realpathSync.native(review)}`) });
  });

  it('names the repo of a group whose branch is checked out', async () => {
    const root = tempDir();
    initRepo(join(root, 'api'));
    initRepo(join(root, 'web'));
    const iso = isolation();
    const run = await iso.startRun(root);
    const [api] = run.repos;
    const t = task(1, 'Touch both');
    await land(iso, run, t, { 'api/both.txt': 'a\n', 'web/both.txt': 'w\n' });
    await iso.handoff(run);
    git(api.root, 'checkout', '-q', api.integrationBranch);

    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: false, reason: 'checked-out', error: expect.stringContaining('integration branch of api is checked out') });
  });

  it('says a task that landed before its merges were kept cannot be told apart, in its own words', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const entry = run.tasks[t.id].repos['.'];
    delete run.landings;
    delete run.landedTasks;
    delete entry.landedTip;
    delete entry.taskTip;
    const tip = git(root, 'rev-parse', integration);

    expect(await iso.readLanded(run, [t.id])).toEqual({ ok: false, reason: 'no-own-merge', error: 'Task "Add greeting" landed before Ordewell kept a record of its merge, so it cannot tell which merge to revert. Nothing was reverted.' });
    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'refused' });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(taskIsolationsOf(run)[t.id]).not.toHaveProperty('revertible');
  });

  it('leaves a handed-over run free to check its branch out afterwards', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    await land(iso, run, task(2, 'Add farewell'), { 'farewell.txt': 'bye\n' });
    await iso.handoff(run);

    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    git(root, 'checkout', '-q', integration);
    expect(existsSync(join(root, 'greeting.txt'))).toBe(false);
  });

  it('keeps the integration worktree of a run still landing', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });

    await iso.revert(run, [t.id], nothingInTheWay);

    expect(existsSync(join(root, '.ordewell', 'worktrees', run.id, 'integration', '.git'))).toBe(true);
  });

  it('answers with no landed work left, rather than failing on nothing', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);

    expect(await iso.revert(run, ['gone'], nothingInTheWay)).toMatchObject({ outcome: 'refused' });
  });

  it('refuses work a resolver\'s merge brought in, whose landing no commit of its own can undo', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const first = task(1, 'Change the line');
    const conflicted = task(2, 'Change it too');
    const resolver = task(3, 'Resolve the conflict');
    await land(iso, run, first, { 'shared.txt': 'first\n' });
    // Cut before `first` landed in spirit: reset to the base so the landing conflicts.
    const { cwd } = await iso.prepare(conflicted, run);
    git(cwd, 'reset', '-q', '--hard', run.repos[0].baseRef);
    writeFileSync(join(cwd, 'shared.txt'), 'conflicted\n');
    expect(await iso.integrate(conflicted, run)).toBe('conflict');
    const branch = run.tasks[conflicted.id].branch;

    const resolving = await iso.prepare(resolver, run);
    expect(() => git(resolving.cwd, 'merge', '--no-ff', '--no-edit', branch)).toThrow();
    writeFileSync(join(resolving.cwd, 'shared.txt'), 'resolved\n');
    git(resolving.cwd, 'add', '-A');
    git(resolving.cwd, 'commit', '-q', '-m', 'Resolve');
    expect(await iso.integrate(resolver, run)).toBe('merged');
    expect(await iso.integrate(conflicted, run)).toBe('merged');

    expect(await iso.readLanded(run, [conflicted.id])).toMatchObject({ ok: false, reason: 'no-own-merge' });
    expect(await iso.readLanded(run, [resolver.id])).toMatchObject({ ok: false, reason: 'no-own-merge' });
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    expect(await iso.revert(run, [resolver.id], nothingInTheWay)).toMatchObject({ outcome: 'refused' });
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });
});
describe('work a resolver carried, after the carried task landed on its own', () => {
  /**
   * `conflicted` landed through `resolver`'s merge (so it has no merge of its
   * own for that work), then was retried and landed a merge of its own. That
   * second landing does not make the carried work revertible: the carried work
   * still has no merge of its own.
   */
  async function carriedAndLandedAgain(iso: IWorktreeIsolation, run: IsolationRun) {
    const first = task(1, 'First change');
    const conflicted = task(2, 'Conflicted change');
    const resolver = task(3, 'Resolve the conflict');
    await land(iso, run, first, { 'shared.txt': 'first\n' });
    const { cwd } = await iso.prepare(conflicted, run);
    git(cwd, 'reset', '-q', '--hard', run.repos[0].baseRef);
    writeFileSync(join(cwd, 'shared.txt'), 'conflicted\n');
    expect(await iso.integrate(conflicted, run)).toBe('conflict');
    const branch = run.tasks[conflicted.id].branch;
    const resolving = await iso.prepare(resolver, run);
    expect(() => git(resolving.cwd, 'merge', '--no-ff', '--no-edit', branch)).toThrow();
    writeFileSync(join(resolving.cwd, 'shared.txt'), 'resolved\n');
    git(resolving.cwd, 'add', '-A');
    git(resolving.cwd, 'commit', '-q', '-m', 'Resolve');
    expect(await iso.integrate(resolver, run)).toBe('merged');
    expect(await iso.integrate(conflicted, run)).toBe('merged');
    await land(iso, run, conflicted, { 'extra.txt': 'extra\n' });
    return { first, conflicted, resolver };
  }

  it('refuses reverting the carried task, rather than leaving the carried work behind', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const { conflicted } = await carriedAndLandedAgain(iso, run);

    const result = await iso.revert(run, [conflicted.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('no merge of its own') });
    expect(run.tasks[conflicted.id]?.status).toBe('merged');
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:shared.txt`)).toBe('resolved');
  });

  it('refuses reverting the resolver, rather than removing carried work under a record that still says landed', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const { conflicted, resolver } = await carriedAndLandedAgain(iso, run);

    const result = await iso.revert(run, [resolver.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('no merge of its own') });
    expect(run.tasks[conflicted.id]?.status).toBe('merged');
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:shared.txt`)).toBe('resolved');
  });

  it('offers no Revert on the carried task, which core would always refuse', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const { conflicted } = await carriedAndLandedAgain(iso, run);

    expect(run.landings?.[conflicted.id]).toBeDefined();
    expect(taskIsolationsOf(run)[conflicted.id]).toMatchObject({ state: 'integrated' });
    expect(taskIsolationsOf(run)[conflicted.id]).not.toHaveProperty('revertible');
  });
});
describe('a detached checkout of the integration tip is a review, not a merge', () => {
  it('marks nothing inHead, offers no in-branch command and keeps the branch on a clear-up', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    await iso.handoff(run);
    const tip = git(root, 'rev-parse', integration);
    git(root, 'checkout', '-q', '--detach', tip);

    expect(await iso.findInHead(run)).toEqual([]);
    expect(run.tasks[landed.id].inHead).toBeUndefined();
    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: true, inBranch: [] });

    // The branch is still there for the user's review checkout; a clear-up must
    // not read the detached tip as the user's branch and delete it.
    expect(git(root, 'branch', '--list', integration)).toContain(integration);
  });
});
describe('what a revert cannot be sure of', () => {
  /** `conflicted` goes in through `resolver`'s merge, and has not landed itself yet. */
  async function resolved(iso: IWorktreeIsolation, run: IsolationRun) {
    const first = task(1, 'First change');
    const conflicted = task(2, 'Conflicted change');
    const resolver = task(3, 'Resolve the conflict');
    await land(iso, run, first, { 'shared.txt': 'first\n' });
    const { cwd } = await iso.prepare(conflicted, run);
    git(cwd, 'reset', '-q', '--hard', run.repos[0].baseRef);
    writeFileSync(join(cwd, 'shared.txt'), 'conflicted\n');
    expect(await iso.integrate(conflicted, run)).toBe('conflict');
    const resolving = await iso.prepare(resolver, run);
    expect(() => git(resolving.cwd, 'merge', '--no-ff', '--no-edit', run.tasks[conflicted.id].branch)).toThrow();
    writeFileSync(join(resolving.cwd, 'shared.txt'), 'resolved\n');
    git(resolving.cwd, 'add', '-A');
    git(resolving.cwd, 'commit', '-q', '-m', 'Resolve');
    expect(await iso.integrate(resolver, run)).toBe('merged');
    return { first, conflicted, resolver };
  }

  it('refuses a resolver whose carried task has not landed yet, its record still a conflict', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const { conflicted, resolver } = await resolved(iso, run);
    expect(run.tasks[conflicted.id].status).toBe('conflict');
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);

    expect(await iso.revert(run, [resolver.id], nothingInTheWay)).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('no merge of its own') });
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });

  it('refuses both once the carried task\'s record is gone', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const { conflicted, resolver } = await resolved(iso, run);
    expect(await iso.integrate(conflicted, run)).toBe('merged');
    await iso.release(run, conflicted.id, { keep: false });
    expect(run.tasks[conflicted.id]).toBeUndefined();

    expect(await iso.revert(run, [resolver.id], nothingInTheWay)).toMatchObject({ outcome: 'refused', reason: expect.stringContaining(conflicted.title) });
    expect(await iso.revert(run, [conflicted.id], nothingInTheWay)).toMatchObject({ outcome: 'refused', reason: expect.stringContaining(conflicted.title) });
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:shared.txt`)).toBe('resolved');
  });

  it('takes a dependent carried work is part of into the scope, which refuses the whole revert', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const { first, conflicted, resolver } = await resolved(iso, run);
    await iso.release(run, conflicted.id, { keep: false });
    const dependent = { ...conflicted, dependencies: [first.id] };
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);

    const scope = revertScope(first.id, { tasks: [first, dependent, resolver], run, live: new Set(), resolvers: () => [] });

    expect(scope.taskIds).toContain(conflicted.id);
    expect(await iso.revert(run, scope.taskIds, nothingInTheWay)).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('no merge of its own') });
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });

  it('still reverts a task that merely landed after a resolver, none of whose work it carried', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const { conflicted } = await resolved(iso, run);
    expect(await iso.integrate(conflicted, run)).toBe('merged');
    const later = task(4, 'Later change');
    await land(iso, run, later, { 'later.txt': 'later\n' });

    expect(await iso.revert(run, [later.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
  });

  it('refuses a dependent of a run from before every merge was kept, whose current attempt says nothing of an earlier one', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    delete run.keepsEveryLanding;
    const base = task(1, 'Add greeting');
    const dependent = { ...task(2, 'Add farewell'), dependencies: [base.id], attempted: true as const };
    await land(iso, run, base, { 'greeting.txt': 'hi\n' });
    await land(iso, run, dependent, { 'farewell.txt': 'bye\n' });
    delete run.landings;
    delete run.landedTasks;
    await iso.prepare(dependent, run);
    expect(run.tasks[dependent.id].status).toBe('active');
    run.tasks[dependent.id].status = 'failed';

    expect(revertScope(base.id, { tasks: [base, dependent], run, live: new Set(), resolvers: () => [] }).refusal).toMatchObject({
      reason: 'no-own-merge', message: expect.stringContaining('"Add farewell"'),
    });
  });
});
describe('a checkout that holds the work with no merge of it', () => {
  async function landedOne(startDetached = false) {
    const root = initRepo(tempDir());
    if (startDetached) git(root, 'checkout', '-q', '--detach');
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    await iso.handoff(run);
    return { root, iso, run, landed, integration: run.repos[0].integrationBranch };
  }

  it('lets no clear-up delete the integration branch under a detached review', async () => {
    const { root, iso, run, integration } = await landedOne();
    git(root, 'checkout', '-q', '--detach', integration);

    await iso.discard(run, { integration: 'delete-merged' });

    expect(git(root, 'branch', '--list', integration)).toContain(integration);
  });

  it('counts a branch cut from the integration branch as no merge, with commits of its own or not, though it stops a revert', async () => {
    const { root, iso, run, landed, integration } = await landedOne();
    git(root, 'checkout', '-q', '-b', 'review', integration);
    git(root, 'commit', '-q', '--allow-empty', '-m', 'A note of the reviewer');

    expect(await iso.findInHead(run)).toEqual([]);
    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: true, inBranch: [{ heldBy: ['review'], merged: false }] });
    await iso.discard(run, { integration: 'delete-merged' });
    expect(git(root, 'branch', '--list', integration)).toContain(integration);
  });

  it('counts a review on a run that started detached as no merge', async () => {
    const { root, iso, run, landed, integration } = await landedOne(true);
    git(root, 'checkout', '-q', '--detach', integration);

    expect(await iso.findInHead(run)).toEqual([]);
    expect(run.tasks[landed.id].inHead).toBeUndefined();
    await iso.discard(run, { integration: 'delete-merged' });
    expect(git(root, 'branch', '--list', integration)).toContain(integration);
  });

  it('still reads Merge all on a run that started detached as a merge, which a review is told from by its commit', async () => {
    const { root, iso, run, landed, integration } = await landedOne(true);

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(git(root, 'log', '-1', '--format=%s')).toBe('Merge: Add greeting');

    expect(await iso.findInHead(run)).toEqual([landed.id]);
    await iso.discard(run, { integration: 'delete-merged' });
    expect(git(root, 'branch', '--list', integration)).toBe('');
  });

  it('reads a hand merge into another branch as not merged, and it still stops a revert', async () => {
    const { root, iso, run, landed, integration } = await landedOne();
    git(root, 'checkout', '-q', '-b', 'feature', 'main');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'Work of the user');
    git(root, 'merge', '-q', '--no-edit', integration);

    expect(await iso.findInHead(run)).toEqual([]);
    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: true, inBranch: [{ heldBy: ['feature'], merged: false }] });
    await iso.discard(run, { integration: 'delete-merged' });
    expect(git(root, 'branch', '--list', integration)).toContain(integration);
  });

  it('still reads a fast-forward of the branch the run started on as a merge', async () => {
    const { root, iso, run, landed, integration } = await landedOne();
    git(root, 'merge', '-q', '--ff-only', integration);

    expect(await iso.findInHead(run)).toEqual([landed.id]);
  });

  it('lets the branch the run started on speak for a detached HEAD on it', async () => {
    const { root, iso, run, landed, integration } = await landedOne();
    git(root, 'merge', '-q', '--ff-only', integration);
    git(root, 'checkout', '-q', '--detach');

    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: true, inBranch: [{ repo: '.' }] });
  });
});
