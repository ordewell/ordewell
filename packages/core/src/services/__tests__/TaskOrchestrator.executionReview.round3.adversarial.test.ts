import { describe, expect, it, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import type { ExecutionBackend } from '../executionLease';

/**
 * Execution review, round 3: a cancel keeps a starting attempt's worktree, but
 * the late success path still lets the same record go with keep:false.
 * Pre-existing at 6dfbc985; #29 reported it unverified (its F6). A Stop keeps
 * a worktree as a cancel does (ADR-0013), so it is held to the same.
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

/** Holds the first lease open after its workspace is made, as a backend that starts a box there does. */
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

/** Holds t1's first prepare before git makes anything, so its record is made only after whatever ends the attempt. */
function firstPrepareHeld(isolation: FakeWorktreeIsolation) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  const prepare = isolation.prepare.bind(isolation);
  vi.spyOn(isolation, 'prepare')
    .mockImplementationOnce(async (...args) => { entered(); await gate; return prepare(...args); })
    .mockImplementation(prepare);
  return { preparing, release };
}

describe('a late lease open after a cancel kept the worktree', () => {
  it('does not let go the record the cancel kept', async () => {
    const held = firstOpenHeldAfterPrepare();
    const env = setup(held.execution);
    env.orchestrator.loadPlan([task('t1', 1)]);
    const first = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await held.opened;
    await env.orchestrator.cancelTask('t1');
    const kept = env.orchestrator.runs.current?.tasks.t1;
    expect(kept?.status).toBe('kept');
    held.release();
    await first;
    await flushMicrotasks(20);

    expect(env.orchestrator.runs.current?.tasks.t1).toBe(kept);
    expect(env.orchestrator.runs.current?.tasks.t1?.status).toBe('kept');
  });

  it('keeps the record a prepare still in flight at the cancel makes', async () => {
    const env = setup();
    const held = firstPrepareHeld(env.isolation);
    env.orchestrator.loadPlan([task('t1', 1)]);
    const first = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await held.preparing;
    await env.orchestrator.cancelTask('t1');
    expect(env.orchestrator.runs.current?.tasks.t1).toBeUndefined();
    held.release();
    await first;
    await flushMicrotasks(20);

    expect(env.orchestrator.runs.current?.tasks.t1?.status).toBe('kept');
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.orchestrator.storeInstance.get('t1')?.status).toBe('pending');
  });
});

describe('a late lease open after a Stop', () => {
  it('keeps the worktree its open made, as a Stop keeps a running attempt\'s', async () => {
    const held = firstOpenHeldAfterPrepare();
    const env = setup(held.execution);
    env.orchestrator.loadPlan([task('t1', 1)]);
    const first = env.orchestrator.forceStartTask('t1').then(() => 'ok', (err: unknown) => err);
    await held.opened;
    env.orchestrator.stop();
    held.release();
    await first;
    await flushMicrotasks(20);

    expect(env.orchestrator.runs.current?.tasks.t1?.status).toBe('kept');
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.orchestrator.storeInstance.get('t1')?.status).toBe('pending');
  });
});
