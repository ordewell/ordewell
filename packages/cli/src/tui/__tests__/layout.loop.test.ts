import { describe, it, expect, beforeAll } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import { findTask, type TaskView, type TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));
const frame = (state: TuiState): string => render(state).join('\n');

const found = { outcome: 'fail', reported: 'failed' };
const check = (over: Partial<TaskView> = {}): TaskView => ({
  id: 'c', order: 1, title: 'Review the change', type: 'ai', status: 'pending', dependencies: [], loop: { body: ['f'], maxRounds: 3 }, ...over,
});
const fix = (over: Partial<TaskView> = {}): TaskView => ({
  id: 'f', order: 2, title: 'Fix what the review found', type: 'ai', status: 'pending', dependencies: ['c'], ...over,
});
const plan = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 40, cols: 220, focus: 'plan', tasks, ...over });

describe('a loop in the plan pane (ADR-0045)', () => {
  it('links the check to its body with the same glyph', () => {
    const out = frame(plan([check(), fix()]));

    expect(out).toContain('↻ loop of up to 3 rounds · runs #2 if it fails');
    expect(out).toContain('↻ runs if #1 fails');
  });

  it('says the check\'s round while it runs', () => {
    expect(frame(plan([check({ status: 'in_progress', loopRound: 2 }), fix()]))).toContain('↻ round 2 of 3 · runs #2 if it fails');
  });

  it('shows a check between rounds as fixing, with what the loop waits for, and its body with the round it fixes', () => {
    const out = frame(plan([check({ status: 'failed', loopRound: 1, verdict: found }), fix({ status: 'in_progress' })]));

    expect(out).toContain('↻ round 1 of 3: fixing · found problems: runs again once #2');
    expect(out).toContain('↻ runs if #1 fails (round 1 of 3)');
    expect(out).not.toContain('✗');
  });

  it('shows how the loop ended: passed in a round, or failed after all of them', () => {
    expect(frame(plan([check({ status: 'completed', loopRound: 2, verdict: { outcome: 'pass', reported: 'done' } }), fix({ status: 'skipped', skipReason: 'not needed: its check passed' })])))
      .toContain('↻ passed in round 2 of 3');
    expect(frame(plan([check({ status: 'failed', loopRound: 3, verdict: found }), fix({ status: 'skipped', skipReason: 'not run: the loop ran out of rounds' })])))
      .toContain('↻ failed after 3 rounds');
  });

  it('names the body task that stopped the loop', () => {
    const out = frame(plan([check({ status: 'failed', loopRound: 1, verdict: found }), fix({ status: 'failed' })]));

    expect(out).toContain('↻ stopped in round 1 of 3 · #2 did not pass: retry it');
  });

  it('draws nothing for a plan without a loop', () => {
    expect(frame(plan([check({ loop: undefined }), fix()]))).not.toContain('↻');
  });
});

describe('a loop from the run view', () => {
  const plain = (over: Record<string, unknown>): Record<string, unknown> => ({ type: 'ai', dependencies: [], status: 'pending', ...over });
  const loaded = (): TuiState => reduce(initialState({ sessionId: 's1', rows: 40, cols: 110 }), {
    type: 'planUpdated',
    sessionId: 's1',
    plan: { tasks: [
      plain({ id: 'c', order: 1, title: 'Review', loop: { body: ['f'], maxRounds: 3 } }),
      plain({ id: 'f', order: 2, title: 'Fix', dependencies: ['c'] }),
    ] },
  }).state;

  it('takes the loop off the plan and the round and verdict off the status stream', () => {
    const state = reduce(loaded(), {
      type: 'statusUpdate',
      sessionId: 's1',
      tasks: [{ id: 'c', status: 'failed', loopRound: 2, loop: { body: ['f'], maxRounds: 3 }, verdict: { outcome: 'fail', reason: 'two problems', checks: [], reported: 'failed' } }] as Extract<Action, { type: 'statusUpdate' }>['tasks'],
    }).state;

    expect(findTask(state.tasks, 'c')).toMatchObject({ loop: { body: ['f'], maxRounds: 3 }, loopRound: 2, verdict: { outcome: 'fail', reported: 'failed' } });
    expect(findTask(state.tasks, 'f')?.loop).toBeUndefined();
    expect(frame(state)).toContain('↻ round 2 of 3: fixing');
  });

  it('draws a check nothing will run as stopped, off the status stream, and no longer once a run takes it back', () => {
    const tasks = (loopStranded: boolean) => [{ id: 'c', status: 'failed', loopRound: 1, loop: { body: ['f'], maxRounds: 3 }, verdict: { outcome: 'fail', reason: 'two problems', checks: [], reported: 'failed' }, ...(loopStranded ? { loopStranded: true } : {}) }] as Extract<Action, { type: 'statusUpdate' }>['tasks'];
    const stranded = reduce(loaded(), { type: 'statusUpdate', sessionId: 's1', tasks: tasks(true) }).state;

    expect(frame(stranded)).toContain('↻ stopped in round 1 of 3 · nothing runs it');
    expect(frame(stranded)).not.toContain('fixing');
    expect(frame(reduce(stranded, { type: 'statusUpdate', sessionId: 's1', tasks: tasks(false) }).state)).toContain('↻ round 1 of 3: fixing');
  });
});

describe('removing a task in a loop (ADR-0045 L8)', () => {
  it('refuses a check up front, with core\'s reason, rather than asking first', () => {
    const step = press(plan([check(), fix()], { selectedTask: 0 }), 'char', 'd');

    expect(step.state.overlay).toBeNull();
    expect(frame(step.state)).toContain('"Review the change" is a loop\'s check: remove its body tasks first, or drop its loop');
  });

  it('asks before removing a body task, and says it leaves the loop', () => {
    const step = press(plan([check(), fix()], { selectedTask: 1 }), 'char', 'd');

    expect(step.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'remove-task', taskId: 'f' } });
    expect(step.state.overlay).toMatchObject({ message: expect.stringContaining('whole body of #1 Review the change\'s loop, so the loop is dropped with it.') });
  });
});
