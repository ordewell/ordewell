import { describe, expect, it } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { MAX_PARKS, lostWaits, owedPark, parkDecision, parkResume } from '../Parking';

// Spread over `createTask`, which drops the fields only a run sets.
const task = (id: string, order: number, extra: Partial<Task> = {}): Task => ({ ...createTask({ id, order, title: `Task ${id}`, taskMode: 'build', ...extra }), ...extra });

/** An opening task, three slices after it, and a closing check after them. */
const plan = (extra: Record<string, Partial<Task>> = {}): Task[] => [
  task('open', 1, { status: 'completed', ...extra.open }),
  task('a', 2, { dependencies: ['open'], status: 'in_progress', ...extra.a }),
  task('b', 3, { dependencies: ['open'], status: 'in_progress', ...extra.b }),
  task('c', 4, { dependencies: ['open'], ...extra.c }),
  task('close', 5, { dependencies: ['a', 'b', 'c'], ...extra.close }),
];

const ok = { parkedBefore: 0 };
const refusal = (decision: ReturnType<typeof parkDecision>) => (decision.ok ? '' : decision.refusal);

describe('parkDecision', () => {
  it('waits for the siblings named, by reference, id or title, adding those its dependencies lack', () => {
    expect(parkDecision(plan(), 'a', ['#3', 'Task c'], ok)).toEqual({ ok: true, waitsOn: ['b', 'c'], added: ['b', 'c'] });
    expect(parkDecision(plan({ a: { dependencies: ['open', 'b'] } }), 'a', ['b'], ok)).toEqual({ ok: true, waitsOn: ['b'], added: [] });
  });

  it('refuses work that has landed, telling it to take that in', () => {
    expect(refusal(parkDecision(plan(), 'a', ['open'], ok))).toContain('#1 "Task open" has landed: take its work in now');
  });

  it('refuses work that may never land: failed, skipped, or landing nothing', () => {
    const tasks = plan({ b: { status: 'failed' }, c: { status: 'skipped' } });
    expect(refusal(parkDecision(tasks, 'a', ['b', 'c'], ok))).toMatch(/#3 "Task b" failed, so its work may never land[\s\S]*#4 "Task c" was skipped/);
    expect(refusal(parkDecision([...plan(), task('r', 6, { readOnly: true })], 'a', ['r'], ok))).toContain('lands no work');
  });

  it('refuses a task that waits for this one, which could never land first', () => {
    expect(refusal(parkDecision(plan(), 'a', ['close'], ok))).toContain('#5 "Task close" waits for this task');
    // b already waits for a: a cannot wait for b.
    expect(parkDecision(plan({ b: { dependencies: ['open', 'a'] } }), 'a', ['b'], ok).ok).toBe(false);
  });

  it('refuses a task that waits for this one through a container, which lands only once its subtasks do', () => {
    // p holds a, and b waits for p: a cannot wait for b.
    const held = [task('p', 1, { subtasks: [task('a', 1, { status: 'in_progress' })] }), task('b', 2, { dependencies: ['p'] })];
    expect(refusal(parkDecision(held, 'a', ['b'], ok))).toContain('#2 "Task b" waits for this task');
    // q's subtask q1 waits for a: a cannot wait for q.
    const holding = [task('a', 1, { status: 'in_progress' }), task('q', 2, { subtasks: [task('q1', 1, { dependencies: ['a'] })] })];
    expect(refusal(parkDecision(holding, 'a', ['q'], ok))).toContain('#2 "Task q" waits for this task');
  });

  it('refuses a task whose own granted park, not yet in the plan, waits for this one', () => {
    expect(refusal(parkDecision(plan(), 'a', ['b'], { parkedBefore: 0, granted: new Map([['b', ['a']]]) }))).toContain('#3 "Task b" waits for this task');
    expect(parkDecision(plan(), 'a', ['b'], { parkedBefore: 0, granted: new Map([['c', ['a']]]) }).ok).toBe(true);
  });

  it('refuses itself, a task it holds and a task that holds it', () => {
    const tree = [task('p', 1, { subtasks: [task('s', 1)] }), task('q', 2)];
    expect(refusal(parkDecision(tree, 'p', ['p'], ok))).toContain('is this task');
    expect(refusal(parkDecision(tree, 's', ['p'], ok))).toContain('#1 "Task p" holds this task');
    expect(refusal(parkDecision(tree, 'p', ['#1.1'], ok))).toContain('#1.1 "Task s" is part of this task');
  });

  it(`refuses a task that has waited ${MAX_PARKS} times`, () => {
    expect(refusal(parkDecision(plan(), 'a', ['b'], { parkedBefore: MAX_PARKS }))).toContain(`waited ${MAX_PARKS} times since it last started afresh`);
  });

  it('refuses the whole call when one task is refused, so nothing changes', () => {
    expect(parkDecision(plan(), 'a', ['b', 'nope'], ok)).toEqual({ ok: false, refusal: 'Not waiting; nothing changed.\n"nope" names no task in the plan.' });
  });
});

describe('a park, once it is saved', () => {
  const parked = (status: Task['status'], over: Partial<Task> = {}) => plan({
    a: { status, dependencies: ['open', 'b'], parked: { attempt: 1, waitsOn: ['b'], added: ['b'], count: 1 }, attemptUsage: [{ attempt: 1, runner: 'claude-code', startedAt: '2026-11-21T10:00:00.000Z', wallTimeMs: 0, totals: {}, byModel: [] }], runnerSessionId: 'native-a', runnerSessionOwner: 'claude-code', ...over },
  });

  it('is owed to the next start until another attempt has run', () => {
    expect(owedPark(parked('pending')[1])).toMatchObject({ attempt: 1 });
    const later = parked('in_progress', { attemptUsage: [...parked('pending')[1].attemptUsage!, { attempt: 2, runner: 'claude-code', startedAt: '2026-11-21T10:05:00.000Z', wallTimeMs: 0, totals: {}, byModel: [] }] });
    expect(owedPark(later[1])).toBeNull();
  });

  it('continues the saved session, told what landed', () => {
    const tasks = parked('pending', {});
    tasks[2] = { ...tasks[2], status: 'completed' };
    expect(parkResume(tasks[1], tasks)).toEqual({
      message: '(Ordewell) The work you waited for has landed: #3 "Task b". It is in your working tree now, beside your own work. Go on with your brief from where you stopped.',
      resumeSessionId: 'native-a',
    });
  });

  it('starts afresh where the session is another runner\'s, or none was saved', () => {
    const moved = parked('pending', { assignedRunner: 'codex' });
    expect(parkResume(moved[1], moved)?.resumeSessionId).toBeUndefined();
    const none = parked('pending', { runnerSessionId: undefined });
    expect(parkResume(none[1], none)?.resumeSessionId).toBeUndefined();
  });

  it('is over for work that failed, was skipped or is blocked, but not for a loop\'s check between rounds', () => {
    expect(lostWaits(parked('pending'))).toEqual(new Map());
    expect(lostWaits(parked('pending', {}).map((t) => (t.id === 'b' ? { ...t, status: 'failed' as const } : t)))).toEqual(new Map([['a', ['b']]]));
    expect(lostWaits(parked('pending', {}).map((t) => (t.id === 'b' ? { ...t, status: 'skipped' as const } : t)))).toEqual(new Map([['a', ['b']]]));
    const blocked = parked('pending', {}).map((t) => (t.id === 'b' ? { ...t, status: 'pending' as const, dependencies: ['x'] } : t));
    expect(lostWaits([...blocked, task('x', 9, { status: 'failed' })])).toEqual(new Map([['a', ['b']]]));
  });

  it('tells a start after a lost wait what will not land, and to finish its part', () => {
    const tasks = parked('pending', { dependencies: ['open'] }).map((t) => (t.id === 'b' ? { ...t, status: 'failed' as const } : t));
    expect(parkResume(tasks[1], tasks)?.message).toBe('(Ordewell) The work you waited for will not land now: #3 "Task b" failed. Finish your own part and end as your brief says, naming each check that needs that work, and the task whose work it needs, in a finding. Go on with your brief from where you stopped.');
  });
});
