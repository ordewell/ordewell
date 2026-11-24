import { describe, it, expect } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { heldDependencies } from '../blocking';
function task(id: string, patch: Partial<Task> = {}): Task {
  return createTask({ id, title: id, prompt: 'p', assignedRunner: 'claude-code', ...patch });
}
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
type N = { id: string; deps: string[]; subs: N[]; research?: boolean };
function finish(tasks: Task[], held: (t: Task) => string[]): string[] {
  const all: Task[] = [];
  const walk = (l: Task[]) => l.forEach((t) => { all.push(t); walk(t.subtasks ?? []); });
  walk(tasks);
  const done = new Set<string>();
  for (let progress = true; progress;) {
    progress = false;
    for (const t of all) {
      if (done.has(t.id)) continue;
      const deps = held(t);
      if (deps.every((d) => done.has(d) || !all.some((x) => x.id === d)) && (t.subtasks ?? []).every((s) => done.has(s.id))) { done.add(t.id); progress = true; }
    }
  }
  return all.filter((t) => !done.has(t.id)).map((t) => t.id);
}
describe('a plan whose stated dependencies can finish, with "*" read', () => {
  it('stated-completable plans stay completable with "*" read, subtasks included', () => {
    let tried = 0, stars = 0;
    for (let n = 0; n < 3000; n++) {
      const size = 3 + Math.floor(rnd() * 6);
      const order: string[] = [];
      const make = (id: string, depth: number): N => {
        const subs = depth < 1 && rnd() < 0.3 ? [make(`${id}s0`, depth + 1), make(`${id}s1`, depth + 1)] : [];
        order.push(id);
        return { id, deps: [], subs };
      };
      const tops = Array.from({ length: size }, (_, i) => make(`t${i}`, 0));
      // deps only to earlier leaves/tasks in a random topological order of tops (no cross into own tree)
      const topo = [...tops].sort(() => rnd() - 0.5);
      const idsOf = (t: N): string[] => [t.id, ...t.subs.flatMap(idsOf)];
      topo.forEach((t, i) => {
        const earlier = topo.slice(0, i).flatMap(idsOf);
        const nodes = [t, ...t.subs];
        for (const node of nodes) node.deps = earlier.filter(() => rnd() < 0.15);
        if (rnd() < 0.4) t.deps.push('*');
        if (rnd() < 0.1) t.research = true;
      });
      const build = (x: N): Task => task(x.id, { dependencies: x.deps, research: x.research, subtasks: x.subs.map(build) } as Partial<Task>);
      const tasks = tops.map(build);
      const stated = finish(tasks, (t) => t.dependencies.filter((d) => d !== '*'));
      if (stated.length) continue;
      tried++;
      if (tops.filter((t) => t.deps.includes('*')).length >= 2) stars++;
      const held = heldDependencies(tasks);
      const stuck = finish(tasks, (t) => held(t).map((h) => h.id));
      if (stuck.length) throw new Error('stuck ' + JSON.stringify(stuck) + ' ' + JSON.stringify(tops));
    }
    expect(tried).toBeGreaterThan(500);
    expect(stars).toBeGreaterThan(100);
  });
});
