import type { ResearchStepOutcome } from '@ordewell/core';
import { emptyEditor, type EditorState } from './editor';

export type MessageRole = 'user' | 'assistant' | 'system' | 'error' | 'research';

/**
 * The identity and fate of one research tool call. Carried on its transcript
 * entry so the matching `research_step_done` settles that exact line — a
 * parallel round has several same-tool calls open at once, and matching by
 * name alone would land the wrong outcome on the wrong line.
 */
export interface ResearchMeta {
  toolCallId?: string;
  /** Absent while the call is still in flight. */
  outcome?: ResearchStepOutcome;
  result?: string;
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  timestamp: string;
  research?: ResearchMeta;
}

export type RunStatus = 'idle' | 'planning' | 'researching' | 'executing';

export interface TaskView {
  id: string;
  order: number;
  title: string;
  description?: string;
  prompt?: string;
  type: 'ai' | 'user';
  status: string;
  dependencies: string[];
  assignedRunner?: string;
  taskMode?: string;
  assignedModel?: {
    modelId: string;
    modelLabel: string;
    thinkingEffort?: string;
    availableVariants?: string[];
  };
}

/** One mode a runner's manifest declares, as the mode picker offers it. */
export interface ModeView {
  id: string;
  label: string;
  description?: string;
  /** Tagged `autonomous: true` on the manifest — runs without permission prompts. */
  autonomous?: boolean;
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

/** The five planner skills the VS Code webview exposes as toggles. */
export const SKILL_IDS = ['grill-me', 'tdd', 'prd', 'verify', 'research-subagents'] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export type Skills = Record<SkillId, boolean>;

export function noSkills(): Skills {
  return { 'grill-me': false, tdd: false, prd: false, verify: false, 'research-subagents': false };
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
  | { kind: 'set-runners' }
  | { kind: 'choose-allowlist-runner' }
  | { kind: 'set-allowlist'; runner: string }
  | { kind: 'set-task-runner'; taskId: string }
  | { kind: 'set-task-model'; taskId: string }
  | { kind: 'set-task-effort'; taskId: string }
  | { kind: 'set-task-mode'; taskId: string }
  | { kind: 'set-task-deps'; taskId: string };

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
  kind: 'external_path' | 'shell_command' | 'url_fetch';
  subject: string;
  scope: string;
  detail?: string;
}

export type Overlay =
  | { kind: 'help'; scroll?: number }
  | { kind: 'approval'; request: ApprovalRequestView }
  | { kind: 'picker'; picker: PickerState }
  | { kind: 'prompt'; title: string; hint?: string; value: string; action: PromptAction }
  | { kind: 'confirm'; title: string; message: string; action: ConfirmAction };

/** A free-text prompt overlay — used where a list of options makes no sense. */
export type PromptAction =
  | { kind: 'api-key'; provider: string; envVar: string }
  | { kind: 'add-task' };

/** A yes/no overlay for destructive actions — enter confirms, escape cancels. */
export type ConfirmAction =
  | { kind: 'new-session' }
  | { kind: 'remove-task'; taskId: string };

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

export interface TuiState {
  editor: EditorState;
  messages: ChatMessage[];
  status: RunStatus;
  /** Short label shown next to the spinner, e.g. the current research step. */
  busyLabel: string;
  /** Tail of the planner's raw reasoning for this turn, shown under the spinner. */
  thinkingLine: string;
  sessionId: string | null;
  goal: string;
  tasks: TaskView[];
  planApproved: boolean;
  focus: Focus;
  /** Index into `tasks` for the plan pane's cursor. */
  selectedTask: number;
  /** The selected task can expand in place to show its complete specification. */
  expandedTaskId: string | null;
  /** Editable draft of the expanded task's prompt; set together with `expandedTaskId`. */
  taskEditor: EditorState | null;
  /** Lines the transcript is scrolled back from its tail; 0 follows live output. */
  scroll: number;
  /**
   * The plan pane's viewport, as an absolute line offset — or `null` for the
   * default, which is to follow the selected task. A delta layered on top of
   * that auto-anchor (what this used to be) could never scroll *above* the
   * anchor, so with a task selected far down the plan the first task was
   * unreachable without dragging the selection through it. The first manual
   * scroll seeds the offset from the anchor so the view does not jump; moving
   * the selection with the arrows hands the pane back to follow mode.
   */
  planScroll: number | null;
  skills: Skills;
  runners: RunnerView[];
  sessions: SessionView[];
  models: ModelView[];
  /** Each runner's manifest modes, keyed by runner id — a task's mode picker reads its own runner's list. */
  modesByRunner: Record<string, ModeView[]>;
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
  configuredProviders: string[];
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
  overlay: Overlay | null;
  /**
   * Approval prompts not yet shown. The planner blocks on each one, so they are
   * answered one at a time rather than stacking modals on top of each other.
   */
  pendingApprovals: ApprovalRequestView[];
  toast: string;
  rows: number;
  cols: number;
  exiting: boolean;
  /** Cycles while a task is running to animate the plan pane's spinner. */
  spinnerFrame: number;
}

/** A task with a runner live behind it. `in_progress` is the store's own status. */
export const isTaskRunning = (task: { status: string }): boolean =>
  task.status === 'in_progress' || task.status === 'running';

/**
 * Whether the plan pane has a spinner to animate. Deliberately not
 * `status === 'executing'`: a single force-started task never puts the whole
 * session into a run, and its icon still has to turn.
 */
export const anyTaskRunning = (state: TuiState): boolean => state.tasks.some(isTaskRunning);

export function initialState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    editor: emptyEditor(),
    messages: [],
    status: 'idle',
    busyLabel: '',
    thinkingLine: '',
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
    skills: noSkills(),
    runners: [],
    sessions: [],
    models: [],
    modesByRunner: {},
    orchestratorModels: [],
    providerErrors: {},
    orchestratorModel: '',
    plannerProvider: '',
    plannerEffort: '',
    configuredProviders: [],
    allowlist: {},
    autonomous: true,
    mouseCapture: true,
    selection: null,
    workspace: process.cwd(),
    overlay: null,
    pendingApprovals: [],
    toast: '',
    rows: 24,
    cols: 80,
    exiting: false,
    spinnerFrame: 0,
    ...overrides,
  };
}
