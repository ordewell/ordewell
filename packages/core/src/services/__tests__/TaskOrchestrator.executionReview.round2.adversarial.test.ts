import { describe, expect, it, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import type { ExecutionBackend } from '../executionLease';

/**
 * Execution review, round 2: a Stop during an attempt's workspace prepare
 * lets that workspace go (ADR-0059 L1). The release must reach the record the
 * ended lease prepared, not whatever record the current run holds under the
 * same task id: a later start that ended kept, or landed, owns that one.
 */

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

function setup(execution?: (local: ExecutionBackend) => ExecutionBackend) {
  const isolation = new FakeWorktreeIsolation();
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
    ...(execution ? { execution } : {}),
  });
  return { orchestrator, isolation, spawn, sessions };
}

/** Force-start t1, holding its first prepare; the returned `release` lets that first prepare finish. */
async function firstPrepareHeld(env: ReturnType<typeof setup>) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const got = new Promise<void>((resolve) => { entered = resolve; });
  const prepare = env.isolation.prepare.bind(env.isolation);
  vi.spyOn(env.isolation, 'prepare')
    .mockImplementationOnce(async (...args) => { entered(); await gate; return prepare(...args); })
    .mockImplementation(prepare);
  const first = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
  await got;
  return { first, release };
}

describe('a late prepare after a later start ended kept', () => {
  it('does not let go the kept worktree of a start that followed the first Stop', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('t1', 1)]);
    const { first, release } = await firstPrepareHeld(env);
    env.orchestrator.stop();
    const second = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    // The second start runs in the new run; stop it, which keeps its worktree, unawaited.
    env.orchestrator.stop();
    await vi.waitFor(() => expect(env.orchestrator.runs.current?.tasks.t1?.status).toBe('kept'));
    const kept = env.orchestrator.runs.current?.tasks.t1;
    release();
    await Promise.all([first, second]);
    await flushMicrotasks(20);

    expect(env.orchestrator.runs.current?.tasks.t1).toBe(kept);
    expect(env.orchestrator.runs.current?.tasks.t1?.status).toBe('kept');
  });
});

describe('a late prepare after a later start landed', () => {
  it('does not let go the landed record of a start that followed the Stop', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('t1', 1)]);
    const { first, release } = await firstPrepareHeld(env);
    env.orchestrator.stop();
    const second = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    env.sessions[0].reportComplete({ status: 'done', summary: 'landed' });
    await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('completed'));
    release();
    await Promise.all([first, second]);
    await flushMicrotasks(20);

    expect(env.orchestrator.runs.current?.tasks.t1).toMatchObject({ status: 'merged' });
  });
});

describe('a late shared open after the next run isolated', () => {
  it('does not let go the kept worktree of a start in the isolated run that followed the Stop', async () => {
    const env = setup();
    env.isolation.availability = { active: false, reason: 'not-git' };
    env.orchestrator.loadPlan([task('t1', 1)]);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const got = new Promise<void>((resolve) => { entered = resolve; });
    const runs = env.orchestrator.runs;
    const workspaceCwd = runs.workspaceCwd.bind(runs);
    // Held once the shared workspace is had: its own release reads the run in the same turn as its decision check.
    vi.spyOn(runs, 'workspaceCwd')
      .mockImplementationOnce(async (t) => { const had = await workspaceCwd(t); entered(); await gate; return had; })
      .mockImplementation(workspaceCwd);
    const first = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await got;
    env.orchestrator.stop();
    env.isolation.availability = { active: true };
    const second = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    env.orchestrator.stop();
    await vi.waitFor(() => expect(runs.current?.tasks.t1?.status).toBe('kept'));
    const kept = runs.current?.tasks.t1;
    release();
    await Promise.all([first, second]);
    await flushMicrotasks(20);

    expect(runs.current?.tasks.t1).toBe(kept);
    expect(runs.current?.tasks.t1?.status).toBe('kept');
  });
});

/**
 * Holds t1's first lease open after its workspace is made, as a backend that
 * starts a box there does; the returned `release` lets that open finish.
 */
function firstOpenHeldAfterPrepare() {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const opened = new Promise<void>((resolve) => { entered = resolve; });
  let opens = 0;
  const execution = (local: ExecutionBackend): ExecutionBackend => {
    const reserve = local.reserve.bind(local);
    local.reserve = (request) => {
      const reserved = reserve(request);
      if ('refused' in reserved) return reserved;
      const { lease } = reserved;
      const open = lease.open.bind(lease);
      return { lease: { ...lease, open: async (spec, signal) => {
        const made = await open(spec, signal);
        if (spec.task?.id === 't1' && ++opens === 1) { entered(); await gate; }
        return made;
      } } };
    };
    return local;
  };
  return { execution, opened, release };
}

describe('a late lease open after a later start in the same run ended kept', () => {
  it('does not let go the kept worktree of a start that followed a cancel', async () => {
    const held = firstOpenHeldAfterPrepare();
    const env = setup(held.execution);
    env.orchestrator.loadPlan([task('t1', 1)]);
    const first = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await held.opened;
    // A cancel ends the attempt and leaves the run open, so the next start prepares in the same run.
    await env.orchestrator.cancelTask('t1');
    const run = env.orchestrator.runs.current;
    const second = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    await env.orchestrator.cancelTask('t1');
    const kept = env.orchestrator.runs.current?.tasks.t1;
    expect(env.orchestrator.runs.current).toBe(run);
    expect(kept?.status).toBe('kept');
    held.release();
    await Promise.all([first, second]);
    await flushMicrotasks(20);

    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.orchestrator.runs.current?.tasks.t1).toBe(kept);
    expect(env.orchestrator.runs.current?.tasks.t1?.status).toBe('kept');
  });
});
