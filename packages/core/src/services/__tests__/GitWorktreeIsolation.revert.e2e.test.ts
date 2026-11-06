// Part of GitWorktreeIsolation.revert.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: gitWorktreeRevertKit.ts

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { type GitExecFn } from '../GitWorktreeIsolation';
import { defaultExecFile, subcommandOf } from '../gitExec';
import type { Task } from '../../models/Task';
import { removeDir } from '../../testing';
import { taskIsolationsOf } from '../isolationRecord';
import { git, initRepo, temps, tempDir, task, isolation, land, nothingInTheWay } from './gitWorktreeRevertKit';

afterEach(async () => {
  while (temps.length) await removeDir(temps.pop()!);
});

describe('reverting a landed task', () => {
  it('adds a revert commit on the integration branch and lets go of the record', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const first = task(1, 'Add greeting');
    const second = task(2, 'Add farewell');
    await land(iso, run, first, { 'greeting.txt': 'hi\n' });
    await land(iso, run, second, { 'farewell.txt': 'bye\n' });
    const landed = git(root, 'rev-parse', integration);

    const result = await iso.revert(run, [first.id], nothingInTheWay);

    expect(result).toEqual({ outcome: 'reverted', tasks: [{ taskId: first.id, order: 1, title: 'Add greeting', repos: ['.'] }] });
    // Added to, never rewritten: the landing is still in the branch's history.
    expect(git(root, 'rev-parse', `${integration}~1`)).toBe(landed);
    expect(git(root, 'log', '-1', '--format=%s', integration)).toBe('Revert: Add greeting');
    expect(git(root, 'ls-tree', '--name-only', integration).split('\n')).toEqual(['README.md', 'farewell.txt']);
    expect(run.tasks[first.id]).toBeUndefined();
    expect(run.tasks[second.id].status).toBe('merged');
    expect(run.landing).toBeUndefined();
  });

  it('reverts a task with what landed on top of it, newest landing first, whatever order it is asked in', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const base = task(1, 'Write the file');
    const onTop = task(2, 'Extend the file');
    const nearby = task(3, 'Unrelated file');
    await land(iso, run, base, { 'shared.txt': 'one\n' });
    await land(iso, run, onTop, { 'shared.txt': 'one\ntwo\n' });
    await land(iso, run, nearby, { 'other.txt': 'other\n' });

    const result = await iso.revert(run, [base.id, onTop.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: onTop.id }, { taskId: base.id }] });
    expect(git(root, 'log', '-2', '--format=%s', integration).split('\n')).toEqual(['Revert: Write the file', 'Revert: Extend the file']);
    expect(git(root, 'ls-tree', '--name-only', integration).split('\n')).toEqual(['README.md', 'other.txt']);
  });

  it('stops on a conflict with the integration branch exactly as it was, and says which task and files', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const wrong = task(1, 'Change the line');
    const later = task(2, 'Change it again');
    await land(iso, run, wrong, { 'shared.txt': 'wrong\n' });
    await land(iso, run, later, { 'shared.txt': 'later\n' });
    const tip = git(root, 'rev-parse', integration);
    const worktree = join(root, '.ordewell', 'worktrees', run.id, 'integration');

    const result = await iso.revert(run, [wrong.id], nothingInTheWay);

    expect(result).toEqual({ outcome: 'conflict', task: { taskId: wrong.id, order: 1, title: 'Change the line' }, repo: '.', files: ['shared.txt'] });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(run.tasks[wrong.id].status).toBe('merged');
    expect(run.landing).toBeUndefined();
    // Nothing of it stays in the checkout landings merge in.
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    await land(iso, run, task(3, 'Still lands'), { 'next.txt': 'next\n' });
  });

  it('puts every revert of the set back when a later one conflicts', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const wrong = task(1, 'Change the line');
    const between = task(2, 'Change it again');
    const clean = task(3, 'Add a file');
    await land(iso, run, wrong, { 'shared.txt': 'wrong\n' });
    await land(iso, run, between, { 'shared.txt': 'between\n' });
    await land(iso, run, clean, { 'new.txt': 'new\n' });
    const tip = git(root, 'rev-parse', integration);

    const result = await iso.revert(run, [clean.id, wrong.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'conflict', task: { taskId: wrong.id } });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(git(root, 'show', `${integration}:new.txt`)).toBe('new');
    expect(run.tasks[clean.id].status).toBe('merged');
  });
});
describe('what a surface offers', () => {
  it('marks landed work with a merge of its own until it is in the user\'s branch', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });

    expect(taskIsolationsOf(run)[t.id]).toMatchObject({ state: 'integrated', revertible: true });

    await iso.mergeIntoCheckedOut(run);
    await iso.findInHead(run);
    expect(taskIsolationsOf(run)[t.id]).not.toHaveProperty('revertible');
  });

  it('does not mark a task that landed nothing', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = task(1, 'Change nothing');
    await iso.prepare(t, run);
    expect(await iso.integrate(t, run)).toBe('merged');

    expect(taskIsolationsOf(run)[t.id]).not.toHaveProperty('revertible');
  });
});
describe('a revert across a repo group', () => {
  function group() {
    const root = tempDir();
    initRepo(join(root, 'api'));
    initRepo(join(root, 'web'));
    return root;
  }

  it('reverts in every repo the task changed, and only those', async () => {
    const root = group();
    const iso = isolation();
    const run = await iso.startRun(root);
    const [api, web] = run.repos;
    const both = task(1, 'Touch both');
    const apiOnly = task(2, 'Touch api');
    await land(iso, run, both, { 'api/both.txt': 'a\n', 'web/both.txt': 'w\n' });
    await land(iso, run, apiOnly, { 'api/only.txt': 'a\n' });
    const webBefore = git(web.root, 'rev-parse', web.integrationBranch);

    const result = await iso.revert(run, [apiOnly.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: apiOnly.id, repos: ['api'] }] });
    expect(git(web.root, 'rev-parse', web.integrationBranch)).toBe(webBefore);
    expect(git(api.root, 'ls-tree', '--name-only', api.integrationBranch).split('\n')).toEqual(['README.md', 'both.txt']);

    expect(await iso.revert(run, [both.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: both.id, repos: ['api', 'web'] }] });
    expect(git(api.root, 'ls-tree', '--name-only', api.integrationBranch)).toBe('README.md');
    expect(git(web.root, 'ls-tree', '--name-only', web.integrationBranch)).toBe('README.md');
  });

  it('puts the first repository back when the second one fails', async () => {
    const root = group();
    let refuseIn = '';
    const exec: GitExecFn = (file, args, opts) => (subcommandOf(args) === 'commit-tree' && opts.cwd === refuseIn
      ? Promise.reject(Object.assign(new Error('refused here'), { stderr: 'refused here', code: 1 }))
      : defaultExecFile(file, args, opts));
    const iso = isolation({ execFileImpl: exec });
    const run = await iso.startRun(root);
    const [api, web] = run.repos;
    const both = task(1, 'Touch both');
    await land(iso, run, both, { 'api/both.txt': 'a\n', 'web/both.txt': 'w\n' });
    const tips = [git(api.root, 'rev-parse', api.integrationBranch), git(web.root, 'rev-parse', web.integrationBranch)];
    refuseIn = web.root;

    const result = await iso.revert(run, [both.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'failed', task: { taskId: both.id }, repo: 'web', error: expect.stringContaining('refused here') });
    expect([git(api.root, 'rev-parse', api.integrationBranch), git(web.root, 'rev-parse', web.integrationBranch)]).toEqual(tips);
    expect(run.tasks[both.id].status).toBe('merged');
    expect(run.landing).toBeUndefined();
  });

  it('names the repo that conflicted', async () => {
    const root = tempDir();
    initRepo(join(root, 'api'));
    initRepo(join(root, 'web'), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const wrong = task(1, 'Touch both');
    await land(iso, run, wrong, { 'api/new.txt': 'a\n', 'web/shared.txt': 'wrong\n' });
    await land(iso, run, task(2, 'Change it again'), { 'web/shared.txt': 'later\n' });
    const [api] = run.repos;
    const tip = git(api.root, 'rev-parse', api.integrationBranch);

    const result = await iso.revert(run, [wrong.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'conflict', repo: 'web', files: ['shared.txt'] });
    expect(git(api.root, 'rev-parse', api.integrationBranch)).toBe(tip);
  });
});
describe('work already in the user\'s branch', () => {
  it('is refused, with the exact command, and nothing is written', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const merged = task(1, 'Add greeting');
    await land(iso, run, merged, { 'greeting.txt': 'hi\n' });
    const merge = git(root, 'rev-parse', integration);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    const [head, tip] = [git(root, 'rev-parse', 'HEAD'), git(root, 'rev-parse', integration)];

    const result = await iso.revert(run, [merged.id], nothingInTheWay);

    expect(result).toEqual({
      outcome: 'in-branch',
      commands: [{ task: { taskId: merged.id, order: 1, title: 'Add greeting' }, repo: '.', commit: merge, command: `git revert -m 1 ${merge}`, heldBy: ['main'], merged: true }],
    });
    expect([git(root, 'rev-parse', 'HEAD'), git(root, 'rev-parse', integration)]).toEqual([head, tip]);
    expect(run.tasks[merged.id].status).toBe('merged');
    // The command is what it says it is: run by hand, it takes the work out.
    git(root, 'revert', '--no-edit', '-m', '1', merge);
    expect(existsSync(join(root, 'greeting.txt'))).toBe(false);
  });

  it('names the repo in a group, and every task of the set in the user\'s branch, newest first', async () => {
    const root = tempDir();
    initRepo(join(root, 'api'));
    initRepo(join(root, 'web'));
    const iso = isolation();
    const run = await iso.startRun(root);
    const base = task(1, 'Touch api');
    const onTop = task(2, 'Touch api again');
    await land(iso, run, base, { 'api/one.txt': '1\n' });
    await land(iso, run, onTop, { 'api/two.txt': '2\n' });
    const api = run.repos[0];
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

    const read = await iso.readLanded(run, [base.id, onTop.id]);

    const merge = (t: Task) => run.tasks[t.id].repos.api.landedTip!;
    expect(read).toMatchObject({ ok: true, inBranch: [
      { task: { taskId: onTop.id }, repo: 'api', commit: merge(onTop), command: `git -C api revert -m 1 ${merge(onTop)}` },
      { task: { taskId: base.id }, repo: 'api', commit: merge(base), command: `git -C api revert -m 1 ${merge(base)}` },
    ] });
    expect(git(api.root, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });
});
describe('after a revert', () => {
  it('starts a retry from a tip without the work, and lands it again', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'wrong\n' });
    await iso.revert(run, [t.id], nothingInTheWay);
    const tip = git(root, 'rev-parse', integration);

    const { cwd } = await iso.prepare(t, run);

    expect(existsSync(join(cwd, 'greeting.txt'))).toBe(false);
    expect(run.tasks[t.id].repos['.'].baseRef).toBe(tip);
    writeFileSync(join(cwd, 'greeting.txt'), 'right\n');
    expect(await iso.integrate(t, run)).toBe('merged');
    expect(git(root, 'show', `${integration}:greeting.txt`)).toBe('right');
  });

  it('leaves it reverted when a task cut from a tip that held the work lands', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const wrong = task(1, 'Add greeting');
    const running = task(2, 'Keeps running');
    await land(iso, run, wrong, { 'greeting.txt': 'hi\n' });
    const { cwd } = await iso.prepare(running, run);
    expect(await iso.revert(run, [wrong.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    writeFileSync(join(cwd, 'other.txt'), 'other\n');
    expect(await iso.integrate(running, run)).toBe('merged');

    expect(git(root, 'ls-tree', '--name-only', integration).split('\n')).toEqual(['README.md', 'other.txt']);
  });

  it('is merged by Merge all as part of the branch, which brings nothing of the work', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const wrong = task(1, 'Add greeting');
    await land(iso, run, wrong, { 'greeting.txt': 'hi\n' });
    await land(iso, run, task(2, 'Add farewell'), { 'farewell.txt': 'bye\n' });
    await iso.revert(run, [wrong.id], nothingInTheWay);

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

    expect(existsSync(join(root, 'greeting.txt'))).toBe(false);
    expect(readFileSync(join(root, 'farewell.txt'), 'utf8')).toBe('bye\n');
  });

  it('skips the commit when a later landing already took the work out', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const empty = task(1, 'Nothing to undo');
    const { cwd } = await iso.prepare(empty, run);
    writeFileSync(join(cwd, 'file.txt'), 'x\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'add');
    git(cwd, 'rm', '-q', 'file.txt');
    git(cwd, 'commit', '-q', '-m', 'take it out again');
    expect(await iso.integrate(empty, run)).toBe('merged');
    const tip = git(root, 'rev-parse', integration);

    expect(await iso.revert(run, [empty.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(run.tasks[empty.id]).toBeUndefined();
  });
});
describe('a task that landed more than once', () => {
  it('reverts every landing of a task continued after it landed', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const { cwd } = await iso.prepare(t, run, 'restore');
    writeFileSync(join(cwd, 'more.txt'), 'more\n');
    expect(await iso.integrate(t, run)).toBe('merged');

    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(git(root, 'ls-tree', '--name-only', integration)).toBe('README.md');
    expect(git(root, 'log', '-2', '--format=%s', integration).split('\n')).toEqual(['Revert: Add greeting', 'Revert: Add greeting']);
  });

  it('reverts a landing whose record a retry dropped', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    await iso.release(run, t.id, { keep: false });
    await land(iso, run, t, { 'second.txt': 'again\n' });

    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(git(root, 'ls-tree', '--name-only', integration)).toBe('README.md');
  });

  it('names every landing in the commands for work in the user\'s branch, newest first', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const first = run.tasks[t.id].repos['.'].landedTip!;
    await land(iso, run, t, { 'second.txt': 'again\n' });
    const second = run.tasks[t.id].repos['.'].landedTip!;
    await iso.mergeIntoCheckedOut(run);

    const read = await iso.readLanded(run, [t.id]);

    expect(read).toMatchObject({ ok: true, inBranch: [{ commit: second }, { commit: first }] });
  });

  it('forgets them once reverted, so a landing after the retry is all a later revert undoes', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    await iso.revert(run, [t.id], nothingInTheWay);
    await land(iso, run, t, { 'greeting.txt': 'right\n' });
    const tip = git(root, 'rev-parse', integration);

    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(git(root, 'rev-list', '--count', `${tip}..${integration}`)).toBe('1');
    expect(git(root, 'ls-tree', '--name-only', integration)).toBe('README.md');
  });
});
