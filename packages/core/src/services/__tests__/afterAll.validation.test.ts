import { describe, it, expect } from 'vitest';
import { parsePlanJson, validatePlanTasks } from '../PlanValidator';
import { canSetDependencies } from '../PlanTree';
import { createTask, type Task } from '../../models/Task';

/** "*" as every route a plan or an edit arrives by holds it (ADR-0077). */

const runners = ['claude-code'];
const spec = (id: string, order: number, over: Record<string, unknown> = {}) => ({
  id, order, title: `Task ${id}`, description: id, type: 'ai', prompt: `do ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies: [], ...over,
});

function refusals(tasks: Record<string, unknown>[]): string[] {
  const result = validatePlanTasks({ tasks }, runners);
  if (result.ok) throw new Error('expected a refusal');
  return result.errors.map((e) => e.message);
}

describe('a plan that uses "*"', () => {
  it('is accepted on a top-level task, beside an id it names, and stored as written', () => {
    const result = validatePlanTasks({ tasks: [spec('a', 1), spec('b', 2), spec('check', 3, { dependencies: ['a', '*'] }), spec('pr', 4, { dependencies: ['check'] })] }, runners);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tasks.find((t) => t.id === 'check')!.dependencies).toEqual(['a', '*']);
  });

  it('is read as itself by the one-shot intake, never as a task id it resembles', () => {
    const notes: string[] = [];
    const tasks = parsePlanJson(JSON.stringify({ tasks: [spec('a', 1, { title: '*' }), spec('check', 2, { dependencies: ['*'] })] }), runners, undefined, false, notes);
    expect(tasks[1].dependencies).toEqual(['*']);
    expect(notes).toEqual([]);
  });

  it('is refused as a task id, which a dependency on it would read as after-all', () => {
    const messages = refusals([spec('*', 1), spec('a', 2), spec('b', 3, { dependencies: ['*'] })]);
    expect(messages).toEqual([expect.stringContaining('not an id a task can have')]);
  });

  it('is refused on a subtask, with why', () => {
    const messages = refusals([spec('a', 1), spec('b', 2, { subtasks: [spec('b1', 1, { dependencies: ['*'] })] })]);
    expect(messages).toEqual([expect.stringContaining('only a top-level task can')]);
  });

  it('is refused on a loop\'s body task, which depends on its check alone', () => {
    const messages = refusals([
      spec('build', 1),
      spec('review', 2, { dependencies: ['build'], loop: { body: ['fix'] } }),
      spec('fix', 3, { dependencies: ['review', '*'] }),
    ]);
    expect(messages).toEqual([expect.stringContaining('cannot depend on "*"')]);
  });

  it('closes no cycle of its own, but a cycle the plan wrote is still refused', () => {
    const ok = validatePlanTasks({ tasks: [spec('a', 1), spec('x', 2, { dependencies: ['*'] }), spec('w', 3, { dependencies: ['x'] }), spec('y', 4, { dependencies: ['*'] }), spec('z', 5, { dependencies: ['y'] })] }, runners);
    expect(ok.ok).toBe(true);
    const messages = refusals([spec('a', 1, { dependencies: ['b'] }), spec('b', 2, { dependencies: ['a'] }), spec('check', 3, { dependencies: ['*'] })]);
    expect(messages).toEqual([expect.stringContaining('Dependency cycle detected')]);
  });
});

describe('an edit that sets "*"', () => {
  const plan = (): Task[] => [
    createTask({ id: 'a', order: 1, title: 'A' }),
    createTask({ id: 'b', order: 2, title: 'B', subtasks: [createTask({ id: 'b1', order: 1, title: 'B1' })] }),
  ];

  it('is accepted on a top-level task and refused on a subtask', () => {
    expect(canSetDependencies(plan(), 'a', ['*'])).toEqual({ ok: true });
    expect(canSetDependencies(plan(), 'b1', ['*'])).toEqual({ ok: false, error: expect.stringContaining('only a top-level task can') });
  });
});
