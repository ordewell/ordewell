import * as path from 'path';
import type {
  IsolationHandoff,
  IsolationLandedTask,
  IsolationRemoval,
  IsolationRepo,
  IsolationRun,
  IsolationTaskRecord,
  IsolationTaskStatus,
  IsolationView,
  PlanIsolation,
  PreservedWork,
  RepoGroupLayout,
  TaskIsolation,
} from '../interfaces/IWorktreeIsolation';
import { SELF_REPO } from './repoPath';

export { SELF_REPO };

export function integrationBranchFor(runId: string): string {
  return `ordewell/${runId}/integration`;
}

export function repoRootOf(workspaceRoot: string, repoPath: string): string {
  return path.join(workspaceRoot, repoPath);
}

/** A removal that kept nothing back. */
export function noRemoval(): IsolationRemoval {
  return { preserved: [], refused: [] };
}

/**
 * A `prepare` that failed after it had already replaced the last attempt of
 * the task: that attempt's unlanded work was kept on `preserved` first, and no
 * record names it any more, so whoever tells the user about the failure has to
 * tell them where it went. Reads as the failure it wraps.
 */
export class PrepareFailedError extends Error {
  constructor(readonly failure: unknown, readonly preserved: PreservedWork[]) {
    super(failure instanceof Error ? failure.message : String(failure));
    this.name = failure instanceof Error ? failure.name : 'Error';
    this.cause = failure;
  }
}

/** Add what `from` kept back to `into`. */
export function absorbRemoval(into: IsolationRemoval, from: IsolationRemoval): IsolationRemoval {
  into.preserved.push(...from.preserved);
  into.refused.push(...from.refused);
  return into;
}

/** The group a run isolates, as the planner is told it. */
export function layoutOf(run: IsolationRun): RepoGroupLayout {
  return { repos: run.repos.map((r) => r.path), shared: [...run.shared] };
}

const ISOLATION_STATE: Record<IsolationTaskStatus, Exclude<TaskIsolation['state'], 'none'>> = {
  active: 'active',
  merged: 'integrated',
  conflict: 'conflict',
  repairing: 'repairing',
  kept: 'kept',
  failed: 'kept',
};

/** Whether a saved record's status is one this build knows; a newer daemon may have written one it does not. */
const isKnownStatus = (status: string): status is IsolationTaskStatus =>
  Object.prototype.hasOwnProperty.call(ISOLATION_STATE, status);

/** Paths of the repos a task brought commits to. */
export function changedReposOf(record: IsolationTaskRecord): string[] {
  return Object.entries(record.repos).filter(([, r]) => r.changed).map(([repoPath]) => repoPath);
}

/** Whether a landed task has work in a repo: a later attempt's record says nothing of the merges before it. */
export function landedInRepo(run: IsolationRun, record: IsolationTaskRecord, repoPath: string): boolean {
  return !!record.repos[repoPath]?.changed || run.landings?.[record.taskId]?.[repoPath] !== undefined;
}

/**
 * Landed work a revert can undo (ADR-0054): a merge of its own in every repo it
 * changed, none of it in the user's branch yet, and nothing of it carried in by
 * a resolver. `landings` are the task's merges in {@link IsolationRun.landings},
 * which a later attempt's record says nothing of: a task at work again keeps its
 * mark off, and a revert would refuse it. A run with no `carried` record, or
 * none given, offers nothing: every revert of such a run is refused.
 */
function revertible(record: IsolationTaskRecord, run?: Pick<IsolationRun, 'landings' | 'carried'>): boolean {
  if (record.inHead || record.status === 'active' || record.status === 'repairing' || !run?.carried || run.carried[record.taskId]) return false;
  const landings = run?.landings?.[record.taskId];
  const changed = record.status === 'merged' ? changedReposOf(record) : [];
  return (changed.length > 0 || landings !== undefined) && changed.every((repo) => record.repos[repo].landedTip || landings?.[repo]);
}

/**
 * `repairLimit` is `conflictRepairAttempts` as it stands now, which is what the
 * next repair will be held to. Without one — a saved plan never carries server
 * config — the repair attempt is left out and a live status update fills it in.
 */
export function taskIsolationOf(record: IsolationTaskRecord, repairLimit?: number, run?: Pick<IsolationRun, 'landings' | 'carried'>): TaskIsolation {
  return {
    state: ISOLATION_STATE[record.status],
    branch: record.branch,
    worktree: record.workspace,
    repos: changedReposOf(record),
    ...(record.conflictRepo ? { conflictRepo: record.conflictRepo } : {}),
    ...(record.conflictFiles?.length ? { conflictFiles: record.conflictFiles } : {}),
    ...(record.repairs && repairLimit !== undefined ? { repair: { attempt: record.repairs, limit: repairLimit } } : {}),
    ...(record.repairedFiles?.length ? { repairedFiles: record.repairedFiles } : {}),
    ...(revertible(record, run) ? { revertible: true as const } : {}),
  };
}

/**
 * Every task's mark in a run. A task with merges on the branch and no record
 * left, a retry having dropped it, has no state to show and can still be
 * reverted. A status this build does not know is its own mark-less task, not a
 * crash: a newer daemon may have written one.
 */
export function taskIsolationsOf(run: IsolationRun, repairLimit?: number): Record<string, TaskIsolation> {
  const tasks: Record<string, TaskIsolation> = {};
  for (const taskId of Object.keys(run.landings ?? {})) {
    if (run.carried && !run.carried[taskId]) tasks[taskId] = { state: 'none', revertible: true };
  }
  for (const [taskId, record] of Object.entries(run.tasks)) {
    if (isKnownStatus(record.status)) tasks[taskId] = taskIsolationOf(record, repairLimit, run);
  }
  return tasks;
}

/**
 * What a run hands over: each repo's integration branch and base, and what
 * landed, in plan order. Work the user has merged already, at a merge gate
 * (ADR-0020), is not handed over again.
 */
export function handoffOf(run: IsolationRun): IsolationHandoff {
  const merged = Object.values(run.tasks)
    .filter((r) => r.status === 'merged' && !r.inHead)
    .sort((a, b) => a.order - b.order);
  const entry = (r: IsolationTaskRecord): IsolationLandedTask => ({
    taskId: r.taskId, order: r.order, title: r.title,
    ...(r.repairedFiles?.length ? { repairedFiles: r.repairedFiles } : {}),
  });
  return {
    repos: run.repos.map((repo) => ({
      path: repo.path,
      integrationBranch: repo.integrationBranch,
      baseRef: repo.baseRef,
      ...(repo.baseBranch ? { baseBranch: repo.baseBranch } : {}),
      ...(repo.startedDetached ? { startedDetached: true as const } : {}),
      landed: merged.filter((r) => landedInRepo(run, r, repo.path)).map(entry),
    })),
    landed: merged.map(entry),
  };
}

/** A task record as ADR-0013 persisted it, for one repository. */
export interface Adr0013TaskRecord {
  taskId: string;
  order: number;
  title: string;
  branch: string;
  worktree: string;
  status: IsolationTaskStatus;
  linked: string[];
}

/** A run as ADR-0013 persisted it (0.4.23): one repository, its refs on the run itself. */
export interface Adr0013IsolationRun {
  id: string;
  workspaceRoot: string;
  baseRef: string;
  baseBranch?: string;
  integrationBranch: string;
  tasks: Record<string, Adr0013TaskRecord>;
}

export interface Adr0013PlanIsolation {
  run: Adr0013IsolationRun;
  resolvers: Record<string, string>;
}

function isAdr0013(run: IsolationRun | Adr0013IsolationRun): run is Adr0013IsolationRun {
  return 'integrationBranch' in run && typeof run.integrationBranch === 'string';
}

function fromAdr0013Task(r: Adr0013TaskRecord): IsolationTaskRecord {
  return {
    taskId: r.taskId,
    order: r.order,
    title: r.title,
    branch: r.branch,
    workspace: r.worktree,
    status: r.status,
    // A merged task's branch was merged into the one repo there was; what it
    // changed was never recorded, and landing is what `changed` stands for.
    repos: { [SELF_REPO]: { worktree: r.worktree, linked: r.linked ?? [], ...(r.status === 'merged' ? { changed: true } : {}) } },
    ...(r.status === 'conflict' ? { conflictRepo: SELF_REPO } : {}),
  };
}

/**
 * A persisted plan isolation in today's shape. A run saved in the ADR-0013
 * format — recognised by its own `integrationBranch` — becomes a group of one
 * at `.`, keeping its branches, so a session saved by 0.4.23 resumes and hands
 * off exactly as it would have.
 */
export function migratePlanIsolation(state: PlanIsolation | Adr0013PlanIsolation): PlanIsolation {
  const { run, resolvers } = state;
  if (!isAdr0013(run)) return { run, resolvers: resolvers ?? {} };
  const repo: IsolationRepo = {
    path: SELF_REPO,
    root: repoRootOf(run.workspaceRoot, SELF_REPO),
    baseRef: run.baseRef,
    ...(run.baseBranch ? { baseBranch: run.baseBranch } : {}),
    integrationBranch: run.integrationBranch,
  };
  const tasks = Object.fromEntries(Object.entries(run.tasks ?? {}).map(([id, r]) => [id, fromAdr0013Task(r)]));
  return { run: { id: run.id, workspaceRoot: run.workspaceRoot, repos: [repo], shared: [], sharedRepos: [], tasks }, resolvers: resolvers ?? {} };
}

/** Bring a loaded plan's isolation record, if any, to today's shape in place. */
export function migratePlanStateIsolation(plan: { isolation?: PlanIsolation | Adr0013PlanIsolation }): void {
  if (plan.isolation?.run) plan.isolation = migratePlanIsolation(plan.isolation);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/**
 * Whether a payload carries a run this module can read. The check tells today's
 * record from an ADR-0013 one and stops at the fields both shapes need; the
 * record's own fields are trusted from there, as `stateStore` trusts the JSON it
 * loaded. An older daemon still sends the ADR-0013 shape, so the migration runs
 * on the way in rather than being assumed.
 */
function carriesIsolation(plan: unknown): plan is { isolation: PlanIsolation | Adr0013PlanIsolation } {
  if (!isRecord(plan) || !isRecord(plan.isolation)) return false;
  const { run } = plan.isolation;
  if (!isRecord(run) || !isRecord(run.tasks)) return false;
  if (isArray(run.repos)) {
    return run.repos.some((repo) => isRecord(repo)
      && typeof repo.path === 'string'
      && typeof repo.integrationBranch === 'string'
      && typeof repo.baseRef === 'string');
  }
  return typeof run.integrationBranch === 'string' && typeof run.baseRef === 'string';
}

/**
 * What a persisted plan says about its isolated run, as a surface shows it: the
 * handoff and each task's mark. `null` when the payload carries no record — a
 * planner reply, or a plan that never isolated — which says nothing either way.
 *
 * This is the one reading of a saved record outside the daemon: the migration
 * from the ADR-0013 shape happens here, so no surface grows its own parser.
 * `repairLimit` is server config a saved plan never carries; without it the
 * repair attempt is left for a live status update to fill in.
 */
export function isolationViewOfPlan(plan: unknown, repairLimit?: number): IsolationView | null {
  if (!carriesIsolation(plan)) return null;
  const { run } = migratePlanIsolation(plan.isolation);
  return { tasks: taskIsolationsOf(run, repairLimit), handoff: handoffOf(run) };
}
