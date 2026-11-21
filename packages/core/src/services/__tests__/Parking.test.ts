import { describe, expect, it } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { MAX_PARKS, parkDecision, parkResumeMessage } from '../Parking';

const task = (id: string, order: number, extra: Partial<Task> = {}): Task => createTask({ id, order, title: `Task ${id}`, taskMode: 'build', ...extra });

/** An opening task, three slices after it, and a closing check after them. */
const plan = (extra: Record<string, Partial<Task>> = {}): Task[] => [
  task('open', 1, { status: 'completed', ...extra.open }),
  task('a', 2, { dependencies: ['open'], status: 'in_progress', ...extra.a }),
  task('b', 3, { dependencies: ['open'], status: 'in_progress', ...extra.b }),
  task('c', 4, { dependencies: ['open'], ...extra.c }),
  task('close', 5, { dependencies: ['a', 'b', 'c'], ...extra.close }),
];

const ok = { resumable: true, parkedBefore: 0 };

describe('parkDecision', () => {
  it('adds the siblings it waits for to its dependencies, keeping its own', () => {
    expect(parkDecision(plan(), 'a', ['b', 'c'], ok)).toEqual({ ok: true, dependencies: ['open', 'b', 'c'] });
  });

  it('refuses work that has landed, telling it to take that in', () => {
    const refused = parkDecision(plan(), 'a', ['open'], ok);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? '' : refused.refusal).toContain('#1 "Task open" has landed: take its work in now');
  });

  it('refuses work that may never land: failed, skipped, or landing nothing', () => {
    const tasks = plan({ b: { status: 'failed' }, c: { status: 'skipped' } });
    const readOnly = [...plan(), task('r', 6, { readOnly: true })];
    const both = parkDecision(tasks, 'a', ['b', 'c'], ok);
    expect(both.ok ? '' : both.refusal).toMatch(/#3 "Task b" failed, so its work may never land[\s\S]*#4 "Task c" was skipped/);
    const nothing = parkDecision(readOnly, 'a', ['r'], ok);
    expect(nothing.ok ? '' : nothing.refusal).toContain('lands no work');
  });

  it('refuses a task that waits for this one, which could never land first', () => {
    const waits = parkDecision(plan(), 'a', ['close'], ok);
    expect(waits.ok ? '' : waits.refusal).toContain('#5 "Task close" waits for this task');
    // b already waits for a: a cannot wait for b.
    const cycle = parkDecision(plan({ b: { dependencies: ['open', 'a'] } }), 'a', ['b'], ok);
    expect(cycle.ok).toBe(false);
  });

  it('refuses a runner that cannot continue its session, and a task that has waited its share', () => {
    const noSession = parkDecision(plan(), 'a', ['b'], { resumable: false, parkedBefore: 0 });
    expect(noSession.ok ? '' : noSession.refusal).toContain('cannot continue its session');
    const twice = parkDecision(plan(), 'a', ['b'], { resumable: true, parkedBefore: MAX_PARKS });
    expect(twice.ok ? '' : twice.refusal).toContain(`waited ${MAX_PARKS} times this run`);
  });

  it('refuses the whole call when one task is refused, so nothing changes', () => {
    expect(parkDecision(plan(), 'a', ['b', 'nope'], ok)).toEqual({ ok: false, refusal: 'Not waiting; nothing changed.\n"nope" names no task in the plan.' });
  });
});

describe('parkResumeMessage', () => {
  it('names what landed and how to take it in', () => {
    expect(parkResumeMessage(['#3 "Task b"'], 'Commit your work and take it in with `git merge --no-edit ordewell/run`'))
      .toBe('(Ordewell) The work you waited for has landed: #3 "Task b". Commit your work and take it in with `git merge --no-edit ordewell/run`, resolving any conflict so that both sides\' intent survives, then go on with your brief from where you stopped.');
  });
});
