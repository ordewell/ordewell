import { describe, it, expect } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import * as PlanGraph from '../PlanGraph';

// repairOrder is judged against a brute-force oracle: an order is valid when every in-list dependency
// comes before its dependent, pinned tasks keep their relative order, and none moves to a later slot.
// Only a refusal when no valid order exists is acceptable.

function rng(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuf<T>(a: T[], r: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function perms<T>(a: T[]): T[][] {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
}
const pinned = (t: Task) => t.status === 'in_progress' || t.status === 'completed';
function valid(before: Task[], after: Task[]): boolean {
  const at = new Map(after.map((t, i) => [t.id, i]));
  const was = new Map(before.map((t, i) => [t.id, i]));
  if (after.length !== before.length || at.size !== before.length) return false;
  for (const t of after) for (const d of t.dependencies) if (at.has(d) && at.get(d)! > at.get(t.id)!) return false;
  const pins = after.filter(pinned).map((t) => was.get(t.id)!);
  for (let i = 1; i < pins.length; i++) if (pins[i] < pins[i - 1]) return false;
  for (const t of after) if (pinned(t) && at.get(t.id)! > was.get(t.id)!) return false;
  return true;
}
const describeOrder = (tasks: Task[]) => tasks.map((t) => `${t.id}${pinned(t) ? '*' : ''}[${t.dependencies.join('')}]`).join(' ');
const reaches = (tasks: Task[], from: string, to: string): boolean => {
  const by = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === to) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(by.get(x)?.dependencies ?? []));
  }
  return false;
};

describe('PlanGraph.repairOrder against a brute-force oracle', () => {
  it('accepts exactly when a valid order exists, and returns a valid one', () => {
    const r = rng(7);
    const bad: string[] = [];
    for (let iter = 0; iter < 8000; iter++) {
      const n = 2 + Math.floor(r() * 5);
      const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
      const rank = shuf([...ids], r);
      const tasks = ids.map((id) => {
        const deps = rank.slice(0, rank.indexOf(id)).filter(() => r() < 0.3);
        const s = r();
        const status = s < 0.2 ? 'completed' : s < 0.35 ? 'in_progress' : 'pending';
        return createTask({ id, title: id.toUpperCase(), prompt: 'p', assignedRunner: 'claude-code', dependencies: deps, status: status as Task['status'] });
      });
      const listed = shuf([...tasks], r).map((t, i) => ({ ...t, order: i + 1 }));

      const res = PlanGraph.repairOrder(listed);
      const desc = describeOrder(listed);
      if ('error' in res) {
        if (perms(listed).some((p) => valid(listed, p))) bad.push(`refused but solvable: ${desc} -> ${res.error}`);
      } else {
        if (!valid(listed, res.tasks)) bad.push(`invalid: ${desc} -> ${res.tasks.map((t) => t.id).join('')}`);
        if (valid(listed, listed) && res.moves) bad.push(`moved an already valid order: ${desc} -> ${res.moves}`);
      }
    }
    expect(bad.slice(0, 15)).toEqual([]);
  });

  it('repairs every solvable single park, a waiter gaining an edge to a later sibling', () => {
    const r = rng(11);
    const bad: string[] = [];
    for (let iter = 0; iter < 12000; iter++) {
      const n = 3 + Math.floor(r() * 5);
      const listed: Task[] = [];
      for (let i = 0; i < n; i++) {
        const id = String.fromCharCode(97 + i);
        const deps = listed.filter(() => r() < 0.3).map((t) => t.id);
        const s = r();
        const status = s < 0.25 ? 'completed' : s < 0.45 ? 'in_progress' : 'pending';
        listed.push(createTask({ id, title: id.toUpperCase(), prompt: 'p', assignedRunner: 'claude-code', order: i + 1, dependencies: deps, status: status as Task['status'] }));
      }
      const waiters = listed.filter((t) => !pinned(t));
      if (!waiters.length) continue;
      const w = waiters[Math.floor(r() * waiters.length)];
      const later = listed.slice(listed.indexOf(w) + 1).filter((t) => !reaches(listed, t.id, w.id));
      if (!later.length) continue;
      const z = later[Math.floor(r() * later.length)];
      const parked = listed.map((t) => (t.id === w.id ? { ...t, dependencies: [...t.dependencies, z.id] } : t));

      const res = PlanGraph.repairOrder(parked);
      const desc = describeOrder(parked);
      if ('error' in res) {
        if (perms(parked).some((p) => valid(parked, p))) bad.push(`refused but solvable: ${desc} -> ${res.error}`);
      } else if (!valid(parked, res.tasks)) bad.push(`invalid: ${desc}`);
    }
    expect(bad.slice(0, 6)).toEqual([]);
  });

  it('accepts exactly when a valid order exists in larger, mostly sorted plans, and refuses naming what a pinned task waits on', () => {
    const r = rng(99);
    const bad: string[] = [];
    let refusals = 0;
    for (let iter = 0; iter < 6000; iter++) {
      const n = 6 + Math.floor(r() * 9);
      const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
      const rank = shuf([...ids], r);
      const density = 0.05 + r() * 0.3;
      const tasks = ids.map((id) => {
        const s = r();
        const status = s < 0.25 ? 'completed' : s < 0.4 ? 'in_progress' : 'pending';
        return createTask({ id, title: id.toUpperCase(), prompt: 'p', assignedRunner: 'claude-code', dependencies: rank.slice(0, rank.indexOf(id)).filter(() => r() < density), status: status as Task['status'] });
      });
      // A real plan is close to its dependency order: a topological one with a few swaps.
      const listed = [...tasks].sort((a, b) => rank.indexOf(a.id) - rank.indexOf(b.id));
      for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
        const i = Math.floor(r() * n), j = Math.floor(r() * n);
        [listed[i], listed[j]] = [listed[j], listed[i]];
      }
      const plan = listed.map((t, i) => ({ ...t, order: i + 1 }));

      const res = PlanGraph.repairOrder(plan);
      const desc = describeOrder(plan);
      if ('error' in res) {
        refusals++;
        if (solvable(plan)) bad.push(`refused but solvable: ${desc} -> ${res.error}`);
        const named = /^"(\w+)" would have to run before "(\w+)"/.exec(res.error);
        const dep = named && plan.find((t) => t.title === named[1]);
        const pin = named && plan.find((t) => t.title === named[2]);
        if (!dep || !pin || !pinned(pin) || !reaches(plan, pin.id, dep.id) || dep === pin) bad.push(`refusal names no pinned task and what it waits on: ${desc} -> ${res.error}`);
      } else if (!valid(plan, res.tasks)) bad.push(`invalid: ${desc} -> ${res.tasks.map((t) => t.id).join('')}`);
      else if (valid(plan, plan) && res.moves) bad.push(`moved an already valid order: ${desc} -> ${res.moves}`);
    }
    expect(refusals).toBeGreaterThan(0);
    expect(bad.slice(0, 8)).toEqual([]);
  });

  it('leaves a long valid chain with many pinned tasks as it is', () => {
    const chain = Array.from({ length: 300 }, (_, i) => createTask({
      id: `t${i}`, title: `T${i}`, prompt: 'p', assignedRunner: 'claude-code', order: i + 1,
      dependencies: i > 0 ? [`t${i - 1}`] : [], status: i % 3 === 0 ? 'completed' : 'pending',
    }));
    const res = PlanGraph.repairOrder(chain);
    expect('tasks' in res && res.moves).toBeNull();
  });
});

// Whether a valid order exists, by backtracking over which tasks are placed, for lists too long for `perms`.
function solvable(list: Task[]): boolean {
  const was = new Map(list.map((t, i) => [t.id, i]));
  const ids = new Set(list.map((t) => t.id));
  const pinOrder = list.filter(pinned).map((t) => t.id);
  const done = new Set<string>();
  const dead = new Set<string>();
  const go = (pos: number, pi: number): boolean => {
    if (pos === list.length) return true;
    const key = [...done].sort().join(',');
    if (dead.has(key)) return false;
    for (const t of list) {
      if (done.has(t.id) || t.dependencies.some((d) => ids.has(d) && !done.has(d))) continue;
      if (pinned(t) && (pinOrder[pi] !== t.id || pos > was.get(t.id)!)) continue;
      done.add(t.id);
      if (go(pos + 1, pinned(t) ? pi + 1 : pi)) return true;
      done.delete(t.id);
    }
    dead.add(key);
    return false;
  };
  return go(0, 0);
}
