import { EMPTY_HOLD, fromTranscript, holdPrompt, taskStartedNotice } from '@ordewell/core';
import { isolationOfPlan } from '../isolation';
import { chatEditorRoomFor } from './geometry';
import { chatScrollMax } from './layout';
import { activeToken, findCommand, parseSlash, tokenCompletions } from './slash';
import { applyKey, commit } from './editor';
import { say, wiped } from './transcript';
import { blockedPicker, clearIsolation, handoffArrived, isolationForPlan, sameIsolation, showDiff } from './handoff';
import { continuesTask, findTask, isTaskRunning, planRows, plannerInFlight, type GateView, type RunStatus, type TaskTransportView, type TaskView, type TuiState } from './state';
import type { Key } from './keys';
import { handleOverlayKey } from './reducers/overlays';
import { handlePlanKey } from './reducers/planPane';
import { announceApprovals, announceCheckpoint, continueTaskStep, handleTaskViewKey, openTaskView, taskLogAbandoned, taskLogArrived, taskLogLoaded } from './reducers/taskView';
import { pickRewindTarget, runCommand, skillInTaskView, unknownCommand } from './reducers/commands';
import { disarmStop, drainQueue, plannerEscape } from './reducers/turnQueue';
import { applySettings, followSession, normalizeTasks, runLabel } from './reducers/incoming';
import { refillPicker } from './reducers/pickers';
import {
  handleMouseSelect, isMouseSelect, isWheel, scrollChat, scrollDelta, scrollPointed, settlePlan, toggleDetail,
} from './reducers/pointer';
import { clamp, clampSelection, stale, step, type Action, type Effect, type Step } from './reducers/shared';

export { initialState } from './state';
export { resolveTaskId } from './reducers/taskEdits';
export type { Action, Effect, Step, TaskAction } from './reducers/shared';

/**
 * Live output never moves a reader who scrolled back: the offset counts lines
 * from the tail, so lines arriving below would otherwise slide what they are
 * reading upward. At the tail (scroll 0) the pane just follows.
 */
function holdReadingPlace(before: TuiState, after: TuiState): TuiState {
  if (before.scroll <= 0 || after.scroll !== before.scroll) return after;
  if (before.taskView?.taskId !== after.taskView?.taskId) return after;
  const grown = chatScrollMax(after) - chatScrollMax(before);
  return grown > 0 ? { ...after, scroll: clamp(after.scroll + grown, chatScrollMax(after)) } : after;
}

export function reduce(state: TuiState, action: Action): Step {
  const result = reduceAction(state, action);
  if (action.type !== 'sessionMessage' && action.type !== 'taskLog') return result;
  return { ...result, state: holdReadingPlace(state, result.state) };
}

function reduceAction(state: TuiState, action: Action): Step {
  switch (action.type) {
    case 'key':
      return handleKey(state, action.key);

    // Isolation belongs to one session's plan, and task ids repeat across
    // sessions, so nothing of the last one's may carry over into this.
    case 'sessionStarted':
      return step(clearIsolation({ ...state, sessionId: action.sessionId, goal: action.goal, taskView: null }));

    // The daemon registers a session only once planning succeeds; when it does
    // not, holding on to the id would send every next message to a session the
    // server never had.
    case 'sessionCleared':
      // Prompts belong to the session that raised them; the old planner is gone.
      return step({
        ...clearIsolation(state),
        sessionId: null,
        goal: '',
        taskView: null,
        pendingApprovals: [],
        queuedPrompts: EMPTY_HOLD,
        stopArmed: false,
        overlay: state.overlay?.kind === 'approval' ? null : state.overlay,
      });

    case 'chatRestored':
      if (stale(state, action.sessionId)) return step(state);
      return step({ ...state, conversation: fromTranscript(action.history, action.researchLog, action.plannerUsage), scroll: 0 });

    case 'planUpdated': {
      if (stale(state, action.sessionId)) return step(state);
      // A saved plan carries its isolation record; a planner reply does not,
      // and says nothing about it, so what the stream last reported stays.
      const isolation = isolationOfPlan(action.plan);
      const tasks = isolationForPlan(normalizeTasks(action.plan), isolation, state.tasks);
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
        handoff: isolation ? isolation.handoff : state.handoff,
        status: plannerInFlight(state) ? 'idle' : state.status,
        busyLabel: '',
        expandedTaskId,
        taskEditor: expandedTaskId !== null ? state.taskEditor : null,
      };
      const selectedTask = clampSelection(state.selectedTask, planRows(next).length);
      // A plan refresh mid-run (a run in flight) is not a turn ending — only
      // leaving the planning statuses is the moment the queue may drain.
      const settled = settlePlan({
        ...next,
        selectedTask,
        focus: tasks.length === 0 ? 'chat' : state.focus,
      });
      if (!plannerInFlight(state)) {
        return step(settled);
      }
      return drainQueue(state, settled);
    }

    // A message never ends a turn: `planUpdated` does (see `converse`), so a
    // queued prompt drains onto a settled state. Until then the status only
    // says whether a call is out.
    case 'sessionMessage':
      if (stale(state, action.sessionId)) return step(state);
      return step(followSession(state, action.message));

    case 'taskLog':
      if (stale(state, action.sessionId)) return step(state);
      return step(announceApprovals(taskLogArrived(state, action), action));

    case 'taskViewRequested':
      if (stale(state, action.sessionId)) return step(state);
      return openTaskView(state, action.sessionId, action.taskId);

    case 'taskLogLoaded':
      if (stale(state, action.sessionId)) return step(state);
      return step(taskLogLoaded(state, action));

    // A settled transcript line, not a research step: nothing ever settles a
    // task's start, so as a step it stayed "⋯" forever and was counted into
    // the planner's next "(+N more)".
    case 'taskStarted': {
      if (stale(state, action.sessionId)) return step(state);
      // One task, one start. A second notice for a task already running is a
      // duplicate that slipped through (a retry arrives with it back to
      // pending, so a genuine second start still speaks).
      const existing = findTask(state.tasks, action.taskId);
      if (existing && isTaskRunning(existing)) return step(state);
      const tasks = state.tasks.map((t) => (t.id === action.taskId && !isTaskRunning(t) ? { ...t, status: 'in_progress' } : t));
      const spoken = say(state, 'system', taskStartedNotice(action.title, action.runner));
      return step({ ...spoken, tasks, status: 'executing', busyLabel: runLabel(tasks) });
    }

    case 'taskCheckpoint':
      if (stale(state, action.sessionId)) return step(state);
      return step(announceCheckpoint(state, action));

    case 'taskStatus': {
      if (stale(state, action.sessionId) || !state.tasks.some((t) => t.id === action.taskId)) return step(state);
      // This event names no reason, so one kept from an earlier wait would be stale.
      const tasks = state.tasks.map((t) => (t.id === action.taskId ? { ...t, status: action.status, awaitingReason: undefined, checkpoint: undefined } : t));
      // The indicator follows the tasks, not the stream: once none is running
      // the run is over, whatever the daemon's scheduler still holds armed.
      const status = runStatus(state, tasks);
      return step({ ...state, status, tasks, busyLabel: status === 'executing' ? runLabel(tasks, state.gate) : state.busyLabel });
    }

    case 'tasksStatus': {
      if (stale(state, action.sessionId)) return step(state);
      const updates = action.updates;
      let changed = false;
      const tasks = state.tasks.map((t) => {
        const update = updates[t.id];
        if (update === undefined) return t;
        const idleSince = update.idleSince ?? null;
        const isolation = update.isolation ?? t.isolation;
        // Unlike isolation, every status carries the transport whole: absent
        // means the task's latest attempt was not asked to run structured.
        const transport = update.transport;
        const awaitingReason = update.awaitingReason;
        const checkpoint = update.checkpoint;
        const continuable = update.continuable === true;
        const awaitingApproval = update.awaitingApproval;
        const mergeGate = update.mergeGate;
        const forcedPastGate = update.forcedPastGate;
        if (
          update.status !== t.status || idleSince !== (t.idleSince ?? null) || !sameIsolation(isolation, t.isolation)
          || !sameTransport(transport, t.transport) || awaitingReason !== t.awaitingReason || checkpoint !== t.checkpoint
          || continuable !== (t.continuable ?? false) || awaitingApproval !== t.awaitingApproval
          || !sameList(mergeGate, t.mergeGate) || !sameList(forcedPastGate, t.forcedPastGate)
        ) {
          changed = true;
          return { ...t, status: update.status, idleSince, isolation, transport, awaitingReason, checkpoint, continuable, awaitingApproval, mergeGate, forcedPastGate };
        }
        return t;
      });
      // An update that does not say (an older daemon) leaves the gate as it was.
      const gate = action.gate === undefined ? state.gate : action.gate;
      const gateChanged = !sameGate(gate, state.gate);
      // Skip a new state object when nothing actually changed — a no-op
      // status_update still triggers a render via dispatch, but at least
      // the reference equality lets downstream memos keep their hits.
      if (!changed && !gateChanged) return step(state);
      const next = { ...state, tasks, gate };
      const status = runStatus(next, tasks);
      return step({ ...next, status, busyLabel: status === 'executing' ? runLabel(tasks, gate) : state.busyLabel });
    }

    case 'isolationBlocked': {
      if (stale(state, action.sessionId)) return step(state);
      return step(blockedPicker(state, action.message, action.repos));
    }

    case 'isolationHandoff': {
      if (stale(state, action.sessionId)) return step(state);
      return step(handoffArrived(state, action.handoff));
    }

    case 'handoffDiff': {
      if (stale(state, action.sessionId)) return step(state);
      return step(showDiff(state, action.diff));
    }

    case 'runCleared': {
      if (stale(state, action.sessionId)) return step(state);
      // Whatever overlay the discard or merge was confirmed from is already closed; one
      // opened since (a picker, help) has nothing to do with the run and stays.
      const overlay = state.overlay?.kind === 'handoff' ? null : state.overlay;
      return step({ ...clearIsolation(state), overlay });
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
      });
    }

    case 'executionLost': {
      if (stale(state, action.sessionId)) return step(state);
      // Statuses stay as last reported: the daemon still serves the live store
      // and may be running these, so 'pending' would be a guess against a run
      // that is still going.
      return step({
        ...say(state, 'error', 'Lost the connection to the daemon — this view is no longer following the run, but the daemon may still be running it. /load this session again to see where it stands.'),
        status: 'idle',
        busyLabel: '',
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

    case 'rewindTargetsLoaded':
      if (stale(state, action.sessionId)) return step(state);
      if (action.pick !== undefined) return pickRewindTarget({ ...state, rewindTargets: action.targets }, action.pick);
      return step(refillPicker({ ...state, rewindTargets: action.targets }, ['rewind']));

    // A fork holds no run, whatever the session it came from was doing — the
    // original keeps its run, and its events are stale from here on.
    case 'sessionForked':
      return step({
        ...clearIsolation(state),
        sessionId: action.sessionId,
        goal: action.goal,
        taskView: null,
        status: 'idle',
        busyLabel: '',
        planApproved: false,
        pendingApprovals: [],
        queuedPrompts: EMPTY_HOLD,
        stopArmed: false,
        overlay: state.overlay?.kind === 'approval' ? null : state.overlay,
      });

    // The rewound message comes back as a draft to edit and resend, so it lands
    // as if just typed: history is not being browsed, and nothing is parked.
    case 'inputPrefilled':
      if (stale(state, action.sessionId)) return step(state);
      return step({
        ...state,
        focus: 'chat',
        editor: { ...state.editor, text: action.text, cursor: action.text.length, historyIndex: state.editor.history.length, draft: '' },
      });

    case 'runnersLoaded':
      // Installed runners are the planner picker's preflight signal, so a
      // picker opened before discovery landed fills in rather than sitting
      // there claiming every agent is missing.
      return step(refillPicker({
        ...state,
        runners: action.runners,
        orchestratorModel: action.orchestratorModel ?? state.orchestratorModel,
      }, ['set-planner', 'set-task-runner']));

    case 'failed': {
      // A failed call may have been the task view's log read; the view falls
      // back to whatever the live stream sent rather than waiting forever.
      state = taskLogAbandoned(state);
      const quiet = plannerInFlight(state) && state.stopRequested;
      const reported = { ...(quiet ? state : say(state, 'error', action.message)), status: 'idle' as const, busyLabel: '' };
      // A planner turn dying IS a turn ending — the queue would otherwise wait
      // on a next one that never comes. An execution failure (or any failure
      // with no turn running) drains nothing.
      if (!plannerInFlight(state)) return step(reported);
      return drainQueue(state, reported);
    }

    case 'workspaceNeedsInit':
      return step({
        ...state,
        status: 'idle',
        busyLabel: '',
        overlay: {
          kind: 'confirm',
          title: 'Initialize new workspace?',
          message: `"${action.workspace}" isn't a recognized project yet (no .git or manifest found). Start a new ordewell workspace here?`,
          action: { kind: 'init-workspace', goal: action.goal, workspace: action.workspace },
        },
      });

    case 'notice':
      return step(say(state, action.level === 'error' ? 'error' : 'system', action.message));

    case 'resize': {
      // A grown pane can leave both offsets pointing past the end of content
      // that now fits; re-clamping here keeps "the offset is always reachable"
      // true for the keys handled next, not just for the ones handled last.
      // The selection goes rather than moves: it names screen cells, and a
      // resize both re-wraps what is under them and shifts the divider — so a
      // span anchored where the plan pane used to begin would end up straddling
      // the new one, which is exactly the splice pinning a pane prevents.
      const resized = { ...state, rows: action.rows, cols: action.cols, selection: null };
      return step(settlePlan({ ...resized, scroll: clamp(resized.scroll, chatScrollMax(resized)) }));
    }

    // Whether there is anything to animate is the app loop's call (it owns the
    // timer); a tick that arrives simply advances the frame.
    case 'spinnerTick':
      return step({ ...state, spinnerFrame: (state.spinnerFrame + 1) % 10 });

    // The scheduled expiry of an armed stop; a token that is no longer the live
    // arm is a stale timer (the user disarmed and re-armed in between) and is
    // ignored, so it cannot cut a newer arm short.
    case 'stopDisarmed':
      if (!state.stopArmed || action.arm !== state.stopArmToken) return step(state);
      return step(disarmStop(state));
  }
}

/** The run indicator after a task-status change: a run is active only while a task is. */
function sameTransport(a: TaskTransportView | undefined, b: TaskTransportView | undefined): boolean {
  return a?.kind === b?.kind && a?.fallback === b?.fallback;
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return (a ?? []).join('\0') === (b ?? []).join('\0');
}

function sameGate(a: GateView | null, b: GateView | null): boolean {
  if (!a || !b) return a === b;
  return a.paused === b.paused && JSON.stringify(a.handoff) === JSON.stringify(b.handoff);
}

function runStatus(state: TuiState, tasks: TaskView[]): RunStatus {
  if (tasks.some(isTaskRunning)) return 'executing';
  // A task waiting on the user is not executing, but the run is not over
  // either — the indicator says it waits rather than going idle. A run paused
  // at a merge gate waits on the user the same way.
  if (tasks.some((t) => t.status === 'awaiting_user') || state.gate?.paused) return 'executing';
  return plannerInFlight(state) ? state.status : 'idle';
}

/** Ctrl-C backs out one layer at a time; it only quits when there is nothing to back out of. */
function interrupt(state: TuiState): Step {
  if (state.overlay) return step({ ...state, overlay: null });
  if (state.editor.text) return step({ ...state, editor: { ...state.editor, text: '', cursor: 0 } });
  return step({ ...state, exiting: true }, [{ type: 'exit' }]);
}

/**
 * Key routing, outermost first: global quit keys, then whatever overlay is
 * open, then the focused pane. Only the chat pane feeds the line editor, so
 * plan-pane shortcuts and picker filters never leak into the prompt.
 */
function handleKey(state: TuiState, key: Key): Step {
  // Any key that is not the Esc being asked about disarms a standing stop. The
  // arm is dropped and the key goes on to whatever it normally does — a press
  // that arrives after the arm must not be swallowed by the arming itself.
  if (state.stopArmed && key.name !== 'escape') state = disarmStop(state);
  if (key.name === 'ctrl-c') return interrupt(state);
  if (key.name === 'ctrl-d' && !state.editor.text && !state.overlay) {
    return step({ ...state, exiting: true }, [{ type: 'exit' }]);
  }
  if (key.name === 'ctrl-l') return step({ ...state, conversation: wiped(state.conversation), scroll: 0 });
  // A chat-pane switch: the plan pane's rows are never truncated, so there is
  // nothing there to expand. It is open mid-turn on purpose — reading the
  // stream in full as it lands is where full detail matters most.
  if (key.name === 'ctrl-o' && state.focus === 'chat' && !state.overlay) return toggleDetail(state);

  // In the task view, Esc backs out the same way: a draft clears first, then
  // the view closes and the planner chat returns. An open overlay still owns
  // Esc ahead of it, so /help closes before the view does.
  if (key.name === 'escape' && state.taskView && !state.overlay) {
    if (state.editor.text) return step({ ...state, editor: { ...state.editor, text: '', cursor: 0 } });
    return step({ ...state, taskView: null, scroll: 0 });
  }

  // Esc during a planner turn is the turn queue's (take back a prompt, arm a
  // stop, commit it); every other Esc belongs to the overlay or pane below.
  if (key.name === 'escape') {
    const stopped = plannerEscape(state);
    if (stopped) return stopped;
  }
  if (state.overlay) return handleOverlayKey(state, state.overlay, key);
  // Above the focus split, because a wheel notch is aimed, not focused. A drag
  // is aimed too, and for the same reason it never reaches the line editor or
  // the plan pane's letter shortcuts below.
  if (isWheel(key)) return scrollPointed(state, key);
  if (isMouseSelect(key)) return handleMouseSelect(state, key);
  if (key.name === 'wheelignored') return step(state);
  if (key.name === 'tab' && state.focus === 'chat') {
    const token = activeToken(state.editor.text, state.editor.cursor);
    const matches = token ? tokenCompletions(token) : [];
    if (token && matches.length > 0) {
      const { text: full } = state.editor;
      const completed = `/${matches[0].name} `;
      const text = full.slice(0, token.start) + completed + full.slice(token.end);
      return step({ ...state, editor: { ...state.editor, text, cursor: token.start + completed.length } });
    }
  }
  if (key.name === 'tab') {
    // The pane is hidden while the plan is empty, so there is nothing to focus.
    if (state.focus === 'chat' && state.tasks.length === 0) return step(state);
    return step({ ...state, focus: state.focus === 'chat' ? 'plan' : 'chat' });
  }
  if (state.focus === 'plan') return handlePlanKey(state, key);

  // The task view's own keys (attempts, queued messages, interrupt) sit ahead
  // of the editor; anything they decline still types into the composer.
  if (state.taskView) {
    const handled = handleTaskViewKey(state, key);
    if (handled) return handled;
  }

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
  const room = chatEditorRoomFor(state, true);
  return step({ ...state, editor: applyKey(state.editor, key, multilineEditor ? room : undefined) });
}

function submit(state: TuiState): Step {
  const text = state.editor.text.trim();
  if (!text) return step(state);

  const cleared: TuiState = { ...state, editor: commit(state.editor) };
  const command = parseSlash(text);
  // Only a built-in is dispatched here. In planner chat a skill-backed or
  // unregistered /name goes to the planner like any other message, literal
  // /name and all, so the daemon's own skill resolution (see
  // resolveSkillInvocation) loads Ordewell's skill before a coding-agent
  // planner ever sees the token and tries to resolve it itself. The task
  // view's composer has no such resolution: a mistyped /retyr there would
  // continue a finished task or reach a running agent, so it is refused.
  if (command) {
    const known = findCommand(command.name);
    if (known && known.source !== 'skill') return runCommand(cleared, command);
    if (state.taskView) return known ? skillInTaskView(cleared, command.name) : unknownCommand(cleared, command.name);
  }

  // The task view's composer talks to the runner, not the planner: the daemon
  // queues the message (or delivers it to a waiting task) and the log shows it.
  // A finished task has no turn to message; its composer continues it instead.
  if (state.taskView) {
    if (!state.sessionId) return step(state);
    const taskId = state.taskView.taskId;
    if (continuesTask(findTask(state.tasks, taskId))) return continueTaskStep(cleared, state.sessionId, taskId, text);
    return step(cleared, [{ type: 'sendTaskMessage', sessionId: state.sessionId, taskId, text }]);
  }

  // A prompt while a turn answers is held, not sent: the transcript would
  // otherwise show a message the daemon has not even received yet, and the
  // first turn's registration race turns a second prompt into a 404.
  if (plannerInFlight(state)) {
    return step({ ...cleared, queuedPrompts: holdPrompt(state.queuedPrompts, text) });
  }

  const spoken = say(cleared, 'user', text);
  const effect: Effect = state.sessionId
    ? { type: 'sendMessage', sessionId: state.sessionId, message: text }
    : { type: 'startConversation', goal: text };

  return step({ ...spoken, status: 'planning', stopRequested: false }, [effect]);
}
