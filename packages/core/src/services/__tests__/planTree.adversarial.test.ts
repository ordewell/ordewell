import { describe, it, expect } from 'vitest';
import { applyTaskOps } from '../TaskOps';
import { canSetDependencies, dependencyCandidates, dependentsOf, subtreeIds } from '../PlanTree';
import { keepExecutionState, createTask, type Task } from '../../models/Task';
import { plannedTask, checkPlanInvariants } from '../PlannedTask';

function task(over: Partial<Task> = {}): Task {
  return createTask({ id: 't', title: 'T', prompt: 'do it', assignedRunner: 'claude-code', ...over });
}

function tree(): Task[] {
  return [
    task({ id: 'a', order: 1, title: 'A', subtasks: [
      task({ id: 'a1', order: 1, title: 'A1' }),
      task({ id: 'a2', order: 2, title: 'A2' }),
    ] }),
    task({ id: 'b', order: 2, title: 'B', subtasks: [task({ id: 'b1', order: 1, title: 'B1' })] }),
    task({ id: 'c', order: 3, title: 'C' }),
  ];
}

const RUNNERS = ['claude-code' as const];

describe('adversarial: the batch dependency graph (task ops)', () => {
  it('lets a later op finish an earlier rewire that momentarily closed a cycle', () => {
    const tasks = tree();
    tasks[2].dependencies = ['a'];
    const result = applyTaskOps(tasks, [
      { op: 'update', taskId: 'a', changes: { dependencies: ['c'] } },
      { op: 'update', taskId: 'c', changes: { dependencies: [] } },
    ], RUNNERS);
    expect(result.ok).toBe(true);
    expect(result.tasks.find((t) => t.id === 'a')!.dependencies).toEqual(['c']);
  });

  it('refuses a batch that ends in a cycle, naming the op that broke it', () => {
    const tasks = tree();
    tasks[2].dependencies = ['a'];
    const result = applyTaskOps(tasks, [
      { op: 'update', taskId: 'a', changes: { dependencies: ['c'] } },
    ], RUNNERS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/^op 1 \(update\): Dependency cycle detected/);
  });

  it('refuses a planner update whose only change is a self-dependency, rather than stripping it', () => {
    const result = applyTaskOps(tree(), [
      { op: 'update', taskId: 'a', changes: { dependencies: ['a'] } },
    ], RUNNERS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/cycle/i);
    expect(result.errors[0]).toMatch(/"A" → "A"/);
  });

  it('resolves a subtask dependency written as a dotted ref across branches', () => {
    const result = applyTaskOps(tree(), [
      { op: 'add', task: { title: 'Z', prompt: 'z', dependencies: ['#2.1'] } },
    ], RUNNERS);
    expect(result.ok).toBe(true);
    const added = result.tasks.at(-1)!;
    expect(added.dependencies).toEqual(['b1']);
  });

  it('refuses an added subtask that depends on the task it hangs under, by the id the planner gave it', () => {
    const result = applyTaskOps(tree(), [
      { op: 'add', task: { id: 'p1', title: 'P', prompt: 'p', subtasks: [
        { id: 's1', title: 'S', prompt: 's', dependencies: ['p1'] },
      ] as never } },
    ], RUNNERS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/ancestor or descendant/i);
  });

  it('pins order labels to the plan as the batch began: a remove does not shift a later "#2"', () => {
    const result = applyTaskOps(tree(), [
      { op: 'remove', taskId: '#1' },
      { op: 'update', taskId: '#2', changes: { title: 'Rewired' } },
    ], RUNNERS);
    expect(result.ok).toBe(true);
    expect(result.tasks.find((t) => t.id === 'b')!.title).toBe('Rewired');
  });

  it('resolves a later op\'s title ref against the tree the batch began with, after an earlier op renamed the task', () => {
    const result = applyTaskOps(tree(), [
      { op: 'update', taskId: 'b', changes: { title: 'Renamed' } },
      { op: 'update', taskId: 'B', changes: { description: 'found' } },
    ], RUNNERS);
    expect(result.ok).toBe(true);
    expect(result.tasks.find((t) => t.id === 'b')!.description).toBe('found');
  });

  it('refuses a dependency on a task an earlier op removed, rather than writing a dead id', () => {
    const result = applyTaskOps(tree(), [
      { op: 'remove', taskId: 'a' },
      { op: 'update', taskId: 'c', changes: { dependencies: ['a'] } },
    ], RUNNERS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/op 2 \(update\)/);
    expect(result.errors[0]).toMatch(/no longer exists/i);
  });

  it('detaches a dependency on a removed task\'s subtask within the same batch', () => {
    const tasks = tree();
    tasks[2].dependencies = ['b1'];
    const result = applyTaskOps(tasks, [
      { op: 'remove', taskId: 'b' },
    ], RUNNERS);
    expect(result.ok).toBe(true);
    expect(result.tasks.find((t) => t.id === 'c')!.dependencies).toEqual([]);
  });

  it('refuses a reorder that names a subtask by its dotted label', () => {
    const result = applyTaskOps(tree(), [
      { op: 'reorder', taskIds: ['a', 'b', 'c', '#1.1'] },
    ], RUNNERS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/unknown task in reorder list/i);
  });

  it('refuses a repair that would have to move a completed task past work it depends on, naming both', () => {
    const tasks = tree();
    tasks[1] = { ...tasks[1], status: 'completed', dependencies: ['a'] };
    const result = applyTaskOps(tasks, [
      { op: 'update', taskId: 'a', changes: { dependencies: ['c'] } },
    ], RUNNERS);
    expect(result.ok).toBe(false);
    // B waits on A, which now waits on C, listed after B.
    expect(result.errors[0]).toMatch(/"C" would have to run before "B", which is completed and cannot be moved/);
  });

  it('lets a completed task move up, keeping its order, so a task that now depends on it follows it', () => {
    const tasks = tree();
    tasks[2].status = 'completed';
    const result = applyTaskOps(tasks, [
      { op: 'update', taskId: 'a', changes: { dependencies: ['c'] } },
    ], RUNNERS);
    expect(result.errors).toEqual([]);
    expect(result.tasks.map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('adversarial: dependency rules over the whole tree', () => {
  it('keeps a subtask-to-subtask dependency across branches valid for a direct edit', () => {
    expect(canSetDependencies(tree(), 'a2', ['b1'])).toEqual({ ok: true });
  });

  it('refuses a subtask depending on its own grandparent, not just its parent', () => {
    const tasks = tree();
    const deep = tree()[0].subtasks[1];
    (deep as Task).subtasks = [task({ id: 'deep', order: 1, title: 'Deep' })];
    expect(canSetDependencies(tasks, 'deep', ['a']).ok).toBe(false);
    expect(canSetDependencies(tasks, 'a', ['deep']).ok).toBe(false);
  });

  it('offers only the deeper level\'s earlier siblings for a second-level subtask', () => {
    const tasks = tree();
    (tasks[0].subtasks![1] as Task).subtasks = [
      task({ id: 'd1', order: 1, title: 'D1' }),
      task({ id: 'd2', order: 2, title: 'D2' }),
    ];
    expect(dependencyCandidates(tasks, 'd2').map((t) => t.id)).toEqual(['d1']);
    expect(dependencyCandidates(tasks, 'd2').map((t) => t.id)).not.toContain('a1');
  });

  it('names a dependent on a removed task\'s subtask, and none inside the removed subtree', () => {
    const tasks = tree();
    (tasks[0].subtasks![0] as Task).dependencies = ['a'];
    (tasks[2] as Task).dependencies = ['a1'];
    const dependents = dependentsOf(tasks, 'a');
    expect(dependents.map((t) => t.id)).toEqual(['c']);
  });

  it('takes the whole subtree for a mid-level removal', () => {
    const tasks = tree();
    (tasks[0].subtasks![1] as Task).subtasks = [task({ id: 'deep', order: 1, title: 'Deep' })];
    expect(subtreeIds(tasks, 'a2')).toEqual(new Set(['a2', 'deep']));
  });

  it('lets an earlier sibling depend on a later one when the graph allows it', () => {
    const tasks = [task({ id: 'a', order: 1, title: 'A' }), task({ id: 'b', order: 2, title: 'B' })];
    expect(canSetDependencies(tasks, 'a', ['b'])).toEqual({ ok: true });
  });
});

describe('adversarial: whole-plan intake (submit_plan) dependencies', () => {
  const intake = (tasks: Task[]) => {
    const planned = tasks.map((t) => plannedTask(t, { runners: ['claude-code'], runnerModes: {
      'claude-code': [
        { id: 'acceptEdits', label: 'Edit', description: '' },
        { id: 'bypassPermissions', label: 'Bypass', description: '', autonomous: true },
        { id: 'plan', label: 'Plan', description: '', readOnly: true },
      ],
    } }));
    return [...planned.flatMap((p) => p.errors), ...checkPlanInvariants(planned.map((p) => p.task), ['claude-code'])];
  };

  it('refuses a subtask depending on its own parent in a submitted plan', () => {
    const errors = intake([
      task({ id: 'p', order: 1, title: 'P', subtasks: [task({ id: 'kid', order: 1, title: 'Kid', dependencies: ['p'] })] }),
    ]);
    expect(errors.map((e) => e.message).join('\n')).toMatch(/ancestor or descendant/i);
  });

  it('accepts a top-level task depending on a later one — display order is not a requirement', () => {
    const errors = intake([
      task({ id: 'a', order: 1, title: 'A', dependencies: ['b'] }),
      task({ id: 'b', order: 2, title: 'B' }),
    ]);
    expect(errors).toEqual([]);
  });

  it('refuses a submitted task depending on an id that is nowhere in the plan', () => {
    const errors = intake([task({ id: 'a', order: 1, title: 'A', dependencies: ['ghost'] })]);
    expect(errors.map((e) => e.message).join('\n')).toMatch(/Unknown dependency "ghost"/);
  });
});

describe('adversarial: a submit_plan rewrite and execution state', () => {
  const skipped = { ...task({ id: 'a', order: 1, title: 'A' }), status: 'skipped' as const, skipReason: 'not needed on this host' };

  it('keeps a skipped task\'s skip reason when the rewrite restates it', () => {
    const restated = { ...task({ id: 'a', order: 1, title: 'A' }), skipReason: 'the planner made this up' };
    const [kept] = keepExecutionState([skipped], [restated]);
    expect(kept.status).toBe('skipped');
    expect(kept.skipReason).toBe('not needed on this host');
  });

  // The rewrite's omission removes a task that is not settled — a skipped task
  // is terminal but not settled (completed/in_progress/awaiting_user are) —
  // so this documents the boundary rather than a fault.
  it('drops a skipped task the rewrite omits, as the rewrite rule keeps only settled ones', () => {
    const b = task({ id: 'b', order: 2, title: 'B' });
    const rewritten = keepExecutionState([skipped, b], [task({ id: 'b', order: 1, title: 'B' })]);
    expect(rewritten.map((t) => t.id)).toEqual(['b']);
  });

  it('keeps the skip reason of a skipped subtask too', () => {
    const parent = task({ id: 'p', order: 1, title: 'P', subtasks: [
      { ...task({ id: 'kid', order: 1, title: 'Kid' }), status: 'skipped' as const, skipReason: 'covered elsewhere' },
    ] });
    const restated = task({ id: 'p', order: 1, title: 'P', subtasks: [
      task({ id: 'kid', order: 1, title: 'Kid' }),
    ] });
    const [kept] = keepExecutionState([parent], [restated]);
    expect(kept.subtasks![0].status).toBe('skipped');
    expect(kept.subtasks![0].skipReason).toBe('covered elsewhere');
  });
});
