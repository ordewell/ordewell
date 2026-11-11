import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import { registerSkillCommands } from '../slash';
import type { TaskView, TuiState } from '../state';
import { lastMessage, messagesOf } from './chat';

/**
 * Prompts typed while a planner turn answers hold in a visible queue instead
 * of pretending to be sent. They go out together, as one message, when the
 * turn settles; Esc takes the newest back, and double-Esc arms then stops the turn.
 */

function run(text: string, overrides: Partial<TuiState> = {}) {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text, cursor: text.length } };
  return reduce(state, { type: 'key', key: { name: 'enter' } });
}

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string) => reduce(state, key(name, char));

const task = (over: Partial<TaskView>): TaskView => ({
  id: 'task-1', order: 1, title: 'Do the thing', type: 'ai', status: 'pending', dependencies: [], ...over,
});

const planningState = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 'session-1', tasks: [task({})], planner: 'planning', ...over });

/** Type `text` into the editor of `state` and press enter. */
const submitInto = (state: TuiState, text: string): TuiState =>
  press({ ...state, editor: { ...state.editor, text, cursor: text.length } }, 'enter').state;

describe('submitting while a planner turn is in flight', () => {
  it('queues instead of sending, and shows nothing in the transcript yet', () => {
    const { state, effects } = run('also cover caching', planningState());

    expect(effects).toEqual([]);
    expect(state.queuedPrompts).toEqual(['also cover caching']);
    expect(messagesOf(state).some((m) => m.role === 'user')).toBe(false);
    expect(state.editor.text).toBe('');
  });

  it('queues for a research turn too, the other in-flight status', () => {
    const { effects, state } = run('follow-up', planningState({ planner: 'planning' }));
    expect(effects).toEqual([]);
    expect(state.queuedPrompts).toEqual(['follow-up']);
  });

  it('keeps queueing several prompts in order', () => {
    const first = run('one', planningState()).state;
    const second = submitInto(first, 'two');

    expect(second.queuedPrompts).toEqual(['one', 'two']);
    expect(messagesOf(second).every((m) => m.role !== 'user')).toBe(true);
  });

  it('still sends immediately when no turn is in flight', () => {
    const { effects } = run('use bcrypt', planningState({ planner: 'idle' }));
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 'session-1', message: 'use bcrypt' }]);
  });

  it('the very first goal is never queued, even though it sets the status itself', () => {
    const { effects } = run('build a login page', planningState({ planner: 'idle', sessionId: null }));
    expect(effects).toEqual([{ type: 'startConversation', goal: 'build a login page' }]);
  });

  it('plain slash commands still run while a turn is in flight', () => {
    const { effects, state } = run('/refresh', planningState());
    expect(effects).toEqual([{ type: 'refresh', announce: true, sessionId: 'session-1' }]);
    expect(state.queuedPrompts).toEqual([]);
  });
});

describe('the turn settling sends the queued prompts', () => {
  const queued = (over: Partial<TuiState> = {}): TuiState =>
    run('follow up', planningState(over)).state;

  it('planUpdated ends the turn, speaks the queued prompt, and starts the next turn', () => {
    const state = queued({ scroll: 5 });
    const { state: after, effects } = reduce(state, {
      type: 'planUpdated',
      plan: { tasks: [task({})] },
      sessionId: 'session-1',
    });

    expect(lastMessage(after)).toMatchObject({ role: 'user', text: 'follow up' });
    expect(after.planner).toBe('planning');
    expect(after.queuedPrompts).toEqual([]);
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 'session-1', message: 'follow up' }]);
  });

  it('sends every queued prompt in one settle, glued in the order typed', () => {
    let state = run('one', planningState()).state;
    state = submitInto(state, 'two');
    state = submitInto(state, 'three');

    const { state: after, effects } = reduce(state, { type: 'planUpdated', plan: {}, sessionId: 'session-1' });

    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 'session-1', message: 'one\ntwo\nthree' }]);
    expect(after.queuedPrompts).toEqual([]);
    expect(messagesOf(after).filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['one\ntwo\nthree']);
    expect(after.planner).toBe('planning');
  });

  it('a failing turn sends the queued prompt too', () => {
    const state = queued();
    const { state: after, effects } = reduce(state, { type: 'failed', message: 'the planner timed out', turn: true });

    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 'session-1', message: 'follow up' }]);
    expect(after.planner).toBe('planning');
    expect(messagesOf(after).some((m) => m.role === 'error')).toBe(true);
  });

  it('an idle failure does not drain the queue — only a turn ending does', () => {
    const state = { ...queued(), status: 'executing' as const, planner: 'idle' as const };
    const { effects } = reduce(state, { type: 'failed', message: 'boom' });
    expect(effects).toEqual([]);
  });

  it('a plan refresh during execution never drains the queue', () => {
    const state = { ...queued(), status: 'executing' as const, planner: 'idle' as const };
    const { effects } = reduce(state, { type: 'planUpdated', plan: {}, sessionId: 'session-1' });
    expect(effects).toEqual([]);
  });

  it('a queued skill command goes out verbatim, like any prompt', () => {
    registerSkillCommands([{ name: 'grilling-after', description: 'Grill the plan' }]);
    try {
      const state = run('/grilling-after', planningState()).state;
      const { state: after } = reduce(state, { type: 'planUpdated', plan: {}, sessionId: 'session-1' });

      expect(lastMessage(after)).toMatchObject({ role: 'user', text: '/grilling-after' });
    } finally {
      registerSkillCommands([]);
    }
  });
});

describe('esc takes the newest queued prompt back', () => {
  it('fills an empty composer with it, the caret at its end, and leaves the older ones queued', () => {
    let state = submitInto(planningState(), 'first');
    state = submitInto(state, 'second\nthoughts');

    const { state: after, effects } = press(state, 'escape');

    expect(effects).toEqual([]);
    expect(after.queuedPrompts).toEqual(['first']);
    expect(after.editor.text).toBe('second\nthoughts');
    expect(after.editor.cursor).toBe('second\nthoughts'.length);
    expect(after.planner).toBe('planning');
  });

  it('discards it when the composer holds a draft, leaving the draft as it was', () => {
    let state = submitInto(planningState(), 'first');
    state = submitInto(state, 'second');
    // A draft typed after queueing, the thing the takeback must not touch.
    const drafted = { ...state, editor: { ...state.editor, text: 'a draft', cursor: 3 } };

    const { state: after, effects } = press(drafted, 'escape');

    expect(effects).toEqual([]);
    expect(after.queuedPrompts).toEqual(['first']);
    expect(after.editor).toEqual(drafted.editor);
    expect(after.planner).toBe('planning');
  });

  it('takes one prompt per press, newest first, before the next esc arms a stop', () => {
    let state = submitInto(planningState(), 'first');
    state = submitInto(state, 'second');
    const drafted = { ...state, editor: { ...state.editor, text: 'a draft', cursor: 7 } };

    const once = press(drafted, 'escape').state;
    const twice = press(once, 'escape').state;
    expect(twice.queuedPrompts).toEqual([]);
    expect(twice.stopArmed).toBe(false);

    const { state: armed, effects } = press(twice, 'escape');
    expect(armed.stopArmed).toBe(true);
    expect(effects).toEqual([{ type: 'disarmStop', afterMs: 2000, arm: 1 }]);
  });

  it('keeps the planner running — the first esc is not a stop while something is queued', () => {
    let state = planningState();
    state = submitInto(state, 'unsent');
    const { state: after, effects } = press(state, 'escape');

    expect(effects).toEqual([]);
    expect(after.planner).toBe('planning');
  });
});

describe('double esc stops the turn', () => {
  it('the first esc arms a stop and schedules the disarm through an effect', () => {
    const { state, effects } = press(planningState(), 'escape');

    expect(effects).toEqual([{ type: 'disarmStop', afterMs: 2000, arm: 1 }]);
    expect(state.stopArmed).toBe(true);
    expect(state.planner).toBe('planning');
    expect(state.editor.text).toBe('');
  });

  it('the second esc stops the turn with the existing cancelPlanning', () => {
    const armed = press(planningState(), 'escape').state;
    const { state, effects } = press(armed, 'escape');

    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 'session-1' }]);
    expect(state.stopArmed).toBe(false);
  });

  it('the disarm action clears the arm without stopping anything', () => {
    const armed = press(planningState(), 'escape').state;
    const { state, effects } = reduce(armed, { type: 'stopDisarmed', arm: armed.stopArmToken });

    expect(state.stopArmed).toBe(false);
    expect(effects).toEqual([]);
    expect(state.planner).toBe('planning');
  });

  it('a stale expiry cannot cut a newer arm short', () => {
    const first = press(planningState(), 'escape').state;
    const disarmed = press(first, 'char', 'x').state;
    const rearmed = press(disarmed, 'escape').state;

    // The first arm's timer fires, but it is no longer the live arm.
    const stale = reduce(rearmed, { type: 'stopDisarmed', arm: first.stopArmToken });
    expect(stale.state.stopArmed).toBe(true);

    const expired = reduce(rearmed, { type: 'stopDisarmed', arm: rearmed.stopArmToken });
    expect(expired.state.stopArmed).toBe(false);
  });

  it('any other key disarms the stop', () => {
    const armed = press(planningState({ editor: { ...initialState().editor, text: 'draft', cursor: 5 } }), 'escape').state;
    const { state, effects } = press(armed, 'char', 'x');

    expect(state.stopArmed).toBe(false);
    expect(effects).toEqual([]);
    expect(state.editor.text).toBe('draftx');
  });

  it('the armed esc does not clear the draft', () => {
    const armed = press(planningState({ editor: { ...initialState().editor, text: 'x', cursor: 1 } }), 'escape');
    expect(armed.state.editor.text).toBe('x');
    expect(armed.state.editor.text).not.toBe('');
  });

  it('stopping the planning turn returns still-queued prompts to the editor, not to the daemon', () => {
    // The only stop that leaves anything queued is /stop — the Esc route
    // takes the queue back one press at a time before it can arm, so its queue
    // is empty by the time it stops.
    let state = planningState();
    state = submitInto(state, 'one');
    state = submitInto(state, 'two');
    const { state: stopped, effects } = run('/stop', { ...state, planner: 'planning' });

    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 'session-1' }]);
    expect(stopped.queuedPrompts).toEqual([]);
    expect(stopped.editor.text).toBe('one\ntwo');
  });
});

describe('the approval overlay with double esc', () => {
  const approvalState = (over: Partial<TuiState> = {}): TuiState => ({
    ...planningState(over),
    overlay: { kind: 'approval', request: { id: 'ap-1', kind: 'shell_command', subject: 'npm test', scope: 'npm test' } },
  });

  it('the first esc neither denies nor stops — it arms', () => {
    const { state, effects } = press(approvalState(), 'escape');

    expect(effects).toEqual([{ type: 'disarmStop', afterMs: 2000, arm: 1 }]);
    expect(state.overlay).toMatchObject({ kind: 'approval' });
    expect(state.stopArmed).toBe(true);
  });

  it('the second esc stops the turn, closing the overlay and the queue behind it', () => {
    const armed = press(approvalState(), 'escape').state;
    const { state, effects } = press(armed, 'escape');

    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 'session-1' }]);
    expect(state.overlay).toBeNull();
    expect(state.pendingApprovals).toEqual([]);
  });

  it('esc still denies when the turn has settled, as before', () => {
    const { state, effects } = press(approvalState({ planner: 'idle' }), 'escape');

    expect(effects).toEqual([{ type: 'respondApproval', sessionId: 'session-1', approvalId: 'ap-1', granted: false }]);
    expect(state.overlay).toBeNull();
  });
});

describe('esc when idle is unchanged', () => {
  it('clears the chat draft', () => {
    const { state, effects } = press(planningState({ planner: 'idle', editor: { ...initialState().editor, text: 'left in the box', cursor: 14 } }), 'escape');

    expect(effects).toEqual([]);
    expect(state.editor.text).toBe('');
  });

  it('returns plan-pane focus to chat', () => {
    const { state, effects } = press(planningState({ planner: 'idle', focus: 'plan' }), 'escape');
    expect(effects).toEqual([]);
    expect(state.focus).toBe('chat');
  });
});

describe('leftover queue on a settling turn whose queue was emptied another way', () => {
  it('a prompt taken back stays in the editor while the settle sends what is still queued', () => {
    let state = run('one', planningState()).state;
    state = submitInto(state, 'two');

    // Unsend `two` back to the editor; `one` is still queued.
    const unsent = press(state, 'escape').state;
    expect(unsent.queuedPrompts).toEqual(['one']);
    expect(unsent.editor.text).toBe('two');
    expect(unsent.editor.cursor).toBe(3);

    const settled = reduce(unsent, { type: 'planUpdated', plan: {}, sessionId: 'session-1' });
    expect(lastMessage(settled.state)).toMatchObject({ role: 'user', text: 'one' });
    expect(settled.state.editor.text).toBe('two');
  });
});

describe('rendering — queued prompts', () => {
  it('renders as dimmed bubbles below the transcript, in order, the newest marked `queued · esc takes back`', () => {
    style.enabled = false;
    try {
      const out = render(planningState({ queuedPrompts: ['extra thought', 'and another'] })).join('\n');

      expect(out).toContain('extra thought');
      expect(out).toContain('queued · esc takes back');
      expect((out.match(/queued · esc takes back/g) ?? []).length).toBe(1);
      // Ordering: the first queued prompt paints above the second.
      expect(out.indexOf('extra thought')).toBeLessThan(out.indexOf('and another'));
    } finally {
      style.enabled = true;
    }
  });

  it('nothing renders when the queue is empty', () => {
    style.enabled = false;
    try {
      const out = render(planningState({ queuedPrompts: [] })).join('\n');
      expect(out).not.toContain('queued · esc takes back');
    } finally {
      style.enabled = true;
    }
  });

  it('the bubble is dimmed, so it reads as unsent beside a bright user turn', () => {
    style.enabled = true;
    try {
      const out = render(planningState({ queuedPrompts: ['a parked thought'] })).join('\n');
      const line = out.split('\n').find((l) => l.includes('a parked thought')) ?? '';
      expect(line).toContain('\x1b[90m'); // style.grey
    } finally {
      style.enabled = false;
    }
  });
});

describe('rendering — the armed stop hint', () => {
  it('a red `Press Esc again to stop` hint appears at the bottom left while armed', () => {
    style.enabled = true;
    try {
      const frame = render(planningState({ stopArmed: true }));
      const bottomRows = frame.slice(-6).join('\n');

      expect(bottomRows).toContain('Press Esc again to stop');
      expect(bottomRows).toContain('\x1b[31m');
    } finally {
      style.enabled = false;
    }
  });

  it('the hint is gone once the arm lapses', () => {
    style.enabled = true;
    try {
      const lapsed = render(planningState({ stopArmed: false })).join('\n');
      expect(lapsed).not.toContain('Press Esc again to stop');
    } finally {
      style.enabled = false;
    }
  });
});

// The daemon broadcasts the plan a turn lands to every socket on the session,
// and the follow socket is open through every turn: its copy can beat the REST
// answer `converse` settles the turn with.
describe('a plan broadcast during the surface\'s own turn', () => {
  it('neither settles the turn nor sends the queued prompt', () => {
    const state = run('follow up', planningState()).state;
    const { state: after, effects } = reduce(state, {
      type: 'planBroadcast',
      plan: { tasks: [task({ title: 'Edited' })] },
      sessionId: 'session-1',
    });

    expect(after.planner).toBe('planning');
    expect(after.queuedPrompts).toEqual(['follow up']);
    expect(effects).toEqual([]);
  });

  it('updates the pane when no turn of this surface is out (a supervisor\'s edit)', () => {
    const state = initialState({ sessionId: 'session-1', tasks: [task({})], status: 'executing' });
    const { state: after } = reduce(state, {
      type: 'planBroadcast',
      plan: { tasks: [task({ title: 'Edited', status: 'in_progress' })] },
      sessionId: 'session-1',
    });

    expect(after.tasks[0].title).toBe('Edited');
  });
});
