import { ALL_PROVIDERS, CLI_PROVIDERS, PROVIDER_PRIORITY, runnerForProvider, type AiProvider, type ConversationMessage, type ResearchStepOutcome } from '@ordewell/core';
import { dependencyCandidates, dependentsOf } from '@ordewell/core/plan-utils';
import { sanitize } from './ansi';
import { applyKey, commit, emptyEditor, type EditorState } from './editor';
import { chatEditorRoom, chatPaneWidth, paneColumns, planPaneWidth, taskEditorRoom } from './geometry';
import { bodyRows, chatScrollMax, helpScrollMax, planScrollExtent } from './layout';
import { selectedText } from './render';
import { completions, findCommand, parseSlash, type ParsedCommand } from './slash';
import {
  findTask, initialState, SKILL_IDS, planRows, selectedPlanRow, visibleItems,
  type ApprovalRequestView, type Cell, type ChatMessage, type Focus, type MessageRole, type ModeView,
  type ModelView, type PickerItem, type PickerState, type RunnerView, type Selection, type SessionView,
  type SkillId, type TaskView, type TuiState,
} from './state';
import { assignedModelFor, effortsForTask, modelsForRunner, modelsForTask, modesForTask, runnerAccepts } from './taskAssignment';
import type { Key } from './keys';

export { initialState };

/** Side effects the runtime performs; the reducer itself stays pure. */
export type Effect =
  /** `allowInit` is only ever set on the retry after the user confirms the "initialize this as a new workspace?" prompt — see `workspaceNeedsInit`. */
  | { type: 'startConversation'; goal: string; allowInit?: boolean }
  | { type: 'sendMessage'; sessionId: string; message: string }
  | { type: 'command'; name: string; action: 'on' | 'off' }
  | { type: 'setModel'; modelId: string }
  | { type: 'setPlanner'; provider: string }
  | { type: 'setPlannerEffort'; effort: string }
  | { type: 'setApiKey'; provider: string; key: string }
  | { type: 'setAllowlist'; runner: string; modelIds: string[] }
  | { type: 'setRunnerEnabled'; runner: string; enabled: boolean }
  /** The runner picker's whole confirmed set, so one visit reports one result. */
  | { type: 'setRunners'; changes: { runner: string; enabled: boolean }[]; message: string }
  | { type: 'setAutonomous'; enabled: boolean }
  | { type: 'setMouseCapture'; enabled: boolean }
  /** A finished selection, already clipped to its pane and stripped of paint. */
  | { type: 'copyText'; text: string }
  | { type: 'loadModels' }
  | { type: 'loadSessions' }
  | { type: 'loadSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'saveSession'; sessionId: string }
  | { type: 'closeSession'; sessionId: string }
  | { type: 'execute'; sessionId: string }
  | { type: 'stopExecution'; sessionId: string }
  | { type: 'cancelPlanning'; sessionId: string }
  | { type: 'processQueued'; sessionId: string }
  /** `watch` asks the runtime to hold the execution stream open for this action — see `taskActionEffect`. */
  | { type: 'taskAction'; sessionId: string; taskId: string; action: TaskAction; watch?: boolean }
  | { type: 'addTask'; sessionId: string; title: string }
  | { type: 'updateTask'; sessionId: string; taskId: string; changes: Record<string, unknown>; message: string }
  | { type: 'removeTask'; sessionId: string; taskId: string }
  | { type: 'openTaskTerminal'; sessionId: string; taskId: string }
  | { type: 'respondApproval'; sessionId: string; approvalId: string; granted: boolean }
  | { type: 'refresh' }
  | { type: 'exit' };

export type TaskAction = 'complete' | 'uncomplete' | 'skip' | 'retry' | 'cancel' | 'force-start';

export type Action =
  | { type: 'key'; key: Key }
  | { type: 'sessionStarted'; sessionId: string; goal: string }
  | { type: 'sessionCleared' }
  | { type: 'chatRestored'; history: ConversationMessage[]; sessionId?: string }
  | { type: 'planUpdated'; plan: unknown; sessionId?: string }
  | { type: 'plannerMessage'; content: string; sessionId?: string }
  | { type: 'plannerToken'; text: string; sessionId?: string }
  | { type: 'researchStep'; summary: string; toolCallId?: string; sessionId?: string }
  | { type: 'researchStepDone'; summary: string; toolCallId?: string; outcome: ResearchStepOutcome; result: string; sessionId?: string }
  | { type: 'plannerThinking'; text: string; sessionId?: string }
  | { type: 'approvalRequested'; request: ApprovalRequestView; sessionId?: string }
  | { type: 'approvalSettled'; approvalId: string; sessionId?: string }
  | { type: 'taskStatus'; taskId: string; status: string; sessionId?: string }
  | { type: 'tasksStatus'; updates: Record<string, { status: string; idleSince?: string | null }>; sessionId?: string }
  | { type: 'queueReady'; sessionId?: string }
  | { type: 'executionComplete'; summary?: { total: number; completed: number; failed: number }; stopped?: boolean; sessionId?: string }
  | { type: 'settingsLoaded'; settings: Record<string, unknown> }
  | { type: 'modelsLoaded'; models: ModelView[]; orchestratorModels?: ModelView[]; providers?: string[]; providerErrors?: Record<string, string>; modesByRunner?: Record<string, ModeView[]> }
  | { type: 'sessionsLoaded'; sessions: SessionView[] }
  | { type: 'runnersLoaded'; runners: RunnerView[]; orchestratorModel?: string }
  | { type: 'failed'; message: string }
  /** The workspace has no project marker — offer to initialize it rather than just failing. */
  | { type: 'workspaceNeedsInit'; goal: string; workspace: string }
  | { type: 'notice'; message: string }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'spinnerTick' };

export interface Step {
  state: TuiState;
  effects: Effect[];
}

const KNOWN_PROVIDERS = Object.keys(ALL_PROVIDERS);
const DEFAULT_EFFORT = '__runner_default__';

function step(state: TuiState, effects: Effect[] = []): Step {
  return { state, effects };
}

function say(
  state: TuiState,
  role: MessageRole,
  content: string,
  research?: ChatMessage['research'],
  extra?: Partial<Pick<ChatMessage, 'research' | 'streaming'>>,
): TuiState {
  // The daemon, not just the keyboard, can hand us a literal tab (a planner
  // turn, a research summary) — see `sanitize` for why one left in breaks
  // the frame just as a pasted one would.
  const message: ChatMessage = {
    role,
    content: sanitize(content),
    timestamp: new Date().toISOString(),
    ...(research ? { research } : {}),
    ...extra,
  };
  // A new turn snaps a scrolled-back transcript to the tail — following the
  // conversation beats preserving the reading position.
  return { ...state, messages: [...state.messages, message], scroll: 0 };
}

/**
 * A loaded session's persisted dialogue (ADR-0002) rebuilt as transcript
 * entries. `plan_generated` is a timeline marker, not a spoken turn — the plan
 * pane already shows the plan itself, so it becomes a system note rather than
 * an inline card (the TUI has no equivalent of the webview's plan anchor).
 */
function restoredMessages(history: ConversationMessage[]): ChatMessage[] {
  return history.map((entry) => ({
    role: entry.kind === 'plan_generated' ? 'system' : entry.kind === 'system' ? 'system' : entry.role,
    content: sanitize(entry.kind === 'plan_generated' ? 'Plan generated.' : entry.content),
    timestamp: entry.timestamp,
  }));
}

const isPendingResearch = (m: ChatMessage): boolean => m.role === 'research' && !m.research?.outcome;

/**
 * Whether this is the planner's newest turn arriving a second time.
 *
 * One turn can reach the TUI twice: the daemon broadcasts `planner_message` on
 * the session socket *and* leaves it as the last assistant entry in the plan it
 * returns, and while a run is live there are two subscriptions to that one
 * channel (planning and execution). Only a repeat of the newest turn counts —
 * scoped to "nothing has been said since" so a planner legitimately repeating
 * itself on a later turn still gets its line.
 */
function alreadySpoken(messages: ChatMessage[], content: string): boolean {
  const last = findLastIndex(messages, (m) => m.role === 'assistant' || m.role === 'user');
  return last >= 0 && messages[last].role === 'assistant' && messages[last].content === content;
}

/**
 * A parallel tool round opens several calls at once. The spinner names the
 * newest and counts the rest, rather than flickering between filenames and
 * leaving the user with whichever one happened to land last.
 */
function researchLabel(messages: ChatMessage[], summary: string): string {
  const others = messages.filter(isPendingResearch).length - 1;
  return others > 0 ? `${summary} (+${others} more)` : summary;
}

/**
 * Settle the transcript entry this result belongs to. The id match is what
 * keeps a parallel round honest; the summary match is the fallback for a
 * stream that reports no tool_call id.
 */
function settleResearchStep(
  messages: ChatMessage[],
  action: Extract<Action, { type: 'researchStepDone' }>,
): ChatMessage[] {
  // The stored entry's content already went through `say`, so the no-id
  // fallback match has to compare against the same sanitized form or a
  // summary carrying a tab would never settle.
  const summary = sanitize(action.summary);
  const index = findLastIndex(messages, (m) =>
    isPendingResearch(m) &&
    (action.toolCallId ? m.research?.toolCallId === action.toolCallId : m.content === summary));
  if (index < 0) return messages;

  const next = [...messages];
  next[index] = {
    ...next[index],
    research: { ...next[index].research, outcome: action.outcome, result: sanitize(action.result) },
  };
  return next;
}

function findLastIndex<T>(items: T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (match(items[i])) return i;
  }
  return -1;
}

/** Enough reasoning to see the planner is thinking, not enough to scroll the frame. */
const THINKING_TAIL = 400;

const fail = (state: TuiState, message: string): Step => step(say(state, 'error', message));

/**
 * A planner/execution result carries the session id it was produced for. A
 * turn from a session that `/new` has since replaced must not touch the
 * fresh state, even though its promise/socket callback fires afterwards.
 */
const stale = (state: TuiState, sessionId: string | undefined): boolean =>
  sessionId !== undefined && sessionId !== state.sessionId;

export function reduce(state: TuiState, action: Action): Step {
  switch (action.type) {
    case 'key':
      return handleKey(state, action.key);

    case 'sessionStarted':
      return step({ ...state, sessionId: action.sessionId, goal: action.goal });

    // The daemon registers a session only once planning succeeds; when it does
    // not, holding on to the id would send every next message to a session the
    // server never had.
    case 'sessionCleared':
      // Prompts belong to the session that raised them; the old planner is gone.
      return step({
        ...state,
        sessionId: null,
        goal: '',
        pendingApprovals: [],
        overlay: state.overlay?.kind === 'approval' ? null : state.overlay,
      });

    case 'approvalRequested': {
      if (stale(state, action.sessionId)) return step(state);
      return step(enqueueApproval(state, action.request));
    }

    case 'approvalSettled': {
      if (stale(state, action.sessionId)) return step(state);
      return step(dropApproval(state, action.approvalId));
    }

    case 'chatRestored':
      if (stale(state, action.sessionId)) return step(state);
      return step({ ...state, messages: restoredMessages(action.history), scroll: 0 });

    case 'planUpdated': {
      if (stale(state, action.sessionId)) return step(state);
      const tasks = normalizeTasks(action.plan);
      // A plan refresh can supersede the task whose prompt is open; the editor
      // survives only while its task does. The cursor is clamped against the
      // visible rows afterwards, so an expanded parent's subtasks count.
      // `findTask` walks subtasks too — the expanded id is a subtask's as often
      // as a top-level task's.
      const expandedTaskId =
        state.expandedTaskId && findTask(tasks, state.expandedTaskId) ? state.expandedTaskId : null;
      const next: TuiState = {
        ...state,
        tasks,
        status: state.status === 'planning' || state.status === 'researching' ? 'idle' : state.status,
        busyLabel: '',
        thinkingLine: '',
        expandedTaskId,
        taskEditor: expandedTaskId !== null ? state.taskEditor : null,
      };
      return step({ ...next, selectedTask: Math.min(state.selectedTask, Math.max(0, planRows(next).length - 1)) });
    }

    case 'plannerMessage': {
      if (stale(state, action.sessionId)) return step(state);
      const settled: TuiState = { ...state, status: 'idle', busyLabel: '', thinkingLine: '' };
      // Sanitized before the comparison, not just before storage — `say`
      // stores the sanitized form, so matching against the raw turn would
      // never dedup a repeat that carries a tab.
      const content = sanitize(action.content);
      // A live `plan_token` stream left a partial bubble at the tail: settle it
      // with the final text in place rather than appending a second entry.
      const last = state.messages.at(-1);
      if (last?.role === 'assistant' && last.streaming) {
        const messages = [...state.messages];
        messages[messages.length - 1] = { ...last, content, streaming: undefined };
        return step({ ...settled, messages });
      }
      // Already on screen: the same turn reached us over both the session
      // socket and the REST reply (see `converse`), so only the status settles.
      if (alreadySpoken(state.messages, content)) return step(settled);
      return step(say(settled, 'assistant', content));
    }

    case 'plannerToken': {
      if (stale(state, action.sessionId)) return step(state);
      const text = sanitize(action.text);
      const last = state.messages.at(-1);
      if (last?.role === 'assistant' && last.streaming) {
        const messages = [...state.messages];
        messages[messages.length - 1] = { ...last, content: last.content + text };
        return step({ ...state, messages });
      }
      return step(say(state, 'assistant', text, undefined, { streaming: true }));
    }

    case 'researchStep': {
      if (stale(state, action.sessionId)) return step(state);
      const summary = sanitize(action.summary);
      // A transcript entry, not just a spinner label: overwriting the label was
      // why a parallel round collapsed to whichever call finished last.
      const spoken = say(state, 'research', summary, { toolCallId: action.toolCallId });
      // The footer said "Planning…" through the whole research phase, which is
      // where a turn spends most of its time. `researching` is the same
      // in-flight state as far as ESC is concerned — only the label differs.
      const status = state.status === 'planning' ? 'researching' : state.status;
      return step({ ...spoken, status, busyLabel: researchLabel(spoken.messages, summary) });
    }

    case 'researchStepDone': {
      if (stale(state, action.sessionId)) return step(state);
      const messages = settleResearchStep(state.messages, action);
      const pending = messages.filter(isPendingResearch);
      // Round over, model thinking again — back to the planning label until the
      // next tool call, or until the turn settles the status to idle.
      const status = pending.length === 0 && state.status === 'researching' ? 'planning' : state.status;
      return step({
        ...state,
        messages,
        status,
        busyLabel: pending.length > 0 ? researchLabel(messages, pending[pending.length - 1].content) : '',
      });
    }

    case 'plannerThinking': {
      if (stale(state, action.sessionId)) return step(state);
      // The one piece of planner text that never becomes a transcript entry,
      // and so never passes through `say` — it goes straight to the status row,
      // which is repainted on every spinner tick.
      return step({ ...state, thinkingLine: (state.thinkingLine + sanitize(action.text)).slice(-THINKING_TAIL) });
    }

    case 'taskStatus': {
      if (stale(state, action.sessionId) || !state.tasks.some((t) => t.id === action.taskId)) return step(state);
      return step({
        ...state,
        status: 'executing',
        tasks: state.tasks.map((t) => (t.id === action.taskId ? { ...t, status: action.status } : t)),
      });
    }

    case 'tasksStatus': {
      if (stale(state, action.sessionId)) return step(state);
      const updates = action.updates;
      let changed = false;
      const tasks = state.tasks.map((t) => {
        const update = updates[t.id];
        if (update === undefined) return t;
        const idleSince = update.idleSince ?? null;
        if (update.status !== t.status || idleSince !== (t.idleSince ?? null)) {
          changed = true;
          return { ...t, status: update.status, idleSince };
        }
        return t;
      });
      // Skip a new state object when nothing actually changed — a no-op
      // status_update still triggers a render via dispatch, but at least
      // the reference equality lets downstream memos keep their hits.
      if (!changed) return step(state);
      return step({ ...state, status: 'executing', tasks });
    }

    case 'queueReady': {
      if (stale(state, action.sessionId)) return step(state);
      const sessionId = action.sessionId ?? state.sessionId;
      if (sessionId === null) return step(state);
      return step(state, [{ type: 'processQueued', sessionId }]);
    }

    case 'executionComplete': {
      if (stale(state, action.sessionId)) return step(state);
      // A stop sends no tally, and defaulting it to zero reported a run halted
      // after four of five tasks as "0/5 complete". The pane already holds the
      // per-task statuses the daemon streamed, so count them.
      const { completed, total, failed } = action.summary ?? {
        completed: state.tasks.filter((t) => t.status === 'completed').length,
        total: state.tasks.length,
        failed: state.tasks.filter((t) => t.status === 'failed').length,
      };
      const failures = failed > 0 ? ` · ${failed} failed` : '';
      const verb = action.stopped ? 'stopped' : 'finished';
      return step({
        ...say(state, 'system', `Execution ${verb} — ${completed}/${total} tasks complete${failures}.`),
        status: 'idle',
        busyLabel: '',
        thinkingLine: '',
      });
    }

    case 'settingsLoaded':
      return step(applySettings(state, action.settings));

    case 'modelsLoaded':
      return step(
        refillPicker(
          {
            ...state,
            models: action.models,
            orchestratorModels: action.orchestratorModels ?? state.orchestratorModels,
            configuredProviders: action.providers ?? state.configuredProviders,
            providerErrors: action.providerErrors ?? state.providerErrors,
            modesByRunner: action.modesByRunner ?? state.modesByRunner,
          },
          ['set-model', 'set-planner', 'set-task-model', 'set-task-effort', 'set-task-mode'],
        ),
      );

    case 'sessionsLoaded':
      return step(refillPicker({ ...state, sessions: action.sessions }, ['load-session', 'delete-session']));

    case 'runnersLoaded':
      // Installed runners are the planner picker's preflight signal, so a
      // picker opened before discovery landed fills in rather than sitting
      // there claiming every agent is missing.
      return step(refillPicker({
        ...state,
        runners: action.runners,
        orchestratorModel: action.orchestratorModel ?? state.orchestratorModel,
      }, ['set-planner', 'set-task-runner']));

    case 'failed':
      return step({ ...say(state, 'error', action.message), status: 'idle', busyLabel: '', thinkingLine: '' });

    case 'workspaceNeedsInit':
      return step({
        ...state,
        status: 'idle',
        busyLabel: '',
        thinkingLine: '',
        overlay: {
          kind: 'confirm',
          title: 'Initialize new workspace?',
          message: `"${action.workspace}" isn't a recognized project yet (no .git or manifest found). Start a new ordewell workspace here?`,
          action: { kind: 'init-workspace', goal: action.goal, workspace: action.workspace },
        },
      });

    case 'notice':
      return step(say(state, 'system', action.message));

    case 'resize': {
      // A grown pane can leave both offsets pointing past the end of content
      // that now fits; re-clamping here keeps "the offset is always reachable"
      // true for the keys handled next, not just for the ones handled last.
      // The selection goes rather than moves: it names screen cells, and a
      // resize both re-wraps what is under them and shifts the divider — so a
      // span anchored where the plan pane used to begin would end up straddling
      // the new one, which is exactly the splice pinning a pane prevents.
      const resized = { ...state, rows: action.rows, cols: action.cols, selection: null };
      return step({
        ...resized,
        scroll: clamp(resized.scroll, chatScrollMax(resized)),
        planScroll: resized.planScroll === null
          ? null
          : clamp(resized.planScroll, planScrollExtent(resized).maxScroll),
      });
    }

    // Whether there is anything to animate is the app loop's call (it owns the
    // timer); a tick that arrives simply advances the frame.
    case 'spinnerTick':
      return step({ ...state, spinnerFrame: (state.spinnerFrame + 1) % 10 });
  }
}

// ── Incoming data ────────────────────────────────────────────────────────────

/**
 * A plan's text, safe to lay out. Every field here was written by a model, so
 * it gets the same treatment a planner turn does — see `sanitize`.
 */
const planText = (value: unknown, fallback = ''): string => sanitize(String(value ?? fallback));

/**
 * The same, for a field the pane paints on one row. A newline surviving into
 * one of these would be written into the middle of a row rather than wrapped,
 * which moves the terminal's cursor down a line and shoves the rest of the
 * frame with it — the plan pane's meta rows are `truncate`d, not wrapped, so
 * nothing downstream would split it.
 */
const planLabel = (value: unknown, fallback = ''): string => planText(value, fallback).replace(/\n+/g, ' ');

/**
 * A plan reaches the TUI in two shapes. Live from the planner it is one flat
 * `tasks` array; persisted it is split in two — finished tasks in
 * `executionLog`, the rest in `pendingTasks` — so the two halves are rejoined
 * and re-ordered, otherwise completed work would vanish from the pane.
 */
function normalizeTasks(plan: unknown): TaskView[] {
  const source = plan as { tasks?: unknown[]; pendingTasks?: unknown[]; executionLog?: unknown[] } | null;

  const byId = new Map<string, Record<string, any>>();
  // Pending first, then the log: the log is the record of what actually
  // happened, so it wins for a task that somehow appears in both.
  for (const list of [source?.pendingTasks, source?.executionLog]) {
    for (const task of (list ?? []) as Record<string, any>[]) {
      byId.set(String(task.id), task);
    }
  }

  const raw = byId.size > 0
    ? [...byId.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : ((source?.tasks ?? []) as Record<string, any>[]);

  return raw.map((t, i) => toTaskView(t, i));
}

/** One wire task as the pane's `TaskView`, recursing into sorted subtasks. */
function toTaskView(t: Record<string, any>, index: number): TaskView {
  return {
    id: String(t.id ?? `task-${index + 1}`),
    order: typeof t.order === 'number' ? t.order : index + 1,
    title: planLabel(t.title, 'Untitled task'),
    description: planText(t.description ?? t.title),
    prompt: typeof t.prompt === 'string' ? sanitize(t.prompt) : undefined,
    type: t.type === 'user' ? 'user' : 'ai',
    status: planLabel(t.status, 'pending'),
    dependencies: Array.isArray(t.dependencies) ? t.dependencies.map((id: unknown) => planLabel(id)) : [],
    assignedRunner: typeof t.assignedRunner === 'string' ? planLabel(t.assignedRunner) : undefined,
    taskMode: typeof t.taskMode === 'string' ? planLabel(t.taskMode) : undefined,
    assignedModel:
      t.assignedModel && typeof t.assignedModel === 'object'
        ? {
            modelId: planLabel(t.assignedModel.modelId),
            modelLabel: planLabel(t.assignedModel.modelLabel ?? t.assignedModel.modelId),
            thinkingEffort:
              typeof t.assignedModel.thinkingEffort === 'string'
                ? planLabel(t.assignedModel.thinkingEffort)
                : typeof t.thinkingEffort === 'string'
                  ? planLabel(t.thinkingEffort)
                  : undefined,
            availableVariants: Array.isArray(t.assignedModel.availableVariants)
              ? t.assignedModel.availableVariants.map((variant: unknown) => planLabel(variant))
              : undefined,
          }
        : undefined,
    subtasks: Array.isArray(t.subtasks)
      ? [...t.subtasks]
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((s, i) => toTaskView(s as Record<string, any>, i))
      : undefined,
  };
}

const enabledFlag = (value: unknown): boolean | undefined =>
  typeof (value as { enabled?: unknown })?.enabled === 'boolean'
    ? ((value as { enabled: boolean }).enabled)
    : undefined;

function applySettings(state: TuiState, settings: Record<string, unknown>): TuiState {
  // The daemon names the verification skill `verification`; the TUI calls it `/verify`.
  const sources: Record<SkillId, unknown> = {
    tdd: settings.tdd,
    verify: settings.verification,
  };

  const skills = { ...state.skills };
  for (const id of SKILL_IDS) {
    const flag = enabledFlag(sources[id]);
    if (flag !== undefined) skills[id] = flag;
  }

  return {
    ...state,
    skills,
    orchestratorModel:
      typeof settings.orchestratorModel === 'string' ? settings.orchestratorModel : state.orchestratorModel,
    plannerProvider:
      typeof settings.aiProvider === 'string' ? settings.aiProvider : state.plannerProvider,
    plannerEffort:
      typeof settings.plannerThinkingEffort === 'string' ? settings.plannerThinkingEffort : state.plannerEffort,
    allowlist:
      settings.modelAllowlist && typeof settings.modelAllowlist === 'object'
        ? (settings.modelAllowlist as Record<string, string[]>)
        : state.allowlist,
  };
}

/**
 * A picker opened before its data arrived (`/model`, `/sessions`) shows an
 * empty list; refill it in place when the fetch lands so the user does not have
 * to close and reopen it.
 */
function refillPicker(state: TuiState, kinds: PickerState['action']['kind'][]): TuiState {
  const overlay = state.overlay;
  if (overlay?.kind !== 'picker' || !kinds.includes(overlay.picker.action.kind)) return state;

  const items = pickerItemsFor(state, overlay.picker.action);
  // The model picker's hint carries any provider-fetch failures; recompute it
  // on refill so it appears (or clears) the moment the catalog lands.
  const hint = overlay.picker.action.kind === 'set-model' ? providerErrorHint(state) : overlay.picker.hint;
  return { ...state, overlay: { kind: 'picker', picker: { ...overlay.picker, items, hint, index: 0 } } };
}

/** Provider name + price, so the picker states which provider serves a model. */
function modelDetail(m: ModelView): string | undefined {
  return [m.provider, m.pricing].filter(Boolean).join(' · ') || undefined;
}

/**
 * A one-line warning naming any configured provider whose catalog fetch failed,
 * or undefined when every provider loaded. The picker still lists the models
 * from providers that did work — this just explains what is missing and why.
 */
function providerErrorHint(state: TuiState): string | undefined {
  const failed = Object.keys(state.providerErrors ?? {});
  if (failed.length === 0) return undefined;
  const names = failed.map((p) => ALL_PROVIDERS[p as AiProvider]?.label ?? p);
  return `⚠ Unavailable (key or fetch failed): ${names.join(', ')} — showing working providers only.`;
}

/**
 * The planner-model catalog for the current backend (ADR-0009). A harness
 * planner runs a coding agent, so the only models it can serve are that
 * agent's own — offering it the cross-provider vendor catalog would list
 * models it cannot run. This is the third of the three places `isCliProvider`
 * guards.
 */
function plannerModelItems(state: TuiState): PickerItem[] {
  const runner = runnerForProvider(state.plannerProvider as AiProvider);
  if (!runner) return state.orchestratorModels.map((m) => ({ id: m.id, label: m.label, detail: modelDetail(m) }));

  const items = state.models
    .filter((m) => m.runners?.includes(runner))
    .map((m) => ({
      id: m.id,
      label: m.label,
      detail: [
        m.provider,
        m.variants?.length ? `${m.variants.length} effort level${m.variants.length === 1 ? '' : 's'}` : 'runner default effort',
      ].filter(Boolean).join(' · '),
      selected: m.id === state.orchestratorModel,
    }));
  // An empty catalog means discovery hasn't landed (or failed); a blank picker
  // with no explanation reads as a broken command.
  return items.length > 0
    ? items
    : [{ id: '', label: `No ${runner} models discovered yet`, detail: 'run /refresh', disabled: true }];
}

/** The variants of the model the harness planner is set to, plus the agent's own default. */
function plannerEffortItems(state: TuiState): PickerItem[] {
  const runner = runnerForProvider(state.plannerProvider as AiProvider);
  if (!runner) {
    return [{ id: '', label: 'Thinking effort applies to a coding-agent planner', detail: 'switch with /planner', disabled: true }];
  }
  const model = state.models.find((m) => m.id === state.orchestratorModel && m.runners?.includes(runner));
  if (!model) {
    return [{ id: '', label: 'No planner model selected', detail: 'pick one with /model', disabled: true }];
  }
  const variants = model.variants ?? [];
  if (variants.length === 0) {
    return [{ id: '', label: `${model.label} exposes no effort levels`, detail: "it always runs at the agent's default", disabled: true }];
  }
  return [
    { id: DEFAULT_EFFORT, label: 'Runner default', detail: 'Let the agent choose', selected: !state.plannerEffort },
    ...variants.map((v) => ({ id: v.id, label: v.label, selected: v.id === state.plannerEffort })),
  ];
}

function pickerItemsFor(state: TuiState, action: PickerState['action']): PickerItem[] {
  if (action.kind === 'set-model') {
    return plannerModelItems(state);
  }
  if (action.kind === 'set-planner') {
    return plannerItems(state);
  }
  if (action.kind === 'set-planner-effort') {
    return plannerEffortItems(state);
  }
  if (action.kind === 'load-session' || action.kind === 'delete-session') {
    return state.sessions.map((s) => ({
      id: s.id,
      label: s.goal || s.id,
      detail: `${s.taskCount} tasks · ${s.status}`,
    }));
  }
  if (action.kind === 'set-allowlist') {
    return modelsForRunner(state.models, action.runner).map((m) => ({
      id: m.id,
      label: m.label,
      detail: [m.provider, m.pricing].filter(Boolean).join(' · ') || undefined,
    }));
  }
  if (action.kind === 'set-runners') {
    return state.runners.map((runner) => ({ id: runner.id, label: runner.name }));
  }
  if (action.kind === 'set-task-runner') {
    const task = findTask(state.tasks, action.taskId);
    if (!task) return [];
    return state.runners.map((runner) => ({
      id: runner.id,
      label: runner.name,
      detail: runner.enabled ? undefined : 'not enabled for planning',
      selected: runner.id === task.assignedRunner,
    }));
  }
  if (action.kind === 'set-task-deps') {
    return dependencyCandidates(state.tasks, action.taskId).map((candidate) => ({
      id: candidate.id,
      label: `#${candidate.order} ${candidate.title}`,
      detail: candidate.status === 'completed' ? 'already completed' : undefined,
    }));
  }
  if (action.kind === 'set-task-mode') {
    const task = findTask(state.tasks, action.taskId);
    if (!task) return [];
    return modesForTask(state.modesByRunner, task).map((mode) => ({
      id: mode.id,
      label: mode.label,
      detail: mode.description,
      selected: mode.id === task.taskMode,
    }));
  }
  if (action.kind === 'set-task-model') {
    const task = findTask(state.tasks, action.taskId);
    if (!task) return [];
    const items = modelsForTask(state.models, task).map((model) => ({
      id: model.id,
      label: model.label,
      detail: [
        model.provider,
        model.variants?.length ? `${model.variants.length} effort level${model.variants.length === 1 ? '' : 's'}` : 'runner default effort',
      ].filter(Boolean).join(' · '),
      selected: model.id === task.assignedModel?.modelId,
    }));
    // An empty catalog means discovery hasn't landed for this runner (or
    // failed) — a blank picker with no explanation reads as a broken command.
    return items.length > 0
      ? items
      : [{ id: '', label: `No ${task.assignedRunner ?? 'runner'} models discovered yet`, detail: 'run /refresh', disabled: true }];
  }
  if (action.kind === 'set-task-effort') {
    const task = findTask(state.tasks, action.taskId);
    if (!task) return [];
    const current = task.assignedModel?.thinkingEffort;
    return [
      { id: DEFAULT_EFFORT, label: 'Runner default', detail: 'Let the executor choose', selected: !current },
      ...effortsForTask(state.models, task).map((variant) => ({
        id: variant.id,
        label: variant.label,
        selected: variant.id === current,
      })),
    ];
  }
  return [];
}

// ── Scrolling ────────────────────────────────────────────────────────────────
//
// Wheel, page keys and the help sheet's arrows all move one of three offsets,
// and each one is clamped here — where it is written — against the pane's real
// extent as `layout.ts` measures it.
//
// Clamping only in the renderer is what made the panes read as frozen: the
// offset kept growing past the end of the content while the view stayed put, so
// every notch back the other way was absorbed silently until the counter fell
// under the bound again. An offset that can never exceed what is scrollable has
// no dead zone in either direction.

const WHEEL_NOTCH = 3;

/** One page, less a line of overlap so the reader keeps their place across the jump. */
function pageNotch(viewport: number): number {
  return Math.max(1, viewport - 1);
}

/**
 * Lines a scroll key moves, positive being *back* through the content, or
 * `null` when it is not a scroll key. The viewport is measured only for the
 * page keys — every other keystroke in the chat pane comes through here on its
 * way to the editor.
 */
function scrollDelta(key: Key, state: TuiState): number | null {
  if (key.name === 'scrollup') return WHEEL_NOTCH;
  if (key.name === 'scrolldown') return -WHEEL_NOTCH;
  if (key.name === 'pageup') return pageNotch(bodyRows(state));
  if (key.name === 'pagedown') return -pageNotch(bodyRows(state));
  return null;
}

const isWheel = (key: Key): boolean => key.name === 'scrollup' || key.name === 'scrolldown';

/**
 * The pane a mouse report belongs to — a wheel notch or the press that starts a
 * drag: the one the pointer is over, falling back to the focused one when there
 * is no plan pane or the report carried no coordinates.
 *
 * Focus-based routing is what made one pane read as frozen — hovering the task
 * list while typing in the chat scrolled the chat, so the list under the
 * pointer never moved. The keyboard's page keys keep following focus, because
 * the keyboard has no pointer to ask.
 *
 * The divider counts as the plan side: a one-column dead strip between two
 * scrollable panes is a bug the user would experience as the wheel randomly
 * failing, and a press landing on it as a selection that refuses to start.
 */
function pointerPane(state: TuiState, key: Key): Focus {
  if (key.col === undefined || planPaneWidth(state) === 0) return state.focus;
  return key.col <= chatPaneWidth(state) ? 'chat' : 'plan';
}

function scrollPointed(state: TuiState, key: Key): Step {
  const delta = key.name === 'scrollup' ? WHEEL_NOTCH : -WHEEL_NOTCH;
  return pointerPane(state, key) === 'plan' ? scrollPlan(state, delta) : scrollChat(state, delta);
}

// ── Selection ────────────────────────────────────────────────────────────────

const isMouseSelect = (key: Key): boolean =>
  key.name === 'mousedown' || key.name === 'mousedrag' || key.name === 'mouseup';

/**
 * Where a mouse report lands *within a pane*: the reported cell, with its
 * column pulled back inside that pane's span. This is what stops a drag that
 * wandered across the divider from selecting the neighbour — it extends down
 * the origin pane instead, which is the only way a copied line can be one
 * pane's text rather than a splice of both.
 */
function selectionCell(state: TuiState, pane: Focus, key: Key): Cell {
  const { first, last } = paneColumns(state, pane);
  return {
    col: clampRange(key.col ?? first, first, last),
    row: clampRange(key.row ?? 1, 1, state.rows),
  };
}

function clampRange(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Whether the drag never left the cell it started in — a click, not a range. */
const isClick = (selection: Selection): boolean =>
  selection.anchor.col === selection.head.col && selection.anchor.row === selection.head.row;

function handleMouseSelect(state: TuiState, key: Key): Step {
  if (key.name === 'mousedown') {
    // The pane is decided once, here, and carried for the whole drag —
    // `pointerPane` is the same aim the wheel uses, divider fallback included.
    const pane = pointerPane(state, key);
    const cell = selectionCell(state, pane, key);
    return step({ ...state, selection: { anchor: cell, head: cell, pane } });
  }

  const { selection } = state;
  // A drag or release with nothing anchored is a report from before this app
  // owned the mouse (a tmux reattach mid-drag), not the tail of a selection.
  if (!selection) return step(state);

  const moved = { ...selection, head: selectionCell(state, selection.pane, key) };
  if (key.name === 'mousedrag') return step({ ...state, selection: moved });

  // A click with no movement is how the user dismisses a selection; treating it
  // as a zero-width range would leave the old highlight up and copy nothing.
  if (isClick(moved)) return step({ ...state, selection: null });
  return step({ ...state, selection: null }, [{ type: 'copyText', text: selectedText({ ...state, selection: moved }) }]);
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

function scrollChat(state: TuiState, delta: number): Step {
  return step({ ...state, scroll: clamp(state.scroll + delta, chatScrollMax(state)) });
}

/**
 * The plan pane's offset is absolute, so the first manual notch takes over from
 * follow mode exactly where the view already is — otherwise the pane would jump
 * to the top of the plan the moment the user touched the wheel.
 */
function scrollPlan(state: TuiState, delta: number): Step {
  const { followOffset, maxScroll } = planScrollExtent(state);
  const from = state.planScroll ?? followOffset;
  return step({ ...state, planScroll: clamp(from - delta, maxScroll) });
}

/** A planner turn the user can still call off — research rounds included. */
const plannerInFlight = (state: TuiState): boolean =>
  state.status === 'planning' || state.status === 'researching';

/**
 * Call off the turn. An approval prompt on screen goes with it, queue and all:
 * the daemon denies every outstanding request as it aborts, so leaving the
 * modal up would ask the user to answer for a turn that no longer exists.
 */
function stopPlanning(state: TuiState, sessionId: string): Step {
  const dismissed = state.overlay?.kind === 'approval'
    ? { ...state, overlay: null, pendingApprovals: [] }
    : state;
  return step(dismissed, [{ type: 'cancelPlanning', sessionId }]);
}

/**
 * Key routing, outermost first: global quit keys, then whatever overlay is
 * open, then the focused pane. Only the chat pane feeds the line editor, so
 * plan-pane shortcuts and picker filters never leak into the prompt.
 */
function handleKey(state: TuiState, key: Key): Step {
  if (key.name === 'ctrl-c') return interrupt(state);
  if (key.name === 'ctrl-d' && !state.editor.text && !state.overlay) {
    return step({ ...state, exiting: true }, [{ type: 'exit' }]);
  }
  if (key.name === 'ctrl-l') return step({ ...state, messages: [] });

  // A first ESC stops the planner rather than doing whatever ESC does today —
  // that behavior is still one ESC away, once the turn is no longer in flight.
  // This sits *above* overlay routing for the approval prompt only: ESC there
  // would otherwise deny one tool call, which the planner answers by issuing
  // the next one. A user pressing ESC mid-research wants the turn dead, not a
  // single refusal. Every other overlay (help, pickers, confirm, task editor)
  // keeps its own ESC — those are things the user opened and can close.
  if (key.name === 'escape' && plannerInFlight(state) && state.sessionId
      && (!state.overlay || state.overlay.kind === 'approval')) {
    return stopPlanning(state, state.sessionId);
  }
  if (state.overlay) return handleOverlayKey(state, state.overlay, key);
  // Above the focus split, because a wheel notch is aimed, not focused. A drag
  // is aimed too, and for the same reason it never reaches the line editor or
  // the plan pane's letter shortcuts below.
  if (isWheel(key)) return scrollPointed(state, key);
  if (isMouseSelect(key)) return handleMouseSelect(state, key);
  if (key.name === 'wheelignored') return step(state);
  if (key.name === 'tab' && state.focus === 'chat') {
    const matches = completions(state.editor.text);
    if (matches.length > 0) {
      const text = `/${matches[0].name} `;
      return step({ ...state, editor: { ...state.editor, text, cursor: text.length } });
    }
  }
  if (key.name === 'tab') return step({ ...state, focus: state.focus === 'chat' ? 'plan' : 'chat' });
  if (state.focus === 'plan') return handlePlanKey(state, key);

  if (key.name === 'enter') return submit(state);
  if (key.name === 'escape') return step({ ...state, editor: { ...state.editor, text: '', cursor: 0 } });
  // Page keys and the wheel scroll the transcript. Up/down always go to the
  // editor: single-line drafts get history recall, multi-line drafts get cursor
  // movement between wrapped lines.
  const scroll = scrollDelta(key, state);
  if (scroll !== null) return scrollChat(state, scroll);

  const multilineEditor = state.editor.text.includes('\n');
  // Keys only reach the editor while it has focus, which is exactly when the
  // renderer reserves the caret column.
  const room = chatEditorRoom(state.cols, true);
  return step({ ...state, editor: applyKey(state.editor, key, multilineEditor ? room : undefined) });
}

/** Ctrl-C backs out one layer at a time; it only quits when there is nothing to back out of. */
function interrupt(state: TuiState): Step {
  if (state.overlay) return step({ ...state, overlay: null });
  if (state.editor.text) return step({ ...state, editor: { ...state.editor, text: '', cursor: 0 } });
  return step({ ...state, exiting: true }, [{ type: 'exit' }]);
}

// ── Plan pane ────────────────────────────────────────────────────────────────

const PLAN_SHORTCUTS: Record<string, TaskAction> = {
  c: 'cancel',
  f: 'force-start',
  s: 'skip',
};

/** Task actions that spawn a runner, so the pane only learns their fate from the execution stream. */
const SPAWNS_RUNNER: TaskAction[] = ['force-start', 'retry'];

/**
 * A spawn's progress reaches the TUI over the session's execution stream, and
 * nothing else opens one: without it a force-started task sat frozen on its
 * first spinner frame and never settled. A plan run already holds that stream,
 * so a second subscription would report the run finishing twice.
 */
function taskActionEffect(state: TuiState, sessionId: string, taskId: string, action: TaskAction): Effect {
  const watch = SPAWNS_RUNNER.includes(action) && state.status !== 'executing';
  return watch
    ? { type: 'taskAction', sessionId, taskId, action, watch: true }
    : { type: 'taskAction', sessionId, taskId, action };
}

/**
 * `m` is one key in both directions: a done task un-marks, anything else marks.
 * A second key for the reverse of a toggle is a key nobody remembers.
 */
export function markAction(task: { status: string }): TaskAction {
  return task.status === 'completed' ? 'uncomplete' : 'complete';
}

function handlePlanKey(state: TuiState, key: Key): Step {
  // While a task's prompt editor is open, every key edits its draft instead of
  // moving the list cursor — otherwise up/down would collapse it out from
  // under the caret. `findTask` walks subtasks too: the editor opens on a
  // subtask as often as a top-level task.
  const editingTask = state.expandedTaskId ? findTask(state.tasks, state.expandedTaskId) : undefined;
  if (editingTask && state.taskEditor) return handleTaskEditKey(state, editingTask, state.taskEditor, key);

  // Expanded without an open editor: the cursor is browsing a parent's
  // revealed subtask rows. Escape backs out of that one step at a time,
  // rather than leaving the plan pane entirely.
  if (key.name === 'escape') {
    if (state.expandedTaskId) return step({ ...state, expandedTaskId: null, planScroll: null });
    return step({ ...state, focus: 'chat' });
  }
  // Moving the selection hands the viewport back to follow mode: the user is
  // navigating the list again, so the pane should chase the cursor. The cursor
  // walks the visible rows, subtasks included, and an expanded parent stays
  // open so its rows do not vanish under the step.
  if (key.name === 'up') {
    return step({ ...state, selectedTask: Math.max(0, state.selectedTask - 1), planScroll: null });
  }
  if (key.name === 'down') {
    return step({
      ...state,
      selectedTask: Math.min(planRows(state).length - 1, state.selectedTask + 1),
      planScroll: null,
    });
  }

  // pageup/pagedown only — a wheel notch is routed by the pointer well above
  // this, and never reaches the focused pane's handler.
  const scroll = scrollDelta(key, state);
  if (scroll !== null) return scrollPlan(state, scroll);

  const row = selectedPlanRow(state);
  if (!row) return step(state);
  const task = row.task;
  if (key.name === 'enter' || key.name === 'right') {
    // A parent's first enter only reveals its subtask rows — jumping straight
    // to the editor would trap the cursor before it ever reaches them. Enter
    // again on the still-selected parent, or on any row without subtasks,
    // opens the editor as before.
    const hasSubtasks = (task.subtasks?.length ?? 0) > 0;
    if (hasSubtasks && state.expandedTaskId !== task.id) {
      return step({ ...state, expandedTaskId: task.id, taskEditor: null, planScroll: null });
    }
    const text = task.prompt ?? task.description ?? task.title;
    return step({
      ...state,
      expandedTaskId: task.id,
      taskEditor: { ...emptyEditor(), text, cursor: text.length },
    });
  }
  if (!state.sessionId || key.name !== 'char') return step(state);

  // `E` is the plan pane's equivalent of /run: it starts the whole plan, not
  // the selected task, hence the uppercase.
  if (key.char === 'E') return step(state, [{ type: 'execute', sessionId: state.sessionId }]);

  const action = key.char === 'm' ? markAction(task) : PLAN_SHORTCUTS[key.char ?? ''];
  if (action) {
    return step(state, [taskActionEffect(state, state.sessionId, task.id, action)]);
  }
  if (key.char === 'd') return confirmRemoveTask(state, task);
  if (key.char === 'a') return addTask(state, '');
  if (key.char === 't') {
    return step(state, [{ type: 'openTaskTerminal', sessionId: state.sessionId, taskId: task.id }]);
  }
  if (key.char === 'R') return openTaskRunnerPicker(state, task);
  if (key.char === 'o') return openTaskModelPicker(state, task);
  if (key.char === 'e') return openTaskEffortPicker(state, task);
  if (key.char === 'M') return openTaskModePicker(state, task);
  if (key.char === 'D') return openTaskDepsPicker(state, task);
  return step(state);
}

/** Enter commits the prompt edit and collapses; escape discards it and collapses. */
function handleTaskEditKey(state: TuiState, task: TaskView, editor: EditorState, key: Key): Step {
  if (key.name === 'enter') return commitTaskEdit(state, task, editor);
  if (key.name === 'escape') return step({ ...state, expandedTaskId: null, taskEditor: null });
  // The page keys still scroll the pane rather than move through the text,
  // same as when nothing is expanded.
  const scroll = scrollDelta(key, state);
  if (scroll !== null) return scrollPlan(state, scroll);
  return step({ ...state, taskEditor: applyKey(editor, key, taskEditorRoom(state)) });
}

function commitTaskEdit(state: TuiState, task: TaskView, editor: EditorState): Step {
  const collapsed = { ...state, expandedTaskId: null, taskEditor: null };
  const prompt = editor.text.trim();
  const original = task.prompt ?? task.description ?? task.title;
  if (!prompt || prompt === original || !state.sessionId) return step(collapsed);
  return step(collapsed, [{
    type: 'updateTask',
    sessionId: state.sessionId,
    taskId: task.id,
    changes: { prompt },
    message: `Task #${task.order} prompt updated.`,
  }]);
}

// ── Overlays ─────────────────────────────────────────────────────────────────

/**
 * Queue rather than stack: the planner blocks on each request, so showing them
 * one at a time keeps the modal honest about what is actually waiting. The open
 * modal is itself the head of the queue, hence the id check against both.
 */
function enqueueApproval(state: TuiState, request: ApprovalRequestView): TuiState {
  const open = state.overlay?.kind === 'approval' ? state.overlay.request : null;
  if (open?.id === request.id) return state;
  if (state.pendingApprovals.some((p) => p.id === request.id)) return state;
  if (open) return { ...state, pendingApprovals: [...state.pendingApprovals, request] };
  return { ...state, overlay: { kind: 'approval', request } };
}

/** Retire a request answered elsewhere (another surface, or the planner's timeout). */
function dropApproval(state: TuiState, approvalId: string): TuiState {
  const pending = state.pendingApprovals.filter((p) => p.id !== approvalId);
  const open = state.overlay?.kind === 'approval' ? state.overlay.request : null;
  if (open?.id !== approvalId) return { ...state, pendingApprovals: pending };
  return showNextApproval({ ...state, pendingApprovals: pending, overlay: null });
}

function showNextApproval(state: TuiState): TuiState {
  const [next, ...rest] = state.pendingApprovals;
  if (!next) return { ...state, overlay: null };
  return { ...state, overlay: { kind: 'approval', request: next }, pendingApprovals: rest };
}

function handleApprovalKey(
  state: TuiState,
  overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'approval' }>,
  key: Key,
): Step {
  const grant = key.name === 'enter' || key.char === 'y' || key.char === 'Y';
  const deny = key.name === 'escape' || key.char === 'n' || key.char === 'N';
  // Anything else is left alone: a stray keypress must not answer for the user.
  if (!grant && !deny) return step(state);

  const { request } = overlay;
  const verdict = grant ? 'approved' : 'denied';
  const noted = say(showNextApproval({ ...state, overlay: null }), 'system', `Approval ${verdict}: ${request.subject}`);

  return step(noted, state.sessionId
    ? [{ type: 'respondApproval', sessionId: state.sessionId, approvalId: request.id, granted: grant }]
    : []);
}

function handleOverlayKey(state: TuiState, overlay: NonNullable<TuiState['overlay']>, key: Key): Step {
  if (overlay.kind === 'help') return handleHelpKey(state, overlay.scroll ?? 0, key);
  // A sideways notch is not a keystroke, and every overlay below reads an
  // unhandled key as a cue to close or to hold still.
  if (key.name === 'wheelignored') return step(state);
  // The pickers turn a notch into selection movement, which is what scrolls
  // their list. Everything else here floats over the panes with nothing of its
  // own to scroll, so the notch belongs to the pane underneath rather than in
  // the bin — an approval prompt used to freeze both panes solid.
  if (isWheel(key) && overlay.kind !== 'picker') return scrollPointed(state, key);
  if (overlay.kind === 'approval') return handleApprovalKey(state, overlay, key);
  if (overlay.kind === 'confirm') return handleConfirmKey(state, overlay, key);
  if (key.name === 'escape') return step({ ...state, overlay: null });
  if (overlay.kind === 'prompt') return handlePromptKey(state, overlay, key);
  return handlePickerKey(state, overlay.picker, key);
}

function handleConfirmKey(
  state: TuiState,
  overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'confirm' }>,
  key: Key,
): Step {
  if (key.name === 'escape') return step({ ...state, overlay: null });
  if (key.name !== 'enter') return step(state);
  const closed = { ...state, overlay: null };
  if (overlay.action.kind === 'new-session') return newSession(closed);
  if (overlay.action.kind === 'remove-task') {
    if (!state.sessionId) return step(closed);
    return step(closed, [{ type: 'removeTask', sessionId: state.sessionId, taskId: overlay.action.taskId }]);
  }
  if (overlay.action.kind === 'init-workspace') {
    return step({ ...closed, status: 'planning' }, [{ type: 'startConversation', goal: overlay.action.goal, allowInit: true }]);
  }
  return step(closed);
}

/**
 * The sheet is taller than most terminals, so it scrolls; anything else closes
 * it. The offsets here run the other way to the panes' — the sheet is
 * top-anchored, so a positive delta moves *down* it.
 */
function handleHelpKey(state: TuiState, scroll: number, key: Key): Step {
  const page = pageNotch(bodyRows(state));
  const move: Record<string, number> = {
    down: 1,
    up: -1,
    pagedown: page,
    pageup: -page,
    scrolldown: WHEEL_NOTCH,
    scrollup: -WHEEL_NOTCH,
  };
  const delta = move[key.name];
  if (delta === undefined) return step({ ...state, overlay: null });
  return step({ ...state, overlay: { kind: 'help', scroll: clamp(scroll + delta, helpScrollMax(state)) } });
}

function handlePromptKey(
  state: TuiState,
  overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'prompt' }>,
  key: Key,
): Step {
  if (key.name === 'enter') {
    const value = overlay.value.trim();
    const closed = { ...state, overlay: null };
    if (!value) return step(closed);

    if (overlay.action.kind === 'api-key') {
      return step(closed, [{ type: 'setApiKey', provider: overlay.action.provider, key: value }]);
    }
    if (!state.sessionId) return fail(closed, 'No active plan to add a task to.');
    return step(closed, [{ type: 'addTask', sessionId: state.sessionId, title: value }]);
  }

  const value = editText(overlay.value, key);
  return step({ ...state, overlay: { ...overlay, value } });
}

/** The picker filter and the prompt field are single-line fields with no cursor. */
function editText(value: string, key: Key): string {
  if (key.name === 'char') return value + (key.char ?? '');
  // Single-line fields flatten a paste's newlines; a copied API key often
  // drags a trailing newline along, and it must not act as enter here either.
  if (key.name === 'paste') return value + (key.text ?? '').replace(/\n/g, ' ');
  if (key.name === 'backspace') return value.slice(0, -1);
  if (key.name === 'ctrl-u') return '';
  return value;
}

function handlePickerKey(state: TuiState, picker: PickerState, key: Key): Step {
  const items = visibleItems(picker);
  const reopen = (next: PickerState): Step => step({ ...state, overlay: { kind: 'picker', picker: next } });

  if (key.name === 'up' || key.name === 'scrollup') return reopen({ ...picker, index: Math.max(0, picker.index - 1) });
  if (key.name === 'down' || key.name === 'scrolldown') {
    return reopen({ ...picker, index: Math.min(items.length - 1, picker.index + 1) });
  }

  // Space toggles membership in a multi-select; elsewhere it is filter text.
  if (picker.multi && key.name === 'char' && key.char === ' ') {
    const item = items[picker.index];
    if (!item) return reopen(picker);
    const chosen = picker.chosen.includes(item.id)
      ? picker.chosen.filter((id) => id !== item.id)
      : [...picker.chosen, item.id];
    return reopen({ ...picker, chosen });
  }

  if (key.name === 'enter') return choose(state, picker, items[picker.index]);

  const filter = editText(picker.filter, key);
  if (filter === picker.filter) return reopen(picker);
  return reopen({ ...picker, filter, index: 0 });
}

function choose(state: TuiState, picker: PickerState, item: PickerItem | undefined): Step {
  const closed: TuiState = { ...state, overlay: null };

  if (picker.action.kind === 'set-allowlist') {
    return step(closed, [{ type: 'setAllowlist', runner: picker.action.runner, modelIds: picker.chosen }]);
  }
  // Multi-select pickers commit `chosen` on enter, so they resolve before the
  // "nothing highlighted" guard: clearing every dependency is a real edit.
  if (picker.action.kind === 'set-runners') {
    const changes = state.runners
      .filter((runner) => runner.enabled !== picker.chosen.includes(runner.id))
      .map((runner) => ({ runner: runner.id, enabled: !runner.enabled }));
    if (changes.length === 0) return step(closed);
    const names = state.runners.filter((r) => picker.chosen.includes(r.id)).map((r) => r.name);
    return step(closed, [{
      type: 'setRunners',
      changes,
      message: names.length > 0
        ? `Runners enabled: ${names.join(', ')}.`
        : 'No runners enabled — the planner has nothing to assign work to.',
    }]);
  }
  if (picker.action.kind === 'set-task-deps') {
    const taskId = picker.action.taskId;
    const task = findTask(state.tasks, taskId);
    if (!task || !state.sessionId) return step(closed);
    return step(closed, [{
      type: 'updateTask',
      sessionId: state.sessionId,
      taskId: task.id,
      changes: { dependencies: picker.chosen },
      message: picker.chosen.length > 0
        ? `Task #${task.order} now depends on ${picker.chosen.length} task${picker.chosen.length === 1 ? '' : 's'}.`
        : `Task #${task.order} no longer depends on anything.`,
    }]);
  }
  if (!item) return step(state);

  // Placeholder and unavailable rows are on screen to explain themselves, not
  // to be chosen. Keep the picker open so the reason stays readable.
  if (item.disabled) {
    return step(say(state, 'error', item.detail ? `${item.label} — ${item.detail}` : `${item.label} is not available.`));
  }

  switch (picker.action.kind) {
    case 'set-model':
      return step(closed, [{ type: 'setModel', modelId: item.id }]);

    case 'set-planner':
      // The daemon decides what the new backend's model should become — its
      // own remembered choice, that backend's catalog default, or nothing —
      // and the effect that runs this consumes whatever it returns.
      return step(closed, [{ type: 'setPlanner', provider: item.id }]);
    case 'set-planner-effort':
      return step(closed, [{ type: 'setPlannerEffort', effort: item.id === DEFAULT_EFFORT ? '' : item.id }]);

    case 'load-session':
      return step(closed, [{ type: 'loadSession', sessionId: item.id }]);
    case 'delete-session':
      return step(closed, [{ type: 'deleteSession', sessionId: item.id }]);
    case 'set-key':
      return step({ ...state, overlay: keyPrompt(item.id as AiProvider) });
    case 'choose-allowlist-runner': {
      const action = { kind: 'set-allowlist' as const, runner: item.id };
      const items = pickerItemsFor(state, action);
      // An empty catalog is not an empty allowlist. Confirming a picker with no
      // rows would store `[]` — "no restriction" — so refuse to open it rather
      // than let a cold discovery quietly lift the user's limit.
      if (items.length === 0) {
        return step(say(state, 'error', `No models discovered for ${item.label}. Run /refresh, then try again.`));
      }
      return step({
        ...state,
        overlay: {
          kind: 'picker',
          picker: {
            title: `Models allowed for ${item.label}`,
            hint: 'An empty selection lifts the restriction.',
            items,
            filter: '',
            index: 0,
            multi: true,
            // Ids this runner doesn't serve can be sitting in a settings file
            // written before the list was scoped; dropping them here means
            // confirming the picker also repairs the stored allowlist.
            chosen: (state.allowlist[item.id] ?? []).filter((id) => items.some((i) => i.id === id)),
            action,
          },
        },
      });
    }
    case 'set-task-runner': {
      const taskId = picker.action.taskId;
      const task = findTask(state.tasks, taskId);
      if (!task || !state.sessionId) return step(closed);
      return assignTaskRunner(closed, state.sessionId, task, item.id, item.label);
    }
    case 'set-task-mode': {
      const taskId = picker.action.taskId;
      const task = findTask(state.tasks, taskId);
      if (!task || !state.sessionId) return step(closed);
      return assignTaskMode(closed, state.sessionId, task, item.id, item.label);
    }
    case 'set-task-model': {
      const taskId = picker.action.taskId;
      const task = findTask(state.tasks, taskId);
      const model = state.models.find((candidate) => candidate.id === item.id);
      if (!task || !model || !state.sessionId) return step(closed);
      return assignTaskModel(closed, state.sessionId, task, model);
    }
    case 'set-task-effort': {
      const taskId = picker.action.taskId;
      const task = findTask(state.tasks, taskId);
      if (!task || !state.sessionId) return step(closed);
      return assignTaskEffort(closed, state.sessionId, task, item.id === DEFAULT_EFFORT ? undefined : item.id);
    }
  }
}

function submit(state: TuiState): Step {
  const text = state.editor.text.trim();
  if (!text) return step(state);

  const cleared: TuiState = { ...state, editor: commit(state.editor) };
  const command = parseSlash(text);
  // A skill-backed command is not dispatched here: it goes to the planner like
  // any other message, literal /name and all, so the daemon's own skill
  // interception (see resolveSkillInvocation) substitutes it before a
  // coding-agent planner ever sees the token and tries to resolve it itself.
  if (command && findCommand(command.name)?.source !== 'skill') return runCommand(cleared, command);

  const spoken = say(cleared, 'user', text);
  const effect: Effect = state.sessionId
    ? { type: 'sendMessage', sessionId: state.sessionId, message: text }
    : { type: 'startConversation', goal: text };

  return step({ ...spoken, status: 'planning' }, [effect]);
}

// ── Slash commands ───────────────────────────────────────────────────────────

function runCommand(state: TuiState, { name, args }: ParsedCommand): Step {
  if (!findCommand(name)) {
    return fail(state, `Unknown command: /${name} — type /help to see what's available.`);
  }

  if ((SKILL_IDS as readonly string[]).includes(name)) {
    return toggleSkill(state, name as SkillId, args[0]);
  }

  switch (name) {
    case 'help':
      return step({ ...state, overlay: { kind: 'help', scroll: 0 } });
    case 'quit':
      return step({ ...state, exiting: true }, [{ type: 'exit' }]);
    case 'refresh':
      return step(state, [{ type: 'refresh' }]);

    case 'run':
      return withSession(state, (sessionId) => step(state, [{ type: 'execute', sessionId }]));
    case 'approve':
      return withSession(state, (sessionId) =>
        step({ ...state, planApproved: true }, [{ type: 'execute', sessionId }]),
      );
    case 'stop':
      // Whichever is actually in flight — a planning turn and a task run never
      // overlap, so this is never ambiguous about which one to halt.
      return withSession(state, (sessionId) =>
        step(state, [
          state.status === 'planning' || state.status === 'researching'
            ? { type: 'cancelPlanning', sessionId }
            : { type: 'stopExecution', sessionId },
        ]),
      );

    case 'model':
      return setModel(state, args);
    case 'planner':
      return setPlanner(state, args);
    case 'planner-effort':
      return setPlannerEffort(state, args);
    case 'key':
      return setKey(state, args);
    case 'allowlist':
      return allowlist(state, args);
    case 'runners':
      return runners(state, args);
    case 'auto':
      return setAutonomous(state, args[0]);
    case 'mouse':
      return setMouseCapture(state, args[0]);

    case 'sessions':
      return step(
        { ...state, overlay: { kind: 'picker', picker: picker('Sessions', [], { kind: 'load-session' }) } },
        [{ type: 'loadSessions' }],
      );
    case 'new':
      return requestNewSession(state);
    case 'save':
      return withSession(state, (sessionId) => step(state, [{ type: 'saveSession', sessionId }]));
    case 'load':
      return args[0]
        ? step(state, [{ type: 'loadSession', sessionId: args[0] }])
        : fail(state, 'Usage: /load <session-id> — or run /sessions to pick one.');
    case 'delete':
      return args[0]
        ? step(state, [{ type: 'deleteSession', sessionId: args[0] }])
        : fail(state, 'Usage: /delete <session-id>');

    case 'add-task':
      return addTask(state, args.join(' '));
    case 'remove-task':
      return taskCommand(state, args[0], (sessionId, taskId) =>
        step(state, [{ type: 'removeTask', sessionId, taskId }]),
      );
    case 'terminal':
      return taskCommand(state, args[0], (sessionId, taskId) =>
        step(state, [{ type: 'openTaskTerminal', sessionId, taskId }]),
      );
    case 'task-runner':
      return taskRunnerCommand(state, args);
    case 'task-model':
      return taskModelCommand(state, args);
    case 'task-effort':
      return taskEffortCommand(state, args);
    case 'task-mode':
      return taskModeCommand(state, args);
    case 'task-deps':
      return taskCommand(state, args[0], (_sessionId, taskId) =>
        openTaskDepsPicker(state, findTask(state.tasks, taskId)!),
      );
    case 'complete':
    case 'uncomplete':
    case 'skip':
    case 'retry':
    case 'cancel':
    case 'force-start':
      return taskCommand(state, args[0], (sessionId, taskId) =>
        step(state, [taskActionEffect(state, sessionId, taskId, name as TaskAction)]),
      );
  }

  return fail(state, `/${name} is not wired up yet.`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function picker(
  title: string,
  items: PickerItem[],
  action: PickerState['action'],
  extra: Partial<PickerState> = {},
): PickerState {
  return { title, items, filter: '', index: 0, multi: false, chosen: [], action, ...extra };
}

/** Commands that only make sense once a plan exists. */
function withSession(state: TuiState, run: (sessionId: string) => Step): Step {
  if (!state.sessionId) {
    return fail(state, 'No active plan — describe a goal first, or load a session with /sessions.');
  }
  return run(state.sessionId);
}

/** `on`/`off` when given explicitly, otherwise the opposite of what is set now. */
function resolveToggle(arg: string | undefined, current: boolean): boolean | null {
  const value = arg?.toLowerCase();
  if (value === 'on') return true;
  if (value === 'off') return false;
  if (value === undefined) return !current;
  return null;
}

function toggleSkill(state: TuiState, skill: SkillId, arg: string | undefined): Step {
  const enabled = resolveToggle(arg, state.skills[skill]);
  if (enabled === null) return fail(state, `Usage: /${skill} [on|off]`);
  return step(state, [{ type: 'command', name: skill, action: enabled ? 'on' : 'off' }]);
}

// Only asks when there is something to lose; an empty/idle session resets
// silently. Mirrors the VS Code extension's confirm-before-reset.
function requestNewSession(state: TuiState): Step {
  const hasContent = state.tasks.length > 0 || state.messages.length > 0 || state.goal !== '' || state.status !== 'idle';
  if (!state.sessionId || !hasContent) return newSession(state);
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: 'Start a new session?',
      message: 'The current plan will be cleared and any running tasks stopped.',
      action: { kind: 'new-session' },
    },
  });
}

function newSession(state: TuiState): Step {
  // Without this, the outgoing session's execution stream stays open and its
  // task updates keep landing on whatever id matches in the fresh state below.
  const closeEffects: Effect[] = state.sessionId ? [{ type: 'closeSession', sessionId: state.sessionId }] : [];
  return step({
    ...state,
    sessionId: null,
    goal: '',
    tasks: [],
    planApproved: false,
    messages: [],
    selectedTask: 0,
    expandedTaskId: null,
    taskEditor: null,
    scroll: 0,
    status: 'idle',
    busyLabel: '',
    thinkingLine: '',
    // Prompts belong to the session that raised them; the old planner is gone
    // and its pending requests deny on their own timeout.
    pendingApprovals: [],
    overlay: state.overlay?.kind === 'approval' ? null : state.overlay,
  }, closeEffects);
}

function setModel(state: TuiState, args: string[]): Step {
  if (args[0] === 'set' && args[1]) {
    // A harness planner can only run its own agent's models (ADR-0009), so the
    // typed path gets the same scoping the picker does.
    const runner = runnerForProvider(state.plannerProvider as AiProvider);
    const known = runner ? modelsForRunner(state.models, runner) : [];
    if (runner && known.length > 0 && !known.some((m) => m.id === args[1])) {
      return fail(state, `${args[1]} was not discovered for ${runner}.`);
    }
    return step(state, [{ type: 'setModel', modelId: args[1] }]);
  }
  if (args.length > 0 && args[0] !== 'set') return fail(state, 'Usage: /model [set <model-id>]');

  const items = pickerItemsFor(state, { kind: 'set-model' });
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker('Orchestrator model', items, { kind: 'set-model' }, { hint: providerErrorHint(state) }),
      },
    },
    [{ type: 'loadModels' }],
  );
}

/**
 * Everything that can plan, in one list (ADR-0009).
 *
 * Coding agents come first: they need no API key, which makes them the answer
 * for the user who has just installed Ordewell and has no vendor account. An
 * agent whose CLI isn't on PATH is listed disabled with the reason rather than
 * hidden — discovering a missing CLI after typing a real goal is the failure
 * the preflight exists to prevent.
 */
function plannerItems(state: TuiState): PickerItem[] {
  const installed = new Set(state.runners.map((r) => r.id));

  const agents: PickerItem[] = CLI_PROVIDERS.map((id) => {
    const runner = runnerForProvider(id)!;
    const ready = installed.has(runner);
    return {
      id,
      label: ALL_PROVIDERS[id].label,
      detail: ready ? 'coding agent · no API key needed' : 'CLI not installed or not on PATH',
      selected: state.plannerProvider === id,
      disabled: !ready,
    };
  });

  const vendors: PickerItem[] = PROVIDER_PRIORITY
    .filter((id) => state.configuredProviders.includes(id))
    .map((id) => ({
      id,
      label: ALL_PROVIDERS[id].label,
      detail: ALL_PROVIDERS[id].apiKeyEnvVar,
      selected: state.plannerProvider === id,
    }));

  return vendors.length > 0
    ? [...agents, ...vendors]
    : [...agents, { id: '', label: 'No API providers configured', detail: 'add a key with /key', disabled: true }];
}

function setPlanner(state: TuiState, args: string[]): Step {
  if (args[0]) {
    const id = args[0].toLowerCase();
    if (!KNOWN_PROVIDERS.includes(id)) {
      return fail(state, `Unknown planner: ${id}. Run /planner with no arguments to see the list.`);
    }
    return step(state, [{ type: 'setPlanner', provider: id }]);
  }
  return step({
    ...state,
    overlay: {
      kind: 'picker',
      picker: picker('Planner', plannerItems(state), { kind: 'set-planner' }, {
        hint: 'Who researches your goal and writes the plan. Coding agents use their own subscription — no API key.',
      }),
    },
  });
}

function setPlannerEffort(state: TuiState, args: string[]): Step {
  const items = plannerEffortItems(state);
  if (args[0]) {
    const wanted = args[0].toLowerCase();
    const match = items.find((i) => !i.disabled && (i.id === wanted || (wanted === 'default' && i.id === DEFAULT_EFFORT)));
    if (!match) {
      const available = items.filter((i) => !i.disabled && i.id !== DEFAULT_EFFORT).map((i) => i.id);
      return fail(state, available.length > 0
        ? `Unknown effort: ${args[0]}. Available: ${available.join(', ')}, default.`
        : (items[0]?.label ?? 'No effort levels available.'));
    }
    return step(state, [{ type: 'setPlannerEffort', effort: match.id === DEFAULT_EFFORT ? '' : match.id }]);
  }
  return step({
    ...state,
    overlay: {
      kind: 'picker',
      picker: picker('Planner thinking effort', items, { kind: 'set-planner-effort' }, {
        hint: "How hard the planning agent thinks per turn. Higher costs latency and tokens against your subscription.",
      }),
    },
  });
}

function setKey(state: TuiState, args: string[]): Step {
  if (args[0] === 'set' && args[1]) {
    const provider = args[1].toLowerCase();
    if (!KNOWN_PROVIDERS.includes(provider)) {
      return fail(state, `Unknown provider: ${provider}. Run /key with no arguments to see the list.`);
    }
    if (!args[2]) {
      return step({
        ...state,
        overlay: keyPrompt(provider as AiProvider),
      });
    }
    return step(state, [{ type: 'setApiKey', provider, key: args.slice(2).join(' ') }]);
  }

  const items: PickerItem[] = PROVIDER_PRIORITY.map((id) => ({
    id,
    label: ALL_PROVIDERS[id].label,
    detail: ALL_PROVIDERS[id].apiKeyEnvVar,
    selected: state.configuredProviders.includes(id),
  }));
  return step({ ...state, overlay: { kind: 'picker', picker: picker('API provider key', items, { kind: 'set-key' }) } });
}

function keyPrompt(provider: AiProvider): TuiState['overlay'] {
  const meta = ALL_PROVIDERS[provider];
  return {
    kind: 'prompt',
    title: `${meta.label} API key`,
    hint: `Stored as ${meta.apiKeyEnvVar} in your .env`,
    value: '',
    action: { kind: 'api-key', provider, envVar: meta.apiKeyEnvVar },
  };
}

function allowlist(state: TuiState, args: string[]): Step {
  const [sub, runner, ...rest] = args;

  if (sub === 'set') {
    if (!runner || rest.length === 0) return fail(state, 'Usage: /allowlist set <runner> <id1,id2,…>');
    if (state.runners.length > 0 && !state.runners.some((r) => r.id === runner)) {
      return fail(state, `Unknown runner "${runner}".`);
    }
    const modelIds = rest.join(' ').split(',').map((s) => s.trim()).filter(Boolean);
    if (modelIds.length === 0) return fail(state, 'Usage: /allowlist set <runner> <id1,id2,…>');
    // Same rule the picker enforces, for the typed path: an id this runner was
    // never discovered with cannot be spawned, so refuse rather than persist it.
    // Skipped when nothing is discovered yet — that says nothing about the ids.
    const known = modelsForRunner(state.models, runner);
    if (state.models.length > 0 && known.length > 0) {
      const stray = modelIds.filter((id) => !known.some((m) => m.id === id));
      if (stray.length > 0) {
        return fail(state, `Not discovered for ${runner}: ${stray.join(', ')}.`);
      }
    }
    return step(state, [{ type: 'setAllowlist', runner, modelIds }]);
  }

  if (sub === 'clear') {
    if (!runner) return fail(state, 'Usage: /allowlist clear <runner>');
    return step(state, [{ type: 'setAllowlist', runner, modelIds: [] }]);
  }

  if (sub === 'show' || sub === undefined) {
    const items: PickerItem[] = state.runners.map((r) => ({
      id: r.id,
      label: r.name,
      detail: describeAllowlist(state.allowlist[r.id]),
    }));
    return step(
      {
        ...state,
        overlay: {
          kind: 'picker',
          picker: picker('Limit models for which runner?', items, { kind: 'choose-allowlist-runner' }),
        },
      },
      // The model list the next picker is built from must be the runner's real
      // one; refresh it while the user is still choosing a runner.
      [{ type: 'loadModels' }],
    );
  }

  return fail(state, 'Usage: /allowlist [set <runner> <ids> | clear <runner>]');
}

function describeAllowlist(ids: string[] | undefined): string {
  if (!ids || ids.length === 0) return 'no restriction';
  return `${ids.length} model${ids.length === 1 ? '' : 's'} allowed`;
}

function runners(state: TuiState, args: string[]): Step {
  const [runner, arg] = args;

  if (runner) {
    const known = state.runners.find((r) => r.id === runner);
    const enabled = resolveToggle(arg, known?.enabled ?? true);
    if (enabled === null) return fail(state, 'Usage: /runners [<runner-id> on|off]');
    return step(state, [{ type: 'setRunnerEnabled', runner, enabled }]);
  }

  const action = { kind: 'set-runners' as const };
  const items = pickerItemsFor(state, action);
  return step({ ...state, overlay: {
    kind: 'picker',
    picker: picker('Runners', items, action, {
      hint: 'Enabled runners are the ones the planner may assign work to.',
      multi: true,
      chosen: state.runners.filter((r) => r.enabled).map((r) => r.id),
    }),
  } });
}

function setAutonomous(state: TuiState, arg: string | undefined): Step {
  const enabled = resolveToggle(arg, state.autonomous);
  if (enabled === null) return fail(state, 'Usage: /auto [on|off]');
  // Updated here, not from the effect: nothing round-trips this setting back
  // (it lives in .env), and a stale flag would freeze the toggle and the badge.
  return step({ ...state, autonomous: enabled }, [{ type: 'setAutonomous', enabled }]);
}

/**
 * Capture no longer costs the user their selection — the app does the selecting
 * itself now, and confines it to one pane so a copied line cannot be a splice
 * of chat and plan. What `off` still buys is the *terminal's* own selection,
 * which spans both panes and is the only one that can reach a scrollback the
 * alt screen has already scrolled away. The notice names both, because a
 * command whose only stated effect is one the user cannot see is a mystery.
 */
function setMouseCapture(state: TuiState, arg: string | undefined): Step {
  const enabled = resolveToggle(arg, state.mouseCapture);
  if (enabled === null) return fail(state, 'Usage: /mouse [on|off]');
  const noted = say(
    // A selection made under capture is meaningless once the terminal owns the
    // mouse again, and its highlight would sit on screen with nothing able to
    // move it.
    { ...state, mouseCapture: enabled, selection: null },
    'system',
    enabled
      ? 'Mouse capture on — the wheel scrolls, and dragging selects within one pane and copies on release.'
      : "Mouse capture off — the terminal's own drag-select is back, across both panes; scroll with pgup/pgdn.",
  );
  return step(noted, [{ type: 'setMouseCapture', enabled }]);
}

function openTaskRunnerPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not run on an executor, so they have no runner.');
  const action = { kind: 'set-task-runner' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Runner · #${task.order} ${task.title}`, pickerItemsFor(state, action), action, {
          hint: 'Changing the runner re-picks this task model, effort and mode for it.',
        }),
      },
    },
  );
}

/**
 * Names the dependents rather than counting them: the removal rewrites those
 * tasks' dependency lists, and a bare "Remove task?" would hide that.
 */
function confirmRemoveTask(state: TuiState, task: TaskView): Step {
  const dependents = dependentsOf(state.tasks, task.id);
  const named = dependents.map((t) => `#${t.order} ${t.title}`).join(', ');
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: `Remove #${task.order} ${task.title}?`,
      message: dependents.length > 0
        ? `${dependents.length === 1 ? '1 task depends' : `${dependents.length} tasks depend`} on it and will lose that dependency: ${named}.`
        : 'This cannot be undone.',
      action: { kind: 'remove-task', taskId: task.id },
    },
  });
}

function openTaskDepsPicker(state: TuiState, task: TaskView): Step {
  const action = { kind: 'set-task-deps' as const, taskId: task.id };
  const items = pickerItemsFor(state, action);
  if (items.length === 0) return fail(state, `Nothing runs before #${task.order}, so it has no possible dependencies.`);
  return step({
    ...state,
    overlay: {
      kind: 'picker',
      picker: picker(`Depends on · #${task.order} ${task.title}`, items, action, {
        hint: 'Only tasks earlier in the plan can be dependencies.',
        multi: true,
        chosen: task.dependencies.filter((id) => items.some((i) => i.id === id)),
      }),
    },
  });
}

function openTaskModePicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not have an executor mode.');
  const modes = modesForTask(state.modesByRunner, task);
  if (modes.length === 0) {
    return fail(state, `${task.assignedRunner ?? 'This runner'} declares no modes.`);
  }
  const action = { kind: 'set-task-mode' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Mode · #${task.order}`, pickerItemsFor(state, action), action, {
          hint: `Modes declared by ${task.assignedRunner}.`,
        }),
      },
    },
  );
}

function openTaskModelPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not have an executor model.');
  const action = { kind: 'set-task-model' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Model · #${task.order} ${task.title}`, pickerItemsFor(state, action), action, {
          hint: task.assignedRunner
            ? `Showing models discovered for ${task.assignedRunner}.`
            : 'Choose the model this task will run with.',
        }),
      },
    },
    [{ type: 'loadModels' }],
  );
}

function openTaskEffortPicker(state: TuiState, task: TaskView): Step {
  if (task.type !== 'ai') return fail(state, 'Manual tasks do not have a thinking effort.');
  if (!task.assignedModel) return fail(state, 'Choose a model for this task before setting its thinking effort.');
  const action = { kind: 'set-task-effort' as const, taskId: task.id };
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker(`Thinking effort · #${task.order}`, pickerItemsFor(state, action), action, {
          hint: `${task.assignedModel.modelLabel} · choose runner default or a supported effort`,
        }),
      },
    },
    [{ type: 'loadModels' }],
  );
}

function assignTaskModel(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  model: ModelView,
): Step {
  const assignedModel = assignedModelFor(model, task.assignedModel?.thinkingEffort);
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    // JSON drops `undefined`; null is intentional here so changing models can
    // also clear a stale legacy top-level effort on the persisted task.
    changes: { assignedModel, thinkingEffort: assignedModel.thinkingEffort ?? null },
    message: `Task #${task.order} model set to ${model.label}.`,
  }]);
}

/**
 * Sends only the runner. The daemon owns the retarget (Session.setTaskRunner):
 * it re-derives model, effort and mode from the new runner's catalog, and the
 * refreshed plan comes back through the usual plan refresh. Picking a model
 * here would race that and could name one the runner cannot spawn.
 */
function assignTaskRunner(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  runner: string,
  runnerLabel: string,
): Step {
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    changes: { assignedRunner: runner },
    message: `Task #${task.order} runner set to ${runnerLabel}.`,
  }]);
}

function assignTaskMode(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  mode: string,
  modeLabel: string,
): Step {
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    changes: { taskMode: mode },
    message: `Task #${task.order} mode set to ${modeLabel}.`,
  }]);
}

function assignTaskEffort(
  state: TuiState,
  sessionId: string,
  task: TaskView,
  thinkingEffort: string | undefined,
): Step {
  const assignedModel = task.assignedModel
    ? { ...task.assignedModel, thinkingEffort }
    : undefined;
  return step(state, [{
    type: 'updateTask',
    sessionId,
    taskId: task.id,
    changes: { assignedModel, thinkingEffort: thinkingEffort ?? null },
    message: `Task #${task.order} thinking effort set to ${thinkingEffort ?? 'runner default'}.`,
  }]);
}

function taskModelCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskModelPicker(state, task);
    const model = state.models.find((candidate) => candidate.id === args[1]) ?? {
      id: args[1],
      label: args[1],
      provider: '',
      variants: [],
    };
    if (!runnerAccepts(task, model)) {
      return fail(state, `${model.label} was not discovered for ${task.assignedRunner}.`);
    }
    return assignTaskModel(state, sessionId, task, model);
  });
}

function taskRunnerCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskRunnerPicker(state, task);
    const runner = state.runners.find((candidate) => candidate.id === args[1]);
    if (!runner) return fail(state, `Unknown runner "${args[1]}".`);
    return assignTaskRunner(state, sessionId, task, runner.id, runner.name);
  });
}

function taskModeCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskModePicker(state, task);
    const mode = modesForTask(state.modesByRunner, task).find((candidate) => candidate.id === args[1]);
    if (!mode) return fail(state, `Unsupported mode "${args[1]}" for ${task.assignedRunner}.`);
    return assignTaskMode(state, sessionId, task, mode.id, mode.label);
  });
}

function taskEffortCommand(state: TuiState, args: string[]): Step {
  return taskCommand(state, args[0], (sessionId, taskId) => {
    const task = findTask(state.tasks, taskId)!;
    if (!args[1]) return openTaskEffortPicker(state, task);
    if (!task.assignedModel) return fail(state, 'Choose a model for this task before setting its thinking effort.');
    const effort = args[1].toLowerCase();
    const value = effort === 'default' || effort === 'none' ? undefined : args[1];
    const supported = effortsForTask(state.models, task);
    if (value && supported.length > 0 && !supported.some((variant) => variant.id === value)) {
      return fail(state, `Unsupported effort "${value}" for ${task.assignedModel.modelLabel}.`);
    }
    return assignTaskEffort(state, sessionId, task, value);
  });
}

function addTask(state: TuiState, title: string): Step {
  return withSession(state, (sessionId) => {
    if (!title) {
      return step({
        ...state,
        overlay: { kind: 'prompt', title: 'New task title', value: '', action: { kind: 'add-task' } },
      });
    }
    return step(state, [{ type: 'addTask', sessionId, title }]);
  });
}

function taskCommand(
  state: TuiState,
  token: string | undefined,
  run: (sessionId: string, taskId: string) => Step,
): Step {
  return withSession(state, (sessionId) => {
    if (!token) return fail(state, 'Which task? Pass a task id or its number in the plan.');
    const taskId = resolveTaskId(state, token);
    if (!taskId) return fail(state, `No task matching "${token}" in the current plan.`);
    return run(sessionId, taskId);
  });
}

/** Users refer to tasks by the number shown in the plan pane as often as by id. */
export function resolveTaskId(state: TuiState, token: string): string | null {
  const byId = findTask(state.tasks, token);
  if (byId) return byId.id;

  const order = Number(token);
  if (Number.isInteger(order)) {
    const byOrder = state.tasks.find((t) => t.order === order);
    if (byOrder) return byOrder.id;
  }
  return null;
}
