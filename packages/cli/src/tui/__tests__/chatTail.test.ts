import { beforeAll, describe, expect, it } from 'vitest';
import type { ResearchLogEntry, SerializedConversationMessage, SessionMessage } from '@ordewell/core';
import { stripAnsi, style } from '../ansi';
import { conversationLines } from '../blocks';
import { bodyPanes, chatScrollMax } from '../layout';
import { reduce } from '../reducer';
import { render } from '../render';
import { initialState, type TaskView, type TuiState } from '../state';

/*
 * The chat pane lays out only as much of a long transcript as its viewport and
 * the scrollback in use need. What it paints must not change for that: every
 * frame here is checked against the whole transcript laid out at once
 * (`conversationLines`), windowed as the pane always has — the newest lines
 * at the bottom, `scroll` lines held back off the tail.
 */

beforeAll(() => {
  style.enabled = false;
});

const at = (i: number): string => new Date(Date.UTC(2026, 9, 1, 10, 0, i)).toISOString();
const words = (n: number, seed: number): string =>
  Array.from({ length: n }, (_, i) => ['plan', 'route', 'café', 'migrate', 'schema', '工具', 'verify', 'x'][(i * 7 + seed) % 8]).join(' ');

/** A saved conversation of `pairs` user messages, research steps and Markdown replies. */
function transcript(pairs: number): { history: SerializedConversationMessage[]; researchLog: ResearchLogEntry[] } {
  const history: SerializedConversationMessage[] = [];
  const researchLog: ResearchLogEntry[] = [];
  let t = 0;
  for (let p = 0; p < pairs; p += 1) {
    history.push({ role: 'user', content: `Question ${p}: ${words(12 + (p % 30), p)}`, timestamp: at(t++) } as SerializedConversationMessage);
    for (let s = 0; s < p % 3; s += 1) {
      researchLog.push({
        id: `r${p}-${s}`, tool: 'read_file', args: `src/file${p}.ts`,
        result: Array.from({ length: 4 + ((p + s) % 9) }, (_, i) => `line ${i} of file ${p}: ${words(6, i)}`).join('\n'),
        success: true, outcome: 'success', timestamp: at(t++),
      } as ResearchLogEntry);
    }
    const reply = `## Reply ${p}\n\n${words(40 + (p % 50), p)}\n\n- one ${words(5, p)}\n- two\n\n\`\`\`ts\nconst x${p} = ${p};\n\`\`\`\n`;
    history.push({ role: 'assistant', content: reply, timestamp: at(t++) } as SerializedConversationMessage);
  }
  return { history, researchLog };
}

const tasks: TaskView[] = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, order: i + 1, title: `Task ${i + 1}`, type: 'ai', status: 'pending', dependencies: [] }));

function restored(pairs: number, over: Partial<TuiState> = {}): TuiState {
  const state = initialState({ sessionId: 's', rows: 40, cols: 200, focus: 'chat', tasks, ...over });
  return reduce(state, { type: 'chatRestored', sessionId: 's', ...transcript(pairs) }).state;
}

/** The chat pane's rows of a frame: the left of a side-by-side body, or the top of a stacked one. */
function chatRows(state: TuiState): string[] {
  const { mode, chat } = bodyPanes(state);
  // Side by side, the divider follows an erase to the end of the row.
  return render(state).slice(0, chat.rows).map((row) => stripAnsi(mode === 'side' ? row.split('\x1b[K')[0]! : row).trimEnd());
}

/** The same rows from the whole transcript, laid out at once and windowed. */
function expectedRows(state: TuiState): string[] {
  const { chat } = bodyPanes(state);
  const all = conversationLines(state.conversation.blocks, chat.cols, state.detailAll).map(stripAnsi);
  const max = Math.max(0, all.length - chat.rows);
  const shown = all.slice(0, all.length - Math.min(state.scroll, max));
  const rows = all.length > chat.rows ? shown.slice(-chat.rows) : shown;
  return Array.from({ length: chat.rows }, (_, i) => (rows[i] ?? '').trimEnd());
}

const press = (state: TuiState, name: string): TuiState => reduce(state, { type: 'key', key: { name } as never }).state;

describe('the chat pane of a long transcript', () => {
  const sizes: Array<[string, Partial<TuiState>]> = [
    ['wide', { rows: 40, cols: 200 }],
    ['narrow, stacked over the plan', { rows: 40, cols: 60 }],
    ['short', { rows: 12, cols: 120 }],
  ];

  it.each(sizes)('paints the same lines at every scroll position, %s', (_name, size) => {
    for (const detailAll of [false, true]) {
      const state = restored(60, { ...size, detailAll });
      const max = conversationLines(state.conversation.blocks, bodyPanes(state).chat.cols, detailAll).length;
      for (const scroll of [0, 1, 7, 40, 333, Math.floor(max / 2), max - 3, max + 50]) {
        const at = { ...state, scroll };
        expect(chatRows(at), `scroll ${scroll}, detail ${detailAll}`).toEqual(expectedRows(at));
      }
    }
  });

  it('pages back to the very first line and forward to the tail again', () => {
    let state = restored(80, { rows: 30, cols: 100 });
    const { chat } = bodyPanes(state);
    const all = conversationLines(state.conversation.blocks, chat.cols, false).map((line) => stripAnsi(line).trimEnd());
    let presses = 0;
    for (;;) {
      const next = press(state, 'pageup');
      if (next.scroll === state.scroll) break;
      state = next;
      presses += 1;
      expect(chatRows(state)).toEqual(expectedRows(state));
    }
    expect(state.scroll).toBe(all.length - chat.rows);
    expect(chatRows(state)[0]).toBe(all[0]);
    expect(presses).toBeGreaterThan(10);
    while (state.scroll > 0) state = press(state, 'pagedown');
    expect(chatRows(state)).toEqual(expectedRows(state));
  });

  it('pages a pane taller than the lookahead by whole pages', () => {
    let state = restored(120, { rows: 300, cols: 100 });
    const page = bodyPanes(state).chat.rows - 1;
    expect(page).toBeGreaterThan(200);
    for (let i = 1; i <= 3; i += 1) {
      state = press(state, 'pageup');
      expect(state.scroll).toBe(page * i);
      expect(chatRows(state)).toEqual(expectedRows(state));
    }
  });

  it('wheels back one notch at a time from the tail', () => {
    let state = restored(40, { rows: 30, cols: 100 });
    for (let i = 0; i < 30; i += 1) {
      const next = press(state, 'scrollup');
      expect(next.scroll).toBeGreaterThan(state.scroll);
      state = next;
      expect(chatRows(state)).toEqual(expectedRows(state));
    }
  });

  it('bounds the scroll at the transcript\'s start, measured whole', () => {
    const state = restored(60, { rows: 30, cols: 100 });
    const all = conversationLines(state.conversation.blocks, bodyPanes(state).chat.cols, false);
    const top = { ...state, scroll: all.length };
    expect(chatScrollMax(top)).toBe(all.length - bodyPanes(state).chat.rows);
  });

  it('keeps a reader far back on the same lines while replies arrive', () => {
    const state = { ...restored(60, { rows: 30, cols: 100 }), scroll: 900 };
    const before = chatRows(state);
    const reply = (n: number): SessionMessage => ({ type: 'planner_message', content: `late reply ${n}\n\n${words(60, n)}`, timestamp: at(9000 + n) });
    const after = [reply(1), reply(2)].reduce((s, message) => reduce(s, { type: 'sessionMessage', sessionId: 's', message }).state, state);
    expect(after.scroll).toBeGreaterThan(900);
    expect(chatRows(after)).toEqual(before);
  });

  it('moves a reader far back by what full detail added, as it always has', () => {
    const state = { ...restored(60, { rows: 30, cols: 100 }), scroll: 700 };
    const cols = bodyPanes(state).chat.cols;
    const grown = conversationLines(state.conversation.blocks, cols, true).length - conversationLines(state.conversation.blocks, cols, false).length;
    expect(grown).toBeGreaterThan(0);
    const expanded = press(state, 'ctrl-o');
    expect(expanded.detailAll).toBe(true);
    expect(expanded.scroll).toBe(700 + grown);
    expect(chatRows(expanded)).toEqual(expectedRows(expanded));
  });
});
