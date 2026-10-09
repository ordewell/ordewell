import { v4 as uuidv4 } from 'uuid';
import type { PlanIsolation } from '../interfaces/IWorktreeIsolation';
import type { RunnerTransport } from '../interfaces/ITerminalRunner';
import type { PlannerUsage, UsageRecord, UsageTotals } from './Usage';
import type { SkillSource } from '../services/SkillsService';

export interface UserStep {
  order: number;
  instruction: string;
  completed: boolean;
}

/** One deterministic signal gathered while verifying a completed task. */
export interface VerificationCheck {
  name: 'exit_code' | 'completion_marker' | 'task_complete' | 'manual';
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
}

export interface TaskOutputSummary {
  reviewReason: string;
  logTail: string;
  capturedAt: string;
}

export type TaskType = 'ai' | 'user';
export type TaskStatus = 'pending' | 'approved' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'awaiting_user';
export type TaskMode = string;

/**
 * Why an `awaiting_user` task waits (ADR-0018, W1): a structured turn that
 * ended without the done marker, a checkpoint question, work that did not
 * land, or an ops task that changed tracked files (ADR-0020). Saved, so no
 * surface has to guess it from whether an attempt is live.
 */
export type AwaitingReason = 'input' | 'checkpoint' | 'conflict' | 'files-changed';

export function isAwaitingReason(value: unknown): value is AwaitingReason {
  return value === 'input' || value === 'checkpoint' || value === 'conflict' || value === 'files-changed';
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
 * How a task's latest attempt was driven (ADR-0018). Recorded only when its
 * plan asked for the structured transport, so a terminal plan's tasks carry
 * nothing new.
 */
export interface TaskTransport {
  kind: RunnerTransport;
  /** Why a plan that asked for structured ran this task on the terminal — never a silent downgrade (S3). */
  fallback?: string;
  /** The runner's own session id of a structured attempt, once it ends: what a continue resumes (K1). */
  nativeSessionId?: string;
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
  assignedModel?: TaskModelAssignment;
  assignedRunner: RunnerId;
  thinkingEffort?: string;
  taskMode?: TaskMode;
  completionMarker: string;
  autonomy?: 'AFK' | 'HITL';
  sliceType?: 'HITL' | 'AFK';
  userStoriesCovered?: string[];
  transport?: TaskTransport;
  /** Set only while `status` is `awaiting_user`, and not always then — a usage-limit pause has none. */
  awaitingReason?: AwaitingReason;
  /**
   * An ops task (ADR-0020): it changes no repository files, runs at the
   * workspace root rather than in a worktree, and waits for the change tasks
   * it depends on to be merged into the user's branch. Top-level AI tasks
   * only; absent means a change task.
   */
  ops?: boolean;
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
}

export interface DiscoveredMode {
  id: string;
  label: string;
  description: string;
}

export type ResearchToolType =
  | 'read_file' | 'read_files' | 'glob' | 'grep' | 'find_symbol' | 'list_dir'
  | 'bash' | 'fetch' | 'web_search' | 'spawn_research_agent'
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
  // `usage`.
  type:
    | 'thinking' | 'tool_call' | 'tool_result' | 'plan_token' | 'interrupted' | 'liveness'
    | 'text_delta' | 'text_retracted' | 'usage' | 'subagent_started' | 'subagent_finished';
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
   * unknown rather than defaulted to zero.
   */
  contextWindow?: number;
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
   * user-triggered compaction left in place of the earlier messages — always
   * the transcript's first entry. 'skill_load' is a skill loaded into the
   * conversation, its snapshot in `skill`; one the user invoked follows the
   * message that named it. Absent for ordinary chat turns, so sessions saved
   * before markers existed degrade gracefully.
   */
  kind?: 'plan_generated' | 'system' | 'compaction' | 'skill_load';
  /** Present exactly when `kind` is 'skill_load'. */
  skill?: SkillLoad;
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

/** A message the user sent, as opposed to a skill load their message caused. */
export function isUserMessage(entry: ConversationMessage): boolean {
  return entry.role === 'user' && entry.kind !== 'skill_load';
}

export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: string;
  /** What its `/name` tokens loaded when it was sent: the drain composes them with the text, as a live send does. */
  skills?: SkillLoad[];
}

export interface PlanModificationWarnings {
  deletedCompleted: string[];
  changedCompleted: string[];
  deletedInProgress: string[];
  modifiedInProgress: string[];
  brokenDependencies: string[];
}

export function emptyWarnings(): PlanModificationWarnings {
  return { deletedCompleted: [], changedCompleted: [], deletedInProgress: [], modifiedInProgress: [], brokenDependencies: [] };
}

export interface LegacyPlanState {
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
  /** Follow-ups queued while tasks execute — applied as plan modifications between batches. */
  queuedMessages?: QueuedMessage[];
  /**
   * The plan's isolation run (ADR-0013), written from the orchestrator at
   * persist time and read back only when a saved plan is adopted. It names
   * branches and worktrees that belong to this plan alone: a fork of the plan
   * must leave it behind rather than share it.
   */
  isolation?: PlanIsolation;
  /** Kept so a reopened session shows the same token line (#49). */
  plannerUsage?: PlannerUsage;
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

export type PlanState =
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
    };

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
      (t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'blocked',
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
    };
  }

  return {
    phase: 'planning',
    history: messages,
    message: '',
    pendingTasks: raw.tasks,
  };
}

export function migrateLegacyPlan(legacy: LegacyPlanState): PlanState {
  const messages: Message[] = [];

  if (legacy.researchLog) {
    messages.push(...legacy.researchLog.map(logEntryToMessage));
  }

  if (legacy.queuedMessages) {
    for (const qm of legacy.queuedMessages) {
      messages.push({
        id: qm.id,
        role: 'system',
        content: qm.text,
        timestamp: new Date(qm.timestamp).getTime(),
      });
    }
  }

  const isPlanning = legacy.status === 'draft' || legacy.status === 'approved' || legacy.status === 'rejected';

  if (isPlanning) {
    return {
      phase: 'planning',
      history: messages,
      message: 'Plan generation',
      pendingTasks: legacy.tasks.filter((t) => t.status === 'pending' || t.status === ('draft' as never)),
    };
  }

  const nonCompletedTasks = legacy.tasks.filter(
    (t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'blocked'
  );

  const completedSnapshot: TaskSnapshot[] = legacy.tasks
    .filter((t) => t.status === 'completed' || t.status === 'failed')
    .map((t) => ({
      ...t,
      completedAt: new Date(legacy.lastUpdated).getTime(),
      verdict: t.verdict,
      retryCount: 0,
      finalized: true,
    }));

  return {
    phase: 'executing',
    history: messages,
    message: 'Plan migration',
    executionLog: completedSnapshot,
    pendingTasks: nonCompletedTasks,
    goal: 'Plan migration',
    runners: legacy.runners,
    status: legacy.status,
  };
}

export { taskOrderLabel, taskRef, titledTaskRef, resolveOrderLabel } from '../order-labels';

export function createTask(overrides: Partial<Task> = {}): Task {
  const skills = skillNames(overrides.skills);
  return {
    id: overrides.id ?? uuidv4(),
    order: overrides.order ?? 0,
    title: overrides.title ?? '',
    description: overrides.description ?? '',
    type: overrides.type ?? 'ai',
    status: overrides.status ?? 'pending',
    dependencies: overrides.dependencies ?? [],
    prompt: overrides.prompt,
    userSteps: overrides.userSteps,
    subtasks: overrides.subtasks ?? [],
    verdict: overrides.verdict,
    outputSummary: overrides.outputSummary,
    assignedModel: overrides.assignedModel,
    assignedRunner: overrides.assignedRunner ?? 'claude-code',
    thinkingEffort: overrides.thinkingEffort,
    taskMode: overrides.taskMode ?? 'build',
    completionMarker: overrides.completionMarker ?? uuidv4(),
    autonomy: overrides.autonomy,
    sliceType: overrides.sliceType,
    userStoriesCovered: overrides.userStoriesCovered,
    ...(opsFlag(overrides.ops, overrides.type) ? { ops: true } : {}),
    ...(skills ? { skills } : {}),
  };
}

/**
 * A name a skill can have, lower-cased as `/name` is. Anything else — a path
 * separator, `..` — is joined into a path and could only reach outside the
 * skill dirs.
 */
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

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
 * for whoever knows where it sits: parsing drops the flag, an edit refuses it.
 */
export function opsFlag(value: unknown, type: Task['type'] = 'ai'): true | undefined {
  return value === true && type === 'ai' ? true : undefined;
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

/** The runner set a plan has until one is chosen: the one runner every host ships. */
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
  return tasks.flatMap((t) => [t, ...flattenTasks(t.subtasks ?? [])]);
}

/** A flattened task with the parent it hangs under, null for a top-level task. */
export interface TaskWithParent {
  task: Task;
  parent: Task | null;
}

export function flattenTasksWithParents(tasks: readonly Task[]): TaskWithParent[] {
  const rows: TaskWithParent[] = [];
  const walk = (t: Task, parent: Task | null) => {
    rows.push({ task: t, parent });
    for (const sub of t.subtasks ?? []) walk(sub, t);
  };
  for (const t of tasks) walk(t, null);
  return rows;
}

export function migrateTask(task: Record<string, unknown>): Task {
  if (!task.assignedModel) {
    task.assignedModel = undefined;
  }
  if (!task.assignedRunner) {
    task.assignedRunner = 'claude-code';
  }
  if (!task.thinkingEffort) {
    task.thinkingEffort = undefined;
  }
  if (!task.completionMarker) {
    task.completionMarker = uuidv4();
  }
  if (task.verdict && task.verification) {
    delete task.verification;
  }
  if (!task.autonomy) {
    task.autonomy = undefined;
  }
  if (!task.sliceType) {
    task.sliceType = undefined;
  }
  if (!task.userStoriesCovered) {
    task.userStoriesCovered = undefined;
  }
  return task as unknown as Task;
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

export function removeTaskFromPlan(tasks: readonly Task[], taskId: string): Task[] {
  const result = tasks
    .filter((t) => t.id !== taskId)
    .map((t) => ({
      ...t,
      dependencies: t.dependencies.filter((depId) => depId !== taskId),
      subtasks: removeTaskFromPlan(t.subtasks, taskId),
    }));
  return renumberTasks(result);
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
 * it had; a task the rewrite adds starts pending.
 */
export function keepExecutionState(current: readonly Task[], rewrite: Task[]): Task[] {
  const existing = new Map(flattenTasks(current).map((t) => [t.id, t]));
  const named = new Set(flattenTasks(rewrite).map((t) => t.id));

  const overlay = (tasks: Task[], was: readonly Task[]): Task[] => {
    const result = tasks.map((t): Task => {
      const prior = existing.get(t.id);
      if (prior && SETTLED_STATUSES.has(prior.status)) return { ...prior };
      return {
        ...t,
        status: prior?.status ?? 'pending',
        verdict: prior?.verdict,
        outputSummary: prior?.outputSummary,
        transport: prior?.transport,
        attemptSkills: prior?.attemptSkills,
        // Where a task that has run ran is fixed, like its transport (ADR-0020).
        ...(prior?.status === 'failed' ? { ops: prior.ops } : {}),
        forcedPastGate: prior?.forcedPastGate,
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

/** What only execution reads; {@link keepExecutionState} puts it back on whatever a planner returns. */
const EXECUTION_ONLY = ['attemptSkills', 'transport', 'awaitingReason', 'completionMarker', 'forcedPastGate', 'outputSummary'] as const satisfies readonly (keyof Task)[];

export type PlannerTaskView = Omit<Task, typeof EXECUTION_ONLY[number] | 'subtasks'> & { subtasks: PlannerTaskView[] };

/**
 * A task as a planner prompt carries it. An attempt's skill snapshots are
 * whole SKILL.md bodies and an output summary holds a log tail: sent on every
 * planner call, they cost tokens and invite the planner to edit state it does
 * not own.
 */
export function plannerTaskView(task: Task): PlannerTaskView {
  const view: Record<string, unknown> = { ...task, subtasks: (task.subtasks ?? []).map(plannerTaskView) };
  for (const key of EXECUTION_ONLY) delete view[key];
  return view as PlannerTaskView;
}

export function validateModifiedPlan(original: Task[], modified: Task[]): PlanModificationWarnings {
  const allOriginal = flattenTasks(original);
  const allModified = flattenTasks(modified);
  const warnings = emptyWarnings();
  const originalMap = new Map(allOriginal.map((t) => [t.id, t]));
  const modifiedIds = new Set(allModified.map((t) => t.id));

  for (const ot of originalMap.values()) {
    if (ot.status === 'completed' && !modifiedIds.has(ot.id)) {
      warnings.deletedCompleted.push(ot.title);
    } else if (ot.status === 'in_progress' && !modifiedIds.has(ot.id)) {
      warnings.deletedInProgress.push(ot.title);
    }
  }

  for (const mt of allModified) {
    const orig = originalMap.get(mt.id);
    if (orig) {
      if (orig.status === 'completed' && mt.status !== 'completed') {
        warnings.changedCompleted.push(orig.title);
      }
      if (orig.status === 'in_progress' && (mt.status !== 'in_progress' || mt.prompt !== orig.prompt)) {
        warnings.modifiedInProgress.push(orig.title);
      }
      if (orig.status === 'failed' && mt.status === 'pending') {
        for (const dt of allModified) {
          if (dt.dependencies.includes(mt.id) && dt.status === 'blocked') {
            dt.status = 'pending';
          }
        }
      }
    }
  }

  for (const t of allModified) {
    for (const depId of t.dependencies) {
      if (!modifiedIds.has(depId)) {
        warnings.brokenDependencies.push(`${t.title} → ${depId}`);
      }
    }
  }

  return warnings;
}

export interface ActiveTaskSession {
  id: string;
  taskId: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidationContext {
  executionLog: TaskSnapshot[];
  oldPending: Task[];
  newPending: Task[];
  activeSessions: Map<string, ActiveTaskSession>;
}

export type ValidationCheck = (ctx: ValidationContext) => ValidationResult;

export function warningsText(w: PlanModificationWarnings): string | null {
  const lines: string[] = [];
  if (w.deletedCompleted.length) lines.push(`Completed tasks deleted: ${w.deletedCompleted.join(', ')}`);
  if (w.changedCompleted.length) lines.push(`Completed tasks modified: ${w.changedCompleted.join(', ')}`);
  if (w.deletedInProgress.length) lines.push(`In-progress tasks deleted: ${w.deletedInProgress.join(', ')}`);
  if (w.modifiedInProgress.length) lines.push(`In-progress tasks modified: ${w.modifiedInProgress.join(', ')}`);
  if (w.brokenDependencies.length) lines.push(`Broken dependencies: ${w.brokenDependencies.join(', ')}`);
  return lines.length > 0 ? lines.join('\n') : null;
}
