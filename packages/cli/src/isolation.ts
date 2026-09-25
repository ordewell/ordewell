import { describeMergeResult, type IsolationMergeResult } from '@ordewell/core';
import type { HandoffRepoView, HandoffView, LandedTaskView, TaskIsolationView } from './tui/state';

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
  workspace?: unknown;
  /** ADR-0013 records named the one worktree here. */
  worktree?: unknown;
  status?: unknown;
  repos?: Record<string, { changed?: unknown }>;
  conflictRepo?: unknown;
}

type RepoFields = Omit<HandoffRepoView, 'landed'>;

/**
 * The run's repos. A run in the ADR-0013 shape — its one repository's refs on
 * the run itself — comes from a daemon older than this CLI and reads as a
 * group of one.
 */
function reposOf(run: Record<string, unknown>): RepoFields[] | null {
  if (Array.isArray(run.repos)) {
    const repos = (run.repos as Array<Record<string, unknown>>).filter((r) => (
      r && typeof r.path === 'string' && typeof r.integrationBranch === 'string' && typeof r.baseRef === 'string'
    ));
    return repos.length > 0
      ? repos.map((r) => ({ path: String(r.path), integrationBranch: String(r.integrationBranch), baseRef: String(r.baseRef) }))
      : null;
  }
  if (typeof run.integrationBranch === 'string' && typeof run.baseRef === 'string') {
    return [{ path: '.', integrationBranch: run.integrationBranch, baseRef: run.baseRef }];
  }
  return null;
}

function changedRepos(record: RunRecord, legacy: boolean, state: TaskIsolationView['state']): string[] {
  if (legacy) return state === 'integrated' ? ['.'] : [];
  return Object.entries(record.repos ?? {}).filter(([, r]) => r?.changed === true).map(([path]) => path);
}

export function isolationOfPlan(plan: unknown): PlanIsolationView | null {
  const run = (plan as { isolation?: { run?: Record<string, unknown> } } | null)?.isolation?.run;
  const repos = run ? reposOf(run) : null;
  if (!run || !repos) return null;
  const legacy = !Array.isArray(run.repos);

  const records = Object.entries((run.tasks ?? {}) as Record<string, RunRecord>);
  const tasks: Record<string, TaskIsolationView> = {};
  const landed: Array<LandedTaskView & { changed: string[] }> = [];
  for (const [taskId, record] of records) {
    const state = STATE_OF[String(record.status)];
    if (!state) continue;
    const changed = changedRepos(record, legacy, state);
    tasks[taskId] = {
      state,
      branch: String(record.branch ?? ''),
      worktree: String(record.workspace ?? record.worktree ?? ''),
      repos: changed,
      ...(typeof record.conflictRepo === 'string' ? { conflictRepo: record.conflictRepo } : legacy && state === 'conflict' ? { conflictRepo: '.' } : {}),
    };
    if (state === 'integrated') {
      landed.push({ taskId, order: Number(record.order ?? 0), title: String(record.title ?? taskId), changed });
    }
  }
  landed.sort((a, b) => a.order - b.order);
  const entry = ({ taskId, order, title }: LandedTaskView): LandedTaskView => ({ taskId, order, title });
  return {
    handoff: {
      repos: repos.map((repo) => ({ ...repo, landed: landed.filter((t) => t.changed.includes(repo.path)).map(entry) })),
      landed: landed.map(entry),
    },
    tasks,
  };
}

/** The run's integration branch as one line names it: every repo's has the same name. */
export function handoffBranch(handoff: HandoffView): string {
  return [...new Set(handoff.repos.map((r) => r.integrationBranch))].join(', ');
}

/** Where the run forked, as one line names it, each ref cut to `length` and, for a group, headed by its repo. */
export function handoffBase(handoff: HandoffView, length: number): string {
  const group = isRepoGroup(handoff);
  return handoff.repos.map((r) => `${group ? `${r.path} ` : ''}${r.baseRef.slice(0, length)}`).join(', ');
}

/**
 * Whether the run spans more than a lone repo at the workspace root. A group of
 * one at `.` is worded and drawn exactly as it was before repo groups; anything
 * else names its repos.
 */
export function isRepoGroup(handoff: HandoffView): boolean {
  return handoff.repos.some((r) => r.path !== '.');
}

/** The repos Merge all will merge: those with work on their integration branch, else all of them. */
export function reposWithWork(handoff: HandoffView): string[] {
  const withWork = handoff.repos.filter((r) => r.landed.length > 0);
  return (withWork.length > 0 ? withWork : handoff.repos).map((r) => r.path);
}

/** One line per repo: what landed on its integration branch, or that there is nothing to merge. */
export function repoResultLines(handoff: HandoffView): string[] {
  return handoff.repos.map(({ path, landed }) => {
    const n = landed.length;
    return `${path}: ${n === 0 ? 'nothing to merge' : `${n} task${n === 1 ? '' : 's'} landed`}`;
  });
}

/** The repos a task changed, for a row that names them; none for a group of one. */
export function taskRepoNames(isolation: TaskIsolationView | undefined): string[] {
  return (isolation?.repos ?? []).filter((r) => r !== '.');
}

/**
 * What "Merge all" did, in words. A group of one reads as it did before repo
 * groups; a group takes the shared wording and, when nothing or not everything
 * merged, is told the integration branches are plain branches to merge by hand.
 */
export function mergeOutcome(result: IsolationMergeResult, branch: string, group: boolean): { ok: boolean; message: string } {
  const ok = result.outcome === 'merged';
  if (!group && result.outcome === 'conflict') {
    return { ok, message: `Merging ${branch} conflicted, so it was aborted — your tree is as it was. Merge it with git and resolve the conflict there.` };
  }
  const { message } = describeMergeResult(result, branch, group);
  return { ok, message: ok || !group ? message : `${message} Each repository's ${branch} is a plain branch you can merge by hand.` };
}
