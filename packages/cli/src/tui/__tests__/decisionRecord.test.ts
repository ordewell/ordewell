import { describe, it, expect } from 'vitest';
import type { DecisionRecordEntry } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { recordLayout } from '../layout';
import type { TuiState } from '../state';

const entry = (over: Partial<DecisionRecordEntry> & Pick<DecisionRecordEntry, 'id' | 'kind' | 'text'>): DecisionRecordEntry => ({
  at: 0, timestamp: '2026-01-01T00:00:00.000Z', ...over,
});

const RECORD: DecisionRecordEntry[] = [
  entry({ id: 'D1', kind: 'decision', text: 'Use SQLite', why: 'one file, no server' }),
  entry({ id: 'C1', kind: 'constraint', text: 'no new dependencies' }),
  entry({ id: 'R1', kind: 'rejected', text: 'Postgres', why: 'needs a server' }),
  entry({ id: 'Q1', kind: 'question', text: 'Which migration tool?' }),
  entry({ id: 'D2', kind: 'decision', text: 'Use LMDB', why: 'faster reads', supersedes: 'D1' }),
];

// eslint-disable-next-line no-control-regex
const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');
const typed = (text: string, over: Partial<TuiState> = {}) => {
  const base = initialState(over);
  return reduce({ ...base, editor: { ...base.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } });
};

describe('/decisions', () => {
  it('opens the record sheet, with superseded entries hidden', () => {
    expect(typed('/decisions').state.overlay).toEqual({ kind: 'record', scroll: 0 });
  });

  it('/decisions all lists the superseded entries too', () => {
    expect(typed('/decisions all').state.overlay).toEqual({ kind: 'record', scroll: 0, all: true });
  });

  it('refuses an argument it does not know', () => {
    expect(typed('/decisions everything').state.overlay).toBeNull();
  });

  it('closes on any key that does not scroll', () => {
    const open = typed('/decisions').state;
    expect(reduce(open, { type: 'key', key: { name: 'escape' } }).state.overlay).toBeNull();
  });
});

describe('the record on the plan', () => {
  it('arrives with a plan broadcast and goes with the session', () => {
    const idle = initialState({ sessionId: 's1' });
    const heard = reduce(idle, { type: 'planBroadcast', plan: { tasks: [], decisionRecord: RECORD }, sessionId: 's1' }).state;
    expect(heard.decisionRecord).toEqual(RECORD);
    // A later plan without one (the field is left off an empty record) clears it.
    expect(reduce(heard, { type: 'planBroadcast', plan: { tasks: [] }, sessionId: 's1' }).state.decisionRecord).toEqual([]);
  });
});

describe('the record sheet', () => {
  const sheet = (all: boolean, record = RECORD) => recordLayout(record, all, 40, 80).lines.map(strip);

  it('shows each standing entry under its kind and hides what was superseded', () => {
    const text = sheet(false).join('\n');
    expect(text).toContain('Decisions');
    expect(text).toContain('D2 Use LMDB');
    expect(text).toContain('why: faster reads');
    expect(text).toContain('C1 "no new dependencies"');
    expect(text).toContain('Rejected');
    expect(text).toContain('R1 Postgres');
    expect(text).toContain('Open questions');
    expect(text).toContain('Q1 Which migration tool?');
    expect(text).not.toContain('Use SQLite');
    expect(text).toContain('1 superseded (/decisions all shows them)');
  });

  it('marks a superseded entry with what replaced it when asked for all', () => {
    const text = sheet(true).join('\n');
    expect(text).toContain('D1 Use SQLite (superseded by D2)');
    expect(text).toContain('D2 Use LMDB');
  });

  it('says when nothing is recorded', () => {
    expect(sheet(false, []).join('\n')).toContain('Nothing recorded yet');
  });

  it('keeps a terminal escape in an entry off the screen', () => {
    const lines = sheet(false, [entry({ id: 'D1', kind: 'decision', text: 'bad\u001b[2Jtext', why: 'because' })]);
    expect(lines.join('\n')).not.toContain('\u001b');
  });

  it('draws as an overlay and scrolls to its last row', () => {
    const many = Array.from({ length: 30 }, (_, i) => entry({ id: `D${i + 1}`, kind: 'decision', text: `Decision number ${i + 1}`, why: 'because' }));
    let state = initialState({ rows: 12, cols: 60, decisionRecord: many, overlay: { kind: 'record', scroll: 0 } });
    expect(render(state).map(strip).join('\n')).toContain('Decision record');
    for (let i = 0; i < 100; i++) state = reduce(state, { type: 'key', key: { name: 'down' } }).state;
    expect(state.overlay).toMatchObject({ kind: 'record' });
    expect(render(state).map(strip).join('\n')).toContain('Decision number 30');
  });
});
