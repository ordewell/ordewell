import { describe, expect, it } from 'vitest';
import { boundedWakeUps, WAKE_MAX_CHARS, type RunEvent } from '../WakePolicy';
import { wakeUpDigest } from '../Supervisor';

/**
 * ADR-0057 R5: a turn over its cap names each event it leaves out, "in a line
 * up to a count". A usage limit is one of the events that needs a person, so
 * the line must still say what happened, not only which tasks it was about.
 * This is the round 3 review's failing case: `leftOut` cuts the end of a
 * long rank-0 line, where the event kind and detail are.
 */
const describeLong = (id: string) => `#${id.slice(1)} "${'T'.repeat(70)} ${id}"`;

const report = (id: string, at: number) => wakeUpDigest({
  attention: [{ kind: 'task_report', taskId: id, at, report: { authority: 'supervisor', text: 'It passed.\n' + 'r'.repeat(6000), passed: true } }],
  sinceLast: [],
}, describeLong);

describe('a capped turn names what it leaves out (ADR-0057 R5)', () => {
  it('keeps the usage limit it leaves out, not only the tasks it paused', () => {
    const usage = wakeUpDigest({
      attention: [{ kind: 'usage_limit', at: 1, runner: 'claude-code', resumeAt: '2026-10-11T20:10:00Z', taskIds: ['t1', 't2', 't3', 't4', 't5'] }],
      sinceLast: [],
    }, describeLong);
    const newest = wakeUpDigest({
      attention: [],
      sinceLast: Array.from({ length: 10000 }, (_, i) => ({ kind: 'task_passed' as const, taskId: `p${i}-xxxxxxxxxxxxxxxxxxxx`, at: 2 })),
    }, (id) => id);

    const [note] = boundedWakeUps([usage, report('t8', 2), report('t9', 3), newest]);

    expect(note.length).toBeLessThan(WAKE_MAX_CHARS);
    expect(note).toContain('usage limit');
    expect(note).toContain('2026-10-11T20:10:00Z');
  });

  it.each([
    ['task_report', { kind: 'task_report', taskId: 't1', report: { authority: 'supervisor', text: 'r'.repeat(6000), passed: true } }, 'has ended'],
    ['landing_conflict', { kind: 'landing_conflict', taskId: 't1' }, 'could not land'],
    ['auto_merge_stopped', { kind: 'auto_merge_stopped', taskId: 't1' }, 'stopped'],
    ['waiting_approval', { kind: 'waiting_approval', taskId: 't1', detail: 'd'.repeat(300) }, 'waiting for approval'],
    ['task_idle', { kind: 'task_idle', taskId: 't1', detail: 'd'.repeat(300) }, 'gone quiet'],
    ['task_failed', { kind: 'task_failed', taskId: 't1', detail: 'd'.repeat(300) }, 'failed'],
  ] as const)('keeps what happened when it leaves out a %s, however long the title', (_kind, event, words) => {
    const line = wakeUpDigest({ attention: [{ ...event, at: 1 } as RunEvent], sinceLast: [] }, describeLong);
    const passes = Array.from({ length: 10000 }, (_, i) => ({ kind: 'task_passed' as const, taskId: `p${i}-xxxxxxxxxxxxxxxxxxxx`, at: 2 }));

    const [note] = boundedWakeUps([line, wakeUpDigest({ attention: [], sinceLast: passes }, (id) => id)]);

    expect(note.split('\n')[1]).toContain(words);
  });
});
