import { describe, expect, it } from 'vitest';
import { checkHandoff, handoffReferenceText, storedHandoff, type StoredHandoff } from '../../models/Handoff';
import { createTask, type Task } from '../../models/Task';
import type { TaskLogEvent } from '../../models/TaskLog';
import { handoffAttempt, handoffLogs, readTask } from '../readTask';

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

describe("a delegated task's repair (ADR-0055 D14, ADR-0057 R2)", () => {
  const report: StoredHandoff = { ...storedHandoff({ summary: 'What the child plan did.' })!, attempt: 1 };
  const repair: StoredHandoff = { ...storedHandoff({ summary: 'Merged it.\n- Changed outside its scope (from Ordewell): tests/' })!, held: true, attempt: 2 };
  const logged = {
    attempts: () => [1, 2],
    events: (_id: string, attempt: number): TaskLogEvent[] => [{ type: 'handoff', handoff: attempt === 1 ? report : repair }],
  };
  const repaired = [createTask({ id: 'd', order: 1, title: 'Delegated', type: 'delegated', goal: 'g', budget: { tokens: 1000 }, handoff: report })];

  it('leaves its report what a read finds, and its own words in its own attempt, held', () => {
    expect(readTask({ task: '#1' }, undefined, repaired, logged).text).toContain('What the child plan did.');
    const own = readTask({ task: '#1@2' }, undefined, repaired, logged).text;
    expect(own).toContain('attempt 2 of 2');
    expect(own.split('\n').filter((line) => line.startsWith('- Changed outside its scope'))).toEqual([]);
  });

  it('stands in for its own log where a forked session has none', () => {
    expect(handoffAttempt(repaired[0], [])).toBeUndefined();
    expect(handoffAttempt(repaired[0], [2])).toBe(2);
    expect(handoffAttempt(repaired[0], [1, 2])).toBe(1);
    expect(readTask({ task: '#1' }, undefined, repaired, { attempts: () => [], events: () => [] }).text).toContain('What the child plan did.');
  });
});

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

  describe('with the digest gone, as a retry leaves it', () => {
    const cleared = (): Task[] => [{ ...plan(2)[0], handoff: undefined, status: 'pending' }, plan(2)[1]];

    it('pins to the newest attempt that left a handoff', () => {
      const cited = checkHandoff({ summary: 'Reads the last review.', artifacts: [{ kind: 'task', task: '#4/F1' }] }, 'fix', cleared(), { logs: handoffLogs(log) });
      if (!cited.ok) throw new Error(cited.refusal);
      expect(cited.handoff.artifacts).toEqual([expect.objectContaining({ task: 'review', attempt: 2, finding: 'F1' })]);
    });

    it('passes over an attempt still running, which has left none', () => {
      const running = { attempts: (id: string) => (id === 'review' ? [1, 2, 3] : []), events: (id: string, attempt: number) => (attempt === 3 ? [] : log.events(id, attempt)) };
      const cited = checkHandoff({ summary: 'Reads the last review.', artifacts: [{ kind: 'task', task: '#4/F1' }] }, 'fix', cleared(), { logs: handoffLogs(running) });
      if (!cited.ok) throw new Error(cited.refusal);
      expect(cited.handoff.artifacts).toEqual([expect.objectContaining({ attempt: 2 })]);
    });

    it('holds a finding to the handoff it pins to, which has only so many', () => {
      const cited = checkHandoff({ summary: 'Reads the last review.', artifacts: [{ kind: 'task', task: '#4/F3' }] }, 'fix', cleared(), { logs: handoffLogs(log) });
      expect(cited).toMatchObject({ ok: false, refusal: expect.stringContaining('its latest handoff has F1 to F1') });
    });

    it('stays unpinned for a task no attempt of which has handed anything over', () => {
      const cited = checkHandoff({ summary: 'Points at it.', artifacts: [{ kind: 'task', task: '#5' }] }, 'third', [...plan(2), createTask({ id: 'third', order: 6, title: 'Third', dependencies: ['fix'] })], { logs: handoffLogs(log) });
      if (!cited.ok) throw new Error(cited.refusal);
      expect(cited.handoff.artifacts?.[0]).not.toHaveProperty('attempt');
    });
  });

  it('refuses an attempt the log does not hold, naming those it does', () => {
    const read = readTask({ task: '#4@7/F1' }, 'fix', plan(2), log);
    expect(read).toMatchObject({ isError: true, text: expect.stringContaining('no saved attempt 7') });
  });
});

describe('a skipped or failed task, its last handoff kept (ADR-0047)', () => {
  // A loop's review: attempt 1 failed with findings, attempt 2 was cut off by a stop, and the planner then skipped it.
  const failed: StoredHandoff = { ...storedHandoff({ status: 'failed', summary: 'Two races remain.', findings: [{ severity: 'major', title: 'The lease race' }] })!, attempt: 1 };
  const cutOff = {
    attempts: (id: string) => (id === 'review' ? [1, 2] : []),
    events: (id: string, attempt: number): TaskLogEvent[] => (id === 'review' && attempt === 1 ? [{ type: 'handoff', handoff: failed }] : []),
  };
  const skipped: Task[] = [
    createTask({ id: 'review', order: 1, title: 'Review', status: 'skipped', loop: { body: ['fix', 'docs'], maxRounds: 2 } }),
    createTask({ id: 'fix', order: 2, title: 'Fix', dependencies: ['review'] }),
    createTask({ id: 'docs', order: 3, title: 'Docs' }),
  ];

  it('reads the newest attempt that left a handoff, labelled with how it ended, and says the later one left none', () => {
    const read = readTask({ task: '#1' }, 'fix', skipped, cutOff);
    expect(read.isError).toBeUndefined();
    expect(read.text).toContain('attempt 1 of 2');
    expect(read.text).toContain('Its attempt 2 left no handoff');
    expect(read.text).toContain('This attempt ended failed: none of its work landed.');
    expect(read.text).toContain('F1 [major] The lease race');
  });

  it('is read by a fellow body task of its loop', () => {
    expect(readTask({ task: '#1' }, 'docs', skipped, cutOff).text).toContain('Two races remain.');
  });
});
