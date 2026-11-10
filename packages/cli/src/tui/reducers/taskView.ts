import { observeTaskServedModel } from '../accountLimits';
import { EMPTY_TASK_LOG_FOLLOW, followTaskLog, parseCount, resumeLabel, runnerToolSubject, taskRowView, truncateCheckpointSummary, type ApprovalDecision, type QueuedTaskMessage } from '@ordewell/core';
import { commit } from '../editor';
import type { Key } from '../keys';
import { continuesTask, findTask, newestRemovable, refFor, queuedTarget, removable, resumesTask, scriptTaskView, waitingApproval, waitingCheckpoint, type TaskLogState, type TuiState } from '../state';
import { say } from '../transcript';
import { fail, step, type Step, type Action } from './shared';

/*
 * The chat pane swapped for one task's log (ADR-0018, V1). Opening
 * reads the saved log so the view has its history; the live `task_log` stream
 * then folds into the same core view, deduped against what the file already
 * held.
 */

/** Open a task's log in the chat pane, reading its latest saved attempt first. */
export function openTaskView(state: TuiState, sessionId: string, taskId: string): Step {
  const task = findTask(state.tasks, taskId);
  if (!task) return fail(state, `No task ${taskId} in this plan.`);
  // Enter and /open reach a chat only once an attempt exists: a status or a
  // manual mark is not an attempt. Staying put is the point — no empty view.
  if (!taskRowView(task).chatAvailable) {
    return fail(state, 'This task hasn’t started yet. Its chat becomes available when it starts.');
  }
  const taskView: TaskLogState = {
    taskId,
    ...EMPTY_TASK_LOG_FOLLOW,
    queuedIndex: null,
  };
  // Focus the composer: the task view's whole point is talking to the runner.
  return step({ ...state, taskView, focus: 'chat', scroll: 0 }, [{ type: 'openTaskLog', sessionId, taskId }]);
}

/**
 * Continue a task with `text`, opening its view if another pane is showing.
 * The view follows the new attempt; earlier ones stay reachable with alt←.
 */
export function continueTaskStep(state: TuiState, sessionId: string, taskId: string, text: string): Step {
  const opened = state.taskView?.taskId === taskId
    ? step({ ...state, taskView: { ...state.taskView, followLatest: true } })
    : openTaskView(state, sessionId, taskId);
  // Like a retry, it spawns a runner, so a TUI not already watching a run
  // holds the execution stream open to see it (see `taskActionEffect`).
  const watch = state.status !== 'executing';
  return step(opened.state, [...opened.effects, { type: 'continueTask', sessionId, taskId, text, ...(watch ? { watch: true } : {}) }]);
}

/** The queue's own bookkeeping once the log moved it: the pick stays on a row, and a removal the log has shown is no longer awaited. */
function clampQueueIndex(tv: TaskLogState): TaskLogState {
  const removing = tv.removing?.filter((id) => tv.view.queued.some((m) => m.id === id));
  const settled = removing && removing.length !== tv.removing?.length ? { ...tv, removing } : tv;
  if (settled.queuedIndex === null) return settled;
  if (settled.view.queued.length === 0) return { ...settled, queuedIndex: null };
  const max = settled.view.queued.length - 1;
  return settled.queuedIndex <= max ? settled : { ...settled, queuedIndex: max };
}

/**
 * Asks the daemon to take a queued message back. Its row goes only when the
 * log says so; `fill` puts its text in the composer meanwhile, which a refusal
 * takes out again (see `taskMessageKept`).
 */
function askRemoval(state: TuiState, tv: TaskLogState, sessionId: string, message: QueuedTaskMessage, fill: boolean): Step {
  const editor = fill
    ? { ...state.editor, text: message.text, cursor: message.text.length, historyIndex: state.editor.history.length, draft: '' }
    : state.editor;
  return step({ ...state, editor, taskView: { ...tv, removing: [...(tv.removing ?? []), message.id] } }, [
    { type: 'removeTaskMessage', sessionId, taskId: tv.taskId, messageId: message.id, ...(fill ? { filled: message.text } : {}) },
  ]);
}

/**
 * Esc on a task's queue: the newest message the runner can still give back
 * comes out of it, into the composer only while that is empty, else it is
 * dropped. Null when there is none, so Esc goes on to the draft and the way
 * back. A child's queue has no route for removal, so its Esc is the way back.
 */
export function takeBackNewest(state: TuiState): Step | null {
  const tv = state.taskView;
  if (!tv || !state.sessionId || state.child || scriptTaskView(state)) return null;
  const newest = tv.view.queued[newestRemovable(tv)];
  return newest ? askRemoval(state, tv, state.sessionId, newest, !state.editor.text.trim()) : null;
}

/**
 * The runner took the message before the removal reached it. The words Esc
 * put in the composer come out again, unless the person has typed over them,
 * since keeping them would send the message twice.
 */
export function taskMessageKept(state: TuiState, action: Extract<Action, { type: 'taskMessageKept' }>): TuiState {
  const editor = action.filled !== undefined && state.editor.text === action.filled ? { ...state.editor, text: '', cursor: 0 } : state.editor;
  const tv = state.taskView;
  if (!tv || tv.taskId !== action.taskId) return say({ ...state, editor }, 'system', action.message);
  const removing = tv.removing?.filter((id) => id !== action.messageId);
  return { ...state, editor, taskView: { ...tv, removing, notice: action.message } };
}

export function taskLogAbandoned(state: TuiState): TuiState {
  const tv = state.taskView;
  if (!tv || tv.loaded) return state;
  return { ...state, taskView: clampQueueIndex({ ...tv, ...followTaskLog(tv, { type: 'loaded', attempt: tv.attempt, events: [], abandoned: true }) }) };
}

export function taskLogArrived(state: TuiState, action: Extract<Action, { type: 'taskLog' }>): TuiState {
  state = observeTaskServedModel(state, action);
  const tv = state.taskView;
  if (!tv || tv.taskId !== action.taskId) return state;
  const next = followTaskLog(tv, { ...action, type: 'live' });
  return { ...state, taskView: next === tv ? tv : clampQueueIndex({ ...tv, ...next }) };
}

/**
 * A runner asking for approval is announced wherever the user is (ADR-0018,
 * A1), except in the view already showing its card: the task may be one the
 * user is not watching, and it waits until someone answers. Another task's
 * open view keeps its place.
 */
export function announceApprovals(state: TuiState, action: Extract<Action, { type: 'taskLog' }>): TuiState {
  if (state.taskView?.taskId === action.taskId) return state;
  const task = findTask(state.tasks, action.taskId);
  const way = task ? `tab to the plan, select task ${refFor(state, task)} and press enter (or /open ${refFor(state, task)})` : 'tab to the plan, select it and press enter';
  const spoken = action.events.reduce((s, event) => (event.type === 'approval_requested' && !event.decided
    ? say(s, 'system', `Task ${task ? refFor(state, task) : '?'} waits for approval: ${runnerToolSubject(event.tool, event.args)}: ${way}, then ctrl-y allows or ctrl-g denies`)
    : s), state);
  return spoken !== state ? { ...spoken, scroll: state.scroll } : spoken;
}

/**
 * A task's checkpoint question, said in the chat pane wherever the user is:
 * the first line of it, and where the whole of it can be answered.
 */
export function announceCheckpoint(state: TuiState, action: Extract<Action, { type: 'taskCheckpoint' }>): TuiState {
  const task = findTask(state.tasks, action.taskId) ?? state.tasks.find((t) => t.title === action.title);
  const label = task ? `Task ${refFor(state, task)}` : action.title;
  const where = task ? `tab to the plan, select task ${refFor(state, task)} and press enter (or /open ${refFor(state, task)}) to answer` : 'tab to the plan, select it and press enter to answer';
  const spoken = say(state, 'system', `${label} asks: ${truncateCheckpointSummary(action.summary)}: ${where}`);
  return { ...spoken, scroll: state.scroll };
}

export function taskLogLoaded(state: TuiState, action: Extract<Action, { type: 'taskLogLoaded' }>): TuiState {
  state = observeTaskServedModel(state, action);
  const tv = state.taskView;
  if (!tv || tv.taskId !== action.taskId) return state;
  return { ...state, taskView: clampQueueIndex({ ...tv, ...followTaskLog(tv, { ...action, type: 'loaded' }) }) };
}

/**
 * Answer the waiting request (ADR-0018, A1). A denial takes what is in the
 * composer as its note to the agent, so the note is written the way any
 * message to the task is, and the composer is emptied once it is sent.
 */
function answerApproval(state: TuiState, tv: TaskLogState, sessionId: string, decision: ApprovalDecision['decision']): Step {
  const approval = waitingApproval(tv);
  if (!approval?.approvalId) return step(say(state, 'system', 'Nothing is waiting for approval.'));
  if (decision === 'allowForTask' && !approval.allowForTask) {
    return step(say(state, 'system', 'The runner offered no grant for the rest of this task: ctrl-y allows this call.'));
  }
  const note = decision === 'deny' ? state.editor.text.trim() : '';
  const answer: ApprovalDecision = decision === 'deny' ? { decision, ...(note ? { note } : {}) } : { decision };
  const next = note ? { ...state, editor: { ...state.editor, text: '', cursor: 0 } } : state;
  return step(next, [{ type: 'answerTaskApproval', sessionId, approvalId: approval.approvalId, answer }]);
}

/**
 * Answer the checkpoint a task waits at. Only a rejection carries a reason, so
 * an approval has nowhere to put a note. The daemon says if the task is no
 * longer waiting, so a checkpoint settled elsewhere is not pre-judged here.
 */
export function answerCheckpoint(state: TuiState, sessionId: string, taskId: string, answer: 'approve' | 'reject', reason = '', raiseTokens?: number): Step {
  const task = findTask(state.tasks, taskId);
  if (!waitingCheckpoint(task)) return step(say(state, 'system', `Task ${task?.order ?? taskId} is not waiting at a checkpoint.`));
  // A delegated task's approval reaches its subplanner, and only there does one carry words (ADR-0056 M8).
  const note = answer === 'reject' || task?.type === 'delegated' ? reason.trim() : '';
  return step(state, [{ type: 'answerTaskCheckpoint', sessionId, taskId, answer, ...(note ? { reason: note } : {}), ...(raiseTokens !== undefined ? { raiseTokens } : {}) }]);
}

/**
 * ctrl-y and ctrl-g: a waiting tool request answers first, then the checkpoint.
 * A rejection takes the composer's text as its reason, as a denial takes its
 * note, and empties the composer once sent.
 */
function answerWaiting(state: TuiState, tv: TaskLogState, sessionId: string, decision: 'allow' | 'deny'): Step {
  if (waitingApproval(tv) || !waitingCheckpoint(findTask(state.tasks, tv.taskId))) return answerApproval(state, tv, sessionId, decision);
  if (decision === 'allow') {
    // A delegated task's Approve can carry a raise (ADR-0056 M5): only its budget is a number to type here.
    const raiseTokens = findTask(state.tasks, tv.taskId)?.type === 'delegated' ? parseCount(state.editor.text.trim(), 1) ?? undefined : undefined;
    const approved = answerCheckpoint(state, sessionId, tv.taskId, 'approve', '', raiseTokens);
    return raiseTokens === undefined ? approved : { ...approved, state: { ...approved.state, editor: { ...approved.state.editor, text: '', cursor: 0 } } };
  }
  const answered = answerCheckpoint(state, sessionId, tv.taskId, 'reject', state.editor.text);
  return state.editor.text.trim() ? { ...answered, state: { ...answered.state, editor: { ...answered.state.editor, text: '', cursor: 0 } } } : answered;
}

/**
 * Force send (ADR-0023, F1): the composer's text or, with the composer empty,
 * the oldest queued message the runner can still be handed, interrupting the
 * running turn to go next. The daemon glues the rest of the queue behind
 * either, in the order typed, so send now sends everything waiting at once and
 * a pick has nothing to choose.
 */
function sendNow(state: TuiState, tv: TaskLogState, sessionId: string): Step {
  const text = state.editor.text.trim();
  if (text) {
    const task = findTask(state.tasks, tv.taskId);
    if (continuesTask(task)) {
      return step(say(state, 'system', resumesTask(task)
        ? 'The task is paused on a usage limit, so there is no turn to interrupt: enter resumes it.'
        : 'The task has finished, so there is no turn to interrupt: enter continues it.'));
    }
    return step({ ...state, editor: commit(state.editor) }, [{ type: 'forceSendTaskMessage', sessionId, taskId: tv.taskId, text }]);
  }
  const queued = tv.view.queued.find((m) => removable(tv, m));
  if (!queued) return step(say(state, 'system', 'Nothing to send now: type a message first.'));
  // The forced message moves to the head of the queue, so a pick by index
  // would land on another one; the default follows the newest instead.
  return step({ ...state, taskView: { ...tv, queuedIndex: null } }, [
    { type: 'forceSendQueuedTaskMessage', sessionId, taskId: tv.taskId, messageId: queued.id },
  ]);
}

/**
 * The task view's own keys. Everything else — enter, escape, the editor, the
 * page keys — falls through to the normal chat-pane handling, so typing and
 * scrolling work exactly as in the planner chat.
 */
export function handleTaskViewKey(state: TuiState, key: Key): Step | null {
  const tv = state.taskView;
  if (!tv || !state.sessionId) return null;

  if (key.name === 'alt-left' || key.name === 'alt-right') {
    const index = tv.attempts.indexOf(tv.loadingAttempt ?? tv.attempt);
    if (index < 0) return null;
    const target = key.name === 'alt-left' ? index - 1 : index + 1;
    const attempt = tv.attempts[target];
    if (attempt === undefined) {
      return step(say(state, 'system', target < 0 ? 'This is the first attempt.' : 'This is the latest attempt.'));
    }
    return step(
      { ...state, taskView: { ...tv, ...followTaskLog(tv, { type: 'picked', attempt }) } },
      [{ type: 'loadTaskAttempt', sessionId: state.sessionId, taskId: tv.taskId, attempt }],
    );
  }

  // A script runs no model (ADR-0035): its log has no turn to queue, send,
  // interrupt or answer, so only the attempt switch above reads it.
  if (scriptTaskView(state)) return null;

  if (key.name === 'ctrl-r') {
    const queued = tv.view.queued[queuedTarget(tv)];
    if (!queued) return step(say(state, 'system', 'No queued message to remove.'));
    if (queued.handedOver) return step(say(state, 'system', 'The runner already has that message; it can no longer be taken back.'));
    if (tv.removing?.includes(queued.id)) return step(state);
    return askRemoval(state, tv, state.sessionId, queued, false);
  }

  if (key.name === 'ctrl-s') return sendNow(state, tv, state.sessionId);

  if (key.name === 'ctrl-x') {
    // Paused on a usage limit there is no turn to interrupt, only a resume to cancel.
    const task = findTask(state.tasks, tv.taskId);
    if (task && resumeLabel(task)) return step(state, [{ type: 'taskAction', sessionId: state.sessionId, taskId: tv.taskId, action: 'cancel-resume' }]);
    return step(state, [{ type: 'interruptTask', sessionId: state.sessionId, taskId: tv.taskId }]);
  }

  if (key.name === 'ctrl-y') return answerWaiting(state, tv, state.sessionId, 'allow');
  if (key.name === 'ctrl-t') return answerApproval(state, tv, state.sessionId, 'allowForTask');
  if (key.name === 'ctrl-g') return answerWaiting(state, tv, state.sessionId, 'deny');

  if (key.name === 'ctrl-n' || key.name === 'ctrl-p') {
    const count = tv.view.queued.length;
    if (count === 0) return null;
    const delta = key.name === 'ctrl-n' ? 1 : -1;
    const from = queuedTarget(tv);
    const queuedIndex = from < 0 ? count - 1 : Math.max(0, Math.min(count - 1, from + delta));
    return step({ ...state, taskView: { ...tv, queuedIndex } });
  }

  return null;
}
