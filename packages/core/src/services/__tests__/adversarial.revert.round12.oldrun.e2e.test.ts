import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation, type WorktreeIsolationDeps } from '../GitWorktreeIsolation';
import type { IWorktreeIsolation, IsolationRun } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { isolationViewOfPlan } from '../isolationRecord';
import { revertScope } from '../taskRevert';

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round12-')));
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

const OLDER = 'This run started on an older version of Ordewell, so Ordewell cannot tell what its merges carried, and a revert could take work that another task still counts as landed. Nothing was reverted.';

describe('ROUND12: a run saved before `carried`', () => {
  it('refuses every revert, rather than removing work a record still says landed', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const { conflicted, resolver } = await carriedThenLanded(iso, run);
    // A run saved by a build before this feature: it has none of these fields,
    // only each record's landedTip and taskTip.
    delete run.carried;
    delete run.landings;
    delete run.landedTasks;
    delete run.keepsEveryLanding;
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    const tasks = [task(1, 'First change'), task(2, 'Conflicted change'), task(3, 'Resolve the conflict')];

    const view = isolationViewOfPlan({ isolation: { run, resolvers: {} } });
    expect(view?.tasks[resolver.id]).toMatchObject({ state: 'integrated' });
    for (const { id } of tasks) {
      expect(view?.tasks[id]).not.toHaveProperty('revertible');
      expect(revertScope(id, { tasks, run, live: new Set(), resolvers: () => [] })).toEqual({ taskIds: [], refusal: { reason: 'no-own-merge', message: OLDER } });
      expect(await iso.readLanded(run, [id])).toEqual({ ok: false, reason: 'no-own-merge', error: OLDER });
      expect(await iso.revert(run, [id], nothingInTheWay)).toEqual({ outcome: 'refused', reason: OLDER });
    }

    expect({ shared: git(root, 'show', `${run.repos[0].integrationBranch}:shared.txt`), status: run.tasks[conflicted.id]?.status }).toEqual({ shared: 'resolved', status: 'merged' });
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });

  it('stays older after a merge carries work on this build: a record started now would miss what came before', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    delete run.carried;

    const { conflicted, resolver } = await carriedThenLanded(iso, run);

    expect(run).not.toHaveProperty('carried');
    expect(await iso.revert(run, [resolver.id], nothingInTheWay)).toEqual({ outcome: 'refused', reason: OLDER });
    expect(await iso.revert(run, [conflicted.id], nothingInTheWay)).toEqual({ outcome: 'refused', reason: OLDER });
  });

  it('a run started on this build holds the record empty, through a save, and reverts', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const started = await iso.startRun(root);
    expect(started.carried).toEqual({});
    const t = task(1, 'First change');
    await land(iso, started, t, { 'shared.txt': 'first\n' });
    const run = JSON.parse(JSON.stringify(started)) as IsolationRun;

    expect(isolationViewOfPlan({ isolation: { run, resolvers: {} } })?.tasks[t.id]).toMatchObject({ state: 'integrated', revertible: true });
    expect(revertScope(t.id, { tasks: [t], run, live: new Set(), resolvers: () => [] }).refusal).toBeUndefined();
    expect(await iso.revert(run, [t.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:shared.txt`)).toBe('base');
  });

  it('control: with `carried` kept, the carrying merge alone is refused, in its own words', async () => {
    const root = initRepo(tempDir(), { 'shared.txt': 'base\n' });
    const iso = isolation();
    const run = await iso.startRun(root);
    const { resolver } = await carriedThenLanded(iso, run);
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);

    expect(await iso.revert(run, [resolver.id], nothingInTheWay)).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('no merge of its own') });
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });
});
