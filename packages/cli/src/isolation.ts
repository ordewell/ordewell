import type { HandoffView, TaskIsolationView } from './tui/state';

/**
 * What a saved plan says about its isolated run, in the shape the surfaces show.
 * The daemon persists the run record with the plan (`LegacyPlanState.isolation`),
 * so a reloaded session can offer its handoff and mark its conflicts without a
 * live stream having told it. `null` when the payload carries no record — a
 * planner reply, or a plan that never isolated — which says nothing either way.
 */
export interface PlanIsolationView {
  handoff: HandoffView;
  tasks: Record<string, TaskIsolationView>;
}

const STATE_OF: Record<string, TaskIsolationView['state']> = {
  active: 'active',
  merged: 'integrated',
  conflict: 'conflict',
  // A failed integration keeps its refs exactly as a failed verdict does; the
  // user sees one thing: work that did not land and can be looked at.
  kept: 'kept',
  failed: 'kept',
};

interface RunRecord {
  taskId?: unknown;
  order?: unknown;
  title?: unknown;
  branch?: unknown;
  worktree?: unknown;
  status?: unknown;
}

export function isolationOfPlan(plan: unknown): PlanIsolationView | null {
  const run = (plan as { isolation?: { run?: Record<string, unknown> } } | null)?.isolation?.run;
  if (!run || typeof run.integrationBranch !== 'string' || typeof run.baseRef !== 'string') return null;

  const records = Object.entries((run.tasks ?? {}) as Record<string, RunRecord>);
  const tasks: Record<string, TaskIsolationView> = {};
  const landed: HandoffView['landed'] = [];
  for (const [taskId, record] of records) {
    const state = STATE_OF[String(record.status)];
    if (!state) continue;
    tasks[taskId] = { state, branch: String(record.branch ?? ''), worktree: String(record.worktree ?? '') };
    if (state === 'integrated') {
      landed.push({ taskId, order: Number(record.order ?? 0), title: String(record.title ?? taskId) });
    }
  }
  landed.sort((a, b) => a.order - b.order);
  return { handoff: { branch: run.integrationBranch, baseRef: run.baseRef, landed }, tasks };
}
