// Part of GitWorktreeIsolation.revert.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: gitWorktreeRevertKit.ts

import { describe, it, expect, afterEach } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { type GitExecFn } from '../GitWorktreeIsolation';
import { defaultExecFile, subcommandOf } from '../gitExec';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, removeDir } from '../../testing';
import { IsolationRunController } from '../IsolationRunController';
import { fakeNotification } from './sessionTestKit';
import { cleanEnv, git, initRepo, temps, tempDir, task, isolation, land, nothingInTheWay } from './gitWorktreeRevertKit';

afterEach(async () => {
  while (temps.length) await removeDir(temps.pop()!);
});

describe('a landing whose record no longer says so', () => {
  it('names a task with no record left, and words its commit from what it stated', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'greeting.txt'), 'hi\n');
    expect(await iso.integrate(t, run, undefined, { subject: 'Greet the user' })).toBe('merged');
    await iso.release(run, t.id, { keep: false });

    const read = await iso.readLanded(run, [t.id]);
    const result = await iso.revert(run, [t.id], nothingInTheWay);

    expect(read).toEqual({ ok: true, tasks: [{ taskId: t.id, order: 1, title: 'Add greeting', repos: ['.'] }], inBranch: [] });
    expect(result).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: t.id }] });
    expect(git(root, 'log', '-1', '--format=%s', integration)).toBe('Revert: Greet the user');
    expect(run.landings?.[t.id]).toBeUndefined();
    expect(run.landedTasks?.[t.id]).toBeUndefined();
  });

  it('keeps the record and worktree of a later attempt that did not land', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'unlanded.txt'), 'still here\n');
    await iso.release(run, t.id, { keep: true });

    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(git(root, 'ls-tree', '--name-only', integration)).toBe('README.md');
    expect(run.tasks[t.id].status).toBe('kept');
    expect(readFileSync(join(cwd, 'unlanded.txt'), 'utf8')).toBe('still here\n');
    expect(run.landings?.[t.id]).toBeUndefined();
  });

  it('ends the conflict of a later attempt, which nothing should repair or land now', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = task(1, 'Change the line');
    await land(iso, run, t, { 'shared.txt': 'first\n' });
    const { cwd } = await iso.prepare(t, run);
    git(cwd, 'reset', '-q', '--hard', run.repos[0].baseRef);
    writeFileSync(join(cwd, 'shared.txt'), 'second\n');
    expect(await iso.integrate(t, run)).toBe('conflict');

    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(run.tasks[t.id]).toMatchObject({ status: 'kept' });
    expect(run.tasks[t.id]).not.toHaveProperty('conflictRepo');
    expect(run.tasks[t.id]).not.toHaveProperty('conflictFiles');
    expect(existsSync(cwd)).toBe(true);
  });

  it('does not take a repo only the later attempt changed for one with no merge', async () => {
    const root = tempDir();
    initRepo(join(root, 'api'));
    initRepo(join(root, 'web'), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const [api, web] = run.repos;
    const t = task(1, 'Touch the api');
    const between = task(2, 'Change the line');
    await land(iso, run, t, { 'api/one.txt': 'a\n' });
    await land(iso, run, between, { 'web/shared.txt': 'between\n' });
    const { cwd } = await iso.prepare(t, run);
    git(join(cwd, 'web'), 'reset', '-q', '--hard', web.baseRef);
    writeFileSync(join(cwd, 'web', 'shared.txt'), 'conflicted\n');
    expect(await iso.integrate(t, run)).toBe('conflict');

    expect(await iso.readLanded(run, [t.id])).toMatchObject({ ok: true, tasks: [{ taskId: t.id, repos: ['api'] }] });
    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
    expect(git(api.root, 'ls-tree', '--name-only', api.integrationBranch)).toBe('README.md');
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
    // In its turn, and again with its commits made.
    expect(judged).toEqual(['judged', 'judged']);
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

  it('rolls its commits back when something stops it while it made them', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const tip = git(root, 'rev-parse', integration);
    let judged = 0;
    const settled: unknown[] = [];

    const result = await iso.revert(run, [t.id], {
      ...nothingInTheWay,
      refusal: () => (++judged === 2 ? 'Another plan was loaded.' : null),
      settled: (taskIds) => settled.push(taskIds),
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'Another plan was loaded.' });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(settled).toEqual([]);
    expect(run.landing).toBeUndefined();
    expect(run.tasks[t.id].status).toBe('merged');
  });

  it('leaves a plan loaded under it alone, the same run saved or not', async () => {
    const root = initRepo(tempDir());
    const { exec, held, open } = holdGit((args) => subcommandOf(args) === 'merge-tree');
    const iso = isolation({ execFileImpl: exec });
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const tip = git(root, 'rev-parse', integration);
    const settled: unknown[] = [];
    const controller = new IsolationRunController({
      isolation: iso,
      config: fakeConfig({ worktreeIsolation: true }),
      notifications: fakeNotification(),
      workspaceRoot: () => root,
      listener: { changed: () => undefined, blocked: () => undefined, handoff: () => undefined, closed: () => undefined, ended: () => undefined, notice: () => undefined, resolversEnded: () => undefined },
      liveTasks: () => new Set(),
      landedOn: () => [],
    });
    await controller.adopt({ run, resolvers: {} });

    const reverting = controller.revert([t.id], { refusal: () => null, settled: (ids) => settled.push(ids) });
    await held;
    // What the session reloads from its file: the same run, as a new record that has not heard of this revert.
    const adopted = controller.adopt({ run: JSON.parse(JSON.stringify(run)) as IsolationRun, resolvers: {} });
    open();

    expect(await reverting).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('Another plan was loaded') });
    await adopted;
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(settled).toEqual([]);
    expect(controller.planIsolation?.run.tasks[t.id].status).toBe('merged');
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
      persist: () => seen.push({ landing: structuredClone(run.landing), reverted: git(root, 'log', '-1', '--format=%s', run.repos[0].integrationBranch) }),
      settled: (taskIds) => seen.push({ taskIds, landing: run.landing, record: run.tasks[t.id], flagged: run.reverted }),
    });

    const commit = git(root, 'rev-parse', run.repos[0].integrationBranch);
    expect(seen).toEqual([
      { landing: { taskId: t.id, tips: { '.': tip }, reverts: { '.': { commits: [] } } }, reverted: 'Merge: Add greeting' },
      // Named before the branch moves onto it, so no crash leaves a commit of its own unsaved.
      { landing: { taskId: t.id, tips: { '.': tip }, reverts: { '.': { commits: [commit] } } }, reverted: 'Merge: Add greeting' },
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
    run.landing = { taskId: t.id, tips: { '.': tip }, reverts: { '.': { commits: [] } } };

    await isolation().pruneOrphans(run);

    expect(git(root, 'rev-parse', integration)).toBe(moved);
    expect(run.landing).toBeDefined();
    expect(await iso.mergeIntoCheckedOut(run)).toMatchObject({ outcome: 'blocked', blocked: [{ reason: 'partial-landing' }] });
  });

  it('holds each repo to the reverts it had to make, not to the most any repo did', async () => {
    const root = tempDir();
    initRepo(join(root, 'api'));
    initRepo(join(root, 'web'));
    const iso = isolation();
    const run = await iso.startRun(root);
    const [api, web] = run.repos;
    const first = task(1, 'Touch both');
    const second = task(2, 'Touch api again');
    await land(iso, run, first, { 'api/one.txt': '1\n', 'web/one.txt': '1\n' });
    await land(iso, run, second, { 'api/two.txt': '2\n' });
    const [apiTip, webTip] = [git(root, '-C', 'api', 'rev-parse', api.integrationBranch), git(root, '-C', 'web', 'rev-parse', web.integrationBranch)];
    const saved = structuredClone(run);
    await iso.revert(run, [first.id, second.id], { ...nothingInTheWay, persist: () => Object.assign(saved, structuredClone(run)) });
    expect(Object.values(saved.landing?.reverts ?? {}).map((r) => r.commits.length)).toEqual([2, 1]);
    // A writer outside the queue: one revert on web, and a commit no revert made.
    git(join(root, '.ordewell', 'worktrees', run.id, 'integration', 'web'), 'commit', '-q', '--allow-empty', '-m', 'Work of the user');
    const moved = git(root, '-C', 'web', 'rev-parse', web.integrationBranch);

    await isolation().pruneOrphans(saved);

    expect(git(root, '-C', 'api', 'rev-parse', api.integrationBranch)).toBe(apiTip);
    expect(git(root, '-C', 'web', 'rev-parse', web.integrationBranch)).toBe(moved);
    expect(moved).not.toBe(webTip);
    expect(saved.landing).toBeDefined();
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

    expect(read).toMatchObject({ ok: true, inBranch: [{ command: `git -C 'my api' revert -m 1 ${merge}` }] });
    execFileSync('sh', ['-c', `git -C 'my api' revert --no-edit -m 1 ${merge}`], { cwd: root, env: cleanEnv(), stdio: 'ignore' });
    expect(existsSync(join(root, 'my api', 'greeting.txt'))).toBe(false);
  });

  it.each([
    ['a variable', 'we$HOME'],
    ['a command substitution', 'we$(touch pwned)ird'],
    ['a backtick', 'we`touch pwned`ird'],
    // Windows allows no double quote in a file name.
    ...(process.platform === 'win32' ? [] : [['a double quote', 'we"ird']]),
    ['a single quote', "it's"],
  ])('runs as printed with %s in the path', async (_what, name) => {
    const root = tempDir();
    initRepo(join(root, name));
    const iso = isolation({ config: fakeConfig({ worktreeIsolation: true, workspaceRepos: [name] }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { [join(name, 'greeting.txt')]: 'hi\n' });
    await iso.mergeIntoCheckedOut(run);

    const read = await iso.readLanded(run, [t.id]);
    if (!read.ok) throw new Error(read.error);
    execFileSync('sh', ['-c', read.inBranch[0].command.replace(' revert ', ' revert --no-edit ')], { cwd: root, env: cleanEnv(), stdio: 'ignore' });

    expect(existsSync(join(root, name, 'greeting.txt'))).toBe(false);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
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
describe('reverting on an older git', () => {
  /** Real git that says it is `version`, and turns `merge-tree --merge-base` down as a git before 2.40 does. */
  const gitOf = (version: string): GitExecFn => (file, args, opts) => {
    if (args[0] === '--version') return Promise.resolve({ stdout: `git version ${version}\n`, stderr: '' });
    if (args.some((arg) => arg.startsWith('--merge-base'))) {
      return Promise.reject(Object.assign(new Error('unknown option'), { stdout: '', stderr: "error: unknown option `merge-base=...'", code: 129 }));
    }
    return defaultExecFile(file, args, opts);
  };

  it('takes one landing back on git 2.39, keeping what landed beside it', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'one\ntwo\nthree\n' });
    const iso = isolation({ execFileImpl: gitOf('2.39.5') });
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const first = task(1, 'Change the top');
    const second = task(2, 'Change the bottom');
    await land(iso, run, first, { 'shared.txt': 'ONE\ntwo\nthree\n' });
    await land(iso, run, second, { 'shared.txt': 'ONE\ntwo\nTHREE\n' });

    expect(await iso.revert(run, [first.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted', tasks: [{ taskId: first.id }] });

    expect(git(root, 'show', `${integration}:shared.txt`)).toBe('one\ntwo\nTHREE');
    // What stood in for the merge's sides stays out of the branch's history.
    expect(git(root, 'rev-list', '--count', `${integration}~1..${integration}`)).toBe('1');
    expect(git(root, 'log', '-1', '--format=%s', integration)).toBe('Revert: Change the top');
  });

  it('stops on a conflict on git 2.39 and says which files', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'one\n' });
    const iso = isolation({ execFileImpl: gitOf('2.39.5') });
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const first = task(1, 'Change it');
    const second = task(2, 'Change it again');
    await land(iso, run, first, { 'shared.txt': 'two\n' });
    await land(iso, run, second, { 'shared.txt': 'three\n' });
    const tip = git(root, 'rev-parse', integration);

    expect(await iso.revert(run, [first.id], nothingInTheWay)).toMatchObject({ outcome: 'conflict', files: ['shared.txt'] });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
  });

  it('tells a run on git 2.37 what that costs, in the version it found', async () => {
    const note = await isolation({ execFileImpl: gitOf('2.37.7') }).gitShortfall();

    expect(note).toContain('git 2.38 or newer');
    expect(note).toContain('2.37.7');
    expect(note).not.toContain('patch');
  });

  it('adds what goes wrong with a patch on git 2.32', async () => {
    expect(await isolation({ execFileImpl: gitOf('2.32.7') }).gitShortfall()).toContain("another task's patch");
  });

  it('has nothing to say on git 2.38, on an Apple build, or with no git at all', async () => {
    expect(await isolation({ execFileImpl: gitOf('2.38.0') }).gitShortfall()).toBeNull();
    expect(await isolation({ execFileImpl: gitOf('2.39.5 (Apple Git-154)') }).gitShortfall()).toBeNull();
    const missing: GitExecFn = () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
    expect(await isolation({ execFileImpl: missing }).gitShortfall()).toBeNull();
  });

  it('refuses on git 2.37, naming the version it needs', async () => {
    const root = initRepo(tempDir());
    const iso = isolation({ execFileImpl: gitOf('2.37.7') });
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });

    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: false, reason: 'git', error: expect.stringContaining('git 2.38 or newer') });
    expect(await iso.revert(run, [landed.id], nothingInTheWay)).toMatchObject({ outcome: 'failed', error: expect.stringContaining('git 2.38 or newer') });
  });
});
