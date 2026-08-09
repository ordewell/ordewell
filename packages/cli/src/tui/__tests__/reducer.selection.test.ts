import { describe, it, expect, beforeAll } from 'vitest';
import { initialState, reduce, type Effect, type Step } from '../reducer';
import { style, width } from '../ansi';
import type { ChatMessage, TaskView, TuiState } from '../state';

beforeAll(() => {
  // The copied text is stripped of paint either way; leaving colour on would
  // only make the pane-width assertions read as if they were about escapes.
  style.enabled = false;
});

/**
 * At cols 80 with a plan, `planPaneWidth` is 36 and `chatPaneWidth` 43 — so the
 * chat owns columns 1–43, the divider is 44, and the plan owns 45–80. Every
 * column in these tests is chosen against that layout.
 */
const CHAT_LAST = 43;
const PLAN_FIRST = 45;

const tasks: TaskView[] = [
  { id: 'a', order: 1, title: 'Add the login route', type: 'ai', status: 'pending', dependencies: [] },
  { id: 'b', order: 2, title: 'Write the tests', type: 'ai', status: 'pending', dependencies: ['a'] },
];

const screenState = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ rows: 24, cols: 80, tasks, ...over });

const mouse = (state: TuiState, name: string, col: number, row: number): Step =>
  reduce(state, { type: 'key', key: { name, col, row } });

/**
 * Two panes whose text cannot be confused for one another: every chat row says
 * PANECHAT and every task title says PANEPLAN, so a copy that spliced the two
 * shows up as the wrong word rather than as an off-by-one column.
 */
const twoPanes = (): TuiState => screenState({
  messages: Array.from({ length: 30 }, (_, i): ChatMessage => ({
    role: 'user', content: `PANECHAT row ${i} filling the whole chat pane`, timestamp: '',
  })),
  tasks: Array.from({ length: 20 }, (_, i): TaskView => ({
    id: `t${i}`, order: i + 1, title: `PANEPLAN task ${i}`, type: 'ai', status: 'pending', dependencies: [],
  })),
});

/** Press, drag and release across the given cells, returning the release step. */
function drag(state: TuiState, from: [number, number], to: [number, number]): Step {
  const down = mouse(state, 'mousedown', from[0], from[1]).state;
  const moved = mouse(down, 'mousedrag', to[0], to[1]).state;
  return mouse(moved, 'mouseup', to[0], to[1]);
}

const copied = (effects: Effect[]): string => {
  const effect = effects.find((e): e is Extract<Effect, { type: 'copyText' }> => e.type === 'copyText');
  if (!effect) throw new Error('the release emitted no copyText effect');
  return effect.text;
};

describe('a drag inside one pane', () => {
  it('anchors the selection where the button went down and pins it to that pane', () => {
    const down = mouse(screenState(), 'mousedown', 5, 3).state;
    const dragged = mouse(down, 'mousedrag', 20, 3).state;

    expect(dragged.selection).toEqual({
      anchor: { col: 5, row: 3 },
      head: { col: 20, row: 3 },
      pane: 'chat',
    });
  });

  it('clamps a drag that wanders out of the plan pane back to the pane it started in', () => {
    const down = mouse(screenState(), 'mousedown', 60, 3).state;
    const wandered = mouse(down, 'mousedrag', 10, 6).state;

    // The row is honoured — the selection runs *down* the plan pane — but the
    // column stops at the plan's first column instead of crossing the divider.
    expect(wandered.selection).toEqual({
      anchor: { col: 60, row: 3 },
      head: { col: PLAN_FIRST, row: 6 },
      pane: 'plan',
    });
  });

  it('clamps a chat drag that wanders into the plan pane back to the chat', () => {
    const down = mouse(screenState(), 'mousedown', 10, 3).state;
    const wandered = mouse(down, 'mousedrag', 70, 5).state;

    expect(wandered.selection).toMatchObject({ head: { col: CHAT_LAST, row: 5 }, pane: 'chat' });
  });
});

describe('what a release copies', () => {
  it('copies chat text only, with not one character of the plan pane in it', () => {
    const text = copied(drag(twoPanes(), [1, 6], [CHAT_LAST, 9]).effects);

    expect(text).toContain('PANECHAT');
    expect(text).not.toContain('PANEPLAN');
    // The divider itself lives one column past the chat pane and must not come
    // along either — it is the seam the splice used to happen at.
    expect(text).not.toContain('│');
  });

  it('copies plan text only when the drag started there', () => {
    const text = copied(drag(twoPanes(), [PLAN_FIRST, 6], [78, 9]).effects);

    expect(text).toContain('PANEPLAN');
    expect(text).not.toContain('PANECHAT');
  });

  it('returns one line per selected row, each clipped to the origin pane', () => {
    const text = copied(drag(twoPanes(), [1, 6], [CHAT_LAST, 9]).effects);
    const lines = text.split('\n');

    expect(lines).toHaveLength(4);
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(CHAT_LAST);
  });

  // A cell-addressed highlight left standing after release would drift once the
  // copy notice's chat message reflows the transcript underneath it — so release
  // must drop the selection in the same step that copies its text.
  it('drops the selection in the very release that copies it', () => {
    const released = drag(twoPanes(), [1, 6], [CHAT_LAST, 9]);

    expect(copied(released.effects)).toContain('PANECHAT');
    expect(released.state.selection).toBeNull();
  });
});

describe('a click that is not a drag', () => {
  it('clears the standing selection instead of copying an empty range', () => {
    // A standing selection only exists mid-drag now — release drops it — so
    // this leaves the button down rather than using the drag() helper.
    const down1 = mouse(twoPanes(), 'mousedown', 1, 6).state;
    const selected = mouse(down1, 'mousedrag', CHAT_LAST, 9).state;
    expect(selected.selection).not.toBeNull();

    const down2 = mouse(selected, 'mousedown', 10, 12).state;
    const clicked = mouse(down2, 'mouseup', 10, 12);

    expect(clicked.state.selection).toBeNull();
    expect(clicked.effects).toEqual([]);
  });
});

describe('what a drag must not disturb', () => {
  it('never reaches the line editor', () => {
    const typing = screenState({ editor: { ...initialState().editor, text: 'draft', cursor: 5 } });
    const after = drag(typing, [5, 6], [20, 8]).state;

    expect(after.editor.text).toBe('draft');
  });

  it('never reaches the plan pane shortcuts, which would expand or remove a task', () => {
    const planFocused = screenState({ focus: 'plan', sessionId: 's1' });
    const after = drag(planFocused, [PLAN_FIRST, 6], [70, 8]);

    expect(after.state.expandedTaskId).toBeNull();
    expect(after.state.overlay).toBeNull();
    expect(after.effects.every((e) => e.type === 'copyText')).toBe(true);
  });

  // A resize re-lays out both panes and moves the divider, so the cells a
  // standing selection names now hold different text — and a span anchored
  // where the plan pane used to start can end up straddling the new divider,
  // which is the splice the pane pinning exists to prevent.
  it('drops a standing selection when the terminal is resized', () => {
    // Same reasoning as the click-clears case: a standing selection only
    // exists mid-drag, so leave the button down instead of releasing first.
    const down = mouse(twoPanes(), 'mousedown', PLAN_FIRST, 6).state;
    const selected = mouse(down, 'mousedrag', 70, 9).state;
    expect(selected.selection).not.toBeNull();

    const resized = reduce(selected, { type: 'resize', rows: 40, cols: 120 }).state;
    expect(resized.selection).toBeNull();
  });

  it('leaves the wheel scrolling both panes exactly as before', () => {
    const state = twoPanes();
    const overChat = reduce(state, { type: 'key', key: { name: 'scrollup', col: 10, row: 5 } }).state;
    expect(overChat.scroll).toBe(3);
    expect(overChat.selection).toBeNull();

    const overPlan = reduce(state, { type: 'key', key: { name: 'scrolldown', col: 60, row: 5 } }).state;
    expect(overPlan.planScroll).not.toBeNull();
    expect(overPlan.scroll).toBe(0);
  });
});
