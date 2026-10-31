import { describe, expect, it } from 'vitest';
import { wakeUpDigest } from '../Supervisor';

/**
 * ADR-0057 R5: a ride-along event takes one line of at most 120 characters.
 * The line still has to say what happened: a planner that only sees the task
 * and its title cannot tell a failure from silence.
 */

const describeLong = () => `#1 "${'A'.repeat(160)}"`;

describe('a ride-along digest line says what happened', () => {
  it('still names the failure inside the 120-character line', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'task_failed', taskId: 't1', at: 1, detail: 'boom' }], sinceLast: [] }, describeLong);

    expect(digest).toContain('failed');
  });

  it('still says a task went quiet inside the 120-character line', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'task_idle', taskId: 't1', at: 1 }], sinceLast: [] }, describeLong);

    expect(digest).toContain('gone quiet');
  });

  it('still says a task passed inside the 120-character line', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'run_finished', at: 1 }], sinceLast: [{ kind: 'task_passed', taskId: 't1', at: 1 }] }, describeLong);

    expect(digest.split('\n').at(-1)).toMatch(/…" passed$/);
  });

  it('keeps every line within 120 and the title\'s closing quote, however long both are', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'task_failed', taskId: 't1', at: 1, detail: 'x'.repeat(500) }], sinceLast: [] }, describeLong);
    const line = digest.split('\n')[1];

    expect(line.length).toBeLessThanOrEqual(120);
    expect(line).toContain('…" failed: xxx');
  });

  it('does not cut a title a line has room for', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'task_idle', taskId: 't1', at: 1 }], sinceLast: [] }, () => '#1 "Short"');

    expect(digest).toContain('- task #1 "Short" has gone quiet');
  });
});
