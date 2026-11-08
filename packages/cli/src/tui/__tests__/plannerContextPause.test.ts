import { describe, it, expect, vi } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import type { TuiState } from '../state';
import { stripAnsi } from '../ansi';
import { chatLayout } from '../layout';

/**
 * A planner paused on its context (ADR-0002) waits for the user: the chat
 * footer says so, `/compact retry` opens the paused turn again, and `/stop`
 * drops it — the run's own Stop is not what the user is asking for then.
 */

const session = (over: Partial<TuiState> = {}): TuiState => initialState({ sessionId: 's1', rows: 30, cols: 120, ...over });
const REASON = "vendor/model refused the planner's call as too long for its window, even after pruning older file reads. The planner is paused: Retry compaction tries to condense its context and continue the turn, or stop it to drop the turn.";
const pause = { model: 'vendor/model', at: '2026-10-25T10:00:00Z', reason: REASON, inputs: ['turn-1'] };
const planWith = (plannerContextPause?: typeof pause) => ({ tasks: [], ...(plannerContextPause ? { plannerContextPause } : {}) });
const planUpdated = (state: TuiState, plan: unknown): TuiState => reduce(state, { type: 'planUpdated', plan, sessionId: 's1' }).state;
const footer = (state: TuiState): string => stripAnsi(chatLayout(state, 12, 120).footer.join('\n'));

function typed(state: TuiState, text: string): Step {
  return reduce({ ...state, editor: { ...state.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } });
}

describe('a planner paused on its context', () => {
  it('is kept from the plan and drawn in the chat footer, with the ways out', () => {
    const paused = planUpdated(session(), planWith(pause));

    expect(paused.plannerPause).toEqual({ model: 'vendor/model' });
    expect(footer(paused)).toMatch(/Planner paused: its context does not fit vendor\/model's window/);
    expect(footer(paused)).toContain('/compact retry');
    expect(footer(paused)).toContain('/stop');
  });

  it('goes when a later plan no longer carries it', () => {
    const gone = planUpdated(planUpdated(session(), planWith(pause)), planWith());

    expect(gone.plannerPause).toBeNull();
    expect(footer(gone)).not.toContain('Planner paused');
  });

  it('is not drawn while a planner turn runs: a retry in flight is the planner working', () => {
    const retrying = { ...planUpdated(session(), planWith(pause)), planner: 'planning' as const };

    expect(footer(retrying)).not.toContain('Planner paused');
  });

  it('keeps the draft and the scroll as the pause comes and goes', () => {
    const drafted = { ...session(), editor: { ...session().editor, text: 'half a thought', cursor: 6 }, scroll: 3 };
    const paused = planUpdated(drafted, planWith(pause));
    const resumed = planUpdated(paused, planWith());

    for (const state of [paused, resumed]) {
      expect(state.editor).toEqual(drafted.editor);
      expect(state.scroll).toBe(3);
    }
  });
});

describe('/compact retry', () => {
  it('opens the paused turn again as a planner turn', () => {
    const asked = typed(planUpdated(session(), planWith(pause)), '/compact retry');

    expect(asked.effects).toEqual([{ type: 'retryPlannerCompaction', sessionId: 's1' }]);
    expect(asked.state.planner).toBe('planning');
  });

  it('waits out a planner turn, as /compact does', () => {
    const busy = typed({ ...planUpdated(session(), planWith(pause)), planner: 'planning' }, '/compact retry');

    expect(busy.effects).toEqual([]);
  });

  it('asks the daemon as a planner turn does, its reply settling the plan', async () => {
    const plan = planWith();
    const retryPlannerCompaction = vi.fn().mockResolvedValue(plan);
    const dispatch = vi.fn();
    const deps: EffectDeps = {
      api: {
        retryPlannerCompaction,
        followSession: vi.fn().mockReturnValue({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: vi.fn() }),
      } as unknown as OrdewellApi,
      workspace: '/ws', port: 3742, dispatch, newSessionId: () => 's2', setEnvVar: () => {}, saveAutonomy: () => ({ overridden: false }), hasBin: () => true,
      login: async () => ({ ok: true }),
      exit: vi.fn(),
      reviveDaemon: vi.fn(), setMouseCapture: vi.fn(), writeTerminal: vi.fn(),
    };

    await runEffect({ type: 'retryPlannerCompaction', sessionId: 's1' }, deps);

    expect(retryPlannerCompaction).toHaveBeenCalledWith('s1');
    expect(dispatch).toHaveBeenCalledWith({ type: 'planUpdated', plan, sessionId: 's1' });
  });
});

describe('/stop while the planner is paused on its context', () => {
  it('stops the planner, dropping the paused turn, and leaves the run alone', () => {
    const stopped = typed(planUpdated(session(), planWith(pause)), '/stop');

    expect(stopped.effects).toEqual([{ type: 'cancelPlanning', sessionId: 's1' }]);
  });

  it('stops the run as ever when nothing is paused', () => {
    expect(typed(session(), '/stop').effects).toEqual([{ type: 'stopExecution', sessionId: 's1' }]);
  });
});
