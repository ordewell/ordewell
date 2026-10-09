import type { AwaitingReason, LegacyPlanState, QueuedMessage, ResearchStep, RunnerId, SkillLoadNotice, SubagentOutcome, Task, TaskTransport, Verdict } from '../models/Task';
import type { UsageTotals } from '../models/Usage';
import type { TaskLogEvent } from '../models/TaskLog';
import type { ApprovalKind } from '../interfaces/IApproval';
import type { ApprovalSource } from './ApprovalPolicy';
import type { IsolationHandoff, IsolationMergeResult, TaskIsolation } from '../interfaces/IWorktreeIsolation';
import type { QueuedTaskMessage } from '../interfaces/ITerminalRunner';
import { canContinue } from './continuation';

export type SerializedTaskStatus = {
  id: string;
  status: string;
  verdict: { outcome: 'pass' | 'fail'; reason: string; checks: Verdict['checks'] } | null;
  /** Advisory silence timestamp from VerdictEngine — not part of task status semantics. */
  idleSince?: string | null;
  /** Absent unless the plan has an isolation run, so a shared-root plan's updates are unchanged. */
  isolation?: TaskIsolation;
  /** Absent unless the task's plan asked for the structured transport (ADR-0018): what it ran on, or why it fell back. */
  transport?: Pick<TaskTransport, 'kind' | 'fallback'>;
  /** What an `awaiting_user` task waits on, when it was saved (ADR-0018, W1). */
  awaitingReason?: AwaitingReason;
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
   * The dependencies an ops or user task waits on at its merge gate: their
   * work has landed but is not merged into the user's branch (ADR-0020).
   * Absent when it waits for no Merge all.
   */
  mergeGate?: string[];
  /** The dependencies, by title, a force start went past the merge gate of (ADR-0020). */
  forcedPastGate?: string[];
};

/**
 * A run with tasks at a merge gate (ADR-0020), as a surface offers Merge all
 * mid-run: what has landed and is not merged yet, and whether nothing else is
 * running, so the run waits on the user alone.
 */
export interface MergeGateView {
  paused: boolean;
  repos: IsolationHandoff['repos'];
  landed: IsolationHandoff['landed'];
}

export type SerializedTask = {
  id: string;
  order: number;
  title: string;
  type: string;
  description: string;
  dependencies: string[];
  assignedRunner: RunnerId;
  assignedModel: Task['assignedModel'] | null;
  taskMode: string;
  prompt: string | null;
  subtasks: SerializedTask[];
  userSteps: Task['userSteps'];
  thinkingEffort: Task['thinkingEffort'];
  autonomy: Task['autonomy'];
  sliceType: Task['sliceType'];
  userStoriesCovered: Task['userStoriesCovered'];
  /** Set only on an ops task (ADR-0020). */
  ops?: true;
  /** Task skills attached by name; absent when none. */
  skills?: string[];
};

export type SerializedPlan = {
  tasks: SerializedTask[];
  runners: RunnerId[];
  generatedAt: string;
  conversationHistory?: LegacyPlanState['conversationHistory'];
  prdMarkdown?: string;
  queuedMessages?: QueuedMessage[];
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
 * - `planner_message` replaces the streamed text of the turn's final segment —
 *   a surface drops what it accumulated and shows the message instead.
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
   * is classified. Authoritative over any `planner_text_delta` of its turn's
   * final segment. `turnId` is absent for replies sent outside a streamed turn.
   */
  | { type: 'planner_message'; content: string; timestamp: string; turnId?: string }
  /**
   * A planner turn began. Emitted once per turn by whoever runs the turn,
   * before any other message carrying its `turnId`. `prompt` is the user's
   * message, as typed, when the turn answers one; `skills` are what its
   * `/name` tokens loaded, absent when none did.
   */
  | { type: 'planner_turn_started'; turnId: string; prompt?: string; skills?: SkillLoadNotice[] }
  | { type: 'planner_skill_loaded'; turnId: string; skill: SkillLoadNotice }
  /**
   * A planner turn is over; nothing more carries its `turnId`. Emitted exactly
   * once per `planner_turn_started`, stop and failure included, after the
   * turn's `planner_message` when it has one.
   */
  | { type: 'planner_turn_ended'; turnId: string; outcome: PlannerTurnOutcome }
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
   * `bySubagent` entry. `contextFill` is the last planner prompt against the
   * model's window, omitted when the window is unknown. Cost appears only as
   * reported by a provider or runner (see `UsageRecord`).
   */
  | {
      type: 'planner_usage';
      turnId?: string;
      totals: UsageTotals;
      bySubagent?: Record<string, UsageTotals>;
      contextFill?: { usedTokens: number; windowTokens: number };
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
  // `gate` is present while a task waits at a merge gate (ADR-0020): what Merge
  // all would merge now, and whether the run is paused there with nothing else
  // running.
  | { type: 'status_update'; tasks: SerializedTaskStatus[]; gate?: MergeGateView }
  | { type: 'review_needed'; tasks: SerializedTask[] }
  | { type: 'review_approved' }
  | { type: 'checkpoint'; taskId: string; taskTitle: string; summary: string }
  | { type: 'execution_complete'; summary: { total: number; completed: number; failed: number } }
  | { type: 'execution_stopped' }
  | { type: 'task_updated'; taskId: string; changes: Record<string, unknown> }
  | { type: 'task_started'; taskId: string; order: number; title: string; runner: RunnerId; modelId?: string }
  | { type: 'task_output'; taskId: string; text: string }
  /**
   * A structured task's log as it happens (ADR-0018, P1): the next events of
   * the task's attempt `attempt`, in order — the same ones appended to that
   * attempt's file, so a surface folding these and one replaying the file
   * draw the same blocks. Terminal-transport tasks send none.
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
  | { type: 'isolation_handoff'; repos: IsolationHandoff['repos']; landed: IsolationHandoff['landed'] }
  // What "Merge all" did, for every surface watching rather than only the one
  // that asked: merged, blocked with each repo and why, or stopped part-way
  // with the repos that stay merged.
  | { type: 'isolation_merge'; result: IsolationMergeResult }
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
  | { type: 'approval_request'; id: string; kind: ApprovalKind; subject: string; scope: string; detail?: string; turnId?: string }
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
 * A line a run wants the user to read — how it isolates, what it shares. Not a
 * {@link SessionMessage}: hosts that show notices as toasts already do, and
 * widening the union would break every exhaustive switch over it. A host with
 * no toast channel (the daemon) hands these to its clients by its own means.
 */
export type SessionNotice = { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

export type SessionBroadcaster = (msg: SessionMessage) => void;

export function serializeTask(t: Task): SerializedTask {
  return {
    id: t.id,
    order: t.order,
    title: t.title,
    type: t.type,
    description: t.description,
    dependencies: t.dependencies || [],
    assignedRunner: t.assignedRunner,
    assignedModel: t.assignedModel || null,
    taskMode: t.taskMode || 'build',
    prompt: t.prompt || null,
    subtasks: (t.subtasks || []).map(serializeTask),
    userSteps: t.userSteps || undefined,
    thinkingEffort: t.thinkingEffort || undefined,
    autonomy: t.autonomy || undefined,
    sliceType: t.sliceType || undefined,
    userStoriesCovered: t.userStoriesCovered || undefined,
    ...(t.ops ? { ops: true as const } : {}),
    ...(t.skills?.length ? { skills: [...t.skills] } : {}),
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
): SerializedTaskStatus {
  return {
    id: t.id,
    status: t.status,
    verdict: t.verdict
      ? { outcome: t.verdict.outcome, reason: t.verdict.reason, checks: t.verdict.checks || [] }
      : null,
    idleSince,
    ...(isolation ? { isolation } : {}),
    ...(t.transport ? { transport: t.transport.fallback ? { kind: t.transport.kind, fallback: t.transport.fallback } : { kind: t.transport.kind } } : {}),
    ...(t.status === 'awaiting_user' && t.awaitingReason ? { awaitingReason: t.awaitingReason } : {}),
    ...(t.status === 'awaiting_user' && t.awaitingReason === 'checkpoint' && checkpoint ? { checkpoint } : {}),
    ...(queued.length > 0 ? { queued: queued.map((m) => ({ ...m })) } : {}),
    ...(canContinue(t) ? { continuable: true as const } : {}),
    ...(awaitingApproval > 0 ? { awaitingApproval } : {}),
    ...(mergeGate.length > 0 ? { mergeGate: [...mergeGate] } : {}),
    ...(t.forcedPastGate?.length ? { forcedPastGate: [...t.forcedPastGate] } : {}),
  };
}

export function serializePlan(plan: LegacyPlanState): SerializedPlan {
  return {
    tasks: plan.tasks.map(serializeTask),
    runners: plan.runners,
    generatedAt: plan.generatedAt,
    conversationHistory: plan.conversationHistory,
    prdMarkdown: plan.prdMarkdown,
    queuedMessages: plan.queuedMessages,
  };
}

export function executionSummary(tasks: readonly Task[]): { total: number; completed: number; failed: number } {
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
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
