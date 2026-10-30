import { describe, it, expect, afterEach } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation, type GitExecFn, type WorktreeIsolationDeps } from '../GitWorktreeIsolation';
import { subcommandOf } from '../gitExec';
import type { IsolationRun, IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { taskIsolationOf } from '../isolationRecord';

// A git hook that runs the suite exports GIT_DIR & co., which would point every
// fixture command at the outer repository instead of the temp one.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(root: string, files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

const temps: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-revert-')));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function task(order: number, title: string): Task {
  return { id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' };
}

function isolation(deps: Partial<WorktreeIsolationDeps> = {}): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), ...deps });
}

/** Land a task that writes `files`, in each of the repos it names. */
async function land(iso: IWorktreeIsolation, run: IsolationRun, t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}

/** A revert with nothing in its way, as the controller asks for it. */
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };

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

    expect(taskIsolationOf(run.tasks[t.id])).toMatchObject({ state: 'integrated', revertible: true });

    await iso.mergeIntoCheckedOut(run);
    await iso.findInHead(run);
    expect(taskIsolationOf(run.tasks[t.id])).not.toHaveProperty('revertible');
  });

  it('does not mark a task that landed nothing', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = task(1, 'Change nothing');
    await iso.prepare(t, run);
    expect(await iso.integrate(t, run)).toBe('merged');

    expect(taskIsolationOf(run.tasks[t.id])).not.toHaveProperty('revertible');
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
    const iso = isolation();
    const run = await iso.startRun(root);
    const [api, web] = run.repos;
    const both = task(1, 'Touch both');
    await land(iso, run, both, { 'api/both.txt': 'a\n', 'web/both.txt': 'w\n' });
    const tips = [git(api.root, 'rev-parse', api.integrationBranch), git(web.root, 'rev-parse', web.integrationBranch)];
    // Installed once the task has landed, so only the revert's commit meets it.
    const hook = join(web.root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "refused by the hook"\nexit 1\n');
    chmodSync(hook, 0o755);

    const result = await iso.revert(run, [both.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'failed', task: { taskId: both.id }, repo: 'web', error: expect.stringContaining('refused by the hook') });
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
      commands: [{ task: { taskId: merged.id, order: 1, title: 'Add greeting' }, repo: '.', commit: merge, command: `git revert -m 1 ${merge}` }],
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

describe('the revert\'s commit', () => {
  it('is named from the commit the task stated, carries the trailer and lands as written', async () => {
    const root = initRepo(tempDir());
    git(root, 'config', 'commit.cleanup', 'strip');
    const iso = isolation({ plannedWith: () => true });
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Title');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'file.txt'), 'x\n');
    await iso.integrate(t, run, undefined, { subject: '#42 Fix the parser', body: 'Why it was fixed.' });
    const merge = git(root, 'rev-parse', integration);

    await iso.revert(run, [t.id], nothingInTheWay);

    expect(git(root, 'log', '-1', '--format=%B', integration)).toBe(`Revert: #42 Fix the parser\n\nThis reverts the merge ${merge}, which landed it.\n\nPlanned-with: Ordewell`);
  });
});

describe('the revert\'s place on the queue', () => {
  const execFileAsync = promisify(execFile);

  /** Real git, except that the first call `at` matches waits for the returned function. */
  function holdGit(at: (args: string[]) => boolean): { exec: GitExecFn; held: Promise<void>; open: () => void } {
    let open!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const held = new Promise<void>((resolve) => { arrived = resolve; });
    let spent = false;
    const exec: GitExecFn = async (file, args, opts) => {
      if (!spent && at(args)) {
        spent = true;
        arrived();
        await gate;
      }
      const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
      return { stdout: String(stdout), stderr: String(stderr) };
    };
    return { exec, held, open };
  }

  it('waits for a landing under way, and judges the task only once it has its turn', async () => {
    const root = initRepo(tempDir());
    const { exec, held, open } = holdGit((args) => subcommandOf(args) === 'merge' && args.includes('--no-ff'));
    const iso = isolation({ execFileImpl: exec });
    const run = await iso.startRun(root);
    const wrong = task(1, 'Add greeting');
    const landing = task(2, 'Landing now');
    const { cwd } = await iso.prepare(landing, run);
    writeFileSync(join(cwd, 'landing.txt'), 'landing\n');
    // The first landing is the one held.
    const preparedWrong = await iso.prepare(wrong, run);
    writeFileSync(join(preparedWrong.cwd, 'greeting.txt'), 'hi\n');
    const landed = Promise.all([iso.integrate(wrong, run), iso.integrate(landing, run)]);
    await held;

    const judged: string[] = [];
    const reverted = iso.revert(run, [wrong.id], { ...nothingInTheWay, refusal: () => { judged.push('judged'); return null; } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(judged).toEqual([]);

    open();
    await landed;
    expect(await reverted).toMatchObject({ outcome: 'reverted' });
    expect(judged).toEqual(['judged']);
  });

  it('hears a refusal that came while it waited, and touches nothing', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const tip = git(root, 'rev-parse', integration);

    const result = await iso.revert(run, [t.id], { ...nothingInTheWay, refusal: () => 'Task "D" started meanwhile.' });

    expect(result).toEqual({ outcome: 'refused', reason: 'Task "D" started meanwhile.' });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(run.tasks[t.id].status).toBe('merged');
  });

  it('records the tips and has the run saved before its first commit, and takes the task back in one step', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    const seen: unknown[] = [];

    await iso.revert(run, [t.id], {
      refusal: () => null,
      persist: () => seen.push({ landing: run.landing, reverted: git(root, 'log', '-1', '--format=%s', run.repos[0].integrationBranch) }),
      settled: (taskIds) => seen.push({ taskIds, landing: run.landing, record: run.tasks[t.id], flagged: run.reverted }),
    });

    expect(seen).toEqual([
      { landing: { taskId: t.id, tips: { '.': tip }, reverts: 1 }, reverted: 'Merge: Add greeting' },
      { taskIds: [t.id], landing: undefined, record: undefined, flagged: true },
    ]);
  });
});

describe('a revert a crash interrupted', () => {
  it('is rolled back by the prune, since the saved run still has the task landed', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const first = task(1, 'Add greeting');
    const second = task(2, 'Add farewell');
    await land(iso, run, first, { 'greeting.txt': 'hi\n' });
    await land(iso, run, second, { 'farewell.txt': 'bye\n' });
    const tip = git(root, 'rev-parse', integration);
    const saved = structuredClone(run);
    await iso.revert(run, [first.id, second.id], {
      ...nothingInTheWay,
      persist: () => Object.assign(saved, structuredClone(run)),
    });
    expect(git(root, 'rev-parse', integration)).not.toBe(tip);

    await isolation().pruneOrphans(saved);

    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(saved.landing).toBeUndefined();
    expect(saved.tasks[first.id].status).toBe('merged');
  });

  it('leaves anything but its own reverts alone, and holds the next landing off', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const tip = git(root, 'rev-parse', integration);
    const dir = join(root, '.ordewell', 'worktrees', run.id, 'integration');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'one too many');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'two too many');
    const moved = git(root, 'rev-parse', integration);
    run.landing = { taskId: t.id, tips: { '.': tip }, reverts: 1 };

    await isolation().pruneOrphans(run);

    expect(git(root, 'rev-parse', integration)).toBe(moved);
    expect(run.landing).toBeDefined();
    expect(await iso.mergeIntoCheckedOut(run)).toMatchObject({ outcome: 'blocked', blocked: [{ reason: 'partial-landing' }] });
  });
});

describe('the command for work in the user\'s branch', () => {
  it('quotes a repo path the shell would split', async () => {
    const root = tempDir();
    initRepo(join(root, 'my api'));
    const iso = isolation({ config: fakeConfig({ worktreeIsolation: true, workspaceRepos: ['my api'] }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'my api/greeting.txt': 'hi\n' });
    await iso.mergeIntoCheckedOut(run);
    const merge = run.tasks[t.id].repos['my api'].landedTip!;

    const read = await iso.readLanded(run, [t.id]);

    expect(read).toMatchObject({ ok: true, inBranch: [{ command: `git -C "my api" revert -m 1 ${merge}` }] });
    execFileSync('sh', ['-c', `git -C "my api" revert --no-edit -m 1 ${merge}`], { cwd: root, env: cleanEnv(), stdio: 'ignore' });
    expect(existsSync(join(root, 'my api', 'greeting.txt'))).toBe(false);
  });
});

describe('a rollback git will not make', () => {
  it('says so, keeps the tips recorded, and holds landings and Merge all off a part-reverted branch', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const execFileAsync = promisify(execFile);
    let refuseReset = false;
    const exec: GitExecFn = async (file, args, opts) => {
      if (refuseReset && subcommandOf(args) === 'reset' && args.some((a) => /^[0-9a-f]{40}$/.test(a))) throw Object.assign(new Error('fatal: no'), { stderr: 'fatal: no', code: 128 });
      const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
      return { stdout: String(stdout), stderr: String(stderr) };
    };
    const iso = isolation({ execFileImpl: exec });
    const run = await iso.startRun(root);
    const wrong = task(1, 'Change the line');
    const between = task(2, 'Change it again');
    const clean = task(3, 'Add a file');
    await land(iso, run, wrong, { 'shared.txt': 'wrong\n' });
    await land(iso, run, between, { 'shared.txt': 'between\n' });
    await land(iso, run, clean, { 'new.txt': 'new\n' });
    refuseReset = true;

    const result = await iso.revert(run, [clean.id, wrong.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'failed', task: { taskId: wrong.id }, error: 'it conflicted, and the integration branch could not be put back in .' });
    expect(run.landing).toBeDefined();
    expect(await iso.mergeIntoCheckedOut(run)).toMatchObject({ outcome: 'blocked', blocked: [{ reason: 'partial-landing' }] });
    expect(await iso.revert(run, [clean.id], nothingInTheWay)).toMatchObject({ outcome: 'failed' });

    refuseReset = false;
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(run.landing).toBeUndefined();
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('new\n');
  });
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

    const result = await iso.revert(run, [t.id], nothingInTheWay);

    expect(result).toEqual({ outcome: 'failed', repo: '.', error: `the integration branch is checked out in ${root}` });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(run.tasks[t.id].status).toBe('merged');
    expect(run.landing).toBeUndefined();
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
