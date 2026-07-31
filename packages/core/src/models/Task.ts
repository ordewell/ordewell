import { v4 as uuidv4 } from 'uuid';

export interface UserStep {
  order: number;
  instruction: string;
  completed: boolean;
}

/** One deterministic signal gathered while verifying a completed task. */
export interface VerificationCheck {
  name: 'exit_code' | 'completion_marker' | 'manual';
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
  timestamp: string;
  thinkingText?: string;
}

export interface UserPromptEntry {
  id: string;
  type: 'user_prompt' | 'system';
  content: string;
  timestamp: string;
}

export type ResearchLogEntry = ResearchStep | UserPromptEntry;

export interface ResearchProgress {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'plan_token' | 'interrupted';
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
   * 'system' is a host-injected notice. Absent for ordinary chat turns, so
   * sessions saved before markers existed degrade gracefully.
   */
  kind?: 'plan_generated' | 'system';
}

export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: string;
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

function migrateHistory(raw: LegacyPlanState): Message[] {
  const messages: Message[] = [];

  if (raw.researchLog) {
    for (const entry of raw.researchLog) {
      if ('type' in entry && entry.type === 'user_prompt') {
        messages.push({
          id: entry.id,
          role: 'user',
          content: (entry as UserPromptEntry).content,
          timestamp: new Date(entry.timestamp).getTime(),
        });
      } else {
        const step = entry as ResearchStep;
        messages.push({
          id: step.id,
          role: 'system',
          content: JSON.stringify({ tool: step.tool, args: step.args, result: step.result }),
          timestamp: new Date(step.timestamp).getTime(),
        });
      }
    }
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
    for (const entry of legacy.researchLog) {
      if ('type' in entry && entry.type === 'user_prompt') {
        messages.push({
          id: entry.id,
          role: 'user',
          content: (entry as UserPromptEntry).content,
          timestamp: new Date(entry.timestamp).getTime(),
        });
      } else {
        const step = entry as ResearchStep;
        messages.push({
          id: step.id,
          role: 'system',
          content: JSON.stringify({ tool: step.tool, args: step.args, result: step.result }),
          timestamp: new Date(step.timestamp).getTime(),
        });
      }
    }
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

export function createTask(overrides: Partial<Task> = {}): Task {
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
  };
}

export function createEmptyPlan(): LegacyPlanState {
  return {
    tasks: [],
    generatedAt: new Date().toISOString(),
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
  };
}

export function flattenTasks(tasks: Task[]): Task[] {
  return tasks.flatMap((t) => [t, ...flattenTasks(t.subtasks ?? [])]);
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

export function addTaskToPlan(tasks: Task[], partial: Partial<Task>): Task[] {
  const maxOrder = tasks.reduce((max, t) => Math.max(max, t.order), 0);
  const newTask = createTask({
    ...partial,
    order: partial.order ?? maxOrder + 1,
    status: 'pending',
  });
  return renumberTasks([...tasks, newTask]);
}

export function removeTaskFromPlan(tasks: Task[], taskId: string): Task[] {
  const result = tasks
    .filter((t) => t.id !== taskId)
    .map((t) => ({
      ...t,
      dependencies: t.dependencies.filter((depId) => depId !== taskId),
      subtasks: removeTaskFromPlan(t.subtasks, taskId),
    }));
  return renumberTasks(result);
}

export function updateTaskInPlan(tasks: Task[], taskId: string, changes: Partial<Task>): Task[] {
  return renumberTasks(
    tasks.map((t) => {
      if (t.id === taskId) return { ...t, ...changes, id: t.id };
      return { ...t, subtasks: updateTaskInPlan(t.subtasks, taskId, changes) };
    })
  );
}

export function renumberTasks(tasks: Task[]): Task[] {
  return tasks.map((t, i) => ({
    ...t,
    order: i + 1,
    subtasks: renumberTasks(t.subtasks),
  }));
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
