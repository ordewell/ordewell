import { describe, it, expect } from 'vitest';
import { capConflictFiles } from '@ordewell/core';
import { initialState, reduce, type Step } from '../reducer';
import { render } from '../render';
import { stripAnsi, style } from '../ansi';
import { bodyRows, chatBodyLines, chatLayout, chatScrollMax, footerHints, helpLayout, planOffset, planScrollExtent } from '../layout';
import type { TaskView, TuiState } from '../state';
import { chatOf } from './chat';

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

/** The first task whose every line is inside the pane's viewport. */
function firstFullyVisibleRow(state: TuiState): number {
  const layout = planScrollExtent(state);
  const offset = planOffset(layout, state.planScroll);
  return layout.rowSpans.findIndex((span) => span.start >= 1 + offset && span.end <= offset + layout.rows - 1);
}

const chatState = (lines: number, over: Partial<TuiState> = {}): TuiState => {
  const conversation = chatOf(...Array.from({ length: lines }, (_, i): ['user', string] => ['user', `message ${i + 1}`]));
  return initialState({ rows: 12, cols: 60, conversation, ...over });
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
    const seen = planOffset(planScrollExtent(following), following.planScroll);
    expect(seen, 'the plan must overflow the pane for this to mean anything').toBeGreaterThan(0);

    const nudged = press(following, 'scrollup').state;

    expect(nudged.planScroll).toBe(seen - 3);
  });

  it('stops at the end of the plan, and one notch back up moves immediately', () => {
    const bottom = repeat(planState({ selectedTask: 0 }), 'pagedown', 20);
    expect(bottom.planScroll).toBe(planScrollExtent(bottom).maxScroll);
    expect(plain(bottom)).toContain('Task 30');

    expect(frame(press(bottom, 'scrollup').state)).not.toBe(frame(bottom));
  });

  it('keeps the viewport still while the cursor walks back up through it', () => {
    const start = planState({ selectedTask: 0 });
    // Rows are three lines tall, so a 20-row pane holds six of them.
    const down = repeat(start, 'down', 9);
    const offset = down.planScroll!;
    expect(offset, 'the cursor must have run past the bottom for this to mean anything').toBeGreaterThan(0);

    const top = firstFullyVisibleRow(down);
    const walked = repeat(down, 'up', down.selectedTask - top);
    expect(walked.selectedTask).toBe(top);
    expect(walked.planScroll).toBe(offset);

    const scrolled = press(walked, 'up').state;
    expect(scrolled.selectedTask).toBe(top - 1);
    // The bottom-aligned viewport had shown the tail of the task above, so the
    // step is however far that task's first line sits from the pane's top.
    expect(scrolled.planScroll).toBe(planScrollExtent(scrolled).rowSpans[top - 1].start - 1);
    expect(firstFullyVisibleRow(scrolled)).toBe(top - 1);
    const shown = plain(scrolled).split('\n');
    expect(shown[shown.findIndex((line) => line.includes('Plan 0/30')) + 1]).toContain(`Task ${top}`);
  });
});

describe('expanded task editor — the same one offset', () => {
  const expanded = (): TuiState => press(planState({ selectedTask: 0 }), 'right').state;

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

  it('stays quiet in the plan pane, where the selection is always on screen', () => {
    expect(plain(press(planState(), 'pagedown').state)).not.toContain('↑ scrolled back');
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
    const first = chatBodyLines(state.conversation.blocks, 40, false);

    const churned = { ...state, planScroll: 7, spinnerFrame: 4 };
    expect(chatBodyLines(churned.conversation.blocks, 40, false)).toBe(first);
  });

  it('serves the reducer\'s scroll bound from the same entry the renderer paints from', () => {
    const state = chatState(40);
    render(state);
    const painted = chatBodyLines(state.conversation.blocks, state.cols, state.detailAll);

    chatScrollMax(state);

    expect(chatBodyLines(state.conversation.blocks, state.cols, state.detailAll)).toBe(painted);
  });
});

describe('chat anchor', () => {
  it('top-anchors content that fits and bottom-anchors what overflows', () => {
    expect(chatLayout(chatState(1, { tasks: tasks(2) }), 12, 60).anchor).toBe('top');
    expect(chatLayout(chatState(40, { tasks: tasks(2) }), 12, 60).anchor).toBe('bottom');
  });

  it('top-anchors the welcome with or without messages while it fits', () => {
    expect(chatLayout(chatState(0, { rows: 60 }), 60, 80).anchor).toBe('top');
    expect(chatLayout(chatState(1, { rows: 60 }), 60, 80).anchor).toBe('top');
  });
});

describe('plan pane — conflict row', () => {
  const conflictTask = (isolation: Partial<NonNullable<TaskView['isolation']>>): TaskView => ({
    id: 't1', order: 1, title: 'Task 1', type: 'ai', status: 'awaiting_user', dependencies: [],
    isolation: { state: 'conflict', branch: 'ordewell/run1/1-t1', worktree: '/wt', repos: ['.'], ...isolation },
  });

  it('names the conflicting files', () => {
    const state = initialState({ sessionId: 's1', rows: 20, cols: 200, tasks: [conflictTask({ conflictFiles: ['a.ts', 'b.ts'] })], focus: 'plan' });

    expect(plain(state)).toContain('⚠ merge conflict (a.ts, b.ts)');
  });

  it('caps a long list of conflicting files', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
    const state = initialState({ sessionId: 's1', rows: 20, cols: 200, tasks: [conflictTask({ conflictFiles: files })], focus: 'plan' });

    expect(plain(state)).toContain(`⚠ merge conflict (${capConflictFiles(files)})`);
  });

  it('names no files when the record has none', () => {
    const state = initialState({ sessionId: 's1', rows: 20, cols: 200, tasks: [conflictTask({})], focus: 'plan' });

    expect(plain(state)).toContain('⚠ merge conflict — its work is kept on its own branch');
  });
});

describe('the armed stop cue', () => {
  const armed = (cols: number): TuiState =>
    initialState({ sessionId: 's1', status: 'planning', stopArmed: true, rows: 24, cols });

  it('renders once, as the red status row, at narrow and wide widths', () => {
    style.enabled = true;
    try {
      for (const cols of [40, 120]) {
        const frame = render(armed(cols)).join('\n');
        expect(frame.match(/Press Esc again to stop/g) ?? []).toHaveLength(1);
        expect(frame).not.toContain('esc again to stop');
        expect(frame).toContain('\x1b[31mPress Esc again to stop');
      }
    } finally {
      style.enabled = false;
    }
  });

  it('leaves the footer naming what one esc does instead of repeating the armed cue', () => {
    const hints = footerHints(armed(80));
    expect(hints).not.toContain('esc again to stop');
    expect(hints).toContain('esc ×2 stop planning');
  });

  it('keeps the footer height steady across arming, so the body does not move', () => {
    const unarmed = initialState({ sessionId: 's1', status: 'planning', rows: 24, cols: 80 });
    expect(bodyRows(armed(80))).toBe(bodyRows(unarmed));
  });
});

describe('the help sheet footer', () => {
  const helpFooter = (): string => stripAnsi(helpLayout(200, 120).lines.join('\n'));

  it('names the keys that actually work in the panes', () => {
    const footer = helpFooter();
    expect(footer).toContain('tab switches panes');
    expect(footer).toContain('pgup/pgdn scroll');
    expect(footer).toContain('ctrl-o toggles full detail');
    expect(footer).toContain('esc takes back a queued prompt');
  });

  it('drops the arrow keys and the removed per-block expansion mentions', () => {
    const footer = helpFooter();
    expect(footer).not.toContain('↑↓');
    expect(footer).not.toContain('alt-enter');
    expect(footer).not.toMatch(/alt[+-]?(↑|↓)/);
  });

  it('renders within narrow and wide frames', () => {
    for (const cols of [40, 120]) {
      const lines = render(initialState({ rows: 24, cols, overlay: { kind: 'help', scroll: 0 } }));
      expect(lines).toHaveLength(24);
      expect(lines.every((line) => stripAnsi(line).length <= cols)).toBe(true);
    }
  });
});
