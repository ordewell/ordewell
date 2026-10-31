import { describe, expect, it } from 'vitest';
import { checkHandoff, handoffReferenceText, storedHandoff, type StoredHandoff } from '../../models/Handoff';
import { createTask, type Task } from '../../models/Task';
import type { TaskLogEvent } from '../../models/TaskLog';
import { handoffLogs, readTask } from '../readTask';

/** Two attempts of a review, whose F numbers mean different things: what a retry or a loop round leaves. */
const handoffs: Record<number, StoredHandoff> = {
  1: { ...storedHandoff({ summary: 'First look.', findings: [{ severity: 'major', title: 'One' }, { severity: 'minor', title: 'Two' }, { severity: 'blocker', title: 'The race in the lease' }] })!, attempt: 1 },
  2: { ...storedHandoff({ summary: 'Second look.', findings: [{ severity: 'info', title: 'Something else entirely' }] })!, attempt: 2 },
};

const log = {
  attempts: (taskId: string) => (taskId === 'review' ? [1, 2] : []),
  events: (taskId: string, attempt: number): TaskLogEvent[] => (taskId === 'review' ? [{ type: 'handoff', handoff: handoffs[attempt] }] : []),
};

const plan = (attempt: 1 | 2): Task[] => [
  createTask({ id: 'review', order: 4, title: 'Review', handoff: handoffs[attempt] }),
  createTask({ id: 'fix', order: 5, title: 'Fix', dependencies: ['review'] }),
];

describe('a reference across a retry (ADR-0057 R1)', () => {
  it('still reads what it named once a later attempt numbers its findings anew', () => {
    const cited = checkHandoff({ summary: 'Fixed F3.', artifacts: [{ kind: 'task', task: '#4/F3' }] }, 'fix', plan(1), { logs: handoffLogs(log) });
    if (!cited.ok) throw new Error(cited.refusal);
    const [reference] = cited.handoff.artifacts!;

    // The review runs again: F3 no longer exists in what the plan holds.
    const retried = plan(2);
    const text = handoffReferenceText(reference, (id) => (id === 'review' ? '#4' : undefined));
    expect(text).toBe('#4@1/F3');

    const read = readTask({ task: text }, 'fix', retried, log);
    expect(read.isError).toBeUndefined();
    expect(read.text).toContain('attempt 1 of 2');
    expect(read.text).toContain('F3 [blocker] The race in the lease');
    expect(read.text).not.toContain('Something else entirely');
  });

  it('reads the latest through a reference that pins nothing, as one saved before pinning does', () => {
    expect(readTask({ task: '#4/F1' }, 'fix', plan(2), log).text).toContain('attempt 2 of 2');
  });

  it('refuses an attempt the log does not hold, naming those it does', () => {
    const read = readTask({ task: '#4@7/F1' }, 'fix', plan(2), log);
    expect(read).toMatchObject({ isError: true, text: expect.stringContaining('no saved attempt 7') });
  });
});
