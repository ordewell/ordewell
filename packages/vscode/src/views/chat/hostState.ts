import type { AccountLimitSnapshot, GlobalRunSettings, IsolationPreview } from '@ordewell/core';
import type { SurfacePlan, DiscoveredModel, RunnerId, RunActivity, RunView, RunTask, AiProvider } from '@ordewell/core';
import { DEFAULT_RUNNERS, EMPTY_HOLD, EMPTY_RUN, IDLE_ACTIVITY, type PromptHold } from '@ordewell/core/plan-utils';
import type { HostToWebview, PlannerBackend, RunnerMeta } from '../../shared/protocol';
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
  /**
   * Which conversation that is: it moves on when the host replaces one, whose
   * block ids a new one reuses, so what a reader opened in it stays with it.
   */
  conversationEpoch: number;
  plan: SurfacePlan | null;
  isExecuting: boolean;
  isResearchActive: boolean;
  error: string;
  models: DiscoveredModel[];
  modelsByRunner: Partial<Record<string, DiscoveredModel[]>>;
  modelAllowlist: Record<string, string[]>;
  runnerList: RunnerInfo[];
  /** The runners the settings file every surface shares holds on (ADR-0043), as the host last reported them. */
  enabledRunnerIds: string[];
  /**
   * A Runners pill clicked, on or off, until the host's `runnerChoiceSaved`
   * for that request answers it, saved or not. A runner list is never the
   * answer: discovery that began before the save would revive the old state.
   */
  pendingRunners: Partial<Record<RunnerId, { enabled: boolean; requestId: string }>>;
  /** Queued prompts: what the host is holding for the next planner turn. */
  held: PromptHold;
  /** The last queued text the host gave back; `seq` makes a repeat of the same words land again. */
  unsent: { text: string; seq: number } | null;
  modesByRunner: Record<string, RunnerMode[]>;
  /** The one line a runner's modes being off on this host puts above the plan, with the page that explains it. */
  runnerNotice: { line: string; docs: string } | null;
  modelConfig: { orchestrator: string; orchestratorProvider?: string } | null;
  /** The user's autonomy level, run settings (ADR-0030) and parallel limit; null until the host sends them. */
  runSettings: { autonomous: boolean; run: GlobalRunSettings; maxParallel: number } | null;
  /** Bumped by each `/settings`: App opens the Settings panel at its Run block. */
  settingsRequest: number;
  modelOptions: ModelOption[];
  configuredProviders: AiProvider[];
  /** Who plans (ADR-0009): the backends offered, the one in use, and its runner + effort. */
  planner: { backends: PlannerBackend[]; provider: string; runner?: string; effort?: string };
  /**
   * Whether the host has said who can plan, and which agents are installed.
   * Both come from its probe for coding agents, after the catalog may already
   * be in; until then the first screen says it is detecting rather than that
   * nothing is installed.
   */
  plannerKnown: boolean;
  runnersKnown: boolean;
  isReady: boolean;
  modelDiscoveryErrors: Record<string, string>;
  skills: { name: string; description: string; appliesTo?: 'planner' | 'task' }[];
  taskSkills: { name: string; description: string }[];
  checkpoint: { taskId: string; taskTitle: string; summary: string; pausedAt: number } | null;
  /**
   * The checkpoint the user answered, by task id and question. A run view that
   * still carries the question — the status update clearing the task has not
   * arrived, or another task's update landed first — must not re-open the
   * panel; only a different question does.
   */
  answeredCheckpoint: { taskId: string; summary: string } | null;
  taskOutput: TaskOutputMap;
  /**
   * The run as the host folded every session event (#S8c): each task's plan
   * fields and status, the merge view, usage, run settings, handoff and last
   * Merge all result. The per-task badges and the isolation cards read here.
   */
  run: RunView;
  /**
   * The run's own state, as a `runView` or an Execute's answer last said:
   * starting, running, scheduled or resumable. The plan's status is the
   * execution flag; this is the start's.
   */
  activity: RunActivity;
  /**
   * The user pressed Execute (or Approve all) and the host has not answered
   * yet: the button shows "Starting…" at once. Cleared by the matching
   * `runActivity`, a refusal, or a session change — never by a run's own ticks.
   */
  starting: boolean;
  /** The Execute request `starting` belongs to; a reply for another is stale. */
  startRequestId: number | null;
  /** Is the plan dock open? See planDock.ts for when this flips. */
  dockExpanded: boolean;
  /** The dock's dragged cap in px, remembered by the host; undefined keeps the stylesheet's default. */
  dockHeight: number | undefined;
  /** When the open planner turn began (ISO), for the elapsed time of its working row (#81); none while the host did not say. */
  plannerTurnStartedAt?: string;
  /** The user stopped the turn: plan updates are dropped until the host closes it. */
  stopped: boolean;
  /**
   * The watchdog unlocked the input on a turn the host never closed. The host
   * saying that turn is still producing (`plannerTurnAlive`) locks it again;
   * any word from the host on the turn, or the user's own, ends the wait.
   */
  turnLost: boolean;
  /**
   * The user started a new session: errors from the old one's turn are
   * dropped, until the user sends anything, a typed command included.
   */
  sessionCleared: boolean;
  /** Every installed runner's account limits: live account data, kept across a session reset. */
  accountLimits: readonly AccountLimitSnapshot[];
  /**
   * The workspace's repositories and branches, as the host last read them.
   * `undefined` until the host says anything; `null` while it re-reads, after
   * a workspace change or a reload, so an old answer is never shown as current.
   * Not part of a session: a new or restored one keeps it.
   */
  isolationPreview: IsolationPreview | null | undefined;
}

export const INITIAL_HOST_STATE: HostState = {
  conversation: EMPTY_PATCHED_VIEW,
  conversationEpoch: 0,
  plan: null,
  isExecuting: false,
  isResearchActive: false,
  error: '',
  models: [],
  modelsByRunner: {},
  modelAllowlist: {},
  runnerList: [],
  enabledRunnerIds: [...DEFAULT_RUNNERS],
  pendingRunners: {},
  held: EMPTY_HOLD,
  unsent: null,
  modesByRunner: {},
  runnerNotice: null,
  modelConfig: null,
  runSettings: null,
  settingsRequest: 0,
  modelOptions: [],
  configuredProviders: [],
  planner: { backends: [], provider: '' },
  plannerKnown: false,
  runnersKnown: false,
  isReady: false,
  modelDiscoveryErrors: {},
  skills: [],
  taskSkills: [],
  checkpoint: null,
  answeredCheckpoint: null,
  taskOutput: {},
  run: EMPTY_RUN,
  activity: IDLE_ACTIVITY,
  starting: false,
  startRequestId: null,
  dockExpanded: false,
  dockHeight: undefined,
  stopped: false,
  turnLost: false,
  sessionCleared: false,
  accountLimits: [],
  isolationPreview: undefined,
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
  | { type: 'commandSent' }
  | { type: 'startRequested'; requestId: number }
  | { type: 'patchPlan'; plan: Updatable<SurfacePlan | null> }
  | { type: 'turnLost' }
  | { type: 'patchError'; error: string }
  | { type: 'patchReady'; ready: boolean }
  | { type: 'runnerChoiceRequested'; runnerId: RunnerId; enabled: boolean; requestId: string }
  | { type: 'checkpointAnswered' }
  | { type: 'patchDockHeight'; height: number | undefined }
  | { type: 'patchDockExpanded'; expanded: Updatable<boolean> };

/**
 * Clears what belongs to the previous session. Fields per kind:
 * - all kinds: error, plan, the run, checkpoint, task output, and the dock (the
 *   run's per-task badges are keyed by task id, so they must not outlive the
 *   plan they described).
 * - 'restore' and 'new' also: stop the running/planning flags and drop queued
 *   prompts. 'empty' leaves them: the host's own `state` says whether a run
 *   goes on and `plannerTurn` whether a turn does, and queued prompts survive
 *   an emptied plan.
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
    answeredCheckpoint: null,
    taskOutput: {},
    run: EMPTY_RUN,
    activity: IDLE_ACTIVITY,
    starting: false,
    startRequestId: null,
    dockExpanded: nextDock(state.dockExpanded, 'session-reset'),
  };
  if (kind === 'empty') return next;
  next.isResearchActive = false;
  next.turnLost = false;
  next.isExecuting = false;
  next.held = EMPTY_HOLD;
  next.stopped = kind === 'new';
  next.sessionCleared = kind === 'new';
  return next;
}

/** The runners shown on: the saved list, with any pill click the host has not answered yet. */
export function runnersOn(state: Pick<HostState, 'runnerList' | 'enabledRunnerIds' | 'pendingRunners'>): RunnerId[] {
  const on = (id: RunnerId) => state.pendingRunners[id]?.enabled ?? state.enabledRunnerIds.includes(id);
  const listed = state.runnerList.map((r) => r.id);
  return [...new Set([...listed, ...state.enabledRunnerIds])].filter(on);
}

function resolve<T>(value: Updatable<T>, prev: T): T {
  return typeof value === 'function' ? (value as (p: T) => T)(prev) : value;
}

export function reduceHost(state: HostState, action: HostAction): HostState {
  switch (action.type) {
    case 'resetSession':
      return resetSession(state, action.kind);

    case 'turnStopped':
      return { ...state, stopped: true, isResearchActive: false, turnLost: false };

    case 'turnRequested':
      return { ...state, stopped: false, sessionCleared: false, error: '', isResearchActive: true, turnLost: false };

    // A command such as /fork or /compact opens no turn of the old session's,
    // and may fail before it opens one at all: its error is the new session's.
    case 'commandSent':
      return state.sessionCleared ? { ...state, sessionCleared: false } : state;

    case 'startRequested':
      // A second click while the first is still with the host is the same
      // start, not another: the host and core coalesce it too.
      if (state.starting || state.activity.starting) return state;
      return { ...state, starting: true, startRequestId: action.requestId, error: '' };

    case 'patchPlan':
      return { ...state, plan: resolve(action.plan, state.plan) };

    case 'turnLost':
      return { ...state, isResearchActive: false, turnLost: true };

    case 'patchError':
      return { ...state, error: action.error };

    case 'patchReady':
      return { ...state, isReady: action.ready };

    case 'runnerChoiceRequested': {
      const { runnerId, enabled, requestId } = action;
      return { ...state, pendingRunners: { ...state.pendingRunners, [runnerId]: { enabled, requestId } } };
    }

    case 'runnerChoiceSaved': {
      // An answer to an older or repeated request, or to the page before a
      // reload, leaves the newer click it would otherwise clear.
      if (state.pendingRunners[action.runnerId]?.requestId !== action.requestId) return state;
      const pendingRunners = { ...state.pendingRunners };
      delete pendingRunners[action.runnerId];
      const saved = state.enabledRunnerIds.includes(action.runnerId);
      let enabledRunnerIds = state.enabledRunnerIds;
      if (action.enabled && !saved) enabledRunnerIds = [...enabledRunnerIds, action.runnerId];
      if (!action.enabled && saved) enabledRunnerIds = enabledRunnerIds.filter((id) => id !== action.runnerId);
      return { ...state, enabledRunnerIds, pendingRunners };
    }

    case 'checkpointAnswered':
      // The question is answered here, before the run says so: remember it so
      // the next run view still carrying it does not re-open the panel.
      return {
        ...state,
        checkpoint: null,
        answeredCheckpoint: state.checkpoint
          ? { taskId: state.checkpoint.taskId, summary: state.checkpoint.summary }
          : state.answeredCheckpoint,
      };

    case 'patchDockHeight':
      return { ...state, dockHeight: action.height };

    case 'patchDockExpanded':
      return { ...state, dockExpanded: resolve(action.expanded, state.dockExpanded) };

    case 'setState': {
      const base = action.state === 'empty' ? resetSession(state, 'empty') : state;
      // `approved` is the plan's approval, not a run: a task's own status is
      // what says work is executing. The click's own "Starting…" covers the
      // gap, so forcing `isExecuting` here made a start read as a run.
      return { ...base, isExecuting: action.state === 'empty' ? false : base.isExecuting };
    }

    case 'planUpdated': {
      if (state.stopped) return state;
      const incoming: SurfacePlan | null = action.plan ?? null;
      let next: HostState = { ...state, plan: incoming };
      // Not a turn's end: a run's status tick arrives mid-turn too, and the
      // host's `plannerTurn` is what says a turn is over.
      if (incoming) {
        next.isExecuting = incoming.status === 'running';
        // A run is executing now: the click's start has arrived, and its
        // button must be the run's Stop, not a spinner for a finished start.
        if (next.isExecuting) next.starting = false;
      }
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
      return { ...resetSession(state, 'restore'), conversationEpoch: state.conversationEpoch + 1 };

    // A new session or a cleared plan empties the conversation first; a reload
    // replaces it with blocks renumbered from the start. A compaction does
    // neither: it folds in where it happened (ADR-0017).
    case 'conversationPatch':
      return {
        ...state,
        conversation: applyConversationPatch(state.conversation, action),
        ...((action.order.length === 0 && state.conversation.order.length > 0) || action.replaced
          ? { conversationEpoch: state.conversationEpoch + 1 } : {}),
      };

    // The stop gate lasts until the host has closed the stopped turn; a new
    // turn is never gated.
    case 'plannerTurn':
      return { ...state, stopped: false, isResearchActive: action.active, turnLost: false, plannerTurnStartedAt: action.active ? action.startedAt : undefined };

    case 'plannerTurnAlive':
      if (!state.turnLost || state.stopped) return state;
      return { ...state, isResearchActive: true, turnLost: false };

    case 'showError':
      if (state.sessionCleared) return state;
      return { ...state, error: action.error, isResearchActive: false, turnLost: false, starting: false, startRequestId: null };

    case 'taskOutput':
      return { ...state, taskOutput: appendTaskOutput(state.taskOutput, action.taskId, action.text ?? '') };

    // The run view replaces the per-field status, isolation and merge
    // messages: one fold, and the checkpoint panel follows from it — so a
    // webview that rejoins is re-told a checkpoint it never saw arrive.
    case 'runView': {
      const question = checkpointOf(action.view);
      // A question the user already answered must not re-open the panel while
      // the run still carries it. A different question is a new ask, and clears
      // the memory; so does a view with no question at all.
      const answered = !!question && state.answeredCheckpoint?.taskId === question.taskId
        && state.answeredCheckpoint.summary === question.summary;
      const checkpoint = question && !answered
        ? state.checkpoint?.taskId === question.taskId
          ? { ...question, pausedAt: state.checkpoint.pausedAt }
          : { ...question, pausedAt: action.now }
        : null;
      const activity = action.view.activity ?? state.activity;
      return {
        ...state,
        run: action.view,
        activity,
        checkpoint,
        answeredCheckpoint: answered ? state.answeredCheckpoint : null,
        // Work is live: whatever start was waiting is over, and Stop is the
        // control now. A view that only says "starting" leaves the spinner be.
        starting: activity.running ? false : state.starting,
      };
    }

    case 'runActivity': {
      // A reply for an Execute this webview is no longer waiting on is another
      // session's (or an already-settled one): it must not light a spinner.
      if (action.requestId !== undefined && action.requestId !== state.startRequestId) return state;
      return {
        ...state,
        activity: action.activity,
        starting: false,
        startRequestId: action.requestId !== undefined ? null : state.startRequestId,
      };
    }

    case 'setModels':
      return { ...state, models: action.models ?? [] };

    case 'setModelsByRunner':
      return { ...state, modelsByRunner: action.modelsByRunner ?? {} };

    case 'setModelAllowlist':
      return { ...state, modelAllowlist: action.allowlist ?? {} };

    case 'setModesByRunner':
      return { ...state, modesByRunner: action.modesByRunner ?? {}, runnerNotice: action.notice ?? null };

    case 'setModelConfig':
      return { ...state, modelConfig: action.modelConfig ?? null };

    case 'setModelOptions':
      return { ...state, modelOptions: action.modelOptions ?? [] };

    case 'setConfiguredProviders':
      return { ...state, configuredProviders: action.providers ?? [], isReady: true };

    case 'setPlannerBackends':
      return {
        ...state,
        plannerKnown: true,
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
      return {
        ...state,
        runnerList: list.map((r: RunnerMeta) => ({ id: r.id, displayName: r.displayName })),
        enabledRunnerIds: list.filter((r: RunnerMeta) => r.enabled).map((r: RunnerMeta) => r.id),
        runnersKnown: true,
      };
    }

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

    case 'accountLimits':
      return { ...state, accountLimits: action.limits };

    case 'isolationPreview':
      return { ...state, isolationPreview: action.preview };

    case 'setRunSettings':
      return { ...state, runSettings: { autonomous: action.autonomous, run: action.run, maxParallel: action.maxParallel } };

    case 'openSettings':
      return { ...state, settingsRequest: state.settingsRequest + 1 };

    default:
      return state;
  }
}

/** The task, if any, parked at a checkpoint: the whole question the panel draws. */
function checkpointOf(view: RunView): { taskId: string; taskTitle: string; summary: string } | null {
  const find = (tasks: readonly RunTask[]): { taskId: string; taskTitle: string; summary: string } | null => {
    for (const task of tasks) {
      if (task.status === 'awaiting_user' && task.awaitingReason === 'checkpoint' && task.checkpoint) {
        return { taskId: task.id, taskTitle: task.title, summary: task.checkpoint };
      }
      const nested = find(task.subtasks);
      if (nested) return nested;
    }
    return null;
  };
  return find(view.tasks);
}
