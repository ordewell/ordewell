import { describe, it, expect } from 'vitest';
import { createTask, keepExecutionState, type Task } from '../Task';
import { ATTEMPT_FIELDS, EXECUTION_FIELDS, TASK_FIELDS, executionStateOf, freshAttempt } from '../TaskExecution';

/** A task that has run and holds every attempt and execution field. */
function ranTask(): Task {
  return {
    ...createTask({ id: 'a', title: 'A', prompt: 'do a', assignedRunner: 'claude-code' }),
    status: 'awaiting_user',
    verdict: { outcome: 'fail', reason: 'broke', checks: [], decidedAt: 'now' },
    outputSummary: { reviewReason: 'broke', logTail: 'oops', capturedAt: 'now' },
    handoff: { summary: 'It broke.', findings: [], findingCount: 0 },
    runnerSessionId: 'session-1',
    runnerSessionOwner: 'claude-code',
    awaitingReason: 'usage-limit',
    parkedQuestion: 'Which database?',
    waitsEnded: 3,
    resumeAt: '2026-11-07T20:00:00.000Z',
    carriedFrom: 'codex',
    skipReason: 'not needed',
    reverted: true,
    researchOrigin: { actor: 'planner-turn', research: true },
    forcedPastGate: ['Earlier work'],
    attemptSkills: [],
    addedBy: 'supervisor',
    attempted: true,
    attemptUsage: [],
    loopRound: 2,
    reportTo: { actor: 'planner-turn', research: true },
  };
}

describe('freshAttempt', () => {
  const cases: Array<[string, Parameters<typeof freshAttempt>[0], { loopRound?: number; reverted?: true }]> = [
    ['a retry starts a loop\'s rounds over and releases a revert', {}, {}],
    ['a resume after a usage limit stays in its round (ADR-0045 L7)', { sameRound: true }, { loopRound: 2 }],
    ['a rearm keeps the revert mark the user\'s hold rests on (ADR-0054)', { rearm: true }, { reverted: true }],
  ];

  it.each(cases)('%s', (_name, opts, kept) => {
    const before = ranTask();
    const after: Task = { ...before, ...freshAttempt(opts) };

    expect(after.status).toBe('pending');
    for (const field of ATTEMPT_FIELDS) {
      if (field === 'status') continue;
      expect(after[field], field).toEqual(kept[field as keyof typeof kept]);
    }
    for (const field of EXECUTION_FIELDS.filter((f) => TASK_FIELDS[f] === 'execution')) {
      expect(after[field], field).toEqual(before[field]);
    }
  });

  it('touches nothing of the plan', () => {
    const changes = freshAttempt();
    for (const field of Object.keys(changes)) expect(TASK_FIELDS[field as keyof Task], field).toBe('attempt');
  });
});

describe('the field table', () => {
  it('names every field of a task as created, and execution state as the attempt and execution fields', () => {
    for (const field of Object.keys(createTask({}))) expect(TASK_FIELDS, field).toHaveProperty(field);
    expect(new Set(EXECUTION_FIELDS)).toEqual(new Set(Object.entries(TASK_FIELDS).filter(([, kind]) => kind !== 'plan').map(([f]) => f)));
    expect(ATTEMPT_FIELDS.every((f) => EXECUTION_FIELDS.includes(f))).toBe(true);
  });

  it('reads a task\'s execution state, every field named', () => {
    const state = executionStateOf(ranTask());
    expect(Object.keys(state).sort()).toEqual([...EXECUTION_FIELDS].sort());
    expect(state).toMatchObject({ status: 'awaiting_user', forcedPastGate: ['Earlier work'], attempted: true });
    expect(Object.values(executionStateOf(undefined)).every((v) => v === undefined)).toBe(true);
  });

  it('is what a planner\'s rewrite keeps: every execution field from the task as it stood, none from the rewrite', () => {
    const prior = { ...ranTask(), status: 'failed' as const };
    const rewrite = { ...createTask({ id: 'a', title: 'Edited', prompt: 'do a better', assignedRunner: 'claude-code' }), parkedQuestion: 'invented', verdict: undefined };

    const [kept] = keepExecutionState([prior], [rewrite]);

    expect(kept).toMatchObject({ title: 'Edited', prompt: 'do a better' });
    for (const field of EXECUTION_FIELDS) expect(kept[field], field).toEqual(prior[field]);
  });
});
