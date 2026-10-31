import { describe, it, expect, vi } from 'vitest';
import { createTask, type SessionMessage } from '@ordewell/core';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import { inboundFor } from '../inbound';
import { chatActivity } from '../layout';
import { plannerInFlight, type TuiState } from '../state';

/**
 * What the TUI believes about the planner turn it has out: a plan refresh, a
 * loaded session and a repeated reply must each leave that belief alone or
 * correct it, never end the turn or send a prompt held for another session.
 */

const typed = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const enter = (state: TuiState, text: string): TuiState => reduce(typed(state, text), { type: 'key', key: { name: 'enter' } }).state;

/** A turn out in session s1, with one prompt held behind it. */
const midTurn = (): TuiState => enter(enter(initialState({ sessionId: 's1', rows: 30, cols: 100 }), 'build it'), 'and a README');

function deps(api: Partial<OrdewellApi>, actions: Action[]): EffectDeps {
  return {
    api: api as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action) => actions.push(action),
    newSessionId: () => 's1',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    setMouseCapture: () => {},
    hasBin: () => true,
    pipeToClipboard: () => {},
    writeTerminal: () => {},
    reviveDaemon: () => Promise.resolve(false),
    login: async () => ({ ok: true }),
    exit: () => {},
  };
}

/** Folds the actions an effect dispatched into `state`, collecting every effect the reducer asked for. */
function fold(state: TuiState, actions: Action[]): { state: TuiState; effects: Effect[] } {
  const effects: Effect[] = [];
  let current = state;
  for (const action of actions) {
    const result = reduce(current, action);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

describe('a turn the daemon holds for agent detection', () => {
  const socket = () => {
    const actions: Action[] = [];
    const planning = inboundFor({ getTaskLog: vi.fn() } as unknown as Parameters<typeof inboundFor>[0], (action) => actions.push(action), 's1').planning();
    return { actions, planning };
  };

  it('says what it waits for, until the probe answers', () => {
    const { actions, planning } = socket();

    planning({ type: 'planner_detection', waiting: true });
    const waiting = fold(midTurn(), actions).state;
    expect(chatActivity(waiting)?.label).toBe('Detecting coding agents…');

    planning({ type: 'planner_detection', waiting: false });
    expect(chatActivity(fold(midTurn(), actions).state)?.label).toBe('Planning…');
  });

  it('says it no longer once a turn opens, whatever of the answer a dropped socket lost', () => {
    const { actions, planning } = socket();

    planning({ type: 'planner_detection', waiting: true });
    planning({ type: 'planner_turn_started', turnId: 'turn-1', startedAt: '2026-10-31T10:00:00.000Z' });

    expect(chatActivity(fold(midTurn(), actions).state)?.label).toBe('Planning…');
  });

  it('leaves a turn stopped at the gate idle, however long the probe takes', () => {
    const { actions, planning } = socket();

    planning({ type: 'planner_detection', waiting: true });
    const { state } = fold({ ...midTurn(), planner: 'idle' }, actions);

    expect(chatActivity(state)).toBeNull();
  });
});

describe('a plan refresh during a planner turn', () => {
  it('shows the plan and leaves the turn, and the prompt held behind it, where they were', async () => {
    const actions: Action[] = [];
    const api: Partial<OrdewellApi> = {
      removeTask: vi.fn().mockResolvedValue({ ok: true }),
      getSession: vi.fn().mockResolvedValue({ meta: { id: 's1', goal: 'g' }, plan: { tasks: [] } }),
    };
    await runEffect({ type: 'removeTask', sessionId: 's1', taskId: 'task-1' } as Effect, deps(api, actions));

    const before = midTurn();
    const { state, effects } = fold(before, actions);

    expect(state.planner).toBe(before.planner);
    expect(state.queuedPrompts).toEqual(['and a README']);
    expect(effects.filter((e) => e.type === 'sendMessage')).toEqual([]);
  });
});

describe('loading another session during a planner turn', () => {
  it('does not send the old session\'s held prompt to the loaded one, nor keep its turn', async () => {
    const actions: Action[] = [];
    const api: Partial<OrdewellApi> = {
      followSession: () => ({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} }),
      adoptSession: vi.fn().mockResolvedValue({ plan: { tasks: [] }, goal: 'Other goal' }),
    };
    await runEffect({ type: 'loadSession', sessionId: 's2' }, deps(api, actions));

    const { state, effects } = fold(midTurn(), actions);

    expect(state.sessionId).toBe('s2');
    expect(effects.filter((e) => e.type === 'sendMessage')).toEqual([]);
    expect(state.queuedPrompts).toEqual([]);
    expect(state.planner).toBe('idle');
    expect(state.stopArmed).toBe(false);
    expect(state.forceSendPending).toBeNull();
  });
});

describe('loading a session while the daemon runs a planner turn', () => {
  const compaction = (phase: 'started' | 'ended'): SessionMessage => ({
    type: 'planner_compaction',
    compaction: phase === 'started'
      ? { phase, id: 'c1', origin: 'ordewell', trigger: 'auto', at: '2026-01-02T00:00:00.000Z' }
      : { phase, id: 'c1', origin: 'ordewell', trigger: 'auto', outcome: 'condensed', at: '2026-01-02T00:00:05.000Z' },
  });
  const heard = (message: SessionMessage): Action => ({ type: 'sessionMessage', sessionId: 's2', message });
  const turnEnded = heard({ type: 'planner_turn_ended', turnId: 't1', outcome: 'message' });

  /** The session as `/load` leaves it when the daemon names turn `t1` as running. */
  async function loaded(): Promise<TuiState> {
    const actions: Action[] = [];
    const api: Partial<OrdewellApi> = {
      followSession: () => ({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} }),
      adoptSession: vi.fn().mockResolvedValue({ plan: { tasks: [] }, goal: 'g', plannerTurnId: 't1' }),
    };
    await runEffect({ type: 'loadSession', sessionId: 's2' }, deps(api, actions));
    return fold(initialState({ rows: 30, cols: 100 }), actions).state;
  }

  it('leaves the planner free when that turn\'s end reached the socket while the load was answered', async () => {
    const actions: Action[] = [];
    let onEvent: ((event: SessionMessage) => void) | undefined;
    const api: Partial<OrdewellApi> = {
      followSession: (_id, handler) => {
        onEvent = handler as (event: SessionMessage) => void;
        return { ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} };
      },
      adoptSession: vi.fn().mockImplementation(async () => {
        onEvent!({ type: 'planner_turn_ended', turnId: 't1', outcome: 'message' });
        return { plan: { tasks: [] }, goal: 'g', plannerTurnId: 't1' };
      }),
    };
    await runEffect({ type: 'loadSession', sessionId: 's2' }, deps(api, actions));
    const { state } = fold(initialState({ rows: 30, cols: 100 }), actions);

    expect(plannerInFlight(state)).toBe(false);
    expect(state.planner).toBe('idle');
    expect(state.turnGate.open).toBeNull();
    const sent = reduce(typed(state, 'and a README'), { type: 'key', key: { name: 'enter' } });
    expect(sent.effects.filter((e) => e.type === 'sendMessage')).toEqual([{ type: 'sendMessage', sessionId: 's2', message: 'and a README' }]);
  });

  it('keeps the planner busy through a compaction inside that turn, until the turn itself ends', async () => {
    const during = fold(await loaded(), [heard(compaction('started')), heard(compaction('ended'))]).state;

    expect(plannerInFlight(during)).toBe(true);
    expect(during.turnGate.open).toBe('t1');
    expect(fold(during, [turnEnded]).state.planner).toBe('idle');
  });

  it('holds a prompt typed during that compaction, and sends it once the turn ends', async () => {
    const typedDuring = enter(fold(await loaded(), [heard(compaction('started'))]).state, 'and a README');
    const compacted = fold(typedDuring, [heard(compaction('ended'))]);

    expect(compacted.state.queuedPrompts).toEqual(['and a README']);
    expect(compacted.effects.filter((e) => e.type === 'sendMessage')).toEqual([]);

    const ended = fold(compacted.state, [turnEnded]);
    expect(ended.effects.filter((e) => e.type === 'sendMessage')).toEqual([{ type: 'sendMessage', sessionId: 's2', message: 'and a README' }]);
    expect(ended.state.queuedPrompts).toEqual([]);
  });
});

/**
 * What reaches the session's socket while `/load` is answered is held until
 * the session is on screen. It is newer than what the answer read, so the
 * answer's plan, turn and compaction are what it lands on, never what
 * overwrites it.
 */
describe('loading a session while broadcasts land before the load is answered', () => {
  const heard = (message: SessionMessage): Action => ({ type: 'sessionMessage', sessionId: 's2', message });
  const oldPlan = { tasks: [createTask({ id: 'old', order: 1, title: 'Old plan task' })], conversationHistory: [] };
  const pause = { model: 'vendor/model', at: '2026-01-02T00:00:00.000Z', reason: 'paused', inputs: ['p1'] };
  const newPlan = { tasks: [createTask({ id: 'new', order: 1, title: 'Landed while loading' })], conversationHistory: [], plannerContextPause: pause };
  // A daemon frame as the socket hands it over: the plan is the serialized one, read loosely by the reducer.
  const landed = (seq?: number) => ({ type: 'plan_generated', plan: newPlan, goal: 'g', runners: [], ...(seq !== undefined ? { stream: 'd1', seq } : {}) });
  const started: SessionMessage = { type: 'planner_compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'auto', at: '2026-01-02T00:00:00.000Z' } };
  const ended = (outcome: 'condensed' | 'stopped' | 'failed' | 'unchanged', seq?: number): SessionMessage => ({
    type: 'planner_compaction',
    compaction: { phase: 'ended', id: 'c1', origin: 'ordewell', trigger: 'auto', outcome, at: '2026-01-02T00:00:05.000Z' },
    ...(seq !== undefined ? { stream: 'd1', seq } : {}),
  } as SessionMessage);
  const turnEnded: SessionMessage = { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' };

  /** `/load` with `held` reaching the socket while the daemon answers it, and `adopted` what the answer read. */
  async function loadedWith(held: unknown[], adopted: Record<string, unknown>): Promise<{ state: TuiState; effects: Effect[] }> {
    const actions: Action[] = [];
    let onEvent: ((event: unknown) => void) | undefined;
    const api: Partial<OrdewellApi> = {
      followSession: (_id, handler) => {
        onEvent = handler as (event: unknown) => void;
        return { ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} };
      },
      adoptSession: vi.fn().mockImplementation(async () => {
        for (const event of held) onEvent!(event);
        return { plan: { tasks: [] }, goal: 'g', ...adopted };
      }),
    };
    await runEffect({ type: 'loadSession', sessionId: 's2' }, deps(api, actions));
    return fold(initialState({ rows: 30, cols: 100 }), actions);
  }

  const sends = (state: TuiState, text: string): Effect[] => reduce(typed(state, text), { type: 'key', key: { name: 'enter' } }).effects.filter((e) => e.type === 'sendMessage');
  const blocks = (state: TuiState) => state.conversation.blocks.flatMap((b) => (b.type === 'compaction' ? [{ id: b.compactionId, status: b.status }] : []));

  it('keeps a plan that landed meanwhile, and the planner pause it carries, over the older plan the load read', async () => {
    const { state } = await loadedWith([landed()], { plan: oldPlan });

    expect(state.run.tasks.map((t) => t.id)).toEqual(['new']);
    expect(state.plannerPause).toEqual({ model: 'vendor/model' });
    expect(state.planner).toBe('idle');
  });

  it('keeps the newer plan of a turn it joins, holding prompts until that turn ends', async () => {
    const joined = await loadedWith([landed()], { plan: oldPlan, plannerTurnId: 't1' });

    expect(joined.state.run.tasks.map((t) => t.id)).toEqual(['new']);
    expect(joined.state.planner).toBe('joined');
    expect(joined.state.turnGate.open).toBe('t1');
    expect(sends(joined.state, 'and a README')).toEqual([]);

    const over = await loadedWith([landed(), turnEnded], { plan: oldPlan, plannerTurnId: 't1' });
    expect(over.state.run.tasks.map((t) => t.id)).toEqual(['new']);
    expect(over.state.plannerPause).toEqual({ model: 'vendor/model' });
    expect(plannerInFlight(over.state)).toBe(false);
    expect(over.state.turnGate.open).toBeNull();
  });

  for (const outcome of ['condensed', 'stopped', 'failed', 'unchanged'] as const) {
    it(`leaves the planner free when the compaction it read as running had ended ${outcome} meanwhile`, async () => {
      const { state } = await loadedWith([ended(outcome)], { plannerCompaction: started });

      expect(state.planner).toBe('idle');
      expect(plannerInFlight(state)).toBe(false);
      expect(blocks(state)).toEqual(outcome === 'unchanged' ? [] : [{ id: 'c1', status: outcome }]);
      expect(sends(state, 'and a README')).toEqual([{ type: 'sendMessage', sessionId: 's2', message: 'and a README' }]);
    });
  }

  it('settles a compaction whose start the socket greeted with and whose end followed, whatever copies arrive', async () => {
    const view = { tasks: [], runMerge: null, handoff: null, mergeResult: null };
    const { state } = await loadedWith(
      [{ type: 'run_snapshot', sessionId: 's2', view, stream: 'd1', seq: 4 }, started, ended('stopped', 5), ended('stopped', 5), landed(6), landed(6)],
      { plan: oldPlan, plannerCompaction: started },
    );

    expect(state.planner).toBe('idle');
    expect(blocks(state)).toEqual([{ id: 'c1', status: 'stopped' }]);
    expect(state.run.tasks.map((t) => t.id)).toEqual(['new']);
    expect(sends(state, 'and a README')).toHaveLength(1);
  });

  it('keeps the planner compacting while the compaction it read as running has not ended, until its end arrives', async () => {
    const during = await loadedWith([started], { plannerCompaction: started });

    expect(during.state.planner).toBe('compacting');
    expect(blocks(during.state)).toEqual([{ id: 'c1', status: 'running' }]);
    const typedDuring = enter(during.state, 'and a README');
    expect(typedDuring.queuedPrompts).toEqual(['and a README']);

    // Its end releases the held prompt, which goes out as the next turn.
    const done = fold(typedDuring, [heard(ended('condensed'))]);
    expect(done.state.planner).toBe('planning');
    expect(done.state.queuedPrompts).toEqual([]);
    expect(done.effects.filter((e) => e.type === 'sendMessage')).toEqual([{ type: 'sendMessage', sessionId: 's2', message: 'and a README' }]);
  });

  it('frees the planner when both the joined turn and its compaction ended meanwhile', async () => {
    const { state } = await loadedWith([ended('condensed'), turnEnded], { plannerTurnId: 't1', plannerCompaction: started });

    expect(plannerInFlight(state)).toBe(false);
    expect(state.turnGate.open).toBeNull();
    expect(sends(state, 'and a README')).toHaveLength(1);
  });
});
