import { TASK_DIFF_UNAVAILABLE, type TaskDiffRead, type TaskDiffResult } from './taskDiffRead';
import type { Task } from '../models/Task';
import type { HandoffCommit } from '../models/Handoff';
import type { IConfig } from '../interfaces/IConfig';
import type { INotification } from '../interfaces/INotification';
import type {
  IsolationHandoff,
  IsolationInactiveReason,
  IsolationMergeResult,
  IsolationOutcome,
  IsolationRemoval,
  IsolationRevertResult,
  IsolationRun,
  IsolationTaskRecord,
  IsolationTaskRef,
  IsolationView,
  IWorktreeIsolation,
  LandedWork,
  PlanIsolation,
  PreparedTask,
  PrepareIntent,
  PreservedWork,
  PreviousWork,
  RepairEvidence,
  RepoGroupLayout,
  RevertWatch,
  SetupFailure,
  TaskIsolation,
  TreeSnapshot,
} from '../interfaces/IWorktreeIsolation';
import { describeMergeResult, repairedLanded } from './mergeResultNotice';
import { quotedList } from '../utils/quotedList';
import { handoffOf, layoutOf, PrepareFailedError, SELF_REPO, taskIsolationOf } from './isolationRecord';
import { handoffBranchName } from './mergeWording';
import type { IsolatedExecution } from './plannerModes';
import { PlanEditError } from './PlanEditError';
import { workspaceRepoGroup } from './repoGroup';
import type { SkillLayout } from './taskSkills';

export type IsolationNoticeLevel = 'info' | 'warn' | 'error';

/**
 * How an attempt that may run in a worktree gets one: fresh, the kept one for
 * a repair, restoring the previous attempt's work, or fresh and thrown away
 * whatever it changes, for a read-only task (ADR-0046).
 */
export type AttemptIntent = 'fresh' | 'repair' | 'readOnly' | PrepareIntent;

/**
 * What adopting a persisted run found: nothing to change, landed work git
 * shows the user has merged since, or a settled run that had nothing left to
 * hand over and was cleared up.
 */
export type AdoptOutcome = 'unchanged' | 'changed' | 'cleared';

export interface AttemptWorkspace {
  cwd: string;
  worktree: boolean;
  /** The task workspace holding the attempt's worktrees, which `cwd` is in; set with `worktree` when it was prepared. */
  workspace?: string;
  /** Set for a `restore` in a worktree; absent in the checkout, where the previous attempt's edits remain. */
  previousWork?: PreviousWork;
}

/**
 * What the controller reports. It never schedules or emits on its own: the
 * orchestrator turns these into observer events and decides what runs next.
 */
export interface IsolationRunListener {
  /**
   * The run record changed and should be persisted with the plan. `detached`
   * is set instead when the record that changed is no longer the plan's own —
   * a release that outlived the plan load that replaced its run — and belongs
   * to the session that was left.
   */
  changed(detached?: IsolationRun): void;
  /** A run did not start: `repos` of the group have tracked changes. */
  blocked(repos: string[]): void;
  /** An isolated run closed and handed its integration branches over. */
  handoff(handoff: IsolationHandoff): void;
  /** The run was cleared up and forgotten: nothing was handed over, or it was discarded. */
  closed(): void;
  /** Already said through the notifications; also for a surface that shows no toasts. */
  notice(level: IsolationNoticeLevel, message: string): void;
}

export interface IsolationRunControllerDeps {
  isolation: IWorktreeIsolation;
  config: IConfig;
  notifications: INotification;
  workspaceRoot: () => string;
  listener: IsolationRunListener;
  /**
   * The tasks no clean-up of the whole run may take a worktree from: an
   * attempt is running them, or the plan has them in progress or waiting on
   * the user mid-attempt.
   */
  liveTasks: () => ReadonlySet<string>;
}

type SharedRootReason = Exclude<IsolationInactiveReason, 'dirty'>;

type RunDecision =
  | { mode: 'isolated'; continuing: boolean; layout: RepoGroupLayout }
  | { mode: 'blocked'; repos: string[] }
  | { mode: 'shared'; reason: SharedRootReason; repos: string[] };

const SHARED_ROOT_TAIL = 'tasks run in the workspace root without worktree isolation.';

/** Why a run fell back to the shared workspace root, as the one line the user is told. */
function sharedRootNotice(reason: SharedRootReason, repos: string[]): string {
  switch (reason) {
    case 'disabled': return 'Worktree isolation is off: tasks run in the workspace root.';
    case 'git-missing': return `git was not found: ${SHARED_ROOT_TAIL}`;
    case 'no-commits':
      return repos.length > 0
        ? `No repository in this folder has commits yet (${repos.join(', ')}): ${SHARED_ROOT_TAIL}`
        : `The repository has no commits yet: ${SHARED_ROOT_TAIL}`;
    case 'not-git': return `Not a git repository: ${SHARED_ROOT_TAIL}`;
  }
}

const quoted = (tasks: readonly IsolationTaskRef[]): string => quotedList(tasks.map((t) => t.title));

/** Tasks as the subject of a sentence: `Task "A"`, `Tasks "A" and "B"`. */
const tasksNamed = (tasks: readonly IsolationTaskRef[]): string => `${tasks.length === 1 ? 'Task' : 'Tasks'} ${quoted(tasks)}`;

/** What one removal kept on a branch, and how to get it back. */
function preservedNotice(kept: PreservedWork[]): string {
  const [first] = kept;
  const where = kept.some((k) => k.repo !== SELF_REPO) ? ` in ${kept.map((k) => `${k.repo} (${k.commit.slice(0, 7)})`).join(', ')}` : ` (${first.commit.slice(0, 7)})`;
  const owner = first.task ? `Task "${first.task.title}"` : 'A leftover task workspace no record accounted for';
  return `${owner} had work that never landed, so before its worktree was removed it was kept on branch ${first.branch}${where}. `
    + `\`git log ${first.branch}\` shows it; merge or cherry-pick it to bring it back, and delete the branch once you no longer need it.`;
}

/** A worktree a removal left alone, and what the user can do with it. */
function refusedNotice(worktree: string, reason: string, task?: IsolationTaskRef): string {
  return `Left ${task ? `the worktree of task "${task.title}"` : 'a leftover worktree'} in place at ${worktree}: it holds work Ordewell could not keep (${reason}). `
    + `Save what you need from it, then remove it with \`git worktree remove --force ${worktree}\`.`;
}

/** What a new run shares live instead of isolating, as one line; null when it shares nothing. */
function sharedPathsNotice(run: IsolationRun): string | null {
  // A lone repository shares the repositories nested inside it: they cannot be
  // isolated with it, so they are linked live rather than left to vanish.
  if (run.repos.some((r) => r.path === SELF_REPO)) {
    if (run.shared.length === 0) return null;
    const one = run.shared.length === 1;
    return `${run.shared.join(', ')} ${one ? 'is a repository nested inside this one' : 'are repositories nested inside this one'}: linked live into every task, so edits there are not isolated.`;
  }
  const loose = run.shared.filter((p) => !run.sharedRepos.includes(p));
  if (run.sharedRepos.length === 0) {
    if (loose.length === 0) return null;
    const one = loose.length === 1;
    return `${loose.join(', ')} ${one ? 'is' : 'are'} shared live with every task, so edits to ${one ? 'it' : 'them'} are not isolated.`;
  }
  const one = run.sharedRepos.length === 1 && loose.length === 0;
  const subject = [run.sharedRepos.length === 1 ? 'It' : 'They', ...(loose.length > 0 ? [`and ${loose.join(', ')}`] : [])].join(' ');
  return `Could not isolate ${run.sharedRepos.join(', ')} (no commits, or git refused a worktree). `
    + `${subject} ${one ? 'is' : 'are'} shared live with every task, so edits to ${one ? 'it' : 'them'} are not isolated.`;
}

/**
 * The lifecycle of a plan's isolation run (ADR-0013, ADR-0014, ADR-0020),
 * between the scheduler and the git layer: deciding, at a run's first change
 * task, whether it executes in worktrees, a blocked run and how it goes on,
 * each attempt's working directory, releasing worktrees, which landed work the
 * user has merged, the tree check of an ops task, the handoff when the run
 * closes, and what the user does with it afterwards. The record it keeps
 * outlives one run — a resumed plan continues it.
 */
export class IsolationRunController {
  private readonly isolation: IWorktreeIsolation;
  private readonly config: IConfig;
  private readonly notifications: INotification;
  private readonly workspaceRoot: () => string;
  private readonly listener: IsolationRunListener;
  private readonly liveTasks: () => ReadonlySet<string>;

  private run: IsolationRun | null = null;
  /** See {@link mergedRun}. */
  private merged: string | null = null;
  /** An adoption stays scoped even while cleanup temporarily leaves no run record. */
  private adoptions = 0;
  /** Copied paths already reported for the current run: every task gets the same copies. */
  private reportedCopies = new Set<string>();
  private reportedSetupFailures = new Set<string>();
  /**
   * How the open run executes; null while no run is open, `undecided` until
   * its first change task asks. A run is one Execute-Plan or one manual task
   * run, from its start until it settles or is stopped.
   */
  private mode: 'undecided' | 'isolated' | 'shared' | null = null;
  /** Resolver task id → the conflicted task it resolves; see {@link linkResolver}. */
  private resolvers: Record<string, string> = {};
  private opening: Promise<boolean> | null = null;
  private opened = 0;
  /** Bumped by an interrupt, so an activation in flight across it does not open the run it ended. */
  private activations = 0;
  /** The start a dirty tree turned away, handed back once the user chooses how to go on. */
  private blockedStart: (() => Promise<void>) | null = null;
  /** The dirty repos behind {@link blockedStart}, for the stash notice. */
  private blockedRepos: string[] = [];

  constructor(deps: IsolationRunControllerDeps) {
    this.isolation = deps.isolation;
    this.config = deps.config;
    this.notifications = deps.notifications;
    this.workspaceRoot = deps.workspaceRoot;
    this.listener = deps.listener;
    this.liveTasks = deps.liveTasks;
  }

  /** The plan's run record, open or not; null when the plan has not isolated. */
  get current(): IsolationRun | null { return this.run; }

  /**
   * The id of the plan's last isolated run once it closed with everything it
   * landed merged into the user's branch and was cleared up: what tells a
   * Merge all asked for after it, which has nothing to merge, from one in a
   * plan that never isolated (ADR-0029). Null while the plan holds a run
   * record, and once a later run decides how it executes. Saved with the plan.
   */
  get mergedRun(): string | null { return this.run ? null : this.merged; }

  get isOpen(): boolean { return this.mode !== null; }

  /** How many runs have opened: what tells one run's launches from the next one's. */
  get epoch(): number { return this.opened; }

  /** The open run has decided whether it isolates. */
  get decided(): boolean { return this.mode === 'isolated' || this.mode === 'shared'; }

  /** The open run executes in worktrees. */
  get isolating(): boolean { return this.mode === 'isolated' && this.run !== null; }

  /** A run is waiting on the user to stash or to go on without isolation. */
  get blocked(): boolean { return this.blockedStart !== null; }

  /** What the plan persists of isolated execution; null when no run ever isolated. */
  get planIsolation(): PlanIsolation | null {
    return this.run ? { run: this.run, resolvers: this.resolvers } : null;
  }

  /** The one guard of every action on the run: a plan that never isolated is a request refused, not a fault. */
  requireRun(): IsolationRun {
    if (!this.run) throw new PlanEditError('This plan has no isolated run');
    return this.run;
  }

  /** A task's record in the open run, only while that run isolates. */
  openRecord(taskId: string): IsolationTaskRecord | undefined {
    return this.mode === 'isolated' ? this.run?.tasks[taskId] : undefined;
  }

  /** Where a task's isolated work stands; null when the plan has no isolation run to speak of. */
  taskIsolation(taskId: string): TaskIsolation | null {
    if (!this.run) return null;
    const record = this.run.tasks[taskId];
    if (!record) return { state: 'none' };
    return taskIsolationOf(record, this.config.conflictRepairAttempts);
  }

  view(): IsolationView | null {
    const run = this.run;
    if (!run) return null;
    const tasks = Object.fromEntries(Object.values(run.tasks).map((r): [string, TaskIsolation] => [r.taskId, taskIsolationOf(r, this.config.conflictRepairAttempts)]));
    return { tasks, handoff: handoffOf(run) };
  }

  /**
   * Take over a plan's persisted isolation, or none for a plan that has not
   * isolated yet. Whatever a crashed process left behind for the run — a
   * worktree still marked active, a directory no record owns — is pruned,
   * while kept, failed and conflicted worktrees stay for the user. Then git is
   * asked which landed work the user has merged since the record was saved:
   * a settled run whose landed work is all in HEAD has nothing left to hand
   * over, so it is cleared up as Merge all would have, unless it still holds
   * work that never landed (ADR-0013).
   *
   * Deliberately not reported to the listener: adopting is not a change of the
   * session's own, and a host that adopts without persisting (VS Code's
   * restore) would otherwise write a new session file on every reload. What
   * git changed is returned instead, for the caller to save where it can and
   * announce. A plan loaded meanwhile supersedes this adoption, which then
   * touches nothing and resolves `unchanged`. `mergedRun` is the plan's saved
   * {@link mergedRun}.
   */
  async adopt(state: PlanIsolation | null, mergedRun?: string): Promise<AdoptOutcome> {
    const adoption = ++this.adoptions;
    this.run = state?.run ?? null;
    this.resolvers = { ...(state?.resolvers ?? {}) };
    this.merged = this.run ? null : mergedRun ?? null;
    const run = this.run;
    if (!run) return 'unchanged';
    try {
      const pruned = await this.isolation.pruneOrphans(run);
      // Never silently: work kept back from the sweep has to be named, or the
      // user has a worktree they do not know about and a task that looks done.
      for (const task of pruned.kept) {
        this.tell('warn', `Task "${task.title}" was still holding unlanded work when this plan was re-opened, so its worktree and branch were kept. Retry it to land the work, or review it by hand.`);
      }
      this.report(pruned);
    } catch (err) {
      this.tell('warn', `Could not prune leftover worktrees: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.run !== run) return 'unchanged';
    const found = await this.findLanded(run);
    if (this.run !== run) return 'unchanged';
    const outcome = found ? 'changed' : 'unchanged';
    if (this.isOpen || !this.allMerged(run) || this.holdouts(run).length > 0) return outcome;
    // The record goes before git deletes the run's worktrees and branches: a
    // start that comes in meanwhile then mints a fresh run from HEAD instead
    // of continuing one whose branches are being deleted under it.
    const resolvers = this.resolvers;
    this.run = null;
    this.resolvers = {};
    this.merged = run.id;
    const discarded = await this.discardMerged(run);
    if (this.adoptions !== adoption) return 'unchanged';
    if (!discarded) {
      // Refused: the record is the one pointer to what could not be let go.
      if (this.run === null) { this.run = run; this.resolvers = resolvers; this.merged = null; }
      return outcome;
    }
    // A start opened while git was deleting: the run in force is that one.
    return this.isOpen ? 'changed' : 'cleared';
  }

  /** Open a run if none is, leaving whether it isolates to its first change task. */
  open(): void {
    if (this.mode) return;
    this.mode = 'undecided';
    this.opened += 1;
  }

  /**
   * Decide once per run, as its first change task starts, whether it executes
   * in worktrees (ADR-0020): an ops task needs none, so a run of only ops
   * tasks never asks. `resume` is what a dirty tree parks until the user
   * chooses how to go on. Resolves false while the run waits on that choice.
   */
  decide(resume: () => Promise<void>): Promise<boolean> {
    this.open();
    if (this.decided) return Promise.resolve(true);
    if (this.blockedStart) return Promise.resolve(false);
    if (!this.opening) {
      const opening = this.activate(resume, this.activations).finally(() => {
        if (this.opening === opening) this.opening = null;
      });
      this.opening = opening;
    }
    return this.opening;
  }

  /**
   * Whether the run in force, or else the next one, gives each task its own
   * worktrees, and of which repo group — what the planner is told, since it
   * decides whether tasks on the same file have to be ordered and which shared
   * paths two tasks must not edit at once. A tree that would block counts as
   * not isolating: the user may yet run without isolation, and ordering is
   * the safe rule then.
   */
  async plannerLayout(): Promise<IsolatedExecution> {
    if (this.decided) return this.isolating && this.run ? layoutOf(this.run) : false;
    const decision = await this.assess(this.workspaceRoot());
    return decision.mode === 'isolated' ? decision.layout : false;
  }

  /**
   * Where the workspace's skills are read, and whether tasks get worktrees.
   * Read synchronously inside a planner turn or a chip edit, so it comes from
   * the files, not git or the planner's last layout: a restored session is
   * right from its first edit. The run's repos while it isolates; otherwise
   * the group the workspace holds, in worktrees unless isolation is off or
   * this run chose to share the root.
   */
  skillLayout(): SkillLayout {
    if (this.isolating && this.run) return { repos: this.run.repos.map((r) => r.path), worktrees: true };
    return {
      repos: workspaceRepoGroup(this.workspaceRoot(), this.config.workspaceRepos),
      worktrees: !this.decided && this.config.worktreeIsolation,
    };
  }

  /**
   * Go on with the start a dirty tree turned away. `stash` puts the user's
   * tracked changes on the git stash first, so the run isolates; `shared` runs
   * this one run in the workspace root, knowingly. Returns the parked start for
   * the caller to replay; null when nothing was parked.
   */
  async continueBlocked(how: 'stash' | 'shared'): Promise<(() => Promise<void>) | null> {
    const resume = this.blockedStart;
    if (!resume) return null;
    if (how === 'stash') {
      const repos = this.blockedRepos;
      // Parked until the stash succeeds: one that throws leaves the user their choice.
      await this.isolation.stash(this.workspaceRoot());
      // Said even when an interrupt came meanwhile: the changes are stashed either way.
      this.tell('info', repos.length > 0
        ? `Stashed your uncommitted changes in ${repos.join(', ')}: \`git stash pop\` in each brings them back.`
        : 'Stashed your uncommitted changes: `git stash pop` brings them back.');
      if (this.blockedStart !== resume) return null;
      this.blockedStart = null;
    } else {
      this.blockedStart = null;
      this.begin('shared');
      this.tell('info', 'Running without worktree isolation: tasks share the workspace root for this run.');
    }
    return resume;
  }

  /**
   * The working directory of an attempt that may run in a worktree — which
   * attempts do is the attempt kind's to say (see `attemptKind.attemptCwd`):
   * the worktree prepared for it in an isolated run, the kept one for a
   * conflict repair, else the workspace root. `worktree` says which. Does not
   * itself report a worktree it creates as a change — the caller does once
   * the attempt is committed as running, so a spawn abandoned or failed after
   * this settles is not misreported as a change that stuck.
   */
  attemptCwd(task: Task, intent: AttemptIntent): Promise<AttemptWorkspace> {
    if (intent === 'repair' && this.run) return this.reopenCwd(task, this.run);
    if (!this.isolating || !this.run) return this.workspaceCwd(task);
    return this.prepareCwd(task, this.run, intent === 'restore' ? intent : 'fresh', intent === 'readOnly');
  }

  /** The workspace root, for an attempt that runs outside any worktree. */
  async workspaceCwd(task: Task): Promise<{ cwd: string; worktree: boolean }> {
    // A worktree left by an earlier attempt describes work this attempt
    // replaces; left alone it could later be integrated as if it were this one's.
    await this.release(task.id, { keep: false });
    return { cwd: this.workspaceRoot(), worktree: false };
  }

  private async reopenCwd(task: Task, run: IsolationRun): Promise<{ cwd: string; worktree: boolean }> {
    const { cwd } = await this.isolation.reopen(task, run);
    return { cwd, worktree: true };
  }

  private async prepareCwd(task: Task, run: IsolationRun, intent: PrepareIntent, readOnly: boolean): Promise<AttemptWorkspace> {
    let result: PreparedTask;
    try {
      result = await this.isolation.prepare(task, run, intent, readOnly ? { readOnly } : {});
    } catch (err) {
      // The attempt this one replaced is gone, record and all: only this says where its work went.
      if (err instanceof PrepareFailedError) this.report({ preserved: err.preserved, refused: [] });
      throw err;
    }
    const { cwd, copied, setupFailed, preserved, restoration } = result;
    this.reportCopies(copied);
    this.reportSetupFailures(setupFailed ?? []);
    if (preserved) this.report({ preserved, refused: [] });
    const workspace = run.tasks[task.id]?.workspace;
    const prepared = { cwd, worktree: true, ...(workspace ? { workspace } : {}) };
    if (!restoration) return prepared;
    const previousWork: PreviousWork = restoration === 'fallback' ? { outcome: 'fallback', preserved: preserved ?? [] } : { outcome: 'restored' };
    return { ...prepared, previousWork };
  }

  /**
   * Land a task's work on the run's integration branches. The record is
   * reported changed once the landing is set and before the first merge, so
   * a crash mid-landing leaves the tips to roll back to, and again once it
   * settles. A git error is `failed`, never a throw.
   */
  async integrate(task: Task, commit?: HandoffCommit): Promise<IsolationOutcome> {
    const run = this.run;
    if (!run) return 'failed';
    const outcome = await this.isolation.integrate(task, run, () => this.listener.changed(), commit).catch((): IsolationOutcome => 'failed');
    this.listener.changed();
    return outcome;
  }

  /** What a conflict repair's work shows (ADR-0015); git that cannot tell counts against it. */
  async verifyRepair(task: Task): Promise<RepairEvidence> {
    const run = this.run;
    const unverified = (): RepairEvidence => ({ ok: false, reason: 'failed', repo: run?.tasks[task.id]?.conflictRepo ?? SELF_REPO });
    if (!run) return unverified();
    return this.isolation.verifyRepair(task, run).catch(unverified);
  }

  /**
   * Let go of a task's worktree. `keep` leaves it and its branch for
   * inspection; otherwise both go. A landing still in flight settles first, so
   * the worktree is never torn down underneath its merge. Bound to the run
   * the call was made in: a plan loaded meanwhile adopts its own run, whose
   * records share these task ids and are not this release's to touch.
   */
  async release(taskId: string, opts: { keep: boolean }, landing?: Promise<unknown> | null): Promise<void> {
    const run = this.run;
    await landing;
    if (!run?.tasks[taskId]) return;
    try {
      this.report(await this.isolation.release(run, taskId, opts));
    } catch (err) {
      this.notifications.warn(`Could not clean up the worktree of task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.listener.changed(run === this.run ? undefined : run);
  }

  /**
   * Close the open run. An isolated one hands its integration branch over for
   * review — unless everything it landed is merged already, at merge gates or
   * by the run's automatic Merge all, which leaves nothing to hand over, so it
   * is cleared up as a Merge all would have.
   */
  async close(): Promise<void> {
    const mode = this.mode;
    this.mode = null;
    const run = this.run;
    if (mode !== 'isolated' || !run) return;
    await this.refreshInHead();
    if (this.allMerged(run)) {
      this.tell('info', 'Everything this run landed is merged into your branch already.');
      await this.clearMerged(run);
      return;
    }
    try {
      this.listener.handoff(await this.isolation.handoff(run));
    } catch (err) {
      this.tell('warn', `Could not hand the run's integration branch over: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.listener.changed();
  }

  /**
   * Whether a task's landed work still waits to be merged into the user's
   * branch — what holds an ops or user task at its merge gate (ADR-0020). A
   * task with no record never landed anything to wait for.
   */
  awaitsMerge(taskId: string): boolean {
    const record = this.run?.tasks[taskId];
    return !!record && record.status === 'merged' && !record.inHead;
  }

  /**
   * Look again for landed work the user has merged — by Merge all, or by hand
   * with git. Resolves true when some was found.
   */
  async refreshInHead(): Promise<boolean> {
    const run = this.run;
    if (!run) return false;
    const found = await this.findLanded(run);
    if (found) this.listener.changed();
    return found;
  }

  /** Mark the run's landed work git finds in HEAD; true when some was found. */
  private async findLanded(run: IsolationRun): Promise<boolean> {
    if (!Object.values(run.tasks).some((r) => r.status === 'merged' && !r.inHead)) return false;
    const found = await this.isolation.findInHead(run).catch((): string[] => []);
    return found.length > 0;
  }

  /** The run landed something and every landing is in the user's HEAD. */
  private allMerged(run: IsolationRun): boolean {
    return Object.values(run.tasks).some((r) => r.status === 'merged') && handoffOf(run).landed.length === 0;
  }

  /**
   * The tracked state of the workspace as an attempt whose tree is checked
   * starts (see `attemptKind.checksTree`), for {@link filesChangedSince}
   * (ADR-0020). Null where the check does not run: a run that shares the
   * workspace root, where every task's edits land in it, or a workspace git
   * cannot isolate at all.
   */
  async snapshotWorkspace(): Promise<TreeSnapshot | null> {
    if (this.mode === 'shared') return null;
    const root = this.workspaceRoot();
    if (!this.isolating) {
      const availability = await this.isolation.isActive(root).catch((): null => null);
      if (!availability || (!availability.active && availability.reason !== 'dirty')) return null;
    }
    return this.isolation.snapshotTree(root, this.run?.sharedRepos ?? []).catch((): null => null);
  }

  /** Tracked files changed since `snapshot`; none when the run has since gone on in the workspace root. */
  async filesChangedSince(snapshot: TreeSnapshot | null): Promise<string[]> {
    if (!snapshot || this.mode === 'shared') return [];
    return this.isolation.changedSince(this.workspaceRoot(), snapshot).catch((): string[] => []);
  }

  /**
   * A stop or a plan load: the open run ends without a handoff and a parked
   * start is dropped. `keepOpen` spares a run the scheduler is still driving.
   */
  interrupt(opts: { keepOpen?: boolean } = {}): void {
    if (!opts.keepOpen) {
      this.mode = null;
      this.activations++;
      this.opening = null;
    }
    this.blockedStart = null;
  }

  /**
   * Mark which added task resolves which conflict. The resolver merges the
   * conflicted task's branch by hand in its own worktree; once that lands, the
   * conflicted task can land in turn — through the same merge, so a resolver
   * that did not really bring it along conflicts again instead of being taken
   * at its word.
   */
  linkResolver(resolverId: string, conflictedId: string): void {
    this.resolvers[resolverId] = conflictedId;
    this.listener.changed();
  }

  /** The conflicted task a landed resolver was added for, forgotten as it is returned. */
  takeResolver(resolverId: string): string | undefined {
    const conflictedId = this.resolvers[resolverId];
    if (!conflictedId) return undefined;
    delete this.resolvers[resolverId];
    this.listener.changed();
    return conflictedId;
  }

  async taskDiff(taskId: string, options: TaskDiffRead): Promise<TaskDiffResult> {
    if (!this.run || !this.run.tasks[taskId] || !this.isolation.taskDiff) {
      return { available: false, reason: TASK_DIFF_UNAVAILABLE };
    }
    return this.isolation.taskDiff(this.run, taskId, options);
  }

  async reviewDiff(): Promise<string> {
    return this.isolation.reviewDiff(this.requireRun());
  }

  /**
   * "Merge all": the run's integration branches into whatever the user has
   * checked out, in every repo or none. During a run it merges what has
   * landed so far and the run goes on (ADR-0020): its branches stay for the
   * tasks still to land. Once a settled run merged everything, it has nothing
   * left to hand over, so it is cleared up and forgotten; a branch the user's
   * HEAD somehow does not contain stays for the next run's sweep.
   */
  async merge(): Promise<IsolationMergeResult> {
    const run = this.requireRun();
    const repaired = repairedLanded(handoffOf(run));
    const result = await this.isolation.mergeIntoCheckedOut(run);
    const branch = handoffBranchName(run);
    const group = run.repos.some((r) => r.path !== SELF_REPO);
    const { level, message } = describeMergeResult(result, branch, group, repaired);
    this.tell(level, message);
    if (result.outcome !== 'merged') return result;
    await this.refreshInHead();
    if (!this.isOpen) await this.clearMerged(run);
    return result;
  }

  /** What git says of landed work a revert would take; see {@link IWorktreeIsolation.readLanded}. */
  readLanded(taskIds: readonly string[]): Promise<LandedWork> {
    return this.isolation.readLanded(this.requireRun(), taskIds);
  }

  /**
   * Revert tasks' landings on the integration branches (ADR-0054). The record
   * is reported changed once the tips are set and before the first commit,
   * and again once it settles, as a landing's is. Bound to the run it was
   * asked in: a plan loaded meanwhile has records of its own under these ids.
   */
  async revert(taskIds: readonly string[], watch: Omit<RevertWatch, 'persist'>): Promise<IsolationRevertResult> {
    const run = this.requireRun();
    const result = await this.isolation.revert(run, taskIds, {
      refusal: watch.refusal,
      persist: () => this.listener.changed(run === this.run ? undefined : run),
      settled: (reverted) => { if (run === this.run) watch.settled(reverted); },
    });
    this.listener.changed(run === this.run ? undefined : run);
    return result;
  }

  /**
   * Worktrees and task branches go; the integration branch and the record stay
   * for review and merge. Refused while a task of the run is still live.
   */
  async cleanup(): Promise<void> {
    const run = this.requireRun();
    this.refuseWhileLive(run);
    this.report(await this.isolation.discard(run, { integration: 'keep' }));
    this.listener.changed();
  }

  /**
   * The run and everything it made go, and the plan forgets it; the next run
   * starts afresh. Refused while a task of the run is still live.
   */
  async discard(): Promise<void> {
    const run = this.requireRun();
    this.refuseWhileLive(run);
    this.report(await this.isolation.discard(run, { integration: 'delete' }));
    this.forget();
  }

  /** The records of tasks still live, whose worktrees no clean-up of the whole run may take. */
  private liveRecords(run: IsolationRun): IsolationTaskRecord[] {
    const live = this.liveTasks();
    return Object.values(run.tasks).filter((r) => live.has(r.taskId));
  }

  private refuseWhileLive(run: IsolationRun): void {
    const live = this.liveRecords(run);
    if (live.length === 0) return;
    const one = live.length === 1;
    throw new PlanEditError(`${tasksNamed(live)} ${one ? 'is' : 'are'} still running or waiting on you, so ${one ? 'its worktree stays' : 'their worktrees stay'}. Let ${one ? 'it' : 'them'} finish, or retry or mark ${one ? 'it' : 'them'} complete, first.`);
  }

  /**
   * Clear a settled run up once everything it landed is merged — and only
   * when nothing else is left in it: a live task, or a worktree holding work
   * that never landed, keeps the whole run, worktrees and branches, rather
   * than leaving that work to a deletion.
   */
  private async clearMerged(run: IsolationRun): Promise<void> {
    const live = this.liveRecords(run);
    const unlanded = this.holdouts(run).filter((r) => !live.includes(r));
    if (live.length > 0 || unlanded.length > 0) {
      const why = [
        ...(live.length > 0 ? [`${tasksNamed(live)} ${live.length === 1 ? 'is' : 'are'} still running or waiting on you`] : []),
        ...(unlanded.length > 0 ? [`${tasksNamed(unlanded)} ${unlanded.length === 1 ? 'holds' : 'hold'} work that has not landed`] : []),
      ];
      const one = live.length + unlanded.length === 1;
      this.tell('info', `The run is not cleared up: ${why.join(', and ')}, so ${one ? 'its worktree stays' : 'their worktrees stay'}, and so do the run's branches.`);
      return;
    }
    if (await this.discardMerged(run)) this.forget(run.id);
  }

  /** The records that keep a settled run from being cleared up: live, or holding work that never landed. */
  private holdouts(run: IsolationRun): IsolationTaskRecord[] {
    const live = this.liveTasks();
    return Object.values(run.tasks).filter((r) => live.has(r.taskId) || r.status !== 'merged');
  }

  /** The run's worktrees and merged branches go; false, said, when git would not let them. */
  private async discardMerged(run: IsolationRun): Promise<boolean> {
    try {
      this.report(await this.isolation.discard(run, { integration: 'delete-merged' }));
      return true;
    } catch (err) {
      this.tell('warn', `Merged, but could not clean up the run's worktrees and branches: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Say what a removal kept back instead of deleting: where the work went, or which worktree stayed. */
  private report(removal: IsolationRemoval): void {
    const byOwner = new Map<string, PreservedWork[]>();
    for (const kept of removal.preserved) {
      const key = kept.task?.taskId ?? `${kept.repo}:${kept.branch}`;
      byOwner.set(key, [...(byOwner.get(key) ?? []), kept]);
    }
    for (const kept of byOwner.values()) this.tell('warn', preservedNotice(kept));
    for (const { worktree, reason, task } of removal.refused) this.tell('warn', refusedNotice(worktree, reason, task));
  }

  /** The run goes from the plan; `merged` names it as {@link mergedRun} when everything it landed was merged. */
  private forget(merged?: string): void {
    this.run = null;
    this.resolvers = {};
    this.merged = merged ?? null;
    this.listener.changed();
    this.listener.closed();
  }

  private async assess(root: string): Promise<RunDecision> {
    const availability = await this.isolation.isActive(root);
    const continued = this.continuableRun(root);
    const continuing = continued !== null;
    // A continued run keeps the group it started with.
    if (availability.active) {
      const layout = continued ? layoutOf(continued) : { repos: availability.repos ?? [SELF_REPO], shared: availability.shared ?? [] };
      return { mode: 'isolated', continuing, layout };
    }
    // A continued run's base is already fixed, so edits the user has made in
    // their own tree since cannot change what its tasks start from.
    if (availability.reason === 'dirty') {
      return continued ? { mode: 'isolated', continuing, layout: layoutOf(continued) } : { mode: 'blocked', repos: availability.repos ?? [] };
    }
    return { mode: 'shared', reason: availability.reason, repos: availability.repos ?? [] };
  }

  private async activate(resume: () => Promise<void>, activation: number): Promise<boolean> {
    const root = this.workspaceRoot();
    const decision = await this.assess(root);
    const interrupted = () => activation !== this.activations;
    if (interrupted()) return false;
    if (decision.mode === 'blocked') {
      this.blockedStart = resume;
      this.blockedRepos = decision.repos;
      this.listener.blocked(decision.repos);
      return false;
    }
    if (decision.mode === 'shared') {
      this.tell('info', sharedRootNotice(decision.reason, decision.repos));
      this.begin('shared');
      return true;
    }
    if (!decision.continuing) {
      try {
        if (!(await this.mint(root, interrupted))) return false;
      } catch (err) {
        if (interrupted()) return false;
        // Git can still refuse every repo of the group once a run is minted — the one check `isActive` cannot make.
        this.tell('info', `${err instanceof Error ? err.message : String(err)}: ${SHARED_ROOT_TAIL}`);
        this.listener.changed();
        this.begin('shared');
        return true;
      }
    }
    this.begin('isolated');
    await this.sweep();
    return true;
  }

  private begin(mode: 'isolated' | 'shared'): void {
    this.open();
    this.mode = mode;
    // This run's own merges are what count from here: a shared one has none to make.
    this.merged = null;
  }

  /** What earlier runs left merged in the group goes; a failure here is worth a word, never a stopped run. */
  private async sweep(): Promise<void> {
    if (!this.run) return;
    try {
      await this.isolation.sweep(this.run);
    } catch (err) {
      this.tell('warn', `Could not clear merged branches of earlier runs: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The plan's run carries on while it still has any record: anything landed
   * means a resumed plan's dependents must start from a tip that holds their
   * predecessors' work, and anything held — a kept attempt, a conflict, a
   * repair — is work the user may still want, which a fresh run's mint would
   * delete. Only a run with no records at all is superseded, and not one that
   * reverted the tasks it had: a retry starts from its tip (ADR-0054).
   */
  private continuableRun(root: string): IsolationRun | null {
    const run = this.run;
    return run && run.workspaceRoot === root && (run.reverted || Object.values(run.tasks).some((r) => r.status !== 'active')) ? run : null;
  }

  /**
   * A run with no records at all holds only superseded attempts, so it goes —
   * but its integration branch only where the user's HEAD contains it, as does
   * that of a run that cannot be continued for another reason (it ran from a
   * different workspace path): only the user gives landed work up.
   *
   * False when `interrupted` came while git was minting: a newer activation
   * may be minting its own run, so this one is never installed over it, and
   * is discarded rather than left as branches no record names.
   */
  private async mint(root: string, interrupted: () => boolean): Promise<boolean> {
    const previous = this.run;
    const live = previous ? this.liveRecords(previous) : [];
    if (previous && live.length > 0) {
      this.tell('warn', `The last run's worktrees are left in place: ${tasksNamed(live)} ${live.length === 1 ? 'is' : 'are'} still running or waiting on you there.`);
    } else if (previous) {
      // Not decided from the records: a retry drops a landed task's, and the branch then holds work no record names. A branch with nothing landed is behind HEAD, so this deletes it too.
      const removal = await this.isolation.discard(previous, { integration: 'delete-merged' }).catch(() => null);
      if (removal) this.report(removal);
    }
    if (this.run === previous) this.run = null;
    if (interrupted()) return false;
    const run = await this.isolation.startRun(root);
    if (interrupted()) {
      await this.isolation.discard(run, { integration: 'delete' }).catch(() => null);
      return false;
    }
    this.run = run;
    this.resolvers = {};
    this.reportedCopies.clear();
    this.reportedSetupFailures.clear();
    this.listener.changed();
    const shared = sharedPathsNotice(run);
    if (shared) this.tell('info', shared);
    return true;
  }

  private reportCopies(copied: string[]): void {
    const fresh = copied.filter((p) => !this.reportedCopies.has(p));
    if (fresh.length === 0) return;
    for (const p of fresh) this.reportedCopies.add(p);
    const one = fresh.length === 1;
    this.tell(
      'warn',
      `${fresh.join(', ')} could not be linked into task workspaces (a hard link is impossible there), so each task gets ${one ? 'a copy' : 'copies'}: edits to ${one ? 'it' : 'them'} stay in the task.`,
    );
  }

  private reportSetupFailures(failures: SetupFailure[]): void {
    for (const { repo, detail } of failures) {
      if (this.reportedSetupFailures.has(repo)) continue;
      this.reportedSetupFailures.add(repo);
      const where = repo === SELF_REPO ? 'this repository' : `repository \`${repo}\``;
      // exec's message opens with "Command failed: <the command>"; the line after it is the cause.
      const cause = detail.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('Command failed:'))[0];
      this.tell(
        'warn',
        `The worktree setup command (ordewell.worktreeSetupCommand or ORDEWELL_WORKTREE_SETUP) failed in ${where}, so its task worktrees use the default links instead${cause ? `: ${cause}` : ''}`,
      );
    }
  }

  private tell(level: IsolationNoticeLevel, message: string): void {
    this.notifications[level](message);
    this.listener.notice(level, message);
  }
}
