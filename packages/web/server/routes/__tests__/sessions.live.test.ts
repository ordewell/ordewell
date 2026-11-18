import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { loadSession, migratePlanState as migratePlanStateOf, type LegacyPlanState } from '@ordewell/core';
import { sessionsRoute } from '../sessions';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

vi.mock('@ordewell/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ordewell/core')>()),
  loadSession: vi.fn(),
}));

const readSaved = vi.mocked(loadSession);

// What a save writes for this plan: the file's meta is computed from the plan, so a live read can say the same.
const plan = {
  tasks: [
    { id: 't1', order: 1, title: 'One', status: 'pending', subtasks: [{ id: 't1.1', order: 1, title: 'Sub', status: 'pending' }] },
    { id: 't2', order: 2, title: 'Two', status: 'pending' },
  ],
  generatedAt: '2026-10-25T10:00:00.000Z',
  lastUpdated: '2026-10-25T10:05:00.000Z',
  status: 'approved',
  runners: ['opencode'],
  conversationHistory: [{ role: 'user', content: 'Add rate limiting', timestamp: '2026-10-25T10:00:00.000Z' }],
} as unknown as LegacyPlanState;
const meta = { id: 's1', goal: 'Rate limiting', runners: ['opencode'], taskCount: 3, status: 'approved', createdAt: plan.generatedAt, updatedAt: plan.lastUpdated };

function pool(live: boolean): OrchestratorPool {
  return {
    holds: vi.fn().mockReturnValue(live),
    getPlan: vi.fn().mockReturnValue(live ? plan : null),
    getPlanState: vi.fn().mockReturnValue(live ? migrate() : null),
    getGoal: vi.fn().mockReturnValue('Rate limiting'),
    runSnapshot: vi.fn().mockReturnValue(null),
    plannerTurnId: vi.fn().mockReturnValue(undefined),
    plannerCompaction: vi.fn().mockReturnValue(undefined),
    streamPosition: vi.fn().mockReturnValue({ stream: 'daemon', seq: 12 }),
  } as unknown as OrchestratorPool;
}

function migrate() {
  // The state a live store holds for the plan above, as the saved file migrates to.
  return migratePlanStateOf(plan);
}


async function read(p: OrchestratorPool): Promise<Record<string, unknown>> {
  const app = new Hono();
  app.route('/api/sessions', sessionsRoute(p));
  const res = await app.request('/api/sessions/s1?workspace=/ws');
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /api/sessions/:id for a live session', () => {
  beforeEach(() => {
    readSaved.mockReset();
    readSaved.mockReturnValue({ meta, plan } as never);
  });

  it('answers from the pool without reading the session file', async () => {
    await read(pool(true));

    expect(readSaved).not.toHaveBeenCalled();
  });

  it('says what the saved file would, apart from the stream position only a live session has', async () => {
    const live = await read(pool(true));
    const saved = await read(pool(false));

    expect(readSaved).toHaveBeenCalledTimes(1);
    const { position, ...liveRest } = live;
    expect(position).toEqual({ stream: 'daemon', seq: 12 });
    expect(liveRest).toEqual(saved);
  });

  it('still reads the file for a session the pool does not hold, and answers 404 when there is none', async () => {
    readSaved.mockReturnValue(null);
    const app = new Hono();
    app.route('/api/sessions', sessionsRoute(pool(false)));

    expect((await app.request('/api/sessions/s1?workspace=/ws')).status).toBe(404);
    expect(readSaved).toHaveBeenCalled();
  });
});
