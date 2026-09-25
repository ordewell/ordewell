import * as path from 'path';
import type {
  IsolationHandoff,
  IsolationLandedTask,
  IsolationRepo,
  IsolationRun,
  IsolationTaskRecord,
  IsolationTaskStatus,
  PlanIsolation,
  RepoGroupLayout,
  TaskIsolation,
} from '../interfaces/IWorktreeIsolation';

/** The path of the repo in a workspace that is itself the repository. */
export const SELF_REPO = '.';

export function integrationBranchFor(runId: string): string {
  return `ordewell/${runId}/integration`;
}

export function repoRootOf(workspaceRoot: string, repoPath: string): string {
  return path.join(workspaceRoot, repoPath);
}

/** The group a run isolates, as the planner is told it. */
export function layoutOf(run: IsolationRun): RepoGroupLayout {
  return { repos: run.repos.map((r) => r.path), shared: [...run.shared] };
}

/** The run's integration branch for a one-line notice: every repo's has the same name. */
export function integrationBranchNameOf(run: IsolationRun): string {
  return [...new Set(run.repos.map((r) => r.integrationBranch))].join(', ');
}

const ISOLATION_STATE: Record<IsolationTaskStatus, Exclude<TaskIsolation['state'], 'none'>> = {
  active: 'active',
  merged: 'integrated',
  conflict: 'conflict',
  kept: 'kept',
  failed: 'kept',
};

export function taskIsolationOf(record: IsolationTaskRecord): TaskIsolation {
  return {
    state: ISOLATION_STATE[record.status],
    branch: record.branch,
    worktree: record.workspace,
    repos: Object.entries(record.repos).filter(([, r]) => r.changed).map(([repoPath]) => repoPath),
    ...(record.conflictRepo ? { conflictRepo: record.conflictRepo } : {}),
  };
}

/** What a run hands over: each repo's integration branch and base, and what landed, in plan order. */
export function handoffOf(run: IsolationRun): IsolationHandoff {
  const merged = Object.values(run.tasks)
    .filter((r) => r.status === 'merged')
    .sort((a, b) => a.order - b.order);
  const entry = (r: IsolationTaskRecord): IsolationLandedTask => ({ taskId: r.taskId, order: r.order, title: r.title });
  return {
    repos: run.repos.map((repo) => ({
      path: repo.path,
      integrationBranch: repo.integrationBranch,
      baseRef: repo.baseRef,
      landed: merged.filter((r) => r.repos[repo.path]?.changed).map(entry),
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
