import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation, type WorktreeIsolationDeps } from '../GitWorktreeIsolation';
import type { IsolationRun, IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { revertScope } from '../taskRevert';
import { IsolationRunController } from '../IsolationRunController';

/**
 * Audit of the revert's plan-level landed set and of `inHead` (ADR-0054):
 *
 * - a task whose current record is not `merged` (a retry dropped it, a spawn
 *   failed, a continue conflicted) still has its old merges on the integration
 *   branch, so reverting its ancestor must take it too;
 * - checking the integration branch out for review is not the user's branch
 *   holding the work, so it must not make the landings `inHead`.
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-revert-audit-')));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});
function task(order: number, title: string, dependencies: string[] = []): Task {
  return { id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies, subtasks: [], assignedRunner: 'claude-code' };
}
function isolation(deps: Partial<WorktreeIsolationDeps> = {}): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), ...deps });
}
async function land(iso: IWorktreeIsolation, run: IsolationRun, t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };

describe('AUDIT revert: a dependent whose record a retry dropped', () => {
  it('is still landed on the branch, so reverting its ancestor takes it too', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const base = task(1, 'Base change');
    const dependent = task(2, 'Standing on the base', ['task-1']);
    await land(iso, run, base, { 'base.txt': 'base\n' });
    await land(iso, run, dependent, { 'dependent.txt': 'dependent\n' });

    // What a retry does before its new attempt lands: the record goes, the merge stays.
    await iso.release(run, dependent.id, { keep: false });
    expect(run.tasks[dependent.id]).toBeUndefined();
    expect(run.landings?.[dependent.id]?.['.']).toHaveLength(1);

    const scope = revertScope(base.id, { tasks: [base, dependent], run, live: new Set() });

    expect(scope.taskIds).toContain(dependent.id);
    expect(await iso.revert(run, scope.taskIds, nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
    expect(git(root, 'ls-tree', '--name-only', integration)).toBe('README.md');
  });
});

describe('AUDIT revert: the integration branch checked out for review', () => {
  it('is not the user\'s branch, so it does not make the landing inHead', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    await iso.handoff(run);
    git(root, 'checkout', '-q', integration);

    expect(await iso.findInHead(run)).toEqual([]);
    expect(run.tasks[landed.id].inHead).toBeUndefined();

    git(root, 'checkout', '-q', 'main');
    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: true, inBranch: [] });
    expect(await iso.revert(run, [landed.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
  });

  it('does not let adopting the run clear away work the user never merged', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    await iso.handoff(run);
    git(root, 'checkout', '-q', integration);
    const controller = new IsolationRunController({
      isolation: iso,
      config: fakeConfig({ worktreeIsolation: true }),
      notifications: fakeNotification(),
      workspaceRoot: () => root,
      listener: { changed: () => undefined, blocked: () => undefined, handoff: () => undefined, closed: () => undefined, notice: () => undefined },
      liveTasks: () => new Set(),
    });

    expect(await controller.adopt({ run, resolvers: {} })).not.toBe('cleared');
    expect(controller.current?.tasks[landed.id]).toMatchObject({ status: 'merged' });
    expect(run.tasks[landed.id].inHead).toBeUndefined();
    expect(git(root, 'branch', '--list', integration)).toContain(integration);
  });
});
