import { describe, expect, it } from 'vitest';
import { createTask, serializeTask, type RunView } from '@ordewell/core';
import { initialState, reduce, type Action } from '../reducer';
import type { TuiState } from '../state';

/**
 * Adversarial: a planner turn on screen belongs to one session (ADR-0017,
 * ADR-0029). Every way the TUI leaves a session — a fork, a load, a clear and
 * a new session — has to drop the turn gate and the prompts held behind it, or
 * the next session inherits the old turn's gate and ctrl-s sends now behind a
 * turn that no longer exists.
 */

const enter = { type: 'key' as const, key: { name: 'enter' } };

/** A turn another client opened, as the socket announces it: the gate is open. */
const midTurn = (): TuiState =>
  reduce(initialState({ sessionId: 's1', planner: 'planning' }), {
    type: 'sessionMessage',
    sessionId: 's1',
    message: { type: 'planner_turn_started', turnId: 't1', prompt: 'Research the repository' },
  }).state;

const withDraft = (state: TuiState, text: string): TuiState => ({
  ...state,
  editor: { ...state.editor, text, cursor: text.length },
});

/** The TUI's own turn in flight, with a prompt queued behind it. */
const turnWithQueue = (): TuiState => reduce(withDraft(midTurn(), 'second prompt'), enter).state;

const quiet = (state: TuiState) => [state.turnGate.open, state.queuedPrompts.length, state.planner];

describe('adversarial: leaving a session drops its turn gate and queue', () => {
  it('a load, a fork and a deleted session all start with no turn', () => {
    expect(quiet(midTurn())).toEqual(['t1', 0, 'planning']);

    for (const action of [
      { type: 'sessionLoaded', sessionId: 's2', goal: 'g' },
      { type: 'sessionForked', sessionId: 's2', goal: 'g' },
      { type: 'sessionDeleted', sessionId: 's1' },
    ] as Action[]) {
      expect(quiet(reduce(midTurn(), action).state)).toEqual([null, 0, 'idle']);
    }
  });

  it('clearing a failed start mid-turn drops the turn gate with the prompts', () => {
    const cleared = reduce(turnWithQueue(), { type: 'sessionCleared' }).state;

    expect(cleared.turnGate.open).toBeNull();
  });
});

describe('adversarial: what was open on the session left behind stays with it', () => {
  const press = (state: TuiState, name: string, char?: string) => reduce(state, { type: 'key', key: { name, ...(char ? { char } : {}) } });
  const planOf = (title: string) => ({ tasks: [{ id: 'task-1', order: 1, title, prompt: title, type: 'ai', status: 'pending', dependencies: [] }] });

  /** Session a's `task-1` with its prompt open and edited, as the right arrow opens it. */
  const editingA = (): TuiState => {
    const planned = reduce(initialState({ sessionId: 'a', focus: 'plan' }), { type: 'planUpdated', plan: planOf('A'), sessionId: 'a' }).state;
    const opened = press(planned, 'right').state;
    return press(opened, 'char', '!').state;
  };

  // Task ids are plan-local, so the loaded plan has its own `task-1`: an editor
  // kept across the load would save a's draft over b's prompt.
  it.each([
    ['a load', [{ type: 'sessionLoaded', sessionId: 'b', goal: 'g' }, { type: 'planUpdated', plan: planOf('B'), sessionId: 'b' }]],
    ['a clear', [{ type: 'sessionCleared' }]],
    // A fork (and a rewind, which forks) copies the task list, so `task-1` is the fork's too.
    ['a fork', [{ type: 'sessionForked', sessionId: 'b', goal: 'g' }, { type: 'planUpdated', plan: planOf('A'), sessionId: 'b' }]],
  ] as [string, Action[]][])('%s closes the prompt editor, so Enter saves nothing', (_, actions) => {
    const editing = editingA();
    expect(editing.taskEditor?.text).toBe('A!');

    const after = actions.reduce((s, action) => reduce(s, action).state, editing);
    expect(after.expandedTaskId).toBeNull();
    expect(after.taskEditor).toBeNull();
    expect(press({ ...after, focus: 'plan' }, 'enter').effects).not.toContainEqual(expect.objectContaining({ type: 'updateTask' }));
  });

  it('a turn of the session left behind that fails lands nowhere: no error, no idle, no drained prompt', () => {
    const onB = [
      { type: 'sessionLoaded', sessionId: 'b', goal: 'g' },
      { type: 'planUpdated', plan: planOf('B'), sessionId: 'b' },
      { type: 'turnJoined', sessionId: 'b', turnId: 'turn-b' },
    ] as Action[];
    const joined = onB.reduce((s, action) => reduce(s, action).state, initialState({ sessionId: 'a', planner: 'planning' }));
    const queued = reduce(withDraft(joined, 'queued for B'), enter).state;
    expect(queued.queuedPrompts).toEqual(['queued for B']);

    const { state, effects } = reduce(queued, { type: 'failed', message: 'Provider 500 while planning session A', turn: true, sessionId: 'a' });
    expect(effects).toEqual([]);
    expect(state.planner).toBe('joined');
    expect(state.queuedPrompts).toEqual(['queued for B']);
    expect(JSON.stringify(state.conversation)).not.toContain('Provider 500');

    const own = reduce(initialState({ sessionId: 'b', planner: 'planning' }), { type: 'failed', message: 'refused', turn: true, sessionId: 'b' }).state;
    expect(own.planner).toBe('idle');
  });

  it('a late clear for the session left behind does not take the one loaded since', () => {
    const onB = reduce(initialState({ sessionId: 'a', planner: 'planning' }), { type: 'sessionLoaded', sessionId: 'b', goal: 'g' }).state;
    const after = reduce(onB, { type: 'sessionCleared', sessionId: 'a' }).state;
    expect(after.sessionId).toBe('b');
    expect(after.goal).toBe('g');
    expect(reduce(onB, { type: 'sessionCleared', sessionId: 'b' }).state.sessionId).toBeNull();
  });

  it('an approval answer that failed for the session left behind is not reported on this one', () => {
    const onB = reduce(initialState({ sessionId: 'a' }), { type: 'sessionLoaded', sessionId: 'b', goal: 'g' }).state;
    const message = 'Could not deliver the approval answer: the planner will treat it as denied.';
    expect(JSON.stringify(reduce(onB, { type: 'failed', message, sessionId: 'a' }).state.conversation)).not.toContain(message);
    expect(JSON.stringify(reduce(onB, { type: 'failed', message, sessionId: 'b' }).state.conversation)).toContain(message);
  });

  it('/new and a clear leave no paused or resending planner on the welcome', () => {
    const plan = { tasks: [], plannerContextPause: { model: 'vendor/model' }, plannerResend: { runner: 'claude-code', at: new Date(Date.now() + 60_000).toISOString() } };
    const held = reduce(initialState({ sessionId: 's1' }), { type: 'planUpdated', plan, sessionId: 's1' }).state;
    expect(held.plannerPause).not.toBeNull();
    expect(held.plannerResend).not.toBeNull();

    const fresh = reduce(withDraft(held, '/new'), enter).state;
    const confirmed = fresh.overlay?.kind === 'confirm' ? reduce(fresh, enter).state : fresh;
    for (const after of [confirmed, reduce(held, { type: 'sessionCleared' }).state]) {
      expect(after.sessionId).toBeNull();
      expect(after.plannerPause).toBeNull();
      expect(after.plannerResend).toBeNull();
    }
  });
});

describe('adversarial: an abandoned opening reports onto no other welcome', () => {
  /** An opening turn on screen, as `startConversation` leaves it once it dispatched `sessionStarted`. */
  const opening = (): TuiState =>
    reduce(initialState({ planner: 'planning' }), { type: 'sessionStarted', sessionId: 'a', goal: 'Plan A' }).state;
  const discarded = { type: 'failed', turn: true, sessionId: 'a', message: 'The planner turn was discarded' } as const satisfies Action;
  const errorsOf = (state: TuiState): string => JSON.stringify(state.conversation);

  it('/new while the opening runs keeps the discarded turn\'s error off the fresh welcome', () => {
    const confirm = reduce(withDraft(opening(), '/new'), enter).state;
    const fresh = confirm.overlay?.kind === 'confirm' ? reduce(confirm, enter).state : confirm;
    expect(fresh.sessionId).toBeNull();
    const after = reduce(fresh, discarded).state;
    expect(errorsOf(after)).not.toContain('discarded');
    expect(after.planner).toBe('idle');
  });

  it('a clear still reports the refusal onto the welcome it left', () => {
    const cleared = reduce(opening(), { type: 'sessionCleared', sessionId: 'a' }).state;
    expect(errorsOf(reduce(cleared, discarded).state)).toContain('discarded');
  });

  it('a stop armed against the abandoned session does not outlive /new or a clear', () => {
    const stopping = { ...opening(), stopRequested: true };
    const fresh = reduce(stopping, { type: 'sessionDeleted', sessionId: 'a' }).state;
    expect(fresh.stopRequested).toBe(false);
    expect(reduce(stopping, { type: 'sessionCleared', sessionId: 'a' }).state.stopRequested).toBe(false);
  });
});

describe('adversarial: the run closed is the Session\'s to say (ADR-0013, ADR-0020)', () => {
  /** A run whose one task carries a conflict mark and whose handoff card is up. */
  const runWithCards = (): TuiState => {
    const task = serializeTask(createTask({ id: 't1', order: 1, title: 'Deploy', prompt: 'deploy', status: 'completed' }));
    const view: RunView = {
      tasks: [{
        ...task,
        isolation: { state: 'conflict', branch: 'ordewell/r1/1-deploy', worktree: '/wt/1', repos: ['.'], conflictRepo: '.', conflictFiles: ['x.ts'] },
      }],
      runMerge: null,
      handoff: { repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abc123', landed: [] }], landed: [] },
      mergeResult: null,
    };
    return reduce(initialState({ sessionId: 's1' }), { type: 'runSnapshot', sessionId: 's1', view }).state;
  };

  it('a Merge all while the run goes on keeps the marks and takes the handoff card it merged', () => {
    const merged = reduce(runWithCards(), { type: 'runMessage', message: { type: 'isolation_merge', result: { outcome: 'merged' } }, sessionId: 's1' }).state;

    expect(merged.tasks[0]?.isolation).toMatchObject({ state: 'conflict' });
    expect(merged.handoff).toBeNull();
  });

  it('the Session\'s run_closed is what clears the marks', () => {
    const closed = reduce(runWithCards(), { type: 'runMessage', message: { type: 'run_closed' }, sessionId: 's1' }).state;

    expect(closed.tasks[0]?.isolation).toBeUndefined();
    expect(closed.handoff).toBeNull();
  });
});
