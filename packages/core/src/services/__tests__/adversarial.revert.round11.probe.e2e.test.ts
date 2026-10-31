import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation, type WorktreeIsolationDeps } from '../GitWorktreeIsolation';
import { defaultExecFile, type GitExecFn } from '../gitExec';
import type { IWorktreeIsolation, IsolationRun } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { handoffOf } from '../isolationRecord';
import { revertScope } from '../taskRevert';
import { IsolationRunController } from '../IsolationRunController';
import { fakeNotification } from './sessionTestKit';

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round11-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' });
function isolation(deps: Partial<WorktreeIsolationDeps> = {}): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), ...deps });
}
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };
async function land(iso: IWorktreeIsolation, run: IsolationRun, t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}

/** `conflicted` goes in through `resolver`'s merge, then lands a merge of its own. */
async function carriedThenLanded(iso: IWorktreeIsolation, run: IsolationRun) {
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

describe('ROUND11: a git failure while recording work a resolver carried', () => {
  it('refuses the later revert rather than remove work a record still says landed', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    let failAt: string | null = null;
    const exec: GitExecFn = async (file, args, opts) => {
      // Only the ancestor question about the carried tip fails, as a transient
      // failure would; every other query answers.
      if (failAt !== null && args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[2] === failAt) {
        const err = new Error('cannot read object') as Error & { code: number; stdout: string; stderr: string };
        err.code = 128;
        err.stdout = '';
        err.stderr = 'fatal: cannot read object';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = isolation({ execFileImpl: exec });
    const run = await iso.startRun(root);
    const first = task(1, 'First change');
    const conflicted = task(2, 'Conflicted change');
    const resolver = task(3, 'Resolve the conflict');
    await land(iso, run, first, { 'shared.txt': 'first\n' });
    const { cwd } = await iso.prepare(conflicted, run);
    git(cwd, 'reset', '-q', '--hard', run.repos[0].baseRef);
    writeFileSync(join(cwd, 'shared.txt'), 'conflicted\n');
    expect(await iso.integrate(conflicted, run)).toBe('conflict');
    const branch = run.tasks[conflicted.id].branch;
    const carriedTip = run.tasks[conflicted.id].repos['.'].taskTip!;
    const resolving = await iso.prepare(resolver, run);
    expect(() => git(resolving.cwd, 'merge', '--no-ff', '--no-edit', branch)).toThrow();
    writeFileSync(join(resolving.cwd, 'shared.txt'), 'resolved\n');
    git(resolving.cwd, 'add', '-A');
    git(resolving.cwd, 'commit', '-q', '-m', 'Resolve');
    // The landing's own check of what its merge carried cannot be answered.
    failAt = carriedTip;
    expect(await iso.integrate(resolver, run)).toBe('merged');
    failAt = null;
    // The moment to ask has passed, so what git could not say of is kept.
    expect(run.carried?.[conflicted.id]).toEqual({ '.': [carriedTip] });
    // The carried task then lands a merge of its own, which holds only its later work.
    expect(await iso.integrate(conflicted, run)).toBe('merged');
    await land(iso, run, conflicted, { 'extra.txt': 'extra\n' });

    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    expect(revertScope(resolver.id, { tasks: [first, conflicted, resolver], run, live: new Set(), resolvers: () => [] }).refusal).toBeUndefined();
    const result = await iso.revert(run, [resolver.id], nothingInTheWay);

    expect({ outcome: result.outcome, shared: git(root, 'show', `${run.repos[0].integrationBranch}:shared.txt`), status: run.tasks[conflicted.id]?.status }).toEqual({
      outcome: 'refused', shared: 'resolved', status: 'merged',
    });
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });
});

describe('ROUND11: a git failure while asking what a merge carried', () => {
  it('does not drop the saved carried tip and revert over it', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    let failAt: string | null = null;
    const exec: GitExecFn = async (file, args, opts) => {
      if (failAt !== null && args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[2] === failAt) {
        const err = new Error('cannot read object') as Error & { code: number; stdout: string; stderr: string };
        err.code = 128;
        err.stdout = '';
        err.stderr = 'fatal: cannot read object';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = isolation({ execFileImpl: exec });
    const run = await iso.startRun(root);
    const { conflicted, resolver } = await carriedThenLanded(iso, run);
    // The tip `carried` saved when the resolver's merge brought it in.
    const carriedTip = run.carried![conflicted.id]['.'][0];
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);

    // One failed read of what the merge carried, at revert time.
    failAt = carriedTip;
    const preview = await iso.readLanded(run, [resolver.id]);
    const result = await iso.revert(run, [resolver.id], nothingInTheWay);
    failAt = null;

    // A read git could not answer stops as `holdersOf`'s does: 'failed', not a refusal over the work.
    expect(preview).toMatchObject({ ok: false, reason: 'git' });
    expect({ outcome: result.outcome, shared: git(root, 'show', `${run.repos[0].integrationBranch}:shared.txt`), status: run.tasks[conflicted.id]?.status }).toEqual({
      outcome: 'failed', shared: 'resolved', status: 'merged',
    });
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });

  it('control: with git answering, the saved carried tip refuses the revert', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const { resolver } = await carriedThenLanded(iso, run);
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);

    expect(await iso.revert(run, [resolver.id], nothingInTheWay)).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('no merge of its own') });
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });
});

describe('ROUND11: a git failure while asking which branch the user renamed', () => {
  it('reads as not merged, so a close still hands the work over', async () => {
    const root = initRepo(tempDir());
    let fail = false;
    const exec: GitExecFn = async (file, args, opts) => {
      // The user's branch was renamed main -> work; only git's answer about it fails.
      if (fail && args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[3] === 'refs/heads/work') {
        const err = new Error('cannot read object') as Error & { code: number; stdout: string; stderr: string };
        err.code = 128;
        err.stdout = '';
        err.stderr = 'fatal: cannot read object';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = isolation({ execFileImpl: exec });
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    // The user renamed their branch, and a new branch took the old name and
    // holds the integration tip; only the renamed one is the user's.
    git(root, 'branch', '-m', 'main', 'work');
    git(root, 'branch', 'main', run.repos[0].integrationBranch);
    expect(() => git(root, 'show', 'work:greeting.txt')).toThrow();

    const handoffs: ReturnType<typeof handoffOf>[] = [];
    const notifications = fakeNotification();
    const controller = new IsolationRunController({
      isolation: iso,
      config: fakeConfig({ worktreeIsolation: true }),
      notifications,
      workspaceRoot: () => root,
      listener: { changed: () => undefined, blocked: () => undefined, handoff: (h) => handoffs.push(h), closed: () => undefined, ended: () => undefined, notice: () => undefined, resolversEnded: () => undefined },
      liveTasks: () => new Set(),
      landedOn: () => [],
    });
    await controller.adopt({ run, resolvers: {} });
    await controller.decide(async () => undefined);

    fail = true;
    const changed = await iso.findInHead(run);
    const inHead = run.tasks[landed.id]?.inHead;
    const handoff = handoffOf(run).landed.map((t) => t.taskId);
    await controller.close();

    // What a false yes does: the run closes as merged over work the user's
    // branch does not hold.
    expect((notifications.info as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n')).not.toContain('Everything this run landed is merged');
    expect({ changed, inHead, handoff }).toEqual({ changed: [], inHead: undefined, handoff: [landed.id] });
    expect(handoffs.map((h) => h.landed.map((t) => t.taskId))).toEqual([[landed.id]]);
  });

  it('control: with git answering, the renamed branch is the user\'s and the impostor is not', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    git(root, 'branch', '-m', 'main', 'work');
    git(root, 'branch', 'main', run.repos[0].integrationBranch);

    expect(await iso.findInHead(run)).toEqual([]);
    expect(run.tasks[landed.id].inHead).toBeUndefined();
    expect(handoffOf(run).landed.map((t) => t.taskId)).toEqual([landed.id]);
  });
});
