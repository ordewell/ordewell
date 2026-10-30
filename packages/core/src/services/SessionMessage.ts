import type { AccountLimitSnapshot } from '../models/AccountLimits';
import type { AwaitingReason, ConversationMessage, LegacyPlanState, PlanState, PendingPlanTurn, PlannerCompaction, ReplyRun, ResearchStep, RunnerId, RunSettings, SkillLoadNotice, SubagentOutcome, Task, TaskSkillNotice, TaskSnapshot, Verdict } from '../models/Task';
import type { SessionBilling, AttemptUsage, ContextFill, ModelUsage, PlanUsage, UsageTotals } from '../models/Usage';
import type { ExecutionRecord } from '../models/Execution';
import type { TaskLoop } from '../models/Loop';
import type { HandoffDigest } from '../models/Handoff';
import type { TaskLogEvent } from '../models/TaskLog';
import type { ApprovalKind } from '../interfaces/IApproval';
import type { ApprovalSource } from './ApprovalPolicy';
import type { Escalation } from './escalations';
import type { AutoMergeTrigger } from './TaskOrchestrator';
import type { IsolationHandoff, IsolationMergeResult, TaskIsolation } from '../interfaces/IWorktreeIsolation';
import type { QueuedTaskMessage } from '../interfaces/IRunner';
import { canContinue } from './continuation';
import { skillLoadNotice, surfaceStep } from '../conversation/records';
import { blockingFailures } from './blocking';

export type SerializedTaskStatus = {
  id: string;
  /** The task's type, so a status-only surface can tag a script task (ADR-0035); absent from an older daemon. */
  type?: Task['type'];
  status: Task['status'];
  /** `reported` tells a loop's check between rounds from one that failed (ADR-0045 L2). */
  verdict: { outcome: 'pass' | 'fail'; reason: string; checks: Verdict['checks']; reported?: Verdict['reported'] } | null;
  /** Advisory silence timestamp from VerdictEngine — not part of task status semantics. */
  idleSince?: string | null;
  /**
   * What the runner reported through `task_complete`, received while its
   * attempt winds down (ADR-0018, L1): a receipt, not the verdict, which
   * `verdict` and `status` carry once it is decided. Absent once the attempt
   * ends or a new turn voids the report, and never saved.
   */
  completionReceived?: NonNullable<Verdict['reported']>;
  /**
   * Which spawn of a starting runner waits for Ordewell's tools to connect
   * (ADR-0025): 1, then 2 after its one respawn. Nothing was sent to the
   * runner yet. Absent once they connect, and when the attempt ends; a second
   * miss holds the task, which `holdReason` says.
   */
  attaching?: 1 | 2;
  /** Absent unless the plan has an isolation run, so a shared-root plan's updates are unchanged. */
  isolation?: TaskIsolation;
  /** What an `awaiting_user` task waits on, when it was saved (ADR-0018, W1). */
  awaitingReason?: AwaitingReason;
  /** When a task paused on a usage limit resumes on its own (ISO time); absent when it waits for a manual retry. */
  resumeAt?: string;
  /** Why a `skipped` task was skipped; absent when no reason was given, and on any other status. */
  skipReason?: string;
  /** The whole question of the checkpoint the task waits at; absent when it waits at none. */
  checkpoint?: string;
  /** Messages waiting for a structured task's turn to end, oldest first; absent when there are none. */
  queued?: QueuedTaskMessage[];
  /** Set when the task can be continued in its saved runner session (ADR-0018, K1); the id itself stays in the daemon. */
  continuable?: true;
  /**
   * How many of a structured task's runner requests wait for an answer
   * (ADR-0018, A1) — "waiting for approval", which leaves `status` alone.
   * Absent when none do.
   */
  awaitingApproval?: number;
  /**
   * The ancestors an ops or user task waits on at its merge gate: their
   * work has landed but is not merged into the user's branch (ADR-0020).
   * Absent when it waits for no Merge all.
   */
  mergeGate?: string[];
  /** The ancestors, by title, a force start went past the merge gate of (ADR-0020). */
  forcedPastGate?: string[];
  /**
   * Added after the user approved the plan and not approved since, so the
   * scheduler leaves it for them (ADR-0035). Absent for any other task.
   */
  waitsForApproval?: true;
  /** Why a task is held out of auto-scheduling, in the user's words; absent when it is not held. */
  holdReason?: string;
  /** Set only on a research task, so a stream of statuses alone can say which task is one (ADR-0037). */
  research?: true;
  /** The latest attempt's handoff, as the plan keeps it (ADR-0047); absent when the attempt left none. */
  handoff?: HandoffDigest;
  /** An attempt has started: its chat exists from then on. Absent on a task never run. */
  attempted?: true;
  attemptUsage?: AttemptUsage[];
  /** Set only on a loop's check, so a stream of statuses alone can say which task is one (ADR-0045). */
  loop?: TaskLoop;
  /** The round a loop's check is in, past its first (ADR-0045 L5); absent on round 1 and on any other task. */
  loopRound?: number;
};

/**
 * Landed work not yet in the user's branch. `paused` means the running plan
 * waits at a merge gate with no attempts active.
 */
export interface RunMergeView {
  waitingAtGate: boolean;
  paused: boolean;
  repos: IsolationHandoff['repos'];
  landed: IsolationHandoff['landed'];
}

export type SerializedTask = {
  id: string;
  order: number;
  title: string;
  type: string;
  /** Without it a plan broadcast after a run reads as every task pending. */
  status: Task['status'];
  description: string;
  dependencies: string[];
  assignedRunner: RunnerId;
  assignedModel: Task['assignedModel'] | null;
  taskMode: string;
  prompt: string | null;
  subtasks: SerializedTask[];
  userSteps: Task['userSteps'];
  autonomy: Task['autonomy'];
  sliceType: Task['sliceType'];
  userStoriesCovered: Task['userStoriesCovered'];
  /** As on {@link SerializedTaskStatus}: only while the task is `awaiting_user`. */
  awaitingReason?: AwaitingReason;
  resumeAt?: string;
  /** As on {@link SerializedTaskStatus}: only while the task is `skipped`. */
  skipReason?: string;
  /** Set only on an ops task (ADR-0020). */
  ops?: true;
  research?: boolean;
  /** The latest attempt's handoff, as the plan keeps it (ADR-0047); absent when the attempt left none. */
  handoff?: HandoffDigest;
  /** Task skills attached by name; absent when none. */
  skills?: string[];
  /** Set only on a task an Act supervisor added (ADR-0029). */
  addedBy?: 'supervisor';
  /** An attempt has started: its chat exists from then on. Absent on a task never run. */
  attempted?: true;
  attemptUsage?: AttemptUsage[];
  /** A script task's body and time limit (ADR-0035); absent on any other task. */
  commands?: string[][];
  script?: string;
  timeoutMs?: number;
  /** Set only on a loop's check (ADR-0045). */
  loop?: TaskLoop;
  /** As on {@link SerializedTaskStatus}: only on a loop's check past its first round. */
  loopRound?: number;
};

/** Skill loads go out as notices: their bodies are for the planner, and stay in the session. */
export type SerializedConversationMessage = Omit<ConversationMessage, 'skill'> & { skill?: SkillLoadNotice };
export type SerializedPendingTurn = Omit<PendingPlanTurn, 'skills'> & { skills?: SkillLoadNotice[] };

/**
 * A task as a surface is sent it: its attempt's skills are notices, whole in
 * the session only, and its runner session id stays there too — no surface shows it,
 * and only a continue reads the runner's own session id.
 */
export type SurfaceTask<T extends Task = Task> = Omit<T, 'attemptSkills' | 'subtasks' | 'runnerSessionId'> & {
  attemptSkills?: TaskSkillNotice[];
  subtasks: SurfaceTask[];
};

/** A plan as the daemon and the VS Code webview are sent it: the session's own state, minus every skill body. */
export type SurfacePlan = Omit<LegacyPlanState, 'tasks' | 'conversationHistory' | 'pendingTurns' | 'queuedMessages'> & {
  tasks: SurfaceTask[];
  conversationHistory?: SerializedConversationMessage[];
  pendingTurns?: SerializedPendingTurn[];
};

/** The phase-tagged shape of {@link SurfacePlan}. */
export type SurfacePlanState =
  | (Omit<Extract<PlanState, { phase: 'planning' }>, 'pendingTasks'> & { pendingTasks: SurfaceTask[] })
  | (Omit<Extract<PlanState, { phase: 'executing' }>, 'pendingTasks' | 'executionLog'> & { pendingTasks: SurfaceTask[]; executionLog: SurfaceTask<TaskSnapshot>[] });

export type SerializedPlan = {
  runSettings?: LegacyPlanState['runSettings'];
  /** What waits on the planner's usage limit, and when it goes, so a surface can say so and offer to cancel it. */
  plannerResend?: LegacyPlanState['plannerResend'];
  /** The planner paused on its context, so a surface can say why and offer Retry compaction. */
  plannerContextPause?: LegacyPlanState['plannerContextPause'];
  tasks: SerializedTask[];
  runners: RunnerId[];
  generatedAt: string;
  conversationHistory?: SerializedConversationMessage[];
  prdMarkdown?: string;
};

/** How a planner turn ended: the reply kind it settled on, a user stop, or a failure. */
export type PlannerTurnOutcome = 'message' | 'plan' | 'task_ops' | 'stopped' | 'error';

/**
 * Everything a session tells its surfaces, over one broadcast seam.
 *
 * A planner turn (#47) streams between `planner_turn_started` and
 * `planner_turn_ended` with the same `turnId`; every turn-scoped message in
 * between carries it. The stream is provisional and the settled messages are
 * authoritative:
 * - `planner_message` settles the streamed text of each run it carries in that
 *   run's segment, where it streamed — a surface drops what it accumulated
 *   there and shows the run's text instead.
 * - A reply that is a JSON envelope (plan, taskOps, taskQuery) never arrives
 *   as `planner_text_delta`; it streams as `plan_token`, the "building plan"
 *   display.
 * - A subagent's own text never appears in the reply; its activity arrives
 *   tagged with its `subagentId`.
 */
export type SessionMessage =
  /**
   * The plan, whole. `turnId` names the planner turn whose commit this
   * broadcast carries, so the turn's building plan becomes the marker; it is
   * absent on every other broadcast of the plan.
   */
  | { type: 'plan_generated'; plan: SerializedPlan; goal: string; runners: RunnerId[]; turnId?: string }
  /**
   * The settled reply of a planner turn, emitted by the session once the turn
   * is classified. `turnId` is absent for replies sent outside a streamed turn.
   * `supervisor`: the supervisor said it in a wake-up turn (ADR-0029).
   * `runs`: what the reply shows, run by run, each authoritative over its
   * segment's `planner_text_delta`s; `content` stays the whole reply. Without
   * runs (a note the conversation wrote, an older daemon) the message is
   * authoritative over the turn's final segment.
   */
  | { type: 'planner_message'; content: string; timestamp: string; turnId?: string; supervisor?: true; runs?: ReplyRun[] }
  /**
   * A planner turn began. Emitted once per turn by whoever runs the turn,
   * before any other message carrying its `turnId`. `prompt` is the user's
   * message, as typed, when the turn answers one; `skills` are what its
   * `/name` tokens loaded, absent when none did. `wakeUps` are the wake-up
   * digests the turn delivers, shown ahead of the prompt; `supervisor` marks a
   * wake-up turn, which no user message opened (ADR-0029). `forced`: the
   * prompt was force sent, and this turn replaces the one it stopped.
   */
  | { type: 'planner_turn_started'; turnId: string; prompt?: string; skills?: SkillLoadNotice[]; wakeUps?: string[]; supervisor?: true; forced?: true }
  | { type: 'planner_skill_loaded'; turnId: string; skill: SkillLoadNotice }
  /**
   * A planner turn is over; nothing more carries its `turnId`. Emitted exactly
   * once per `planner_turn_started`, stop and failure included, after the
   * turn's `planner_message` when it has one. `forceSent`: a force send
   * stopped it, and the forced turn follows — the user did not stop the
   * conversation, so a surface keeps the prompts it holds (ADR-0023, F2).
   */
  | { type: 'planner_turn_ended'; turnId: string; outcome: PlannerTurnOutcome; forceSent?: true }
  /**
   * Reply prose as it streams, appended in order within its segment. A segment
   * is one continuous run of model text; text before a tool call is its own
   * segment, and a later segment never rewrites an earlier one. Never carries
   * a JSON envelope or a subagent's text (see the union's invariants).
   */
  | { type: 'planner_text_delta'; turnId: string; segmentId: string; text: string }
  /**
   * Exposed reasoning as it streams, from the planner or — tagged with
   * `subagentId` — from one of its subagents. Never part of the reply. The one
   * thinking message for every backend: `segmentId` is set only where the
   * backend streams thinking in segments (the API loops; harness planners do
   * not), and `turnId` is absent for thinking outside a turn (one-shot plans).
   */
  | { type: 'planner_thinking_delta'; turnId?: string; segmentId?: string; subagentId?: string; text: string }
  /**
   * Text streamed for an attempt the turn discarded (a corrective retry) is
   * taken back: a surface removes it. With `segmentId`, only that segment;
   * without, all of the turn's text not yet settled by a `planner_message`.
   * A segment that streamed to the plan display (`plan_token`) takes the
   * turn's building plan with it.
   */
  | { type: 'planner_text_retracted'; turnId: string; segmentId?: string }
  /**
   * The planner's running usage for the session, subagents included, emitted
   * after a model call reports usage. `totals` already contains every
   * `bySubagent` entry. `contextFill` is the context the main model's last
   * call left, with its window when known; omitted before a call was measured.
   * Cost appears only as reported by a provider or runner (see `UsageRecord`).
   */
  | {
      type: 'planner_usage';
      sessionBilling?: SessionBilling;
      byModel?: ModelUsage[];
      model?: string;
      turnId?: string;
      totals: UsageTotals;
      bySubagent?: Record<string, UsageTotals>;
      contextFill?: ContextFill;
    }
  /**
   * A subagent began work on `brief`. Emitted by the planner backend that
   * spawned it (ADR-0005 research agents, or a harness planner's own), before
   * any message tagged with its `subagentId`.
   */
  | { type: 'subagent_started'; turnId?: string; subagentId: string; brief: string; model?: string }
  /**
   * A subagent is done; nothing more is tagged with its `subagentId`. Emitted
   * once per `subagent_started`. `digest` is what it handed back to the
   * planner; `usage` is its own share, already counted in `planner_usage`.
   */
  | { type: 'subagent_finished'; turnId?: string; subagentId: string; outcome: SubagentOutcome; digest: string; usage?: UsageTotals }
  /**
   * One phase of a planner compaction (see {@link PlannerCompaction}); never a
   * subagent's, nor a task runner's. A surface folds both phases into one
   * block by `compaction.id`, and a repeat of either changes nothing. A
   * condensed one's summary arrives in the transcript, its checkpoint carrying
   * the same id. `turnId`: the turn it happened in; absent for a `/compact`,
   * which is no user turn. A fact, not a turn's stream: a stop never cuts it off.
   */
  | { type: 'planner_compaction'; compaction: PlannerCompaction; turnId?: string }
  /** `escalations`: what waits on a person now (ADR-0053), whole; absent from an older daemon. */
  | { type: 'status_update'; tasks: SerializedTaskStatus[]; runMerge?: RunMergeView; usage?: PlanUsage; activity?: RunActivity; escalations?: Escalation[] }
  | { type: 'review_needed'; tasks: SerializedTask[] }
  | { type: 'review_approved' }
  | { type: 'checkpoint'; taskId: string; taskTitle: string; summary: string }
  | { type: 'execution_complete'; summary: ExecutionSummary }
  | { type: 'execution_stopped' }
  // A call at the command seam (ADR-0029), with who made it: `text` is the
  // line the transcript keeps for it, so a reload shows what was shown live.
  | { type: 'execution_action'; record: ExecutionRecord; text: string }
  | { type: 'task_updated'; taskId: string; changes: Record<string, unknown> }
  | { type: 'task_started'; taskId: string; order: number; title: string; runner: RunnerId; modelId?: string }
  | { type: 'task_output'; taskId: string; text: string }
  /**
   * A structured task's log as it happens (ADR-0018, P1): the next events of
   * the task's attempt `attempt`, in order — the same ones appended to that
   * attempt's file, so a surface folding these and one replaying the file
   * draw the same blocks.
   */
  | { type: 'task_log'; taskId: string; attempt: number; events: TaskLogEvent[] }
  // A run did not start because tracked files are modified. It waits for the
  // user to stash (`continueWithStash`) or to run without isolation this once
  // (`continueWithoutIsolation`); nothing is spawned until then. `repos` names
  // the dirty repos of a group; a group of one names none.
  | { type: 'isolation_blocked'; reason: 'dirty'; repos?: string[]; message: string }
  // An isolated run settled: for each repo, the branch its work landed on and
  // the commit that branch forked from; and what landed, in plan order. Sent
  // before `execution_complete`, which surfaces treat as the end of the stream.
  // `deferredTo`: an Act supervisor handles it first; the unmarked handoff
  // that follows its wake-up turn, if the run is still unmerged, comes after.
  | { type: 'isolation_handoff'; repos: IsolationHandoff['repos']; landed: IsolationHandoff['landed']; deferredTo?: IsolationHandoff['deferredTo'] }
  // What "Merge all" did, for every surface watching rather than only the one
  // that asked: merged, blocked with each repo and why, or stopped part-way
  // with the repos that stay merged. `trigger`: Ordewell ran it by itself,
  // at a merge gate or at the run's end, with merge at gates automatically on.
  | { type: 'isolation_merge'; result: IsolationMergeResult; trigger?: AutoMergeTrigger }
  // The Session cleared the isolated run up and forgot it: a Merge all that
  // left nothing to hand over, or a discard. Sent after the `isolation_merge`
  // that caused it, and never for a merge that leaves the run going. The one
  // word on it: a surface folds this rather than guessing from a merge result.
  | { type: 'run_closed' }
  // Carries no content — see `ResearchProgress['liveness']`. Exists only so a
  // surface's idle watchdog sees the harness process working even during a
  // stretch that produces nothing visible.
  | { type: 'planner_liveness' }
  // `toolLabel` carries a harness planner's own name for the tool (ADR-0009) —
  // always set when `tool` is `agent_tool`, so no surface has to render the
  // catch-all member name at the user.
  | { type: 'research_step'; tool: string; toolLabel?: string; args: string; subagentId?: string; toolCallId?: string; turnId?: string }
  // The "building plan" display only: a JSON envelope as it streams, never
  // reply prose. `turnId` is absent for a one-shot plan, which has no turn.
  // `segmentId` names the segment the envelope streams in; a turn's next
  // envelope is a new segment, and the display starts over with it.
  | { type: 'plan_token'; token: string; turnId?: string; segmentId?: string }
  | { type: 'research_step_done'; step: ResearchStep; subagentId?: string; turnId?: string }
  // Planner research wants something outside its default envelope and is
  // blocked until a human answers. Broadcast rather than returned, because the
  // human may be on any surface (or several at once) and the request outlives
  // whichever HTTP call triggered it.
  | { type: 'approval_request'; id: string; kind: ApprovalKind; subject: string; scope: string; detail?: string; body?: string; turnId?: string }
  | { type: 'approval_settled'; id: string; granted: boolean }
  // A decision reached with no round-trip prompt: pre-approved via config,
  // remembered from earlier in this session, or the operator's mode floor
  // (allow/deny skipping the human entirely). The interactive path above
  // already has full visibility via approval_request/approval_settled; this
  // is the one that previously had none — a model silently auto-running
  // `npm test` because the scope was already granted looked identical, from
  // every UI, to it never having been asked in the first place.
  | {
      type: 'approval_decided';
      kind: ApprovalKind;
      subject: string;
      scope: string;
      detail?: string;
      granted: boolean;
      source: Exclude<ApprovalSource, 'asked'>;
    };

/**
 * A plan a surface read whole rather than off the message stream: a route's
 * answer, a loaded session. Folds into a {@link RunView} as a plan refresh.
 */
export type PlanSnapshot = { type: 'plan_snapshot'; plan: SurfacePlan | SurfacePlanState };

/** What only the status stream says about a task; a plan refresh keeps these as they were. */
export type RunTaskStatus = Partial<Pick<
  SerializedTaskStatus,
  'verdict' | 'idleSince' | 'completionReceived' | 'attaching' | 'isolation' | 'checkpoint' | 'queued' | 'continuable' | 'awaitingApproval' | 'mergeGate' | 'forcedPastGate' | 'waitsForApproval' | 'holdReason' | 'handoff' | 'attempted'
>>;

/** A task in the run view: the plan's fields, then the status stream's. */
export type RunTask = Omit<SerializedTask, 'subtasks'> & RunTaskStatus & { subtasks: RunTask[] };

/**
 * What the scheduler is doing with the plan, independent of any one task:
 * the authoritative word a surface shows a start by, and a guard reads before
 * acting on the plan. Kept apart from a task's status so a start that has not
 * claimed anything yet is never drawn as work in progress.
 */
export interface RunActivity {
  /** A start is admitted and has not claimed a task: work is on its way. */
  starting: boolean;
  /** At least one attempt is live. */
  running: boolean;
  /** The scheduler is driving the plan: ready tasks start as slots free. */
  scheduled: boolean;
  /** A run with nothing starting that something still resumes by itself (a usage limit's reset, a retry). */
  resumable: boolean;
  /**
   * Something could still move a task on without being asked: a start on its
   * way, a queued start behind its dependencies, an attempt in any phase, a
   * scheduler driving the plan, or a usage-limit hold. The same fact core
   * refuses a manual override on (ADR-0029), so a surface never asks a
   * question the seam would then refuse. A run that ended on a failure is not
   * here: overriding the failed task is the way out.
   */
  advancesOnItsOwn: boolean;
}

/** A run with nothing at work and nothing on its way. */
export const IDLE_ACTIVITY: RunActivity = { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false };

/**
 * A session's run as every surface draws it (the [run view](../../../../CONTEXT.md)):
 * folded from {@link SessionMessage}s and plan snapshots by `reduceRun`, or
 * taken whole from `Session.runSnapshot()` by a surface that joins late.
 */
export interface RunView {
  /** In plan order, subtasks nested under their parent. */
  tasks: RunTask[];
  runSettings?: RunSettings;
  runMerge: RunMergeView | null;
  usage?: PlanUsage;
  handoff: IsolationHandoff | null;
  mergeResult: IsolationMergeResult | null;
  /** What the scheduler is doing with the plan, as {@link RunActivity}. */
  activity?: RunActivity;
  /** What will not move without a person (ADR-0053), as the newest status update said; absent from an older daemon's snapshot. */
  escalations?: Escalation[];
}

export type RunInput = SessionMessage | PlanSnapshot;

/**
 * A line a run wants the user to read — how it isolates, what it shares. Not a
 * {@link SessionMessage}: hosts that show notices as toasts already do, and
 * widening the union would break every exhaustive switch over it. A host with
 * no toast channel (the daemon) hands these to its clients by its own means.
 */
export type SessionNotice = { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

export type SessionBroadcaster = (msg: SessionMessage) => void;

export function serializeTask(t: SurfaceTask): SerializedTask {
  return {
    id: t.id,
    order: t.order,
    title: t.title,
    type: t.type,
    status: t.status,
    description: t.description,
    dependencies: t.dependencies || [],
    assignedRunner: t.assignedRunner,
    assignedModel: t.assignedModel || null,
    taskMode: t.taskMode || 'build',
    prompt: t.prompt || null,
    subtasks: (t.subtasks || []).map(serializeTask),
    userSteps: t.userSteps || undefined,
    autonomy: t.autonomy || undefined,
    sliceType: t.sliceType || undefined,
    userStoriesCovered: t.userStoriesCovered || undefined,
    ...(t.status === 'awaiting_user' && t.awaitingReason ? { awaitingReason: t.awaitingReason } : {}),
    ...(t.status === 'awaiting_user' && t.awaitingReason === 'usage-limit' && t.resumeAt ? { resumeAt: t.resumeAt } : {}),
    ...(t.status === 'skipped' && t.skipReason ? { skipReason: t.skipReason } : {}),
    ...(t.ops ? { ops: true as const } : {}),
    ...(t.research !== undefined ? { research: t.research } : {}),
    ...(t.handoff ? { handoff: structuredClone(t.handoff) } : {}),
    ...(t.attempted ? { attempted: true as const } : {}),
    ...(t.attemptUsage ? { attemptUsage: structuredClone(t.attemptUsage) } : {}),
    ...(t.skills?.length ? { skills: [...t.skills] } : {}),
    ...(t.addedBy ? { addedBy: t.addedBy } : {}),
    ...(t.commands ? { commands: t.commands.map((argv) => [...argv]) } : {}),
    ...(t.script !== undefined ? { script: t.script } : {}),
    ...(t.timeoutMs !== undefined ? { timeoutMs: t.timeoutMs } : {}),
    ...(t.loop ? { loop: { body: [...t.loop.body], maxRounds: t.loop.maxRounds } } : {}),
    ...(t.loop && t.loopRound !== undefined ? { loopRound: t.loopRound } : {}),
  };
}

export function serializeTaskStatus(
  t: Task,
  idleSince: string | null = null,
  isolation: TaskIsolation | null = null,
  queued: readonly QueuedTaskMessage[] = [],
  awaitingApproval = 0,
  mergeGate: readonly string[] = [],
  checkpoint = '',
  waitsForApproval = false,
  holdReason: string | null = null,
  completionReceived: Verdict['reported'] | null = null,
  attaching: 1 | 2 | null = null,
): SerializedTaskStatus {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    verdict: t.verdict
      ? { outcome: t.verdict.outcome, reason: t.verdict.reason, checks: t.verdict.checks || [], ...(t.verdict.reported ? { reported: t.verdict.reported } : {}) }
      : null,
    idleSince,
    ...(completionReceived ? { completionReceived } : {}),
    ...(attaching ? { attaching } : {}),
    ...(t.attempted ? { attempted: true as const } : {}),
    ...(t.attemptUsage ? { attemptUsage: structuredClone(t.attemptUsage) } : {}),
    ...(isolation ? { isolation } : {}),
    ...(t.status === 'awaiting_user' && t.awaitingReason ? { awaitingReason: t.awaitingReason } : {}),
    ...(t.status === 'awaiting_user' && t.awaitingReason === 'usage-limit' && t.resumeAt ? { resumeAt: t.resumeAt } : {}),
    ...(t.status === 'awaiting_user' && t.awaitingReason === 'checkpoint' && checkpoint ? { checkpoint } : {}),
    ...(t.status === 'skipped' && t.skipReason ? { skipReason: t.skipReason } : {}),
    ...(queued.length > 0 ? { queued: queued.map((m) => ({ ...m })) } : {}),
    ...(canContinue(t) ? { continuable: true as const } : {}),
    ...(awaitingApproval > 0 ? { awaitingApproval } : {}),
    ...(mergeGate.length > 0 ? { mergeGate: [...mergeGate] } : {}),
    ...(t.forcedPastGate?.length ? { forcedPastGate: [...t.forcedPastGate] } : {}),
    ...(waitsForApproval ? { waitsForApproval: true as const } : {}),
    ...(holdReason ? { holdReason } : {}),
    ...(t.research ? { research: true as const } : {}),
    ...(t.handoff ? { handoff: structuredClone(t.handoff) } : {}),
    ...(t.loop ? { loop: { body: [...t.loop.body], maxRounds: t.loop.maxRounds } } : {}),
    ...(t.loop && t.loopRound !== undefined ? { loopRound: t.loopRound } : {}),
  };
}

function surfaceConversation(history: LegacyPlanState['conversationHistory']): SerializedConversationMessage[] | undefined {
  return history?.map(({ skill, ...m }) => (skill ? { ...m, skill: skillLoadNotice(skill) } : m));
}

function surfacePendingTurns(pending: LegacyPlanState['pendingTurns']): SerializedPendingTurn[] | undefined {
  return pending?.map(({ skills, ...t }) => (skills ? { ...t, skills: skills.map(skillLoadNotice) } : t));
}

export function surfaceTask<T extends Task>({ attemptSkills, subtasks, runnerSessionId: _runnerSessionId, ...task }: T): SurfaceTask<T> {
  return {
    ...task,
    ...(attemptSkills ? { attemptSkills: attemptSkills.map(({ name, source, path }): TaskSkillNotice => ({ name, source, path })) } : {}),
    subtasks: (subtasks ?? []).map(surfaceTask),
  };
}

/** The one place a plan's skill bodies come off before it leaves the session: every wire path that carries plan state goes through here. */
export function surfacePlan({ queuedMessages: _carriedOverAtLoad, ...plan }: LegacyPlanState): SurfacePlan {
  return {
    ...plan,
    tasks: plan.tasks.map(surfaceTask),
    conversationHistory: surfaceConversation(plan.conversationHistory),
    pendingTurns: surfacePendingTurns(plan.pendingTurns),
    researchLog: plan.researchLog?.map((e) => ('type' in e ? e : surfaceStep(e))),
  };
}

export function surfacePlanState(state: PlanState): SurfacePlanState {
  return state.phase === 'planning'
    ? { ...state, pendingTasks: state.pendingTasks.map(surfaceTask) }
    : { ...state, pendingTasks: state.pendingTasks.map(surfaceTask), executionLog: state.executionLog.map(surfaceTask) };
}

export function serializePlan(plan: LegacyPlanState): SerializedPlan {
  return {
    tasks: plan.tasks.map(serializeTask),
    runners: plan.runners,
    generatedAt: plan.generatedAt,
    runSettings: plan.runSettings,
    ...(plan.plannerResend ? { plannerResend: plan.plannerResend } : {}),
    ...(plan.plannerContextPause ? { plannerContextPause: plan.plannerContextPause } : {}),
    conversationHistory: surfaceConversation(plan.conversationHistory),
    prdMarkdown: plan.prdMarkdown,
  };
}

/**
 * What a finished run did, task by task: `blocked` are those a failure kept
 * from starting (ADR-0034); `skipped` ended without a verdict and landed
 * nothing, so they are neither completed nor failed.
 */
export interface ExecutionSummary {
  total: number;
  completed: number;
  failed: number;
  blocked: number;
  skipped: number;
}

export function executionSummary(tasks: readonly Task[]): ExecutionSummary {
  const blocked = blockingFailures(tasks);
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    blocked: tasks.filter((t) => blocked.has(t.id)).length,
    skipped: tasks.filter((t) => t.status === 'skipped').length,
  };
}

export const CHECKPOINT_TRUNCATE_LENGTH = 120;

/** Truncate a checkpoint summary to a single line of at most CHECKPOINT_TRUNCATE_LENGTH chars. */
export function truncateCheckpointSummary(summary: string): string {
  // Take the first line only (checkpoint summaries often contain reasoning across lines)
  const firstLine = summary.split('\n')[0].trim();
  if (firstLine.length <= CHECKPOINT_TRUNCATE_LENGTH) return firstLine;
  return firstLine.slice(0, CHECKPOINT_TRUNCATE_LENGTH - 1) + '…';
}

/** Host-owned live data: never part of a Session's transcript or saved plan. */
export interface AccountLimitsMessage {
  type: 'account_limits';
  limits: readonly AccountLimitSnapshot[];
}
