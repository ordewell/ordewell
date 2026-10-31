import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { defaultExecFile, type GitExecFn } from '../gitExec';
import type { IWorktreeIsolation, IsolationRun } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round11-reads-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' });
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };
const greeting = task(1, 'Add greeting');

/** An isolation whose git answers, but for the one query `failing` is set to, which exits 128 as a lock or a corrupt object would. */
function isolation() {
  const state: { failing: ((args: string[], cwd?: string) => boolean) | null } = { failing: null };
  const exec: GitExecFn = async (file, args, opts) => {
    if (state.failing?.(args, opts.cwd)) throw Object.assign(new Error('cannot read'), { code: 128, stdout: '', stderr: 'fatal: cannot read' });
    return defaultExecFile(file, args, opts);
  };
  return { state, iso: createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec }) };
}
async function land(iso: IWorktreeIsolation, run: IsolationRun, t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}
/** A task's work committed on its branch, its worktree clean. */
async function committed(iso: IWorktreeIsolation, run: IsolationRun, t: Task): Promise<string> {
  const { cwd } = await iso.prepare(t, run);
  writeFileSync(join(cwd, 'greeting.txt'), 'hi\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'Work');
  return cwd;
}
/** The integration branch merged into the user's branch and then deleted, as a clear-up leaves it. */
async function landedThenGone(iso: IWorktreeIsolation, root: string, run: IsolationRun): Promise<string> {
  await land(iso, run, greeting, { 'greeting.txt': 'hi\n' });
  const merge = run.repos[0].integrationBranch;
  await iso.handoff(run);
  git(root, 'merge', '-q', '--no-ff', '--no-edit', merge);
  git(root, 'branch', '-D', merge);
  return run.landings![greeting.id]['.'][0];
}

describe('whether a task brings anything', () => {
  const countAhead = (args: string[]) => args[0] === 'rev-list' && args[1] === '--count';

  it('stops a landing rather than call work merged that never landed', async () => {
    const root = initRepo(tempDir());
    const { iso, state } = isolation();
    const run = await iso.startRun(root);
    await committed(iso, run, greeting);

    state.failing = countAhead;
    expect(await iso.integrate(greeting, run)).toBe('failed');
    state.failing = null;

    const record = run.tasks[greeting.id];
    expect(record.status).toBe('failed');
    expect(record.landingError).toContain('git could not say');
    expect(run.landings).toBeUndefined();
    expect(() => git(root, 'show', `${run.repos[0].integrationBranch}:greeting.txt`)).toThrow();
    expect(git(root, 'show', `${record.branch}:greeting.txt`)).toBe('hi');
    expect(await iso.integrate(greeting, run)).toBe('merged');
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:greeting.txt`)).toBe('hi');
  });

  it('keeps an interrupted attempt rather than prune it', async () => {
    const root = initRepo(tempDir());
    const { iso, state } = isolation();
    const run = await iso.startRun(root);
    const cwd = await committed(iso, run, greeting);

    state.failing = countAhead;
    const pruned = await iso.pruneOrphans(run);
    state.failing = null;

    expect(pruned.kept.map((t) => t.taskId)).toEqual([greeting.id]);
    expect(run.tasks[greeting.id].status).toBe('kept');
    expect(existsSync(cwd)).toBe(true);
  });
});

describe('what holds a merge', () => {
  it('refuses when git cannot say whether HEAD is on a branch', async () => {
    const root = initRepo(tempDir());
    const { iso, state } = isolation();
    const run = await iso.startRun(root);
    await land(iso, run, greeting, { 'greeting.txt': 'hi\n' });
    const integration = run.repos[0].integrationBranch;
    const tip = git(root, 'rev-parse', integration);

    state.failing = (args, cwd) => args.join(' ') === 'symbolic-ref -q HEAD' && cwd === root;
    expect(await iso.readLanded(run, [greeting.id])).toMatchObject({ ok: false, reason: 'git' });
    expect((await iso.revert(run, [greeting.id], nothingInTheWay)).outcome).toBe('failed');
    state.failing = null;

    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(await iso.readLanded(run, [greeting.id])).toMatchObject({ ok: true });
  });

  it('refuses over a branch it cannot read, which git passes over with exit 0', async () => {
    const root = initRepo(tempDir());
    const { iso } = isolation();
    const run = await iso.startRun(root);
    await land(iso, run, greeting, { 'greeting.txt': 'hi\n' });
    const integration = run.repos[0].integrationBranch;
    const tip = git(root, 'rev-parse', integration);
    expect(await iso.readLanded(run, [greeting.id])).toMatchObject({ ok: true });

    writeFileSync(join(root, '.git', 'refs', 'heads', 'feature'), 'not a sha\n');
    expect(await iso.readLanded(run, [greeting.id])).toMatchObject({ ok: false, reason: 'git' });
    expect((await iso.revert(run, [greeting.id], nothingInTheWay)).outcome).toBe('failed');
    expect(git(root, 'rev-parse', integration)).toBe(tip);

    rmSync(join(root, '.git', 'refs', 'heads', 'feature'));
    expect(await iso.readLanded(run, [greeting.id])).toMatchObject({ ok: true });
  });

  it('does not read work as merged past a branch it cannot read', async () => {
    const root = initRepo(tempDir());
    const { iso } = isolation();
    const run = await iso.startRun(root);
    await land(iso, run, greeting, { 'greeting.txt': 'hi\n' });
    await iso.handoff(run);
    git(root, 'merge', '-q', '--no-ff', '--no-edit', run.repos[0].integrationBranch);

    writeFileSync(join(root, '.git', 'refs', 'heads', 'feature'), 'not a sha\n');
    expect(await iso.findInHead(run)).toEqual([]);
    expect(run.tasks[greeting.id].inHead).toBeUndefined();

    rmSync(join(root, '.git', 'refs', 'heads', 'feature'));
    expect(await iso.findInHead(run)).toEqual([greeting.id]);
    expect(run.tasks[greeting.id].inHead).toBe(true);
  });
});

describe('the integration branch\'s own line', () => {
  const firstParents = (integration: string) => (args: string[]) => args[0] === 'rev-list' && args[1] === '--first-parent' && args[2] === integration;

  it('refuses when it cannot be read, so no command comes out of an order nobody read', async () => {
    const root = initRepo(tempDir());
    const { iso, state } = isolation();
    const run = await iso.startRun(root);
    await land(iso, run, greeting, { 'greeting.txt': 'hi\n' });
    await iso.handoff(run);
    git(root, 'merge', '-q', '--no-ff', '--no-edit', run.repos[0].integrationBranch);

    state.failing = firstParents(run.repos[0].integrationBranch);
    expect(await iso.readLanded(run, [greeting.id])).toMatchObject({ ok: false, reason: 'git' });
  });

  it('control: a branch that is gone still gets the command for what holds its merge', async () => {
    const root = initRepo(tempDir());
    const { iso } = isolation();
    const run = await iso.startRun(root);
    const merge = await landedThenGone(iso, root, run);

    expect(await iso.readLanded(run, [greeting.id])).toMatchObject({ ok: true, inBranch: [{ commit: merge, heldBy: ['main'], merged: true }] });
  });
});

describe('whether a merge is in the user\'s branch', () => {
  const askedOf = (merge: string) => (args: string[]) => args[0] === 'rev-parse' && args.includes(`${merge}^{commit}`);

  it('refuses a revert, since a false no would call the user\'s own branch a review to delete', async () => {
    const root = initRepo(tempDir());
    const { iso, state } = isolation();
    const run = await iso.startRun(root);
    await land(iso, run, greeting, { 'greeting.txt': 'hi\n' });
    await iso.handoff(run);
    git(root, 'merge', '-q', '--no-ff', '--no-edit', run.repos[0].integrationBranch);

    state.failing = askedOf(run.landings![greeting.id]['.'][0]);
    const result = await iso.revert(run, [greeting.id], nothingInTheWay);
    state.failing = null;

    expect(result).toMatchObject({ outcome: 'failed', error: expect.stringContaining('is in your branch') });
    expect(await iso.readLanded(run, [greeting.id])).toMatchObject({ ok: true, inBranch: [{ heldBy: ['main'], merged: true }] });
  });

  it('reads as not merged when the integration branch is gone too, however that would count alone', async () => {
    const root = initRepo(tempDir());
    const { iso, state } = isolation();
    const run = await iso.startRun(root);
    const merge = await landedThenGone(iso, root, run);

    state.failing = askedOf(merge);
    expect(await iso.findInHead(run)).toEqual([]);
    expect(run.tasks[greeting.id].inHead).toBeUndefined();
    state.failing = null;

    expect(await iso.findInHead(run)).toEqual([greeting.id]);
  });

  it('reads as not merged on a run with no base branch', async () => {
    const root = initRepo(tempDir());
    git(root, 'checkout', '-q', '--detach');
    const { iso, state } = isolation();
    const run = await iso.startRun(root);
    await land(iso, run, greeting, { 'greeting.txt': 'hi\n' });
    await iso.handoff(run);
    git(root, 'merge', '-q', '--no-ff', '--no-edit', run.repos[0].integrationBranch);
    const merge = run.landings![greeting.id]['.'][0];

    state.failing = (args) => args[0] === 'merge-base' && args[2] === merge && args[3] === 'HEAD';
    expect(await iso.findInHead(run)).toEqual([]);
    state.failing = null;

    expect(await iso.findInHead(run)).toEqual([greeting.id]);
  });
});

describe('whether a branch or a worktree is there to keep', () => {
  it('keeps a branch git could not read rather than delete it as having nothing to keep', async () => {
    const root = initRepo(tempDir());
    const { iso, state } = isolation();
    const run = await iso.startRun(root);
    const cwd = await committed(iso, run, greeting);
    const { branch } = run.tasks[greeting.id];
    const tip = git(root, 'rev-parse', branch);
    rmSync(cwd, { recursive: true, force: true });

    state.failing = (args) => args[0] === 'rev-parse' && args.includes(`refs/heads/${branch}`);
    const removal = await iso.discard(run, { integration: 'keep' });
    state.failing = null;

    expect(removal.refused).toMatchObject([{ reason: expect.stringContaining('could not read branch') }]);
    expect(git(root, 'rev-parse', branch)).toBe(tip);
  });

  it('leaves a leftover worktree alone when git cannot list what holds it', async () => {
    const root = initRepo(tempDir());
    const { iso, state } = isolation();
    const run = await iso.startRun(root);
    const cwd = await committed(iso, run, greeting);
    const { branch } = run.tasks[greeting.id];
    const tip = git(root, 'rev-parse', branch);
    // A record lost to a crash, with its worktree and branch left behind.
    delete run.tasks[greeting.id];

    state.failing = (args) => args[0] === 'worktree' && args[1] === 'list';
    await expect(iso.prepare(greeting, run)).rejects.toThrow('could not list the worktrees');
    state.failing = null;

    expect(existsSync(cwd)).toBe(true);
    expect(git(root, 'rev-parse', branch)).toBe(tip);
  });
});
