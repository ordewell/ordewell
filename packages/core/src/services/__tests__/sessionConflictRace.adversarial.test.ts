import { describe, it, expect, vi } from 'vitest';
import { FakeWorktreeIsolation } from '../../testing';
import { FakeRunnerSession, fakeConfig, makeSession, taskOf } from './sessionTestKit';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { IConfig } from '../../interfaces/IConfig';
import type { TaskOrchestrator } from '../TaskOrchestrator';

/**
 * Adversarial: a conflict has one worker (ADR-0015), and a repair respects a
 * usage limit, in the orders of events the record and the claim can disagree on.
 */

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

interface Host {
  session: ReturnType<typeof makeSession>;
  orchestrator: TaskOrchestrator;
  isolation: FakeWorktreeIsolation;
  sessions: FakeRunnerSession[];
  spawned: () => string[];
  latest: (id: string) => FakeRunnerSession;
}

function host(isolation: FakeWorktreeIsolation, config: Partial<IConfig> = {}): Host {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const session = makeSession({
    isolation,
    config: fakeConfig({ conflictRepairAttempts: 2, ...config }),
    runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner,
    broadcast: () => {},
    onNotice: () => {},
  });
  const orchestrator = (session as unknown as { orchestrator: TaskOrchestrator }).orchestrator;
  return {
    session,
    orchestrator,
    isolation,
    sessions,
    spawned: () => sessions.map((s) => s.taskId),
    latest: (id) => sessions.filter((s) => s.taskId === id).at(-1)!,
  };
}

/** A repair whose `reopen` is held just before it records the task as `repairing`. */
class HeldReopen extends FakeWorktreeIsolation {
  entered!: () => void;
  enter = new Promise<void>((resolve) => { this.entered = resolve; });
  open: () => void = () => {};
  private gate = new Promise<void>((resolve) => { this.open = resolve; });

  override async reopen(t: Task, run: Parameters<FakeWorktreeIsolation['reopen']>[1]) {
    this.entered();
    await this.gate;
    return super.reopen(t, run);
  }
}

describe('adversarial: one worker per conflict', () => {
  it('refuses a resolver added while the repair is claimed but not yet marked repairing', async () => {
    const isolation = new HeldReopen();
    isolation.outcomes.set('t1', 'conflict');
    isolation.conflictFiles.set('t1', ['a.ts']);
    const env = host(isolation, { maxParallelSessions: 2 });
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', '/repo');

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await isolation.enter;

    // The repair attempt is live and its agent is about to start; the surfaces
    // still read the isolation record as `conflict`, so the resolve action is
    // offered. Adding a resolver here gives the conflict two workers.
    try {
      expect(env.orchestrator.getAttempt('t1')).toBeDefined();
      expect(taskOf(env.session, 't1')?.status).toBe('in_progress');
      await expect(env.session.resolveConflictAsTask('t1')).rejects.toThrow(/is repairing its conflict/);
      expect(env.session.planTasks).toHaveLength(1);
    } finally {
      isolation.open();
    }
    await vi.waitFor(() => expect(env.spawned()).toEqual(['t1', 't1']));
  }, 20_000);
});

const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";

const NO_RESET = "You've hit your session limit";

/** t2 hits its limit while t1 is at work; a reset it can read is what makes that a hold on the run. */
async function limited(env: Host, said = LIMIT): Promise<void> {
  env.latest('t2').emitEvent({ type: 'error', message: said, usageLimit: said === LIMIT ? { resetsAt: new Date(Date.now() + 3_600_000).toISOString() } : {} } as never);
  env.latest('t2').emitOutput(`${said}\n`);
  env.latest('t2').emitTurnEnd('failed');
  await vi.waitFor(() => expect(taskOf(env.session, 't2')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' }));
}

describe('adversarial: a repair respects a usage limit', () => {
  const conflicted = () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.outcomes.set('t1', 'conflict');
    return isolation;
  };
  // Long enough for the landing to settle, and for a repair that should wait to start.
  const landed = () => new Promise((resolve) => setTimeout(resolve, 300));
  const repairWait = (env: Host) => env.orchestrator.taskIsolation('t1');

  it('does not start a repair while the run is held on its runner\'s usage limit, and starts it after', async () => {
    const env = host(conflicted(), { maxParallelSessions: 2 });
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', '/repo');

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(new Set(env.spawned()).size).toBe(2));
    await limited(env);
    expect(env.orchestrator.awaitsResume).toBe(true);

    try {
      env.latest('t1').reportComplete({ status: 'done', summary: '' });
      await landed();

      expect(env.spawned().filter((id) => id === 't1')).toHaveLength(1);
      // Owed, as ADR-0015 has it: a repair that starts by itself is not a conflict to act on.
      expect(taskOf(env.session, 't1')?.status).toBe('pending');
      expect(repairWait(env)).toMatchObject({ state: 'conflict', repairWaits: 'usage-limit' });
      expect(repairWait(env)).not.toHaveProperty('repair');

      await env.orchestrator.resumeNow('t2');

      await vi.waitFor(() => expect(env.spawned().filter((id) => id === 't1')).toHaveLength(2));
      await vi.waitFor(() => expect(repairWait(env)).toMatchObject({ state: 'repairing', repair: { attempt: 1, limit: 2 } }));
    } finally {
      env.session.destroy();
    }
  }, 20_000);

  it('holds a repair of tasks started by hand too, with no scheduler to claim it after', async () => {
    const env = host(conflicted(), { maxParallelSessions: 2 });
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', '/repo');

    await env.orchestrator.forceStartTask('t1');
    await env.orchestrator.forceStartTask('t2');
    await limited(env);
    expect(env.orchestrator.isScheduling).toBe(false);

    try {
      env.latest('t1').reportComplete({ status: 'done', summary: '' });
      await landed();

      expect(env.spawned().filter((id) => id === 't1')).toHaveLength(1);
      expect(repairWait(env)).toMatchObject({ state: 'conflict', repairWaits: 'usage-limit' });

      await env.orchestrator.resumeNow('t2');

      await vi.waitFor(() => expect(env.spawned().filter((id) => id === 't1')).toHaveLength(2));
    } finally {
      env.session.destroy();
    }
  }, 20_000);

  it('holds a repair on its runner\'s limit when there is no reset to hold the run for', async () => {
    const env = host(conflicted(), { maxParallelSessions: 2 });
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', '/repo');

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(new Set(env.spawned()).size).toBe(2));
    await limited(env, NO_RESET);
    expect(env.orchestrator.awaitsResume).toBe(false);

    try {
      env.latest('t1').reportComplete({ status: 'done', summary: '' });
      await landed();

      expect(env.spawned().filter((id) => id === 't1')).toHaveLength(1);
      expect(repairWait(env)).toMatchObject({ state: 'conflict', repairWaits: 'usage-limit' });

      await env.orchestrator.retryTask('t2');

      await vi.waitFor(() => expect(env.spawned().filter((id) => id === 't1')).toHaveLength(2));
    } finally {
      env.session.destroy();
    }
  }, 20_000);
});
