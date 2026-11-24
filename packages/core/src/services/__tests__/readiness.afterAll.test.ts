import { describe, it, expect } from 'vitest';
import { selectReadyTasks, startWaits, mergeGate, type ReadinessInput } from '../readiness';
import { planBlocks } from '../blocking';
import { createTask, flattenTasks, type Task } from '../../models/Task';
import type { IsolationTaskRecord } from '../../interfaces/IWorktreeIsolation';

function task(id: string, patch: Partial<Task> = {}): Task {
  return createTask({ id, title: id.toUpperCase(), prompt: 'p', assignedRunner: 'claude-code', ...patch });
}

function storeOf(plan: Task[]) {
  const all = flattenTasks(plan);
  const byId = new Map(all.map((t) => [t.id, t]));
  return {
    allTasks: all as ReadonlyArray<Readonly<Task>>,
    isCompleted: (id: string) => byId.get(id)?.status === 'completed',
    isSkipped: (id: string) => byId.get(id)?.status === 'skipped',
    isOps: (id: string) => {
      const root = plan.find((t) => t.id === id || flattenTasks([t]).some((s) => s.id === id));
      return root?.ops === true || root?.type === 'script';
    },
    get: (id: string) => byId.get(id),
    resolveTaskRunner: (t: Readonly<Task>) => t.assignedRunner,
  };
}

function input(plan: Task[], records: Record<string, IsolationTaskRecord> = {}): ReadinessInput {
  return {
    store: storeOf(plan),
    onHold: new Set(),
    approved: () => true,
    runs: {
      openTaskState: (id: string) => records[id]?.status,
      awaitsMerge: (id: string) => records[id]?.status === 'merged' && !records[id]?.inHead,
    },
    active: 0,
    maxParallel: 10,
    merging: false,
    startsHeld: false,
    completing: new Set(),
    queued: new Set(),
  };
}

const waitsOf = (plan: Task[], id: string) => startWaits(flattenTasks(plan).find((t) => t.id === id)!, input(plan));
const ready = (plan: Task[]) => selectReadyTasks(input(plan)).ready.map((t) => t.id);

describe('a task that depends on "*" (ADR-0077)', () => {
  it('waits for every other task, though it names none, and starts once they are done', () => {
    const plan = [task('a'), task('b'), task('suite', { dependencies: ['*'] }), task('pr', { dependencies: ['suite'] })];
    expect(ready(plan)).toEqual(['a', 'b']);
    expect(waitsOf(plan, 'suite')).toEqual([{ kind: 'dependencies', waiting: ['a', 'b'] }]);
    const done = plan.map((t) => (t.id === 'a' || t.id === 'b' ? { ...t, status: 'completed' as const } : t));
    expect(ready(done)).toEqual(['suite']);
  });

  it('waits for a task added after it was written, which the planner never named', () => {
    const plan = [task('a', { status: 'completed' }), task('suite', { dependencies: ['*'] }), task('late')];
    expect(ready(plan)).toEqual(['late']);
    expect(waitsOf(plan, 'suite')).toEqual([{ kind: 'dependencies', waiting: ['late'] }]);
  });

  it('is released by a skip of a task it covers, held by a retry of one, and lets go of one removed', () => {
    const skipped = [task('a', { status: 'completed' }), task('b', { status: 'skipped' }), task('suite', { dependencies: ['*'] })];
    expect(ready(skipped)).toEqual(['suite']);
    const retried = [task('a', { status: 'completed' }), task('b', { status: 'approved' }), task('suite', { dependencies: ['*'] })];
    expect(waitsOf(retried, 'suite')).toEqual([{ kind: 'dependencies', waiting: ['b'] }]);
    const removed = [task('a', { status: 'completed' }), task('suite', { dependencies: ['*'] })];
    expect(ready(removed)).toEqual(['suite']);
  });

  it('is blocked by a failed task it covers, as by one it names (ADR-0034)', () => {
    const plan = [task('a', { status: 'failed' }), task('b', { status: 'completed' }), task('suite', { dependencies: ['*'] })];
    expect(planBlocks(plan).blocked.get('suite')).toEqual(['a']);
    expect(waitsOf(plan, 'suite')[0]).toEqual({ kind: 'blocked', failed: ['a'] });
  });

  it('passes what it covers to its subtasks, as any dependency of a parent', () => {
    const plan = [task('a'), task('suite', { dependencies: ['*'], subtasks: [task('s1')] })];
    expect(ready(plan)).toEqual(['a']);
    expect(waitsOf(plan, 's1')).toEqual([{ kind: 'dependencies', waiting: ['a'] }]);
  });

  it('as a script task, holds the merge gate on every task it covers', () => {
    const plan = [
      task('a', { status: 'completed' }),
      task('b', { status: 'completed' }),
      createTask({ id: 'suite', title: 'Suite', type: 'script', commands: [['npm', 'test']], dependencies: ['*'] }),
    ];
    const records: Record<string, IsolationTaskRecord> = {
      a: { taskId: 'a', order: 1, title: 'A', branch: 'b/a', workspace: '/wt/a', status: 'merged', repos: {} },
      b: { taskId: 'b', order: 2, title: 'B', branch: 'b/b', workspace: '/wt/b', status: 'merged', repos: {} },
    };
    const rule = input(plan, records);
    expect(mergeGate(plan[2], rule.store, rule.runs)).toEqual(['a', 'b']);
  });

  it('waits for a loop through its check, never on its body, which stays the loop\'s to run', () => {
    const plan = [
      task('a', { status: 'completed' }),
      task('check', {
        status: 'failed', dependencies: ['a'], loop: { body: ['fix'], maxRounds: 2 }, loopRound: 1,
        verdict: { outcome: 'fail', reported: 'failed' } as Task['verdict'],
      }),
      task('fix', { status: 'approved', dependencies: ['check'] }),
      task('final', { dependencies: ['*'] }),
    ];
    expect(ready(plan)).toEqual(['fix']);
    expect(waitsOf(plan, 'final')).toEqual([{ kind: 'dependencies', waiting: ['check'] }]);
  });
});
