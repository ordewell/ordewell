import type { Task, Verdict } from '../models/Task';
import type { IConfig } from '../interfaces/IConfig';
import type { IsolationOutcome, IsolationRun, RepairEvidence } from '../interfaces/IWorktreeIsolation';
import type { PlanStore } from './PlanStore';
import type { IsolationRunController } from './IsolationRunController';
import { changedReposOf, integrationBranchNameOf, SELF_REPO } from './isolationRecord';
import { capConflictFiles } from './conflictFiles';
import { buildConflictRepairPrompt, buildConflictResolutionPrompt } from './PlanPrompts';

/** Which repair of a task an attempt is, of the most `conflictRepairAttempts` allows. */
export interface RepairAttempt {
  n: number;
  limit: number;
}

/** One thing the user is told about a landing. */
export interface LandingMessage {
  level: 'info' | 'warn' | 'error';
  text: string;
  /** Also handed to a surface that shows no toasts: ADR-0015 logs every conflict repair as a notice. */
  repairLog?: true;
}

/**
 * How a landing settled, for the orchestrator to apply — it marks the task,
 * starts the repair and says the messages. By the time one is returned the
 * merge has happened or not, and the run record says so.
 *
 * - `landed`: the work is on the integration branch of every repo it changed.
 * - `nothing-to-land`: the attempt ran in the workspace root, or the task
 *   holds no unlanded work; it is done as it stands.
 * - `repair-needed`: the landing conflicted and the task is owed `repair`
 *   (ADR-0015), in the worktree kept for it.
 * - `awaiting_user`: the work did not land and waits on the user, worktree
 *   kept — a conflict with no repair left (`conflict`), a merge git refused
 *   (`landing-failed`), or a repair that did not land (`repair-failed`). None
 *   of them halts the run.
 */
export type LandingOutcome =
  | { kind: 'landed'; messages: LandingMessage[] }
  | { kind: 'nothing-to-land'; messages: LandingMessage[] }
  | { kind: 'repair-needed'; repair: RepairAttempt; messages: LandingMessage[] }
  | { kind: 'awaiting_user'; reason: 'conflict' | 'landing-failed' | 'repair-failed'; messages: LandingMessage[] };

export type UnlandedOutcome = Extract<LandingOutcome, { kind: 'repair-needed' | 'awaiting_user' }>;

/** The task is done as it stands: its work landed, or it had none to land. */
export function completesTask(outcome: LandingOutcome): outcome is Extract<LandingOutcome, { kind: 'landed' | 'nothing-to-land' }> {
  return outcome.kind === 'landed' || outcome.kind === 'nothing-to-land';
}

export interface LandingDeps {
  runs: IsolationRunController;
  config: Pick<IConfig, 'conflictRepairAttempts'>;
  /** Read-only: only the orchestrator changes a task. */
  tasks: Pick<PlanStore, 'get'>;
}

const NOTHING_TO_LAND: LandingOutcome = { kind: 'nothing-to-land', messages: [] };

/**
 * Landing and Conflict repair (ADR-0013, ADR-0014, ADR-0015): a passed
 * attempt's work onto the run's integration branches through the
 * {@link IsolationRunController}, and what a landing that did not go through
 * leads to. It answers with a {@link LandingOutcome} rather than acting on it —
 * it never marks a task, starts an attempt or emits — so the scheduler stays
 * the one place that decides what runs. A repair is spent when it starts: the
 * controller's `reopen` counts it before the runner spawns, and nothing here
 * hands one back.
 */
export class Landing {
  private readonly runs: IsolationRunController;
  private readonly config: Pick<IConfig, 'conflictRepairAttempts'>;
  private readonly tasks: Pick<PlanStore, 'get'>;

  constructor(deps: LandingDeps) {
    this.runs = deps.runs;
    this.config = deps.config;
    this.tasks = deps.tasks;
  }

  /**
   * Land a passed attempt's work. One whose worktree has no unlanded record
   * behind it any more — the run was discarded under it — cannot land.
   */
  async landPassed(task: Task, attempt: { worktree: boolean }): Promise<LandingOutcome> {
    if (!attempt.worktree) return NOTHING_TO_LAND;
    if (!this.hasUnlandedWork(task.id)) return this.unmerged(task, 'failed');
    const landing = await this.runs.integrate(task);
    return landing === 'merged' ? { kind: 'landed', messages: [] } : this.unmerged(task, landing);
  }

  /** Mark complete is a passed verdict the user vouches for: what the task holds unlanded lands the same way. */
  async landVouched(task: Task): Promise<LandingOutcome> {
    if (!this.hasUnlandedWork(task.id)) return NOTHING_TO_LAND;
    const landing = await this.runs.integrate(task);
    return landing === 'merged' ? { kind: 'landed', messages: [] } : this.unmerged(task, landing);
  }

  /**
   * A repair's verdict decides only whether its work may try to land; the
   * task keeps the verdict its own work earned. Evidence comes before the
   * queue, and the landing after it is the one every task goes through, so a
   * repair the tip has moved past again is a fresh conflict, not a pass.
   */
  async settleRepair(task: Task, verdict: Verdict): Promise<LandingOutcome> {
    if (verdict.outcome !== 'pass') return this.unrepaired(task, `did not finish (${verdict.reason})`);
    const evidence = await this.runs.verifyRepair(task);
    if (!evidence.ok) return this.unrepaired(task, this.describeEvidence(evidence));
    const landing = await this.runs.integrate(task);
    if (landing !== 'merged') return this.unmerged(task, landing);
    const files = this.runs.current?.tasks[task.id]?.repairedFiles ?? [];
    return {
      kind: 'landed',
      messages: [{ level: 'info', text: `Task "${task.title}" landed after repairing a conflict${files.length > 0 ? ` in ${capConflictFiles(files)}` : ''}.`, repairLog: true }],
    };
  }

  /** A repair that ended without landing leaves the task as its conflict did: waiting on the user, worktree and refs kept. */
  async unrepaired(task: Task, why: string): Promise<Extract<LandingOutcome, { kind: 'awaiting_user' }>> {
    await this.runs.release(task.id, { keep: true });
    return {
      kind: 'awaiting_user',
      reason: 'repair-failed',
      messages: [{
        level: 'warn',
        text: `The conflict repair of task "${task.title}" ${why}, so it did not land. Its ${this.isGroup() ? 'worktrees are' : 'worktree is'} kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.`,
        repairLog: true,
      }],
    };
  }

  /**
   * Land the conflicted task a resolver was added for, now that the resolver
   * has landed. Its branch is on the integration branch by then, so it merges
   * clean — and one the resolver did not really bring along conflicts again
   * instead of being taken at its word. Null when there is nothing to land.
   */
  async landResolved(resolverId: string): Promise<{ task: Readonly<Task>; outcome: LandingOutcome } | null> {
    const conflictedId = this.runs.takeResolver(resolverId);
    if (!conflictedId) return null;
    const task = this.tasks.get(conflictedId);
    // Only the conflict it was added for: a task retried since has a new
    // attempt of its own, whose worktree it would merge half-done.
    if (!task || this.runs.current?.tasks[conflictedId]?.status !== 'conflict') return null;
    const landing = await this.runs.integrate(task);
    if (landing !== 'merged') return { task, outcome: this.unmerged(task, landing) };
    return { task, outcome: { kind: 'landed', messages: [{ level: 'info', text: `Task "${task.title}" landed through its conflict resolution.` }] } };
  }

  /** The repair a conflicted task is owed next; null when repair is off, used up, or there is no isolated run to repair it in. */
  nextRepair(taskId: string): RepairAttempt | null {
    const record = this.runs.openRecord(taskId);
    const limit = this.config.conflictRepairAttempts;
    const spent = record?.repairs ?? 0;
    return record?.status === 'conflict' && spent < limit ? { n: spent + 1, limit } : null;
  }

  /** What a repair is asked to do; read once `reopen` has recorded the tips it must bring in. */
  repairPrompt(task: Task): string {
    const run = this.runs.requireRun();
    const record = run.tasks[task.id];
    const conflict = {
      branch: record?.branch ?? '',
      repos: Object.keys(record?.repairBase ?? {}),
      ...(record?.conflictRepo ? { conflictRepo: record.conflictRepo } : {}),
      ...(record?.conflictFiles ? { conflictFiles: record.conflictFiles } : {}),
    };
    return buildConflictRepairPrompt(task, conflict, integrationBranchNameOf(run));
  }

  private hasUnlandedWork(taskId: string): boolean {
    const record = this.runs.current?.tasks[taskId];
    return !!record && record.status !== 'merged';
  }

  private unmerged(task: Readonly<Task>, landing: Exclude<IsolationOutcome, 'merged'>): UnlandedOutcome {
    const run = this.runs.current;
    const branch = run ? integrationBranchNameOf(run) : 'the integration branch';
    const record = run?.tasks[task.id];
    // Named only where there is a repo to name: a group of one reads as it always has.
    const inRepo = record?.conflictRepo && record.conflictRepo !== SELF_REPO ? record.conflictRepo : null;
    if (landing === 'conflict') {
      const files = record?.conflictFiles?.length ? ` (${capConflictFiles(record.conflictFiles)})` : '';
      const conflicted = inRepo
        ? `Task "${task.title}" passed, but landing it on ${branch} conflicted in ${inRepo}${files}, so none of it landed.`
        : `Task "${task.title}" passed, but merging it into ${branch} conflicted${files}.`;
      // Never resolved here: the first answer is a bounded repair by the task
      // itself, on a new attempt in its own worktree (ADR-0015); until one
      // lands, the task's dependents wait on it.
      const repair = this.nextRepair(task.id);
      if (repair) return { kind: 'repair-needed', repair, messages: [{ level: 'warn', text: conflicted }] };
      const whyNot = this.noRepairReason(task);
      return {
        kind: 'awaiting_user',
        reason: 'conflict',
        messages: [
          { level: 'warn', text: `${conflicted} ${inRepo ? 'Its worktrees are' : 'Its worktree is'} kept — resolve it by hand and mark it complete, retry it, or resolve it as a task.` },
          ...(whyNot ? [{ level: 'info' as const, text: whyNot, repairLog: true as const }] : []),
        ],
      };
    }
    // The verdict passed; only the landing did not. A red X would contradict
    // the runner's own report, and failing would halt the run over work that is
    // finished and kept, so it waits on the user as a conflict does
    // (ADR-0013).
    const why = record?.landingError ? ` (${record.landingError})` : '';
    return {
      kind: 'awaiting_user',
      reason: 'landing-failed',
      messages: [{
        level: 'error',
        text: inRepo
          ? `Task "${task.title}" passed, but git could not integrate its work in ${inRepo}${why}, so none of it landed. Its worktrees are kept for inspection.`
          : `Task "${task.title}" passed, but git could not integrate its work${why}. Its worktree is kept for inspection.`,
      }],
    };
  }

  private noRepairReason(task: Readonly<Task>): string | null {
    const limit = this.config.conflictRepairAttempts;
    if (limit === 0) return `Conflict repair is off (conflictRepairAttempts is 0), so task "${task.title}" waits for you.`;
    const spent = this.runs.current?.tasks[task.id]?.repairs ?? 0;
    return spent >= limit ? `Task "${task.title}" has had ${spent} of its ${limit} conflict repairs, so its conflict waits for you.` : null;
  }

  private describeEvidence(evidence: Exclude<RepairEvidence, { ok: true }>): string {
    const run = this.runs.current;
    const inRepo = evidence.repo !== SELF_REPO ? ` in ${evidence.repo}` : '';
    const branch = run ? integrationBranchNameOf(run) : 'the integration branch';
    switch (evidence.reason) {
      case 'not-merged': return `finished, but its branch${inRepo} does not contain ${branch}`;
      case 'conflict-markers': {
        const files = (evidence.files ?? []).map((file) => (evidence.repo !== SELF_REPO ? `${evidence.repo}/${file}` : file));
        return `finished, but left conflict markers in ${capConflictFiles(files)}`;
      }
      case 'failed': return `finished, but git could not check its work${inRepo}`;
    }
  }

  private isGroup(): boolean {
    return this.runs.current?.repos.some((r) => r.path !== SELF_REPO) ?? false;
  }
}

/**
 * The task `resolveConflictAsTask` adds for a conflicted one (ADR-0013): on
 * that task's runner, model and mode, it merges the conflicted branch by hand
 * in its own worktree, which starts at the integration tip. Null unless the
 * task's landing is in conflict. Linking the two, so the conflicted task lands
 * once the resolver has, stays with the caller.
 */
export function conflictResolverTask(task: Readonly<Task>, run: IsolationRun | null): Partial<Task> | null {
  const record = run?.tasks[task.id];
  if (!run || record?.status !== 'conflict') return null;
  const integrationBranch = integrationBranchNameOf(run);
  const conflict = {
    branch: record.branch,
    repos: changedReposOf(record),
    ...(record.conflictRepo ? { conflictRepo: record.conflictRepo } : {}),
  };
  return {
    title: `Resolve merge conflict: ${task.title}`,
    description: `Merge ${record.branch} into ${integrationBranch} by hand.`,
    type: 'ai',
    prompt: buildConflictResolutionPrompt(task, conflict, integrationBranch),
    assignedRunner: task.assignedRunner,
    assignedModel: task.assignedModel,
    thinkingEffort: task.thinkingEffort,
    taskMode: task.taskMode,
    autonomy: 'AFK',
    sliceType: 'AFK',
    dependencies: [],
  };
}
