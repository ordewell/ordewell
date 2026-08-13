import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { makeSession } from './sessionTestKit';

describe('planContextBlock task-shape fields', () => {
  function planWithMixedTasks(): LegacyPlanState {
    return {
      tasks: [
        createTask({
          id: 'ai-1',
          order: 1,
          title: 'Implement thing',
          prompt: 'do it',
          type: 'ai',
          autonomy: 'AFK',
          sliceType: 'AFK',
          taskMode: 'build',
          thinkingEffort: 'high',
        }),
        createTask({
          id: 'man-1',
          order: 2,
          title: 'Manually configure DNS',
          prompt: 'do it',
          type: 'user',
          autonomy: 'HITL',
          sliceType: 'HITL',
          userSteps: [
            { order: 1, instruction: 'Log into registrar', completed: false },
            { order: 2, instruction: 'Add TXT record', completed: false },
          ],
        }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
  }

  it('distinguishes an AI task from a MAN task, and shows step count instead of model/mode for MAN', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
      },
    });
    session.loadPlan(planWithMixedTasks(), 'Test goal', '/repo');

    await session.continueConversation('go on');
    const outgoing = continueConversation.mock.calls[0][0] as string;

    const aiLine = outgoing.split('\n').find((l) => l.includes('id=ai-1'));
    const manLine = outgoing.split('\n').find((l) => l.includes('id=man-1'));

    expect(aiLine).toContain('type:AI');
    expect(aiLine).toContain('autonomy:AFK');
    expect(aiLine).toContain('slice:AFK');
    expect(aiLine).toContain('mode:build');
    expect(aiLine).toContain('effort:high');

    expect(manLine).toContain('type:MAN');
    expect(manLine).toContain('autonomy:HITL');
    expect(manLine).toContain('slice:HITL');
    expect(manLine).toContain('steps:2');
    // Model/mode fields are meaningless for a MAN task and must not appear.
    expect(manLine).not.toContain('mode:');
    expect(manLine).not.toContain('model:');
  });

  it('shows each task\'s status and its dependencies by #order, not just id', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
      },
    });
    const plan = planWithMixedTasks();
    plan.tasks[1].dependencies = ['ai-1'];
    session.loadPlan(plan, 'Test goal', '/repo');

    await session.continueConversation('go on');
    const outgoing = continueConversation.mock.calls[0][0] as string;

    const aiLine = outgoing.split('\n').find((l) => l.includes('id=ai-1'));
    const manLine = outgoing.split('\n').find((l) => l.includes('id=man-1'));

    expect(aiLine).toContain('[pending]');
    expect(manLine).toContain('deps:[#1]');
  });

  it('keeps the per-turn plan block compact — a short suffix per task, not a paragraph, on a large plan', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
      },
    });
    const tasks = Array.from({ length: 40 }, (_, i) =>
      createTask({ id: `t${i + 1}`, order: i + 1, title: `Task ${i + 1}`, prompt: 'do it', assignedRunner: 'claude-code' }),
    );
    session.loadPlan(
      { tasks, generatedAt: new Date().toISOString(), status: 'approved', runners: ['claude-code'], lastUpdated: new Date().toISOString() },
      'Test goal',
      '/repo',
    );

    await session.continueConversation('go on');
    const outgoing = continueConversation.mock.calls[0][0] as string;

    const taskLines = outgoing.split('\n').filter((l) => l.includes('id=t'));
    expect(taskLines).toHaveLength(40);
    // A short scalar-only line per task, not a paragraph — bound generously.
    for (const line of taskLines) expect(line.length).toBeLessThan(200);
  });

  it('advertises every field the applier accepts, including previously-unadvertised ones like type and autonomy', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
      },
    });
    session.loadPlan(planWithMixedTasks(), 'Test goal', '/repo');

    await session.continueConversation('go on');
    const outgoing = continueConversation.mock.calls[0][0] as string;

    for (const field of ['type', 'autonomy', 'sliceType', 'thinkingEffort', 'userSteps', 'taskMode']) {
      expect(outgoing).toContain(`"${field}"`);
    }
  });

  it('lets the planner flip a field the protocol previously failed to advertise (sliceType)', async () => {
    const session = makeSession({
      aiService: {
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: 'ai-1', changes: { sliceType: 'HITL' } }],
          text: '{"taskOps":[...]}',
          researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithMixedTasks(), 'Test goal', '/repo', { persist: false });

    await session.continueConversation('flip task 1 to a HITL slice');

    expect(session.planTasks.find((t) => t.id === 'ai-1')!.sliceType).toBe('HITL');
  });
});
