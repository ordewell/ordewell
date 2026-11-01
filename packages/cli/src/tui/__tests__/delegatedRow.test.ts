import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTask, serializePlan } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { planLayout } from '../layout';
import { style } from '../ansi';
import type { TuiState } from '../state';

/*
 * A delegated task's row in the plan pane (ADR-0055 D16, D20): its goal, what
 * is left of its budget, where its child stands, and a Stop still winding down.
 * The tasks arrive as the daemon sends them: a plan, then status updates.
 */

vi.mock('@ordewell/core', async (importOriginal) => ({ ...await importOriginal<typeof import('@ordewell/core')>(), DELEGATION_OFFERED: true }));

beforeAll(() => { style.enabled = false; });
afterAll(() => { style.enabled = true; });

const wirePlan = () => serializePlan({
  tasks: [
    createTask({ id: 'd', order: 1, title: 'Import ledger', type: 'delegated', goal: 'Move the importer behind the new interface', budget: { tokens: 2_000_000 }, protectedPaths: ['tests/'] }),
    createTask({ id: 'f', order: 2, title: 'Report', prompt: 'write it' }),
  ],
  generatedAt: '2026-01-01T00:00:00Z', status: 'approved', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00Z',
});

const loaded = (): TuiState => reduce(initialState({ sessionId: 's1', rows: 40, cols: 100, focus: 'plan' }), { type: 'planUpdated', plan: wirePlan(), sessionId: 's1' }).state;
const lines = (state: TuiState): string => planLayout(state, 40, 100).lines.join('\n');

const delegation = { tasks: { completed: 2, running: 1, waiting: 0, pending: 1, failed: 0, skipped: 0 }, tokens: { budget: 2_000_000, left: 1_300_000 } };
const update = (state: TuiState, over: Record<string, unknown>): TuiState =>
  reduce(state, { type: 'statusUpdate', tasks: [{ id: 'd', status: 'in_progress', verdict: null, ...over }], sessionId: 's1' }).state;

describe('a delegated task in the plan pane', () => {
  it('stays a delegated task, with its goal', () => {
    expect(loaded().tasks[0]).toMatchObject({ type: 'delegated', goal: 'Move the importer behind the new interface' });
  });

  it('says where its child stands and what is left of its budget, beside the title', () => {
    const text = lines(update(loaded(), { delegation }));
    expect(text).toContain('2 of 4 done, 1 running');
    expect(text).toContain('1.3M of 2M tokens left');
  });

  it('says it is stopping while a Stop winds its child down, though the task reads as not started', () => {
    const text = lines(update(loaded(), { status: 'pending', delegation: { stopping: true } }));
    expect(text).toContain('SUB');
    expect(text).toContain('stopping: its child plan is still winding down.');
  });

  it('draws nothing of it on a task that is not delegated', () => {
    const text = lines(loaded());
    expect(text.split('\n').filter((line) => line.includes('Report'))[0]).not.toMatch(/tokens left|done/);
    expect(render(loaded()).join('\n')).toBeTruthy();
  });
});
