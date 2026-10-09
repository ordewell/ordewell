import type { AiProvider, ApprovalDecision, AwaitingReason, PlannerUsage, ResearchLogEntry, SerializedConversationMessage, SessionMessage, SettingsResponse, TaskLogEvent } from '@ordewell/core';
import type { Key } from '../keys';
import type {
  GateView, HandoffView, LandedTaskView, ModelView, ModeView, RewindTargetView, RunnerView, SessionView,
  TaskIsolationView, TuiState,
} from '../state';
import { say } from '../transcript';

/** One task's entry in a daemon `status_update`, as the TUI keeps it. */
export interface TaskStatusUpdate {
  status: string;
  idleSince?: string | null;
  isolation?: TaskIsolationView;
  awaitingReason?: AwaitingReason;
  checkpoint?: string;
  continuable?: boolean;
  awaitingApproval?: number;
  mergeGate?: string[];
  forcedPastGate?: string[];
}

/** Side effects the runtime performs; the reducer itself stays pure. */
export type Effect =
  /** `allowInit` is only ever set on the retry after the user confirms the "initialize this as a new workspace?" prompt — see `workspaceNeedsInit`. */
  | { type: 'startConversation'; goal: string; allowInit?: boolean }
  | { type: 'sendMessage'; sessionId: string; message: string }
  | { type: 'setModel'; modelId: string }
  | { type: 'setPlanner'; provider: string }
  | { type: 'setPlannerEffort'; effort: string }
  | { type: 'setApiKey'; provider: string; key: string }
  | { type: 'setAllowlist'; runner: string; modelIds: string[] }
  | { type: 'setRunnerEnabled'; runner: string; enabled: boolean }
  /** The runner picker's whole confirmed set, so one visit reports one result. */
  | { type: 'setRunners'; changes: { runner: string; enabled: boolean }[]; message: string }
  | { type: 'setAutonomous'; enabled: boolean }
  | { type: 'setMaxParallel'; limit: number }
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
  | { type: 'isolationReviewDiff'; sessionId: string }
  /** `branch` is only for the words the result is reported in; `repaired` likewise (ADR-0015). */
  /** `midRun`: merged at a merge gate (ADR-0020), so the run and its record stay. */
  | { type: 'isolationMerge'; sessionId: string; branch: string; group?: boolean; repaired?: LandedTaskView[]; midRun?: boolean }
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
  | { type: 'taskAction'; sessionId: string; taskId: string; action: TaskAction; watch?: boolean }
  | { type: 'addTask'; sessionId: string; title: string }
  | { type: 'updateTask'; sessionId: string; taskId: string; changes: Record<string, unknown>; message: string }
  | { type: 'removeTask'; sessionId: string; taskId: string }
  /** Reads a structured task's saved log (ADR-0018, P1) so its view opens with its history. */
  | { type: 'openTaskLog'; sessionId: string; taskId: string }
  /** Reads one saved attempt, for switching to an earlier one. */
  | { type: 'loadTaskAttempt'; sessionId: string; taskId: string; attempt: number }
  /** A user message to a structured task. */
  | { type: 'sendTaskMessage'; sessionId: string; taskId: string; text: string }
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
  | { type: 'refresh'; announce?: boolean }
  | { type: 'exit' };

export type TaskAction = 'complete' | 'uncomplete' | 'skip' | 'retry' | 'cancel' | 'force-start';

export type Action =
  | { type: 'key'; key: Key }
  | { type: 'sessionStarted'; sessionId: string; goal: string }
  | { type: 'sessionCleared' }
  /** A saved session's records, which the conversation is rebuilt from as a reload would show it. */
  | { type: 'chatRestored'; history: SerializedConversationMessage[]; researchLog?: ResearchLogEntry[]; plannerUsage?: PlannerUsage; sessionId?: string }
  | { type: 'planUpdated'; plan: unknown; sessionId?: string }
  /** One planner message from the session, as it came: core's conversation view decides what it shows. */
  | { type: 'sessionMessage'; message: SessionMessage; sessionId?: string }
  /** The next events of a structured task's attempt, live (ADR-0018, P1). */
  | { type: 'taskLog'; taskId: string; attempt: number; events: TaskLogEvent[]; sessionId?: string }
  /** A structured task's saved log, read when its view opens or an attempt is switched to. `attempts` is omitted when a switch already knows the list. */
  | { type: 'taskLogLoaded'; taskId: string; attempts?: number[]; attempt: number; events: TaskLogEvent[]; sessionId?: string }
  /** Open a task's saved log in the chat pane. */
  | { type: 'taskViewRequested'; taskId: string; sessionId: string }
  | { type: 'taskStarted'; taskId: string; title: string; runner?: string; sessionId?: string }
  /** A task asked a checkpoint question; the chat pane says so, and where to answer. */
  | { type: 'taskCheckpoint'; taskId: string; title: string; summary: string; sessionId?: string }
  | { type: 'taskStatus'; taskId: string; status: string; sessionId?: string }
  | { type: 'tasksStatus'; updates: Record<string, TaskStatusUpdate>; gate?: GateView | null; sessionId?: string }
  | { type: 'isolationBlocked'; message: string; repos?: string[]; sessionId?: string }
  | { type: 'isolationHandoff'; handoff: HandoffView; sessionId?: string }
  | { type: 'handoffDiff'; diff: string; sessionId?: string }
  /** The run and its record are gone; nothing is left to hand off or to mark. */
  | { type: 'runCleared'; sessionId?: string }
  /** The scheduled expiry of an armed stop; the arm simply lapses. */
  | { type: 'stopDisarmed'; arm: number }
  | { type: 'executionComplete'; summary?: { total: number; completed: number; failed: number }; stopped?: boolean; sessionId?: string }
  /** The execution socket dropped before the run reported an end; whatever the pane shows as running no longer has a feed. */
  | { type: 'executionLost'; sessionId?: string }
  | { type: 'settingsLoaded'; settings: Partial<SettingsResponse> }
  | { type: 'modelsLoaded'; models: ModelView[]; orchestratorModels?: ModelView[]; providers?: AiProvider[]; providerErrors?: Record<string, string>; modesByRunner?: Record<string, ModeView[]> }
  | { type: 'sessionsLoaded'; sessions: SessionView[] }
  | { type: 'sessionForked'; sessionId: string; goal: string }
  | { type: 'inputPrefilled'; text: string; sessionId?: string }
  | { type: 'rewindTargetsLoaded'; targets: RewindTargetView[]; sessionId?: string; pick?: number }
  | { type: 'runnersLoaded'; runners: RunnerView[]; orchestratorModel?: string }
  | { type: 'failed'; message: string }
  /** The workspace has no project marker — offer to initialize it rather than just failing. */
  | { type: 'workspaceNeedsInit'; goal: string; workspace: string }
  | { type: 'notice'; message: string; level?: 'info' | 'warn' | 'error' }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'spinnerTick' };

export interface Step {
  state: TuiState;
  effects: Effect[];
}

export function step(state: TuiState, effects: Effect[] = []): Step {
  return { state, effects };
}

export const fail = (state: TuiState, message: string): Step => step(say(state, 'error', message));

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
    return fail(state, 'No active plan — describe a goal first, or load a session with /sessions.');
  }
  return run(state.sessionId);
}
