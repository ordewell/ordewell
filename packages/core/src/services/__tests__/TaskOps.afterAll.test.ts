import { describe, it, expect } from 'vitest';
import { applyTaskOps } from '../TaskOps';
import { afterAllReader } from '../AfterAll';
import { createTask, type Task } from '../../models/Task';

/** An edit of a plan whose closing check depends on "*" (ADR-0077): the list stays "*", and what it covers follows the plan. */

const task = (id: string, order: number, patch: Partial<Task> = {}): Task =>
  createTask({ id, order, title: id.toUpperCase(), prompt: id, assignedRunner: 'claude-code', ...patch });

const plan = (check: Partial<Task> = {}): Task[] => [
  task('a', 1),
  task('b', 2),
  task('suite', 3, { dependencies: ['*'], ...check }),
  task('pr', 4, { dependencies: ['suite'] }),
];

function applied(tasks: Task[], ops: Parameters<typeof applyTaskOps>[1]): Task[] {
  const result = applyTaskOps(tasks, ops, ['claude-code']);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return [...result.tasks];
}

const covered = (tasks: Task[], id = 'suite'): readonly string[] => afterAllReader(tasks)(tasks.find((t) => t.id === id)!);
const titles = (tasks: Task[], ids: readonly string[]) => ids.map((id) => tasks.find((t) => t.id === id)!.title);

describe('an edit of a plan with "*"', () => {
  it('covers a task added later, and puts the check after it, its list still "*"', () => {
    const tasks = applied(plan(), [{ op: 'add', task: { title: 'Docs', prompt: 'docs' } }]);
    expect(tasks.map((t) => t.title)).toEqual(['A', 'B', 'Docs', 'SUITE', 'PR']);
    expect(tasks.find((t) => t.id === 'suite')!.dependencies).toEqual(['*']);
    expect(titles(tasks, covered(tasks))).toEqual(['A', 'B', 'Docs']);
  });

  it('adds a task after a check that has already completed without refusing the edit', () => {
    const done = plan({ status: 'completed' }).map((t) => (t.id === 'a' || t.id === 'b' ? { ...t, status: 'completed' as const } : t));
    const tasks = applied(done, [{ op: 'add', task: { title: 'Late', prompt: 'late' } }]);
    expect(tasks.map((t) => t.title)).toEqual(['A', 'B', 'SUITE', 'PR', 'Late']);
  });

  it('sets "*" by an update, beside a reference written as "#n"', () => {
    const tasks = applied([task('a', 1), task('b', 2), task('check', 3)], [{ op: 'update', taskId: '#3', changes: { dependencies: ['#1', '*'] } }]);
    expect(tasks.find((t) => t.id === 'check')!.dependencies).toEqual(['a', '*']);
  });

  it('covers the parts of a split task and the task two merge into, as it covered them before', () => {
    const split = applied(plan(), [{ op: 'split', taskId: 'a', parts: [{ title: 'A1', prompt: 'a1' }, { title: 'A2', prompt: 'a2' }] }]);
    expect(titles(split, covered(split))).toEqual(['A1', 'A2', 'B']);
    const merged = applied(plan(), [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'AB', prompt: 'ab' } }]);
    expect(titles(merged, covered(merged))).toEqual(['AB']);
  });

  it('keeps "*" on the check it splits into its first part, so the last part still runs after everything', () => {
    const tasks = applied(plan(), [{ op: 'split', taskId: 'suite', parts: [{ title: 'Unit', prompt: 'u' }, { title: 'E2E', prompt: 'e' }] }]);
    const unit = tasks.find((t) => t.title === 'Unit')!;
    expect(unit.dependencies).toEqual(['*']);
    expect(titles(tasks, covered(tasks, unit.id))).toEqual(['A', 'B']);
  });
});
