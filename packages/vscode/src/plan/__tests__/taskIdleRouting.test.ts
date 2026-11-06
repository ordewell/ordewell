import { describe, it, expect, vi } from 'vitest';
import { EMPTY_RUN, reduceRun, type LegacyPlanState, type RunView, type SerializedTask, type SessionMessage, type SerializedTaskStatus } from '@ordewell/core';
import { SessionView } from '@ordewell/ui/host';
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
function deps(): { d: PlanManagerDeps; posted: RunView[] } {
  const posted: RunView[] = [];
  const view = new SessionView((m) => { if (m.type === 'runView') posted.push(m.view); });
  const { run } = view;
  run.adopt(reduceRun(EMPTY_RUN, {
    type: 'plan_generated',
    plan: { tasks: [planned('t1', 1), planned('t2', 2)], runners: ['claude-code'], generatedAt: 'x' },
    goal: 'g',
    runners: ['claude-code'],
  }));
  const plan = { status: 'draft', tasks: [] } as unknown as LegacyPlanState;
  const d = {
    session: { isExecuting: true, status: 'running' },
    chatProvider: { view, run, showPlan: vi.fn() },
    getCurrentPlan: () => plan,
    isGeneratingPlan: () => false,
  } as unknown as PlanManagerDeps;
  return { d, posted };
}

const statusUpdate = (tasks: SerializedTaskStatus[]): SessionMessage => ({ type: 'status_update', tasks });

describe('status_update folds onto the run view', () => {
  it('puts each task\'s idleSince on the run', () => {
    const { d, posted } = deps();
    handleSessionMessage(statusUpdate([
      { id: 't1', status: 'in_progress', verdict: null, idleSince: '2026-08-18T00:00:00.000Z' },
      { id: 't2', status: 'in_progress', verdict: null, idleSince: null },
    ]), d);

    expect(posted.at(-1)!.tasks.map((t) => [t.id, t.idleSince])).toEqual([
      ['t1', '2026-08-18T00:00:00.000Z'],
      ['t2', null],
    ]);
  });

  it('treats a missing idleSince as cleared, not stuck', () => {
    const { d, posted } = deps();
    handleSessionMessage(statusUpdate([{ id: 't1', status: 'completed', verdict: null }]), d);

    expect(posted.at(-1)!.tasks.find((t) => t.id === 't1')!.idleSince).toBeUndefined();
  });

  it('puts how many runner requests each task waits on, the absent clearing the badge', () => {
    const { d, posted } = deps();
    handleSessionMessage(statusUpdate([
      { id: 't1', status: 'in_progress', verdict: null, awaitingApproval: 2 },
      { id: 't2', status: 'in_progress', verdict: null },
    ]), d);

    expect(posted.at(-1)!.tasks.map((t) => [t.id, t.awaitingApproval])).toEqual([['t1', 2], ['t2', undefined]]);
  });
});
