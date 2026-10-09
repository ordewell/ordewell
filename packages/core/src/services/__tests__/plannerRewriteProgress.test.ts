import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { FakeRunnerSession, makeSession, testWorkspace, taskOf } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';

function recordingRunner(spawned: string[]): IRunner {
  return {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      spawned.push(taskId);
      return new FakeRunnerSession(`s-${taskId}`, taskId);
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as IRunner;
}

/** Two tasks already done in an earlier run, one left to do. */
function halfDonePlan(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'set it up', status: 'completed', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Build', prompt: 'build it', status: 'completed', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'Ship', prompt: 'ship it', dependencies: ['b'], assignedRunner: 'claude-code' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 3 tasks.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ],
  };
}

/**
 * What a planner hands back when asked to add a task and it answers with the
 * whole plan: every task it already had, as it chose to echo them, plus the
 * new one. Recorded from a real session — the finished tasks came back
 * `pending` with a placeholder prompt.
 */
function rewrittenWithAddedTask(current: readonly Task[]): Task[] {
  return [
    ...current.map((t) => ({
      ...t,
      status: 'pending' as const,
      prompt: t.status === 'completed' ? 'Completed in an earlier round; retained for dependency integrity.' : t.prompt,
    })),
    createTask({ id: 'd', order: current.length + 1, title: 'Docs', prompt: 'write the docs', dependencies: ['c'], assignedRunner: 'claude-code' }),
  ];
}

describe('a planner rewrite never undoes finished work', () => {
  it('keeps completed tasks completed when the planner answers an add with the whole plan', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => ({
          kind: 'plan' as const,
          tasks: rewrittenWithAddedTask(session.planTasks),
          text: '',
          researchLog: [],
        })),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(halfDonePlan(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('add a docs task');

    expect(taskOf(session, 'a')).toMatchObject({ status: 'completed', prompt: 'set it up' });
    expect(taskOf(session, 'b')).toMatchObject({ status: 'completed', prompt: 'build it' });
    expect(taskOf(session, 'd')).toBeDefined();

    await session.executePlan();
    expect(spawned).toEqual(['c']);
  });

  it('keeps completed tasks completed when a queued whole-plan edit lands between batches', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      planner: {
        modifyDuringExecution: vi.fn(async ({ pendingTasks }: { pendingTasks: Task[] }) => ({
          message: 'added',
          pendingTasks: rewrittenWithAddedTask(pendingTasks),
        })),
      },
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => ({
          kind: 'plan' as const,
          tasks: rewrittenWithAddedTask(session.planTasks),
          text: '',
          researchLog: [],
        })),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(halfDonePlan(), 'build it', testWorkspace, { persist: false });
    await session.executePlan(); // 'c' is live, so the whole-plan reply is queued
    expect(spawned).toEqual(['c']);

    await session.continueConversation('add a docs task');
    expect(session.getQueuedMessages().length).toBe(1);
    await session.processQueuedMessages();

    expect(taskOf(session, 'a')).toMatchObject({ status: 'completed', prompt: 'set it up' });
    expect(taskOf(session, 'b')).toMatchObject({ status: 'completed', prompt: 'build it' });
    expect(taskOf(session, 'c')!.status).toBe('in_progress');
    expect(taskOf(session, 'd')).toBeDefined();
    expect(spawned).toEqual(['c']);
  });

  it('keeps a task finished in this run when the between-batches edit leaves it out', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      planner: {
        // The between-batches prompt asks only for the tasks still to run, so
        // a planner that obeys it drops the ones already done.
        modifyDuringExecution: vi.fn(async ({ pendingTasks }: { pendingTasks: Task[] }) => ({
          message: 'added',
          pendingTasks: rewrittenWithAddedTask(pendingTasks.filter((t) => t.status !== 'completed')),
        })),
      },
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => ({ kind: 'plan' as const, tasks: [...session.planTasks], text: '', researchLog: [] })),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    const plan = halfDonePlan();
    plan.tasks[1] = createTask({ ...plan.tasks[1], status: 'pending' });
    plan.tasks.push(createTask({ id: 'e', order: 4, title: 'Lint', prompt: 'lint it', dependencies: ['a'], assignedRunner: 'claude-code' }));
    session.loadPlan(plan, 'build it', testWorkspace, { persist: false });
    await session.executePlan(); // 'b' and 'e' go live
    await session.markTaskComplete('e'); // finished in this run, so it is in the execution log
    expect(taskOf(session, 'e')!.status).toBe('completed');

    await session.continueConversation('add a docs task');
    await session.processQueuedMessages();

    expect(taskOf(session, 'a')).toMatchObject({ status: 'completed' });
    expect(taskOf(session, 'e')).toMatchObject({ status: 'completed', title: 'Lint' });
  });

  it('does not re-spawn a cancelled task when a paused run takes a whole-plan reply', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => ({
          kind: 'plan' as const,
          tasks: rewrittenWithAddedTask(session.planTasks),
          text: '',
          researchLog: [],
        })),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(halfDonePlan(), 'build it', testWorkspace, { persist: false });
    await session.executePlan();
    await session.cancelTask('c'); // the run stays armed with nothing live

    await session.continueConversation('add a docs task');

    expect(taskOf(session, 'c')!.status).toBe('pending');
    expect(spawned).toEqual(['c']);
  });

  it('tells the user and keeps the run going when a queued edit cannot be applied', async () => {
    const onNotice = vi.fn();
    const session = makeSession({
      runner: recordingRunner([]),
      onNotice,
      planner: {
        modifyDuringExecution: vi.fn().mockRejectedValue(new Error('Plan modification validation exhausted after 3 attempts')),
      },
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => ({ kind: 'plan' as const, tasks: [...session.planTasks], text: '', researchLog: [] })),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    const plan = halfDonePlan();
    session.loadPlan(plan, 'build it', testWorkspace, { persist: false });
    await session.executePlan();
    await session.continueConversation('add a docs task');

    await expect(session.processQueuedMessages()).resolves.toBeUndefined();

    expect(session.getQueuedMessages().length).toBe(0);
    expect(plan.queuedMessages ?? []).toEqual([]);
    expect(session.planTasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', message: expect.stringContaining('could not be applied') }));
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toMatch(/NOT applied/);
  });

  it('forgets a queued edit once it has been applied, so a reload cannot apply it again', async () => {
    const session = makeSession({
      runner: recordingRunner([]),
      planner: {
        modifyDuringExecution: vi.fn(async ({ pendingTasks }: { pendingTasks: Task[] }) => ({ message: 'ok', pendingTasks })),
      },
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => ({ kind: 'plan' as const, tasks: [...session.planTasks], text: '', researchLog: [] })),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    const plan = halfDonePlan();
    session.loadPlan(plan, 'build it', testWorkspace, { persist: false });
    await session.executePlan();
    await session.continueConversation('add a docs task');
    expect(plan.queuedMessages).toHaveLength(1);

    await session.processQueuedMessages();

    expect(session.getQueuedMessages().length).toBe(0);
    expect(plan.queuedMessages ?? []).toEqual([]);
  });
});
