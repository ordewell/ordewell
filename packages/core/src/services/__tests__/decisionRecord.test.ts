import { describe, expect, it } from 'vitest';
import type { DecisionRecordEntry } from '../../models/Task';
import { addToRecord, recordBefore, recordBlock, recordChanges, RECORD_LIMIT, type RecordContext } from '../decisionRecord';

const context = (over: Partial<RecordContext> = {}): RecordContext => ({
  at: 3,
  timestamp: '2026-11-10T10:00:00.000Z',
  userWords: ['Ship it by Friday.\nNever touch   the billing schema.'],
  redact: (text) => text,
  ...over,
});

function added(record: readonly DecisionRecordEntry[], inputs: Parameters<typeof addToRecord>[1], over: Partial<RecordContext> = {}): DecisionRecordEntry[] {
  const result = addToRecord(record, inputs, context(over));
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.record;
}

describe('the decision record', () => {
  it('numbers each kind on its own and keeps where in the transcript each entry was made', () => {
    const record = added([], [
      { kind: 'decision', text: 'Use Postgres', why: 'the team runs it already' },
      { kind: 'constraint', text: 'Never touch the billing schema.' },
      { kind: 'decision', text: 'Keep the REST API', why: 'clients depend on it' },
      { kind: 'question', text: 'Which region hosts the replica?' },
      { kind: 'rejected', text: 'MongoDB', why: 'no transactions across collections' },
    ]);
    expect(record.map(({ id, kind, at }) => [id, kind, at])).toEqual([
      ['D1', 'decision', 3], ['C1', 'constraint', 3], ['D2', 'decision', 3], ['Q1', 'question', 3], ['R1', 'rejected', 3],
    ]);
  });

  it('refuses the whole batch when any entry is wrong, naming each', () => {
    const result = addToRecord([], [
      { kind: 'decision', text: 'Use Postgres' },
      { kind: 'rejected', text: 'MongoDB' },
      { kind: 'question', text: '  ' },
      { kind: 'decision', text: 'Keep REST', why: 'clients', supersedes: 'D9' },
    ], context());
    expect(result).toEqual({
      ok: false,
      errors: [
        'Entry 1: a decision needs its why.',
        'Entry 2: a rejection needs its why.',
        'Entry 3: the text is empty.',
        'Entry 4: there is no live entry D9 to supersede.',
      ],
    });
  });

  it('takes a constraint only as the user wrote it, spacing and quotes aside', () => {
    expect(added([], [{ kind: 'constraint', text: '"Never touch the billing schema."' }])[0].text).toBe('Never touch the billing schema.');
    const result = addToRecord([], [{ kind: 'constraint', text: 'Do not change billing.' }], context());
    expect(result).toEqual({ ok: false, errors: ['Entry 1: a constraint is the user\'s words, verbatim: "Do not change billing." is not in any of their messages. Quote them, or record a decision.'] });
  });

  it('supersedes a live entry once, and the whole block shows only what stands', () => {
    const first = added([], [
      { kind: 'question', text: 'Which region hosts the replica?' },
      { kind: 'decision', text: 'Use Postgres', why: 'the team runs it already' },
    ]);
    const second = added(first, [{ kind: 'decision', text: 'Host the replica in eu-west-1', why: 'the users are in Europe', supersedes: 'Q1' }], { at: 7 });
    expect(second.at(-1)).toMatchObject({ id: 'D2', supersedes: 'Q1', at: 7 });
    expect(addToRecord(second, [{ kind: 'question', text: 'Again?', supersedes: 'Q1' }], context())).toEqual({ ok: false, errors: ['Entry 1: there is no live entry Q1 to supersede.'] });
    expect(recordBlock(second)).toBe([
      '<decision_record>',
      'Decisions:',
      '- D1: Use Postgres. Why: the team runs it already',
      '- D2: Host the replica in eu-west-1. Why: the users are in Europe',
      '</decision_record>',
    ].join('\n'));
  });

  it('renders each section, the constraints in the user\'s words, and nothing for an empty record', () => {
    expect(recordBlock([])).toBeNull();
    const record = added([], [
      { kind: 'constraint', text: 'Ship it by Friday.' },
      { kind: 'rejected', text: 'MongoDB', why: 'no transactions' },
      { kind: 'question', text: 'Which region?' },
      { kind: 'decision', text: 'Use Postgres', why: 'known' },
    ]);
    expect(recordBlock(record)).toBe([
      '<decision_record>',
      'Decisions:',
      '- D1: Use Postgres. Why: known',
      'Constraints, in the user\'s words:',
      '- C1: "Ship it by Friday."',
      'Rejected:',
      '- R1: MongoDB. Why: no transactions',
      'Open questions:',
      '- Q1: Which region?',
      '</decision_record>',
    ].join('\n'));
  });

  it('says what was added since a count the planner holds', () => {
    const record = added(added([], [{ kind: 'question', text: 'Which region?' }]), [
      { kind: 'decision', text: 'eu-west-1', why: 'users in Europe', supersedes: 'Q1' },
      { kind: 'rejected', text: 'us-east-1', why: 'latency' },
    ]);
    expect(recordChanges(record, 3)).toBeNull();
    expect(recordChanges(record, 1)).toBe([
      '<decision_record_changes>',
      '- decision D1: eu-west-1. Why: users in Europe (supersedes Q1)',
      '- rejected R1: us-east-1. Why: latency',
      '</decision_record_changes>',
    ].join('\n'));
  });

  it('redacts what it keeps, after checking the constraint against the raw words', () => {
    const redact = (text: string) => text.replaceAll('sk-live-123', '[secret]');
    const record = added([], [
      { kind: 'constraint', text: 'Use key sk-live-123 only in prod.' },
      { kind: 'decision', text: 'Read sk-live-123 from the env', why: 'never inline sk-live-123' },
    ], { userWords: ['Use key sk-live-123 only in prod.'], redact });
    expect(record.map(({ text, why }) => [text, why])).toEqual([
      ['Use key [secret] only in prod.', undefined],
      ['Read [secret] from the env', 'never inline [secret]'],
    ]);
  });

  it('holds a bounded number of entries', () => {
    const full = Array.from({ length: RECORD_LIMIT }, (_, i): DecisionRecordEntry => ({ id: `Q${i + 1}`, kind: 'question', text: `q${i}`, at: 0, timestamp: 't' }));
    expect(addToRecord(full, [{ kind: 'question', text: 'one more' }], context())).toEqual({
      ok: false,
      errors: [`The record holds its limit of ${RECORD_LIMIT} entries: supersede what no longer stands rather than add to it.`],
    });
  });

  it('keeps, before a rewind point, only what was recorded before it', () => {
    const record = [
      ...added([], [{ kind: 'question', text: 'Which region?' }], { at: 0 }),
    ];
    const later = added(record, [{ kind: 'decision', text: 'eu-west-1', why: 'users', supersedes: 'Q1' }], { at: 4 });
    expect(recordBefore(later, 4).map(({ id }) => id)).toEqual(['Q1']);
    expect(recordBefore(later, 5).map(({ id }) => id)).toEqual(['Q1', 'D1']);
  });
});
