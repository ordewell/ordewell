import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayTaskLog } from '@ordewell/core';
import { stripAnsi, style, width } from '../ansi';
import { reduce } from '../reducer';
import { render, selectedText } from '../render';
import { initialState, type TaskLogState, type TaskView, type TuiState } from '../state';

const ALLOWLIST_TIP = 'Tip: Use /allowlist to limit which models the planner assigns per runner.';
const RUNNERS_TIP = 'Tip: Use /runners to turn runners on or off.';

let wasEnabled: boolean;
beforeEach(() => { wasEnabled = style.enabled; style.enabled = true; });
afterEach(() => { style.enabled = wasEnabled; });

const at = (cols: number, over: Partial<TuiState> = {}): TuiState => initialState({ rows: 24, cols, ...over });
const typed = (text: string, over: Partial<TuiState> = {}): TuiState => {
  const s = at(80, over);
  return { ...s, editor: { ...s.editor, text, cursor: text.length } };
};
/** The frame row the prompt is on: the composer's text row. */
const composerRow = (state: TuiState): number => render(state).findIndex((row) => stripAnsi(row).startsWith('❯')) + 1;
const composerText = (state: TuiState): string => stripAnsi(render(state)[composerRow(state) - 1] ?? '').trimEnd();
const key = (state: TuiState, name: string, extra: { char?: string; text?: string } = {}): TuiState =>
  reduce(state, { type: 'key', key: { name, ...extra } }).state;

describe('the empty planner composer shows a command tip (#137)', () => {
  it('right after the caret, on the band, in the grey the slash hint uses', () => {
    const row = render(at(80))[composerRow(at(80)) - 1];
    expect(row).toContain(style.bandGrey(` ${ALLOWLIST_TIP}`));
    expect(composerText(at(80))).toBe(`❯   ${ALLOWLIST_TIP}`);
  });

  it('still reads as a tip with colour off', () => {
    style.enabled = false;
    expect(composerText(at(80))).toContain(ALLOWLIST_TIP);
  });

  it('gives way to typed and pasted text, which the composer shows alone', () => {
    expect(composerText(typed('add a login route'))).toBe('❯ add a login route');
    const pasted = key(at(80), 'paste', { text: 'pasted text' });
    expect(pasted.editor.text).toBe('pasted text');
    expect(composerText(pasted)).not.toContain('Tip:');
  });

  it('shows none on a task view\'s composer, a blurred composer, or one under an overlay', () => {
    const task: TaskView = { id: 't1', order: 3, title: 'Refactor', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code' };
    const taskView: TaskLogState = {
      taskId: 't1',
      view: replayTaskLog([{ type: 'text_delta', text: 'On it.' }, { type: 'turn_end', reason: 'completed' }]),
      attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0,
    };
    // The help sheet `/help` opens lists every command itself.
    const helpOpen = at(80, { overlay: { kind: 'help', scroll: 0 } });
    for (const state of [at(80, { tasks: [task], taskView }), at(80, { focus: 'plan' }), helpOpen]) {
      expect(render(state).some((row) => stripAnsi(row).includes('Tip:'))).toBe(false);
    }
  });

  it('is cut to fit a narrow terminal, and left out where too little room remains', () => {
    for (const cols of [40, 24, 12]) {
      const frame = render(at(cols));
      for (const row of frame) expect(width(row)).toBeLessThanOrEqual(cols);
    }
    expect(composerText(at(40))).toMatch(/^❯ {3}Tip: Use \/allowlist .*…$/);
    expect(composerText(at(12))).not.toContain('Tip');
  });

  it('is never copied with a selection over the composer, which still copies what was typed', () => {
    const select = (state: TuiState): TuiState => {
      const row = composerRow(state);
      return { ...state, selection: { anchor: { col: 1, row }, head: { col: state.cols, row }, pane: 'chat' } };
    };
    expect(selectedText(select(typed('add a login route')))).toContain('add a login route');
    expect(selectedText(select(at(80)))).not.toContain('Tip');
  });

  it('is not painted while mouse capture is off, where a terminal selection would copy it', () => {
    expect(composerText(at(80))).toContain(ALLOWLIST_TIP);
    expect(composerText(at(80, { mouseCapture: false }))).not.toContain('Tip:');
  });
});

describe('which tip shows (#137)', () => {
  it('moves on once each time the composer is emptied, and holds still otherwise', () => {
    const start = at(80);
    const typedOne = key(start, 'char', { char: 'x' });
    expect(typedOne.composerTipSeq).toBe(0);
    const emptied = key(typedOne, 'backspace');
    expect(emptied.composerTipSeq).toBe(1);
    expect(composerText(emptied)).toContain(RUNNERS_TIP);
    // A key that leaves the empty composer empty picks no new tip.
    expect(key(emptied, 'left').composerTipSeq).toBe(1);
  });
});
