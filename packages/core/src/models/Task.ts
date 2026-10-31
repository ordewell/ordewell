import { v4 as uuidv4 } from 'uuid';
import type { PlanIsolation } from '../interfaces/IWorktreeIsolation';
import type { AttemptUsage, PlannerUsage, ReportedWindow, UsageRecord, UsageTotals } from './Usage';
import type { ExecutionRecord, ScriptConsent, SupervisorLevel } from './Execution';
import type { SkillSource } from '../services/SkillsService';
import type { SupervisionMemorySnapshot } from '../services/LoopGuards';
import type { SupervisorSnapshot } from '../services/Supervisor';
import type { TaskLoop } from './Loop';
import type { HandoffDigest } from './Handoff';
import { SKILL_NAME_PATTERN } from '../conversation/skillTokens';
import { subtreeIds, walkPlan } from '../services/PlanTree';
import { migratePlanStateIsolation } from '../services/isolationRecord';
import { interruptedVerdict } from '../services/VerdictEngine';

export interface UserStep {
  order: number;
  instruction: string;
  completed: boolean;
}

/**
 * One deterministic signal gathered while verifying a completed task. `completion_marker` is only in verdicts saved before completion was reported through `task_complete` alone.
 * `script_exit` is a script task's exit status, its one evidence (ADR-0035).
 */
export interface VerificationCheck {
  name: 'exit_code' | 'completion_marker' | 'task_complete' | 'manual' | 'script_exit';
  passed: boolean;
  /** A check that did not apply. Skipped checks don't affect the verdict. */
  skipped: boolean;
  detail: string;
}

/** Evidence-based verdict for a completed task. Single end-to-end outcome produced by verification. */
export interface Verdict {
  outcome: 'pass' | 'fail';
  reason: string;
  checks: VerificationCheck[];
  decidedAt: string;
  /**
   * What the attempt's evidence said of the work: the status the runner's
   * `task_complete` call reported, or a script's exit read the same way —
   * `done` on exit 0, `failed` on a non-zero exit, a signal or its time limit,
   * `blocked` when it could not start. A loop starts a round only on `failed`
   * (ADR-0045 L2). Absent when nothing reported: a runner that exited without
   * the call, Mark complete, a stopped script, an attempt the host died in, a
   * verdict saved before it was kept.
   */
  reported?: 'done' | 'failed' | 'blocked';
}

export interface TaskOutputSummary {
  reviewReason: string;
  /** The `task_complete` summary, the task's report; absent when the attempt ended without one, and from sessions saved before it was kept. */
  report?: string;
  /** Empty when there is a report: the turn's final text is the report itself. */
  logTail: string;
  capturedAt: string;
}

/** `script` is an ops task whose body Ordewell runs with no model (ADR-0035). */
export type TaskType = 'ai' | 'user' | 'script';
/**
 * `skipped` is terminal and verdict-less: the task will not be waited for, and
 * nothing it did lands. Its dependents go ahead without it once the work it
 * waited on is done. There is no stored `blocked`: a task is blocked when a
 * failed dependency says so (ADR-0034), and a file that kept the old status
 * loads as pending.
 */
export type TaskStatus = 'pending' | 'approved' | 'in_progress' | 'completed' | 'failed' | 'awaiting_user' | 'skipped';
export type TaskMode = string;

/**
 * Why an `awaiting_user` task waits (ADR-0018, W1): a structured turn that
 * ended without a `task_complete` call, a checkpoint question, work that did not
 * land, an ops task that changed tracked files (ADR-0020), or its runner's
 * usage limit. Saved, so no surface has to guess it from whether an attempt
 * is live.
 */
export type AwaitingReason = 'input' | 'checkpoint' | 'conflict' | 'files-changed' | 'usage-limit';

export function isAwaitingReason(value: unknown): value is AwaitingReason {
  return value === 'input' || value === 'checkpoint' || value === 'conflict' || value === 'files-changed' || value === 'usage-limit';
}

export interface TaskModelAssignment {
  modelId: string;
  modelLabel: string;
  thinkingEffort?: string;
  /**
   * All variant ids the model offered when this assignment was made. Carried
   * on the assignment because runners need it at spawn time (opencode's TUI
   * only honors an assigned variant when the others are config-disabled) and
   * the discovery catalog isn't available there.
   */
  availableVariants?: string[];
}

export type RunnerId = string;

/**
 * Bring loaded tasks to the structured-only shape, in place. A task saved
 * while the terminal transport existed may say it ran there, and why; neither
 * means anything now, and such a task left no session to continue. Its
 * completion marker id went with the text markers: completion is reported
 * only through `task_complete`.
 */
export function migrateLoadedTasks(tasks: readonly Task[]): void {
  for (const task of tasks) {
    if (typeof task.runnerSessionId !== 'string') delete task.runnerSessionId;
    if (typeof task.carriedFrom !== 'string') delete task.carriedFrom;
    if (typeof task.runnerSessionOwner !== 'string') delete task.runnerSessionOwner;
    const legacy = task as Task & { transport?: { kind?: unknown; nativeSessionId?: unknown } };
    if (!task.runnerSessionId && legacy.transport?.kind === 'structured' && typeof legacy.transport.nativeSessionId === 'string') {
      task.runnerSessionId = legacy.transport.nativeSessionId;
    }
    delete legacy.transport;
    delete (task as { completionMarker?: unknown }).completionMarker;
    // The effort once had a second home on the task; the spawn reads only the model's.
    const effort = (task as { thinkingEffort?: unknown }).thinkingEffort;
    if (typeof effort === 'string' && task.assignedModel && !task.assignedModel.thinkingEffort) task.assignedModel.thinkingEffort = effort;
    delete (task as { thinkingEffort?: unknown }).thinkingEffort;
    migrateLoadedTasks(task.subtasks ?? []);
  }
}

/**
 * Nothing is running when a plan comes off disk, so a task saved in progress
 * lost its attempt with the host that ran it. It is failed, in place, so the
 * inbox lists it and what depends on it waits (ADR-0053). Its attempts and
 * logs are left as they are.
 */
export function failInterruptedTasks(tasks: readonly Task[], now: string): void {
  for (const task of flattenTasks(tasks)) {
    if (task.status !== 'in_progress') continue;
    task.status = 'failed';
    task.verdict = interruptedVerdict(now);
  }
}

/**
 * A task an edit made manual has nothing to retry, and is the user's to do: one
 * failed, or waiting on the user with no runner to hear an answer, waits as a
 * manual task does (ADR-0053). A runner still at a question keeps it, and the
 * answer is still its to read, until it ends or the plan comes off disk.
 */
export function releaseMadeManual(tasks: readonly Task[], live: (taskId: string) => boolean = () => false): void {
  for (const task of flattenTasks(tasks)) {
    if (task.type !== 'user' || live(task.id) || (task.status !== 'failed' && task.status !== 'awaiting_user')) continue;
    task.status = 'pending';
    delete task.awaitingReason;
    delete task.resumeAt;
  }
}

/**
 * Nothing claims a repair when a plan comes off disk: what owed it went with
 * the host that saved it. So a task saved not started whose landing conflicted
 * is a conflict waiting on the user, in place, and the inbox lists it; the
 * next Execute still repairs it (ADR-0015, ADR-0053).
 */
export function settleOwedRepairs(plan: LegacyPlanState): void {
  const records = plan.isolation?.run.tasks;
  if (!records) return;
  for (const task of flattenTasks(plan.tasks)) {
    if ((task.status !== 'pending' && task.status !== 'approved') || records[task.id]?.status !== 'conflict') continue;
    task.status = 'awaiting_user';
    task.awaitingReason = 'conflict';
  }
}

/**
 * Drop what a build before the per-message research budget was removed wrote
 * for it (ADR-0037): the budget, its two run settings, its per-turn flag, and
 * the report wait a task carried. The persisted types no longer name these,
 * so a reopened session would otherwise spread them onto the wire and write
 * them back; they are deleted by key, never widened into the types.
 */
export function dropRetiredPlanFields(plan: LegacyPlanState): void {
  const raw = plan as unknown as Record<string, unknown>;
  delete raw.researchBudget;
  const settings = plan.runSettings as unknown as Record<string, unknown> | undefined;
  if (settings) {
    delete settings.researchMaxParallel;
    delete settings.researchMaxPerMessage;
  }
  for (const turn of plan.pendingTurns ?? []) delete (turn as unknown as Record<string, unknown>).budgetStarted;
  for (const task of flattenTasks(plan.tasks)) delete (task as unknown as Record<string, unknown>).researchWait;
}

/**
 * Move a mid-run edit an older build queued for its next batch boundary into
 * the pending turns: it was never answered, so it waits like any other.
 */
function carryOverQueuedEdits(plan: LegacyPlanState): void {
  const queued = plan.queuedMessages ?? [];
  delete plan.queuedMessages;
  if (queued.length === 0) return;
  const carried = queued.map(({ id, text, timestamp, skills }): PendingPlanTurn => ({ id, source: 'user', text, timestamp, ...(skills ? { skills } : {}) }));
  plan.pendingTurns = [...(plan.pendingTurns ?? []), ...carried];
}

/**
 * Bring a loaded plan to the shape this build reads, in place: every plan-shape
 * migration lives here, so each can be tested from an old shape without a whole
 * Session, as {@link migrateLoadedTasks} does for tasks.
 *
 * `adopting` is false when a Session reloads the plan it already holds: the
 * live run's task pauses are fresher than the save, so they stay.
 */
export function migrateLoadedPlan(plan: LegacyPlanState, { adopting = true }: { adopting?: boolean } = {}): void {
  // Saved before approval had its own record: the status said it, and
  // executing a plan approved every task it held. Read once, here, and never
  // again — a surface rewrites the status for display.
  plan.approved ??= plan.status !== 'draft' && plan.status !== 'rejected';
  if (!plan.approvedTasks && plan.approved) {
    plan.approvedTasks = flattenTasks(plan.tasks).map((t) => t.id);
  }
  // A saved reset time belonged to a run that is gone; loading is not consent
  // to spend tokens (ADR-0044).
  if (adopting) {
    for (const task of flattenTasks(plan.tasks)) delete task.resumeAt;
  }
  migratePlanStateIsolation(plan);
  // Older builds copied the since-removed transport setting onto the plan.
  // Every plan now runs structured (ADR-0018), so the copy is not carried on.
  delete (plan as { runnerTransport?: unknown }).runnerTransport;
  // Run settings are the user's now (ADR-0030); an older plan's own copies
  // are not read, and go with this save.
  for (const key of ['supervisorLevel', 'mergeAtGatesAutomatically', 'supervisorRetryLimit', 'wakeUpReadBudget']) {
    delete (plan as unknown as Record<string, unknown>)[key];
  }
  // The per-message research budget is gone (ADR-0037); a plan saved before
  // its removal is read once and written back without its keys.
  dropRetiredPlanFields(plan);
  carryOverQueuedEdits(plan);
}

/**
 * A task skill as one attempt received it: read from the task's own worktree
 * (or global) at spawn, kept so the user can see what the runner was told
 * even after the skill's file changes.
 */
export interface TaskSkillSnapshot {
  name: string;
  source: SkillSource;
  path: string;
  content: string;
}

/** A task skill as a surface is told of it: the body stays in the task's log file and the session. */
export type TaskSkillNotice = Omit<TaskSkillSnapshot, 'content'>;

export interface Task {
  id: string;
  order: number;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  dependencies: string[];
  prompt?: string;
  userSteps?: UserStep[];
  subtasks: Task[];
  verdict?: Verdict;
  outputSummary?: TaskOutputSummary;
  /**
   * The latest attempt's handoff, as the plan keeps it (ADR-0047): its
   * summary, first findings and artifacts. The whole handoff, report and all,
   * is in that attempt's log. Absent when the attempt handed none over, and
   * on a plan saved before handoffs, which reads `outputSummary` instead.
   */
  handoff?: HandoffDigest;
  assignedModel?: TaskModelAssignment;
  assignedRunner: RunnerId;
  taskMode?: TaskMode;
  autonomy?: 'AFK' | 'HITL';
  sliceType?: 'HITL' | 'AFK';
  userStoriesCovered?: string[];
  /** The runner's saved session for a later continue; cleared when a fresh attempt starts. */
  runnerSessionId?: string;
  /**
   * The runner that session belongs to: a session cannot cross runners, so
   * Continue is offered only while the task is still assigned to it. Absent
   * on a plan saved before it was recorded; the last attempt's runner stands
   * in (see `sessionOwner`).
   */
  runnerSessionOwner?: RunnerId;
  /** Set only while `status` is `awaiting_user`, and not always then — a pause saved by an older build has none. */
  awaitingReason?: AwaitingReason;
  /**
   * How many waits have ended since its latest attempt started, or since the
   * task was written if none has: an attempt can wait many times, and this
   * tells one wait from the next in an escalation's id (ADR-0053). Saved with
   * the plan, so the id holds across a reload. Absent counts as none.
   */
  waitsEnded?: number;
  /**
   * When a task paused on its runner's usage limit is resumed on its own (ISO
   * time): the reset the runner announced, plus a short margin. Absent when no
   * reset time could be read or the user cancelled the resume — the task then
   * waits for a manual retry. Set only with `awaitingReason` `usage-limit`.
   */
  resumeAt?: string;
  /**
   * The runner a task paused on its usage limit was moved off (ADR-0018, U1):
   * its next attempt is a carry-over, a fresh session that starts from that
   * attempt's files. Cleared once that attempt runs, and by a retry.
   */
  carriedFrom?: RunnerId;
  /** Why the task was skipped, as whoever skipped it put it; set only while `status` is `skipped`, and not always then. */
  skipReason?: string;
  /**
   * The user reverted its landed work (ADR-0054): saved with the plan, so the
   * hold that keeps it from running again outlives this process. Set only
   * while it waits as the revert left it: its next start clears it.
   */
  reverted?: true;
  /**
   * An ops task (ADR-0020): it changes no repository files, runs at the
   * workspace root rather than in a worktree, and waits for the change tasks
   * it depends on to be merged into the user's branch. Top-level AI tasks
   * only; absent means a change task. A script task is one by nature and
   * stores none (see {@link runsAsOps}).
   */
  ops?: boolean;
  /** A top-level read-only AI task whose report returns to the planner (ADR-0037 R1). */
  research?: boolean;
  /** A retry still owes research's report under its original authority (ADR-0037 R3). */
  researchOrigin?: TaskReportTo;
  /**
   * The dependencies, by title, whose work was not merged into the user's
   * branch when the user force-started this task past its merge gate
   * (ADR-0020). Cleared when the task is retried.
   */
  forcedPastGate?: string[];
  /**
   * Task skills (`applies-to: task`) attached by name. Their bodies are put in
   * the runner's prompt at spawn, resolved where the task runs — a subtask's
   * are its own, never its parent's. Absent means none.
   */
  skills?: string[];
  /** The skills the latest attempt was given, as read when it spawned. */
  attemptSkills?: TaskSkillSnapshot[];
  /**
   * Who put the task in the plan, when it was not the user's own planning:
   * `supervisor` for a task an Act supervisor added during a run, which
   * counts as approved to run (ADR-0029). Set by the session, never by an op.
   */
  addedBy?: 'supervisor';
  /**
   * An attempt of it has started, so its chat exists from then on: kept after
   * a failure, a cancel, a skip or a completion, and restored with the plan.
   * Set by the attempt's own start — never by a status or a manual mark.
   */
  attempted?: true;
  attemptUsage?: AttemptUsage[];
  /**
   * A script task's body (ADR-0035), exactly one of these two: argument
   * vectors run in order with no shell, stopping at the first that fails, or
   * one script run by the research shell's interpreter.
   */
  commands?: string[][];
  script?: string;
  /** A script task's time limit; absent means ten minutes (`DEFAULT_SCRIPT_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Set on a loop's check (ADR-0045): the tasks that fix what it finds, and how many times it may run. */
  loop?: TaskLoop;
  /**
   * The round of a loop's check's latest run, or the one it is running;
   * absent is round 1. Execution state, saved so a reload resumes mid-round,
   * and started over by a retry of the check (ADR-0045 L5, L7).
   */
  loopRound?: number;
  /**
   * A planner turn waits for this task's result (ADR-0037, R2): set when the
   * tool that started it answered before it ended, or when research lands.
   * Cleared once its end is reported, in a turn acting for whoever started it (R3).
   */
  reportTo?: TaskReportTo;
}

/**
 * Who started a task whose result is owed to the planner (ADR-0037, R3): a
 * planner turn in the user's conversation, or the supervisor, at its level
 * then, with script consent (ADR-0035) or the research profile (ADR-0037 R4).
 */
export type TaskReportTo = ({ consent: ScriptConsent; research?: never } | { research: true; consent?: never }) & (
  | { actor: 'planner-turn' }
  | { actor: 'supervisor'; level: SupervisorLevel }
);

/** Whose authority a turn opened without the user acts with (ADR-0037, R3): the user's turn, or the supervisor's. */
export type TurnAuthority = 'user' | 'supervisor';

export interface DiscoveredMode {
  id: string;
  label: string;
  description: string;
}

export type ResearchToolType =
  | 'read_file' | 'read_files' | 'glob' | 'grep' | 'find_symbol' | 'list_dir'
  | 'bash' | 'fetch' | 'web_search' | 'spawn_research_agent'
  | 'task_query' | 'task_output' | 'task_diff'
  /**
   * A tool belonging to a harness planner's own toolbox (ADR-0009) that has no
   * Ordewell equivalent — Edit, WebFetch, TodoWrite, whatever a coding agent
   * ships next. The real name travels in `toolLabel` rather than being
   * relabelled as a tool it is not; the union stays closed so the
   * exhaustiveness checks in every surface's icon/label switch survive.
   */
  | 'agent_tool';

/**
 * What happened when a research tool call ran, for honest per-surface
 * rendering. The broadcast seam carries this on every `research_step_done` so
 * surfaces do not have to pattern-match refusal text to tell a refused `rm`
 * from a successful `rm` — the old render path flipped a `✓` for both.
 */
export type ResearchStepOutcome = 'success' | 'failure' | 'refused' | 'denied' | 'not_executed';

export interface ResearchStep {
  id: string;
  tool: ResearchToolType;
  /** The tool's own name when it came from a harness planner — always set for `agent_tool`. */
  toolLabel?: string;
  args: string;
  result: string;
  success: boolean;
  outcome: ResearchStepOutcome;
  /** The model's tool_call id, so a surface can match `tool_result` to the
   * pending `tool_call` it announced — robust under parallel same-tool rounds. */
  toolCallId?: string;
  /** The research subagent that ran the call, so a reload regroups it under that subagent. */
  subagentId?: string;
  timestamp: string;
  thinkingText?: string;
}

export interface UserPromptEntry {
  id: string;
  type: 'user_prompt' | 'system';
  content: string;
  timestamp: string;
}

export type SubagentOutcome = 'done' | 'failed' | 'stopped';

/**
 * One subagent's whole run, logged when it finishes: what it was asked, how it
 * ended and what it reported. Its steps stay separate entries carrying the same
 * `subagentId`, so an older reader that knows only steps still shows them.
 */
export interface SubagentLogEntry {
  id: string;
  type: 'subagent';
  subagentId: string;
  brief: string;
  model?: string;
  outcome: SubagentOutcome;
  digest: string;
  usage?: UsageTotals;
  timestamp: string;
}

export type ResearchLogEntry = ResearchStep | UserPromptEntry | SubagentLogEntry;

export interface ResearchProgress {
  // 'liveness' carries no content: a raw-line signal from the harness process
  // (ADR-0009) that reaches a surface even when a turn is producing nothing
  // visible — a subagent's filtered chatter, most often — so an idle watchdog
  // downstream doesn't mistake "nothing to show" for "nothing happening".
  //
  // The turn-scoped kinds below carry one planner turn's stream (#47); see the
  // matching SessionMessage variants for the invariants each one keeps.
  // 'text_delta' is reply text as the model streams it (`text`, `segmentId`),
  // an envelope included: the turn's owner routes each segment to prose or to
  // the plan display, so no backend has to tell them apart. 'text_retracted'
  // takes back an attempt's text: `segmentId`'s, or when absent everything the
  // backend call that sends it has streamed.
  // 'usage' reports one model call (`record`). 'subagent_started' carries
  // `brief` and `model`; 'subagent_finished' carries `outcome`, `digest` and
  // `usage`. 'compaction' is one phase of the planner's own compaction
  // (`compaction`); a subagent's never is one.
  type:
    | 'thinking' | 'tool_call' | 'tool_result' | 'plan_token' | 'interrupted' | 'liveness'
    | 'text_delta' | 'text_retracted' | 'usage' | 'subagent_started' | 'subagent_finished' | 'compaction';
  /** Minted by whoever runs the turn and passed through untouched; absent outside a turn. */
  turnId?: string;
  /** One continuous run of model text — text before a tool call is its own segment. */
  segmentId?: string;
  text?: string;
  tool?: string;
  /** Harness planners (ADR-0009): the agent's own name for a tool Ordewell has no member for. */
  toolLabel?: string;
  toolArgs?: string;
  toolResult?: string;
  planToken?: string;
  step?: ResearchStep;
  /** The model's tool_call id, threaded on tool_call and tool_result so a
   * surface can match the result to its pending call — robust under parallel
   * same-tool rounds where LIFO-by-name matching mislabels summaries. */
  toolCallId?: string;
  /** Present when this event originates from (or reports on) one spawned research subagent (issue #34). */
  subagentId?: string;
  record?: UsageRecord;
  brief?: string;
  model?: string;
  outcome?: SubagentOutcome;
  digest?: string;
  usage?: UsageTotals;
  compaction?: PlannerCompaction;
}

export interface ThinkingBlock {
  id: string;
  text: string;
}

export interface StreamThinkingEvent {
  type: 'thinking';
  block: ThinkingBlock;
}

export interface StreamStepEvent {
  type: 'step';
  step: ResearchStep;
}

export type StreamEvent = StreamThinkingEvent | StreamStepEvent;

export interface DiscoveredModel {
  modelId: string;
  modelLabel: string;
  runnerProvider?: string;
  /**
   * Human-facing provider name as the runner itself reports it (e.g.
   * "OpenCode Zen" for `runnerProvider: 'opencode'`). Populated from the
   * runner's own provider catalog when available; when absent the UI derives a
   * label from `runnerProvider` by title-casing.
   */
  runnerProviderLabel?: string;
  /**
   * The runner whose catalog listed this model. Stamped once, at the single
   * `ModelDiscovery.discover` choke point, so a flat cross-runner list can
   * still say where each entry came from — `runnerProvider` alone cannot:
   * OpenCode reports most of its catalog as `openrouter`, which names the
   * serving backend, not the agent Ordewell would spawn.
   */
  runnerId?: string;
  /** The runner's display name (`OpenCode`), from its manifest. */
  runnerLabel?: string;
  variants: { id: string; label: string }[];
  /**
   * The model's context window when the runner or catalog reports it (#49).
   * Read by the planner-model lookup so context fill can be shown; absent when
   * unknown rather than defaulted to zero. Gemini's is its `inputTokenLimit`:
   * the prompt alone, the reply limited by `maxOutputTokens` apart from it.
   */
  contextWindow?: number;
  /** The longest reply the catalog says the model is served with, when it says. */
  maxOutputTokens?: number;
}

export type PlanStatus = 'draft' | 'approved' | 'rejected' | 'running' | 'completed';

/**
 * One entry of the planner's persisted dialogue (ADR-0002). The single source
 * of truth for both UI redisplay and conversational context. Tool-call results
 * are NOT stored here — they live in the AI service's tool-use history;
 * `researchLog` remains the persisted tool trace for the UI.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /**
   * Timeline marker: 'plan_generated' records the point in the dialogue where
   * the plan was committed (the UI anchors the plan card there on restore);
   * 'system' is a host-injected notice; 'compaction' is the summary a
   * compaction appended, which stands in for the earlier messages in the
   * planner's context while the transcript keeps them (see `checkpoint`). 'skill_load' is a skill loaded into the
   * conversation, its snapshot in `skill`; one the user invoked follows the
   * message that named it. 'execution' is a call at the command seam
   * (ADR-0029), its record in `execution`. 'wake_up' is the digest a wake-up
   * gave the supervisor (role 'user': the model was told it), and
   * 'supervisor' what the supervisor said in a wake-up turn (ADR-0029).
   * 'error' is a planner turn that ended on the planner's usage limit, drawn
   * as a failure and never replayed to the planner: it is not the planner's
   * answer, and its inputs are sent again (see {@link PlannerResendState}).
   * Absent for ordinary chat turns, so sessions saved before markers existed
   * degrade gracefully.
   */
  kind?: 'plan_generated' | 'system' | 'compaction' | 'skill_load' | 'execution' | 'wake_up' | 'supervisor' | 'error';
  actor?: 'Ordewell setting';
  /** Present exactly when `kind` is 'skill_load'. */
  skill?: SkillLoad;
  /** Present exactly when `kind` is 'execution'. */
  execution?: ExecutionRecord;
  /** A user's message that was force sent, stopping the turn before it (ADR-0023). */
  forced?: true;
  /**
   * Set on a 'compaction' entry that is a checkpoint of the planner's context
   * (ADR-0002). A 'compaction' entry without one is a legacy summary when it
   * stands first — it replaced what it condensed — and a marker drawn but
   * never replayed anywhere else.
   */
  checkpoint?: ContextCheckpoint;
  /**
   * What a reply showed, run by run, where each began (ADR-0017 A1). Beside
   * `content`, which stays the reply as the planner is told it. Absent on
   * entries saved before runs were kept, which reload as one message.
   */
  runs?: ReplyRun[];
}

/**
 * Where a compaction cut the planner's context (ADR-0002): its summary stands
 * for every transcript entry before `keptFrom`, and the entries from there on
 * replay verbatim. Entries are only appended, or inserted at a held turn's
 * position, which no checkpoint's cut passes, so the index never moves.
 */
export interface ContextCheckpoint {
  /** Stable across saves, forks and the wire, so a surface can tell this checkpoint from another with the same text. */
  id: string;
  /** An index into the whole transcript, at or before the checkpoint entry itself. */
  keptFrom: number;
  trigger: 'manual' | 'auto';
}

/**
 * How a planner compaction ended. `condensed`: a summary stands in for the
 * older context (a checkpoint was written, or a harness planner reported its
 * own compaction done). `pruned`: older recoverable tool output was dropped
 * from the live context alone. `unchanged`: nothing needed doing. `paused`:
 * the context could not be brought to fit, so the planner waits.
 */
export type PlannerCompactionOutcome = 'condensed' | 'pruned' | 'unchanged' | 'stopped' | 'failed' | 'paused';

/**
 * One planner compaction's lifecycle as it was observed (ADR-0017): both
 * phases share `id`, which is the checkpoint's id when one is written. Only
 * Ordewell's own compaction announces a start; a harness planner's native one
 * is reported when it is over, and nothing invents the start it never sent.
 * Sizes are only ever what a backend reported.
 */
export type PlannerCompaction =
  | { phase: 'started'; id: string; origin: 'ordewell'; trigger: ContextCheckpoint['trigger']; at: string }
  | {
      phase: 'ended';
      id: string;
      origin: 'ordewell' | 'native';
      trigger: ContextCheckpoint['trigger'];
      outcome: PlannerCompactionOutcome;
      at: string;
      preTokens?: number;
      postTokens?: number;
    };

/**
 * One run of a planner reply's text: the segment it streamed under, its
 * settled text, and when it began. A run that never streamed (a message the
 * conversation wrote in the planner's place) has a segment no stream used.
 */
export interface ReplyRun {
  segmentId: string;
  text: string;
  /** ISO timestamp. */
  startedAt: string;
}

/**
 * A skill's SKILL.md as it was when loaded into a planner conversation. A
 * snapshot rather than a reference: a resumed, forked or rewound conversation
 * replays the body the planner originally saw, even after the file changed or
 * was deleted.
 */
export interface SkillLoad {
  invokedBy: 'user' | 'planner';
  name: string;
  source: SkillSource;
  /** The SKILL.md that won, home-abbreviated (`~/...`): which copy loaded is what a reader needs from it. */
  path: string;
  content: string;
  /**
   * Set when the user named a task skill: it is not loaded into the planner's
   * context, which is only told to attach it to the tasks it fits. `content`
   * is empty; the description is what the planner's directive quotes.
   */
  attaches?: { description: string };
}

/** A skill load as a surface announces it — the body stays with the transcript. */
export type SkillLoadNotice = Omit<SkillLoad, 'content'>;

/** A message the user sent, as opposed to a skill load their message caused or a wake-up digest. */
export function isUserMessage(entry: Pick<ConversationMessage, 'role' | 'kind'>): boolean {
  return entry.role === 'user' && entry.kind !== 'skill_load' && entry.kind !== 'wake_up';
}

/** A follow-up an older build queued behind a run's batch boundary; read only to carry it over as a {@link PendingPlanTurn}. */
export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: string;
  skills?: SkillLoad[];
}

/** Who a planner turn answers (ADR-0029): the user's message, or a wake-up batch the supervisor is given. */
export type PlanTurnSource = 'user' | 'supervisor';

/**
 * A planner turn's input not yet answered by a turn that ended. It leaves the
 * plan with the change its turn made, in the same save, so a reload replays
 * exactly the inputs no turn answered — once. A supervisor's input is a
 * wake-up batch not yet delivered (ADR-0029): it stays until a turn lands
 * with it, whatever turns fail meanwhile.
 */
export interface PendingPlanTurn {
  id: string;
  source: PlanTurnSource;
  /** The user's message, or a wake-up batch's digest. */
  text: string;
  timestamp: string;
  /** What its `/name` tokens loaded when it was sent, so a replay sends the same skills. */
  skills?: SkillLoad[];
  /** Force sent: it waits ahead of every input not forced, and its turn is its own (ADR-0023, F2). */
  forced?: true;
  /**
   * A supervisor input carrying a report the planner asked for (ADR-0037, R2),
   * which opens a turn at every supervisor level: `user` for a task started in
   * the user's turn, which the turn then acts as (R3).
   */
  report?: TurnAuthority;
}

/**
 * The run's own copy of the user's run settings (ADR-0030): taken when the
 * user starts it, changed at once by a change made in this session, and
 * lowered by a tripped guard or a failed supervisor.
 */
export interface RunSettings {
  mergeAtGatesAutomatically: boolean;
  /** Absent on a run started before supervisor levels existed: Off. */
  supervisorLevel?: SupervisorLevel;
  /** Absent on a run started before ADR-0030: the user's setting. */
  supervisorRetryLimit?: number;
  /** Absent on a run started before ADR-0030: the user's setting. */
  wakeUpReadBudget?: number;
  /** Why the supervisor stopped for the rest of this run, which carries on as Off; absent while it watches. */
  unsupervised?: string;
}

/**
 * What supervision remembers across a daemon restart (ADR-0029): the loop
 * guards' memory and the wake-up state not yet delivered with a turn.
 */
export interface SupervisionSnapshot {
  /** Retries, failed-attempt shapes, the supervisor's edits and what the user was told. */
  guards?: SupervisionMemorySnapshot;
  /** The events inside their debounce window and the wake-up rate's timestamps. */
  wake?: SupervisorSnapshot;
}

/**
 * What waits on the planner's usage limit. With `at`, the inputs no turn
 * answered are sent again then, on their own; without it — the reset could
 * not be read, the resend hit the limit again, or it was cancelled — they go
 * with the next input: the user's message, or a wake-up.
 */
export interface PlannerResendState {
  /** The runner whose account hit the limit; a planner on another one is not held by it. */
  runner?: RunnerId;
  at?: string;
}

/**
 * The planner paused on its context (ADR-0002): an API planner's call could
 * not be brought inside its model's window, so the turn ended with nothing
 * landed and the planner waits for the user's Retry compaction. What it
 * keeps is bounded: the inputs stay in `pendingTurns`, and only the calls
 * that changed something are listed, never the live context itself.
 */
export interface PlannerContextPause {
  /** The model the call did not fit. */
  model: string;
  at: string;
  /** What the user is told: why it paused, and what Retry compaction does. */
  reason: string;
  /** The pending inputs the paused turn took: a retry answers these, and what arrived since waits for the turn after it. */
  inputs: string[];
  /**
   * The calls the paused turn made that changed something or reached out,
   * each with the head of what it returned (`effectLedger`). It is never
   * replayed to the planner as a note: it is what lets a retry see that a
   * turn which ran effects cannot start again from the transcript, and what
   * the refusal lists for the user.
   */
  done?: string[];
  /** More such calls ran than `done` keeps: the refusal could not list all of them, and a retry without the live context stays refused. */
  doneTruncated?: true;
}

export interface LegacyPlanState {
  /** Research profiles the planner approved as they landed: lifting one withdraws its approval (ADR-0037 R4). */
  researchApprovals?: string[];
  runSettings?: RunSettings;
  /** What supervision remembers across a daemon restart (ADR-0029); absent on plans saved before it existed. */
  supervision?: SupervisionSnapshot;
  tasks: Task[];
  generatedAt: string;
  status: PlanStatus;
  runners: RunnerId[];
  lastUpdated: string;
  researchLog?: ResearchLogEntry[];
  /** The planner dialogue — user messages and assistant messages, in order (ADR-0002). */
  conversationHistory?: ConversationMessage[];
  /** Full markdown PRD once written by the planner (PRD mode), also saved to .scratch/<slug>/PRD.md. */
  prdMarkdown?: string;
  /** Planner turn inputs no turn has answered yet (ADR-0029); a reload replays them. */
  pendingTurns?: PendingPlanTurn[];
  /** Written by builds that queued mid-run edits; a load moves it into {@link pendingTurns}. */
  queuedMessages?: QueuedMessage[];
  /**
   * The plan's isolation run (ADR-0013), written from the orchestrator at
   * persist time and read back only when a saved plan is adopted. It names
   * branches and worktrees that belong to this plan alone: a fork of the plan
   * must leave it behind rather than share it.
   */
  isolation?: PlanIsolation;
  /**
   * The id of the plan's last isolated run, which closed with everything it
   * landed merged into the user's branch; absent once a later run decides how
   * it executes. With no run record left, it is what tells a Merge all asked
   * for after that run from one in a plan that never isolated (ADR-0029).
   */
  mergedRun?: string;
  /** Kept so a reopened session shows the same token line (#49). */
  plannerUsage?: PlannerUsage;
  /** The windows reported over the session, so a reopened one knows each model's from its first call. */
  contextWindows?: ReportedWindow[];
  /** The planner hit its usage limit and the inputs its turn took wait to be sent again; absent otherwise. */
  plannerResend?: PlannerResendState;
  /** The planner's context could not fit its model's window: its turn's inputs wait for Retry compaction; absent otherwise. */
  plannerContextPause?: PlannerContextPause;
  /**
   * The tasks the user approved to run: every task when they executed the
   * plan, and each one they started or retried themselves since. A command
   * from anyone else starts only these (ADR-0029); a task the planner added
   * after the approval waits for the user's. Only tasks still in the plan: a
   * task that leaves takes its approval with it.
   */
  approvedTasks?: string[];
  /**
   * The user approved the plan to run: Execute plan, signing off a review, or
   * autorun's start (ADR-0029, ADR-0030). Kept apart from {@link status},
   * which surfaces rewrite for display; a user's start of one task approves
   * that task, not the plan.
   */
  approved?: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'planner' | 'system';
  content: string;
  timestamp: number;
}

export interface TaskSnapshot extends Task {
  completedAt: number;
  verdict?: Verdict;
  retryCount: number;
  finalized: boolean;
}

/** The plan a surface reads whole carries the approval record, so it can tell which tasks wait for the user (ADR-0035). */
export type PlanState = (
  | {
      phase: 'planning';
      history: Message[];
      message: string;
      pendingTasks: Task[];
    }
  | {
      phase: 'executing';
      history: Message[];
      message: string;
      executionLog: TaskSnapshot[];
      pendingTasks: Task[];
      goal: string;
      runners: string[];
      status: PlanStatus;
    }
) & ApprovalRecord;

function hasPhase(raw: unknown): raw is PlanState {
  return typeof raw === 'object' && raw !== null && 'phase' in raw;
}

function hasTasks(raw: unknown): raw is LegacyPlanState {
  return typeof raw === 'object' && raw !== null && 'tasks' in raw && Array.isArray((raw as Record<string, unknown>).tasks);
}

function logEntryToMessage(entry: ResearchLogEntry): Message {
  const timestamp = new Date(entry.timestamp).getTime();
  if (!('type' in entry)) {
    return { id: entry.id, role: 'system', content: JSON.stringify({ tool: entry.tool, args: entry.args, result: entry.result }), timestamp };
  }
  if (entry.type === 'subagent') {
    const { subagentId, brief, outcome, digest } = entry;
    return { id: entry.id, role: 'system', content: JSON.stringify({ subagentId, brief, outcome, digest }), timestamp };
  }
  return { id: entry.id, role: entry.type === 'user_prompt' ? 'user' : 'system', content: entry.content, timestamp };
}

function migrateHistory(raw: LegacyPlanState): Message[] {
  const messages: Message[] = [];

  if (raw.researchLog) {
    messages.push(...raw.researchLog.map(logEntryToMessage));
  }

  if (raw.queuedMessages) {
    for (const qm of raw.queuedMessages) {
      messages.push({
        id: qm.id,
        role: 'system',
        content: qm.text,
        timestamp: new Date(qm.timestamp).getTime(),
      });
    }
  }

  return messages;
}

export function migratePlanState(raw: unknown): PlanState {
  if (hasPhase(raw)) return raw;

  if (!hasTasks(raw)) {
    return {
      phase: 'planning',
      history: [],
      message: '',
      pendingTasks: [],
    };
  }

  const hasExecution = raw.tasks.some(
    (t) => t.status === 'completed' || t.status === 'failed',
  );

  const messages = migrateHistory(raw);
  const record = approvalRecordOf(raw);

  if (hasExecution) {
    const executionLog: TaskSnapshot[] = raw.tasks
      .filter((t) => t.status === 'completed' || t.status === 'failed')
      .map((t) => ({
        ...t,
        completedAt: new Date(raw.lastUpdated).getTime(),
        verdict: t.verdict,
        retryCount: 0,
        finalized: true,
      }));

    const pendingTasks = raw.tasks.filter(
      (t) => t.status !== 'completed' && t.status !== 'failed',
    );

    return {
      phase: 'executing',
      history: messages,
      message: '',
      executionLog,
      pendingTasks,
      goal: '',
      runners: raw.runners,
      status: raw.status,
      ...record,
    };
  }

  return {
    phase: 'planning',
    history: messages,
    message: '',
    pendingTasks: raw.tasks,
    ...record,
  };
}

export { taskOrderLabel, taskRef, taskRefOf, titledTaskRef, titledTaskRefOf, resolveTaskRef, resolveUserTaskRef } from '../services/TaskRefs';

export function createTask(overrides: Partial<Task> = {}): Task {
  const skills = skillNames(overrides.skills);
  const type = overrides.type ?? 'ai';
  return {
    id: overrides.id ?? uuidv4(),
    order: overrides.order ?? 0,
    title: overrides.title ?? '',
    description: overrides.description ?? '',
    type,
    status: overrides.status ?? 'pending',
    dependencies: overrides.dependencies ?? [],
    prompt: overrides.prompt,
    userSteps: overrides.userSteps,
    subtasks: overrides.subtasks ?? [],
    verdict: overrides.verdict,
    outputSummary: overrides.outputSummary,
    ...(overrides.handoff ? { handoff: structuredClone(overrides.handoff) } : {}),
    ...(overrides.attempted ? { attempted: true as const } : {}),
    ...(overrides.attemptUsage ? { attemptUsage: structuredClone(overrides.attemptUsage) } : {}),
    assignedModel: overrides.assignedModel,
    assignedRunner: overrides.assignedRunner ?? DEFAULT_RUNNERS[0],
    // A script task runs in no mode (ADR-0035): one given it would read as a mode it runs in.
    taskMode: overrides.taskMode ?? (type === 'script' ? undefined : 'build'),
    autonomy: overrides.autonomy,
    sliceType: overrides.sliceType,
    userStoriesCovered: overrides.userStoriesCovered,
    ...(opsFlag(overrides.ops, overrides.type) ? { ops: true } : {}),
    ...(skills ? { skills } : {}),
    ...(overrides.addedBy === 'supervisor' ? { addedBy: 'supervisor' as const } : {}),
    ...(overrides.commands !== undefined ? { commands: overrides.commands.map((argv) => [...argv]) } : {}),
    ...(overrides.script !== undefined ? { script: overrides.script } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.loop ? { loop: { body: [...overrides.loop.body], maxRounds: overrides.loop.maxRounds } } : {}),
    ...(overrides.loopRound !== undefined ? { loopRound: overrides.loopRound } : {}),
    ...(overrides.research !== undefined ? { research: overrides.research } : {}),
  };
}

/**
 * A name a skill can have, lower-cased as `/name` is. Anything else — a path
 * separator, `..` — is joined into a path and could only reach outside the
 * skill dirs.
 */
const SKILL_NAME = new RegExp(`^${SKILL_NAME_PATTERN}$`);

export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

/**
 * The `skills` field as a task stores it, however it arrived: the planner's
 * JSON is untyped. Names are trimmed, lower-cased and deduplicated, and one
 * no skill could have is dropped; none at all is stored absent, so a plan
 * without skills reads exactly as it did before them.
 */
export function skillNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase()).filter(isSkillName))];
  return names.length > 0 ? names : undefined;
}

/**
 * The skills of a task a merge or a split makes from others: what the edit
 * chose when it named any, none when it chose an explicit `[]`, else what the
 * tasks it came from had — a malformed value is not a request to drop them.
 */
export function inheritedSkills(chosen: unknown, inherited: readonly string[] | undefined): string[] | undefined {
  if (Array.isArray(chosen) && chosen.length === 0) return undefined;
  return skillNames(chosen) ?? skillNames(inherited);
}

/**
 * The `ops` flag as a task stores it (ADR-0020), however it arrived. Only a
 * literal `true` on an AI task marks an ops task: the planner's JSON is
 * untyped, and a quoted "true" read as ops would move a task out of its
 * worktree. Anything else is a change task, stored absent so saved plans need
 * no migration. Whether the task may be ops at all — a subtask may not — is
 * for whoever knows where it sits: the planner intake refuses it (`checkPlanInvariants`).
 */
export function opsFlag(value: unknown, type: Task['type'] = 'ai'): true | undefined {
  return value === true && type === 'ai' ? true : undefined;
}

/**
 * Whether a task runs as an ops task (ADR-0020): an AI task marked so, or a
 * script task, which is one by nature and never marked (ADR-0035).
 */
export function runsAsOps(task: Pick<Task, 'ops' | 'type'>): boolean {
  return task.type === 'script' || opsFlag(task.ops, task.type) === true;
}

/**
 * The flag of a task a merge or a split makes from others: what the edit
 * chose, else ops only when every task it came from was. A merge that takes
 * in a change edits files, so it is a change; a split part runs where its
 * task did.
 */
export function inheritedOps(from: readonly Pick<Task, 'ops'>[], chosen?: boolean): boolean {
  return chosen ?? from.every((t) => opsFlag(t.ops) === true);
}

/**
 * The runner set a plan has until one is chosen. The one runner named outside
 * its declaration on purpose: a default is a product choice that no manifest
 * or connector implies.
 */
export const DEFAULT_RUNNERS: readonly RunnerId[] = ['claude-code'];

export function createEmptyPlan(): LegacyPlanState {
  return {
    tasks: [],
    generatedAt: new Date().toISOString(),
    status: 'draft',
    runners: [...DEFAULT_RUNNERS],
    lastUpdated: new Date().toISOString(),
  };
}

export function flattenTasks(tasks: readonly Task[]): Task[] {
  return [...walkPlan(tasks)].map(({ task }) => task);
}

/**
 * A phase-tagged plan rejoined into its tree. The execution log is flat — a
 * finished subtask is logged on its own as well as inside its parent — and in
 * the order tasks finished, so read as a list it puts subtasks at the top level
 * under orders that clash with real top-level tasks. A task's own entry is the
 * latest word on it: its parent's copy was taken when the parent last changed.
 */
export function rejoinPlanTree<T extends { id: string; order: number; subtasks?: T[] }>(pending: readonly T[], log: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const task of [...pending, ...log]) latest.set(task.id, task);
  const nested = new Set<string>();
  const markNested = (task: T): void => {
    for (const sub of task.subtasks ?? []) {
      nested.add(sub.id);
      markNested(sub);
    }
  };
  for (const task of latest.values()) markNested(task);
  const rebuild = (task: T): T => {
    const own = latest.get(task.id) ?? task;
    return own.subtasks?.length ? { ...own, subtasks: own.subtasks.map(rebuild) } : own;
  };
  return [...latest.values()].filter((task) => !nested.has(task.id)).map(rebuild).sort((a, b) => a.order - b.order);
}

/**
 * A flattened task with the parent it hangs under, null for a top-level task,
 * and the path label and reference (`#2.1.3`) `TaskRefs` renders for it.
 */
export interface TaskWithParent {
  task: Task;
  parent: Task | null;
  label: string;
  ref: string;
}

export function flattenTasksWithParents(tasks: readonly Task[]): TaskWithParent[] {
  return [...walkPlan(tasks)].map(({ task, parent, label }) => ({ task, parent: parent ?? null, label, ref: `#${label}` }));
}

export function addTaskToPlan(tasks: readonly Task[], partial: Partial<Task>): Task[] {
  const maxOrder = tasks.reduce((max, t) => Math.max(max, t.order), 0);
  const newTask = createTask({
    ...partial,
    order: partial.order ?? maxOrder + 1,
    status: 'pending',
  });
  return renumberTasks([...tasks, newTask]);
}

/**
 * A removed task leaves every dependency on it, and every loop's body it was
 * in (ADR-0045 L8): a loop it leaves with no body is no loop. Whether its
 * removal may go ahead at all — a loop's check may not be removed — is the
 * caller's to say.
 */
export function removeTaskFromPlan(tasks: readonly Task[], taskId: string): Task[] {
  const removed = subtreeIds(tasks, taskId);
  const prune = (level: readonly Task[]): Task[] => level
    .filter((t) => !removed.has(t.id))
    .map((t) => {
      const pruned: Task = {
        ...t,
        dependencies: t.dependencies.filter((depId) => !removed.has(depId)),
        subtasks: prune(t.subtasks),
      };
      if (!t.loop?.body.some((id) => removed.has(id))) return pruned;
      const body = t.loop.body.filter((id) => !removed.has(id));
      if (body.length > 0) return { ...pruned, loop: { ...t.loop, body } };
      delete pruned.loop;
      delete pruned.loopRound;
      return pruned;
    });
  return renumberTasks(prune(tasks));
}

export function updateTaskInPlan(tasks: readonly Task[], taskId: string, changes: Partial<Task>): Task[] {
  return renumberTasks(
    tasks.map((t) => {
      if (t.id === taskId) return { ...t, ...changes, id: t.id };
      return { ...t, subtasks: updateTaskInPlan(t.subtasks, taskId, changes) };
    })
  );
}

export function renumberTasks(tasks: readonly Task[]): Task[] {
  return tasks.map((t, i) => ({
    ...t,
    order: i + 1,
    subtasks: renumberTasks(t.subtasks),
  }));
}

/** A task waiting on the user with its attempt still live: the runner sits at a checkpoint or for input. */
export function waitsMidAttempt(task: Pick<Task, 'status' | 'awaitingReason'>): boolean {
  return task.status === 'awaiting_user' && (task.awaitingReason === 'checkpoint' || task.awaitingReason === 'input');
}

/** A task paused on its runner's usage limit, whether it resumes on its own or waits for the user (#84). */
export function pausedOnLimit(task: Readonly<Task>): boolean {
  return task.status === 'awaiting_user' && task.awaitingReason === 'usage-limit';
}

/** A task paused on a usage limit that resumes on its own when the limit resets (#84). */
export function waitsForReset(task: Readonly<Task>): boolean {
  return pausedOnLimit(task) && !!task.resumeAt;
}

/** The user's approval record, as a plan carries it (ADR-0029). */
export type ApprovalRecord = Pick<LegacyPlanState, 'approved' | 'approvedTasks'>;

/** A copy of the plan's approval record, for a plan read whole; a field the plan lacks stays absent. */
export function approvalRecordOf(plan: ApprovalRecord): ApprovalRecord {
  return {
    ...(plan.approved !== undefined ? { approved: plan.approved } : {}),
    ...(plan.approvedTasks ? { approvedTasks: [...plan.approvedTasks] } : {}),
  };
}

/**
 * A task the scheduler leaves for the user (ADR-0035): an AI or script task
 * not started yet, in a plan they approved, outside their approval record —
 * the planner added it since, or changed a script's body. It starts once they
 * start it or execute the plan. In a plan they never approved nothing is
 * theirs yet, so nothing is singled out.
 */
export function waitsForApproval(task: Pick<Task, 'id' | 'type' | 'status'>, record: ApprovalRecord): boolean {
  return record.approved === true
    && task.type !== 'user'
    && (task.status === 'pending' || task.status === 'approved')
    && !(record.approvedTasks ?? []).includes(task.id);
}

/**
 * Who put each task of an adopted list in the plan. A task the plan already
 * had keeps its origin, whatever the planner wrote; a new one is the
 * supervisor's when `bySupervisor`, and nobody's in particular otherwise, so
 * no planner can mark its own task as the supervisor's. `added` lists the new
 * tasks, subtasks included.
 */
export function stampOrigin(before: readonly Task[], after: readonly Task[], bySupervisor: boolean): { tasks: Task[]; added: string[] } {
  const prior = new Map(flattenTasks([...before]).map((t) => [t.id, t]));
  const added: string[] = [];
  const stamp = (tasks: readonly Task[]): Task[] => tasks.map((t) => {
    const was = prior.get(t.id);
    const origin = was ? was.addedBy : bySupervisor ? 'supervisor' : undefined;
    if (!was) added.push(t.id);
    const stamped: Task = { ...t, subtasks: stamp(t.subtasks ?? []) };
    if (origin) stamped.addedBy = origin;
    else delete stamped.addedBy;
    return stamped;
  });
  return { tasks: stamp(after), added };
}

/** Done, running, or held for the user: execution state only a runner or the user can change. */
const SETTLED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'in_progress', 'awaiting_user']);

function holdsSettledWork(task: Task): boolean {
  return SETTLED_STATUSES.has(task.status) || (task.subtasks ?? []).some(holdsSettledWork);
}

/**
 * Lay a planner-written task list over the plan it rewrites without letting it
 * change execution state. A planner restates tasks; it never witnessed one run,
 * so the status it writes is not evidence. A settled task is kept exactly as
 * it stands wherever the rewrite names it, and put back beside its old
 * neighbour where the rewrite leaves it out. Every other task keeps the status
 * it had; a task the rewrite adds starts pending. A failed task the rewrite
 * turns into a script task or out of one is kept as it was: what ran, and
 * where, is fixed once it has run (ADR-0020, ADR-0035).
 */
export function keepExecutionState(current: readonly Task[], rewrite: Task[]): Task[] {
  const existing = new Map(flattenTasks(current).map((t) => [t.id, t]));
  const named = new Set(flattenTasks(rewrite).map((t) => t.id));

  const overlay = (tasks: Task[], was: readonly Task[]): Task[] => {
    const result = tasks.map((t): Task => {
      const prior = existing.get(t.id);
      if (prior && SETTLED_STATUSES.has(prior.status)) return { ...prior };
      if (prior?.status === 'failed' && (prior.type === 'script') !== (t.type === 'script')) return { ...prior };
      return {
        ...t,
        status: prior?.status ?? 'pending',
        skipReason: prior?.skipReason,
        reverted: prior?.reverted,
        verdict: prior?.verdict,
        outputSummary: prior?.outputSummary,
        handoff: prior?.handoff,
        runnerSessionId: prior?.runnerSessionId,
        runnerSessionOwner: prior?.runnerSessionOwner,
        carriedFrom: prior?.carriedFrom,
        attemptSkills: prior?.attemptSkills,
        attempted: prior?.attempted,
        attemptUsage: prior?.attemptUsage,
        loopRound: prior?.loopRound,
        waitsEnded: prior?.waitsEnded,
        // Where a task that has run ran is fixed, like its runner session (ADR-0020).
        ...(prior?.status === 'failed' ? { ops: prior.ops } : {}),
        forcedPastGate: prior?.forcedPastGate,
        reportTo: prior?.reportTo,
        researchOrigin: prior?.researchOrigin,
        subtasks: overlay(t.subtasks ?? [], prior?.subtasks ?? []),
      };
    });
    was.forEach((left, i) => {
      if (named.has(left.id) || !holdsSettledWork(left)) return;
      const neighbour = was.slice(0, i).reverse().find((t) => result.some((r) => r.id === t.id));
      const at = neighbour ? result.findIndex((r) => r.id === neighbour.id) + 1 : 0;
      result.splice(at, 0, { ...left });
    });
    return result;
  };

  return renumberTasks(overlay(rewrite, current));
}
