import { describe, it, expect } from 'vitest';
import { createTask, taskOrderLabel } from '@ordewell/core';
import { resolveTaskId } from '../tasks';

function planWith(tasks: ReturnType<typeof createTask>[]) {
  return { pendingTasks: tasks, executionLog: [] };
}

describe('resolveTaskId', () => {
  it('resolves a dotted subtask label to the subtask id', () => {
    const child = createTask({ id: 'child-1', order: 1 });
    const parent = createTask({ id: 'parent-2', order: 2, subtasks: [createTask({ id: 'c0', order: 0 }), child] });
    const plan = planWith([createTask({ id: 't0', order: 1 }), parent]);
    expect(resolveTaskId(plan, '2.1')).toBe('child-1');
  });

  it('resolves a plain top-level order as before', () => {
    const plan = planWith([createTask({ id: 't0', order: 1 }), createTask({ id: 't1', order: 2 })]);
    expect(resolveTaskId(plan, '2')).toBe('t1');
  });

  it('resolves an exact task id as before', () => {
    const plan = planWith([createTask({ id: 't1', order: 1 })]);
    expect(resolveTaskId(plan, 't1')).toBe('t1');
  });

  it('resolves a unique id prefix as before', () => {
    const plan = planWith([createTask({ id: 'abc-123', order: 1 }), createTask({ id: 'xyz-789', order: 2 })]);
    expect(resolveTaskId(plan, 'abc')).toBe('abc-123');
  });

  it('does not resolve a prefix shared by more than one task', () => {
    const plan = planWith([createTask({ id: 'ab-1', order: 1 }), createTask({ id: 'ab-2', order: 2 })]);
    expect(resolveTaskId(plan, 'ab')).toBeUndefined();
  });

  it('returns undefined for a dotted label whose subtask does not exist', () => {
    const parent = createTask({ id: 'parent-2', order: 2, subtasks: [createTask({ id: 'c0', order: 0 })] });
    const plan = planWith([createTask({ id: 't0', order: 1 }), parent]);
    expect(resolveTaskId(plan, '2.9')).toBeUndefined();
  });

  it('resolves a subtask id inside a parent whose subtasks live in executionLog', () => {
    const child = createTask({ id: 'done-child', order: 1 });
    const parent = createTask({ id: 'done-parent', order: 2, subtasks: [child] });
    const plan = { pendingTasks: [], executionLog: [parent] };
    expect(resolveTaskId(plan, '2.1')).toBe('done-child');
  });

  it('resolves exactly the dotted label the shared taskOrderLabel renders for the same subtask', () => {
    const child = createTask({ id: 'child-1', order: 1 });
    const parent = createTask({ id: 'parent-2', order: 2, subtasks: [child, createTask({ id: 'child-2', order: 2 })] });
    const plan = planWith([createTask({ id: 't0', order: 1 }), parent]);
    const label = taskOrderLabel(child, parent);
    expect(label).toBe('2.1');
    expect(resolveTaskId(plan, label)).toBe('child-1');
  });
});
