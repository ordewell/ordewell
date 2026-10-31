import { flattenTasks, flattenTasksWithParents, pausedOnLimit, waitsForReset, type Task, type TaskReportTo, type TaskStatus } from '../models/Task';
import { resolveTaskRef, resolveUserTaskRef } from './TaskRefs';
import type { ExecutionActor, ExecutionCommandName, ExecutionRecord, ScriptConsent, ScriptResult, SupervisorLevel } from '../models/Execution';
import { sameScriptBody, scriptBodyOf, scriptBodyText, type ScriptBody } from '../models/ScriptTask';
import { reportEnded, scriptResultOf, taskReport } from './taskReport';
import type { ApprovalDecision, ApprovalRequest, IApproval } from '../interfaces/IApproval';
import type { IsolationMergeResult, IsolationRevertResult } from '../interfaces/IWorktreeIsolation';
import { continuability } from './continuation';
import type { GuardTarget, GuardTrip } from './LoopGuards';
import { STOPPED_BEFORE_START, type StartAdmission } from './TaskOrchestrator';
import { waitOf, type StartWait } from './readiness';
import { escalationAct, type Escalation } from './escalations';
import { revertStopped, type RevertScope } from './taskRevert';
import { manualOverrideConfirmation, manualOverrideStopFirst, type OverrideDirection } from '../taskRow/texts';

/** One call at the command seam, as every route words it (ADR-0029). Task references are resolved here. */
export type ExecutionCommand =
  | { command: 'run_plan' }
  | { command: 'run_task'; task: string }
  | { command: 'stop_task'; task: string }
  | { command: 'stop_run' }
  /**
   * `session`: continue the saved runner session with `message` (ADR-0018, K1),
   * or resume a task paused on a usage limit in it, the message optional;
   * `fresh`: a new attempt from the task's prompt.
   */
  | { command: 'retry_task'; task: string; from: 'fresh' | 'session'; message?: string }
  /** `force`: the user's force send (ADR-0023, F1), which interrupts the running turn and is read next. */
  | { command: 'message_task'; task: string; text: string; force?: boolean }
  /** `answer` is checked here rather than typed: an `allow` must reach the seam to be refused with its reason. */
  | { command: 'answer_approval'; task: string; approval?: string; answer: string; note?: string }
  /** Merge all: the run's landed work into the user's branch (ADR-0013). */
  | { command: 'merge_all' }
  /** End a task as skipped: nothing it did lands, and its dependents go ahead without it once the work it waited on is done. `reason` is required of anyone but the user. */
  | { command: 'skip_task'; task: string; reason?: string }
  /** The user's force start: past a failed dependency or a merge gate, queued behind dependencies still under way (ADR-0035). */
  | { command: 'force_start'; task: string }
  /**
   * The user vouches for the task's work, which lands as a passed verdict's
   * would; never anyone else (ADR-0029). An AI or script task is refused while
   * a run could advance it, and otherwise needs `confirmed`: the user's yes to
   * {@link manualOverrideConfirmation}, which a call cannot imply. `seen` is
   * the status the user was asked about: one that moved on since is refused.
   */
  | { command: 'mark_complete'; task: string; confirmed?: boolean; seen?: TaskStatus }
  /** The user takes a completion back: the task is not started again, and held until it is retried or started. Confirmed as Mark complete is. */
  | { command: 'mark_not_done'; task: string; confirmed?: boolean; seen?: TaskStatus }
  /**
   * The user takes a task's landed work off the integration branch, before
   * Merge all, with its landed dependents (ADR-0054). Needs `confirmed`, their
   * yes to what the preview listed; `seen` is the task ids it listed, and a
   * set that changed since is refused.
   */
  | { command: 'revert_task'; task: string; confirmed?: boolean; seen?: string[] }
  /** Stop a structured task's running turn, keeping its session: it then waits for the user's message. */
  | { command: 'interrupt_task'; task: string }
  /** Force send a message queued behind the running turn (ADR-0023, F1); `id` is the one `message_task` answered with. */
  | { command: 'force_send_queued'; task: string; id: string }
  /** Take back a message still queued behind the running turn. */
  | { command: 'remove_queued'; task: string; id: string }
  /** Keep a task paused on a usage limit from resuming on its own at the reset: it waits for the user's Resume now or Retry. */
  | { command: 'cancel_resume'; task: string }
  /**
   * The answer to the checkpoint a task waits at: it goes on, or is told `reason`
   * to act on, which anyone but the user must give. The user's, or the
   * supervisor's at Act (ADR-0029).
   */
  | { command: 'answer_checkpoint'; task: string; answer: 'approve' | 'reject'; reason?: string }
  /** The user signs off the plan's review: every task in it is approved, as executing it approves them, and it runs. */
  | { command: 'approve_review' }
  /**
   * The planner's own exact effect (ADR-0035): a script task added to the plan
   * and started in one step, answered with its result, or after a minute as
   * still running. Exactly one of `commands` or `script`; `dependencies` are
   * references to tasks in the plan now.
   */
  | { command: 'run_script'; title: string; commands?: string[][]; script?: string; timeoutMs?: number; dependencies?: string[] };

type RunScript = Extract<ExecutionCommand, { command: 'run_script' }>;

/** What a control answers besides its line, for the surface whose button asked. */
export type CommandPayload =
  /** `message_task`: the queued message's id, which the surface's button answers with. */
  | { kind: 'message'; id: string }
  /** `force_start` queued behind dependencies still under way, rather than started: the line saying so. */
  | { kind: 'queued'; line: string }
  /**
   * The user's `merge_all`, merged or stopped: what the Merge all card
   * renders. Whether it closed the run is the Session's `run_closed` (ADR-0013).
   */
  | { kind: 'merge'; result: IsolationMergeResult }
  /** The user's `revert_task`, reverted or stopped: which tasks, or the task and files, or the commands that do it by hand. */
  | { kind: 'revert'; result: IsolationRevertResult };

/**
 * What a call came to: `message` is written for the caller, a model included,
 * to act on. A refusal carries a payload only where the act ran and stopped:
 * a Merge all that git would not take.
 */
export type CommandOutcome =
  | { ok: true; message: string; payload?: CommandPayload }
  | { ok: false; outcome: 'refused' | 'declined'; message: string; payload?: CommandPayload };

/** What the seam does with a valid command: run it, ask the user first, or refuse with a note the caller can act on. */
export type Consent = { kind: 'allow' } | { kind: 'ask' } | { kind: 'refuse'; reason: string };

/**
 * The effect allowlist (ADR-0035): the user's rule, by name, that covers every
 * command of a `commands` body, or null when none covers it all. A `script`
 * body is never covered.
 */
export type EffectAllowlist = (body: ScriptBody) => string | null;

/** No effect is pre-approved until the user's rules are read: the allowlist has no built-in entries. */
const NO_EFFECTS: EffectAllowlist = () => null;

/** How long `run_script` waits for its task to end before it answers that it is still running (ADR-0035). */
export const SCRIPT_ANSWER_WAIT_MS = 60_000;

/**
 * What a supervisor at `level` may do. The mandate (#23) replaces this check;
 * nothing above it moves.
 */
export type SupervisorPolicy = (level: SupervisorLevel, command: ExecutionCommandName) => Consent;

/**
 * The supervisor levels (ADR-0029). Off: it does not act. Watch: it reads and
 * suggests, and every execution command it calls is refused. Act: every
 * command runs without asking — choosing Act is the consent — inside the loop
 * guards; what a command may never do, like allowing an approval, is still
 * refused by the command itself.
 */
export const SUPERVISOR_LEVELS: SupervisorPolicy = (level) => {
  switch (level) {
    case 'act': return { kind: 'allow' };
    case 'watch': return { kind: 'refuse', reason: 'You are the supervisor at Watch: you read and suggest, and cannot run, stop, retry, skip or message tasks, run scripts, answer approvals or merge. Suggest it to the user instead; their reply is an ordinary message, and you can do it then.' };
    case 'off': return { kind: 'refuse', reason: 'The supervisor is off for this run, so it cannot act. Suggest it to the user instead.' };
  }
};

/**
 * A check that stops an actor spinning (ADR-0029's loop guards): the trip —
 * the note naming the guard and what would be accepted, and what the user is
 * told — or null to let the call through. Run once the call is valid and
 * consented to, before anyone is asked.
 */
export type LoopGuard = (actor: ExecutionActor, command: ExecutionCommand, target: GuardTarget | undefined) => GuardTrip | null;

/** A runner request waiting on a task, as the caller is shown it. */
export interface WaitingRequest {
  id: string;
  subject: string;
}

/**
 * What the seam reads and calls. The Session supplies it from the operations
 * behind the surfaces' buttons, so a command lands exactly as the matching
 * button press does, whoever asked.
 */
export interface ExecutionHost {
  /** The plan's task tree; null when there is no plan. */
  tasks(): readonly Task[] | null;
  /** The user approved the whole plan by executing it. */
  planApproved(): boolean;
  /** The user approved this task: it was in the plan they executed, or they started it themselves. */
  taskApproved(taskId: string): boolean;
  /** A task the scheduler leaves for the user to approve: added to the plan since they approved it (ADR-0035). */
  waitsForApproval(taskId: string): boolean;
  /** A start the user consented to approves these tasks, before it acts. */
  approve(taskIds: readonly string[]): void;
  /** A start under Full with autorun makes the plan approved, as autorun's own start does, so nothing later in the session is refused for it (ADR-0030). */
  approvePlan(): void;
  /** Full autonomy: starts follow plan approval without a question. */
  autonomous(): boolean;
  /** The user's autorun setting, as it is now (ADR-0030). */
  autorun(): boolean;
  /** The scheduler is driving the plan: ready tasks start as slots free. */
  scheduling(): boolean;
  /** An open planner turn holds the scheduler's new starts until its reply ends. */
  startsHeld(): boolean;
  /** Work is running right now. */
  hasLiveWork(): boolean;
  /** A usage limit holds the run: what it paused resumes at the reset. */
  runHeld(): boolean;
  /** A scheduled run is open, driving the plan or held by a usage limit that gives it back, whether or not anything is live. */
  scheduledRun(): boolean;
  /** Something will start without being asked again: a start admitted and not yet claimed, or a scheduled resume. */
  startsPending(): boolean;
  /** A plan the turn in flight submitted, whose start autorun makes as the turn ends (ADR-0030): a start on its way that no run holds yet. */
  submittedStartWaits(): boolean;
  /** Something will run this loop's check between rounds without being asked; see {@link TaskOrchestrator.loopRunsOn}. */
  loopRunsOn(taskId: string): boolean;
  /** Something could move a task on without being asked: a start, an attempt in any phase, the scheduler or a usage-limit hold. */
  advancesOnItsOwn(): boolean;
  /** Admit a start that waits before it claims; see {@link StartAdmission}. */
  admitStart(): StartAdmission;
  /** The task's attempt is live: starting, running or landing. */
  running(taskId: string): boolean;
  /** A conflict repair of the task will start by itself: there is a start to withdraw (ADR-0015). */
  repairOwed(taskId: string): boolean;
  maxParallel(): number;
  /** The run waits on the user to stash or skip isolation before anything starts. */
  runBlocked(): boolean;
  /**
   * Every reason the task cannot start now, from the scheduler's one start
   * rule (ADR-0034). Takes the task, not its id: the one the seam located.
   */
  startWaits(task: Readonly<Task>): readonly StartWait[];
  /** The runner requests waiting on a task for an answer. */
  waitingRequests(taskId: string): readonly WaitingRequest[];
  /** A start is told who asked: whether a run it opens continues the last one depends on it (ADR-0029). */
  runPlan(actor: ExecutionActor): Promise<void>;
  /**
   * Execute while a run is under way: the run takes in the tasks approved, each
   * starting once its dependencies finish. The user's Execute approves every
   * task first, `approved` of which had waited; the planner's approves none, and
   * `left` still wait. Answers the line that says so.
   */
  joinRun(approved: number, left: number): Promise<string>;
  /** The fresh chance the user's Execute gives what failed, for work it takes in (ADR-0053); none while the scheduler drives the run. */
  readyFailed(): void;
  startTask(taskId: string, actor: ExecutionActor): Promise<void>;
  /** Force start the task; answers the line saying it waits for its dependencies, when it was queued behind them rather than started. */
  forceStart(taskId: string): Promise<string | undefined>;
  markComplete(taskId: string): Promise<void>;
  markNotDone(taskId: string): Promise<void>;
  /** What reverting the task would take, as far as the plan can say; see {@link TaskOrchestrator.revertScope}. */
  revertScope(taskId: string): RevertScope;
  /** Revert the task's landed work, through the queue it shares with landings. */
  revertTask(taskId: string): Promise<IsolationRevertResult>;
  interrupt(taskId: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  stopRun(): void;
  /** The user's Stop found nothing to stop: what was admitted before it is withdrawn all the same. */
  stopAsked(): void;
  retryTask(taskId: string, actor: ExecutionActor): Promise<void>;
  /** End the task as skipped, landing nothing of it; see {@link TaskOrchestrator.skipTask}. */
  skipTask(taskId: string, reason: string | undefined, actor: ExecutionActor): Promise<void>;
  continueTask(taskId: string, message: string, actor: ExecutionActor): Promise<void>;
  /** Resume a task paused on a usage limit now; see {@link TaskOrchestrator.resumeNow}. */
  resumeNow(taskId: string, message: string | undefined, actor: ExecutionActor): Promise<void>;
  messageTask(taskId: string, text: string): string;
  /** Force send (ADR-0023, F1): interrupt the running turn and deliver this next. */
  forceMessage(taskId: string, text: string): string;
  /** False once the message was delivered. */
  forceSendQueued(taskId: string, id: string): boolean;
  /** False once the message was delivered or taken back. */
  removeQueued(taskId: string, id: string): boolean;
  /** False when no resume was scheduled. */
  cancelResume(taskId: string): Promise<boolean>;
  /** The task waits at a checkpoint, and a runner is left to hear the answer. */
  awaitsCheckpoint(taskId: string): boolean;
  answerCheckpoint(taskId: string, approve: boolean, reason?: string): void;
  /** Sign off the review: the plan is the user's, and runs. */
  approveReview(): Promise<void>;
  /** Answer a runner's request, as its card does; false once it was answered or withdrawn. */
  answerRequest(requestId: string, decision: ApprovalDecision): boolean;
  /** Merge all, through the queue it shares with landings. */
  mergeAll(): Promise<IsolationMergeResult>;
  /** The plan's last isolated run closed with everything it landed merged into the user's branch, and no run has decided since. */
  runMerged(): boolean;
  /** Keep the call in the timeline, worded as `text`. */
  record(record: ExecutionRecord, text: string): void;
  /** A loop guard stopped a call: the user is told, as the supervisor's message. */
  guardTripped(trip: GuardTrip): void;
  /** The task an edit the open planner turn committed gave this handle; undefined when none did (ADR-0022 P2). */
  turnHandle(name: string): string | undefined;
  /**
   * The script task a `run_script` call would add (ADR-0035), checked as
   * edit_plan's add is, the supervisor's against its loop guards too — or
   * why it cannot be added. Not in the plan yet, so the start rule judges it
   * before anything changes.
   */
  draftScript(call: RunScript, actor: ExecutionActor): { ok: true; task: Task } | { ok: false; errors: string[] };
  /** Put a drafted script task in the plan now, unapproved. */
  addScript(task: Task, actor: ExecutionActor): void;
  /** Start an approved task once its merge gate opens, never past it; see {@link TaskOrchestrator.startAtGate}. */
  startAtGate(taskId: string): void;
  /** Settles once the task's attempt is over, `ms` have passed, or `signal` aborted, whichever is first. */
  awaitEnd(taskId: string, ms: number, signal?: AbortSignal): Promise<void>;
  /** The task's result is owed to the planner, in a turn acting for whoever started it (ADR-0037, R2, R3). */
  owe(taskId: string, to: TaskReportTo): void;
  /** What waits on a person now, derived afresh (ADR-0053). */
  escalations(): readonly Escalation[];
  /** Add the task that merges a conflicted task's branch by hand; false when it has no conflict left. */
  resolveConflict(taskId: string): Promise<boolean>;
  /** Replay the run a dirty checkout turned away, stashing first or for this run without isolation. */
  continueRun(how: 'stash' | 'shared'): Promise<void>;
  /** The end of a task's output, as a planner turn is told it; see {@link taskReport}. */
  reportTail(taskId: string): string | undefined;
}

export interface ExecutionCommandsDeps {
  host: ExecutionHost;
  /** The approval card channel a Guarded start asks through. */
  consent: Pick<IApproval, 'request'>;
  supervisor?: SupervisorPolicy;
  guards?: readonly LoopGuard[];
  /** What pre-approves a script's effect (ADR-0035); nothing does unless set. */
  effects?: EffectAllowlist;
  now?: () => string;
  /** How long `run_script` waits for its task's end; a minute unless set. */
  scriptWaitMs?: number;
}

/** Commands that start work: they need the user's approval of what they start, and ask in Guarded. */
const STARTS: ReadonlySet<ExecutionCommandName> = new Set(['run_plan', 'run_task', 'retry_task', 'force_start', 'approve_review', 'run_script']);

/**
 * What waits for a landing override, besides the starts: a skip restarts a run
 * that ended on a failure, so it would start work under the landing task.
 */
const HELD_BY_LANDING_OVERRIDE: ReadonlySet<ExecutionCommandName> = new Set([...STARTS, 'skip_task', 'revert_task']);

/** The user's own controls, by the names they press them by: a model asking for one is refused. */
const USERS_ONLY: Partial<Record<ExecutionCommandName, string>> = {
  force_start: 'Force start',
  mark_complete: 'Mark complete',
  mark_not_done: 'Mark not done',
  // It takes landed work off the branch: the user's own review decides that, never a model (ADR-0054).
  revert_task: 'Reverting a task',
  interrupt_task: 'Interrupt',
  force_send_queued: 'Force send',
  remove_queued: 'Taking back a queued message',
  cancel_resume: 'Cancelling a scheduled resume',
  approve_review: 'Approving the review',
};

const MERGE_IS_USERS = 'Merge all is the user\'s: they are in this conversation, and press Merge all themselves. Tell them the work is ready to merge.';

const NOT_APPROVED_YET = 'The user has not approved this plan yet: they approve it by executing it themselves (Execute plan). Ask them to.';

const CHECKPOINT_CARD = 'The user answers it from the task\'s checkpoint card (Approve or Reject): tell them what the runner asks and what you would answer, with why.';

const CHECKPOINT_IS_USERS = `A checkpoint is the user's to answer in their own turn: they are in this conversation. ${CHECKPOINT_CARD} Only the supervisor at Act answers one, in a wake-up turn.`;

/** The supervisor's own refusal for a checkpoint, by the level that denies it: the general one says the user's reply applies a suggestion, which a checkpoint's cannot. */
const CHECKPOINT_BELOW_ACT: Record<Exclude<SupervisorLevel, 'act'>, string> = {
  watch: `You are the supervisor at Watch: you read and suggest, and cannot answer a checkpoint. ${CHECKPOINT_CARD}`,
  off: `The supervisor is off for this run, so it cannot answer a checkpoint. ${CHECKPOINT_CARD}`,
};

const SKIP_IS_USERS = 'Skipping a task is the user\'s in their own turn: they are in this conversation, and skip it themselves. Suggest it, with why; only the supervisor at Act skips, in a wake-up turn.';

const SCRIPTS_ARE_THE_PLANNERS = 'run_script is the planner\'s: a person adds a script task to the plan and starts it themselves.';

const NO_PLAN_FOR_SCRIPT = 'There is no plan yet, so there is nowhere to add a script task. Submit a plan that holds it.';

const AUTORUN_JOINS_NOTHING = 'tasks are already running, and in Guarded autorun takes no plan into work under way. Run the plan yourself to start the rest.';
const AUTORUN_RESTARTS_NOTHING = 'a usage limit holds a task, and autorun takes no plan into that run. It resumes at its reset; run the plan yourself and the rest starts then.';

const OVERRIDE_LANDING = 'Another manual override is landing: wait for it to finish, then start or override again.';

const CONFLICT_ANSWERS = 'Add a resolver task, retry it, skip it or mark it complete.';

const ESCALATION_GONE = 'That is no longer waiting on you: it was answered, or the run moved on. Nothing was changed.';

const NEVER_ALLOWS = 'answer_approval never allows. A runner asks because its mode did not cover the request, and allowing it would widen the mode the plan gave the task. Deny it with a note saying what to do instead, or escalate it to the user.';

/** An act that ran and stopped short: refused, with what it did for the surface to show. */
class Stopped extends Error {
  constructor(message: string, readonly payload: CommandPayload | undefined) {
    super(message);
  }
}

interface Located {
  task: Task;
  ref: string;
  /** Paused on its runner's usage limit as the call arrived: a continue of it is a resume, worded as one once it has run. */
  paused: boolean;
}

interface Acted {
  message: string;
  payload?: CommandPayload;
}

/**
 * `approves`: the tasks the start runs that the user has not approved, which
 * a Guarded planner start in their turn asks them to approve rather than
 * being refused for. `act` is told whether a Stop came since the call was
 * admitted, for a start that goes on after an await of its own.
 */
type Prepared =
  | { refusal: string }
  /** Nothing to do and nothing to keep: answered ok, recorded nowhere. */
  | { nothing: string }
  | { act: (stopped: () => boolean) => Promise<Acted>; approves?: Located[] };

/**
 * The command seam (ADR-0029, #91): the one place an execution action
 * reaches the scheduler, whether the user, a planner turn or the supervisor
 * asked. It resolves the task, checks the call against the plan's state, who
 * asked and the user's approval, asks the user where consent needs a person,
 * runs the Session operation behind the matching button, and records the call
 * in the timeline with who asked. A refusal names the task and the reason,
 * worded for whoever asked to act on ({@link voiceOf}).
 */
export class ExecutionCommands {
  private readonly host: ExecutionHost;
  private readonly supervisor: SupervisorPolicy;
  private readonly guards: readonly LoopGuard[];
  private readonly effects: EffectAllowlist;
  private readonly now: () => string;
  private readonly scriptWaitMs: number;
  /**
   * The script tasks whose `run_script` card is open. Their consent is the
   * card's to give, to the body it shows: executing the plan meanwhile leaves
   * them out, or a no on the card would come after a yes it never gave.
   */
  private readonly carded = new Set<string>();
  /**
   * The AI or script tasks whose manual override is landing. One lands at a
   * time, and nothing starts meanwhile: a run requested under it would race
   * the work it is landing, which was judged against a plan with no run.
   */
  private readonly overriding = new Set<string>();

  constructor(private readonly deps: ExecutionCommandsDeps) {
    this.host = deps.host;
    this.supervisor = deps.supervisor ?? SUPERVISOR_LEVELS;
    this.guards = deps.guards ?? [];
    this.effects = deps.effects ?? NO_EFFECTS;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.scriptWaitMs = deps.scriptWaitMs ?? SCRIPT_ANSWER_WAIT_MS;
  }

  /**
   * `signal` ends a wait on the caller's behalf: `run_script` then answers
   * that its task is still running. A planner's call reads the plan as
   * committed, its own edits in the turn included (ADR-0022 P2).
   */
  async run(asked: ExecutionCommand, actor: ExecutionActor, signal?: AbortSignal): Promise<CommandOutcome> {
    if (asked.command === 'run_script') return this.runScript(asked, actor, signal);
    if (!this.host.tasks()) return { ok: false, outcome: 'refused', message: 'There is no plan yet, so there is nothing to run or stop.' };
    const located = 'task' in asked ? this.locate(asked.task, actor) : undefined;
    // A paused task has no turn to message: what is sent to it resumes it, and is consented to, guarded and recorded as that resume.
    const command: ExecutionCommand = asked.command === 'message_task' && located?.paused
      ? { command: 'retry_task', task: asked.task, from: 'session', message: asked.text }
      : asked;
    const consent = this.consent(actor, command.command);
    if ('task' in command && !located) {
      if (actor.kind === 'user') return this.refuse(command, actor, undefined, `There is no task "${command.task}" in this plan.`);
      return this.refuse(command, actor, undefined, `No task matches "${command.task}" in the current plan. Name it by id, "#order" (a subtask "#order.sub"), exact title, or the handle an edit_plan call of this reply gave it.`);
    }

    if (consent.kind === 'refuse') return this.refuse(command, actor, located, consent.reason);

    const first = this.prepare(command, actor, located);
    if ('refusal' in first) return this.refuse(command, actor, located, first.refusal);
    if ('nothing' in first) return { ok: true, message: first.nothing };
    // After the call's own refusals, which name the task an override is landing.
    if (this.overriding.size > 0 && HELD_BY_LANDING_OVERRIDE.has(command.command)) return this.refuse(command, actor, located, OVERRIDE_LANDING);
    const tripped = this.tripped(command, actor, located);
    if (tripped) return tripped;

    // A start counts as live work for Stop until it has acted — on the card, and while it starts (ADR-0029).
    const admission = STARTS.has(command.command) ? this.host.admitStart() : null;
    try {
      return await this.carryOut(command, actor, located, consent, first, admission);
    } finally {
      admission?.release();
    }
  }

  /**
   * The user's answer to an escalation (ADR-0053): the list derived afresh,
   * and the option chosen dispatched to the existing command for that wait, as
   * the user, so every check it has still applies and this adds no authority.
   * It takes no actor because it is the user's alone: no planner tool reaches
   * it, and the supervisor keeps its own tools. `confirmed` is the user's yes to
   * an option's `confirm`, which a choice cannot imply.
   */
  async answerEscalation(id: string, option: string, note?: string, confirmed = false): Promise<CommandOutcome> {
    const refused = (message: string): CommandOutcome => ({ ok: false, outcome: 'refused', message });
    const escalation = this.host.escalations().find((e) => e.id === id);
    if (!escalation) return refused(ESCALATION_GONE);
    const chosen = escalation.options.find((o) => o.id === option);
    if (!chosen) {
      const offered = escalation.options.map((o) => `"${o.id}"`);
      return refused(`"${option}" is not an answer to this: use ${offered.length < 2 ? offered.join('') : `${offered.slice(0, -1).join(', ')} or ${offered[offered.length - 1]}`}. Nothing was changed.`);
    }
    if (chosen.confirm && !confirmed) return refused(`${chosen.confirm} Nothing was changed: it needs your explicit yes.`);
    const act = escalationAct(escalation, chosen.id, note);
    if (act.kind === 'command') return this.run(act.command, { kind: 'user' });
    try {
      if (act.kind === 'continue-run') {
        await this.host.continueRun(act.how);
        return { ok: true, message: act.how === 'stash' ? 'Stashed your changes: the run goes on.' : 'The run goes on without isolation, this once.' };
      }
      const label = `task ${escalation.task?.ref} "${escalation.task?.title}"`;
      if (!(await this.host.resolveConflict(act.task))) return refused(`${capitalize(label)} has no conflict left to resolve.`);
      return { ok: true, message: `Added a task that resolves the conflict of ${label}.` };
    } catch (err) {
      return refused(err instanceof Error ? err.message : String(err));
    }
  }

  /** A valid, consented call, from the user's answer where one is needed to the act and its record. */
  private async carryOut(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, consent: Consent, first: Extract<Prepared, { act: unknown }>, admission: StartAdmission | null): Promise<CommandOutcome> {
    const stopped = () => admission !== null && !admission.current();
    let prepared = first;
    if (consent.kind === 'ask') {
      const plan = this.host.tasks();
      const allowed = await this.deps.consent.request(this.question(command, actor, located, first.approves));
      // A Stop clears the card as it withdraws the start: a no it answered for the user is not theirs.
      if (stopped()) return this.refuse(command, actor, located, STOPPED_BEFORE_START);
      if (!allowed) {
        this.keep(command, actor, located, 'declined');
        return { ok: false, outcome: 'declined', message: `The user did not approve: ${this.intent(command, located)}. Do not ask again unless they say so.` };
      }
      // Answering took time: the plan, or the task's state, may have moved on.
      if (this.host.tasks() !== plan) return this.refuse(command, actor, located, 'The plan changed while the user was asked, so nothing was done.');
      const again = this.prepare(command, actor, located);
      if ('refusal' in again) return this.refuse(command, actor, located, again.refusal);
      if ('nothing' in again) return { ok: true, message: again.nothing };
      prepared = again;
    }

    // Taken at the last check, before the start awaits anything: a planner edit landing while the spawn is
    // under way changes the plan, and the user consented to the plan as it was checked, not as it becomes.
    // Recorded before it acts too because the scheduler starts only approved tasks (ADR-0035), and a retry
    // or run it hands over is started by the scheduler.
    this.host.approve(this.consented(command, actor, located, prepared.approves));
    if (STARTS.has(command.command) && this.startsUnattended(actor)) this.host.approvePlan();
    let acted: Acted;
    try {
      acted = await prepared.act(stopped);
    } catch (err) {
      const refused = this.refuse(command, actor, located, err instanceof Error ? err.message : String(err));
      return err instanceof Stopped ? { ...refused, payload: err.payload } : refused;
    }
    // A Stop while the act awaited withdrew the start it reports, whichever verb it was: the claim under way
    // ended its attempt quietly, so only the seam's admission sees that the Stop came.
    if (stopped()) return this.refuse(command, actor, located, STOPPED_BEFORE_START);
    this.keep(command, actor, located, 'done', doneDetail(command));
    return { ok: true, message: acted.message, ...(acted.payload ? { payload: acted.payload } : {}) };
  }

  /**
   * `run_script` (ADR-0035): a script task the planner adds and starts in one
   * step, on the plan as committed, the turn's own edits included (ADR-0022
   * P2). Who may is ADR-0035's table ({@link scriptConsent}). A
   * card unanswered or denied leaves the task in the plan, unapproved, for the
   * user to start or remove: absence is denial (ADR-0008, T5). It takes the
   * merge gate and the Merge-all exclusion an ops task takes as it starts, and
   * answers with the task's result, or after a minute that it is still
   * running, when its end is owed to the planner as a report (ADR-0037, R2).
   */
  private async runScript(command: RunScript, actor: ExecutionActor, signal?: AbortSignal): Promise<CommandOutcome> {
    if (!this.host.tasks()) return this.refuse(command, actor, undefined, `${NO_PLAN_FOR_SCRIPT} ${this.startsUnattended(actor) ? 'It starts when your reply ends.' : 'The user approves it by executing the plan.'}`);
    const consent = this.scriptConsent(actor, scriptBodyOf({ type: 'script', commands: command.commands, script: command.script, timeoutMs: command.timeoutMs }));
    if (consent.kind === 'refuse') return this.refuse(command, actor, undefined, consent.reason);
    const draft = this.host.draftScript(command, actor);
    if (!draft.ok) return this.refuse(command, actor, undefined, `The script task was not added: ${draft.errors.join('; ')}`);
    const unready = this.scriptUnready(draft.task);
    if (unready) return this.refuse(command, actor, undefined, unready);
    if (this.overriding.size > 0) return this.refuse(command, actor, undefined, OVERRIDE_LANDING);
    const tripped = this.tripped(command, actor, undefined);
    if (tripped) return tripped;

    // Live work for Stop while the user is asked; the start takes its own admission as it claims.
    const admission = this.host.admitStart();
    let how: ScriptConsent | CommandOutcome;
    try {
      this.host.addScript(draft.task, actor);
      how = consent.kind === 'ask' ? await this.askForScript(command, actor, draft.task, admission) : consent.how;
      if ('by' in how) {
        this.host.approve([draft.task.id]);
        if (this.startsUnattended(actor)) this.host.approvePlan();
      }
    } finally {
      admission.release();
    }
    return 'by' in how ? this.startScript(command, actor, draft.task.id, how, signal) : how;
  }

  /** The card for a script task in the plan, unapproved: the consent it gives, or what the call comes to without it. */
  private async askForScript(command: RunScript, actor: ExecutionActor, draft: Readonly<Task>, admission: StartAdmission): Promise<ScriptConsent | CommandOutcome> {
    const added = this.located(draft.id);
    if (!added) return this.refuse(command, actor, undefined, 'The script task left the plan as it was added, so nothing ran.');
    let allowed: boolean;
    this.carded.add(draft.id);
    try {
      allowed = await this.deps.consent.request(this.question(command, actor, added));
    } finally {
      this.carded.delete(draft.id);
    }
    // The user's Stop withdrew the start; the task stays, as a card left unanswered leaves it.
    if (!admission.current()) return this.refuse(command, actor, added, STOPPED_BEFORE_START);
    if (!allowed) {
      this.keep(command, actor, added, 'declined');
      return { ok: false, outcome: 'declined', message: `The user did not approve running script ${describe(added)}: it stays in the plan, not approved, for them to start or remove. Do not ask again unless they say so.` };
    }
    // The yes was to the body on the card: one changed meanwhile is not what was consented to.
    const now = this.located(draft.id);
    if (!now || !sameScriptBody(now.task, draft) || (now.task.status !== 'pending' && now.task.status !== 'approved')) {
      return this.refuse(command, actor, now ?? added, `Script ${describe(added)} changed while the user was asked, so it was not started.`);
    }
    return { by: 'card' };
  }

  /**
   * The approved script task's start, and the answer: its result, or that it
   * waits at its merge gate or still runs, which owes the planner its end.
   */
  private async startScript(command: RunScript, actor: ExecutionActor, taskId: string, consent: ScriptConsent, signal: AbortSignal | undefined): Promise<CommandOutcome> {
    const to = reportTo(actor, consent);
    const started = this.located(taskId)!;
    const label = `script ${describe(started)}`;
    const answered = (result: ScriptResult, message: string, located: Located = started): CommandOutcome => {
      this.keep(command, actor, located, 'done', undefined, { consent, result });
      return { ok: true, message };
    };
    // Answering took time: what holds it now is read afresh.
    const waits = this.host.startWaits(started.task);
    const gate = (waitOf(waits, 'merge-gate')?.unmerged ?? []).flatMap((id) => this.located(id) ?? []);
    if (gate.length > 0) {
      this.host.startAtGate(taskId);
      this.host.owe(taskId, to);
      return answered('gated', `Added ${label}, approved to run, but it waits at its merge gate: the work of ${named(gate)} is not merged into the user's branch yet. It starts once the user merges it (Merge all), and its result reaches you in a run update when it ends. Tell the user.`);
    }
    const unready = this.scriptUnready(started.task);
    if (unready) return this.refuse(command, actor, started, `Approved ${label}, but it did not start: ${unready} It stays in the plan, approved: start it with run_task once that clears.`);
    try {
      await this.host.startTask(taskId, actor);
    } catch (err) {
      return this.refuse(command, actor, started, `Approved ${label}, but it did not start: ${err instanceof Error ? err.message : String(err)} It stays in the plan, approved: start it with run_task once that clears.`);
    }
    if (this.host.runBlocked()) {
      this.host.owe(taskId, to);
      return answered('running', `${MODEL_VOICE.blockedRun} ${capitalize(label)} is approved and starts once they do; its result reaches you in a run update when it ends.`);
    }
    await this.host.awaitEnd(taskId, this.scriptWaitMs, signal);
    // Read as the wait ends, not as it was told: an end that came since is answered here, never owed as well.
    const now = this.located(taskId);
    if (!now) return answered('stopped', `${capitalize(label)} was removed from the plan before it ended, so it has no result.`);
    if (reportEnded(now.task) || (!this.host.running(taskId) && now.task.status !== 'in_progress')) {
      return answered(scriptResultOf(now.task), `Ran ${label}. ${taskReport(now.task, this.host.reportTail(taskId))}`, now);
    }
    this.host.owe(taskId, to);
    return answered('running', `${capitalize(label)} is still running after a minute. Its result reaches you in a run update when it ends: tell the user so. Read its output meanwhile with task_output "${now.ref}".`, now);
  }

  /**
   * Why a script task cannot start as `run_script` would start it, but for its
   * merge gate, at which it waits: a dependency that failed or has not
   * finished, a Merge all under way, every slot taken. Null when it can.
   */
  private scriptUnready(task: Readonly<Task>): string | null {
    const waits = this.host.startWaits(task);
    const one = (n: number, a: string, b: string) => (n === 1 ? a : b);
    const failed = (waitOf(waits, 'blocked')?.failed ?? []).flatMap((id) => this.located(id) ?? []);
    if (failed.length > 0) return `Script task "${task.title}" would depend on ${named(failed)}, which failed. Retry ${one(failed.length, 'it', 'them')} first, or leave the dependency out.`;
    const unmet = (waitOf(waits, 'dependencies')?.waiting ?? []).flatMap((id) => this.located(id) ?? []);
    if (unmet.length > 0) {
      return `Script task "${task.title}" would depend on ${unmet.map((dep) => `${describe(dep)} (${depState(dep.task)})`).join(', ')}, which ${one(unmet.length, 'has', 'have')} not finished. Call run_script once ${one(unmet.length, 'it has', 'they have')}, or add the script task with edit_plan to run after ${one(unmet.length, 'it', 'them')}.`;
    }
    if (waitOf(waits, 'merging')) return 'A Merge all is under way, and a script task never runs alongside one. Call run_script again once it has finished.';
    if (waitOf(waits, 'merge-gate')) return null;
    const live = this.all().filter(({ task: t }) => this.host.running(t.id)).length;
    if (live >= this.host.maxParallel()) return `${live} tasks are already running, the most this session runs at once. Wait for one to finish, or stop one first.`;
    return null;
  }

  /**
   * Who may run a script without the mandate (#23), as ADR-0035's table says.
   * An effect the user's allowlist covers runs in every row but one, and is
   * recorded by its rule. In the user's turn: otherwise autorun in Full runs
   * it, on a first plan as on an approved one (ADR-0030), and failing that
   * they are asked on the card. The supervisor's level decides for it first:
   * at Watch it is refused, to suggest it instead, covered or not; at Act it
   * runs, the task it adds being approved (ADR-0029).
   */
  private scriptConsent(actor: ExecutionActor, body: ScriptBody | null): { kind: 'allow'; how: ScriptConsent } | { kind: 'ask' } | { kind: 'refuse'; reason: string } {
    // A rule the user wrote covers the whole of a `commands` body, or nothing does.
    const covered = (): ScriptConsent | undefined => {
      const rule = body && 'commands' in body ? this.effects(body) : null;
      return rule ? { by: 'allowlist', rule } : undefined;
    };
    switch (actor.kind) {
      case 'user':
      case 'autorun': return { kind: 'refuse', reason: SCRIPTS_ARE_THE_PLANNERS };
      case 'supervisor': {
        const level = this.supervisor(actor.level, 'run_script');
        return level.kind === 'allow' ? { kind: 'allow', how: covered() ?? { by: 'act' } } : level;
      }
      case 'planner-turn': {
        const how: ScriptConsent | undefined = covered() ?? (this.startsUnattended(actor) ? { by: 'autorun' } : undefined);
        return how ? { kind: 'allow', how } : { kind: 'ask' };
      }
    }
  }

  /**
   * Of the tasks a planner edit wrote, the ones autorun approves as the edit
   * commits. Under Full every one of them, a rewritten script's new body
   * included, for the user's turn and a supervisor at Act alike. Otherwise only
   * in the user's turn, and all but a script task, which runs unasked only
   * where `run_script` would run it unasked (ADR-0035), so under Guarded it
   * waits for the user unless their effect allowlist covers it. Its row shows
   * the body verbatim, and starting it is their consent.
   */
  autorunApproves(actor: ExecutionActor, written: readonly Readonly<Task>[]): string[] {
    if (!this.host.autorun()) return [];
    if (this.startsUnattended(actor)) return written.map((t) => t.id);
    if (actor.kind !== 'planner-turn') return [];
    return written.filter((t) => t.type !== 'script' || this.scriptConsent(actor, scriptBodyOf(t)).kind === 'allow').map((t) => t.id);
  }

  /**
   * A task `run_script` answered for before it ended has ended: its result
   * joins the timeline beside its start, with who asked and how it was
   * consented to (ADR-0035).
   */
  scriptEnded(taskId: string, to: TaskReportTo): void {
    const located = this.located(taskId);
    if (!located) return;
    const actor: ExecutionActor = to.actor === 'supervisor' ? { kind: 'supervisor', level: to.level } : { kind: 'planner-turn' };
    this.keep({ command: 'run_script', title: located.task.title }, actor, located, 'done', undefined, { consent: to.consent, result: scriptResultOf(located.task), ended: true });
  }

  private tripped(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined): CommandOutcome | null {
    for (const guard of this.guards) {
      const trip = guard(actor, command, located);
      if (!trip) continue;
      const refused = this.refuse(command, actor, located, trip.refusal);
      this.host.guardTripped(trip);
      return refused;
    }
    return null;
  }

  /**
   * The tasks a start approves, read from the plan as it stands at the
   * command's last check. Autorun starts a plan as the user's standing
   * instruction, so its start approves what it runs as the user's does; so
   * does a start under Full with autorun. Under Guarded it leaves a script task
   * the commit left unapproved: that waits for the user (ADR-0035). A yes on
   * the card approves the tasks the card named, and no others.
   */
  private consented(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, named: readonly Located[] = []): string[] {
    if (!STARTS.has(command.command)) return [];
    if (this.asksToApprove(actor)) return named.flatMap(({ task }) => withSubtasks(task));
    if (actor.kind !== 'user' && actor.kind !== 'autorun' && !this.startsUnattended(actor)) return [];
    if (located) return withSubtasks(located.task);
    const leaves = (task: Readonly<Task>) => actor.kind === 'autorun' && !this.host.autonomous() && task.type === 'script' && !this.host.taskApproved(task.id);
    return this.all().filter(({ task }) => !leaves(task)).map(({ task }) => task.id).filter((id) => !this.carded.has(id));
  }

  /**
   * With autorun on and Full, nobody is asked: a planner turn, or a supervisor
   * its level lets act, may start anything, on a first plan as on an approved
   * one (ADR-0030). Read at each start, so switching either off stops it at
   * once. Below Act the level has refused the call before this is read.
   */
  private startsUnattended(actor: ExecutionActor): boolean {
    const acts = actor.kind === 'planner-turn' || (actor.kind === 'supervisor' && this.supervisor(actor.level, 'run_plan').kind === 'allow');
    return acts && this.host.autorun() && this.host.autonomous();
  }

  /**
   * Guarded means "ask the user first": a planner start in the user's own
   * turn asks, so tasks they have not approved go into the question rather
   * than refusing it. The supervisor's starts stay within what the user
   * approved (ADR-0029).
   */
  private asksToApprove(actor: ExecutionActor): boolean {
    return actor.kind === 'planner-turn' && this.consent(actor, 'run_task').kind === 'ask';
  }

  /**
   * Who may do what without the mandate (#23): the user's own call needs no
   * consent, and their own controls are theirs alone; a planner turn may
   * always end or steer work, and starts it only as the autonomy level says;
   * the supervisor's level decides for it.
   */
  private consent(actor: ExecutionActor, command: ExecutionCommandName): Consent {
    const control = USERS_ONLY[command];
    if (control && actor.kind !== 'user') return { kind: 'refuse', reason: usersOnly(command, control) };
    if (command === 'answer_checkpoint') return this.checkpointConsent(actor);
    switch (actor.kind) {
      case 'user':
      case 'autorun': return { kind: 'allow' };
      // A merge by proxy would add a route to the user's branch for nothing: they are present, and can press it (ADR-0029).
      case 'planner-turn': if (command === 'merge_all') return { kind: 'refuse', reason: MERGE_IS_USERS };
        // Skip decides that work will not be waited for: the user decides that, or a supervisor they let act.
        if (command === 'skip_task') return { kind: 'refuse', reason: SKIP_IS_USERS };
        return !STARTS.has(command) || this.host.autonomous() ? { kind: 'allow' } : { kind: 'ask' };
      case 'supervisor': return this.supervisor(actor.level, command);
    }
  }

  /**
   * A checkpoint asks a person for judgement on the work, so the user answers
   * it from the task's card; the supervisor may only at Act, in a wake-up turn
   * (ADR-0029). A planner turn is in the user's own conversation, and autorun
   * only starts plans.
   */
  private checkpointConsent(actor: ExecutionActor): Consent {
    switch (actor.kind) {
      case 'user': return { kind: 'allow' };
      case 'supervisor': {
        const consent = this.supervisor(actor.level, 'answer_checkpoint');
        return consent.kind === 'refuse' && actor.level !== 'act' ? { kind: 'refuse', reason: CHECKPOINT_BELOW_ACT[actor.level] } : consent;
      }
      case 'planner-turn':
      case 'autorun': return { kind: 'refuse', reason: CHECKPOINT_IS_USERS };
    }
  }

  /**
   * Whether the command can run now, and how, judged against `tasks`: the
   * plan as committed. Read afresh after a question, since answering takes
   * time.
   */
  private prepare(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, tasks: readonly Task[] = this.host.tasks() ?? []): Prepared {
    switch (command.command) {
      case 'run_plan': return this.prepareRunPlan(actor, tasks);
      case 'run_task': return this.prepareStart(located!, actor, 'run', tasks);
      case 'retry_task': return command.from === 'fresh'
        ? this.prepareStart(located!, actor, 'retry', tasks)
        : located!.paused ? this.prepareResume(located!, actor, command.message) : this.prepareContinue(located!, actor, command.message);
      case 'stop_task': return this.prepareStop(located!);
      case 'stop_run': return this.prepareStopRun(actor);
      case 'message_task': return this.prepareMessage(located!, command, actor);
      case 'answer_approval': return this.prepareAnswer(located!, command, actor);
      case 'merge_all': return this.prepareMergeAll(actor);
      case 'skip_task': return this.prepareSkip(located!, actor, command.reason);
      case 'force_start': return this.prepareForceStart(located!);
      case 'mark_complete': return this.prepareMarkComplete(located!, command);
      case 'mark_not_done': return this.prepareMarkNotDone(located!, command);
      case 'revert_task': return this.prepareRevert(located!, command);
      case 'interrupt_task': return this.prepareInterrupt(located!);
      case 'force_send_queued': return this.prepareQueued(located!, command.id, 'force');
      case 'remove_queued': return this.prepareQueued(located!, command.id, 'remove');
      case 'cancel_resume': return this.prepareCancelResume(located!);
      case 'answer_checkpoint': return this.prepareCheckpoint(located!, command, actor);
      case 'approve_review': return this.prepareApproveReview();
      // Its task is not in the plan until the call adds it, so it has a path of its own: see runScript.
      case 'run_script': return { refusal: 'run_script adds its own task, so it is never judged against one.' };
    }
  }

  private prepareRunPlan(actor: ExecutionActor, tasks: readonly Task[]): Prepared {
    const all = this.all(tasks);
    const live = all.filter(({ task }) => this.host.running(task.id));
    const working = this.host.hasLiveWork();
    // No plan submitted asks to take a hold's run on (ADR-0030): that is the user's Execute.
    if (actor.kind === 'autorun' && !working && this.host.runHeld()) return { refusal: AUTORUN_RESTARTS_NOTHING };
    // A run that is open with nothing live is joined too: a new run would take back its pause and what failed in it (ADR-0018 U1, ADR-0053).
    // One a dirty checkout turned away has neither, and only a new run looks at the checkout again.
    if (working || this.host.runHeld() || (this.host.scheduledRun() && !this.host.runBlocked())) {
      const waiting = all.filter(({ task }) => this.host.waitsForApproval(task.id) && !this.carded.has(task.id));
      // Autorun under Guarded stays out of it: its join would approve a script task the user was never shown (ADR-0035).
      if (actor.kind === 'autorun' && !this.host.autonomous()) return { refusal: AUTORUN_JOINS_NOTHING };
      // The user's Execute, and autorun for them, approves what waits rather than restarting the run under way; counted before the approval it records.
      if (actor.kind === 'user' || actor.kind === 'autorun') {
        return {
          act: async () => {
            // The fresh chance is the user's to ask for: autorun's join leaves a failure as it is (ADR-0053).
            if (actor.kind === 'user') this.host.readyFailed();
            return { message: await this.host.joinRun(waiting.length, 0) };
          },
        };
      }
      // Tasks started one by one are no scheduled run, so nothing starts their dependents: this call makes them one.
      // It approves nothing, and the scheduler starts only approved tasks, so it grants what run_task already does (ADR-0035);
      // under Full with autorun it approves what waits, since nobody is asked there.
      const unattended = this.startsUnattended(actor);
      if (!unattended && !this.host.planApproved()) {
        return { refusal: `${NOT_APPROVED_YET} Tasks started with run_task are not a scheduled run, so their dependents start only once the user executes the plan.` };
      }
      return {
        act: async () => {
          await (unattended ? this.host.joinRun(waiting.length, 0) : this.host.joinRun(0, waiting.length));
          const held = unattended || waiting.length === 0 ? '' : ` ${capitalize(named(waiting))} ${waiting.length === 1 ? 'was' : 'were'} added after the user approved the plan, so ${waiting.length === 1 ? 'it waits' : 'they wait'} until they start ${waiting.length === 1 ? 'it' : 'them'} or execute the plan.`;
          const under = live.length === 0 ? '' : `${named(live)} ${live.length === 1 ? 'is' : 'are'} already running, and `;
          const limit = this.host.runHeld() ? ' A usage limit holds the run, so nothing starts before its reset.' : '';
          return { message: `The plan is running: ${under}each approved task starts as its dependencies finish.${limit}${held}` };
        },
      };
    }
    // A new run leaves a skipped task skipped, as it leaves a completed one done.
    const toRun = all.filter(({ task }) => task.type !== 'user' && task.status !== 'completed' && task.status !== 'skipped');
    if (toRun.length === 0) return { refusal: 'Every task has already completed: there is nothing left to run.' };
    let approves: Located[] = [];
    // Autorun is the user's standing instruction: its run is the user's approval, as Execute plan is, and so is a start it lets a planner make in Full.
    if (actor.kind !== 'user' && actor.kind !== 'autorun' && !this.startsUnattended(actor)) {
      // Executing the plan is how the user first takes it as theirs, so no card stands in for it.
      if (!this.host.planApproved()) {
        return { refusal: NOT_APPROVED_YET };
      }
      approves = toRun.filter(({ task }) => !this.host.taskApproved(task.id));
      if (approves.length > 0 && !this.asksToApprove(actor)) {
        const one = approves.length === 1;
        return { refusal: `${capitalize(named(approves))} ${one ? 'was' : 'were'} added after the user approved the plan, so ${one ? 'it is' : 'they are'} not approved to run. Ask the user to execute the plan themselves, which approves ${one ? 'it' : 'them'}.` };
      }
    }
    return {
      ...(approves.length > 0 ? { approves } : {}),
      act: async () => {
        await this.host.runPlan(actor);
        if (this.host.runBlocked()) return { message: voiceOf(actor).blockedRun };
        const started = this.all().filter(({ task }) => this.host.running(task.id));
        if (started.length > 0) return { message: `The plan is running: ${named(started)} started, and the rest start as their dependencies finish.` };
        return {
          message: this.host.startsHeld()
            ? 'The plan is running: what is ready starts once this reply ends, and the rest as their dependencies finish.'
            : 'The plan is running; nothing could start yet. Read the plan to see what each task waits on.',
        };
      },
    };
  }

  /** A start of one task: `run_task`, or a fresh `retry_task`, which also takes a task that failed or waits on the user. */
  private prepareStart(located: Located, actor: ExecutionActor, how: 'run' | 'retry', tasks: readonly Task[]): Prepared {
    const { task } = located;
    const label = describe(located);
    const voice = voiceOf(actor);
    if (task.type === 'user') return { refusal: `${capitalize(label)} is a user task: ${voice.byHand}` };
    const completing = this.completingRefusal(located);
    if (completing) return { refusal: completing };
    if (this.host.running(task.id) || task.status === 'in_progress') {
      return { refusal: how === 'run' ? `${capitalize(label)} is already running.` : `${capitalize(label)} is running: ${voice.stopOrSteer}` };
    }
    if (task.status === 'completed') return { refusal: `${capitalize(label)} has already completed. ${voice.completed}` };
    const skipped = this.skippedRefusal(located, actor);
    if (skipped) return { refusal: skipped };
    // Only the user's retry starts a check's rounds over (ADR-0045 L7).
    const keepsRounds = how === 'run' || actor.kind !== 'user';
    const repeating = keepsRounds ? this.betweenRounds(located, tasks) : null;
    if (repeating) return { refusal: repeating };
    // Past that refusal, nothing else will run a check between rounds: this start is its next round.
    const nextRound = keepsRounds ? waitOf(this.host.startWaits(task), 'repeating') : undefined;
    const settled = !nextRound && (task.status === 'failed' || task.status === 'awaiting_user' || task.status === 'skipped');
    if (how === 'run' && settled) {
      const next = task.status === 'awaiting_user' && task.awaitingReason === 'input'
        ? voice.answerOrRetry
        : located.paused ? voice.resume : voice.retry;
      return { refusal: `${capitalize(label)} ${statusWords(task)}. ${next}` };
    }
    const waits = this.host.startWaits(task);
    // The start rule's `no-prompt`: a task with nothing to run is never started.
    if (waitOf(waits, 'no-prompt')) return { refusal: noPromptRefusal(label, task) };
    const failed = (waitOf(waits, 'blocked')?.failed ?? []).flatMap((id) => this.located(id, tasks) ?? []);
    if (failed.length > 0) {
      return { refusal: `${capitalize(label)} is blocked: ${named(failed)} failed. Retry ${failed.length === 1 ? 'it' : 'them'} first.` };
    }
    const approval = this.unapproved(located, actor);
    if (approval && 'refusal' in approval) return approval;

    const behind = this.heldBehind(located, waits, voice, tasks);
    if (behind) return { refusal: behind };
    // A retry under a running scheduler is left to it, as the Retry button leaves it, so only a start of our own takes a slot.
    const live = this.all(tasks).filter(({ task: t }) => this.host.running(t.id)).length;
    if (!(settled && this.host.scheduling()) && live >= this.host.maxParallel()) {
      return { refusal: `${live} tasks are already running, the most this session runs at once. Wait for one to finish, or stop one first.` };
    }

    return {
      ...approval,
      act: async (stopped) => {
        // The Retry button's own path: it continues a run that ended on a failure, and hands the task to a scheduler that runs.
        if (settled) await this.host.retryTask(task.id, actor);
        // A Stop while the retry let go of the old worktree withdrew the start that would follow it.
        if (stopped()) throw new Error(STOPPED_BEFORE_START);
        if (!this.host.running(task.id) && !(settled && this.host.scheduling())) await this.host.startTask(task.id, actor);
        if (this.host.runBlocked()) return { message: voice.blockedRun };
        const verb = how === 'run' || nextRound ? 'Started' : 'Retrying';
        return {
          message: this.host.running(task.id)
            ? `${verb} ${label}${nextRound ? `, as round ${nextRound.round} of ${nextRound.maxRounds}` : ''}.`
            : `${capitalize(label)} is back in the run and starts when a slot is free.`,
        };
      },
    };
  }

  /** Why the work this task builds on keeps a start of it, a fresh one or a continue, from running now; null when it does not. */
  private heldBehind(located: Located, waits: readonly StartWait[], voice: Voice, tasks?: readonly Task[]): string | null {
    const { task } = located;
    const label = describe(located);
    const check = this.located(waitOf(waits, 'loop-check')?.check ?? '', tasks);
    if (check) return `${capitalize(label)} is in the body of the loop of ${describe(check)}: it runs only if that check fails, and the loop starts it then.`;
    const unmet = (waitOf(waits, 'dependencies') ?? waitOf(waits, 'queued'))?.waiting.flatMap((id) => this.located(id, tasks) ?? []) ?? [];
    if (unmet.length > 0) {
      const one = unmet.length === 1;
      // Work reached through a skip is not a dependency the caller can see on the task.
      const behindSkip = unmet.some((dep) => !task.dependencies.includes(dep.task.id)) ? ': skipping a task does not skip the work behind it' : '';
      return `${capitalize(label)} depends on ${unmet.map((dep) => `${describe(dep)} (${depState(dep.task)})`).join(', ')}, which ${one ? 'has' : 'have'} not finished${behindSkip}. It can start once ${one ? 'it has' : 'they have'}.`;
    }
    // Judged whatever the task's status: a retry of a failed ops task acts on the checkout as a first start does.
    const gate = (waitOf(waits, 'merge-gate')?.unmerged ?? []).flatMap((id) => this.located(id, tasks) ?? []);
    if (gate.length > 0) return `${capitalize(label)} waits for Merge all: the work of ${named(gate)} is not merged into the user's branch yet. ${voice.passGate}`;
    return null;
  }

  /**
   * The user's force start goes past what the scheduler waits for, so only
   * what no start could get past is refused here; the start rule decides the
   * rest at the claim, and a dependency still under way queues it.
   */
  private prepareForceStart(located: Located): Prepared {
    const { task } = located;
    const label = describe(located);
    if (task.type === 'user') return { refusal: `${capitalize(label)} is a user task: ${USER_VOICE.byHand}` };
    if (this.host.running(task.id) || task.status === 'in_progress') return { refusal: `${capitalize(label)} is already running.` };
    if (task.status === 'completed') return { refusal: `${capitalize(label)} has already completed. ${USER_VOICE.completed}` };
    // A force start goes past a hold, a failure and a gate, but not the fact
    // that there is nothing to run (ADR-0034).
    if (waitOf(this.host.startWaits(task), 'no-prompt')) return { refusal: noPromptRefusal(label, task) };
    return {
      act: async () => {
        const queued = await this.host.forceStart(task.id);
        if (queued) return { message: queued, payload: { kind: 'queued', line: queued } };
        if (this.host.runBlocked()) return { message: USER_VOICE.blockedRun };
        return { message: this.host.running(task.id) ? `Started ${label}.` : `${capitalize(label)} is back in the run and starts when a slot is free.` };
      },
    };
  }

  /** Signing off the review approves every task in the plan, as executing it does: the seam records that before it acts. */
  private prepareApproveReview(): Prepared {
    return {
      act: async () => {
        await this.host.approveReview();
        return { message: this.host.runBlocked() ? USER_VOICE.blockedRun : 'Approved the plan: it runs, each task starting once its dependencies finish.' };
      },
    };
  }

  /**
   * Mark complete's landing owns the task until it settles: a stop, retry or
   * skip under it would end the attempt whose worktree it is merging, and the
   * landing would complete the task anyway.
   */
  private completingRefusal(located: Located): string | null {
    if (!waitOf(this.host.startWaits(located.task), 'completing')) return null;
    return `${capitalize(describe(located))} is being marked complete: its work is landing.`;
  }

  /**
   * Why an AI or script task is not the user's to override now, or null
   * (ADR-0029). Read here in the core, so a stale click, the CLI and the API
   * meet the same refusal; a manual task is the user's own sign-off and waits
   * for no run. Checked before anything about the task itself: a completed
   * task is held to it too.
   */
  private overrideBusy(located: Located, direction: OverrideDirection): string | null {
    if (located.task.type === 'user') return null;
    if (this.host.advancesOnItsOwn()) return manualOverrideStopFirst(direction, describe(located));
    return this.overriding.size > 0 ? OVERRIDE_LANDING : null;
  }

  /**
   * Whether the user's yes to this override is on the call, and about the task
   * as it is: a task that moved on since they were asked is another question.
   */
  private overrideUnconfirmed(located: Located, command: Extract<ExecutionCommand, { command: 'mark_complete' | 'mark_not_done' }>): string | null {
    const { task } = located;
    if (task.type === 'user') return null;
    const label = describe(located);
    if (command.seen !== undefined && command.seen !== task.status) {
      return `${capitalize(label)} has changed since you were asked: it ${statusWords(task)}. Nothing was changed; look at it again before deciding.`;
    }
    if (command.confirmed === true) return null;
    return `${manualOverrideConfirmation(command.command === 'mark_complete' ? 'complete' : 'uncomplete', label)} Nothing was changed: it needs the user's explicit yes, so ask them and send the command again with "confirmed": true.`;
  }

  /** The act of an override: the one landing while it awaits, so a start or a second override sees it. */
  private async overriddenBy(located: Located, act: () => Promise<void>): Promise<void> {
    if (located.task.type === 'user') return act();
    this.overriding.add(located.task.id);
    try {
      await act();
    } finally {
      this.overriding.delete(located.task.id);
    }
  }

  private prepareMarkComplete(located: Located, command: Extract<ExecutionCommand, { command: 'mark_complete' }>): Prepared {
    const { task } = located;
    const label = describe(located);
    const busy = this.overrideBusy(located, 'complete');
    if (busy) return { refusal: busy };
    if (task.status === 'completed') return { refusal: `${capitalize(label)} has already completed.` };
    if (this.completingRefusal(located)) return { refusal: `${capitalize(label)} is already being marked complete: its work is landing.` };
    const unconfirmed = this.overrideUnconfirmed(located, command);
    if (unconfirmed) return { refusal: unconfirmed };
    return {
      act: async () => {
        await this.overriddenBy(located, () => this.host.markComplete(task.id));
        // A landing that conflicts leaves the task for the user to resolve, and its row says so.
        return { message: this.located(task.id)?.task.status === 'completed' ? `Marked ${label} complete.` : `Marked ${label} complete, but its work could not land yet: its row says why.` };
      },
    };
  }

  private prepareMarkNotDone(located: Located, command: Extract<ExecutionCommand, { command: 'mark_not_done' }>): Prepared {
    const label = describe(located);
    const busy = this.overrideBusy(located, 'uncomplete');
    if (busy) return { refusal: busy };
    if (located.task.status !== 'completed') return { refusal: `${capitalize(label)} has not completed, so there is nothing to mark not done.` };
    const unconfirmed = this.overrideUnconfirmed(located, command);
    if (unconfirmed) return { refusal: unconfirmed };
    return {
      act: async () => {
        await this.overriddenBy(located, () => this.host.markNotDone(located.task.id));
        return { message: `Marked ${label} not done: it waits until you retry or start it.` };
      },
    };
  }

  /**
   * A revert asks nothing of the run, so unlike an override it waits for no
   * task that does not depend on the work (ADR-0054). What only git can say —
   * that it is in the user's branch, that it conflicts — it says as it runs,
   * in its turn on the queue.
   */
  private prepareRevert(located: Located, command: Extract<ExecutionCommand, { command: 'revert_task' }>): Prepared {
    const scope = this.host.revertScope(located.task.id);
    if (scope.refusal) return { refusal: scope.refusal.message };
    const takes = named(scope.taskIds.flatMap((id) => this.located(id) ?? []));
    if (command.seen && !sameIds(command.seen, scope.taskIds)) {
      return { refusal: `What reverting ${describe(located)} takes has changed since you were asked: it would revert ${takes}. Nothing was changed; look at it again before deciding.` };
    }
    if (command.confirmed !== true) {
      return { refusal: `Reverting ${describe(located)} would revert ${takes} on the integration branch. Nothing was changed: it needs the user's explicit yes, so ask them and send the command again with "confirmed": true.` };
    }
    return {
      act: async () => {
        let result: IsolationRevertResult | undefined;
        await this.overriddenBy(located, async () => { result = await this.host.revertTask(located.task.id); });
        // Set by the act just awaited.
        const ended = result!;
        if (ended.outcome !== 'reverted') throw new Stopped(revertStopped(ended), { kind: 'revert', result: ended });
        const one = ended.tasks.length === 1;
        return {
          message: `Reverted ${takes} on the integration branch: ${one ? 'it is' : 'they are'} back to not started and held until retried, ${one ? 'its' : 'their'} attempts and logs kept. A retry starts from the current tip, without this work.`,
          payload: { kind: 'revert', result: ended },
        };
      },
    };
  }

  private prepareInterrupt(located: Located): Prepared {
    const { task } = located;
    const label = describe(located);
    if (task.type === 'script') return { refusal: scriptHasNoTurn(label, 'interrupt') };
    if (!this.host.running(task.id)) return { refusal: `${capitalize(label)} is not running (it ${statusWords(task)}): there is no turn to interrupt.` };
    return {
      act: async () => {
        await this.host.interrupt(task.id);
        return { message: `Interrupted ${label}: it waits for your message.` };
      },
    };
  }

  private prepareCancelResume(located: Located): Prepared {
    const label = describe(located);
    if (!waitsForReset(located.task)) return { refusal: `${capitalize(label)} has no resume scheduled.` };
    return {
      act: async () => {
        if (!(await this.host.cancelResume(located.task.id))) throw new Error(`${capitalize(label)} has no resume scheduled.`);
        return { message: `${capitalize(label)} no longer resumes on its own at its usage limit's reset: resume it when you choose.` };
      },
    };
  }

  private prepareCheckpoint(located: Located, command: Extract<ExecutionCommand, { command: 'answer_checkpoint' }>, actor: ExecutionActor): Prepared {
    const label = describe(located);
    if (!this.host.awaitsCheckpoint(located.task.id)) {
      return { refusal: `${capitalize(label)} is not waiting at a checkpoint: it was answered already, withdrawn, or has no runner left to hear it.` };
    }
    const approve = command.answer === 'approve';
    const reason = command.reason?.trim() || undefined;
    if (!approve && !reason && actor.kind !== 'user') return { refusal: 'A rejection needs a reason: the runner is told it, and acts on it. Say what it should do instead.' };
    return {
      act: async () => {
        this.host.answerCheckpoint(located.task.id, approve, reason);
        const told = actor.kind === 'user' ? 'your reason' : 'the reason';
        return { message: approve ? `Approved the checkpoint of ${label}: it goes on.` : `Rejected the checkpoint of ${label}: the runner is told${reason ? ` ${told}` : ''}.` };
      },
    };
  }

  private prepareContinue(located: Located, actor: ExecutionActor, message: string | undefined): Prepared {
    const { task } = located;
    const label = describe(located);
    const voice = voiceOf(actor);
    if (this.host.running(task.id) || task.status === 'in_progress') {
      return { refusal: `${capitalize(label)} is running: ${voice.stopOrSteer}` };
    }
    const skipped = this.skippedRefusal(located, actor);
    if (skipped) return { refusal: skipped };
    if (actor.kind !== 'user') {
      const repeating = this.betweenRounds(located);
      if (repeating) return { refusal: repeating };
      const nextRound = waitOf(this.host.startWaits(task), 'repeating');
      if (nextRound) return { refusal: `${capitalize(label)} is between rounds of its loop, and nothing runs it on its own now, so a continue would start its rounds over: start it with run_task, which runs round ${nextRound.round} of ${nextRound.maxRounds}.` };
    }
    const eligible = continuability(task);
    if (!eligible.ok) return { refusal: `${eligible.reason} ${voice.startOver}` };
    if (!message?.trim()) return { refusal: `Continuing ${label} in its saved session needs a message: what the runner should do next.` };
    const approval = this.unapproved(located, actor);
    if (approval && 'refusal' in approval) return approval;
    // A continue is a retry whose first turn is the message (ADR-0018 K1), so what holds a retry holds it.
    const behind = this.heldBehind(located, this.host.startWaits(task), voice);
    if (behind) return { refusal: behind };
    return {
      ...approval,
      act: async () => {
        await this.host.continueTask(task.id, message, actor);
        if (this.host.runBlocked()) return { message: voice.blockedRun };
        return { message: `Continuing ${label} in its saved session with your message.` };
      },
    };
  }

  /**
   * A pause is not a failure: the attempt stopped on its account's limit, so
   * its saved session goes on where it was, told the limit has reset. The
   * message is what to add to that; none is needed.
   */
  private prepareResume(located: Located, actor: ExecutionActor, message: string | undefined): Prepared {
    const { task } = located;
    const label = describe(located);
    const voice = voiceOf(actor);
    const eligible = continuability(task);
    if (!eligible.ok) return { refusal: `${eligible.reason} ${voice.startOver}` };
    const approval = this.unapproved(located, actor);
    if (approval && 'refusal' in approval) return approval;
    const text = message?.trim();
    return {
      ...approval,
      act: async () => {
        await this.host.resumeNow(task.id, text || undefined, actor);
        if (this.host.runBlocked()) return { message: voice.blockedRun };
        return { message: `Resumed ${label} in its saved session${text ? ' with your message' : ''}.` };
      },
    };
  }

  private prepareStop(located: Located): Prepared {
    const { task } = located;
    const label = describe(located);
    const completing = this.completingRefusal(located);
    if (completing) return { refusal: completing };
    if (!this.host.repairOwed(task.id) && !this.host.running(task.id) && task.status !== 'in_progress') {
      return { refusal: `${capitalize(label)} is not running (it ${statusWords(task)}): there is nothing to stop.${this.conflictNext(task)}` };
    }
    return {
      act: async () => {
        await this.host.stopTask(task.id);
        const now = this.located(task.id)?.task;
        if (now?.status === 'awaiting_user' && now.awaitingReason === 'conflict') return { message: `Stopped the repair of ${label}: its merge conflict waits for you, and its work is kept. ${CONFLICT_ANSWERS}` };
        if (task.type === 'script') return { message: `Stopped ${label}: what it was running was ended, and it is back to not started and held until it is retried. A retry runs its body again from the first step.` };
        return { message: `Stopped ${label}: it is back to not started and held until it is retried, and its open approvals were denied.${task.ops ? ' A retry is told what this attempt did.' : ''}` };
      },
    };
  }

  /** What a refused Stop of a conflicted task can do instead: nothing runs it, so there is something else to press. */
  private conflictNext(task: Readonly<Task>): string {
    const resolver = this.located(waitOf(this.host.startWaits(task), 'resolver')?.resolver ?? '');
    if (resolver) return ` Its conflict is with ${describe(resolver)}: stop that task, or let it finish.`;
    return task.status === 'awaiting_user' && task.awaitingReason === 'conflict' ? ` ${CONFLICT_ANSWERS}` : '';
  }

  private prepareStopRun(actor: ExecutionActor): Prepared {
    const live = this.all().filter(({ task }) => this.host.running(task.id));
    // A start admitted but not yet claimed would begin after a refused Stop, so it is a run to stop too, as is the one a submitted plan waits on (ADR-0030).
    const pending = this.host.startsPending() || this.host.submittedStartWaits();
    if (!this.host.hasLiveWork() && !this.host.scheduling() && !pending) {
      if (actor.kind !== 'user') return { refusal: 'Nothing is running: there is no run to stop.' };
      // The user's Stop pressed after the run ended is no request to refuse: the surface already shows it stopped. It still stands against what was admitted before it.
      this.host.stopAsked();
      return { nothing: 'Nothing is running: there is nothing to stop.' };
    }
    return {
      act: async () => {
        this.host.stopRun();
        return {
          message: live.length > 0
            ? `Stopped the run: ${named(live)} ${live.length === 1 ? 'is' : 'are'} back to not started, and the plan is kept. ${voiceOf(actor).startAgain}`
            : pending
              ? 'Stopped the run before anything more started: nothing was running, and what was about to start will not. The plan is kept.'
              : 'Stopped the run; nothing was running. The plan is kept.',
        };
      },
    };
  }

  private prepareMessage(located: Located, command: Extract<ExecutionCommand, { command: 'message_task' }>, actor: ExecutionActor): Prepared {
    const label = describe(located);
    if (located.task.type === 'script') return { refusal: scriptHasNoTurn(label, 'message') };
    if (command.force && actor.kind !== 'user') return { refusal: usersOnly('message_task', 'Force send') };
    if (this.host.awaitsCheckpoint(located.task.id)) {
      return { refusal: `${capitalize(label)} is at a checkpoint${actor.kind === 'user' ? ':' : ', which a message does not answer:'} ${voiceOf(actor).atCheckpoint}` };
    }
    return {
      act: async () => {
        if (command.force) {
          const id = this.host.forceMessage(located.task.id, command.text);
          return { message: `Sent to ${label} now: its turn is interrupted, and the runner reads it next.`, payload: { kind: 'message', id } };
        }
        const id = this.host.messageTask(located.task.id, command.text);
        return { message: `Sent to ${label}. The runner reads it at its next step, or when its turn ends.`, payload: { kind: 'message', id } };
      },
    };
  }

  /** A message queued behind the running turn, sent now or taken back; one delivered meanwhile is past either. */
  private prepareQueued(located: Located, id: string, how: 'force' | 'remove'): Prepared {
    const label = describe(located);
    return {
      act: async () => {
        const done = how === 'force' ? this.host.forceSendQueued(located.task.id, id) : this.host.removeQueued(located.task.id, id);
        if (!done) throw new Error(`That message to ${label} was already delivered${how === 'remove' ? ' or taken back' : ''}.`);
        return {
          message: how === 'force'
            ? `Sent your queued message to ${label} now: its turn is interrupted, and the runner reads it next.`
            : `Took back your queued message to ${label}.`,
        };
      },
    };
  }

  /**
   * The user answers a runner's request as its card does. Anyone else only
   * narrows or hands it on: allowing would widen the mode the plan gave the
   * task (ADR-0029).
   */
  private prepareAnswer(located: Located, command: Extract<ExecutionCommand, { command: 'answer_approval' }>, actor: ExecutionActor): Prepared {
    const label = describe(located);
    const answer = command.answer.trim().toLowerCase();
    const note = command.note?.trim() || undefined;
    let decision: ApprovalDecision | 'escalate';
    if (actor.kind === 'user') {
      if (answer === 'allow') decision = { decision: 'allow' };
      else if (answer === 'allowfortask') decision = { decision: 'allowForTask' };
      else if (answer === 'deny') decision = { decision: 'deny', ...(note ? { note } : {}) };
      else return { refusal: `"${command.answer}" is not an answer: use "allow", "allowForTask" or "deny".` };
    } else {
      if (answer === 'allow' || answer === 'allowfortask') return { refusal: NEVER_ALLOWS };
      if (answer === 'deny') decision = { decision: 'deny', ...(note ? { note } : {}) };
      else if (answer === 'escalate') decision = 'escalate';
      else return { refusal: `"${command.answer}" is not an answer: use "deny" or "escalate".` };
    }
    const waiting = this.host.waitingRequests(located.task.id);
    const listed = waiting.map((r) => `${r.id} (${r.subject})`).join('; ');
    if (waiting.length === 0) return { refusal: `${capitalize(label)} has no request waiting for an answer.` };
    const request = command.approval === undefined && waiting.length === 1 ? waiting[0] : waiting.find((r) => r.id === command.approval);
    if (!request) {
      return {
        refusal: command.approval === undefined
          ? `${capitalize(label)} has ${waiting.length} requests waiting: ${listed}. Name one with "approval".`
          : `No request "${command.approval}" waits on ${label}. Its requests: ${listed}.`,
      };
    }
    return {
      act: async () => {
        if (decision === 'escalate') return { message: `Left ${label}'s request (${request.subject}) for the user to answer. Tell them why in your reply.` };
        if (!this.host.answerRequest(request.id, decision)) throw new Error(`The request ${request.id} was answered meanwhile.`);
        if (decision.decision !== 'deny') return { message: `Allowed ${label}'s request (${request.subject})${decision.decision === 'allowForTask' ? ' for the rest of the task' : ''}.` };
        return { message: `Denied ${label}'s request (${request.subject}).${note ? ' The runner is given your note.' : ''}` };
      },
    };
  }

  private prepareMergeAll(actor: ExecutionActor): Prepared {
    const users = actor.kind === 'user';
    // A Merge all asked for after the run's own merged everything and closed it
    // — at its end, or as the run settled mid-turn — is a request with nothing
    // left to do, not a fault for the timeline (ADR-0029). A plan that never
    // isolated is still refused, by Merge all itself.
    if (this.host.runMerged()) {
      return { nothing: `Nothing to merge: everything the run landed is in ${users ? 'your' : 'the user\'s'} branch already, and the run is closed.` };
    }
    return {
      act: async () => {
        const result = await this.host.mergeAll();
        // Only the user's surface draws the card; a model acts on the line.
        const payload: CommandPayload | undefined = users ? { kind: 'merge', result } : undefined;
        if (result.outcome !== 'merged') throw new Stopped(`Merge all stopped: ${mergeStopped(result)}. ${voiceOf(actor).notMerged}`, payload);
        return {
          message: `Merged the run's landed work into ${users ? 'your' : 'the user\'s'} branch. Tasks waiting at a merge gate for it can start.`,
          ...(payload ? { payload } : {}),
        };
      },
    };
  }

  /**
   * A skip is a decision not to wait for the task. Running it again undoes
   * that decision, so the supervisor leaves it to the user rather than going
   * round between the two.
   */
  private skippedRefusal(located: Located, actor: ExecutionActor): string | null {
    if (located.task.status !== 'skipped' || actor.kind !== 'supervisor') return null;
    return `${capitalize(describe(located))} was skipped: whether it runs again is the user's to decide. Tell them if it should.`;
  }

  /**
   * Why a loop's check between rounds is not started from the seam: something
   * will run it, once its body has landed, or nothing will and its body has
   * yet to land (ADR-0045 L5). Each says only what is true of it. Null for any
   * other task, and for a check whose fix has landed that nothing else will
   * run, which a start runs as its next round rather than leave it stranded.
   */
  private betweenRounds(located: Located, tasks?: readonly Task[]): string | null {
    const repeating = waitOf(this.host.startWaits(located.task), 'repeating');
    if (!repeating) return null;
    const fix = repeating.waiting.flatMap((id) => this.located(id, tasks) ?? []);
    const round = `round ${repeating.round} of ${repeating.maxRounds}`;
    const landed = `once ${named(fix)} ${fix.length === 1 ? 'has' : 'have'} passed and landed`;
    const between = `${capitalize(describe(located))} is between rounds of its loop`;
    if (this.host.loopRunsOn(located.task.id)) return `${between}: it runs again on its own, as ${round}, ${fix.length > 0 ? landed : 'next'}. Leave it to the loop.`;
    return fix.length > 0 ? `${between}, and nothing runs it on its own now: it can start as ${round} ${landed}.` : null;
  }

  /**
   * A skip ends a task without a verdict and lands nothing, so it never
   * vouches for work. Anyone but the user names why, and the supervisor only
   * gives up on a task that already needs someone: failed, blocked, or
   * waiting for input.
   */
  private prepareSkip(located: Located, actor: ExecutionActor, reason: string | undefined): Prepared {
    const { task } = located;
    const label = describe(located);
    const why = reason?.trim() || undefined;
    const completing = this.completingRefusal(located);
    if (completing) return { refusal: completing };
    if (task.status === 'in_progress') return { refusal: `${capitalize(label)} is running: ${voiceOf(actor).stopOrWait}` };
    if (task.status === 'completed') return { refusal: `${capitalize(label)} has completed: its work landed, so there is nothing to skip.` };
    if (task.status === 'skipped') return { refusal: `${capitalize(label)} is already skipped.` };
    if (actor.kind !== 'user') {
      if (!why) return { refusal: `Skipping ${label} needs a reason: it is shown to the user and told to the tasks that depend on it.` };
      const waits = this.host.startWaits(task);
      // A check between rounds needs no one while something runs it on (ADR-0045 L3); stranded, it is failed like any task.
      if (waitOf(waits, 'repeating') && this.host.loopRunsOn(task.id)) return { refusal: `${capitalize(label)} is between rounds of its loop, which goes on by itself: it needs no one, so the supervisor does not skip it.` };
      const needsSomeone = task.status === 'failed' || task.status === 'awaiting_user' || waitOf(waits, 'blocked') !== undefined;
      if (!needsSomeone) return { refusal: `${capitalize(label)} has not started and nothing blocks it: the supervisor skips only a task that failed, is blocked or is waiting for input.` };
    }
    return {
      act: async () => {
        await this.host.skipTask(task.id, why, actor);
        return { message: `Skipped ${label}: none of its work lands, and the tasks that depend on it go ahead without it once the work it waited on is done, told why.` };
      },
    };
  }

  /**
   * Why a start is not the user's to have made, or the task it asks them to
   * approve, or null: the user's own call is its own approval.
   */
  private unapproved(located: Located, actor: ExecutionActor): { refusal: string } | { approves: Located[] } | null {
    if (actor.kind === 'user' || actor.kind === 'autorun' || this.startsUnattended(actor) || this.host.taskApproved(located.task.id)) return null;
    const label = describe(located);
    if (!this.host.planApproved()) {
      return { refusal: `The user has not approved ${label}: they approve the plan by executing it themselves (Execute plan), or a task by starting it. Ask them to.` };
    }
    if (this.asksToApprove(actor)) return { approves: [located] };
    return { refusal: `${capitalize(label)} was added after the user approved the plan, so it is not approved to run. Ask the user to start it, or to execute the plan, which approves it.` };
  }

  /**
   * The Guarded question, on the card the user answers other planner requests
   * on. It names every task a yes approves, since a yes is the user's
   * approval of them as Execute plan would be. A script task's body is on the
   * card whole (ADR-0035): the consent is to what will run, not to a
   * description of it.
   */
  private question(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, approves: readonly Located[] = []): ApprovalRequest {
    const subject = capitalize(this.intent(command, located));
    const script = located?.task.type === 'script' ? scriptBodyOf(located.task) : null;
    const how = located?.task.type === 'ai'
      ? ` It runs on ${located.task.assignedRunner}${located.task.taskMode ? ` in ${located.task.taskMode} mode` : ''}, as the plan set it.`
      : script
        ? ' Ordewell runs exactly what is shown, in order, at the workspace root, with no model.'
        : ' Each task runs on its runner, in the mode the plan set.';
    const one = approves.length === 1;
    const approving = command.command === 'run_script'
      ? ' Allowing approves it to run as shown; otherwise it stays in the plan, not approved, for you to start or remove.'
      : approves.length === 0 ? '' : command.command === 'run_plan'
        ? ` Allowing approves ${named(approves)}, added since you approved the plan, and starts ${one ? 'it' : 'them'} with the rest.`
        : ` Allowing approves ${named(approves)}, added since you approved the plan.`;
    const wants = script ? 'wants to run a script task' : 'wants to start work';
    const body = script ? scriptBodyText(script) : scriptsShown(approves);
    return {
      kind: 'task_start',
      perInvocation: true,
      subject,
      scope: subject,
      detail: `${actor.kind === 'supervisor' ? 'The supervisor' : 'The planner'} ${wants}.${approving}${how}`,
      ...(body ? { body } : {}),
    };
  }

  /** What was asked, as "start task #4 "Title"". */
  private intent(command: ExecutionCommand, located: Located | undefined): string {
    const label = located ? describe(located) : 'task' in command ? `"${command.task}"` : '';
    switch (command.command) {
      case 'run_plan': return 'run the plan';
      case 'run_task': return `start ${label}`;
      case 'retry_task': return command.from === 'fresh' ? `retry ${label}` : `${located?.paused ? 'resume' : 'continue'} ${label} in its saved session`;
      case 'stop_task': return `stop ${label}`;
      case 'stop_run': return 'stop the run';
      case 'message_task': return `message ${label}`;
      case 'answer_approval': return `answer ${label}'s request`;
      case 'merge_all': return 'merge all';
      case 'skip_task': return `skip ${label}`;
      case 'force_start': return `force start ${label}`;
      case 'mark_complete': return `mark ${label} complete`;
      case 'mark_not_done': return `mark ${label} not done`;
      case 'revert_task': return `revert ${label}`;
      case 'interrupt_task': return `interrupt ${label}`;
      case 'force_send_queued': return `force send a queued message to ${label}`;
      case 'remove_queued': return `take back a queued message to ${label}`;
      case 'cancel_resume': return `cancel the scheduled resume of ${label}`;
      case 'answer_checkpoint': return `answer the checkpoint of ${label}`;
      case 'approve_review': return 'approve the plan';
      case 'run_script': return located ? `run script ${label}` : `run a script task "${command.title}"`;
    }
  }

  private refuse(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, reason: string): CommandOutcome {
    this.keep(command, actor, located, 'refused', reason);
    return { ok: false, outcome: 'refused', message: reason };
  }

  private keep(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, outcome: ExecutionRecord['outcome'], detail?: string, script: Pick<ExecutionRecord, 'consent' | 'result' | 'ended'> = {}): void {
    const record: ExecutionRecord = {
      command: command.command,
      actor: actor.kind,
      ...(actor.kind === 'supervisor' ? { level: actor.level } : {}),
      ...(located ? { task: { id: located.task.id, ref: located.ref, title: located.task.title } } : {}),
      outcome,
      ...(detail ? { detail } : {}),
      ...script,
      at: this.now(),
    };
    this.host.record(record, describeExecution(record, command, located?.paused));
  }

  private all(tasks: readonly Task[] = this.host.tasks() ?? []): Located[] {
    return flattenTasksWithParents(tasks).map(({ task, ref }) => ({ task, ref, paused: pausedOnLimit(task) }));
  }

  private located(id: string, tasks?: readonly Task[]): Located | undefined {
    return this.all(tasks).find(({ task }) => task.id === id);
  }

  /**
   * A reference as a caller writes one — see {@link resolveTaskRef}; the
   * user's as they type one ({@link resolveUserTaskRef}). A planner's may be
   * the handle an edit it committed in its turn gave the task (ADR-0022 P2).
   */
  private locate(ref: string, actor?: ExecutionActor, tasks: readonly Task[] = this.host.tasks() ?? []): Located | undefined {
    if (actor?.kind === 'user') {
      const task = resolveUserTaskRef(tasks, ref);
      return task && this.located(task.id, tasks);
    }
    const handled = actor ? this.host.turnHandle(ref.trim()) : undefined;
    const task = handled !== undefined ? flattenTasks(tasks).find((t) => t.id === handled) : resolveTaskRef(tasks, ref);
    return task && this.located(task.id, tasks);
  }
}

/** Whose turn a `run_script` task's result is owed to, and how it was consented to (ADR-0037, R3). */
function reportTo(actor: ExecutionActor, consent: ScriptConsent): TaskReportTo {
  return actor.kind === 'supervisor' ? { actor: 'supervisor', level: actor.level, consent } : { actor: 'planner-turn', consent };
}

/** Why a model may not use one of the user's own controls. */
function usersOnly(command: ExecutionCommandName, control: string): string {
  // Verdicts come from evidence: a vouch by proxy would land work nobody checked.
  if (command === 'mark_complete') return 'Mark complete is the user\'s alone: it lands the work as if someone had checked it, and only they vouch for work. If you think it is done, tell them why; they can mark it complete.';
  return `${control} is the user's own control: they are in this conversation, and press it themselves. Suggest it to them, with why.`;
}

/**
 * How a refusal, or a line about what follows, points the caller on: a model
 * is told the tools it calls and what to tell the user; the user is told the
 * controls they press. Chosen by who asked, in {@link voiceOf}, and nowhere
 * else.
 */
interface Voice {
  /** Why a user task is not started by anyone. */
  byHand: string;
  /** What to do with a task that runs instead of starting it again. */
  stopOrSteer: string;
  /** What to do with a running task instead of skipping it. */
  stopOrWait: string;
  /** What to do with a completed task instead of starting it. */
  completed: string;
  /** What to do with a task waiting for input instead of running it. */
  answerOrRetry: string;
  /** What to do with a task paused on its runner's usage limit instead of running it. */
  resume: string;
  /** What to do with a failed or skipped task instead of running it. */
  retry: string;
  /** What gets a task past its merge gate. */
  passGate: string;
  /** What starts a task over that cannot go on in its saved session. */
  startOver: string;
  /** How a stopped run starts again. */
  startAgain: string;
  /** A Merge all that stopped, after why. */
  notMerged: string;
  /** A start a dirty checkout held back. */
  blockedRun: string;
  /** What answers a task waiting at a checkpoint, which a message does not. */
  atCheckpoint: string;
}

const MODEL_VOICE: Voice = {
  byHand: 'the user does it by hand, and no runner starts it.',
  stopOrSteer: 'stop it first with stop_task, or steer it with message_task.',
  stopOrWait: 'stop it first with stop_task, or let it finish.',
  completed: 'Continue it with retry_task from "session" and a message, or ask the user to mark it not done.',
  answerOrRetry: 'Answer it with message_task, or start a new attempt with retry_task.',
  resume: 'Resume it in its saved session with retry_task from "session".',
  retry: 'Start a new attempt with retry_task.',
  passGate: 'Ask the user to merge (Merge all), or to force start it.',
  startOver: 'A fresh retry (from "fresh") starts it over from its prompt.',
  startAgain: 'Start again with run_plan or run_task.',
  notMerged: 'Nothing was merged; tell the user, who resolves it.',
  blockedRun: 'Nothing started: the user\'s checkout has uncommitted changes, and the run waits for them to stash them or run without isolation. Tell them.',
  atCheckpoint: 'the user answers it from the task\'s checkpoint card (Approve or Reject). Tell them what the runner asks and what you would answer, with why.',
};

/** The supervisor at Act answers checkpoints itself (ADR-0029); the planner's turn is the user's, and they answer. */
const SUPERVISOR_VOICE: Voice = {
  ...MODEL_VOICE,
  atCheckpoint: 'answer it with answer_checkpoint (approve, or reject with a reason), or leave it to the user and tell them why.',
};

const USER_VOICE: Voice = {
  byHand: 'you do it by hand, and no runner starts it.',
  stopOrSteer: 'stop it first, or send it a message.',
  stopOrWait: 'stop it first, or let it finish.',
  completed: 'Continue it with a message, or Mark it not done to run it again.',
  answerOrRetry: 'Answer it with a message, or Retry it.',
  resume: 'Resume it now in its saved session, or wait for its reset.',
  retry: 'Retry it to start a new attempt.',
  passGate: 'Merge all first, or force start it.',
  startOver: 'Retry starts it over from its prompt.',
  startAgain: 'Run the plan or a task to start again.',
  notMerged: 'Nothing was merged.',
  blockedRun: 'Nothing started: your checkout has uncommitted changes. Stash them, or run without isolation.',
  atCheckpoint: 'approve or reject it instead.',
};

function voiceOf(actor: ExecutionActor): Voice {
  switch (actor.kind) {
    case 'user': return USER_VOICE;
    case 'supervisor': return SUPERVISOR_VOICE;
    case 'planner-turn':
    case 'autorun': return MODEL_VOICE;
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const seen = new Set(a);
  return seen.size === new Set(b).size && b.every((id) => seen.has(id));
}

function withSubtasks(task: Readonly<Task>): string[] {
  return [task.id, ...task.subtasks.flatMap(withSubtasks)];
}

function describe({ task, ref }: Located): string {
  return `task ${ref} "${task.title}"`;
}

function named(tasks: readonly Located[]): string {
  const labels = tasks.map(describe);
  return labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A start of an AI task the plan gives no prompt: the start rule's `no-prompt`, in one wording (ADR-0034). */
/** A script task runs its body with no model (ADR-0035): nothing reads a message, and no turn can be interrupted. */
function scriptHasNoTurn(label: string, what: 'message' | 'interrupt'): string {
  return `${capitalize(label)} is a script task: it runs no model, so there is ${what === 'message' ? 'nothing to read a message' : 'no turn to interrupt'}. Stop it, or change its body with edit_plan and retry it.`;
}

/** The bodies of the script tasks a yes would approve, each under its task, for the card (ADR-0035). */
function scriptsShown(approves: readonly Located[]): string {
  return approves.flatMap((located) => {
    const body = located.task.type === 'script' ? scriptBodyOf(located.task) : null;
    return body ? [`${capitalize(describe(located))}:\n${scriptBodyText(body)}`] : [];
  }).join('\n\n');
}

function noPromptRefusal(label: string, task: Pick<Task, 'type'>): string {
  if (task.type === 'script') return `${capitalize(label)} has no body to run. Give it "commands" or a "script" first.`;
  return `${capitalize(label)} has no prompt, so there is nothing to run. Write one first.`;
}

const STATUS_WORDS: Record<TaskStatus, string> = {
  pending: 'has not started',
  approved: 'has not started',
  in_progress: 'is running',
  completed: 'has completed',
  failed: 'failed',
  awaiting_user: 'is waiting for the user',
  skipped: 'was skipped',
};

function statusWords(task: Readonly<Task>): string {
  if (task.status === 'awaiting_user' && task.awaitingReason === 'input') return 'is waiting for input';
  if (task.status === 'awaiting_user' && task.awaitingReason === 'checkpoint') return 'is waiting at a checkpoint for the user';
  if (task.status === 'awaiting_user' && task.awaitingReason === 'conflict') return 'is waiting on a merge conflict';
  if (pausedOnLimit(task)) return 'is paused on its runner\'s usage limit';
  return STATUS_WORDS[task.status];
}

/** Why a dependency does not count as finished yet; a completed one is done but its work has not landed. */
function depState(task: Readonly<Task>): string {
  return task.status === 'completed' ? 'done, not landed yet' : statusWords(task).replace(/^(is|has) /, '');
}

/** The extra a record keeps for a call that went through: the message it sent, or the note a denial carried. */
function doneDetail(command: ExecutionCommand): string | undefined {
  if (command.command === 'message_task') return command.text;
  if (command.command === 'retry_task' && command.from === 'session') return command.message;
  if (command.command === 'answer_approval') return command.note?.trim() || undefined;
  if (command.command === 'skip_task' || command.command === 'answer_checkpoint') return command.reason?.trim() || undefined;
  return undefined;
}

const WHO: Record<ExecutionActor['kind'], string> = {
  user: 'You',
  'planner-turn': 'The planner',
  supervisor: 'The supervisor',
  autorun: 'Autorun',
};

/** The timeline's line for one call: who asked, what, and how it ended. */
function describeExecution(record: ExecutionRecord, command: ExecutionCommand, paused = false): string {
  const who = WHO[record.actor];
  // A refusal for a task the plan does not have names it as the caller did.
  const label = record.task ? `task ${record.task.ref} "${record.task.title}"` : 'task' in command ? `"${command.task}"` : '';
  const continued = command.command === 'retry_task' && command.from === 'session' ? (paused ? 'resume' : 'continue') : null;
  if (record.ended) return `Script ${label}, which ${WHO[record.actor].toLowerCase()} ran, ${SCRIPT_ENDED[record.result ?? 'stopped']}`;
  if (record.outcome !== 'done') {
    const asked = {
      run_plan: 'run the plan',
      run_task: `start ${label}`,
      retry_task: continued ? `${continued} ${label}` : `retry ${label}`,
      stop_task: `stop ${label}`,
      stop_run: 'stop the run',
      message_task: `message ${label}`,
      answer_approval: `answer a request of ${label}`,
      merge_all: 'merge all',
      skip_task: `skip ${label}`,
      force_start: `force start ${label}`,
      mark_complete: `mark ${label} complete`,
      mark_not_done: `mark ${label} not done`,
      revert_task: `revert ${label}`,
      interrupt_task: `interrupt ${label}`,
      force_send_queued: `force send a queued message to ${label}`,
      remove_queued: `take back a queued message to ${label}`,
      cancel_resume: `cancel the scheduled resume of ${label}`,
      answer_checkpoint: `answer the checkpoint of ${label}`,
      approve_review: 'approve the plan',
      run_script: record.task ? `run script ${label}` : `run a script task${command.command === 'run_script' ? ` "${command.title}"` : ''}`,
    }[record.command];
    return record.outcome === 'declined'
      ? `${who} asked to ${asked}; you declined.${record.command === 'run_script' ? ' It stays in the plan, not approved.' : ''}`
      : `${who} asked to ${asked}; refused: ${record.detail ?? 'no reason given'}`;
  }
  const { action, tail } = doneWords(record, command, label, continued);
  // The supervisor and autorun act unattended, so their line reads as the action itself — the button press — and then who pressed it.
  return record.actor === 'supervisor' || record.actor === 'autorun'
    ? `${capitalize(action)}: by ${record.actor}${tail.startsWith(' ') ? `,${tail}` : tail}`
    : `${who} ${action}${tail}`;
}

/** What a call that went through did, and what follows it in the line: a full stop, the quoted message, or the note. */
function doneWords(record: ExecutionRecord, command: ExecutionCommand, label: string, continued: 'resume' | 'continue' | null): { action: string; tail: string } {
  const quoted = record.detail ? `: "${record.detail}"` : '.';
  switch (command.command) {
    case 'run_plan': return { action: 'started the plan', tail: '.' };
    case 'run_task': return { action: `started ${label}`, tail: '.' };
    case 'retry_task': return continued ? { action: `${continued}d ${label} in its saved session`, tail: quoted } : { action: `retried ${label}`, tail: '.' };
    case 'stop_task': return { action: `stopped ${label}`, tail: '.' };
    case 'stop_run': return { action: 'stopped the run', tail: '.' };
    case 'message_task': return { action: `${command.force ? 'force sent' : 'sent'} ${label} a message`, tail: quoted };
    case 'answer_approval': switch (command.answer.trim().toLowerCase()) {
      case 'escalate': return { action: `left a request of ${label} for you to answer`, tail: '.' };
      case 'allow': return { action: `allowed a request of ${label}`, tail: '.' };
      case 'allowfortask': return { action: `allowed a request of ${label} for the rest of the task`, tail: '.' };
      default: return { action: `denied a request of ${label}`, tail: record.detail ? ` with the note "${record.detail}".` : '.' };
    }
    case 'merge_all': return { action: 'merged the run\'s work into your branch', tail: '.' };
    case 'skip_task': return { action: `skipped ${label}`, tail: quoted };
    case 'force_start': return { action: `force started ${label}`, tail: '.' };
    case 'mark_complete': return { action: `marked ${label} complete`, tail: '.' };
    case 'mark_not_done': return { action: `marked ${label} not done`, tail: '.' };
    case 'revert_task': return { action: `reverted ${label}`, tail: '.' };
    case 'interrupt_task': return { action: `interrupted ${label}`, tail: '.' };
    case 'force_send_queued': return { action: `force sent a queued message to ${label}`, tail: '.' };
    case 'remove_queued': return { action: `took back a queued message to ${label}`, tail: '.' };
    case 'cancel_resume': return { action: `cancelled the scheduled resume of ${label}`, tail: '.' };
    case 'approve_review': return { action: 'approved the plan, which starts it', tail: '.' };
    case 'answer_checkpoint': return command.answer === 'reject' ? { action: `rejected the checkpoint of ${label}`, tail: quoted } : { action: `approved the checkpoint of ${label}`, tail: '.' };
    case 'run_script': return record.result === 'gated'
      ? { action: `added script ${label}, to run once its merge gate opens`, tail: `${consentWords(record.consent)}.` }
      : { action: `ran script ${label}`, tail: `${consentWords(record.consent)}${SCRIPT_RESULT[record.result ?? 'running']}` };
  }
}

/** How a script was consented to, as the timeline says it (ADR-0035). */
function consentWords(consent: ScriptConsent | undefined): string {
  switch (consent?.by) {
    case 'card': return ', which you approved on the card';
    case 'allowlist': return `, which your effect allowlist rule "${consent.rule}" covers`;
    case 'autorun': return ', under autorun in Full';
    case 'act': return ', at Act';
    case undefined: return '';
  }
}

const SCRIPT_RESULT: Record<ScriptResult, string> = {
  passed: ': it passed.',
  failed: ': it failed.',
  'changed-files': ': it passed, but changed tracked files and waits for you.',
  stopped: ': it was stopped before it ended.',
  running: ': it is still running.',
  gated: '.',
};

const SCRIPT_ENDED: Record<ScriptResult, string> = {
  passed: 'passed.',
  failed: 'failed.',
  'changed-files': 'passed, but changed tracked files and waits for you.',
  stopped: 'was stopped before it ended.',
  running: 'is still running.',
  gated: 'waits at its merge gate.',
};

/** How a Merge all ended, in a clause: why it stopped, for a model or a run update to read. */
export function mergeStopped(result: IsolationMergeResult): string {
  switch (result.outcome) {
    case 'merged': return 'it merged';
    case 'blocked': {
      const off = result.blocked.filter((b) => b.reason === 'wrong-branch');
      if (off.length === 0) return 'the user\'s checkout has changes that overlap what it would merge';
      return off.map((b) => `${b.repo === '.' ? 'the checkout' : b.repo} is ${b.actual ? `on ${b.actual}` : b.rebasing ? 'in the middle of a rebase' : 'on a detached HEAD'}, not ${b.expected}, which the run started on`).join('; ');
    }
    case 'conflict': return `it conflicts in ${result.repo}${result.files?.length ? `: ${result.files.slice(0, 5).join(', ')}` : ''}`;
    case 'failed': return `it failed in ${result.repo}`;
  }
}
