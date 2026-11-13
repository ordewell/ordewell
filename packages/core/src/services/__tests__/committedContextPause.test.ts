import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, LegacyPlanState, PendingPlanTurn } from '../../models/Task';
import { PlannerContextExhaustedError } from '../plannerContextBudget';
import { makeSession } from './sessionTestKit';
import { ctx, heldPlanner, NOW, plan, prose, settled, task, until } from './supervisorTestKit';

/**
 * A planner tool's commit lands the turn's inputs with the change: the
 * transcript holds them from then on. A later call that overflows the
 * planner's window pauses it (ADR-0002) with those inputs put back for the
 * user's Retry compaction, but they have already landed: neither a Retry nor
 * a Stop may write them, or send them to the planner, a second time.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const WAKE_UP = 'Task t1 finished: its tests pass.';
const ASKED = 'add a lint task';
const addLint = { ops: [{ op: 'add' as const, task: { title: 'Lint', prompt: 'run the linter', assignedRunner: 'claude-code' } }] };

/** A run update a reload kept: it goes with the user's next message. */
const keptWakeUp: PendingPlanTurn = { id: 'turn-kept-1', source: 'supervisor', text: WAKE_UP, timestamp: '2026-10-11T16:30:00Z' };

/** A draft plan whose planner, asked to add a task, commits the edit through its tool, then overflows its window. */
async function pausedAfterCommit() {
  const planner = heldPlanner();
  const retryHeldInput = vi.fn(async () => prose('Added the lint task.'));
  const aiService = Object.assign(planner.aiService, { heldInputRetryable: () => true, retryHeldInput });
  const session = makeSession({ aiService });
  session.loadPlan(plan([task('t1', 1), task('t2', 2)], { status: 'draft', pendingTurns: [keptWakeUp] }), 'build it', process.cwd());
  const asked = session.continueConversation(ASKED);
  await until(() => planner.calls.length === 1);
  expect(planner.calls[0].message).toContain(WAKE_UP);

  const edit = await planner.tools().editPlan!(addLint, ctx);
  expect(edit.isError).toBeFalsy();
  planner.calls[0].fail(new PlannerContextExhaustedError('m', true, { done: ['edit_plan: added Lint'] }));
  await asked;
  await settled();
  expect(session.planState!.plannerContextPause).toBeDefined();
  return { session, planner, retryHeldInput };
}

const history = (plan: LegacyPlanState | null): ConversationMessage[] => plan?.conversationHistory ?? [];
const userSaid = (plan: LegacyPlanState | null) => history(plan).filter((m) => m.role === 'user' && m.content === ASKED);
const wokenWith = (plan: LegacyPlanState | null) => history(plan).filter((m) => m.kind === 'wake_up' && m.content === WAKE_UP);
const prompts = (plan: LegacyPlanState | null) => (plan?.researchLog ?? []).filter((e) => 'type' in e && e.type === 'user_prompt' && e.content === ASKED);

describe('a planner paused on its context after a tool committed in its turn', () => {
  it('lands each of the turn\'s inputs once when Retry compaction carries it on', async () => {
    const { session, retryHeldInput } = await pausedAfterCommit();
    expect(userSaid(session.planState)).toHaveLength(1);
    expect(wokenWith(session.planState)).toHaveLength(1);

    await session.retryPlannerCompaction();

    expect(retryHeldInput).toHaveBeenCalledTimes(1);
    const landed = session.planState;
    expect(landed!.plannerContextPause).toBeUndefined();
    expect(landed!.pendingTurns ?? []).toEqual([]);
    expect(history(landed).at(-1)).toMatchObject({ role: 'assistant', content: 'Added the lint task.' });
    expect(userSaid(landed)).toHaveLength(1);
    expect(wokenWith(landed)).toHaveLength(1);
    expect(prompts(landed)).toHaveLength(1);
    expect(session.planTasks.map((t) => t.title)).toContain('Lint');
  });

  it('still lands them once when its first retry overflows the window again', async () => {
    const { session, retryHeldInput } = await pausedAfterCommit();
    retryHeldInput.mockRejectedValueOnce(new PlannerContextExhaustedError('m', true, { done: ['edit_plan: added Lint'] }));

    await session.retryPlannerCompaction();
    expect(session.planState!.plannerContextPause).toBeDefined();
    await session.retryPlannerCompaction();

    expect(retryHeldInput).toHaveBeenCalledTimes(2);
    const landed = session.planState;
    expect(landed!.plannerContextPause).toBeUndefined();
    expect(landed!.pendingTurns ?? []).toEqual([]);
    expect(userSaid(landed)).toHaveLength(1);
    expect(wokenWith(landed)).toHaveLength(1);
    expect(prompts(landed)).toHaveLength(1);
  });

  it('sends none of the turn\'s run updates again with the user\'s next message after a Stop', async () => {
    const { session, planner } = await pausedAfterCommit();

    expect(session.abortPlannerTurn()).toBe(true);
    expect(session.planState!.plannerContextPause).toBeUndefined();
    expect(session.planState!.pendingTurns ?? []).toEqual([]);

    const next = session.continueConversation('then document it');
    await until(() => planner.calls.length === 2);
    expect(planner.calls[1].message).not.toContain(WAKE_UP);
    expect(planner.calls[1].message).not.toContain(ASKED);
    planner.calls[1].finish(prose('Documented.'));
    await next;

    expect(wokenWith(session.planState)).toHaveLength(1);
    expect(userSaid(session.planState)).toHaveLength(1);
  });
});
