import { describe, it, expect } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import * as PlanGraph from '../PlanGraph';

function task(id: string, patch: Partial<Task> = {}): Task {
  return createTask({ id, title: id.toUpperCase(), prompt: 'p', assignedRunner: 'claude-code', ...patch });
}

/** a, b at the top; c holds c1 (which holds c11) and c2. */
function tree(): Task[] {
  return [
    task('a', { order: 1 }),
    task('b', { order: 2 }),
    task('c', {
      order: 3,
      subtasks: [
        task('c1', { order: 1, subtasks: [task('c11', { order: 1 })] }),
        task('c2', { order: 2 }),
      ],
    }),
  ];
}

/** Every task of a tree by id, to read one at any depth. */
function byId(tasks: readonly Task[]): Map<string, Task> {
  const found = new Map<string, Task>();
  const walk = (level: readonly Task[]) => level.forEach((t) => { found.set(t.id, t); walk(t.subtasks); });
  walk(tasks);
  return found;
}

describe('PlanGraph.remove', () => {
  it('takes the task and its subtree, and every edge into either, at any depth', () => {
    const plan = tree();
    plan[1].dependencies = ['c1'];
    plan[2].subtasks[1].dependencies = ['c11', 'a'];
    plan[2].subtasks[0].subtasks[0].dependencies = ['c2'];
    const after = byId(PlanGraph.remove(plan, 'c1'));
    expect([...after.keys()]).toEqual(['a', 'b', 'c', 'c2']);
    expect(after.get('b')!.dependencies).toEqual([]);
    expect(after.get('c2')!.dependencies).toEqual(['a']);
  });

  it('renumbers the siblings it leaves', () => {
    const after = PlanGraph.remove(tree(), 'a');
    expect(after.map((t) => [t.id, t.order])).toEqual([['b', 1], ['c', 2]]);
  });

  it('takes the task out of a loop body, and ends a loop it leaves with no body', () => {
    const plan = [
      task('check', { order: 1, loop: { body: ['fix1', 'fix2'], maxRounds: 3 }, loopRound: 1 }),
      task('fix1', { order: 2, dependencies: ['check'] }),
      task('fix2', { order: 3, dependencies: ['check'] }),
    ];
    const one = PlanGraph.remove(plan, 'fix1');
    expect(one[0].loop?.body).toEqual(['fix2']);
    const none = PlanGraph.remove(one, 'fix2');
    expect(none[0].loop).toBeUndefined();
    expect(none[0].loopRound).toBeUndefined();
  });

  it('leaves the plan as it is for an id that is not in it', () => {
    const plan = tree();
    expect(PlanGraph.remove(plan, 'nope')).toEqual(plan);
  });
});

describe('PlanGraph.replace', () => {
  it('points a dependent at any depth at the tail, once', () => {
    const plan = tree();
    plan[2].subtasks[0].dependencies = ['a'];
    plan[2].subtasks[0].subtasks[0].dependencies = ['b'];
    const after = byId(PlanGraph.replace(plan, ['a', 'b'], [task('ab')], 'ab'));
    expect(after.get('c1')!.dependencies).toEqual(['ab']);
    expect(after.get('c11')!.dependencies).toEqual(['ab']);
  });

  it('leaves a task that depended on several replaced ones with one edge', () => {
    const plan = tree();
    plan[2].dependencies = ['a', 'b'];
    plan[2].subtasks[1].dependencies = ['b', 'a', 'b'];
    const after = byId(PlanGraph.replace(plan, ['a', 'b'], [task('ab')], 'ab'));
    expect(after.get('c')!.dependencies).toEqual(['ab']);
    expect(after.get('c2')!.dependencies).toEqual(['ab']);
  });

  it('keeps the order of the dependencies it leaves, and dedupes one already stated twice', () => {
    const plan = tree();
    plan[2].dependencies = ['b', 'x', 'x'];
    const after = byId(PlanGraph.replace(plan, ['a', 'b'], [task('ab')], 'ab'));
    expect(after.get('c')!.dependencies).toEqual(['ab', 'x']);
  });

  it('puts the new tasks where the first replaced one was, and renumbers', () => {
    const after = PlanGraph.replace(tree(), ['b', 'c'], [task('b1'), task('b2')], 'b2');
    expect(after.map((t) => [t.id, t.order])).toEqual([['a', 1], ['b1', 2], ['b2', 3]]);
  });

  it('puts them last when none of the replaced ids is in the plan', () => {
    const after = PlanGraph.replace(tree(), ['nope'], [task('n')], 'n');
    expect(after.map((t) => t.id)).toEqual(['a', 'b', 'c', 'n']);
  });

  it('leaves the dependencies the new tasks state as they are', () => {
    const merged = task('ab', { dependencies: ['x'] });
    const after = PlanGraph.replace(tree(), ['a', 'b'], [merged], 'ab');
    expect(after[0].dependencies).toEqual(['x']);
  });

  it('puts the new tasks at the level the first replaced one was on', () => {
    const after = PlanGraph.replace(tree(), ['c1'], [task('n1'), task('n2')], 'n2');
    expect(byId(after).get('c')!.subtasks.map((t) => [t.id, t.order])).toEqual([['n1', 1], ['n2', 2], ['c2', 3]]);
  });

  it('does not rewire an edge into a subtask it drops, which the plan invariants refuse', () => {
    const plan = tree();
    plan[1].dependencies = ['c11'];
    const after = byId(PlanGraph.replace(plan, ['c'], [task('c')], 'c'));
    expect(after.get('b')!.dependencies).toEqual(['c11']);
  });
});

describe('PlanGraph.repairOrder', () => {
  const ids = (r: ReturnType<typeof PlanGraph.repairOrder>) => ('tasks' in r ? r.tasks.map((t) => t.id) : r.error);

  it('moves a dependency ahead of its dependent, and says what moved', () => {
    const r = PlanGraph.repairOrder([task('b', { order: 1, dependencies: ['a'] }), task('a', { order: 2 })]);
    expect(ids(r)).toEqual(['a', 'b']);
    expect('moves' in r && r.moves).toBe('"A" #2→#1, "B" #1→#2');
  });

  it('keeps unconstrained tasks in their listed order, with no moves', () => {
    const r = PlanGraph.repairOrder([task('a', { order: 1 }), task('b', { order: 2 }), task('c', { order: 3, dependencies: ['a'] })]);
    expect(ids(r)).toEqual(['a', 'b', 'c']);
    expect('moves' in r && r.moves).toBeNull();
  });

  it('lets a dependency outside the list constrain nothing', () => {
    const r = PlanGraph.repairOrder([task('a', { order: 1, dependencies: ['elsewhere'] }), task('b', { order: 2 })]);
    expect(ids(r)).toEqual(['a', 'b']);
  });

  it('keeps a pinned task in its slot and moves the free ones around it', () => {
    const r = PlanGraph.repairOrder([
      task('late', { order: 1, dependencies: ['dep'] }),
      task('run', { order: 2, status: 'in_progress' }),
      task('dep', { order: 3 }),
    ]);
    expect(ids(r)).toEqual(['dep', 'run', 'late']);
  });

  it('refuses a pinned task that would have to run after something that depends on it', () => {
    const r = PlanGraph.repairOrder([task('x', { order: 1, dependencies: ['done'] }), task('done', { order: 2, status: 'completed' })]);
    expect(ids(r)).toBe('"X" would have to run after "DONE", which is completed and cannot be moved');
  });

  it('refuses a pinned task that depends on one listed after it', () => {
    const r = PlanGraph.repairOrder([task('run', { order: 1, status: 'in_progress', dependencies: ['dep'] }), task('dep', { order: 2 })]);
    expect(ids(r)).toBe('"DEP" would have to run before "RUN", which is running and cannot be moved');
  });
});
