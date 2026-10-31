import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { createTask } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';

/**
 * Regression for ADR-0054's retry: "A retry or a force start releases it and
 * starts from the current integration tip." Git treats a reverted merge as
 * already merged, so a retried task has to make a merge of its own; this runs
 * the whole orchestrator against real git and checks the branch.
 */

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function tempDir(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-adv2-orch-'))); roots.push(dir); return dir; }
function repo(): string {
  const root = tempDir();
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
function writingRunner(files: Record<string, string[]>) {
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
      setTimeout(() => {
        for (const file of files[opts.taskId] ?? []) {
          mkdirSync(dirname(join(opts.cwd!, file)), { recursive: true });
          writeFileSync(join(opts.cwd!, file), `written by ${opts.taskId}\n`);
        }
        session.reportComplete({ status: 'done', summary: 'Done.' });
      }, 5);
      return session;
    }),
    stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
  };
  return runner;
}

describe.skipIf(!hasGit)('ADVERSARIAL: revert and retry through the real pipeline', () => {
  it('lands a retried task again after its merge was reverted', async () => {
    const root = repo();
    const isolation = createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' });
    const runner = writingRunner({ t1: ['one.txt'], t2: ['two.txt'] });
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig({ maxParallelSessions: 2 }), notifications: fakeNotification(),
      runner, output: new BufferedTaskOutputSource(), isolation, workspaceRoot: () => root,
    });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'One', prompt: 'write one' }),
      createTask({ id: 't2', order: 2, title: 'Two', prompt: 'write two', dependencies: ['t1'] }),
    ]);
    await orchestrator.approveReview();
    const done = (id: string) => vi.waitFor(() => expect(orchestrator.storeInstance.get(id)!.status).toBe('completed'), { timeout: 20000 });
    await done('t1');
    await done('t2');
    const run = orchestrator.runs.current!;
    const integration = run.repos[0].integrationBranch;
    expect(git(root, 'ls-tree', '--name-only', integration).split('\n').sort()).toEqual(['README.md', 'one.txt', 'two.txt']);

    await orchestrator.revertTask('t1');
    expect(git(root, 'ls-tree', '--name-only', integration).split('\n')).toEqual(['README.md']);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('pending');
    expect(orchestrator.holdReason('t1')).toContain('reverted');

    await orchestrator.forceStartTask('t1');
    await done('t1');
    expect(git(root, 'ls-tree', '--name-only', integration).split('\n').sort()).toEqual(['README.md', 'one.txt']);
    await orchestrator.forceStartTask('t2');
    await done('t2');
    expect(git(root, 'ls-tree', '--name-only', integration).split('\n').sort()).toEqual(['README.md', 'one.txt', 'two.txt']);
    // Each retry made a real merge of its own on top of the revert.
    const log = git(root, 'log', '--first-parent', '--format=%s', integration).split('\n');
    expect(log.filter((line) => line === 'Merge: One')).toHaveLength(2);
    expect(log.filter((line) => line === 'Revert: One')).toHaveLength(1);
    expect(existsSync(join(root, 'one.txt'))).toBe(false);
  }, 60000);
});
