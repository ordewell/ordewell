import { describe, expect, it } from 'vitest';
import { storedHandoff } from '../../models/Handoff';
import { createTask, type Task } from '../../models/Task';
import type { TaskLogEvent } from '../../models/TaskLog';
import { readTask } from '../readTask';

/**
 * ADR-0057 R1: a reference is pinned to an attempt, and "a reference stays
 * valid for the life of the root plan ... a task removed from the plan keeps
 * its log". A failed or skipped task may be removed, and a task that cited it
 * keeps the pinned reference in its stored handoff.
 */

const handoff = { ...storedHandoff({ summary: 'Found it.', findings: [{ severity: 'major' as const, title: 'The race' }] })!, attempt: 2 };

const log = {
  attempts: (taskId: string) => (taskId === 'gone' ? [1, 2] : []),
  events: (taskId: string, attempt: number): TaskLogEvent[] => (taskId === 'gone' && attempt === 2 ? [{ type: 'handoff', handoff }] : []),
};

// `gone` was removed from the plan; C is a later task whose dependency (B) cited it.
const citing = { ...storedHandoff({ summary: 'See the race.' })!, artifacts: [{ kind: 'task' as const, task: 'gone', attempt: 2, finding: 'F1' }] };
const plan: Task[] = [
  createTask({ id: 'b', order: 1, title: 'B', handoff: citing }),
  createTask({ id: 'c', order: 2, title: 'C', dependencies: ['b'] }),
  createTask({ id: 'd', order: 3, title: 'D' }),
];

describe('a pinned reference to a task removed from the plan (ADR-0057 R1)', () => {
  it('still reads the attempt it names', () => {
    const read = readTask({ task: 'gone@2/F1' }, 'c', plan, log);

    expect(read.isError).toBeUndefined();
    expect(read.text).toContain('F1 [major] The race');
    expect(read.text).toContain('gone, removed from the plan, attempt 2 of 2');
  });

  it('reads the same attempt given apart from the reference', () => {
    expect(readTask({ task: 'gone', attempt: 2 }, 'c', plan, log).text).toContain('F1 [major] The race');
  });

  it('finds the citation in a log when the plan keeps no digest of it', () => {
    const uncited = [createTask({ id: 'b', order: 1, title: 'B' }), createTask({ id: 'c', order: 2, title: 'C', dependencies: ['b'] })];
    const logged = {
      attempts: (taskId: string) => (taskId === 'b' ? [1] : log.attempts(taskId)),
      events: (taskId: string, attempt: number): TaskLogEvent[] => (taskId === 'b' ? [{ type: 'handoff', handoff: { ...citing, report: undefined } }] : log.events(taskId, attempt)),
    };

    expect(readTask({ task: 'gone@2/F1' }, 'c', uncited, logged).isError).toBeUndefined();
  });

  it('refuses a reader nothing it may read cites, as it refuses any unknown reference', () => {
    expect(readTask({ task: 'gone@2/F1' }, 'd', plan, log)).toEqual({ isError: true, text: '"gone@2/F1" names no task in the plan: give its "#order", its id or its title.' });
  });

  it('refuses an attempt the citation does not name', () => {
    expect(readTask({ task: 'gone@1' }, 'c', plan, log).isError).toBe(true);
  });

  it('refuses a reference with no attempt pinned', () => {
    expect(readTask({ task: 'gone' }, 'c', plan, log).isError).toBe(true);
  });
});
