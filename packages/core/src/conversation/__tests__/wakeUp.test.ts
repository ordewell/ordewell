import { describe, it, expect } from 'vitest';
import { wakeUpItems } from '../wakeUp';
import { wakeUpDigest } from '../../services/Supervisor';
import type { RunEvent } from '../../services/WakePolicy';

const describeTask = (id: string) => (id === 't1' ? '#1 "Scout the cache"' : '#2 "Fix it"');
const report = (taskId: string, text: string): RunEvent => ({ kind: 'task_report', taskId, at: 0, report: { authority: 'user', text, passed: true } });

describe('a run update as items', () => {
  it('reads a report back whole from the digest that carried it', () => {
    const digest = wakeUpDigest({
      attention: [report('t1', 'It passed.\nThe cache is keyed by path.\n\nSee src/cache.ts.')],
      sinceLast: [],
    }, describeTask);

    expect(wakeUpItems(digest)).toEqual([
      { kind: 'report', task: '#1 "Scout the cache"', lines: ['It passed.', 'The cache is keyed by path.', '', 'See src/cache.ts.'] },
    ]);
  });

  it('keeps the update\'s other lines as lines, in order, around a report', () => {
    const digest = wakeUpDigest({
      attention: [
        { kind: 'task_failed', taskId: 't2', at: 0, detail: 'tests red' },
        report('t1', 'It failed: no network.'),
        { kind: 'run_finished', at: 0, detail: '1 of 2 tasks completed' },
      ],
      sinceLast: [{ kind: 'task_passed', taskId: 't1', at: 0 }],
    }, describeTask);

    const items = wakeUpItems(digest);
    expect(items.map((i) => i.kind)).toEqual(['line', 'report', 'line', 'line', 'line']);
    expect(items[0]).toEqual({ kind: 'line', text: '- task #2 "Fix it" failed: tests red' });
    expect(items[1]).toEqual({ kind: 'report', task: '#1 "Scout the cache"', lines: ['It failed: no network.'] });
  });

  it('does not take a task\'s own words for a report', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'task_failed', taskId: 't2', at: 0, detail: ', whose result you asked for, has ended. It passed.' }], sinceLast: [] }, describeTask);
    expect(wakeUpItems(digest).every((i) => i.kind === 'line')).toBe(true);
  });

  it('reads any other text as one line', () => {
    expect(wakeUpItems('Something else')).toEqual([{ kind: 'line', text: 'Something else' }]);
  });
});
