import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { FakeRunnerSession } from '../../testing';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { fakeConfig, fakeNotification, makeSession, testWorkspace } from './sessionTestKit';

/**
 * A plan start is asynchronous: the command seam admits it, the run opens, and
 * only then does the first task claim. These tests hold the scheduler inside
 * that window with a spawn that does not answer, and read the activity a
 * surface draws and a manual override guards itself against.
 */

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function task(id: string, order: number): Task {
  return createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code' });
}

function planOf(tasks: Task[]): LegacyPlanState {
  return {
    tasks,
    generatedAt: '2026-10-11T17:00:00Z',
    lastUpdated: '2026-10-11T17:00:00Z',
    status: 'approved',
    runners: ['claude-code'],
    conversationHistory: [],
  };
}

/** A runner whose spawn waits until the test lets it through, so the run stays in its startup window. */
function heldRunner(): {
  runner: IRunner;
  release(): void;
  spawn: ReturnType<typeof vi.fn>;
} {
  const gate = deferred();
  const spawn = vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
    await gate.promise;
    return new FakeRunnerSession(`s-${taskId}`, taskId);
  });
  return {
    runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } satisfies IRunner,
    release: () => gate.resolve(),
    spawn,
  };
}

function sessionWith(runner: IRunner, tasks: Task[] = [task('t1', 1)]) {
  const session = makeSession({ runner, config: fakeConfig({ maxParallelSessions: 2 }) });
  session.loadPlan(planOf(tasks), 'build it', testWorkspace);
  return session;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the run activity while a plan start is admitted', () => {
  it('says starting before anything claims, and running once it does', async () => {
    const held = heldRunner();
    const session = sessionWith(held.runner);

    const started = session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(session.activity).toEqual({ starting: true, running: false, scheduled: true, resumable: false, advancesOnItsOwn: true, waitsOnUser: false });

    held.release();
    expect(await started).toMatchObject({ ok: true });

    expect(session.activity.starting).toBe(false);
    expect(session.activity.running).toBe(true);
    session.stopExecution();
  });

  it('coalesces a second Execute while the first is still opening the run', async () => {
    const held = heldRunner();
    const session = sessionWith(held.runner);

    const first = session.execute({ command: 'run_plan' }, { kind: 'user' });
    const second = session.execute({ command: 'run_plan' }, { kind: 'user' });

    held.release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);

    expect(held.spawn).toHaveBeenCalledTimes(1);
    session.stopExecution();
  });

  it('settles the start as stopped when Stop comes while it is still opening', async () => {
    const held = heldRunner();
    const session = sessionWith(held.runner);

    const started = session.execute({ command: 'run_plan' }, { kind: 'user' });
    await session.execute({ command: 'stop_run' }, { kind: 'user' });

    const outcome = await started;

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.message).toMatch(/stopped before it could start/i);
    expect(held.spawn).not.toHaveBeenCalled();
    expect(session.activity).toEqual({ starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false, waitsOnUser: false });
  });

  it('starts a fresh run when Execute follows a Stop that came while the first was still opening', async () => {
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const spawn = vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return new FakeRunnerSession(`s-${taskId}-${gates.length}`, taskId);
    });
    const session = sessionWith({ spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } satisfies IRunner);

    const first = session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await session.execute({ command: 'stop_run' }, { kind: 'user' });

    // The stopped opening is still awaiting its spawn; the new Execute must not join it.
    const second = session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    gates.forEach((gate) => gate.resolve());
    const [stopped, restarted] = await Promise.all([first, second]);

    expect(stopped.ok).toBe(false);
    expect(restarted).toMatchObject({ ok: true, message: expect.stringMatching(/task #1 .*started/i) });
    expect(session.activity.running).toBe(true);
    session.stopExecution();
  });

  it('settles the start window when an admitted start is let go without claiming', () => {
    const held = heldRunner();
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig(), notifications: fakeNotification(), runner: held.runner,
    });
    const changed = vi.fn();
    orchestrator.subscribe({ onTaskChanged: changed });

    const admission = orchestrator.admitStart();
    expect(orchestrator.activity.starting).toBe(true);

    admission.release();

    expect(orchestrator.activity.starting).toBe(false);
    // A surface that drew "Starting…" is told the window ended.
    expect(changed).toHaveBeenCalled();
  });

  it('is idle when the plan has nothing left to run', async () => {
    const held = heldRunner();
    const session = sessionWith(held.runner, [{ ...task('t1', 1), status: 'completed' }]);

    const outcome = await session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(outcome.ok).toBe(false);
    expect(session.activity).toEqual({ starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false, waitsOnUser: false });
  });
});
