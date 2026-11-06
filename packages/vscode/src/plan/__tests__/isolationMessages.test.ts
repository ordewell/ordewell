import { describe, it, expect, vi } from 'vitest';
import { EMPTY_RUN, reduceRun, type LegacyPlanState, type RunView, type SerializedTask, type TaskIsolation } from '@ordewell/core';
import { SessionView, type RunViewHost } from '@ordewell/ui/host';
import { handleSessionMessage } from '../PlanManager';
import type { PlanManagerDeps } from '../PlanManager';

function planned(id: string, order: number): SerializedTask {
  return {
    id, order, title: `Task ${id}`, type: 'ai', status: 'pending', description: 'd', dependencies: [],
    assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: null, subtasks: [],
    userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined,
  };
}

/** A host-like deps where the run view is real, so the fold is the thing under test. */
function deps(): { d: PlanManagerDeps; posted: RunView[]; run: RunViewHost } {
  const posted: RunView[] = [];
  const view = new SessionView((m) => { if (m.type === 'runView') posted.push(m.view); });
  const { run } = view;
  run.adopt(reduceRun(EMPTY_RUN, {
    type: 'plan_generated',
    plan: { tasks: [planned('t1', 1), planned('o2', 2)], runners: ['claude-code'], generatedAt: 'x' },
    goal: 'g',
    runners: ['claude-code'],
  }));
  const plan = { status: 'draft', tasks: [] } as unknown as LegacyPlanState;
  const d = {
    session: { isExecuting: true, status: 'running' },
    chatProvider: { view, run, showPlan: vi.fn(), clearIsolationHandoff: () => run.clearIsolation() },
    getCurrentPlan: () => plan,
    isGeneratingPlan: () => false,
  } as unknown as PlanManagerDeps;
  return { d, posted, run };
}

const last = (posted: RunView[]): RunView => posted.at(-1)!;

describe('worktree isolation folds onto the run view (ADR-0013)', () => {
  it('puts each task\'s isolation on the run, and leaves a shared-root task quiet', () => {
    const { d, posted } = deps();
    const conflict: TaskIsolation = { state: 'conflict', branch: 'ordewell/r/1-a', worktree: '/w/1-a', repos: [], conflictRepo: '.' };

    handleSessionMessage({
      type: 'status_update',
      tasks: [
        { id: 't1', status: 'awaiting_user', verdict: null, isolation: conflict },
        { id: 'o2', status: 'in_progress', verdict: null },
      ],
    }, d);

    expect(last(posted).tasks.map((t) => [t.id, t.isolation])).toEqual([['t1', conflict], ['o2', undefined]]);
  });

  it('holds the end-of-run handoff as sent', () => {
    const { d, posted } = deps();
    const landed = [{ taskId: 't1', order: 1, title: 'A' }];
    const handoff = { repos: [{ path: '.', integrationBranch: 'ordewell/r/integration', baseRef: 'abc123', landed }], landed };

    handleSessionMessage({ type: 'isolation_handoff', ...handoff }, d);

    expect(last(posted).handoff).toEqual(handoff);
  });

  it('passes the supervisor deferral on, and replaces it with the unmarked handoff that follows', () => {
    const { d, posted } = deps();
    const landed = [{ taskId: 't1', order: 1, title: 'A' }];
    const handoff = { repos: [{ path: '.', integrationBranch: 'ordewell/r/integration', baseRef: 'abc123', landed }], landed };

    handleSessionMessage({ type: 'isolation_handoff', ...handoff, deferredTo: 'supervisor' }, d);
    expect(last(posted).handoff).toEqual({ ...handoff, deferredTo: 'supervisor' });

    handleSessionMessage({ type: 'isolation_handoff', ...handoff }, d);
    expect(last(posted).handoff).toEqual(handoff);
  });

  it('holds a repo group handoff with each repo its own work', () => {
    const { d, posted } = deps();
    const apiLanded = [{ taskId: 't1', order: 1, title: 'A' }];
    const webLanded = [{ taskId: 't2', order: 2, title: 'B' }];
    const handoff = {
      repos: [
        { path: 'api', integrationBranch: 'ordewell/r/integration', baseRef: 'aaa111', landed: apiLanded },
        { path: 'web', integrationBranch: 'ordewell/r/integration', baseRef: 'bbb222', landed: webLanded },
      ],
      landed: [...apiLanded, ...webLanded],
    };

    handleSessionMessage({ type: 'isolation_handoff', ...handoff }, d);

    expect(last(posted).handoff).toEqual(handoff);
  });

  it('holds a blocked Merge all result with every repo it names', () => {
    const { d, posted } = deps();
    const result = {
      outcome: 'blocked' as const,
      blocked: [
        { repo: 'api', reason: 'conflict' as const, files: ['src/a.ts'] },
        { repo: 'web', reason: 'uncommitted-changes' as const, files: ['src/b.ts'] },
      ],
    };

    handleSessionMessage({ type: 'isolation_merge', result }, d);

    expect(last(posted).mergeResult).toEqual(result);
  });

  // Core clears a fully merged run up and forgets it: the card and every mark
  // would otherwise offer a merge of branches that no longer exist.
  it('puts each task\'s merge gate on the run, and what Merge all would merge (ADR-0020)', () => {
    const { d, posted } = deps();
    const runMerge = { waitingAtGate: true, paused: true, repos: [], landed: [{ taskId: 't1', order: 1, title: 'A' }] };

    handleSessionMessage({
      type: 'status_update',
      tasks: [{ id: 't1', status: 'completed', verdict: null }, { id: 'o2', status: 'pending', verdict: null, mergeGate: ['t1'] }],
      runMerge,
    }, d);

    expect(last(posted).runMerge).toEqual(runMerge);
    expect(last(posted).tasks.find((t) => t.id === 'o2')!.mergeGate).toEqual(['t1']);
  });

  it('keeps the per-task marks after a Merge all mid-run, whose run goes on', () => {
    const { d, posted } = deps();
    handleSessionMessage({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null, isolation: { state: 'conflict', branch: 'b', worktree: 'w', repos: [] } }] }, d);

    handleSessionMessage({ type: 'isolation_merge', result: { outcome: 'merged' } }, d);

    expect(last(posted).mergeResult).toEqual({ outcome: 'merged' });
    expect(last(posted).tasks.find((t) => t.id === 't1')!.isolation?.state).toBe('conflict');
  });

  it('keeps the handoff card of a run the merge left open, for the Session to close in its own words', () => {
    const { d, posted } = deps();
    handleSessionMessage({ type: 'isolation_handoff', repos: [], landed: [] }, d);
    handleSessionMessage({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null, isolation: { state: 'conflict', branch: 'b', worktree: 'w', repos: [] } }] }, d);

    handleSessionMessage({ type: 'isolation_merge', result: { outcome: 'merged' } }, d);

    expect(last(posted).tasks.find((t) => t.id === 't1')!.isolation).toBeDefined();
  });

  it('drops the handoff card and the marks once the Session says the run is closed', () => {
    const { d, posted } = deps();
    handleSessionMessage({ type: 'isolation_handoff', repos: [], landed: [] }, d);
    handleSessionMessage({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null, isolation: { state: 'conflict', branch: 'b', worktree: 'w', repos: [] } }] }, d);

    handleSessionMessage({ type: 'isolation_merge', result: { outcome: 'merged' } }, d);
    handleSessionMessage({ type: 'run_closed' }, d);

    expect(last(posted).mergeResult).toBeNull();
    expect(last(posted).handoff).toBeNull();
    expect(last(posted).tasks.find((t) => t.id === 't1')!.isolation).toBeUndefined();
  });

  it('drops a handoff card deferred to the supervisor when the supervisor merges the run', () => {
    const { d, posted } = deps();
    const landed = [{ taskId: 't1', order: 1, title: 'A' }];
    handleSessionMessage({ type: 'isolation_handoff', repos: [{ path: '.', integrationBranch: 'i', baseRef: 'abc', landed }], landed, deferredTo: 'supervisor' }, d);

    handleSessionMessage({ type: 'isolation_merge', result: { outcome: 'merged' } }, d);
    handleSessionMessage({ type: 'run_closed' }, d);

    expect(last(posted).handoff).toBeNull();
  });
});
