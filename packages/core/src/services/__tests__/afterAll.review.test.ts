import { describe, it, expect } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { afterAllReader, resolveAfterAll } from '../AfterAll';
import { findDependencyCycle } from '../PlanTree';
import { loopErrors } from '../../models/Loop';
import { revertScope } from '../taskRevert';
function task(id: string, patch: Partial<Task> = {}): Task {
  return createTask({ id, title: id, prompt: 'p', assignedRunner: 'claude-code', ...patch });
}
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
describe('"*" as the adversarial review found it (ADR-0077)', () => {
  it('no cycle from "*" on random acyclic stated plans', () => {
    let star2 = 0;
    for (let n = 0; n < 4000; n++) {
      const size = 3 + Math.floor(rnd() * 8);
      const ids = Array.from({ length: size }, (_, i) => `t${i}`);
      // random permutation order for edges: edge only from later to earlier in a hidden topological order
      const topo = [...ids].sort(() => rnd() - 0.5);
      const tasks = ids.map((id) => {
        const at = topo.indexOf(id);
        const deps = topo.slice(0, at).filter(() => rnd() < 0.25);
        if (rnd() < 0.35) deps.push('*');
        return task(id, { dependencies: deps });
      });
      expect(findDependencyCycle(tasks)).toBeNull();
      const resolved = [...resolveAfterAll(tasks)];
      const cyc = findDependencyCycle(resolved);
      if (cyc) throw new Error('cycle: ' + JSON.stringify(tasks.map((t) => [t.id, t.dependencies])));
      if (tasks.filter((t) => t.dependencies.includes('*')).length >= 2) star2++;
    }
    expect(star2).toBeGreaterThan(1000);
  });
  it('a closing check after another one waits for the work between them', () => {
    const plan = [task('a'), task('check1', { dependencies: ['*'] }), task('c', { dependencies: ['check1'] }), task('final', { dependencies: ['*', 'check1'] })];
    expect(afterAllReader(plan)(plan[3])).toEqual(['check1', 'a', 'c']);
  });

  it('refuses "*" on a loop body task even when its check holds "*"', () => {
    const plan = [
      task('a'),
      task('check', { dependencies: ['*'], loop: { body: ['fix'], maxRounds: 3 } }),
      task('fix', { dependencies: ['check', '*'] }),
    ];
    expect(loopErrors(plan).map((e) => e.taskId)).toEqual(['fix']);
  });

  it('a revert of a task added after a finished "*" check leaves the check alone', () => {
    const rec = (id: string, order: number) => ({ taskId: id, order, title: id, branch: `b/${id}`, workspace: `/wt/${id}`, status: 'merged', repos: { '/repo': { changed: true } } });
    const tasks = [
      task('a', { status: 'completed', order: 1 }),
      task('z', { status: 'completed', order: 2, dependencies: ['*'] }),
      task('y', { status: 'completed', order: 3 }),
    ];
    const run = {
      tasks: { a: rec('a', 1), z: rec('z', 2), y: rec('y', 3) },
      landings: { a: { '/repo': ['m1'] }, z: { '/repo': ['m2'] }, y: { '/repo': ['m3'] } },
      keepsEveryLanding: true, carried: {},
      landedOn: { a: [], z: ['a'], y: [] },
    } as unknown as Parameters<typeof revertScope>[1]['run'];
    expect(revertScope('y', { tasks, run, live: new Set(), resolvers: () => [] }).taskIds).toEqual(['y']);
  });
});
