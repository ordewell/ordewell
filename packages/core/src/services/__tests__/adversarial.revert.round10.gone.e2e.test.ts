import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { defaultExecFile, type GitExecFn } from '../gitExec';
import type { IWorktreeIsolation, IsolationHandoff } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { handoffOf } from '../isolationRecord';
import { IsolationRunController } from '../IsolationRunController';
import type { INotification } from '../../interfaces/INotification';

/**
 * ADR-0054: "A git query that fails is no answer, so it reads as not merged, and
 * a revert refuses." `integrationGone` asks whether the integration branch is
 * there with `rev-parse --verify -q`, and reads every failure as "gone" — so a
 * transient failure on a branch that is there makes unmerged work read merged:
 * `inHead` is set, the handoff empties, and closing the run clears it up as
 * merged without handing the work over.
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round10-gone-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' });
async function land(iso: IWorktreeIsolation, run: Parameters<typeof iso.prepare>[1], t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}

describe('a git failure while asking whether the integration branch is gone', () => {
  it('reads as not merged, so a close still hands the work over', async () => {
    const root = initRepo(tempDir());
    let fail = false;
    const exec: GitExecFn = async (file, args, opts) => {
      // The branch is there; only git's answer about it fails, as a lock or a
      // corrupt ref would. The ref name is the run's own integration branch.
      if (fail && args.some((a) => a.startsWith('refs/heads/ordewell/') && a.endsWith('/integration'))) {
        const err = new Error('cannot read ref') as Error & { code: number; stdout: string; stderr: string };
        err.code = 128;
        err.stdout = '';
        err.stderr = 'fatal: cannot read ref';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    // Nothing of it is in the user's branch.
    expect(() => git(root, 'show', 'main:greeting.txt')).toThrow();

    const handoffs: IsolationHandoff[] = [];
    const notifications: INotification = fakeNotification();
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

    // Cannot tell: no mark changes, the handoff keeps the work, and closing
    // hands it over rather than clearing the run up as merged.
    expect({ changed, inHead, handoff }).toEqual({ changed: [], inHead: undefined, handoff: [landed.id] });
    expect(handoffs.map((h) => h.landed.map((t) => t.taskId))).toEqual([[landed.id]]);
    expect((notifications.info as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n')).not.toContain('Everything this run landed is merged');
  });

  // `rev-parse --verify -q` exits 1 for these as it does for a missing ref, so its exit code cannot tell them apart.
  it.each([
    ['broken', (ref: string) => writeFileSync(ref, 'garbage\n')],
    ['unreadable', (ref: string) => chmodSync(ref, 0o000)],
  ])('reads a %s ref as not gone, with no injected failure', async (_kind, damage) => {
    const root = initRepo(tempDir());
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: defaultExecFile });
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    const ref = join(root, '.git', 'refs', 'heads', ...run.repos[0].integrationBranch.split('/'));
    git(root, 'rev-parse', run.repos[0].integrationBranch);

    damage(ref);
    const changed = await iso.findInHead(run);
    const handoff = handoffOf(run).landed.map((t) => t.taskId);
    chmodSync(ref, 0o644);

    expect({ changed, inHead: run.tasks[landed.id]?.inHead, handoff }).toEqual({ changed: [], inHead: undefined, handoff: [landed.id] });
  });

  it('still reads a branch that is really gone as gone', async () => {
    const root = initRepo(tempDir());
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: defaultExecFile });
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    await iso.handoff(run);
    git(root, 'branch', '-D', run.repos[0].integrationBranch);

    expect(await iso.findInHead(run)).toEqual([landed.id]);
    expect(run.tasks[landed.id]?.inHead).toBe(true);
  });
});
