import { taskPlacement } from '@ordewell/core/plan-utils';
import { DEFAULT_MAX_PARALLEL, EMPTY_CONVERSATION, EMPTY_HOLD, EMPTY_RUN, NO_TURN, RUN_SETTINGS_DEFAULTS, isTaskRunning, logContinues, logResumes, taskRef, taskRefOf, titledTaskRef, titledTaskRefOf, type AccountLimitSnapshot, type GlobalRunSettings, type OverrideDirection, type TaskStatus, type AttemptUsage, type AiProvider, type ApprovalBlock, type AwaitingReason, type ConversationView, type HandoffDigest, type IsolationHandoff, type IsolationLandedTask, type IsolationPreview, type PromptHold, type RunTask, type RunView, type SupervisorLevel, type TaskIsolation, type TaskLogFollow, type TaskType, type TurnGate } from '@ordewell/core';
import { emptyEditor, type EditorState } from './editor';
import type { RunnersResponse } from '../apiClient';
import type { SaveSettingsEffect } from './reducers/settings';
import type { StepperState } from './reducers/stepper';

export type RunStatus = 'idle' | 'starting' | 'executing';

/**
 * This surface's own planner call: a turn, a /compact, or none. Apart from
 * `status` because the two overlap — a prompt sent mid-run, a run autorun
 * starts inside the turn that landed its plan — and neither may end the other.
 * `awaiting` is a call whose reply was lost in transit: the daemon runs a turn
 * to its end whether or not anyone waits, so the turn is neither failed nor
 * over until the daemon says so. `compacting` is a compaction this surface did
 * not ask for — the planner's own, another surface's, or one already running
 * when the session was adopted: it has no call here to settle it, so the
 * compaction's end event does (ADR-0017). `joined` is a turn the daemon was
 * running when the session was adopted: no call here will return its plan, so
 * the turn's own end on the stream settles it.
 */
export type PlannerStatus = 'idle' | 'planning' | 'condensing' | 'compacting' | 'awaiting' | 'joined';

export interface TaskView {
  /** An attempt of it has started: its chat exists from then on. Absent on a task never run. */
  attempted?: boolean;
  attemptUsage?: AttemptUsage[];
  id: string;
  order: number;
  title: string;
  description?: string;
  prompt?: string;
  type: TaskType;
  status: string;
  /** Advisory silence timestamp from VerdictEngine — set while the task's runner has gone quiet. */
  idleSince?: string | null;
  /** What its runner reported through `task_complete`, received while the attempt winds down (ADR-0018, L1). */
  completionReceived?: RunTask['completionReceived'];
  /** Which spawn of its starting runner waits for Ordewell's tools to connect (ADR-0025). */
  attaching?: RunTask['attaching'];
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
  /** When a task paused on a usage limit resumes on its own (ISO time); absent when it waits for a manual retry. */
  resumeAt?: string;
  /** Why a `skipped` task was skipped; absent when no reason was given. */
  skipReason?: string;
  /** The whole question of the checkpoint the task waits at, while it does. */
  checkpoint?: string;
  /** A finished structured task the daemon can continue in its saved session (ADR-0018, K1). */
  continuable?: boolean;
  /** How many of its runner's tool requests wait for an answer (ADR-0018, A1); absent when none do. */
  awaitingApproval?: number;
  /** Added after the user approved the plan, so the scheduler leaves it for them (ADR-0035). */
  waitsForApproval?: boolean;
  /** Why it is held out of the scheduler; absent when it is not held. */
  holdReason?: string;
  /** A loop's check between rounds that nothing will run (ADR-0045 L5). */
  loopStranded?: boolean;
  /** An ops task (ADR-0020): it runs in the user's checkout, never a worktree. */
  ops?: boolean;
  /** A research task (ADR-0037): its report goes to the planner and wakes it. */
  research?: boolean;
  /** What its latest attempt handed over (ADR-0047), as the plan keeps it: summary, digest findings and artifacts. */
  handoff?: HandoffDigest;
  /** A script task's body (ADR-0035): argument vectors run in order, or one script. Kept raw: the pane shows it with unseen characters spelled out. */
  commands?: string[][];
  script?: string;
  /** A script task's time limit; absent where it takes the default. */
  timeoutMs?: number;
  /** Set on a loop's check (ADR-0045): its body, by task id, and how many rounds it may run. */
  loop?: { body: string[]; maxRounds: number };
  /** The round of the check's latest run, past its first. */
  loopRound?: number;
  /** What a check's evidence said, so the pane can tell a check between rounds from one that failed outright (ADR-0045 L2). */
  verdict?: { outcome: string; reported?: string };
  /** Task skills attached by name, put in the runner's prompt at spawn. */
  skills?: string[];
  /** Set on a task an Act supervisor added during a run (ADR-0029). */
  addedBy?: 'supervisor';
  /** The ancestors whose work must be merged into the user's branch before this task can go on (ADR-0020). */
  mergeGate?: string[];
  /** The ancestors, by title, a force start went past the merge gate of. */
  forcedPastGate?: string[];
  /** Child tasks, recursively shaped the same way; absent until populated by `toTaskView`. */
  subtasks?: TaskView[];
}

/**
 * The isolation view a surface shows, in core's own shape (ADR-0013): a mark
 * per task the run touched, and the handoff, read from a live status update or
 * from the saved plan by `isolationViewOfPlan`. The CLI names them for its own
 * callers; none of the values is re-declared here.
 */
export type TaskIsolationView = TaskIsolation;
export type LandedTaskView = IsolationLandedTask;
export type HandoffView = IsolationHandoff;

/**
 * Landed work not yet in the user's branch, including a possible merge gate.
 */
export interface RunMergeView {
  waitingAtGate: boolean;
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
  /** Why this host cannot run the mode (a failed probe); it is listed, never assignable. */
  unavailable?: string;
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

/** The daemon's runner row, as `getRunners` hands it over — auth included, never restated. */
export type RunnerView = RunnersResponse['runners'][number];

/**
 * Only a runner's own signed-out verdict, with a way in, raises an alarm:
 * `unknown` must never read as one, and a verdict without a login command has
 * nowhere to send the user (ADR-0052).
 */
export function signedOutWithLogin(row: RunnerView): boolean {
  return row.auth?.state === 'signed-out' && (row.auth.loginCommand?.length ?? 0) > 0;
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
  /**
   * Needs attention but is still choosable: a signed-out agent can be picked
   * and will ask for its own login before planning. Distinct from `disabled`,
   * which cannot be chosen at all.
   */
  warn?: boolean;
}

/** What the runtime should do with the item(s) the user picks. */
export type PickerAction =
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
  | { kind: 'set-task-skills'; taskId: string }
  /** The escalation inbox: choosing a row opens that escalation's answers (ADR-0053). */
  | { kind: 'inbox' }
  | { kind: 'inbox-answer'; escalationId: string };

export interface PickerState {
  title: string;
  hint?: string;
  items: PickerItem[];
  filter: string;
  index: number;
  /** Multi-select pickers toggle with space and confirm the whole set on enter. */
  multi: boolean;
  chosen: string[];
  /**
   * A long list (models, sessions) narrows as the user types. A short fixed
   * one is numbered instead and a digit picks its row — the two can't share,
   * because model names contain digits.
   */
  filterable: boolean;
  action: PickerAction;
}

/**
 * The rows a picker currently offers. Lives with `PickerState` rather than in
 * the reducer: the renderer needs the same list to paint and to keep the
 * highlight on screen, and importing it from the reducer pointed the render
 * layer back at the layer that drives it.
 */
export function visibleItems(picker: PickerState): PickerItem[] {
  return matchingItems(picker.items, picker.filter);
}

/** `items` narrowed to what `filter` matches — the rule every filterable list shares. */
export function matchingItems(items: PickerItem[], text: string): PickerItem[] {
  const filter = text.trim().toLowerCase();
  if (!filter) return items;
  // `detail` carries the provider name, so typing e.g. "openrouter" narrows to
  // that provider's models alongside id/label matches.
  return items.filter(
    (i) =>
      i.id.toLowerCase().includes(filter) ||
      i.label.toLowerCase().includes(filter) ||
      (i.detail ?? '').toLowerCase().includes(filter),
  );
}

/** A planner approval prompt awaiting a yes/no. Mirrors the daemon's SessionMessage. */
export interface ApprovalRequestView {
  id: string;
  kind: 'external_path' | 'shell_command' | 'url_fetch' | 'web_search' | 'mcp_tool' | 'mcp_server' | 'task_start';
  subject: string;
  scope: string;
  detail?: string;
  /** What a script task runs, verbatim, for a start the user is asked to approve (ADR-0035). */
  body?: string;
}

export type Overlay =
  | { kind: 'help'; scroll?: number; sheet?: 'commands' | 'keys' }
  /** `scroll` is how far into the request's `body` the card is read, when the body does not fit. */
  | { kind: 'approval'; request: ApprovalRequestView; scroll?: number }
  | { kind: 'picker'; picker: PickerState }
  | { kind: 'stepper'; stepper: StepperState }
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
  | { kind: 'add-task' }
  /** The note an escalation's answer takes; `required` refuses an empty one. */
  | { kind: 'escalation-note'; escalationId: string; option: string; required: boolean; confirm?: string };

/** A confirmation overlay for destructive actions — enter confirms, escape cancels, unless it offers a `choice`. */
export type ConfirmAction =
  | { kind: 'new-session' }
  | { kind: 'remove-task'; taskId: string }
  | { kind: 'force-start-gated'; taskId: string }
  /** Mark complete or Mark not done; `seen` is the status the user was asked about, which the daemon holds the task to (ADR-0029). */
  | { kind: 'mark-override'; taskId: string; direction: OverrideDirection; seen: TaskStatus }
  /** `menu` is the `/settings` stepper the question was asked from, reopened once it is answered. */
  | { kind: 'save-settings'; effect: SaveSettingsEffect; menu?: StepperState }
  /** `seen` is the task ids the user was shown, which the daemon holds the revert to (ADR-0054). */
  | { kind: 'revert-task'; taskId: string; seen: string[] }
  | { kind: 'merge-run' }
  | { kind: 'discard-run' }
  | { kind: 'init-workspace'; goal: string; workspace: string }
  | { kind: 'rewind'; index: number }
  /** The yes an escalation option's own question asks for; the answer carries it as `confirmed`. */
  | { kind: 'answer-escalation'; escalationId: string; option: string; note?: string };

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
export interface TaskLogState extends TaskLogFollow {
  taskId: string;
  /**
   * Which pending message ctrl-r and ctrl-s (with the composer empty) act on,
   * as picked with ctrl-n/ctrl-p; null until one is picked, which defaults to
   * the newest (see `queuedTarget`).
   */
  queuedIndex: number | null;
  /**
   * Why the last key was refused, drawn in the view in place of its key hints
   * until the next key that is not a scroll: the planner chat, where other
   * notices go, is not on screen.
   */
  notice?: string;
}

/**
 * The index of the pending message the task view's keys act on: the one
 * picked, or the newest not already being sent now. -1 when there is none.
 */
export function queuedTarget(tv: TaskLogState): number {
  const { queued } = tv.view;
  if (tv.queuedIndex !== null) return Math.min(tv.queuedIndex, queued.length - 1);
  for (let i = queued.length - 1; i >= 0; i--) if (!queued[i].forced) return i;
  return -1;
}

/** A prompt a force send took out of the composer, or out of the queue at `queueIndex`. */
export interface ForcedPrompt {
  text: string;
  queueIndex?: number;
}

export interface TuiState {
  editor: EditorState;
  /**
   * The chat pane's content: core's display blocks (#51), fed every planner
   * `SessionMessage` and every line the TUI adds itself as a `LocalEntry`.
   */
  conversation: ConversationView;
  accountLimits: readonly AccountLimitSnapshot[];
  servedModels: Record<string, { attempt: number; model?: string; assignment?: string }>;
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
  planner: PlannerStatus;
  sessionId: string | null;
  goal: string;
  /**
   * The run as core folds it (ADR-0017): every `SessionMessage` that changes a
   * task, the handoff or a merge goes through `reduceRun`, and `tasks`,
   * `handoff`, `runMerge` and the run settings below are derived from it. A
   * plan refresh therefore keeps every status-only field the stream reported.
   */
  run: RunView;
  /** Derived from `run`; the pane's own shape for a run task. */
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
   * planners. Drives `/planner`, and decides whether its model step offers the
   * cross-provider catalog or that coding agent's own models.
   */
  plannerProvider: string;
  /**
   * Thinking effort for a harness planner — one of the selected model's own
   * variants, or empty for the agent's default. Meaningless for a vendor
   * planner, whose effort is baked into the model id.
   */
  plannerEffort: string;
  /**
   * The model (and effort) last picked for each planner backend, keyed by
   * AiProvider — the settings file's `plannerModels`, so `/planner` can
   * pre-select what switching to a backend would restore.
   */
  plannerModels: Record<string, { model: string; effort?: string }>;
  /** How many AI tasks run at once, as the daemon reports it. */
  maxParallel: number;
  configuredProviders: AiProvider[];
  allowlist: Record<string, string[]>;
  autonomous: boolean;
  /** The user's run settings (ADR-0030), as the daemon last answered them. */
  runSettings: GlobalRunSettings;
  /**
   * Whether `runSettings` came from the user's saved settings rather than the
   * defaults it starts with. The welcome only makes a claim about autorun once
   * this is true: a saved `autorun: true` would otherwise be contradicted by a
   * first frame painted before the daemon answers.
   */
  runSettingsKnown: boolean;
  /** The newest settings answer applied; an older one's workspace values are dropped. */
  settingsRead: number;
  /**
   * The newest answer applied for this session's run values. Apart from
   * `settingsRead` because a write answers with no session's run, and must
   * still outrank an older read without dropping the session's own (ADR-0030).
   */
  runSettingsRead: number;
  /**
   * Whether the daemon has named who plans and listed the installed runners.
   * It answers both only once its probe for coding agents has, so until then
   * the welcome says it is detecting: a first frame of "not set" and "none
   * enabled" read as an install with nothing usable on it.
   */
  plannerKnown: boolean;
  runnersKnown: boolean;
  /** Whether `configuredProviders` came from the catalog; until then a key may be set and not yet reported. */
  providersKnown: boolean;
  /**
   * The repositories and branches the daemon would isolate, with the run
   * settings that decide it: `undefined` before the launch read has been
   * asked for or answered, `null` while a read is in flight, then the answer.
   * Not cleared when a plan exists: the welcome owns it only while no plan
   * has been produced, and only a run's own start check is authoritative.
   */
  isolationPreview: IsolationPreview | null | undefined;
  /** The newest preview read this surface started; an older answer is dropped. */
  isolationPreviewRead: number;
  /** The version check's one-time notice (ADR-0048), on the one start that shows it; empty on every other. */
  versionCheckNotice: string;
  runAutoMerge: boolean | null;
  /** The current run's own level, and why its supervisor stopped if it did; null before any run. */
  runSupervisor: { level: SupervisorLevel; unsupervised?: string } | null;
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
  /** Null once everything landed is merged into the user's branch. */
  runMerge: RunMergeView | null;
  /** A planner turn that hit the planner's usage limit goes again at this time (read off the plan); null when none waits. */
  plannerResend: { runner?: string; at: string } | null;
  /** The planner paused on its context, waiting for `/compact retry` or `/stop` (read off the plan); null when it is not. */
  plannerPause: { model: string } | null;
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
  /**
   * A force send stopped the turn in flight and the forced turn follows. The
   * stopped turn's error is not news either, and the prompts held behind it
   * keep their order rather than draining into the turn already on its way.
   * It holds what the send took, so a send that itself fails can give it back.
   */
  forceSendPending: ForcedPrompt | null;
  toast: string;
  rows: number;
  cols: number;
  exiting: boolean;
  /** Cycles while a task is running to animate the plan pane's spinner. */
  spinnerFrame: number;
  /**
   * The clock of the frame being drawn (epoch ms), which the activity line's
   * elapsed time counts to (#81). The app sets it as it paints, so the reducer
   * and renderer read no clock; 0 until then shows no time.
   */
  now: number;
}

export { isTaskRunning };

/**
 * A planner turn the user can still call off — research rounds included, which
 * are part of planning and carry no status of their own.
 * Every in-flight question and hint is asked through here, so a new status
 * that counts as planning cannot be missed in one place and honoured in
 * another.
 */
export const plannerInFlight = (state: TuiState): boolean =>
  state.planner !== 'idle';

/**
 * The plan pane has something of its own open — a task's prompt editor, or a
 * parent's revealed subtask rows — that Esc backs out of before it means
 * anything else. An overlay on top still owns the key, so this is false then.
 */
export const planPaneOpen = (state: TuiState): boolean =>
  state.focus === 'plan' && !state.overlay && (!!state.taskEditor || !!state.expandedTaskId);

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
 * (ADR-0018, K1), or one paused on a usage limit it can resume there: the
 * composer continues it rather than messaging a turn. The rule is core's, so
 * the header that names the button and the key that runs it cannot disagree.
 */
export function continuesTask(task: TaskView | undefined): boolean {
  return task ? logContinues(task) : false;
}

/** A task paused on a usage limit, whose composer resumes it now with what is typed. */
export function resumesTask(task: TaskView | undefined): boolean {
  return task ? logResumes(task) : false;
}

/**
 * Finds a task by id anywhere in the tree, subtasks included — `expandedTaskId`
 * names a subtask as often as a top-level task, and a top-level-only lookup
 * would treat every subtask as gone the moment one is expanded.
 */
export function findTask(tasks: TaskView[], id: string): TaskView | undefined {
  return taskPlacement(tasks, id)?.task;
}

/**
 * Whether the chat pane is showing a script task's log. A script runs no model,
 * so its log is output only: nothing queues, sends, interrupts or answers there
 * (ADR-0035).
 */
export function scriptTaskView(state: TuiState): boolean {
  return state.taskView ? findTask(state.tasks, state.taskView.taskId)?.type === 'script' : false;
}

/**
 * The reference the plan renders for a task: "#2", or the dotted "#2.1" for a
 * subtask. Looked up against the tree, so a subtask is not named by the order
 * it has under its parent.
 */
export function refFor(state: TuiState, task: TaskView): string {
  return taskRefOf(state.tasks, task.id) ?? taskRef(task);
}

/** The reference and title the plan renders for a task, dotted for a subtask. */
export function titledRefFor(state: TuiState, task: TaskView): string {
  return titledTaskRefOf(state.tasks, task.id) ?? titledTaskRef(task);
}

/** A task list as run-view tasks: every level carries a `subtasks` array, which `reduceRun` walks. */
function asRunTasks(tasks: TaskView[]): RunTask[] {
  return tasks.map((task) => ({ ...task, subtasks: asRunTasks(task.subtasks ?? []) } as unknown as RunTask));
}

/**
 * The run view a caller seeds the pane with: its own when it hands one, else
 * one built from the run-shaped fields it did hand (`tasks`, `handoff`,
 * `runMerge`). Keeping the two in step is what lets a caller that seeds tasks
 * directly still fold later messages through `reduceRun`.
 */
function seedRun(overrides: Partial<TuiState>): RunView {
  if (overrides.run) return overrides.run;
  return {
    ...EMPTY_RUN,
    tasks: asRunTasks(overrides.tasks ?? []),
    handoff: overrides.handoff ?? null,
    runMerge: overrides.runMerge
      ? { waitingAtGate: overrides.runMerge.waitingAtGate, paused: overrides.runMerge.paused, repos: overrides.runMerge.handoff.repos, landed: overrides.runMerge.handoff.landed }
      : null,
  };
}

export function initialState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    editor: emptyEditor(),
    conversation: EMPTY_CONVERSATION,
    accountLimits: [],
    servedModels: {},
    taskView: null,
    turnGate: NO_TURN,
    detailAll: false,
    status: 'idle',
    planner: 'idle',
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
    plannerModels: {},
    maxParallel: DEFAULT_MAX_PARALLEL,
    configuredProviders: [],
    allowlist: {},
    autonomous: false,
    runSettings: { ...RUN_SETTINGS_DEFAULTS },
    runSettingsKnown: false,
    settingsRead: 0,
    runSettingsRead: 0,
    plannerKnown: false,
    runnersKnown: false,
    providersKnown: false,
    isolationPreview: undefined,
    isolationPreviewRead: 0,
    versionCheckNotice: '',
    runAutoMerge: null,
    runSupervisor: null,
    mouseCapture: true,
    selection: null,
    workspace: process.cwd(),
    handoff: null,
    runMerge: null,
    plannerResend: null,
    plannerPause: null,
    overlay: null,
    pendingApprovals: [],
    queuedPrompts: EMPTY_HOLD,
    stopArmed: false,
    stopArmToken: 0,
    stopRequested: false,
    forceSendPending: null,
    toast: '',
    rows: 24,
    cols: 80,
    exiting: false,
    spinnerFrame: 0,
    now: 0,
    ...overrides,
    run: seedRun(overrides),
  };
}
