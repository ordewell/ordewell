import { describe, it, expect, vi } from 'vitest';
import { PlanStore } from '../PlanStore';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { makeSession, testWorkspace, saves } from './sessionTestKit';
import { augmentPromptWithPriorOutputs } from '../promptAugment';

function savedDialoguePlan(): LegacyPlanState {
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
  };
}

describe('conversation resume after session load', () => {
  it('reseeds a fresh conversation with the persisted history and the new message', async () => {
    const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok, resuming', researchLog: [] });
    const session = makeSession({
      aiService: {
        startConversation,
        continueConversation: vi.fn(),
        hasActiveConversation: () => false,
        reset: vi.fn(),
      },
    });

    session.loadPlan(savedDialoguePlan(), 'build me a parser', testWorkspace, { persist: false });
    await session.continueConversation('JSON and YAML');

    expect(startConversation).toHaveBeenCalledTimes(1);
    const req = startConversation.mock.calls[0][0];
    expect(req.goal).toBe('build me a parser');
    // The always-on catalog block (models + task modes) precedes the raw
    // message on every turn, including a resumed pre-plan interview.
    expect(req.initialMessage).toContain('<available_models>');
    expect(req.initialMessage.endsWith('JSON and YAML')).toBe(true);
    expect(req.priorHistory).toHaveLength(2);
    expect(req.priorHistory[1].content).toBe('Which file formats?');
  });

  it('does not reseed when the in-memory conversation is still alive', async () => {
    const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'first', researchLog: [] });
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'second', researchLog: [] });
    const session = makeSession({
      aiService: {
        startConversation,
        continueConversation,
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });

    await session.startPlanning('goal', ['claude-code']);
    await session.continueConversation('a reply');

    expect(startConversation).toHaveBeenCalledTimes(1);
    expect(continueConversation).toHaveBeenCalledTimes(1);
  });

  it('loading a plan makes no LLM call', async () => {
    const startConversation = vi.fn();
    const session = makeSession({
      aiService: {
        startConversation,
        continueConversation: vi.fn(),
        hasActiveConversation: () => false,
        reset: vi.fn(),
      },
    });

    session.loadPlan(savedDialoguePlan(), 'goal', testWorkspace, { persist: false });

    expect(startConversation).not.toHaveBeenCalled();
  });

  it('loadPlan adopts the saved session id so persists target the same file', () => {
    const session = makeSession();
    session.loadPlan(savedDialoguePlan(), 'goal', testWorkspace, { sessionId: 'session-1234' });
    expect(session.sessionId).toBe('session-1234');
    expect(saves(session)).toHaveBeenCalledWith(
      expect.anything(), 'goal', testWorkspace, 'session-1234',
    );
  });
});

describe('plan_generated markers', () => {
  it('a committed plan appends a plan_generated marker to the dialogue', async () => {
    const session = makeSession({
      aiService: {
        startConversation: vi.fn().mockResolvedValue({
          kind: 'plan',
          tasks: [createTask({ id: 't1', order: 1, title: 'T', prompt: 'p', assignedRunner: 'claude-code' })],
          text: '{"tasks":[]}',
          researchLog: [],
        }),
        continueConversation: vi.fn(),
        hasActiveConversation: () => false,
        reset: vi.fn(),
      },
    });

    const plan = await session.startPlanning('goal', ['claude-code']);

    const last = plan.conversationHistory![plan.conversationHistory!.length - 1];
    expect(last.kind).toBe('plan_generated');
    expect(last.role).toBe('assistant');
  });
});

describe('a session saved before task reports were kept', () => {
  it('loads its output summaries unchanged, and still hands dependents the tail', () => {
    const saved = JSON.parse(`{
      "tasks": [
        { "id": "a", "order": 1, "title": "Setup", "description": "", "type": "ai", "status": "completed", "dependencies": [], "subtasks": [], "prompt": "p", "assignedRunner": "claude-code",
          "outputSummary": { "reviewReason": "Verified", "logTail": "created src/db.ts", "capturedAt": "2026-01-01T00:00:00Z" } },
        { "id": "b", "order": 2, "title": "Wire", "description": "", "type": "ai", "status": "pending", "dependencies": ["a"], "subtasks": [], "prompt": "wire it", "assignedRunner": "claude-code" }
      ],
      "generatedAt": "2026-01-01T00:00:00Z", "lastUpdated": "2026-01-01T00:00:00Z", "status": "approved", "runners": ["claude-code"],
      "conversationHistory": [{ "role": "user", "content": "set it up", "timestamp": "2026-01-01T00:00:00Z" }]
    }`) as LegacyPlanState;
    const session = makeSession();

    session.loadPlan(saved, 'set it up', testWorkspace, { persist: false });

    const [setup, wire] = session.planTasks;
    expect(setup.outputSummary).toEqual({ reviewReason: 'Verified', logTail: 'created src/db.ts', capturedAt: '2026-01-01T00:00:00Z' });
    expect(augmentPromptWithPriorOutputs(wire, session.planTasks)).toContain('- Tail:\n  created src/db.ts');
  });
});

describe('PlanStore.load status handling', () => {
  it('preserves completed tasks and reports them as satisfied dependencies', () => {
    const store = new PlanStore();
    store.load([
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p', status: 'completed' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'p', status: 'pending', dependencies: ['a'] }),
    ], ['claude-code']);

    expect(store.get('a')!.status).toBe('completed');
    expect(store.isCompleted('a')).toBe(true);
    expect(store.get('b')!.status).toBe('pending');
  });

  it('keeps a failed task failed: the fresh chance is Execute\'s to give', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'a', order: 1, title: 'A', prompt: 'p', status: 'failed' })], ['claude-code']);
    expect(store.isFailed('a')).toBe(true);

    store.resetForRun({ edited: true });
    expect(store.isFailed('a')).toBe(true);

    store.resetForRun();
    expect(store.get('a')!.status).toBe('approved');
  });

  it('gives a task an edit made manual after it failed its fresh chance too, though no run readies it', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'a', order: 1, title: 'A', type: 'user', status: 'failed' })], ['claude-code']);

    store.resetForRun();

    expect(store.get('a')!.status).toBe('pending');
  });
});
