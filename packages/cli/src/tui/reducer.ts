import { blockingFailures, DEFAULT_RUNNERS, EMPTY_HOLD, EMPTY_RUN, NO_TURN, fromTranscript, holdPrompt, taskLogCommands, taskStartedNotice, type RunnerId, type SerializedPlan } from '@ordewell/core';
import { bodyMode, chatEditorRoomFor } from './geometry';
import { SPINNER_CYCLE, chatScrollMax } from './layout';
import { activeToken, composerCompletions, findCommand, parseRunnerCommand, parseSlash, runnerCommandFor, type ParsedCommand } from './slash';
import { applyKey, commit } from './editor';
import { endRunningCompactions, hear, say, wiped } from './transcript';
import { blockedPicker, handoffArrived, showDiff } from './handoff';
import { continuesTask, findTask, isTaskRunning, planPaneOpen, planRows, plannerInFlight, scriptTaskView, waitingApproval, waitingCheckpoint, type RunStatus, type TaskView, type TuiState } from './state';
import type { Key } from './keys';
import { handleOverlayKey } from './reducers/overlays';
import { syncApprovals } from './reducers/approvals';
import { handlePlanKey } from './reducers/planPane';
import { announceApprovals, announceCheckpoint, answerCheckpoint, continueTaskStep, handleTaskViewKey, openTaskView, taskLogAbandoned, taskLogArrived, taskLogLoaded } from './reducers/taskView';
import { newSession, pickRewindTarget, runCommand } from './reducers/commands';
import { adoptCompaction, followCompaction } from './reducers/compaction';
import { disarmStop, drainQueue, forceSendPlanner, plannerEscape, queueToEditor, restoreForced } from './reducers/turnQueue';
import { applySettings, foldRun, followSession, planSnapshot, withRun } from './reducers/incoming';
import { refillPicker, reseedRunnerChoice } from './reducers/pickers';
import { refreshStepper } from './reducers/stepper';
import {
  handleMouseSelect, isMouseSelect, isScrollKey, isWheel, scrollChat, scrollDelta, scrollPointed, settlePanes, settlePlan, toggleDetail,
} from './reducers/pointer';
import { clamp, clampSelection, clearNotice, reportError, stale, step, type Action, type Effect, type Step } from './reducers/shared';

export { initialState } from './state';
export { resolveTaskId } from './reducers/taskEdits';
export type { Action, Effect, Step, TaskAction } from './reducers/shared';

/** The cause a lost-reply line carries, when the effect knew one. */
function because(reason: string | undefined): string {
  return reason ? ` (${reason})` : '';
}

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

/**
 * Stacked, the plan's height follows what the transcript has to say, so a reply
 * landing in the chat can take rows from the plan — and a selection that was
 * just inside its viewport falls off the end. A viewport the user has not
 * positioned (`null`) follows the selection by itself and needs nothing.
 */
function holdPlanInView(after: TuiState): TuiState {
  return after.planScroll === null || bodyMode(after) !== 'stacked' ? after : settlePlan(after);
}

export function reduce(state: TuiState, action: Action): Step {
  const result = reduceAction(state, action);
  // A notice normally sets `scroll` to 0, which `holdReadingPlace` leaves
  // alone; one that holds the reader's place grows the content below them
  // exactly as live output does.
  if (action.type !== 'sessionMessage' && action.type !== 'compacted' && action.type !== 'taskLog' && action.type !== 'notice') return result;
  return { ...result, state: holdPlanInView(holdReadingPlace(state, result.state)) };
}

function reduceAction(state: TuiState, action: Action): Step {
  switch (action.type) {
    case 'accountLimits':
      return stale(state, action.sessionId) ? step(state) : step({ ...state, accountLimits: action.limits });

    case 'key':
      return handleKey(state, action.key);

    // A run belongs to one session's plan, and task ids repeat across sessions
    // (`task-1`), so nothing of the last one's — a merge gate, a checkpoint, its
    // tasks — may carry over into this.
    case 'sessionStarted':
      return step(withRun({ ...state, sessionId: action.sessionId, goal: action.goal, accountLimits: [], servedModels: {}, taskView: null, status: 'idle' }, EMPTY_RUN));

    // A loaded session is a different one: the turn the old one had out, the
    // prompts held behind it and a stop armed against it are not this one's.
    // Nor is an open prompt editor: task ids repeat across plans, so the
    // loaded plan's `task-1` would keep it, and Enter save the old draft there.
    // (`sessionStarted` cannot reset them: `startConversation` dispatches it
    // as its own turn begins.)
    case 'sessionLoaded':
      return step(withRun({
        ...state,
        accountLimits: [],
        servedModels: {},
        sessionId: action.sessionId,
        goal: action.goal,
        taskView: null,
        expandedTaskId: null,
        taskEditor: null,
        status: 'idle',
        planner: 'idle',
        plannerPause: null,
        plannerResend: null,
        turnGate: NO_TURN,
        pendingApprovals: [],
        queuedPrompts: EMPTY_HOLD,
        stopArmed: false,
        stopRequested: false,
        forceSendPending: null,
        overlay: state.overlay?.kind === 'approval' ? null : state.overlay,
        runSettingsKnown: false,
      }, EMPTY_RUN));

    // The daemon registers a session before its opening turn runs, and drops it
    // itself when it refuses the turn or the goal is discarded; any other
    // failure it answered leaves no conversation a reply could continue, so the
    // id is let go rather than guessed at. A reply that was merely lost is not
    // this: the session is the daemon's and the turn may be running (`turnLost`).
    case 'sessionCleared':
      if (stale(state, action.sessionId)) return step(state);
      // Approvals belong to the session that raised them; the old planner is
      // gone, and the turn gate it held with it. The prompts typed behind its
      // turn were never sent and are not echoed until they are, so they go back
      // to the editor rather than vanishing with the session.
      return step(withRun({
        ...queueToEditor(state),
        accountLimits: [],
        servedModels: {},
        sessionId: null,
        goal: '',
        taskView: null,
        expandedTaskId: null,
        taskEditor: null,
        status: 'idle',
        plannerPause: null,
        plannerResend: null,
        turnGate: NO_TURN,
        pendingApprovals: [],
        stopArmed: false,
        forceSendPending: null,
        overlay: state.overlay?.kind === 'approval' ? null : state.overlay,
        runSettingsKnown: action.unreached ? state.runSettingsKnown : false,
      }, EMPTY_RUN));

    // Deleting the session on screen stops it in the daemon; a view left on it
    // would answer every next message with a session-not-found.
    case 'sessionDeleted':
      return action.sessionId === state.sessionId ? newSession(state) : step(state);

    case 'chatRestored':
      if (stale(state, action.sessionId)) return step(state);
      return step({ ...state, conversation: fromTranscript(action.history, action.researchLog, action.plannerUsage, action.pendingTurns), scroll: 0 });

    case 'planRefreshed':
      if (stale(state, action.sessionId)) return step(state);
      return step(showPlan(state, action.plan));

    case 'compacted': {
      if (stale(state, action.sessionId)) return step(state);
      // The summary and its marker are in the plan's transcript; folding them is
      // a no-op when the socket delivered them first, and the only copy when it did not.
      const synced = hear(state, { type: 'plan_generated', plan: action.plan as SerializedPlan, goal: state.goal, runners: [] });
      return reduceAction(synced, { type: 'planUpdated', plan: action.plan, sessionId: action.sessionId });
    }

    case 'planUpdated': {
      if (stale(state, action.sessionId)) return step(state);
      const settled: TuiState = { ...showPlan(state, action.plan), planner: 'idle' };
      // A plan refresh mid-run (a run in flight) is not a turn ending — only
      // leaving the planning statuses is the moment the queue may drain.
      if (!plannerInFlight(state)) {
        return step({ ...settled, forceSendPending: null });
      }
      // The turn a force send stopped can settle with what it had said rather
      // than fail as stopped (see `failed`); the forced turn is still running,
      // and the held prompts wait for it.
      if (state.forceSendPending) return step({ ...settled, planner: 'planning', forceSendPending: null });
      return drainQueue(state, settled);
    }

    // The call that carried the turn's reply died, so nothing will say the turn
    // is over but the daemon. The prompts held behind it, and the turn itself,
    // wait for that; a send-now in doubt is not given back, as the daemon may
    // have taken it.
    case 'turnLost': {
      if (stale(state, action.sessionId) || !plannerInFlight(state)) return step(state);
      const awaiting: TuiState = { ...state, planner: 'awaiting', forceSendPending: null };
      return step(say(awaiting, 'system', `The reply was lost on the way${because(action.reason)}: the planner may still be running this turn or may have finished it. Showing what the server holds.`));
    }

    // The daemon's own word on the session. A turn it still runs is live, and
    // ends through `sessionMessage` below; otherwise the gate's turn is over,
    // and settles as any turn that returned its plan.
    case 'turnReconciled': {
      if (stale(state, action.sessionId)) return step(state);
      if (action.plannerTurnId === undefined && action.plannerCompaction) {
        // Mid-compaction there is nothing to redraw: the view folds the compaction
        // in by its id, and its end, when it comes, frees the planner.
        return step(adoptCompaction(showPlan(state, action.plan), action.plannerCompaction));
      }
      if (action.plannerTurnId === undefined && state.planner === 'compacting') {
        // Its end went with the connection. The plan says whether it committed;
        // otherwise nothing is known to have happened, so no outcome is claimed.
        const synced = hear(state, { type: 'plan_generated', plan: action.plan as SerializedPlan, goal: state.goal, runners: [] });
        return reduceAction(endRunningCompactions(synced, 'unchanged'), { type: 'planUpdated', plan: action.plan, sessionId: action.sessionId });
      }
      if (action.plannerTurnId !== undefined) {
        // The gate follows the turn actually running: its own end is what
        // releases the queue, a stranger's output is not dropped as a stale one's.
        const gate = action.plannerTurnId === state.turnGate.open
          ? state.turnGate
          : { open: action.plannerTurnId, stopped: null };
        return step(showPlan({ ...state, turnGate: gate }, action.plan));
      }
      const redrawn = reduceAction({ ...state, turnGate: NO_TURN }, action.chat).state;
      const settled = reduceAction(redrawn, { type: 'planUpdated', plan: action.plan, sessionId: action.sessionId });
      // A joined turn's end went with the socket: no reply of this surface's was lost.
      if (state.planner === 'joined') return settled;
      // The redraw replaced the line `turnLost` spoke, and with it the reason a message may be missing.
      return { ...settled, state: say(settled.state, 'system', `The reply to your last message was lost on the way${because(action.reason)}; this is what the server holds.`) };
    }

    // Dispatched after the load's `planUpdated`, which reads the planner as
    // free: the turn is the daemon's, and its end is what frees it.
    case 'turnJoined':
      if (stale(state, action.sessionId)) return step(state);
      return step({ ...state, planner: 'joined', turnGate: { open: action.turnId, stopped: null } });

    // A message never ends a turn: `planUpdated` does (see `converse`), so a
    // queued prompt drains onto a settled state. Until then the status only
    // says whether a call is out. The exceptions are turns with no call here:
    // a joined turn's end settles it, as a compaction's end does; the end of a
    // turn whose call was lost sends for the session to be read back.
    case 'sessionMessage': {
      if (stale(state, action.sessionId)) return step(state);
      if (action.message.type === 'planner_compaction') return followCompaction(state, action.message);
      const next = followSession(state, action.message);
      const { sessionId } = state;
      const gateClosed = action.message.type === 'planner_turn_ended' && next.turnGate.open === null;
      if (gateClosed && state.planner === 'joined') {
        // A send-now interrupted the joined turn: its own call is out now, and its reply settles it.
        return state.forceSendPending
          ? step({ ...next, planner: 'planning', forceSendPending: null })
          : drainQueue(state, { ...next, planner: 'idle' });
      }
      const lostTurnEnded = gateClosed && state.planner === 'awaiting' && !state.forceSendPending;
      return step(next, lostTurnEnded && sessionId ? [{ type: 'reconcileTurn', sessionId }] : []);
    }

    // The run as the daemon sends it when a socket connects: the whole view is
    // adopted, so a surface joining mid-run has it before the next update — and
    // its status line with it, as a status update would have set it.
    case 'runSnapshot': {
      if (stale(state, action.sessionId)) return step(state);
      const run = withRun(state, action.view);
      const next = action.approvals ? syncApprovals(run, action.approvals) : run;
      const status = runStatus(next, next.tasks);
      return step({ ...next, status });
    }

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
      const folded = foldRun(state, {
        type: 'task_started',
        taskId: action.taskId,
        order: action.order ?? 0,
        title: action.title,
        runner: (action.runner ?? DEFAULT_RUNNERS[0]) as RunnerId,
      });
      const spoken = say(folded, 'system', taskStartedNotice(action.title, action.runner));
      return step({ ...spoken, status: 'executing' });
    }

    case 'taskCheckpoint':
      if (stale(state, action.sessionId)) return step(state);
      return step(announceCheckpoint(state, action));

    // An edit from another surface or the supervisor; the plan itself is not
    // re-read, so the patch is all there is to show it by.
    case 'taskUpdated':
      if (stale(state, action.sessionId)) return step(state);
      return step(foldRun(state, { type: 'task_updated', taskId: action.taskId, changes: action.changes }));

    case 'statusUpdate': {
      if (stale(state, action.sessionId)) return step(state);
      const next = foldRun(state, {
        type: 'status_update',
        tasks: action.tasks,
        ...(action.runMerge !== undefined ? { runMerge: action.runMerge } : {}),
        ...(action.usage !== undefined ? { usage: action.usage } : {}),
        ...(action.activity !== undefined ? { activity: action.activity } : {}),
        ...(action.escalations !== undefined ? { escalations: action.escalations } : {}),
      });
      // The indicator follows the run's own activity first, then the tasks:
      // beginning a run is "starting" until it claims, and once none is
      // running the run is over, whatever the scheduler still holds armed.
      const status = runStatus(next, next.tasks);
      return step({ ...next, status });
    }

    case 'isolationBlocked': {
      if (stale(state, action.sessionId)) return step(state);
      return step(blockedPicker(state, action.message, action.repos));
    }

    case 'isolationHandoff': {
      if (stale(state, action.sessionId)) return step(state);
      // Announce against the handoff the pane already held — a deferred one for
      // the same run words the follow-up as the supervisor leaving it — then
      // fold the fresh handoff into the run view.
      const announced = handoffArrived(state, action.handoff);
      return step(foldRun(announced, { type: 'isolation_handoff', ...action.handoff }));
    }

    case 'handoffDiff': {
      if (stale(state, action.sessionId)) return step(state);
      return step(showDiff(state, action.diff));
    }

    // What Merge all did, folded the way the Session says it: a merge that
    // leaves the run going keeps the marks (ADR-0020), and only `run_closed`
    // takes them (below).
    case 'isolationMerged': {
      if (stale(state, action.sessionId)) return step(state);
      return step(withoutHandoffOverlay(foldRun(state, { type: 'isolation_merge', result: action.result })));
    }

    case 'runClosed': {
      if (stale(state, action.sessionId)) return step(state);
      return step(withoutHandoffOverlay(foldRun(state, { type: 'run_closed' })));
    }

    case 'executionComplete': {
      if (stale(state, action.sessionId)) return step(state);
      // A stop sends no tally, and defaulting it to zero reported a run halted
      // after four of five tasks as "0/5 complete". The pane already holds the
      // per-task statuses the daemon streamed, so count them.
      const { completed, total, failed, blocked, skipped } = action.summary ?? {
        completed: state.tasks.filter((t) => t.status === 'completed').length,
        total: state.tasks.length,
        failed: state.tasks.filter((t) => t.status === 'failed').length,
        blocked: blockingFailures(state.tasks).size,
        skipped: state.tasks.filter((t) => t.status === 'skipped').length,
      };
      const failures = `${failed > 0 ? ` · ${failed} failed` : ''}${blocked ? ` · ${blocked} blocked` : ''}${skipped ? ` · ${skipped} skipped` : ''}`;
      const verb = action.stopped ? 'stopped' : 'finished';
      return step({
        ...say(state, 'system', `Execution ${verb}: ${completed}/${total} tasks complete${failures}.`),
        status: 'idle',
      });
    }

    // Its own turn's plan comes back on the call `converse` awaits; the copy
    // broadcast meanwhile would settle the turn before its reply is spoken.
    // It still goes on the pane: autorun and the planner's run tools start
    // its tasks inside that turn, and their updates need tasks to land on.
    case 'planBroadcast':
      if (stale(state, action.sessionId)) return step(state);
      if (plannerInFlight(state)) return step(showPlan(state, action.plan));
      return reduceAction(state, { type: 'planUpdated', plan: action.plan, sessionId: action.sessionId });

    // The follow is the only subscription open while nothing runs, so losing
    // it stops live updates entirely: say so, and let the effects side retry
    // without sending this notice again until a reconnect opens.
    case 'followLost': {
      if (stale(state, action.sessionId)) return step(state);
      if (state.status === 'executing' || state.status === 'starting') return reduceAction(state, { type: 'executionLost', sessionId: action.sessionId });
      return step(say(state, 'system', 'Lost the connection to the daemon; reconnecting to follow this session.'));
    }

    // A follow that opens again may be the only way a lost reply's turn end
    // arrives, or a joined turn's: its socket was gone when the daemon broadcast it.
    case 'followRestored':
      if (stale(state, action.sessionId) || (state.planner !== 'awaiting' && state.planner !== 'compacting' && state.planner !== 'joined')) return step(state);
      return step(state, [{ type: 'reconcileTurn', sessionId: action.sessionId }]);

    case 'executionLost': {
      if (stale(state, action.sessionId)) return step(state);
      // Statuses stay as last reported: the daemon still serves the live store
      // and may be running these, so 'pending' would be a guess against a run
      // that is still going.
      return step({
        ...say(state, 'error', 'Lost the connection to the daemon: this view is no longer following the run, but the daemon may still be running it. /load this session again to see where it stands.'),
        status: 'idle',
      });
    }

    case 'settingsLoaded': {
      // An open /settings or /planner marks the current value from what the daemon now holds.
      const { read } = action;
      // A read names the session it answers for. One for a session the user
      // has left, or a write's answer, still carries the workspace's settings,
      // but must not paint its run values over this session's, nor advance
      // this session's run watermark and drop a read on its way (ADR-0030).
      const forThisSession = action.sessionId === undefined
        ? read === undefined || state.sessionId === null
        : action.sessionId === state.sessionId;
      const workspaceFresh = read === undefined || read >= state.settingsRead;
      const runFresh = forThisSession && (read === undefined || read >= state.runSettingsRead);
      if (!workspaceFresh && !runFresh) return step(state);
      const next = workspaceFresh
        ? applySettings(state, action.settings, runFresh)
        : applySettings(state, { run: action.settings.run }, true);
      return step(refreshStepper({
        ...next,
        settingsRead: read !== undefined && workspaceFresh ? Math.max(state.settingsRead, read) : state.settingsRead,
        runSettingsRead: read !== undefined && runFresh ? Math.max(state.runSettingsRead, read) : state.runSettingsRead,
      }));
    }

    case 'modelsLoaded':
      return step(refreshStepper(
        refillPicker(
          {
            ...state,
            models: action.models,
            orchestratorModels: action.orchestratorModels ?? state.orchestratorModels,
            configuredProviders: action.providers ?? state.configuredProviders,
            providersKnown: state.providersKnown || action.providers !== undefined,
            providerErrors: action.providerErrors ?? state.providerErrors,
            modesByRunner: action.modesByRunner ?? state.modesByRunner,
          },
          ['set-task-model', 'set-task-effort', 'set-task-mode'],
        ),
      ));

    case 'sessionsLoaded':
      return step(refillPicker({ ...state, sessions: action.sessions }, ['load-session', 'delete-session']));

    case 'rewindTargetsLoaded':
      if (stale(state, action.sessionId)) return step(state);
      if (action.pick !== undefined) return pickRewindTarget({ ...state, rewindTargets: action.targets }, action.pick);
      return step(refillPicker({ ...state, rewindTargets: action.targets }, ['rewind']));

    // A fork holds no run and no turn, whatever the session it came from was
    // doing — the original keeps both, and its events are stale from here on.
    // Its plan arrives next, onto an empty run view. Nor does it keep an open
    // prompt editor: the fork copies the task ids, so Enter would save the
    // original's draft into the fork.
    case 'sessionForked':
      return step(withRun({
        ...state,
        sessionId: action.sessionId,
        goal: action.goal,
        taskView: null,
        expandedTaskId: null,
        taskEditor: null,
        status: 'idle',
        planner: 'idle',
        turnGate: NO_TURN,
        planApproved: false,
        pendingApprovals: [],
        queuedPrompts: EMPTY_HOLD,
        stopArmed: false,
        stopRequested: false,
        forceSendPending: null,
        overlay: state.overlay?.kind === 'approval' ? null : state.overlay,
        runSettingsKnown: false,
      }, EMPTY_RUN));

    // The rewound message comes back as a draft to edit and resend, so it lands
    // as if just typed: history is not being browsed, and nothing is parked.
    case 'inputPrefilled':
      if (stale(state, action.sessionId)) return step(state);
      return step({
        ...state,
        focus: 'chat',
        editor: { ...state.editor, text: action.text, cursor: action.text.length, historyIndex: state.editor.history.length, draft: '' },
      });

    case 'sharedSettingsChanged':
      return step(state, [{ type: 'loadScope', ...(state.sessionId ? { sessionId: state.sessionId } : {}) }]);

    case 'runnersLoaded':
      // Installed runners are `/planner`'s preflight signal, so a stepper
      // opened before discovery landed fills in rather than sitting there
      // claiming every agent is missing.
      return step(refreshStepper(reseedRunnerChoice(state, refillPicker({
        ...state,
        runners: action.runners,
        runnersKnown: true,
        orchestratorModel: action.orchestratorModel ?? state.orchestratorModel,
      }, ['set-task-runner']))));

    // The preview's reads can overlap: a launch refresh and a settings change
    // both ask, and the daemon may answer the first one last. Only an answer
    // from the newest read may touch the welcome.
    case 'isolationPreviewLoading':
      return action.read < state.isolationPreviewRead
        ? step(state)
        : step({ ...state, isolationPreview: null, isolationPreviewRead: action.read });

    case 'isolationPreviewLoaded':
      return action.read < state.isolationPreviewRead
        ? step(state)
        : step({ ...state, isolationPreview: action.preview, isolationPreviewRead: action.read });

    case 'isolationPreviewFailed':
      return action.read < state.isolationPreviewRead
        ? step(state)
        : step({
          ...state,
          isolationPreview: { status: 'failed', repos: [], shared: [], error: action.message },
          isolationPreviewRead: action.read,
        });

    // A replacement daemon may serve another configuration and another
    // workspace tree; the welcome asks again rather than keeping the old one.
    case 'daemonReconnected':
      return step(state, [{ type: 'loadIsolationPreview' }]);

    case 'failed': {
      // Dropped only once another session is on screen: a session that let
      // itself go (`sessionCleared`) reports why onto the welcome it left.
      if (state.sessionId !== null && stale(state, action.sessionId)) return step(state);
      // A failed call may have been the task view's log read; the view falls
      // back to whatever the live stream sent rather than waiting forever.
      if (!action.turn) {
        const abandoned = reportError(taskLogAbandoned(state), action.message);
        // A whole-plan start answered nothing but this failure: no run is on
        // its way, so the start indicator must not outlive it.
        return step(state.status === 'starting' ? { ...abandoned, status: 'idle' } : abandoned);
      }
      // A force send stopped the turn in flight; the forced turn is already on
      // its way, so the stop is not news and the prompts held behind it keep
      // their order rather than draining into the turn replacing it. Only the
      // stop is that: any other failure is the forced send's own, and its
      // prompt is already out of the composer or the queue, so it goes back.
      if (state.forceSendPending) {
        if (action.code === 'planner_turn_stopped') return step({ ...state, forceSendPending: null, planner: plannerInFlight(state) ? 'planning' : 'idle' });
        state = restoreForced(state);
      }
      const quiet = plannerInFlight(state) && state.stopRequested;
      // The daemon's own end for a compaction may have been lost with the call.
      const settled = state.planner === 'condensing' ? endRunningCompactions(state, quiet || action.code === 'planner_turn_stopped' ? 'stopped' : 'failed') : state;
      const reported = {
        ...(quiet ? settled : reportError(settled, action.message)),
        planner: 'idle' as const,
        // A start that never reached the daemon has no run to wait for: the
        // spinner must not outlive the failure that answered it.
        status: state.status === 'starting' ? 'idle' as const : state.status,
      };
      // A planner turn dying IS a turn ending — the queue would otherwise wait
      // on a next one that never comes.
      if (!plannerInFlight(state)) return step(reported);
      return drainQueue(state, reported);
    }

    // As `failed`: an opening that let itself go asks on the welcome it left,
    // never over a session loaded meanwhile.
    case 'workspaceNeedsInit':
      if (state.sessionId !== null && stale(state, action.sessionId)) return step(state);
      return step({
        ...state,
        planner: 'idle',
        overlay: {
          kind: 'confirm',
          title: 'Initialize new workspace?',
          message: `"${action.workspace}" isn't a recognized project yet (no .git or manifest found). Start a new ordewell workspace here?`,
          action: { kind: 'init-workspace', goal: action.goal, workspace: action.workspace },
        },
      });

    // A refused opening stays on screen while the daemon is revived; the
    // user may have moved to another session or a fresh welcome since, and
    // that view, its queue and its planner are not the opening's to take.
    case 'openingRevived': {
      const restarted = 'The server had stopped; started a new one';
      if (stale(state, action.sessionId)) {
        return step(say(state, 'system', `${restarted}. "${action.goal}" was not sent again, as it is no longer the session on screen.`));
      }
      // Stopped, or ended, while the daemon was down: the opening reached no
      // server, so there is no turn to wait on, no session to keep, and no run
      // settings of its own that the welcome's would have to be read back over.
      if (!plannerInFlight(state) || state.stopRequested) {
        const cleared = reduceAction(state, { type: 'sessionCleared', sessionId: action.sessionId, unreached: true }).state;
        return step(say({ ...cleared, planner: 'idle', stopRequested: false }, 'system', `${restarted}. The goal was not sent again, as planning was stopped.`));
      }
      const retry: Effect = { type: 'startConversation', goal: action.goal, sessionId: action.sessionId, ...(action.allowInit ? { allowInit: true } : {}) };
      return step(say(state, 'system', `${restarted} and retried.`), [retry]);
    }

    case 'notice':
      if (stale(state, action.sessionId)) return step(state);
      return step(say(state, action.level === 'error' ? 'error' : 'system', action.message, !action.holdPlace));

    case 'resize': {
      // A grown pane can leave both offsets pointing past the end of content
      // that now fits; re-clamping here keeps "the offset is always reachable"
      // true for the keys handled next, not just for the ones handled last.
      // The selection goes rather than moves: it names screen cells, and a
      // resize both re-wraps what is under them and shifts the divider — so a
      // span anchored where the plan pane used to begin would end up straddling
      // the new one, which is exactly the splice pinning a pane prevents.
      const resized = { ...state, rows: action.rows, cols: action.cols, selection: null };
      return step(settlePanes(resized));
    }

    // Whether there is anything to animate is the app loop's call (it owns the
    // timer); a tick that arrives simply advances the frame.
    case 'spinnerTick':
      return step({ ...state, spinnerFrame: (state.spinnerFrame + 1) % SPINNER_CYCLE });

    // The scheduled expiry of an armed stop; a token that is no longer the live
    // arm is a stale timer (the user disarmed and re-armed in between) and is
    // ignored, so it cannot cut a newer arm short.
    case 'stopDisarmed':
      if (!state.stopArmed || action.arm !== state.stopArmToken) return step(state);
      return step(disarmStop(state));
  }
}

/**
 * The overlay a merge or discard was confirmed from is closed with the handoff
 * it showed; one opened since (a picker, help) has nothing to do with the run.
 */
function withoutHandoffOverlay(state: TuiState): TuiState {
  return state.handoff || state.overlay?.kind !== 'handoff' ? state : { ...state, overlay: null };
}

/** A plan onto the pane, whether or not it ends a planner turn. */
function showPlan(state: TuiState, plan: unknown): TuiState {
  // The plan folds into the run view, which keeps every status-only field
  // the stream last reported — a checkpoint, continuable, a merge gate. A
  // saved plan's isolation record is read on top, since a load had no live
  // stream to tell it; a planner reply carries none and leaves it as it was.
  const folded = foldRun(state, planSnapshot(plan));
  const { tasks } = folded;
  // A plan refresh can supersede the task whose prompt is open; the editor
  // survives only while its task does. The cursor is clamped against the
  // visible rows afterwards, so an expanded parent's subtasks count.
  // `findTask` walks subtasks too — the expanded id is a subtask's as often
  // as a top-level task's.
  const expandedTaskId =
    state.expandedTaskId && findTask(tasks, state.expandedTaskId) ? state.expandedTaskId : null;
  const next: TuiState = {
    ...folded,
    plannerResend: plannerResendOf(plan),
    plannerPause: plannerPauseOf(plan),
    expandedTaskId,
    taskEditor: expandedTaskId !== null ? state.taskEditor : null,
  };
  return settlePlan({
    ...next,
    selectedTask: clampSelection(state.selectedTask, planRows(next).length),
    focus: tasks.length === 0 ? 'chat' : state.focus,
  });
}

/** What the plan says waits on the planner's usage limit; a hold with no time goes with the next message, so there is nothing to show. */
function plannerResendOf(plan: unknown): TuiState['plannerResend'] {
  const saved = (plan as { plannerResend?: { runner?: unknown; at?: unknown } } | null | undefined)?.plannerResend;
  if (typeof saved?.at !== 'string') return null;
  return { ...(typeof saved.runner === 'string' ? { runner: saved.runner } : {}), at: saved.at };
}

/** What the plan says of a planner paused on its context: why is in the transcript, so only the model is kept. */
function plannerPauseOf(plan: unknown): TuiState['plannerPause'] {
  const saved = (plan as { plannerContextPause?: { model?: unknown } } | null | undefined)?.plannerContextPause;
  return saved ? { model: typeof saved.model === 'string' ? saved.model : 'the planner model' } : null;
}

function runStatus(state: TuiState, tasks: TaskView[]): RunStatus {
  // The run's own authoritative word first: an admitted start that has not
  // claimed is "starting", never "executing", and a claimed one is running
  // even if the first status tick has not caught up yet.
  const activity = state.run.activity;
  if (activity?.starting) return 'starting';
  if (activity?.running) return 'executing';
  if (tasks.some(isTaskRunning)) return 'executing';
  // A task waiting on the user is not executing, but the run is not over
  // either — the indicator says it waits rather than going idle. A run paused
  // at a merge gate waits on the user the same way.
  if (tasks.some((t) => t.status === 'awaiting_user') || state.runMerge?.paused) return 'executing';
  return 'idle';
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
  // A notice answers the key that was refused: the next key that is not a
  // scroll dismisses it, so the view's key hints come back.
  if (state.taskView?.notice && !isScrollKey(key)) state = clearNotice(state);
  if (key.name === 'ctrl-c') return interrupt(state);
  if (key.name === 'ctrl-d' && !state.editor.text && !state.overlay) {
    return step({ ...state, exiting: true }, [{ type: 'exit' }]);
  }
  if (key.name === 'ctrl-l') return step({ ...state, conversation: wiped(state.conversation), scroll: 0 });
  // A chat-pane switch: the plan pane's rows are never truncated, so there is
  // nothing there to expand. It is open mid-turn on purpose — reading the
  // stream in full as it lands is where full detail matters most.
  if (key.name === 'ctrl-o' && state.focus === 'chat' && !state.overlay) return toggleDetail(state);

  // ESC backs out of whichever side the TAB selection is on. While the plan
  // pane has something of its own open, Esc collapses that first and the task
  // view is left as it was; otherwise a task-chat Esc clears the draft, then
  // closes the view onto the plan with the cursor on that task. An open overlay
  // still owns Esc ahead of both, so /help closes before either.
  if (key.name === 'escape' && state.taskView && !state.overlay && !planPaneOpen(state)) {
    if (state.editor.text) return step({ ...state, editor: { ...state.editor, text: '', cursor: 0 } });
    return step(returnToPlan(state, state.taskView.taskId));
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
    const matches = token ? composerCompletions(token, state.taskView ? taskLogCommands(state.taskView.view) : null) : [];
    if (token && matches.length > 0) {
      const { text: full } = state.editor;
      const completed = `/${matches[0]} `;
      const text = full.slice(0, token.start) + completed + full.slice(token.end);
      return step({ ...state, editor: { ...state.editor, text, cursor: token.start + completed.length } });
    }
  }
  if (key.name === 'tab') {
    // The pane is hidden while the plan is empty, so there is nothing to focus.
    if (state.focus === 'chat' && state.tasks.length === 0) return step(state);
    return step(settlePanes({ ...state, focus: state.focus === 'chat' ? 'plan' : 'chat' }));
  }
  if (state.focus === 'plan') return handlePlanKey(state, key);

  // The task view's own keys (attempts, queued messages, interrupt) sit ahead
  // of the editor; anything they decline still types into the composer.
  if (state.taskView) {
    const handled = handleTaskViewKey(state, key);
    if (handled) return handled;
    // A script's log is read-only output (ADR-0035): attempts and scrolling
    // still read it, but nothing types, sends, interrupts or answers there.
    if (scriptTaskView(state)) {
      const scroll = scrollDelta(key, state, 'chat');
      return scroll !== null ? scrollChat(state, scroll) : step(state);
    }
  }

  if (key.name === 'enter') return submit(state);
  // Send now in the planner chat (ADR-0023, F5): mid-turn it interrupts the
  // turn and sends the composer text (or the newest queued prompt) next; with
  // no turn in flight it is the plain send enter is. A TUI command in the
  // composer is not a message to send, so it runs as it does on enter.
  if (key.name === 'ctrl-s') {
    return (plannerInFlight(state) || state.turnGate.open !== null) && !builtInCommand(state.editor.text) ? forceSendPlanner(state) : submit(state);
  }
  if (key.name === 'escape') return step({ ...state, editor: { ...state.editor, text: '', cursor: 0 } });
  // Page keys and the wheel scroll the transcript. Up/down always go to the
  // editor: single-line drafts get history recall, multi-line drafts get cursor
  // movement between wrapped lines.
  const scroll = scrollDelta(key, state, 'chat');
  if (scroll !== null) return scrollChat(state, scroll);

  const multilineEditor = state.editor.text.includes('\n');
  // Keys only reach the editor while it has focus, which is exactly when the
  // renderer reserves the caret column.
  const room = chatEditorRoomFor(state, true);
  return step({ ...state, editor: applyKey(state.editor, key, multilineEditor ? room : undefined) });
}

/**
 * Only a built-in is dispatched by the TUI. In planner chat a skill-backed or
 * unregistered /name goes to the planner like any other message, literal
 * /name and all, so the daemon's own skill resolution (see
 * resolveSkillInvocation) loads Ordewell's skill before a coding-agent
 * planner ever sees the token and tries to resolve it itself.
 */
function builtInCommand(text: string): ParsedCommand | null {
  const command = parseSlash(text);
  const known = command && findCommand(command.name);
  return command && known && known.source !== 'skill' ? command : null;
}

function submit(state: TuiState): Step {
  const text = state.editor.text.trim();
  if (!text) return step(state);

  const cleared: TuiState = { ...state, editor: commit(state.editor) };

  // The task view's composer talks to the runner, not the planner: the daemon
  // queues the message (or delivers it to a waiting task) and the log shows it.
  // A finished task has no turn to message; its composer continues it instead.
  // Its slash namespace is the runner's alone (#66), ahead of Ordewell's.
  if (state.taskView) {
    if (!state.sessionId) return step(state);
    const taskId = state.taskView.taskId;
    const task = findTask(state.tasks, taskId);
    const command = parseRunnerCommand(text);
    const offered = taskLogCommands(state.taskView.view);
    if (command && offered.length > 0 && !runnerCommandFor(offered, command.name)) {
      const notice = `/${command.name} is not a command ${task?.assignedRunner ?? 'the runner'} offers this task: type / to see them.`;
      return step({ ...cleared, taskView: { ...state.taskView, notice } });
    }
    if (state.taskView.notice) cleared.taskView = { ...state.taskView, notice: undefined };
    // At a checkpoint a plain message is refused by the daemon, so enter is the
    // answer: the text is the reason a rejection carries, and the runner goes
    // on in the same session following it. A tool request ahead of it is
    // answered first, and the draft stays for after.
    if (!command && waitingCheckpoint(task)) {
      if (waitingApproval(state.taskView)) {
        return step(say(state, 'system', 'A tool request is waiting ahead of the checkpoint: answer it first (ctrl-y to allow, ctrl-g to deny), then enter replies to the checkpoint.'));
      }
      return answerCheckpoint(cleared, state.sessionId, taskId, 'reject', text);
    }
    // A resumed runner reads a command that opens its first turn as it would any.
    if (continuesTask(task)) return continueTaskStep(cleared, state.sessionId, taskId, text);
    if (command && offered.length > 0) return step(cleared, [{ type: 'invokeTaskCommand', sessionId: state.sessionId, taskId, ...command }]);
    return step(cleared, [{ type: 'sendTaskMessage', sessionId: state.sessionId, taskId, text }]);
  }

  const builtIn = builtInCommand(text);
  if (builtIn) return runCommand(cleared, builtIn);

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

  return step({ ...spoken, planner: 'planning', stopRequested: false, forceSendPending: null }, [effect]);
}

/** Close the task view onto the plan pane, the cursor on the task that was open. */
function returnToPlan(state: TuiState, taskId: string): TuiState {
  const closed: TuiState = { ...state, taskView: null, scroll: 0, focus: 'plan' };
  // Revealing the parent mirrors the pane's own first right-arrow, so the
  // subtask row exists to land on.
  const parent = state.tasks.find((t) => t.subtasks?.some((s) => s.id === taskId));
  const revealed = parent ? { ...closed, expandedTaskId: parent.id, taskEditor: null } : closed;
  const index = planRows(revealed).findIndex((r) => r.task.id === taskId);
  if (index < 0) return closed;
  return settlePlan({ ...revealed, selectedTask: index });
}
