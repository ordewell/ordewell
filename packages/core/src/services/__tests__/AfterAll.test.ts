import { describe, it, expect } from 'vitest';
import { createTask, flattenTasks, type Task } from '../../models/Task';
import { afterAllReader, resolveAfterAll } from '../AfterAll';
import { findDependencyCycle } from '../PlanTree';

function task(id: string, patch: Partial<Task> = {}): Task {
  return createTask({ id, title: id.toUpperCase(), prompt: 'p', assignedRunner: 'claude-code', ...patch });
}

const depsOf = (tasks: Task[], id: string): readonly string[] => afterAllReader(tasks)(tasks.find((t) => t.id === id)!);

describe('"*" in a dependency list', () => {
  it('stands for every other top-level task, after the ids it names', () => {
    const plan = [task('a'), task('b'), task('check', { dependencies: ['b', '*'] }), task('c')];
    expect(depsOf(plan, 'check')).toEqual(['b', 'a', 'c']);
  });

  it('leaves out what comes after the task, directly or not, a PR opener after the check among them', () => {
    const plan = [
      task('a'),
      task('check', { dependencies: ['*'] }),
      task('pr', { dependencies: ['check'] }),
      task('announce', { dependencies: ['pr'] }),
    ];
    expect(depsOf(plan, 'check')).toEqual(['a']);
  });

  it('counts a task as after it when one of its subtasks waits on it', () => {
    const plan = [
      task('a'),
      task('check', { dependencies: ['*'] }),
      task('follow', { subtasks: [task('f1', { dependencies: ['check'] })] }),
    ];
    expect(depsOf(plan, 'check')).toEqual(['a']);
  });

  it('leaves out research tasks', () => {
    const plan = [task('scan', { research: true }), task('a'), task('check', { dependencies: ['*'] })];
    expect(depsOf(plan, 'check')).toEqual(['a']);
  });

  it('waits for a loop through its check, never its body; a check with "*" waits for neither its body nor what follows the loop', () => {
    const plan = [
      task('a'),
      task('loopcheck', { dependencies: ['a'], loop: { body: ['fix'], maxRounds: 3 } }),
      task('fix', { dependencies: ['loopcheck'] }),
      task('final', { dependencies: ['*'] }),
    ];
    expect(depsOf(plan, 'final')).toEqual(['a', 'loopcheck']);
    const starred = [
      task('a'),
      task('loopcheck', { dependencies: ['*'], loop: { body: ['fix'], maxRounds: 3 } }),
      task('fix', { dependencies: ['loopcheck'] }),
      task('after', { dependencies: ['loopcheck'] }),
    ];
    expect(depsOf(starred, 'loopcheck')).toEqual(['a']);
  });

  it('two "*" tasks do not wait for each other, nor for what follows the other, unless one names the other', () => {
    const plan = [
      task('a'),
      task('suite', { dependencies: ['*'] }),
      task('pr', { dependencies: ['suite'] }),
      task('docs', { dependencies: ['*'] }),
    ];
    expect(depsOf(plan, 'suite')).toEqual(['a']);
    expect(depsOf(plan, 'docs')).toEqual(['a']);
    const named = plan.map((t) => (t.id === 'docs' ? { ...t, dependencies: ['*', 'suite'] } : t));
    expect(depsOf(named, 'docs')).toEqual(['suite', 'a']);
    expect(depsOf(named, 'suite')).toEqual(['a']);
  });

  it('never closes a cycle: two "*" tasks each with a follower that the other would otherwise wait on', () => {
    const plan = [
      task('a'),
      task('x', { dependencies: ['*'] }),
      task('w', { dependencies: ['x'] }),
      task('y', { dependencies: ['*'] }),
      task('z', { dependencies: ['y'] }),
    ];
    expect(findDependencyCycle([...resolveAfterAll(plan)])).toBeNull();
    expect(depsOf(plan, 'x')).toEqual(['a']);
  });

  it('covers a task added later, and lets go of one removed, with the stored list unchanged', () => {
    const plan = [task('a'), task('check', { dependencies: ['*'] })];
    expect(depsOf(plan, 'check')).toEqual(['a']);
    const grown = [...plan, task('late')];
    expect(depsOf(grown, 'check')).toEqual(['a', 'late']);
    expect(depsOf(grown.filter((t) => t.id !== 'a'), 'check')).toEqual(['late']);
    expect(grown[1].dependencies).toEqual(['*']);
  });

  it('reads a flat list whose tasks keep their subtasks as it reads the tree', () => {
    const plan = [task('a', { subtasks: [task('a1')] }), task('check', { dependencies: ['*'] })];
    expect(afterAllReader(flattenTasks(plan))(plan[1])).toEqual(['a']);
  });

  it('gives a subtask that holds it nothing for it', () => {
    const plan = [task('a'), task('b', { subtasks: [task('b1', { dependencies: ['*', 'a'] })] })];
    expect(afterAllReader(plan)(plan[1].subtasks[0])).toEqual(['a']);
  });

  it('reads a task the plan does not hold yet as a top-level task', () => {
    const plan = [task('a'), task('b')];
    expect(afterAllReader(plan)({ id: 'new', dependencies: ['*'] })).toEqual(['a', 'b']);
  });

  it('hands back a plan without "*" as the same array', () => {
    const plan = [task('a'), task('b', { dependencies: ['a'] })];
    expect(resolveAfterAll(plan)).toBe(plan);
  });
});
