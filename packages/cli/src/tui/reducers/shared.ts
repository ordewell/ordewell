import type { AccountLimitSnapshot } from '@ordewell/core';
import type { AiProvider, ApprovalDecision, ApprovalRequestMessage, DaemonErrorCode, IsolationPreview, PlanUsage, PlannerUsage, ResearchLogEntry, RunActivity, RunMergeView, RunView, SerializedConversationMessage, SerializedPendingTurn, SerializedTaskStatus, SessionMessage, SettingsResponse, GlobalRunSettings, IsolationMergeResult, StreamStamp, TaskAction, TaskLogEvent, TaskStatus } from '@ordewell/core';
import type { Key } from '../keys';
import type {
  HandoffView, LandedTaskView, ModelView, ModeView, RewindTargetView, RunnerView, SessionView,
  TuiState,
} from '../state';
import { say } from '../transcript';

/** Side effects the runtime performs; the reducer itself stays pure. */
export type Effect =
  /**
   * `allowInit` is only ever set on the retry after the user confirms the "initialize this as a new workspace?" prompt — see `workspaceNeedsInit`.
   * `sessionId` is only ever set on the retry after a revived daemon (`openingRevived`): the session the refused attempt minted, not revived for again.
   */
  | { type: 'startConversation'; goal: string; allowInit?: boolean; sessionId?: string }
  | { type: 'sendMessage'; sessionId: string; message: string }
  /** Read the session back from the daemon after a planner turn's reply was lost, and settle the turn if the daemon is done with it. */
  | { type: 'reconcileTurn'; sessionId: string }
  /** Send now in the planner chat (ADR-0023, F5): stop the turn in flight and answer `message` next. */
  | { type: 'forceSendPlannerMessage'; sessionId: string; message: string }
  | { type: 'setPlanner'; provider: string }
  /** `/planner`'s three answers at once, so the daemon never holds a provider with the old backend's model. `noticeLevel` reddens the confirmation while that agent's own login is missing (ADR-0052). */
  | { type: 'setPlannerChoice'; provider: string; modelId: string; effort: string; notice: string; noticeLevel?: 'error' }
  | { type: 'setApiKey'; provider: string; key: string }
  | { type: 'setAllowlist'; runner: string; modelIds: string[] }
  | { type: 'setRunnerEnabled'; runner: string; enabled: boolean }
  /** Hands the terminal to the login command a runner's manifest declared; `label` names it in the notice. */
  | { type: 'plannerLogin'; command: readonly string[]; label: string }
  /** The runner picker's whole confirmed set, so one visit reports one result. */
  | { type: 'setRunners'; changes: { runner: string; enabled: boolean }[]; message: string }
  | { type: 'setMouseCapture'; enabled: boolean }
  /** A finished selection, already clipped to its pane and stripped of paint. */
  | { type: 'copyText'; text: string }
  | { type: 'loadModels' }
  | { type: 'loadSessions' }
  | { type: 'loadSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'forkConversation'; sessionId: string }
  /** `pick` is `/rewind <n>`: the messages are wanted to quote message n in the confirmation, not to fill the picker. */
  | { type: 'loadRewindTargets'; sessionId: string; pick?: number }
  | { type: 'rewindConversation'; sessionId: string; index: number }
  | { type: 'compactConversation'; sessionId: string }
  | { type: 'cancelPlannerResend'; sessionId: string }
  | { type: 'retryPlannerCompaction'; sessionId: string }
  | { type: 'isolationReviewDiff'; sessionId: string }
  /** `branch` is only for the words the result is reported in; `repaired` likewise (ADR-0015). */
  | { type: 'isolationMerge'; sessionId: string; branch: string; group?: boolean; repaired?: LandedTaskView[] }
  | { type: 'isolationDiscard'; sessionId: string; branch: string }
  | { type: 'isolationCleanup'; sessionId: string; branch: string }
  /** Replays a run a dirty tree parked; `stash` puts tracked changes aside first, `shared` runs in the working tree this once. */
  | { type: 'isolationContinue'; sessionId: string; mode: 'stash' | 'shared' }
  | { type: 'resolveConflict'; sessionId: string; taskId: string }
  | { type: 'saveSession'; sessionId: string }
  | { type: 'closeSession'; sessionId: string }
  | { type: 'execute'; sessionId: string }
  | { type: 'stopExecution'; sessionId: string }
  | { type: 'cancelPlanning'; sessionId: string }
  /** Schedules the stop-arm expiry; the runtime owns the timer, not the reducer. */
  | { type: 'disarmStop'; afterMs: number; arm: number }
  /** `watch` asks the runtime to hold the execution stream open for this action — see `taskActionEffect`. */
  /** `confirmed`: the user's yes to an override, with the status they were asked about (ADR-0029). */
  | { type: 'taskAction'; sessionId: string; taskId: string; action: TaskAction; watch?: boolean; confirmed?: { seen: TaskStatus } }
  | { type: 'addTask'; sessionId: string; title: string }
  /** `/settings`: only the changed values, saved the way their headless commands save them, then `message` as one notice. */
  | { type: 'saveSettings'; run: Partial<GlobalRunSettings>; autonomous?: boolean; maxParallel?: number; message: string; sessionId?: string }
  | { type: 'updateTask'; sessionId: string; taskId: string; changes: Record<string, unknown>; message: string }
  | { type: 'removeTask'; sessionId: string; taskId: string }
  /** Reads a structured task's saved log (ADR-0018, P1) so its view opens with its history. */
  | { type: 'openTaskLog'; sessionId: string; taskId: string }
  /** Reads one saved attempt, for switching to an earlier one. */
  | { type: 'loadTaskAttempt'; sessionId: string; taskId: string; attempt: number }
  /** A user message to a structured task. */
  | { type: 'sendTaskMessage'; sessionId: string; taskId: string; text: string }
  /** The task runner's own command (#66), never one of Ordewell's. */
  | { type: 'invokeTaskCommand'; sessionId: string; taskId: string; name: string; args: string }
  /** Takes back one queued message before it is delivered. */
  | { type: 'removeTaskMessage'; sessionId: string; taskId: string; messageId: string }
  | { type: 'interruptTask'; sessionId: string; taskId: string }
  /** Force send (ADR-0023, F1): interrupt the running turn and deliver `text` next. */
  | { type: 'forceSendTaskMessage'; sessionId: string; taskId: string; text: string }
  /** Force send one queued message, by id. */
  | { type: 'forceSendQueuedTaskMessage'; sessionId: string; taskId: string; messageId: string }
  /** Continue a finished structured task in its saved session, with `text` as its next turn (ADR-0018, K1). */
  | { type: 'continueTask'; sessionId: string; taskId: string; text: string; watch?: boolean }
  | { type: 'respondApproval'; sessionId: string; approvalId: string; granted: boolean }
  /** A task runner's tool request, answered from its task view (ADR-0018, A1). */
  | { type: 'answerTaskApproval'; sessionId: string; approvalId: string; answer: ApprovalDecision }
  /** The checkpoint a task waits at, answered; only a rejection carries a reason. */
  | { type: 'answerTaskCheckpoint'; sessionId: string; taskId: string; answer: 'approve' | 'reject'; reason?: string }
  /** Startup refreshes silently; only a typed `/refresh` sets `announce`. */
  | { type: 'refresh'; announce?: boolean; sessionId?: string }
  /** The runners alone, as the daemon has them saved. */
  | { type: 'loadRunners' }
  /** The enabled runners and the allowlist, as they are saved now: what flags a task and ticks a picker. */
  | { type: 'loadScope'; sessionId?: string }
  /** A read-only look at this workspace's repositories, branches and isolation, for the welcome. */
  | { type: 'loadIsolationPreview' }
  | { type: 'exit' };

export type ChatRestored = { type: 'chatRestored'; history: SerializedConversationMessage[]; researchLog?: ResearchLogEntry[]; plannerUsage?: PlannerUsage; pendingTurns?: SerializedPendingTurn[]; sessionId?: string };

export type { TaskAction };

export type Action =
  | { type: 'key'; key: Key }
  | { type: 'sessionStarted'; sessionId: string; goal: string }
  /**
   * Names the session let go when it is known, so a late clear cannot take the
   * one loaded since. `unreached` is an opening refused before any server saw
   * it: it never held run settings of its own, so the welcome's still stand.
   */
  | { type: 'sessionCleared'; sessionId?: string; unreached?: true }
  | { type: 'sessionDeleted'; sessionId: string }
  /** A saved session's records, which the conversation is rebuilt from as a reload would show it. */
  | ChatRestored
  /**
   * A planner turn's call died after the request went out (a timeout, a reset):
   * the daemon may still be running the turn or have finished it, so it is
   * neither a failure nor an end.
   */
  | { type: 'turnLost'; sessionId: string; /** Why the request failed, short and without the request: shown beside the warning. */ reason?: string }
  /**
   * The session as the daemon holds it after a lost reply, with the conversation
   * to redraw from it. `plannerTurnId` is the turn the daemon is running now, if
   * one is: the gate's turn is over only when the daemon names a different one
   * or none at all. `plannerCompaction` is the compaction it is running, which
   * has no turn: the planner is busy with it, not lost.
   */
  | { type: 'turnReconciled'; plan: unknown; plannerTurnId?: string; plannerCompaction?: Extract<SessionMessage, { type: 'planner_compaction' }>; chat: ChatRestored; sessionId: string; reason?: string }
  /** A session was adopted while the daemon runs planner turn `turnId`, which no call here will settle. */
  | { type: 'turnJoined'; turnId: string; sessionId: string }
  /** A planner turn's call returned its plan: the one action that ends the turn. */
  | { type: 'planUpdated'; plan: unknown; sessionId?: string }
  /**
   * `/compact` answered with the plan it left. The conversation is not redrawn:
   * the transcript's new entries fold into the view that is on screen, so a
   * summary whose frames were lost still lands, then the turn ends as any does.
   */
  | { type: 'compacted'; plan: unknown; sessionId: string }
  /** The plan as the daemon holds it after a request that is not a planner turn; a turn out stays out. */
  | { type: 'planRefreshed'; plan: unknown; sessionId: string }
  /** A saved session is now the one on screen; nothing of the last session's turn carries over. */
  | { type: 'sessionLoaded'; sessionId: string; goal: string }
  /** A plan the daemon broadcast, not one a call of this surface returned. */
  | { type: 'planBroadcast'; plan: unknown; sessionId: string }
  /** One planner message from the session, as it came: core's conversation view decides what it shows. */
  | { type: 'sessionMessage'; message: SessionMessage; sessionId?: string }
  /** The next events of a structured task's attempt, live (ADR-0018, P1). */
  | { type: 'accountLimits'; limits: readonly AccountLimitSnapshot[]; sessionId: string }
  | { type: 'taskLog'; position?: StreamStamp; taskId: string; attempt: number; events: TaskLogEvent[]; sessionId?: string }
  /** A structured task's saved log, read when its view opens or an attempt is switched to. `attempts` is omitted when a switch already knows the list. */
  | { type: 'taskLogLoaded'; position?: StreamStamp; taskId: string; attempts?: number[]; attempt: number; events: TaskLogEvent[]; sessionId?: string }
  /** Open a task's saved log in the chat pane. */
  | { type: 'taskViewRequested'; taskId: string; sessionId: string }
  | { type: 'taskStarted'; taskId: string; order?: number; title: string; runner?: string; sessionId?: string }
  /** A task asked a checkpoint question; the chat pane says so, and where to answer. */
  | { type: 'taskUpdated'; taskId: string; changes: Record<string, unknown>; sessionId?: string }
  | { type: 'taskCheckpoint'; taskId: string; title: string; summary: string; sessionId?: string }
  /** The run's status stream: folded through core's `reduceRun`, status-only fields and all. */
  | { type: 'statusUpdate'; tasks: SerializedTaskStatus[]; runMerge?: RunMergeView; usage?: PlanUsage; activity?: RunActivity; sessionId?: string }
  /** The run as the daemon sends it when a socket connects, before the next update. */
  | { type: 'runSnapshot'; view: RunView; approvals?: ApprovalRequestMessage[]; sessionId?: string }
  /** The edit the open planner turn holds, as it would leave the plan; null once it landed or was dropped. */
  | { type: 'isolationBlocked'; message: string; repos?: string[]; sessionId?: string }
  | { type: 'isolationHandoff'; handoff: HandoffView; sessionId?: string }
  | { type: 'handoffDiff'; diff: string; sessionId?: string }
  /** The run and its record are gone; nothing is left to hand off or to mark. */
  | { type: 'isolationMerged'; result: IsolationMergeResult; sessionId?: string }
  | { type: 'runClosed'; sessionId?: string }
  /** The scheduled expiry of an armed stop; the arm simply lapses. */
  | { type: 'stopDisarmed'; arm: number }
  | { type: 'executionComplete'; summary?: { total: number; completed: number; failed: number; blocked?: number; skipped?: number }; stopped?: boolean; sessionId?: string }
  /** The execution socket dropped before the run reported an end; whatever the pane shows as running no longer has a feed. */
  | { type: 'executionLost'; sessionId?: string }
  /** The session's standing subscription went with the daemon (see `follow` in effects). */
  | { type: 'followLost'; sessionId: string }
  /** A standing subscription opened; on a reconnect this is what reads a lost turn's end back. */
  | { type: 'followRestored'; sessionId: string }
  /** `read` and `sessionId` say which read this answers, so a late one cannot paint another session's values (ADR-0030). */
  | { type: 'settingsLoaded'; settings: Partial<SettingsResponse>; read?: number; sessionId?: string }
  | { type: 'modelsLoaded'; models: ModelView[]; orchestratorModels?: ModelView[]; providers?: AiProvider[]; providerErrors?: Record<string, string>; modesByRunner?: Record<string, ModeView[]> }
  | { type: 'sessionsLoaded'; sessions: SessionView[] }
  | { type: 'sessionForked'; sessionId: string; goal: string }
  | { type: 'inputPrefilled'; text: string; sessionId?: string }
  | { type: 'rewindTargetsLoaded'; targets: RewindTargetView[]; sessionId?: string; pick?: number }
  | { type: 'runnersLoaded'; runners: RunnerView[]; orchestratorModel?: string }
  /** The welcome's repositories and branches: `read` is the request this answers, so an older one cannot land on a newer. */
  | { type: 'isolationPreviewLoading'; read: number }
  | { type: 'isolationPreviewLoaded'; preview: IsolationPreview; read: number }
  | { type: 'isolationPreviewFailed'; message: string; read: number }
  /** The daemon answered again after a revive: what it serves for this workspace may have changed with it. */
  | { type: 'daemonReconnected' }
  /** Another surface saved the settings file the runners and the allowlist live in. */
  | { type: 'sharedSettingsChanged' }
  /**
   * `code` is the daemon's stable reason for a refusal, when it gave one.
   * `turn` marks a failure of the planner turn's own call, the only kind that
   * ends the turn; anything else failing mid-turn leaves it running. A turn's
   * failure names the session it was for, as every other turn result does, and
   * so does an approval answer's: once that session is off screen it is dropped.
   */
  | { type: 'failed'; message: string; code?: DaemonErrorCode; turn?: true; sessionId?: string }
  /** The workspace has no project marker — offer to initialize it rather than just failing. */
  | { type: 'workspaceNeedsInit'; goal: string; workspace: string; sessionId: string }
  /** The daemon refused an opening and has been revived: the reducer decides whether the opening is still the one on screen to retry. */
  | { type: 'openingRevived'; sessionId: string; goal: string; allowInit?: boolean }
  /**
   * `holdPlace` is for a notice that reports on text already on screen rather
   * than moving the conversation on: it must not take a scrolled-back reader
   * to the tail. The copy count is the one such notice.
   */
  /** `sessionId` names the session a notice is about, so one the user has left is not shown on another. */
  | { type: 'notice'; message: string; level?: 'info' | 'warn' | 'error'; holdPlace?: boolean; sessionId?: string }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'spinnerTick' };

export interface Step {
  state: TuiState;
  effects: Effect[];
}

export function step(state: TuiState, effects: Effect[] = []): Step {
  return { state, effects };
}

export const fail = (state: TuiState, message: string): Step => step(reportError(state, message));

/**
 * A local error, where the user can see it. The chat pane draws a task's own
 * log while one is open, so the planner transcript would swallow it: the view's
 * notice row is the one place that is on screen.
 */
export function reportError(state: TuiState, message: string): TuiState {
  return state.taskView
    ? { ...state, taskView: { ...state.taskView, notice: message } }
    : say(state, 'error', message);
}

/**
 * A notice answers the key that was refused. Any next key that is not just
 * scrolling dismisses it, so the view's own key hints come back — a script
 * view has no composer whose next send would clear it.
 */
export function clearNotice(state: TuiState): TuiState {
  return state.taskView?.notice
    ? { ...state, taskView: { ...state.taskView, notice: undefined } }
    : state;
}

/**
 * A planner/execution result carries the session id it was produced for. A
 * turn from a session that `/new` has since replaced must not touch the
 * fresh state, even though its promise/socket callback fires afterwards.
 */
export const stale = (state: TuiState, sessionId: string | undefined): boolean =>
  sessionId !== undefined && sessionId !== state.sessionId;

/** Keeps a value inside `0..max`, where every offset this package clamps shares its zero. */
export function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

/** Keeps the cursor on a real row; an empty list has row 0 as its only resting place. */
export function clampSelection(index: number, rows: number): number {
  return Math.max(0, Math.min(index, rows - 1));
}

/** Commands that only make sense once a plan exists. */
export function withSession(state: TuiState, run: (sessionId: string) => Step): Step {
  if (!state.sessionId) {
    return fail(state, 'No active plan: describe a goal first, or load a session with /sessions.');
  }
  return run(state.sessionId);
}

/** A list filter and the prompt field are single-line fields with no cursor. */
export function editText(value: string, key: Key): string {
  if (key.name === 'char') return value + (key.char ?? '');
  // Single-line fields flatten a paste's newlines; a copied API key often
  // drags a trailing newline along, and it must not act as enter here either.
  if (key.name === 'paste') return value + (key.text ?? '').replace(/\n/g, ' ');
  if (key.name === 'backspace') return value.slice(0, -1);
  if (key.name === 'ctrl-u') return '';
  return value;
}

/** The row a digit key names on a numbered list (numbered from 1 on screen), or null for any other key. */
export function digitRow(key: Key): number | null {
  return key.name === 'char' && key.char !== undefined && /^[1-9]$/.test(key.char) ? Number(key.char) - 1 : null;
}
