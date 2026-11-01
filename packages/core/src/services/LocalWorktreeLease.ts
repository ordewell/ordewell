import type { IsolationRunController } from './IsolationRunController';
import { GUARANTEES, refuseUnproven, type ExecutionBackend, type GuaranteeReport, type LeaseRecord, type LeaseRepo, type LeaseRequest, type LeaseResult, type LeaseSessionState, type LeaseSpec, type OpenLease, type ReservedLease } from './executionLease';
import type { PoolNode, SlotPool } from './SlotPool';

export interface LocalWorktreeLeaseDeps {
  pool: SlotPool;
  /** This Session, as its pool hears it. */
  node: PoolNode;
  runs: Pick<IsolationRunController, 'attemptCwd' | 'workspaceCwd' | 'release' | 'current'>;
  workspaceRoot: () => string;
}

const REACHES_WHAT_THE_USER_REACHES = 'nothing separates it: a local runner reaches what the user reaches';

/**
 * The default backend (ADR-0059 L4): today's code behind the seam, with no
 * setup and no change in behaviour. `reserve` is the Parallel limit, read from
 * the tree's pool, `open` is the attempt's cwd, and `list` reads the session's
 * records. {@link IWorktreeIsolation} stays beneath it, and a runner is still
 * handed a cwd and nothing more (ADR-0013).
 */
export class LocalWorktreeLease implements ExecutionBackend {
  private leases = 0;

  constructor(private readonly deps: LocalWorktreeLeaseDeps) {}

  /** A probe has nothing to run here (L3): no boundary stands between a local runner and the user's machine, so none is reported. */
  async probe(): Promise<GuaranteeReport> {
    return this.report();
  }

  private report(): GuaranteeReport {
    const at = new Date().toISOString();
    return Object.fromEntries(GUARANTEES.map((guarantee) => [guarantee, { proven: false, by: REACHES_WHAT_THE_USER_REACHES, at }])) as GuaranteeReport;
  }

  refusal(request: LeaseRequest): string | null {
    return this.deps.pool.refusal(this.deps.node, slotOf(request));
  }

  reserve(request: LeaseRequest): { lease: ReservedLease } | { refused: string } {
    const taken = this.deps.pool.take(this.deps.node, slotOf(request));
    if ('refused' in taken) return taken;
    return {
      lease: {
        id: `${request.node.sessionId}-${++this.leases}`,
        holdsSlot: taken.holdsSlot,
        open: (spec, signal) => this.open(spec, signal),
        release: () => taken.free(),
      },
    };
  }

  private async open(spec: LeaseSpec, signal: AbortSignal): Promise<OpenLease> {
    const guarantees = this.report();
    refuseUnproven(spec.required, guarantees);
    // Ended since its claim, by a Stop or a cancel: there is no workspace to make, so none is left to undo.
    if (signal.aborted) throw new Error('The lease was given up before it opened.');
    const { cwd, worktree, workspace, previousWork } = await this.workspace(spec);
    const repos = worktree ? this.repos(spec) : [];
    return {
      workspace: { cwd, worktree, ...(workspace ? { writable: workspace } : {}), ...(previousWork ? { previousWork } : {}), ...(repos.length ? { repos } : {}) },
      guarantees,
      exportResult: (session) => this.result(spec, session),
    };
  }

  private workspace({ task, workspace }: LeaseSpec): ReturnType<IsolationRunController['attemptCwd']> {
    if (!task) return Promise.resolve({ cwd: this.deps.workspaceRoot(), worktree: false });
    return workspace.kind === 'worktree' ? this.deps.runs.attemptCwd(task, workspace.intent) : this.deps.runs.workspaceCwd(task);
  }

  private repos({ task }: LeaseSpec): LeaseRepo[] {
    const run = this.deps.runs.current;
    const record = task && run?.tasks[task.id];
    if (!run || !record) return [];
    return run.repos.flatMap((repo) => {
      const entry = record.repos[repo.path];
      return entry ? [{ path: repo.path, root: repo.root, worktree: entry.worktree, branch: record.branch, integrationBranch: repo.integrationBranch, linked: entry.linked }] : [];
    });
  }

  /** The run's record says where the work is; the runner's session stays where the runner keeps it, on this machine (L2). */
  private result({ task }: LeaseSpec, session: LeaseSessionState): LeaseResult {
    const record = task && this.deps.runs.current?.tasks[task.id];
    return { refs: record ? Object.fromEntries(Object.keys(record.repos).map((repo) => [repo, record.branch])) : {}, sessionState: session };
  }

  letGo(taskId: string, { keep, landing }: { keep: boolean; landing?: Promise<unknown> | null; reason: string }): Promise<void> {
    return this.deps.runs.release(taskId, { keep }, landing);
  }

  async list(): Promise<readonly LeaseRecord[]> {
    return Object.values(this.deps.runs.current?.tasks ?? {}).map((record) => ({
      taskId: record.taskId,
      status: record.status,
      worktrees: Object.values(record.repos).map((repo) => repo.worktree),
    }));
  }
}

function slotOf({ role, node }: LeaseRequest): { role: LeaseRequest['role']; taskId?: string } {
  return { role, ...(node.taskId !== undefined ? { taskId: node.taskId } : {}) };
}
