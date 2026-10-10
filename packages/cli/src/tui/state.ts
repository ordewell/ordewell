import { DEFAULT_MAX_PARALLEL, EMPTY_CONVERSATION, EMPTY_HOLD, NO_TURN, isTaskRunning, type AiProvider, type ApprovalBlock, type AwaitingReason, type ConversationView, type PromptHold, type TaskLogEvent, type TaskLogView, type TurnGate } from '@ordewell/core';
import { emptyEditor, type EditorState } from './editor';

export type RunStatus = 'idle' | 'planning' | 'researching' | 'executing';

export interface TaskView {
  id: string;
  order: number;
  title: string;
  description?: string;
  prompt?: string;
  type: 'ai' | 'user';
  status: string;
  /** Advisory silence timestamp from VerdictEngine — set while the task's runner has gone quiet. */
  idleSince?: string | null;
  dependencies: string[];
  assignedRunner?: string;
  taskMode?: string;
  assignedModel?: {
    modelId: string;
    modelLabel: string;
    thinkingEffort?: string;
    availableVariants?: string[];
  };
  /** Absent until the daemon reports a task's isolation; quiet in the pane unless there is a conflict. */
  isolation?: TaskIsolationView;
  /** What an `awaiting_user` task waits on, when the daemon saved why. */
  awaitingReason?: AwaitingReason;
  /** The whole question of the checkpoint the task waits at, while it does. */
  checkpoint?: string;
  /** A finished structured task the daemon can continue in its saved session (ADR-0018, K1). */
  continuable?: boolean;
  /** How many of its runner's tool requests wait for an answer (ADR-0018, A1); absent when none do. */
  awaitingApproval?: number;
  /** An ops task (ADR-0020): it runs in the user's checkout, never a worktree. */
  ops?: boolean;
  /** Task skills attached by name, put in the runner's prompt at spawn. */
  skills?: string[];
  /** The dependencies whose work must be merged into the user's branch before this task can go on (ADR-0020). */
  mergeGate?: string[];
  /** The dependencies, by title, a force start went past the merge gate of. */
  forcedPastGate?: string[];
  /** Child tasks, recursively shaped the same way; absent until populated by `toTaskView`. */
  subtasks?: TaskView[];
}

/** Where a task's isolated work stands (ADR-0013); `none` is a task with no worktree in a run that has some. */
export type TaskIsolationState = 'none' | 'active' | 'integrated' | 'conflict' | 'repairing' | 'kept';

export interface TaskIsolationView {
  state: TaskIsolationState;
  branch?: string;
  /** The task workspace; for a single repo, the task's worktree. */
  worktree?: string;
  /** Paths of the repos the task changed. */
  repos?: string[];
  conflictRepo?: string;
  /** Repo-relative paths, in `conflictRepo`, that conflicted. */
  conflictFiles?: string[];
  /** The conflict repair running or last run (ADR-0015), of the most a task may have. */
  repair?: { attempt: number; limit: number };
  repairedFiles?: string[];
}

export interface LandedTaskView {
  taskId: string;
  order: number;
  title: string;
  /** Set when the task landed only after a conflict repair (ADR-0015): the files it was started for. */
  repairedFiles?: string[];
}

/** One repo's part of a handoff: its integration branch, where it forked, and what landed in it. */
export interface HandoffRepoView {
  path: string;
  integrationBranch: string;
  baseRef: string;
  landed: LandedTaskView[];
}

/** What an isolated run left for the user to land: each repo's branch and base, and what landed, in plan order. */
export interface HandoffView {
  repos: HandoffRepoView[];
  landed: LandedTaskView[];
}

/**
 * A run with tasks at a merge gate (ADR-0020): what Merge all would merge
 * now, and whether the run waits on it with nothing else running.
 */
export interface GateView {
  paused: boolean;
  handoff: HandoffView;
}

/** One mode a runner's manifest declares, as the mode picker offers it. */
export interface ModeView {
  id: string;
  label: string;
  description?: string;
  /** Tagged `autonomous: true` on the manifest — runs without permission prompts. */
  autonomous?: boolean;
}

export interface SkillChoiceView {
  name: string;
  description: string;
}

/** A user message `/rewind` can land just before — `index` is its transcript position. */
export interface RewindTargetView {
  index: number;
  preview: string;
  /** The whole message, for the confirmation to quote — `preview` is one clipped line. */
  content: string;
  timestamp: string;
}

export interface RunnerView {
  id: string;
  name: string;
  enabled: boolean;
}

export interface SessionView {
  id: string;
  goal: string;
  taskCount: number;
  status: string;
  createdAt: string;
}

export interface ModelView {
  id: string;
  label: string;
  provider: string;
  pricing?: string;
  variants?: { id: string; label: string }[];
  /** Executor runners that exposed this model during discovery. */
  runners?: string[];
}

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  selected?: boolean;
  /**
   * Shown but not choosable — a coding agent whose CLI isn't installed, say.
   * Listing it with the reason beats hiding it: "why isn't Codex here?" is a
   * worse question than "Codex — not installed".
   */
  disabled?: boolean;
}

/** What the runtime should do with the item(s) the user picks. */
export type PickerAction =
  | { kind: 'set-model' }
  | { kind: 'set-planner' }
  | { kind: 'set-planner-effort' }
  | { kind: 'set-key' }
  | { kind: 'load-session' }
  | { kind: 'delete-session' }
  | { kind: 'rewind' }
  | { kind: 'isolation-blocked' }
  | { kind: 'set-runners' }
  | { kind: 'choose-allowlist-runner' }
  | { kind: 'set-allowlist'; runner: string }
  | { kind: 'set-task-runner'; taskId: string }
  | { kind: 'set-task-model'; taskId: string }
  | { kind: 'set-task-effort'; taskId: string }
  | { kind: 'set-task-mode'; taskId: string }
  | { kind: 'set-task-deps'; taskId: string }
  | { kind: 'set-task-skills'; taskId: string };

export interface PickerState {
  title: string;
  hint?: string;
  items: PickerItem[];
  filter: string;
  index: number;
  /** Multi-select pickers toggle with space and confirm the whole set on enter. */
  multi: boolean;
  chosen: string[];
  action: PickerAction;
}

/**
 * The rows a picker currently offers. Lives with `PickerState` rather than in
 * the reducer: the renderer needs the same list to paint and to keep the
 * highlight on screen, and importing it from the reducer pointed the render
 * layer back at the layer that drives it.
 */
export function visibleItems(picker: PickerState): PickerItem[] {
  const filter = picker.filter.trim().toLowerCase();
  if (!filter) return picker.items;
  // `detail` carries the provider name, so typing e.g. "openrouter" narrows to
  // that provider's models alongside id/label matches.
  return picker.items.filter(
    (i) =>
      i.id.toLowerCase().includes(filter) ||
      i.label.toLowerCase().includes(filter) ||
      (i.detail ?? '').toLowerCase().includes(filter),
  );
}

/** A planner approval prompt awaiting a yes/no. Mirrors the daemon's SessionMessage. */
export interface ApprovalRequestView {
  id: string;
  kind: 'external_path' | 'shell_command' | 'url_fetch' | 'mcp_tool';
  subject: string;
  scope: string;
  detail?: string;
}

export type Overlay =
  | { kind: 'help'; scroll?: number }
  | { kind: 'approval'; request: ApprovalRequestView }
  | { kind: 'picker'; picker: PickerState }
  /**
   * The end-of-run handoff. `index` is the highlighted action; `diff` replaces
   * the action list while the integration branch's diff is being read.
   */
  | { kind: 'handoff'; index: number; diff: { lines: string[]; scroll: number } | null }
  | { kind: 'prompt'; title: string; hint?: string; value: string; action: PromptAction }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      action: ConfirmAction;
      /** Text shown quoted under `message`; a blank line separates them. */
      quote?: string;
      /** Closing lines under the quote, one per `\n`. */
      note?: string;
      /** Named answers in place of the bare enter/esc; absent, enter runs `action` and esc cancels. */
      choice?: ConfirmChoice;
    };

export interface ConfirmOption {
  label: string;
  /** Whether choosing this runs the overlay's `action`; otherwise it just closes. */
  confirms: boolean;
}

export interface ConfirmChoice {
  options: ConfirmOption[];
  /** The highlighted option — what enter chooses. */
  index: number;
}

/** A free-text prompt overlay — used where a list of options makes no sense. */
export type PromptAction =
  | { kind: 'api-key'; provider: string; envVar: string }
  | { kind: 'add-task' };

/** A confirmation overlay for destructive actions — enter confirms, escape cancels, unless it offers a `choice`. */
export type ConfirmAction =
  | { kind: 'new-session' }
  | { kind: 'remove-task'; taskId: string }
  | { kind: 'force-start-gated'; taskId: string }
  | { kind: 'merge-run' }
  | { kind: 'discard-run' }
  | { kind: 'init-workspace'; goal: string; workspace: string }
  | { kind: 'rewind'; index: number };

export type Focus = 'chat' | 'plan';

/** One terminal cell, 1-based in both axes — the way a mouse report names it. */
export interface Cell {
  col: number;
  row: number;
}

/**
 * A drag in progress, or the range it left behind. `pane` is decided by where
 * the button went down and never moves after that: both panes are painted on
 * the same physical rows, so a range allowed to span the divider would splice
 * the neighbour's text into every copied line.
 */
export interface Selection {
  anchor: Cell;
  head: Cell;
  pane: Focus;
}

/**
 * What the chat pane shows when it has been swapped for a structured task's
 * log (ADR-0018, V1). `view` is core's own block view, folded from the saved
 * log on open and then from the live `task_log` stream, so a reload and a live
 * run draw identically.
 */
export interface TaskLogState {
  taskId: string;
  view: TaskLogView;
  /** Attempts with a saved log, oldest first, as last read. */
  attempts: number[];
  /** The attempt `view` holds; 0 until the saved log or a live event names one. */
  attempt: number;
  /**
   * Live batches that arrived while the saved log was still loading. A batch
   * for the loaded attempt is a copy the file already holds and is dropped; a
   * batch for a different attempt (a retry that raced the read) is folded.
   */
  pending: { attempt: number; events: TaskLogEvent[] }[];
  /** The saved log has been read (or found absent). Until then live batches wait in `pending`. */
  loaded: boolean;
  /** Keep following the newest attempt as the task retries; a manual switch turns this off. */
  followLatest: boolean;
  /** Which queued message the remove key targets. */
  queuedIndex: number;
}

export interface TuiState {
  editor: EditorState;
  /**
   * The chat pane's content: core's display blocks (#51), fed every planner
   * `SessionMessage` and every line the TUI adds itself as a `LocalEntry`.
   */
  conversation: ConversationView;
  /** Set while the chat pane is drawing a structured task's log; null is the planner chat. */
  taskView: TaskLogState | null;
  /** The planner turn the conversation has open, and the one the user stopped — core's stop rule. */
  turnGate: TurnGate;
  /**
   * Whether thinking, command and subagent blocks draw in full. One switch for
   * the whole conversation on purpose: with no block opening on its own there
   * is no set of expanded ids and no focus cursor to keep in step with a
   * stream that inserts, replaces and retracts blocks under them.
   */
  detailAll: boolean;
  status: RunStatus;
  /** Short label shown next to the spinner, e.g. the current research step. */
  busyLabel: string;
  sessionId: string | null;
  goal: string;
  tasks: TaskView[];
  planApproved: boolean;
  focus: Focus;
  /** Index into `planRows` (top-level tasks, plus an expanded task's subtasks) for the plan pane's cursor. */
  selectedTask: number;
  /** The selected task can expand in place to show its complete specification. */
  expandedTaskId: string | null;
  /** Editable draft of the expanded task's prompt; set together with `expandedTaskId`. */
  taskEditor: EditorState | null;
  /** Lines the transcript is scrolled back from its tail; 0 follows live output. */
  scroll: number;
  /**
   * The plan pane's viewport, as an absolute line offset. It holds still while
   * the cursor walks inside it and moves only to keep the selection on screen.
   * `null` means nothing has positioned it yet: it is derived from the
   * selection until the first key or resize settles it into a number.
   */
  planScroll: number | null;
  runners: RunnerView[];
  sessions: SessionView[];
  /** The open `/rewind` picker's rows; `null` until the daemon has answered. */
  rewindTargets: RewindTargetView[] | null;
  models: ModelView[];
  /** Each runner's manifest modes, keyed by runner id — a task's mode picker reads its own runner's list. */
  modesByRunner: Record<string, ModeView[]>;
  /** Every `applies-to: task` skill, user-only ones included — what a task's skills picker offers. */
  taskSkills: SkillChoiceView[];
  /** Cross-provider catalog for the orchestrator (planner) model picker. */
  orchestratorModels: ModelView[];
  /** Per-provider catalog-fetch failures, keyed by provider id. */
  providerErrors: Record<string, string>;
  orchestratorModel: string;
  /**
   * Who plans (ADR-0009): a vendor provider id, or one of the three harness
   * planners. Drives `/planner`, and decides whether `/model` offers the
   * cross-provider catalog or that coding agent's own models.
   */
  plannerProvider: string;
  /**
   * Thinking effort for a harness planner — one of the selected model's own
   * variants, or empty for the agent's default. Meaningless for a vendor
   * planner, whose effort is baked into the model id.
   */
  plannerEffort: string;
  /** How many AI tasks run at once, as the daemon reports it. */
  maxParallel: number;
  configuredProviders: AiProvider[];
  allowlist: Record<string, string[]>;
  autonomous: boolean;
  /**
   * Whether the terminal's mouse is captured for wheel scrolling. On by
   * default; `/mouse off` hands it back when selecting text out of the
   * transcript matters more than the wheel. See terminal.ts.
   */
  mouseCapture: boolean;
  /**
   * The cells the user is dragging over, or `null` when nothing is selected.
   * Lives only for the drag: release both copies the text and clears this,
   * because `Cell`s name screen rows, not content, and the copy notice appends
   * a chat message that reflows the transcript underneath a standing highlight.
   */
  selection: Selection | null;
  workspace: string;
  /** The isolated run awaiting a decision, if any. Cleared once it is discarded. */
  handoff: HandoffView | null;
  /** A run whose tasks wait at a merge gate, so Merge all is offered mid-run; null otherwise. */
  gate: GateView | null;
  overlay: Overlay | null;
  /**
   * Approval prompts not yet shown. The planner blocks on each one, so they are
   * answered one at a time rather than stacking modals on top of each other.
   */
  pendingApprovals: ApprovalRequestView[];
  /**
   * Prompts held back while a planner turn answers. They are visible as dimmed
   * bubbles (so "did I send that?" has a visible answer) and go out one per
   * settling turn, oldest first.
   */
  queuedPrompts: PromptHold;
  /**
   * A first Esc during a planner turn: the stop is armed and one more Esc
   * commits it. Cleared by `stopDisarmed`, which the runtime schedules, or by
   * the next key that is not Esc.
   */
  stopArmed: boolean;
  /**
   * The arm `stopArmed` belongs to. Each arming bumps it, so the expiry a
   * previous arm scheduled can never disarm a later one out of turn.
   */
  stopArmToken: number;
  /**
   * The user stopped the turn still in flight. The daemon answers an aborted
   * turn with an error, and that error is the stop itself, not news.
   */
  stopRequested: boolean;
  toast: string;
  rows: number;
  cols: number;
  exiting: boolean;
  /** Cycles while a task is running to animate the plan pane's spinner. */
  spinnerFrame: number;
}

export { isTaskRunning };

/**
 * Whether the plan pane has a spinner to animate. Deliberately not
 * `status === 'executing'`: a single force-started task never puts the whole
 * session into a run, and its icon still has to turn.
 */
export const anyTaskRunning = (state: TuiState): boolean => state.tasks.some(isTaskRunning);

/**
 * A planner turn the user can still call off — research rounds included.
 * Every in-flight question and hint is asked through here, so a new status
 * that counts as planning cannot be missed in one place and honoured in
 * another.
 */
export const plannerInFlight = (state: TuiState): boolean =>
  state.status === 'planning' || state.status === 'researching';

/** One navigable row of the plan pane — a top-level task, or a subtask shown under an open parent. */
export interface PlanRow {
  task: TaskView;
  parent: TaskView | null;
}

/**
 * The plan pane's navigable rows in display order: each top-level task followed
 * by its subtasks whenever the parent is open. `selectedTask` indexes this list,
 * never `state.tasks` directly — the reducer and the renderer would otherwise
 * each reinvent the flattening and drift apart.
 *
 * A parent stays open while one of its subtasks is itself expanded, or the row
 * under the cursor (and its prompt editor) would vanish the moment right opens
 * it. Only one level nests: a subtask's own children are never shown.
 */
export function planRows(state: TuiState): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const task of state.tasks) {
    rows.push({ task, parent: null });
    const subtasks = task.subtasks ?? [];
    const open = state.expandedTaskId === task.id || subtasks.some((s) => s.id === state.expandedTaskId);
    if (open) {
      for (const subtask of subtasks) rows.push({ task: subtask, parent: task });
    }
  }
  return rows;
}

/** The row the plan pane's cursor points at, or null for an empty plan. */
export function selectedPlanRow(state: TuiState): PlanRow | null {
  return planRows(state)[state.selectedTask] ?? null;
}

/** The request the task view's approval keys answer: the oldest one still waiting in the attempt on screen. */
export function waitingApproval(tv: TaskLogState): ApprovalBlock | undefined {
  return tv.view.blocks.find((b): b is ApprovalBlock => b.type === 'approval' && b.status === 'pending' && b.approvalId !== undefined);
}

/**
 * The question the task view's checkpoint keys answer, while the task waits at
 * it. The daemon sends it with the status, so a view opened after the question
 * was asked still has it.
 */
export function waitingCheckpoint(task: TaskView | undefined): string | undefined {
  return task?.status === 'awaiting_user' && task.awaitingReason === 'checkpoint' ? task.checkpoint : undefined;
}

/**
 * A finished structured task the daemon can continue in its saved session
 * (ADR-0018, K1): the composer continues it rather than messaging a turn.
 * The status is checked too, so a start the daemon has not reported the
 * flag's end for yet is not continued twice.
 */
export function continuesTask(task: TaskView | undefined): boolean {
  return task?.continuable === true && (task.status === 'completed' || task.status === 'failed');
}

/**
 * Finds a task by id anywhere in the tree, subtasks included — `expandedTaskId`
 * names a subtask as often as a top-level task, and a top-level-only lookup
 * would treat every subtask as gone the moment one is expanded.
 */
export function findTask(tasks: TaskView[], id: string): TaskView | undefined {
  for (const task of tasks) {
    if (task.id === id) return task;
    const found = findTask(task.subtasks ?? [], id);
    if (found) return found;
  }
  return undefined;
}

export function initialState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    editor: emptyEditor(),
    conversation: EMPTY_CONVERSATION,
    taskView: null,
    turnGate: NO_TURN,
    detailAll: false,
    status: 'idle',
    busyLabel: '',
    sessionId: null,
    goal: '',
    tasks: [],
    planApproved: false,
    focus: 'chat',
    selectedTask: 0,
    expandedTaskId: null,
    taskEditor: null,
    scroll: 0,
    planScroll: null,
    runners: [],
    sessions: [],
    rewindTargets: null,
    models: [],
    modesByRunner: {},
    taskSkills: [],
    orchestratorModels: [],
    providerErrors: {},
    orchestratorModel: '',
    plannerProvider: '',
    plannerEffort: '',
    maxParallel: DEFAULT_MAX_PARALLEL,
    configuredProviders: [],
    allowlist: {},
    autonomous: true,
    mouseCapture: true,
    selection: null,
    workspace: process.cwd(),
    handoff: null,
    gate: null,
    overlay: null,
    pendingApprovals: [],
    queuedPrompts: EMPTY_HOLD,
    stopArmed: false,
    stopArmToken: 0,
    stopRequested: false,
    toast: '',
    rows: 24,
    cols: 80,
    exiting: false,
    spinnerFrame: 0,
    ...overrides,
  };
}
