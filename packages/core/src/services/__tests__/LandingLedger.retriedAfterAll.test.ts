import { describe, it, expect } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { revertScope } from '../taskRevert';
function task(id: string, patch: Partial<Task> = {}): Task {
  return createTask({ id, title: id, prompt: 'p', assignedRunner: 'claude-code', ...patch });
}
const rec = (id: string, order: number) => ({ taskId: id, order, title: id, branch: `b/${id}`, workspace: `/wt/${id}`, status: 'merged', repos: { '/repo': { changed: true } } });
describe('revert past a retried "*" check', () => {
  for (const zStar of [true, false]) it(`a running retried check that stands on y holds y's revert (z ${zStar ? '"*"' : 'names y'})`, () => {
    const tasks = [
      task('a', { status: 'completed', order: 1 }),
      task('z', { status: 'in_progress', order: 2, dependencies: zStar ? ['*'] : ['a', 'y'] }),
      task('y', { status: 'completed', order: 3 }),
    ];
    // z landed once on [a]; then y was added and landed; then z was retried and is running from a tip holding y.
    const run = {
      tasks: { a: rec('a', 1), z: { ...rec('z', 2), status: 'active' }, y: rec('y', 3) },
      landings: { a: { '/repo': ['m1'] }, z: { '/repo': ['m2'] }, y: { '/repo': ['m3'] } },
      keepsEveryLanding: true, carried: {},
      landedOn: { a: [], z: ['a'], y: [] },
    } as unknown as Parameters<typeof revertScope>[1]['run'];
    const scope = revertScope('y', { tasks, run, live: new Set(['z']), resolvers: () => [] });
    expect(scope.refusal?.reason).toBe('live-dependent');
  });
});
