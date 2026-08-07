import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import * as sessionStore from '../../utils/sessionStore';
import { FakeTerminalSession, makeSession, testWorkspace } from './sessionTestKit';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';

/** A runner double that records the order tasks were spawned in. */
function recordingRunner(spawned: string[]): ITerminalRunner {
  return {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      spawned.push(taskId);
      return new FakeTerminalSession(`s-${taskId}`, taskId);
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as ITerminalRunner;
}

function planWithTasks(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Build', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ],
  };
}

/**
 * A plan the scheduler has already run into a pause: one completed AI task, one
 * AI task the user cancelled (on hold) and one pending `user` task. Nothing is
 * live, but `tick()` keeps the scheduler armed so the user task can still fan
 * its dependents out.
 */
function pausedRunPlan(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', status: 'completed', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Build', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'Sign off', type: 'user', dependencies: ['a'], assignedRunner: 'claude-code' }),
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

describe('task_ops conversation turns', () => {
  it('applies valid ops, records a transcript entry, and broadcasts the plan', async () => {
    const broadcast = vi.fn();
    const session = makeSession({
      broadcast,
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#2', changes: { title: 'Build v2' } }],
          text: '{"taskOps":[...]}',
          researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'build it', testWorkspace, { persist: false });

    const plan = await session.continueConversation('rename task 2 to Build v2');

    expect(session.planTasks.find((t) => t.id === 'b')!.title).toBe('Build v2');
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('Updated "Build"');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'planner_message' }));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'plan_generated' }));
  });

  it('runs the mutatePlan ritual for an applied task_ops turn: persist strictly before broadcast', async () => {
    const order: string[] = [];
    const broadcast = vi.fn(() => order.push('broadcast'));
    const session = makeSession({
      broadcast,
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#2', changes: { title: 'Build v2' } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'build it', testWorkspace, { persist: false });
    vi.mocked(sessionStore.saveSession).mockClear();
    vi.mocked(sessionStore.saveSession).mockImplementation(() => {
      order.push('persist');
      return { id: 'x', goal: '', runners: [], taskCount: 0, status: 'approved', createdAt: '', updatedAt: '' };
    });

    await session.continueConversation('rename task 2');

    expect(order[0]).toBe('persist');
    expect(order).toContain('broadcast');
  });

  it('feeds validation errors back and applies the corrected retry', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce({
        kind: 'task_ops',
        ops: [{ op: 'update', taskId: 'a', changes: { dependencies: ['b'] } }], // cycle a->b->a
        text: '', researchLog: [],
      })
      .mockResolvedValueOnce({
        kind: 'task_ops',
        ops: [{ op: 'update', taskId: 'a', changes: { title: 'Setup v2' } }],
        text: '', researchLog: [],
      });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'g', testWorkspace, { persist: false });

    await session.continueConversation('tweak the plan');

    expect(continueConversation).toHaveBeenCalledTimes(2);
    expect(String(continueConversation.mock.calls[1][0])).toMatch(/rejected/);
    expect(session.planTasks[0].title).toBe('Setup v2');
    expect(session.planTasks[0].dependencies).toEqual([]);
  });

  it('gives up after retries and surfaces the errors with the plan untouched', async () => {
    const badTurn = {
      kind: 'task_ops',
      ops: [{ op: 'remove', taskId: 'nope' }],
      text: '', researchLog: [],
    };
    const continueConversation = vi.fn().mockResolvedValue(badTurn);
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'g', testWorkspace, { persist: false });

    const plan = await session.continueConversation('remove something');

    // 1 initial + 2 retries
    expect(continueConversation).toHaveBeenCalledTimes(3);
    expect(session.planTasks).toHaveLength(2);
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toMatch(/invalid/i);
    expect(last.content).toContain('not found');
  });

  // First turn and later turns settle through the same path — a task_ops
  // emitted straight out of startPlanning gets the same corrective retries.
  it('retries an invalid first-turn task_ops from startPlanning', async () => {
    const startConversation = vi.fn(async () => ({
      kind: 'task_ops' as const,
      ops: [{ op: 'remove' as const, taskId: 'nope' }],
      text: '', researchLog: [],
    }));
    const continueConversation = vi.fn().mockResolvedValue({
      kind: 'message', text: 'sorry, which task?', researchLog: [],
    });
    const session = makeSession({
      aiService: {
        startConversation,
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });

    const plan = await session.startPlanning('goal', ['claude-code']);

    expect(continueConversation).toHaveBeenCalledTimes(1);
    expect(String(continueConversation.mock.calls[0][0])).toMatch(/rejected/);
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toBe('sorry, which task?');
  });

  it('applies edits immediately when the scheduler is armed but no runner is live', async () => {
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#3', changes: { title: 'Sign off with the team' } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.executePlan();
    await session.cancelTask('b');

    // The scheduler is still armed — that is what used to make the edit queue.
    expect(session.isExecuting).toBe(true);

    const plan = await session.continueConversation('rename the sign-off step');

    expect(session.planTasks.find((t) => t.id === 'c')!.title).toBe('Sign off with the team');
    expect(session.queuedCount).toBe(0);
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).not.toMatch(/queued/i);
  });

  it('still queues an edit while a task session is genuinely live', async () => {
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#3', changes: { title: 'Sign off with the team' } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.executePlan(); // spawns #2 and leaves it running

    const plan = await session.continueConversation('rename the sign-off step');

    expect(session.planTasks.find((t) => t.id === 'c')!.title).toBe('Sign off'); // nothing applied live
    expect(session.getQueuedMessages().map((m) => m.text)).toEqual(['rename the sign-off step']);
    expect(session.queuedCount).toBe(1);
    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.content).toMatch(/queued your change/i);
    expect(last.content).toContain('(1 queued)');
  });

  it('re-ticks an armed-but-idle scheduler so an added task with satisfied deps fans out', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'add', task: { title: 'Docs', description: 'write docs', prompt: 'write the docs', dependencies: ['a'] } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.executePlan();
    await session.cancelTask('b');

    await session.continueConversation('add a docs task after setup');

    const added = session.planTasks.find((t) => t.title === 'Docs')!;
    expect(spawned).toContain(added.id);
  });

  // Only Retry / Force Start / Run release a hold. An edit landing under an
  // armed scheduler must adopt the new tasks without also re-arming everything
  // the user pulled out of the schedule.
  it('leaves a cancelled task on hold when an edit lands under an armed scheduler', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: '#3', changes: { title: 'Sign off with the team' } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.executePlan();
    await session.cancelTask('b');

    await session.continueConversation('rename the sign-off step');

    expect(spawned).toEqual(['b']); // the one pre-cancel spawn, not a second
  });

  it('does not promise the planner a queue when no runner is live', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'two left', researchLog: [] });
    const session = makeSession({
      runner: recordingRunner([]),
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.executePlan();
    await session.cancelTask('b');

    await session.continueConversation('what is left?');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).not.toMatch(/Execution is RUNNING/);
    expect(outgoing).not.toMatch(/queued/i);
  });

  it('names the locked in_progress tasks while a runner is live', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      runner: recordingRunner([]),
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.executePlan();

    await session.continueConversation('what is left?');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).toMatch(/Execution is RUNNING — these tasks are locked: #2/);
    expect(outgoing).toMatch(/queued/i);
  });

  it('injects the current plan context into the outgoing message but not the transcript', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'two tasks so far', researchLog: [] });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'g', testWorkspace, { persist: false });

    const plan = await session.continueConversation('how many tasks are there?');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).toContain('<current_plan>');
    expect(outgoing).toContain('taskOps');
    expect(outgoing).toContain('how many tasks are there?');
    const userEntries = plan.conversationHistory!.filter((m) => m.role === 'user');
    expect(userEntries[userEntries.length - 1].content).toBe('how many tasks are there?');
  });
});

describe('requestMerge — planner-driven merge', () => {
  it('routes a merge through the conversation loop and applies the merge op', async () => {
    const continueConversation = vi.fn().mockResolvedValue({
      kind: 'task_ops',
      ops: [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'Setup + Build', prompt: 'do both' } }],
      text: '{"taskOps":[...]}',
      researchLog: [],
    });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'build it', testWorkspace, { persist: false });

    await session.requestMerge(['a', 'b']);

    // The outgoing message carries the merge intent + the plan context block.
    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).toContain('Merge');
    expect(outgoing).toContain('<current_plan>');
    expect(outgoing).toContain('"merge"');
    // Two tasks collapsed into one.
    expect(session.planTasks).toHaveLength(1);
    expect(session.planTasks[0].title).toBe('Setup + Build');
  });

  it('throws a pre-flight compatibility error before any LLM call', async () => {
    const continueConversation = vi.fn();
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'g', testWorkspace, { persist: false });

    await expect(session.requestMerge(['a'])).rejects.toThrow(/at least two/i);
    expect(continueConversation).not.toHaveBeenCalled();
  });

  it('feeds an invalid merge back and applies the corrected retry', async () => {
    const continueConversation = vi.fn()
      .mockResolvedValueOnce({
        kind: 'task_ops',
        ops: [{ op: 'merge', taskIds: ['a', 'b'], merged: {} }], // missing title
        text: '', researchLog: [],
      })
      .mockResolvedValueOnce({
        kind: 'task_ops',
        ops: [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'Setup + Build' } }],
        text: '', researchLog: [],
      });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'g', testWorkspace, { persist: false });

    await session.requestMerge(['a', 'b']);

    expect(continueConversation).toHaveBeenCalledTimes(2);
    expect(String(continueConversation.mock.calls[1][0])).toMatch(/rejected/);
    expect(session.planTasks).toHaveLength(1);
    expect(session.planTasks[0].title).toBe('Setup + Build');
  });
});

describe('requestSplit — planner-driven split', () => {
  it('routes a split through the conversation loop and applies the split op', async () => {
    const continueConversation = vi.fn().mockResolvedValue({
      kind: 'task_ops',
      ops: [{
        op: 'split', taskId: 'b',
        parts: [
          { title: 'Build core', prompt: 'core' },
          { title: 'Build UI', prompt: 'ui' },
        ],
      }],
      text: '{"taskOps":[...]}',
      researchLog: [],
    });
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithTasks(), 'build it', testWorkspace, { persist: false });

    await session.requestSplit('b');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).toContain('Split');
    expect(outgoing).toContain('<current_plan>');
    expect(outgoing).toContain('"split"');
    // One task replaced by two.
    expect(session.planTasks).toHaveLength(3);
    const parts = session.planTasks.filter((t) => t.title.startsWith('Build'));
    expect(parts).toHaveLength(2);
    expect(parts[1].dependencies).toEqual([parts[0].id]);
  });

  it('throws a pre-flight error for a completed task before any LLM call', async () => {
    const continueConversation = vi.fn();
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    const plan = planWithTasks();
    plan.tasks[1].status = 'completed';
    session.loadPlan(plan, 'g', testWorkspace, { persist: false });

    await expect(session.requestSplit('b')).rejects.toThrow(/completed/i);
    expect(continueConversation).not.toHaveBeenCalled();
  });
});
