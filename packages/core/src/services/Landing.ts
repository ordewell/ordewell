import type { Task, Verdict } from '../models/Task';
import type { IConfig } from '../interfaces/IConfig';
import type { IsolationOutcome, RepairEvidence } from '../interfaces/IWorktreeIsolation';
import type { PlanStore } from './PlanStore';
import type { IsolationRunController } from './IsolationRunController';
import { SELF_REPO } from './isolationRecord';
import { capConflictFiles } from './conflictFiles';
import { buildConflictRepairPrompt, buildConflictResolutionPrompt } from './PlanPrompts';
import { landsNothing, type AttemptKind } from './attemptKind';
import type { HandoffCommit } from '../models/Handoff';
import { landingMessage } from './landingMessage';
import { underProtectedPath } from '../models/Delegation';
import { IDENTITY_FIX, lacksIdentity } from './gitIdentity';

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
 * - `nothing-to-land`: the attempt ran in the workspace root, the task
 *   holds no unlanded work, or it is read-only and lands nothing (ADR-0046);
 *   it is done as it stands.
 * - `repair-needed`: the landing conflicted and the task is owed `repair`
 *   (ADR-0015), in the worktree kept for it.
 * - `awaiting_user`: the work did not land and waits on the user, worktree
 *   kept — a conflict with no repair left (`conflict`), a merge git refused
 *   (`landing-failed`), or a repair that did not land (`repair-failed`). None
 *   of them fails the task, so none blocks its dependents.
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
  /** Read-only: only the orchestrator changes a task. `planTasks` labels a subtask by its dotted reference. */
  tasks: Pick<PlanStore, 'get' | 'planTasks'>;
  /** Whether a repair merge's message ends with the Planned-with trailer; read as the prompt is built. */
  plannedWith?: () => boolean;
  /** What this node's ancestors protect, which accumulates down a tree (ADR-0056 M4). */
  inheritedProtectedPaths?: () => readonly string[];
}

const NOTHING_TO_LAND: LandingOutcome = { kind: 'nothing-to-land', messages: [] };

/** What lands work git refused, once the user has fixed what it said: the work is kept, so it is landed, never redone. */
export function landingFix(landingError: string | undefined): string {
  const cause = lacksIdentity(landingError) ? ` ${IDENTITY_FIX}.` : '';
  return `${cause} Once git can, land its work (retry it from its session) to land what it kept without running it again.`;
}

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
  private readonly tasks: Pick<PlanStore, 'get' | 'planTasks'>;
  private readonly plannedWith: () => boolean;
  private readonly inheritedProtectedPaths: () => readonly string[];

  constructor(deps: LandingDeps) {
    this.plannedWith = deps.plannedWith ?? (() => false);
    this.inheritedProtectedPaths = deps.inheritedProtectedPaths ?? (() => []);
    this.runs = deps.runs;
    this.config = deps.config;
    this.tasks = deps.tasks;
  }

  /**
   * Land a passed attempt's work. One whose worktree has no unlanded record
   * behind it any more — the run was discarded under it — cannot land. A
   * read-only attempt's worktree goes instead, whatever it changed: its
   * report is its result (ADR-0046). `commit` is the one the attempt's done
   * handoff stated, which Ordewell's own commits for the task are written from.
   */
  async landPassed(task: Task, attempt: { worktree: boolean; kind: AttemptKind }, commit?: HandoffCommit): Promise<LandingOutcome> {
    if (landsNothing(attempt.kind)) return this.discard(task, attempt.worktree);
    if (!attempt.worktree) return NOTHING_TO_LAND;
    if (!this.hasUnlandedWork(task.id)) return this.unmerged(task, 'failed');
    const landing = await this.runs.integrate(task, commit);
    return landing === 'merged' ? { kind: 'landed', messages: [] } : this.unmerged(task, landing);
  }

  /** Mark complete is a passed verdict the user vouches for: what the task holds unlanded lands the same way. */
  async landVouched(task: Task): Promise<LandingOutcome> {
    if (this.runs.isReadOnly(task.id)) return this.discard(task, true);
    if (!this.hasUnlandedWork(task.id)) return NOTHING_TO_LAND;
    const landing = await this.runs.integrate(task);
    return landing === 'merged' ? { kind: 'landed', messages: [] } : this.unmerged(task, landing);
  }

  /**
   * Land what a passed task kept when git refused its landing, once git can:
   * the verdict it earned stands and the commit its handoff stated is the one
   * written, so nothing runs again (ADR-0013).
   */
  async landKept(task: Task): Promise<LandingOutcome> {
    if (!this.hasUnlandedWork(task.id)) return this.unmerged(task, 'failed');
    const landing = await this.runs.integrate(task, task.handoff?.commit);
    return landing === 'merged' ? { kind: 'landed', messages: [] } : this.unmerged(task, landing);
  }

  /**
   * A repair's verdict decides only whether its work may try to land; the
   * task keeps the verdict its own work earned. Evidence comes before the
   * queue, and the landing after it is the one every task goes through, so a
   * repair the tip has moved past again is a fresh conflict, not a pass.
   * `current` says whether the attempt is still the task's: a stop that comes
   * while the evidence is read has already cancelled the work, and the merge
   * must not bring it in anyway.
   */
  async settleRepair(task: Task, verdict: Verdict, current: () => boolean): Promise<LandingOutcome> {
    if (verdict.outcome !== 'pass') return this.unrepaired(task, `did not finish (${verdict.reason})`);
    const evidence = await this.runs.verifyRepair(task);
    // Whatever ended the attempt has already kept its worktree and said so.
    if (!current()) return { kind: 'awaiting_user', reason: 'repair-failed', messages: [] };
    if (!evidence.ok) return this.unrepaired(task, this.describeEvidence(evidence));
    const touched = await this.protectedPathsTouched(task);
    if (!current()) return { kind: 'awaiting_user', reason: 'repair-failed', messages: [] };
    if (touched.length > 0) return this.unrepaired(task, `changed protected paths (${capConflictFiles(touched)})`);
    const landing = await this.runs.integrate(task);
    if (landing !== 'merged') return this.unmerged(task, landing);
    const files = this.runs.repairedFilesOf(task.id);
    return {
      kind: 'landed',
      messages: [{ level: 'info', text: `Task "${task.title}" landed after repairing a conflict${files.length > 0 ? ` in ${capConflictFiles(files)}` : ''}.`, repairLog: true }],
    };
  }

  /** A repair lands after the verdict that held the work to its protected paths, so it is held to them here (ADR-0055 D7, D14). */
  private async protectedPathsTouched(task: Task): Promise<string[]> {
    const paths = this.protectedPaths(task);
    if (paths.length === 0) return [];
    return (await this.runs.repairPaths(task)).filter((file) => paths.some((rule) => underProtectedPath(file, rule)));
  }

  private protectedPaths(task: Readonly<Task>): readonly string[] {
    return task.type === 'delegated' ? [...task.protectedPaths ?? [], ...this.inheritedProtectedPaths()] : [];
  }

  /** A repair that ended without landing leaves the task as its conflict did: waiting on the user, worktree and refs kept. */
  async unrepaired(task: Task, why: string): Promise<Extract<LandingOutcome, { kind: 'awaiting_user' }>> {
    await this.runs.release(task.id, { keep: true });
    return {
      kind: 'awaiting_user',
      reason: 'repair-failed',
      messages: [{
        level: 'warn',
        text: `The conflict repair of task "${task.title}" ${why}, so it did not land. Its ${this.isGroup() ? 'worktrees are' : 'worktree is'} kept: resolve it by hand and mark it complete, retry it, or resolve it as a task.`,
        repairLog: true,
      }],
    };
  }

  /**
   * Land the conflicted task a resolver was added for, now that the resolver
   * has landed. Its branch is on the integration branch by then, so it merges
   * clean — and one the resolver did not really bring along conflicts again
   * instead of being taken at its word. Null when there is nothing to land.
   * The task is named before its landing settles, so the caller can hold
   * its worktree for as long as the merge is in it; one the caller says is
   * `leaving` the plan is not landed at all.
   */
  landResolved(resolverId: string, leaving: (taskId: string) => boolean = () => false): { task: Readonly<Task>; outcome: Promise<LandingOutcome> } | null {
    const conflictedId = this.runs.takeResolver(resolverId);
    if (!conflictedId || leaving(conflictedId)) return null;
    const task = this.tasks.get(conflictedId);
    // Only the conflict it was added for: a task retried since has a new
    // attempt of its own, whose worktree it would merge half-done.
    if (!task || this.runs.taskState(conflictedId) !== 'conflict') return null;
    return { task, outcome: this.landConflicted(task) };
  }

  private async landConflicted(task: Readonly<Task>): Promise<LandingOutcome> {
    const landing = await this.runs.integrate(task);
    if (landing !== 'merged') return this.unmerged(task, landing);
    return { kind: 'landed', messages: [{ level: 'info', text: `Task "${task.title}" landed through its conflict resolution.` }] };
  }

  /**
   * The repair a conflicted task is owed next; null when repair is off, used
   * up, or there is no isolated run to repair it in. A resolver takes the
   * conflict instead: a conflict has one worker (ADR-0015).
   */
  nextRepair(taskId: string): RepairAttempt | null {
    const limit = this.config.conflictRepairAttempts;
    const spent = this.runs.repairsOf(taskId);
    return this.runs.openTaskState(taskId) === 'conflict' && spent < limit && this.liveResolvers(taskId).length === 0 ? { n: spent + 1, limit } : null;
  }

  /**
   * The tasks in the plan still out to resolve this task's conflict. A skipped
   * one has been given up, and a link to one that left the plan points at
   * nothing, so either leaves the conflict free for another worker.
   */
  liveResolvers(taskId: string): Readonly<Task>[] {
    return this.runs.resolversOf(taskId).flatMap((id) => {
      const resolver = this.tasks.get(id);
      return resolver && resolver.status !== 'skipped' && resolver.status !== 'completed' ? [resolver] : [];
    });
  }

  /** What a repair is asked to do; read once `reopen` has recorded the tips it must bring in. */
  repairPrompt(task: Task): string {
    this.runs.requireRun();
    const found = this.runs.conflictOf(task.id);
    const conflict = {
      branch: found?.branch ?? '',
      message: landingMessage('repair-merge', found?.subject ?? task, this.plannedWith()),
      repos: found?.repairRepos ?? [],
      ...(found?.conflictRepo ? { conflictRepo: found.conflictRepo } : {}),
      ...(found?.conflictFiles ? { conflictFiles: found.conflictFiles } : {}),
    };
    const prompt = buildConflictRepairPrompt(task, conflict, this.runs.handoffBranch ?? '', this.tasks.planTasks);
    const paths = this.protectedPaths(task);
    return paths.length > 0 ? `${prompt}\n\nThese paths may not change: ${paths.join(', ')}. A repair that changes one does not land.` : prompt;
  }

  private hasUnlandedWork(taskId: string): boolean {
    const state = this.runs.taskState(taskId);
    return state !== undefined && state !== 'merged' && !this.runs.isReadOnly(taskId);
  }

  /** A read-only task's worktree goes with whatever is in it, and nothing lands (ADR-0046). */
  private async discard(task: Task, worktree: boolean): Promise<LandingOutcome> {
    if (worktree) await this.runs.release(task.id, { keep: false });
    return NOTHING_TO_LAND;
  }

  private unmerged(task: Readonly<Task>, landing: Exclude<IsolationOutcome, 'merged'>): UnlandedOutcome {
    const branch = this.runs.handoffBranch ?? 'the integration branch';
    const conflict = this.runs.conflictOf(task.id);
    // Named only where there is a repo to name: a group of one reads as it always has.
    const inRepo = conflict?.conflictRepo && conflict.conflictRepo !== SELF_REPO ? conflict.conflictRepo : null;
    if (landing === 'conflict') {
      const files = conflict?.conflictFiles?.length ? ` (${capConflictFiles(conflict.conflictFiles)})` : '';
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
          { level: 'warn', text: `${conflicted} ${inRepo ? 'Its worktrees are' : 'Its worktree is'} kept: resolve it by hand and mark it complete, retry it, or resolve it as a task.` },
          ...(whyNot ? [{ level: 'info' as const, text: whyNot, repairLog: true as const }] : []),
        ],
      };
    }
    // The verdict passed; only the landing did not. A red X would contradict
    // the runner's own report, and failing would block its dependents over work
    // that is finished and kept, so it waits on the user as a conflict does
    // (ADR-0013).
    const landingError = this.runs.landingErrorOf(task.id);
    const why = landingError ? ` (${landingError})` : '';
    return {
      kind: 'awaiting_user',
      reason: 'landing-failed',
      messages: [{
        level: 'error',
        text: (inRepo
          ? `Task "${task.title}" passed, but git could not integrate its work in ${inRepo}${why}, so none of it landed. Its worktrees are kept for inspection.`
          : `Task "${task.title}" passed, but git could not integrate its work${why}. Its worktree is kept for inspection.`)
          + landingFix(landingError),
      }],
    };
  }

  private noRepairReason(task: Readonly<Task>): string | null {
    const limit = this.config.conflictRepairAttempts;
    if (limit === 0) return `Conflict repair is off (conflictRepairAttempts is 0), so task "${task.title}" waits for you.`;
    const spent = this.runs.repairsOf(task.id);
    return spent >= limit ? `Task "${task.title}" has had ${spent} of its ${limit} conflict repairs, so its conflict waits for you.` : null;
  }

  private describeEvidence(evidence: Exclude<RepairEvidence, { ok: true }>): string {
    const inRepo = evidence.repo !== SELF_REPO ? ` in ${evidence.repo}` : '';
    const branch = this.runs.handoffBranch ?? 'the integration branch';
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
    return this.runs.inRepoGroup;
  }
}

/**
 * The task `resolveConflictAsTask` adds for a conflicted one (ADR-0013): on
 * that task's runner, model and mode, it merges the conflicted branch by hand
 * in its own worktree, which starts at the integration tip. Null unless the
 * task's landing is in conflict. Linking the two, so the conflicted task lands
 * once the resolver has, stays with the caller.
 */
export function conflictResolverTask(
  task: Readonly<Task>,
  runs: Pick<IsolationRunController, 'taskState' | 'conflictOf' | 'handoffBranch'>,
  plan?: readonly Task[],
  plannedWith = false,
): Partial<Task> | null {
  const found = runs.taskState(task.id) === 'conflict' ? runs.conflictOf(task.id) : null;
  const integrationBranch = runs.handoffBranch;
  if (!found || integrationBranch === null) return null;
  const conflict = {
    branch: found.branch,
    message: landingMessage('repair-merge', found.subject, plannedWith),
    repos: found.changedRepos,
    ...(found.conflictRepo ? { conflictRepo: found.conflictRepo } : {}),
  };
  return {
    title: `Resolve merge conflict: ${task.title}`,
    description: `Merge ${found.branch} into ${integrationBranch} by hand.`,
    type: 'ai',
    prompt: buildConflictResolutionPrompt(task, conflict, integrationBranch, plan),
    assignedRunner: task.assignedRunner,
    assignedModel: task.assignedModel,
    taskMode: task.taskMode,
    autonomy: 'AFK',
    sliceType: 'AFK',
    dependencies: [],
  };
}
