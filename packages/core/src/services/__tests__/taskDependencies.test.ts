import { describe, it, expect } from 'vitest';
import { canSetDependencies, dependencyCandidates, dependentsOf } from '../TaskOps';
import { createTask, type Task } from '../../models/Task';

function chain(): Task[] {
  return [
    createTask({ id: 'a', order: 1, title: 'Setup' }),
    createTask({ id: 'b', order: 2, title: 'Build', dependencies: ['a'] }),
    createTask({ id: 'c', order: 3, title: 'Test', dependencies: ['a', 'b'] }),
  ];
}

describe('dependentsOf', () => {
  it('names the tasks a removal would detach', () => {
    expect(dependentsOf(chain(), 'a').map((t) => t.id)).toEqual(['b', 'c']);
    expect(dependentsOf(chain(), 'b').map((t) => t.id)).toEqual(['c']);
  });

  it('reports nothing for a leaf', () => {
    expect(dependentsOf(chain(), 'c')).toEqual([]);
  });
});

describe('dependencyCandidates', () => {
  it('offers only the tasks displayed before the target', () => {
    expect(dependencyCandidates(chain(), 'c').map((t) => t.id)).toEqual(['a', 'b']);
    expect(dependencyCandidates(chain(), 'a')).toEqual([]);
  });

  it('offers every task for one that does not exist yet', () => {
    expect(dependencyCandidates(chain()).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('offers nothing for an unknown id rather than pretending it is new', () => {
    expect(dependencyCandidates(chain(), 'nope')).toEqual([]);
  });
});

describe('canSetDependencies', () => {
  it('accepts a list of earlier tasks', () => {
    expect(canSetDependencies(chain(), 'c', ['a'])).toEqual({ ok: true });
    expect(canSetDependencies(chain(), 'c', [])).toEqual({ ok: true });
  });

  it('rejects a self-reference', () => {
    const result = canSetDependencies(chain(), 'b', ['b']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot depend on itself/);
  });

  it('rejects a dependency that comes after the task, which is what a cycle looks like here', () => {
    const result = canSetDependencies(chain(), 'a', ['c']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/comes after it/);
  });

  it('rejects an id no task has', () => {
    expect(canSetDependencies(chain(), 'c', ['ghost']).error).toMatch(/Unknown dependency/);
  });

  it('rejects an edit to a task that is not in the plan', () => {
    expect(canSetDependencies(chain(), 'ghost', [])).toEqual({ ok: false, error: 'Task not found' });
  });
});
