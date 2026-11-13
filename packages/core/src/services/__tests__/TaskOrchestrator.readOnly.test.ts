import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IConfig } from '../../interfaces/IConfig';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { TaskShell, TaskShellSite } from '../../interfaces/IFileSystem';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * A read-only task lands nothing (ADR-0046): it runs in a worktree of its own
 * that goes whatever it changed, its runner is given `run_command` from the
 * task's shell, and its report is all that comes back.
 */
function setup(opts: { config?: Partial<IConfig> } = {}) {
  const isolation = new FakeWorktreeIsolation();
  const sessions: FakeRunnerSession[] = [];
  const requests: RunnerSpawnOptions[] = [];
  const sites: TaskShellSite[] = [];
  const shells: Array<TaskShell & { end: ReturnType<typeof vi.fn> }> = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      requests.push(o);
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${o.taskId}-${sessions.length + 1}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: true, ...opts.config }),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    taskShell: (site) => {
      sites.push(site);
      const shell = { run: vi.fn(async () => ({ success: true, output: 'ran', truncated: false })), end: vi.fn() };
      shells.push(shell);
      return shell;
    },
  });
  const spawned = (taskId: string) => requests.filter((r) => r.taskId === taskId);
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const status = (taskId: string) => orchestrator.storeInstance.get(taskId)!.status;
  const record = (taskId: string) => orchestrator.runs.planIsolation?.run.tasks[taskId];
  return { orchestrator, isolation, spawned, latest, status, record, sites, shells };
}

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'bypassPermissions', ...over });
/** On the mode Claude Code's manifest tags read-only (ADR-0001). */
const readOnly = (id: string, order: number, over: Partial<Task> = {}) => task(id, order, { taskMode: 'plan', ...over });

describe('a read-only task (ADR-0046)', () => {
  it('runs in a worktree of its own, given a shell that may write it, and a change task is given none', async () => {
    const env = setup();
    env.orchestrator.loadPlan([readOnly('r1', 1), task('c2', 2)]);

    await env.orchestrator.approveReview();

    const cwd = env.spawned('r1')[0].cwd;
    expect(cwd).toBe('/fake-worktrees/run1/1-r1');
    expect(env.record('r1')?.readOnly).toBe(true);
    // The worktree's `.git` is named so the sealed profile keeps it the repository's (ADR-0046).
    expect(env.sites).toEqual([{ cwd, writable: cwd, worktrees: [cwd] }]);
    expect(env.spawned('r1')[0].shell).toBe(env.shells[0]);
    expect(env.spawned('c2')[0].shell).toBeUndefined();
    expect(env.record('c2')?.readOnly).toBeUndefined();
  });

  it('lands nothing when it passes, whatever it changed: its worktree goes and its report is its result', async () => {
    const env = setup();
    env.orchestrator.loadPlan([readOnly('r1', 1)]);
    await env.orchestrator.approveReview();

    env.latest('r1').reportComplete({ status: 'done', summary: 'Three findings: the cache is never invalidated.' });

    await vi.waitFor(() => expect(env.status('r1')).toBe('completed'));
    expect(env.isolation.taskIdsFor('integrate')).toEqual([]);
    expect(env.isolation.calls).toContainEqual({ op: 'release', taskId: 'r1', keep: false });
    expect(env.record('r1')).toBeUndefined();
    expect(env.orchestrator.storeInstance.get('r1')!.handoff?.summary).toContain('the cache is never invalidated');
    expect(env.shells[0].end).toHaveBeenCalled();
  });

  it('lets its worktree go when it fails too, with nothing kept for inspection', async () => {
    const env = setup();
    env.orchestrator.loadPlan([readOnly('r1', 1)]);
    await env.orchestrator.approveReview();

    env.latest('r1').reportComplete({ status: 'failed', summary: '', reason: 'could not reproduce' });

    await vi.waitFor(() => expect(env.status('r1')).toBe('failed'));
    await flushMicrotasks();
    expect(env.isolation.taskIdsFor('integrate')).toEqual([]);
    expect(env.record('r1')).toBeUndefined();
    expect(env.shells[0].end).toHaveBeenCalled();
  });

  it('lands nothing when the user marks it complete', async () => {
    const env = setup();
    env.orchestrator.loadPlan([readOnly('r1', 1)]);
    await env.orchestrator.approveReview();
    await vi.waitFor(() => expect(env.spawned('r1')).toHaveLength(1));

    await env.orchestrator.markTaskComplete('r1');

    expect(env.status('r1')).toBe('completed');
    expect(env.isolation.taskIdsFor('integrate')).toEqual([]);
    expect(env.record('r1')).toBeUndefined();
  });

  it('where the run does not isolate, runs from the workspace root with nothing of it writable', async () => {
    const env = setup();
    env.isolation.availability = { active: false, reason: 'disabled' };
    env.orchestrator.loadPlan([readOnly('r1', 1)]);

    await env.orchestrator.approveReview();

    expect(env.spawned('r1')[0].cwd).toBe('/repo');
    expect(env.sites).toEqual([{ cwd: '/repo' }]);
    expect(env.isolation.taskIdsFor('prepare')).toEqual([]);
  });
});
