import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createEmptyPlan, createTask, type LegacyPlanState, type PlanState } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

const BODY = 'SECRET-SKILL-BODY';
const load = { invokedBy: 'user' as const, name: 'grilling', source: 'global' as const, path: '~/.ordewell/skills/grilling/SKILL.md', content: BODY };

/** A plan as the session holds it: every kind of skill body it can carry. */
function planWithBodies(): LegacyPlanState {
  return {
    ...createEmptyPlan(),
    tasks: [{ ...createTask({ id: 't1' }), attemptSkills: [{ name: 'tdd', source: 'global', path: '~/.ordewell/skills/tdd/SKILL.md', content: BODY }] }],
    conversationHistory: [{ role: 'user', content: 'loaded', timestamp: '2026-01-01T00:00:00Z', kind: 'skill_load', skill: load }],
    queuedMessages: [{ id: 'q1', text: '/grilling go', timestamp: '2026-01-01T00:00:01Z', skills: [load] }],
    researchLog: [{
      id: 'rs1', tool: 'agent_tool', toolLabel: 'mcp__ordewell__load_skill', args: '{"name":"grilling"}',
      result: BODY, success: true, outcome: 'success', timestamp: '2026-01-01T00:00:02Z',
    }],
  };
}

function appFor(pool: unknown) {
  const app = new Hono();
  app.route('/api/plans', plansRoute(pool as OrchestratorPool));
  return app;
}

const post = (app: Hono, path: string, body: unknown = {}) =>
  app.request(`/api/plans/s1/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function expectNoBodies(res: Response): Promise<void> {
  const text = await res.text();
  expect(res.status).toBe(200);
  expect(text).not.toContain(BODY);
  expect(text).toContain('grilling');
}

describe('plan routes keep skill bodies off the wire', () => {
  const session = {
    approveReview: async () => planWithBodies(),
    requestMerge: async () => planWithBodies(),
    requestSplit: async () => planWithBodies(),
    resolveConflictAsTask: async () => planWithBodies(),
  };
  const pool = {
    session: () => session,
    startPlanning: async () => planWithBodies(),
    continuePlanning: async () => planWithBodies(),
    getProviderModels: async () => ({ models: [], modelsByRunner: {} }),
    getRunnerState: () => ({ enabledRunners: ['claude-code'] }),
    forkConversation: () => ({ sessionId: 's2', goal: 'g', plan: planWithBodies() }),
    rewindConversation: () => ({ sessionId: 's2', goal: 'g', plan: planWithBodies(), rewoundMessage: 'm' }),
    compactConversation: async () => ({ plan: planWithBodies(), compacted: 2 }),
    generatePlan: async (): Promise<PlanState> => ({
      phase: 'planning', history: [], message: '', pendingTasks: [{ ...createTask({ id: 't1' }), attemptSkills: [{ name: 'grilling', source: 'global', path: 'p', content: BODY }] }],
    }),
  };

  it.each([
    ['review/approve', {}],
    ['tasks/merge', { taskIds: ['a', 'b'] }],
    ['tasks/t1/split', {}],
    ['tasks/t1/resolve-conflict', {}],
    ['converse/start', { goal: 'g', runners: ['claude-code'], workspace: '/ws' }],
    ['converse/message', { message: 'hi' }],
    ['conversation/fork', {}],
    ['conversation/rewind', { index: 0 }],
    ['conversation/compact', {}],
    ['generate', { goal: 'g', runners: ['claude-code'], workspace: '/ws' }],
  ])('POST %s', async (route, body) => {
    await expectNoBodies(await post(appFor(pool), route, body));
  });
});

describe('POST generate', () => {
  it('answers with the notes the one-shot plan\'s transcript records', async () => {
    const plan: LegacyPlanState = {
      ...createEmptyPlan(),
      conversationHistory: [{ role: 'assistant', content: 'Skill check:\n- Task "A": skill "later" not found', timestamp: '2026-01-01T00:00:00Z', kind: 'system' }],
    };
    const pool = {
      session: () => ({ planState: plan }),
      generatePlan: async (): Promise<PlanState> => ({ phase: 'planning', history: [], message: '', pendingTasks: [] }),
      getProviderModels: async () => ({ models: [], modelsByRunner: {} }),
    };

    const res = await post(appFor(pool), 'generate', { goal: 'g', runners: ['claude-code'], workspace: '/ws' });

    expect(((await res.json()) as { notes?: string[] }).notes).toEqual(['Skill check:\n- Task "A": skill "later" not found']);
  });
});
