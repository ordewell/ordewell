import { describe, it, expect } from 'vitest';
import { initialState } from '../reducer';
import { queuedPromptRows, taskQueuedRows } from '../layout';
import { width } from '../ansi';
import type { TaskLogState } from '../state';

// eslint-disable-next-line no-control-regex
const plain = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, '');

const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');

/** What the rows say of the prompt: the two-column marker lead and the trailing hint taken off. */
const said = (rows: string[]): string => rows.map((row) => plain(row).slice(2).replace(/ · .*$/, '').trim()).join(' ');

describe('queued prompt rows on a narrow pane', () => {
  for (const cols of [58, 30, 14]) {
    it(`keeps every word of a long prompt at ${cols} columns`, () => {
      const rows = queuedPromptRows(initialState({ queuedPrompts: [words] }), cols);

      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((row) => width(row) <= cols)).toBe(true);
      expect(said(rows)).toBe(words);
    });
  }

  it('names the hint on a wide pane', () => {
    const [row] = queuedPromptRows(initialState({ queuedPrompts: ['a parked thought'] }), 120);
    expect(plain(row)).toContain('a parked thought · queued · esc takes back · ctrl-s sends all now');
  });
});

describe('queued task message rows on a narrow pane', () => {
  const view = (text: string): TaskLogState => ({
    taskId: 't1',
    view: { blocks: [], nextId: 1, queued: [{ id: 'm1', text, forced: false }], working: true, streams: {} },
    attempts: [1],
    attempt: 1,
    pending: [],
    loaded: true,
    followLatest: true,
    queuedIndex: 0,
  });

  for (const cols of [58, 30]) {
    it(`keeps every word of a long message at ${cols} columns`, () => {
      const rows = taskQueuedRows(initialState({ taskView: view(words) }), cols);

      expect(rows.every((row) => width(row) <= cols)).toBe(true);
      expect(said(rows)).toBe(words);
    });
  }

  it('drops keys from the end, never the state of a message', () => {
    const [wide] = taskQueuedRows(initialState({ taskView: view('a short note') }), 120);
    const [narrow] = taskQueuedRows(initialState({ taskView: view('a short note') }), 50);

    expect(plain(wide)).toBe('❯ a short note · queued · esc takes back · ctrl-s sends all now · ctrl-r removes');
    expect(plain(narrow)).toBe('❯ a short note · queued · esc takes back');
  });

  it('names no key on a handed-over message, which only the current step can take', () => {
    const tv = view('a short note');
    const handed: TaskLogState = { ...tv, view: { ...tv.view, queued: [{ id: 'm1', text: 'a short note', forced: false, handedOver: true }] } };

    expect(plain(taskQueuedRows(initialState({ taskView: handed }), 120)[0])).toBe('❯ a short note · waiting for the current step');
  });
});
