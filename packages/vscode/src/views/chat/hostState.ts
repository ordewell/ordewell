import { type LegacyPlanState, type DiscoveredModel, type RunnerId, type IsolationHandoff, type IsolationMergeResult, type MergeGateView, type TaskIsolation, type AiProvider } from '@ordewell/core';
import { DEFAULT_RUNNERS, EMPTY_HOLD, type PromptHold } from '@ordewell/core/plan-utils';
import type { HostToWebview, PendingPlanEdit, PlannerBackend, RunnerMeta } from '../../shared/protocol';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, type PatchedView } from '../../shared/conversationPatch';
import { appendTaskOutput, type TaskOutputMap } from './taskOutput';
import { isPlanRevision, nextDock } from './planDock';
import type { RunnerMode } from './components/TaskCard';

export interface RunnerInfo {
  id: string;
  displayName: string;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  apiProvider?: AiProvider;
  description?: string;
  pricing?: string;
}

/** Everything the host feeds the webview, plus the two gates that decide which of its messages to drop. */
export interface HostState {
  /** The planner conversation, held by the host and patched in here (#53). */
  conversation: PatchedView;
  plan: LegacyPlanState | null;
  isExecuting: boolean;
  isResearchActive: boolean;
  conversationBusy: boolean;
  error: string;
  models: DiscoveredModel[];
  modelsByRunner: Partial<Record<string, DiscoveredModel[]>>;
  runnerList: RunnerInfo[];
  enabledRunnerIds: string[];
  runners: RunnerId[];
  pendingEdits: PendingPlanEdit[];
  /** Queued prompts: what the host is holding for the next planner turn. */
  held: PromptHold;
  /** The last queued text the host gave back; `seq` makes a repeat of the same words land again. */
  unsent: { text: string; seq: number } | null;
  modesByRunner: Record<string, RunnerMode[]>;
  modelConfig: { orchestrator: string; orchestratorProvider?: string } | null;
  modelOptions: ModelOption[];
  configuredProviders: AiProvider[];
  /** Who plans (ADR-0009): the backends offered, the one in use, and its runner + effort. */
  planner: { backends: PlannerBackend[]; provider: string; runner?: string; effort?: string };
  isReady: boolean;
  modelDiscoveryErrors: Record<string, string>;
  skills: { name: string; description: string; appliesTo?: 'planner' | 'task' }[];
  taskSkills: { name: string; description: string }[];
  checkpoint: { taskId: string; taskTitle: string; summary: string; pausedAt: number } | null;
  taskOutput: TaskOutputMap;
  /** Advisory silence timestamp per task id; null/absent means not stalled. */
  taskIdle: Record<string, string | null>;
  taskApprovals: Record<string, number>;
  /** Per-task isolation state (ADR-0013); only tasks an isolated run has touched appear. */
  taskIsolation: Record<string, TaskIsolation>;
  /** The end-of-run handoff card, present until the run is merged, discarded or restarted. */
  handoff: IsolationHandoff | null;
  mergeResult: IsolationMergeResult | null;
  /** While tasks wait at a merge gate (ADR-0020): what Merge all would merge now. */
  mergeGate: MergeGateView | null;
  /** Per task id, the dependencies it waits on at its merge gate. */
  taskGates: Record<string, string[]>;
  /** Is the plan dock open? See planDock.ts for when this flips. */
  dockExpanded: boolean;
  /** The dock's dragged cap in px, remembered by the host; undefined keeps the stylesheet's default. */
  dockHeight: number | undefined;
  /** The user stopped the turn: plan updates are dropped until the host closes it. */
  stopped: boolean;
  /** The user started a new session: errors from the old one's turn are dropped. */
  sessionCleared: boolean;
}

export const INITIAL_HOST_STATE: HostState = {
  conversation: EMPTY_PATCHED_VIEW,
  plan: null,
  isExecuting: false,
  isResearchActive: false,
  conversationBusy: false,
  error: '',
  models: [],
  modelsByRunner: {},
  runnerList: [],
  enabledRunnerIds: [...DEFAULT_RUNNERS],
  runners: [...DEFAULT_RUNNERS],
  pendingEdits: [],
  held: EMPTY_HOLD,
  unsent: null,
  modesByRunner: {},
  modelConfig: null,
  modelOptions: [],
  configuredProviders: [],
  planner: { backends: [], provider: '' },
  isReady: false,
  modelDiscoveryErrors: {},
  skills: [],
  taskSkills: [],
  checkpoint: null,
  taskOutput: {},
  taskIdle: {},
  taskApprovals: {},
  taskIsolation: {},
  handoff: null,
  mergeResult: null,
  mergeGate: null,
  taskGates: {},
  dockExpanded: false,
  dockHeight: undefined,
  stopped: false,
  sessionCleared: false,
};

export type SessionResetKind = 'empty' | 'restore' | 'new';

type Updatable<T> = T | ((prev: T) => T);

/** A host message, stamped with the clock so the reducer stays pure. */
export type HostMessage = HostToWebview & { now: number };

export type HostAction =
  | HostMessage
  | { type: 'resetSession'; kind: SessionResetKind }
  | { type: 'turnStopped' }
  | { type: 'turnRequested' }
  | { type: 'patchPlan'; plan: Updatable<LegacyPlanState | null> }
  | { type: 'patchResearchActive'; active: boolean }
  | { type: 'patchExecuting'; executing: boolean }
  | { type: 'patchError'; error: string }
  | { type: 'patchReady'; ready: boolean }
  | { type: 'patchRunners'; runners: Updatable<RunnerId[]> }
  | { type: 'patchPendingEdits'; edits: Updatable<PendingPlanEdit[]> }
  | { type: 'patchCheckpoint'; checkpoint: HostState['checkpoint'] }
  | { type: 'patchDockHeight'; height: number | undefined }
  | { type: 'patchDockExpanded'; expanded: Updatable<boolean> };

/**
 * Clears what belongs to the previous session. Fields per kind:
 * - all kinds: error, plan, checkpoint, task output/idle/approvals, isolation
 *   state, pending edits, and the dock (the stalled/approval badges are keyed
 *   by task id, so they must not outlive the plan they described).
 * - 'restore' and 'new' also: stop the running/planning flags and drop queued
 *   prompts. 'empty' leaves them: the host's own `state` says what runs next,
 *   and queued prompts survive an emptied plan.
 * - 'restore' re-opens the gates (a restore always leaves the chat usable);
 *   'new' closes both, so the old session's late plan updates and errors
 *   are dropped until the user's next send or a planner turn.
 * The conversation is never cleared here: the host owns it and resets it.
 */
export function resetSession(state: HostState, kind: SessionResetKind): HostState {
  const next: HostState = {
    ...state,
    error: '',
    plan: null,
    checkpoint: null,
    taskOutput: {},
    taskIdle: {},
    taskApprovals: {},
    taskIsolation: {},
    handoff: null,
    mergeResult: null,
    mergeGate: null,
    taskGates: {},
    pendingEdits: [],
    dockExpanded: nextDock(state.dockExpanded, 'session-reset'),
  };
  if (kind === 'empty') return next;
  next.isResearchActive = false;
  next.isExecuting = false;
  next.held = EMPTY_HOLD;
  next.stopped = kind === 'new';
  next.sessionCleared = kind === 'new';
  return next;
}

function resolve<T>(value: Updatable<T>, prev: T): T {
  return typeof value === 'function' ? (value as (p: T) => T)(prev) : value;
}

export function reduceHost(state: HostState, action: HostAction): HostState {
  switch (action.type) {
    case 'resetSession':
      return resetSession(state, action.kind);

    case 'turnStopped':
      return { ...state, stopped: true, isResearchActive: false };

    case 'turnRequested':
      return { ...state, stopped: false, sessionCleared: false, error: '', isResearchActive: true };

    case 'patchPlan':
      return { ...state, plan: resolve(action.plan, state.plan) };

    case 'patchResearchActive':
      return { ...state, isResearchActive: action.active };

    case 'patchExecuting':
      return { ...state, isExecuting: action.executing };

    case 'patchError':
      return { ...state, error: action.error };

    case 'patchReady':
      return { ...state, isReady: action.ready };

    case 'patchRunners':
      return { ...state, runners: resolve(action.runners, state.runners) };

    case 'patchPendingEdits':
      return { ...state, pendingEdits: resolve(action.edits, state.pendingEdits) };

    case 'patchCheckpoint':
      return { ...state, checkpoint: action.checkpoint };

    case 'patchDockHeight':
      return { ...state, dockHeight: action.height };

    case 'patchDockExpanded':
      return { ...state, dockExpanded: resolve(action.expanded, state.dockExpanded) };

    case 'setState': {
      const base = action.state === 'empty' ? resetSession(state, 'empty') : state;
      return { ...base, isResearchActive: action.state === 'researching', isExecuting: action.state === 'approved' };
    }

    case 'planUpdated': {
      if (state.stopped) return state;
      const incoming: LegacyPlanState | null = action.plan ?? null;
      let next: HostState = { ...state, plan: incoming };
      // Not a turn's end: a run's status tick arrives mid-turn too, and the
      // host's `plannerTurn` is what says a turn is over.
      if (incoming) next.isExecuting = incoming.status === 'running';
      if (incoming && incoming.tasks && incoming.tasks.length > 0) {
        // One `planUpdated` carries two different events. A revision opens
        // the dock; a status tick during execution must not, or a running
        // plan would fight a user who collapsed it.
        const previous = state.plan?.tasks ?? [];
        next = {
          ...next,
          dockExpanded: nextDock(state.dockExpanded, isPlanRevision(previous, incoming.tasks) ? 'plan-revised' : 'plan-progressed'),
        };
      }
      return next;
    }

    case 'restoreChat':
      return resetSession(state, 'restore');

    case 'conversationPatch':
      return { ...state, conversation: applyConversationPatch(state.conversation, action) };

    // The stop gate lasts until the host has closed the stopped turn; a new
    // turn is never gated.
    case 'plannerTurn':
      return { ...state, stopped: false, isResearchActive: action.active };

    case 'conversationBusy':
      return { ...state, conversationBusy: !!action.busy };

    case 'showError':
      if (state.sessionCleared) return state;
      return { ...state, error: action.error, isResearchActive: false };

    case 'taskOutput':
      return { ...state, taskOutput: appendTaskOutput(state.taskOutput, action.taskId, action.text ?? '') };

    case 'taskIdle':
      return { ...state, taskIdle: { ...state.taskIdle, [action.taskId]: action.idleSince } };

    case 'taskApprovals':
      if ((state.taskApprovals[action.taskId] ?? 0) === action.count) return state;
      return { ...state, taskApprovals: { ...state.taskApprovals, [action.taskId]: action.count } };

    case 'taskIsolation':
      return { ...state, taskIsolation: { ...state.taskIsolation, [action.taskId]: action.isolation } };

    case 'isolationHandoff':
      return { ...state, handoff: { repos: action.repos ?? [], landed: action.landed ?? [] } };

    case 'isolationMergeResult':
      return { ...state, mergeResult: action.result ?? null };

    case 'isolationCleared':
      return { ...state, taskIsolation: {}, handoff: null, mergeResult: null, mergeGate: null, taskGates: {} };

    case 'mergeGate':
      return { ...state, mergeGate: action.gate ?? null, taskGates: action.tasks ?? {} };

    case 'setModels':
      return { ...state, models: action.models ?? [] };

    case 'setModelsByRunner':
      return { ...state, modelsByRunner: action.modelsByRunner ?? {} };

    case 'setModesByRunner':
      return { ...state, modesByRunner: action.modesByRunner ?? {} };

    case 'setModelConfig':
      return { ...state, modelConfig: action.modelConfig ?? null };

    case 'setModelOptions':
      return { ...state, modelOptions: action.modelOptions ?? [] };

    case 'setConfiguredProviders':
      return { ...state, configuredProviders: action.providers ?? [], isReady: true };

    case 'setPlannerBackends':
      return {
        ...state,
        planner: {
          backends: action.backends ?? [],
          provider: action.provider ?? '',
          runner: action.runner,
          effort: action.effort || undefined,
        },
      };

    case 'setModelDiscoveryErrors':
      return { ...state, modelDiscoveryErrors: action.errors ?? {} };

    case 'setRunners': {
      const list = action.runners ?? [];
      const ids = list.filter((r: RunnerMeta) => r.enabled).map((r: RunnerMeta) => r.id);
      let runners: RunnerId[];
      if (ids.length === 1) runners = ids;
      else if (ids.length === 0) runners = [...DEFAULT_RUNNERS];
      else {
        const valid = state.runners.filter((r) => ids.includes(r));
        runners = valid.length > 0 ? valid : ids;
      }
      return {
        ...state,
        runnerList: list.map((r: RunnerMeta) => ({ id: r.id, displayName: r.displayName })),
        enabledRunnerIds: ids,
        runners,
      };
    }

    case 'pendingPlanEdits':
      return { ...state, pendingEdits: action.edits ?? [] };

    case 'heldPrompts':
      return { ...state, held: action.prompts };

    case 'promptUnsent':
      return { ...state, unsent: { text: action.text, seq: (state.unsent?.seq ?? 0) + 1 } };

    case 'setTaskSkills':
      return { ...state, taskSkills: action.skills ?? [] };

    case 'setSkills':
      return { ...state, skills: action.skills ?? [] };

    case 'planDockHeight':
      return { ...state, dockHeight: action.height };

    case 'checkpoint':
      return {
        ...state,
        checkpoint: {
          taskId: action.taskId ?? '',
          taskTitle: action.taskTitle ?? '',
          summary: action.summary ?? '',
          pausedAt: action.now,
        },
      };

    default:
      return state;
  }
}
