import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { FakeStructuredSession, makeSession, saves, testWorkspace } from './sessionTestKit';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';

/** A runner double that records the order tasks were spawned in. */
function recordingRunner(spawned: string[]): ITerminalRunner {
  return {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      spawned.push(taskId);
      return new FakeStructuredSession(`s-${taskId}`, taskId);
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as ITerminalRunner;
}

function dialoguePlan(): LegacyPlanState {
  return {
    tasks: [],
    generatedAt: new Date().toISOString(),
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Which file formats?', timestamp: '2026-01-01T00:00:01Z' },
    ],
    researchLog: [
      { id: 'r-1', type: 'user_prompt', content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' },
    ],
  };
}

/**
 * A plan the scheduler has already run into a pause: one completed AI task, one
 * AI task the user cancelled (on hold) and one pending `user` task. Nothing is
 * live, but `tick()` keeps the scheduler armed so a landed edit can still fan
 * work out — which is how the persist-then-throw scenario below is reached.
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
    researchLog: [],
  };
}

describe('continueConversation rollback on failure', () => {
  // The transport can reject for reasons unrelated to the session (a model or
  // planner switch leaving the AI adapter mismatched). The user message this
  // call appended is only in memory — it must come back out, or every failed
  // retry silently diverges session memory from what is on disk / shown.
  it('rolls back this call\'s own unpersisted append when the AI transport rejects', async () => {
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockRejectedValue(new Error('planner transport mismatch')),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(dialoguePlan(), 'build me a parser', testWorkspace, { persist: false });

    await expect(session.continueConversation('JSON and YAML')).rejects.toThrow('planner transport mismatch');

    expect(session.planState!.conversationHistory).toHaveLength(2);
    expect(session.planState!.conversationHistory![1].content).toBe('Which file formats?');
    expect(session.planState!.researchLog).toHaveLength(1);
  });

  // `settleTurn` can persist a task_ops turn and only *then* hit a throwing
  // step (the re-tick that fans the edited plan out, via the orchestrator's
  // onTaskChanged observer). The orchestrator isolates a throwing observer
  // from its own scheduling (TaskOrchestrator.emit), so this no longer
  // reaches the caller as a rejection — but the guard this exercises is that
  // the already-persisted, already-broadcast task_ops turn is never rolled
  // back regardless.
  it('keeps an already-persisted task_ops turn when the re-tick broadcast fails', async () => {
    const spawned: string[] = [];
    let armed = false;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broadcast = vi.fn((msg: { type: string }) => {
      // The mutatePlan notify broadcasts planner_message/plan_generated; only
      // the re-tick's status_update is the "later step" that fails.
      if (armed && msg.type === 'status_update') throw new Error('boom after persist');
    });
    const session = makeSession({
      runner: recordingRunner(spawned),
      broadcast,
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

    armed = true;
    const plan = await session.continueConversation('add a docs task');
    armed = false;

    // 2 pre-call + the user message + the assistant task_ops entry — the
    // persisted turn survives the broadcast failure, and the call itself no
    // longer fails on account of it.
    expect(plan.conversationHistory).toHaveLength(4);
    expect(plan.conversationHistory![3].content).toContain('Tasks updated');
    expect(plan.researchLog).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe('continueConversation rollback when a task settles mid-turn', () => {
  // A verdict is saved the moment it lands, the in-flight turn's user message
  // with it. That save is not the turn landing: a turn that then fails still
  // takes its message back out, and the undo reaches disk too.
  it('rolls back the failed turn in memory and on disk', async () => {
    const live = new Map<string, FakeStructuredSession>();
    const runner = {
      spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
        const s = new FakeStructuredSession(`s-${taskId}`, taskId);
        live.set(taskId, s);
        return s;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as ITerminalRunner;
    let finishTask = (): void => {};
    const session = makeSession({
      runner,
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => {
          finishTask();
          await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'));
          throw new Error('planner transport down');
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    const plan = dialoguePlan();
    plan.tasks = [createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', assignedRunner: 'claude-code' })];
    session.loadPlan(plan, 'build me a parser', testWorkspace, { persist: false });
    await session.executePlan();
    finishTask = () => {
      live.get('a')!.reportComplete({ status: 'done', summary: '' });
      live.get('a')!.emitOutput(`\n`);
      live.get('a')!.emitExit(0);
    };

    await expect(session.continueConversation('JSON and YAML')).rejects.toThrow('planner transport down');

    expect(session.planState!.conversationHistory!.map((m) => m.content)).toEqual(['build me a parser', 'Which file formats?']);
    const onDisk = saves(session).mock.calls.at(-1)![0];
    expect(onDisk.conversationHistory!.map((m) => m.content)).toEqual(['build me a parser', 'Which file formats?']);
    expect(onDisk.tasks[0].status).toBe('completed');
  });
});
