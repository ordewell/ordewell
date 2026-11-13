import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTask, DELEGATION_OFFERED, serializePlan } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { planLayout } from '../layout';
import { style } from '../ansi';

/** With delegation not offered (everything published), a delegated task's row says nothing of its child, budget or Stop (ADR-0055 D21). */

beforeAll(() => { style.enabled = false; });
afterAll(() => { style.enabled = true; });

describe('a delegated task\'s row where delegation is not offered', () => {
  it('is switched off', () => {
    expect(DELEGATION_OFFERED).toBe(false);
  });

  it('shows no counts, budget or stopping line, whatever the daemon sent', () => {
    const plan = serializePlan({
      tasks: [createTask({ id: 'd', order: 1, title: 'Import ledger', type: 'delegated', goal: 'Move it', budget: { tokens: 2_000_000 } })],
      generatedAt: '2026-01-01T00:00:00Z', status: 'approved', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00Z',
    });
    const loaded = reduce(initialState({ sessionId: 's1', rows: 40, cols: 100, focus: 'plan' }), { type: 'planUpdated', plan, sessionId: 's1' }).state;
    const delegation = { tasks: { completed: 2, running: 1, waiting: 0, pending: 1, failed: 0, skipped: 0 }, tokens: { budget: 2_000_000, left: 1_300_000 }, stopping: true as const };
    const updated = reduce(loaded, { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 'd', status: 'pending', verdict: null, delegation }] }, sessionId: 's1' }).state;
    const text = planLayout(updated, 40, 100).lines.join('\n');
    expect(text).toContain('Import ledger');
    expect(text).not.toMatch(/tokens left|of 4 done|stopping|winding/);
  });
});
