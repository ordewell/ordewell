import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import { render } from '../render';
import { bodyRows, chatBodyLines, chatScrollMax, planScrollExtent } from '../layout';
import type { ChatMessage, TaskView, TuiState } from '../state';

/**
 * The scroll model, asserted where the user meets it: a key goes in, the frame
 * either moves or it does not.
 *
 * The defect these pin down was a dead zone, not a lost keystroke. The offset
 * grew past the end of the content while the renderer clamped to the content,
 * so every notch back the other way was swallowed until the counter fell under
 * the bound — the wheel "did nothing", and pgup/pgdn mostly worked but
 * sometimes did not.
 */

const press = (state: TuiState, name: string, char?: string): Step =>
  reduce(state, { type: 'key', key: { name, char } });

const frame = (state: TuiState): string => render(state).join('\n');

/** The pane text with ANSI stripped, so assertions read the words on screen. */
const plain = (state: TuiState): string =>
  // eslint-disable-next-line no-control-regex
  frame(state).replace(/\x1b\[[0-9;]*m/g, '');

function repeat(state: TuiState, name: string, times: number): TuiState {
  let next = state;
  for (let i = 0; i < times; i++) next = press(next, name).state;
  return next;
}

const tasks = (n: number): TaskView[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`, order: i + 1, title: `Task ${i + 1}`,
    type: 'ai' as const, status: 'pending', dependencies: [],
  }));

const planState = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 20, cols: 80, tasks: tasks(30), focus: 'plan', ...over });

const chatState = (lines: number, over: Partial<TuiState> = {}): TuiState => {
  const messages: ChatMessage[] = Array.from({ length: lines }, (_, i) => ({
    role: 'user' as const, content: `message ${i + 1}`, timestamp: '',
  }));
  return initialState({ rows: 12, cols: 60, messages, ...over });
};

describe('chat pane — no dead notches', () => {
  it('moves on the first wheel-down after twenty wheel-ups', () => {
    const overscrolled = repeat(chatState(6), 'scrollup', 20);
    expect(frame(press(overscrolled, 'scrolldown').state)).not.toBe(frame(overscrolled));
  });

  it('moves on the first pagedown after twenty pageups', () => {
    const overscrolled = repeat(chatState(40), 'pageup', 20);
    expect(frame(press(overscrolled, 'pagedown').state)).not.toBe(frame(overscrolled));
  });

  it('never carries an offset past the lines that exist', () => {
    const overscrolled = repeat(chatState(6), 'scrollup', 20);
    expect(overscrolled.scroll).toBe(chatScrollMax(overscrolled));
  });

  it('scrolls back to the very first line of the transcript and no further', () => {
    // With a plan in hand the welcome is gone, so the transcript's own first
    // line is the top of the pane.
    const top = repeat(chatState(40, { tasks: tasks(1) }), 'pageup', 20);
    expect(plain(top)).toContain('message 1');
  });

  it('counts the welcome as part of what scrolls, before a plan replaces it', () => {
    const top = repeat(chatState(40), 'pageup', 20);
    expect(plain(top)).toContain('Describe a goal to start planning.');
  });
});

describe('plan pane — an absolute offset that follows the selection by default', () => {
  it('reaches the first task with the last one selected', () => {
    // The delta-on-top-of-the-auto-anchor model could not do this at all: the
    // offset was clamped at zero from below, so the pane could never show
    // anything above the selected task.
    const scrolledUp = repeat(planState({ selectedTask: 29 }), 'pageup', 20);

    expect(plain(scrolledUp)).toContain('Task 1 ');
    expect(scrolledUp.planScroll).toBe(0);
  });

  it('seeds the first manual notch from where the view already is, so nothing jumps', () => {
    const following = planState({ selectedTask: 29 });
    const { followOffset } = planScrollExtent(following);
    expect(followOffset, 'the plan must overflow the pane for this to mean anything').toBeGreaterThan(0);

    const nudged = press(following, 'scrollup').state;

    expect(nudged.planScroll).toBe(followOffset - 3);
  });

  it('stops at the end of the plan, and one notch back up moves immediately', () => {
    const bottom = repeat(planState({ selectedTask: 0 }), 'pagedown', 20);
    expect(bottom.planScroll).toBe(planScrollExtent(bottom).maxScroll);
    expect(plain(bottom)).toContain('Task 30');

    expect(frame(press(bottom, 'scrollup').state)).not.toBe(frame(bottom));
  });

  it('hands the viewport back to the selection when the arrows move it', () => {
    const scrolled = repeat(planState({ selectedTask: 20 }), 'pageup', 20);
    expect(scrolled.planScroll).toBe(0);

    const moved = press(scrolled, 'down').state;

    expect(moved.planScroll).toBeNull();
    expect(plain(moved)).toContain('Task 22');
  });
});

describe('expanded task editor — the same one offset', () => {
  const expanded = (): TuiState => press(planState({ selectedTask: 0 }), 'enter').state;

  it('scrolls the pane, not the prompt text, and moves on the first notch back', () => {
    const bottom = repeat(expanded(), 'pagedown', 20);
    expect(bottom.expandedTaskId).toBe('t1');
    expect(bottom.planScroll).toBe(planScrollExtent(bottom).maxScroll);

    expect(frame(press(bottom, 'pageup').state)).not.toBe(frame(bottom));
  });
});

describe('help overlay — the same one offset', () => {
  const help = (): TuiState => initialState({ rows: 20, cols: 80, overlay: { kind: 'help', scroll: 0 } });
  const helpScroll = (state: TuiState): number =>
    state.overlay?.kind === 'help' ? state.overlay.scroll ?? 0 : -1;

  it('moves on the first pageup after twenty pagedowns', () => {
    const bottom = repeat(help(), 'pagedown', 20);
    expect(frame(press(bottom, 'pageup').state)).not.toBe(frame(bottom));
  });

  it('holds the sheet\'s last row rather than counting past it', () => {
    const bottom = repeat(help(), 'pagedown', 20);
    const further = press(bottom, 'pagedown').state;
    expect(helpScroll(further)).toBe(helpScroll(bottom));
  });
});

describe('scrolled-back marker', () => {
  it('says so once the transcript is held off its tail', () => {
    const scrolled = press(chatState(40), 'pageup').state;
    expect(plain(scrolled)).toContain('↑ scrolled back');
  });

  it('says nothing while the transcript is live', () => {
    expect(plain(chatState(40))).not.toContain('↑ scrolled back');
  });

  it('says so once the plan pane stops following the selection', () => {
    expect(plain(press(planState(), 'pagedown').state)).toContain('↑ scrolled back');
    expect(plain(planState())).not.toContain('↑ scrolled back');
  });

  it('does not change the body height, so a page up and a page down are the same size', () => {
    const live = chatState(40);
    const back = press(live, 'pageup').state;

    expect(bodyRows(back)).toBe(bodyRows(live));
    expect(press(back, 'pagedown').state.scroll).toBe(0);
  });
});

describe('chat body memo', () => {
  it('is still hit when only planScroll and spinnerFrame change', () => {
    const state = chatState(4, { tasks: tasks(3) });
    const first = chatBodyLines(state.messages, 40);

    const churned = { ...state, planScroll: 7, spinnerFrame: 4 };
    expect(chatBodyLines(churned.messages, 40)).toBe(first);
  });

  it('serves the reducer\'s scroll bound from the same entry the renderer paints from', () => {
    const state = chatState(40);
    render(state);
    const painted = chatBodyLines(state.messages, state.cols);

    chatScrollMax(state);

    expect(chatBodyLines(state.messages, state.cols)).toBe(painted);
  });
});
