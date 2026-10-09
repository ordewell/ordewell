import { EMPTY_TASK_LOG, reduceTaskLog, replayTaskLog, runnerToolSubject, truncateCheckpointSummary, type ApprovalDecision, type TaskLogEvent } from '@ordewell/core';
import { commit } from '../editor';
import type { Key } from '../keys';
import { continuesTask, findTask, waitingApproval, waitingCheckpoint, type TaskLogState, type TuiState } from '../state';
import { say } from '../transcript';
import { step, type Step, type Action } from './shared';

/*
 * The chat pane swapped for one task's log (ADR-0018, V1). Opening
 * reads the saved log so the view has its history; the live `task_log` stream
 * then folds into the same core view, deduped against what the file already
 * held.
 */

/** Open a task's log in the chat pane, reading its latest saved attempt first. */
export function openTaskView(state: TuiState, sessionId: string, taskId: string): Step {
  const task = findTask(state.tasks, taskId);
  if (!task) return step(say(state, 'system', `No task ${taskId} in this plan.`));
  const taskView: TaskLogState = {
    taskId,
    view: EMPTY_TASK_LOG,
    attempts: [],
    attempt: 0,
    pending: [],
    loaded: false,
    followLatest: true,
    queuedIndex: 0,
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

function clampQueueIndex(tv: TaskLogState): TaskLogState {
  const max = Math.max(0, tv.view.queued.length - 1);
  return tv.queuedIndex <= max ? tv : { ...tv, queuedIndex: max };
}

/**
 * Fold a live batch into the shown attempt. A newer attempt either takes over
 * (the reader is following the latest) or is only recorded, so a pinned view
 * stays put while a retry runs. Batches for an attempt already left behind are
 * ignored.
 */
function applyLive(tv: TaskLogState, attempt: number, events: TaskLogEvent[]): TaskLogState {
  if (attempt <= 0) return tv;
  let next = tv;
  if (attempt > next.attempt) {
    if (!next.followLatest) {
      return next.attempts.includes(attempt) ? next : { ...next, attempts: [...next.attempts, attempt] };
    }
    next = {
      ...next,
      view: EMPTY_TASK_LOG,
      attempt,
      attempts: next.attempts.includes(attempt) ? next.attempts : [...next.attempts, attempt],
    };
  }
  if (attempt < next.attempt) return next;
  return clampQueueIndex({ ...next, view: events.reduce(reduceTaskLog, next.view) });
}

/**
 * The saved log could not be read (the view's opening call failed). Stop
 * buffering and fold what the live stream did send, so the view still works
 * rather than waiting forever for a read that is not coming.
 */
export function taskLogAbandoned(state: TuiState): TuiState {
  const tv = state.taskView;
  if (!tv || tv.loaded) return state;
  let next: TaskLogState = { ...tv, pending: [], loaded: true };
  for (const batch of tv.pending) next = applyLive(next, batch.attempt, batch.events);
  return { ...state, taskView: clampQueueIndex(next) };
}

/** One live `task_log` batch: buffered until the saved log lands, then folded. */
export function taskLogArrived(state: TuiState, action: Extract<Action, { type: 'taskLog' }>): TuiState {
  const tv = state.taskView;
  if (!tv || tv.taskId !== action.taskId) return state;
  if (!tv.loaded) {
    return { ...state, taskView: { ...tv, pending: [...tv.pending, { attempt: action.attempt, events: action.events }] } };
  }
  return { ...state, taskView: applyLive(tv, action.attempt, action.events) };
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
  const spoken = action.events.reduce((s, event) => (event.type === 'approval_requested'
    ? say(s, 'system', `· Task ${task?.order ?? '?'} waits for approval: ${runnerToolSubject(event.tool, event.args)} — enter on it, then ctrl-y to allow or ctrl-g to deny`)
    : s), state);
  return spoken !== state ? { ...spoken, scroll: state.scroll } : spoken;
}

/**
 * A task's checkpoint question, said in the chat pane wherever the user is:
 * the first line of it, and where the whole of it can be answered.
 */
export function announceCheckpoint(state: TuiState, action: Extract<Action, { type: 'taskCheckpoint' }>): TuiState {
  const task = findTask(state.tasks, action.taskId) ?? state.tasks.find((t) => t.title === action.title);
  const label = task ? `Task ${task.order}` : action.title;
  const where = 'enter on it to answer';
  const spoken = say(state, 'system', `· ${label} asks: ${truncateCheckpointSummary(action.summary)} — ${where}`);
  return { ...spoken, scroll: state.scroll };
}

/**
 * A saved log (or its absence): replay it, then catch up on buffered live
 * batches. A batch for the attempt just replayed is dropped — the recorder
 * appends before it broadcasts, so the file already holds it; a batch for any
 * other attempt (a retry that raced the read) is folded on top.
 */
export function taskLogLoaded(state: TuiState, action: Extract<Action, { type: 'taskLogLoaded' }>): TuiState {
  const tv = state.taskView;
  if (!tv || tv.taskId !== action.taskId) return state;
  const loaded: TaskLogState = action.attempt >= 1
    ? {
        ...tv,
        view: replayTaskLog(action.events),
        attempts: action.attempts ?? tv.attempts,
        attempt: action.attempt,
      }
    : { ...tv, attempts: action.attempts ?? tv.attempts };
  let next: TaskLogState = { ...loaded, pending: [], loaded: true };
  for (const batch of tv.pending) {
    if (batch.attempt === action.attempt) continue;
    next = applyLive(next, batch.attempt, batch.events);
  }
  return { ...state, taskView: clampQueueIndex(next) };
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
    return step(say(state, 'system', 'The runner offered no grant for the rest of this task — ctrl-y allows this call.'));
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
export function answerCheckpoint(state: TuiState, sessionId: string, taskId: string, answer: 'approve' | 'reject', reason = ''): Step {
  const task = findTask(state.tasks, taskId);
  if (!waitingCheckpoint(task)) return step(say(state, 'system', `Task ${task?.order ?? taskId} is not waiting at a checkpoint.`));
  const note = answer === 'reject' ? reason.trim() : '';
  return step(state, [{ type: 'answerTaskCheckpoint', sessionId, taskId, answer, ...(note ? { reason: note } : {}) }]);
}

/**
 * ctrl-y and ctrl-g: a waiting tool request answers first, then the checkpoint.
 * A rejection takes the composer's text as its reason, as a denial takes its
 * note, and empties the composer once sent.
 */
function answerWaiting(state: TuiState, tv: TaskLogState, sessionId: string, decision: 'allow' | 'deny'): Step {
  if (waitingApproval(tv) || !waitingCheckpoint(findTask(state.tasks, tv.taskId))) return answerApproval(state, tv, sessionId, decision);
  if (decision === 'allow') return answerCheckpoint(state, sessionId, tv.taskId, 'approve');
  const answered = answerCheckpoint(state, sessionId, tv.taskId, 'reject', state.editor.text);
  return state.editor.text.trim() ? { ...answered, state: { ...answered.state, editor: { ...answered.state.editor, text: '', cursor: 0 } } } : answered;
}

/**
 * Force send (ADR-0023, F1): the composer's text or, with the composer empty,
 * the selected queued message — interrupting the running turn to go next.
 * One key for both, so sending now is always the same reach whichever
 * message it is.
 */
function sendNow(state: TuiState, tv: TaskLogState, sessionId: string): Step {
  const text = state.editor.text.trim();
  if (text) {
    if (continuesTask(findTask(state.tasks, tv.taskId))) return step(say(state, 'system', 'The task has finished, so there is no turn to interrupt — enter continues it.'));
    return step({ ...state, editor: commit(state.editor) }, [{ type: 'forceSendTaskMessage', sessionId, taskId: tv.taskId, text }]);
  }
  const queued = tv.view.queued[tv.queuedIndex];
  if (!queued) return step(say(state, 'system', 'Nothing to send now: type a message, or pick a queued one with ctrl-n/ctrl-p.'));
  if (queued.handedOver) return step(say(state, 'system', 'The runner already has that message; it reads it after its current step.'));
  return step(state, [{ type: 'forceSendQueuedTaskMessage', sessionId, taskId: tv.taskId, messageId: queued.id }]);
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
    const index = tv.attempts.indexOf(tv.attempt);
    if (index < 0) return null;
    const target = key.name === 'alt-left' ? index - 1 : index + 1;
    const attempt = tv.attempts[target];
    if (attempt === undefined) {
      return step(say(state, 'system', target < 0 ? 'This is the first attempt.' : 'This is the latest attempt.'));
    }
    return step(
      { ...state, taskView: { ...tv, followLatest: false } },
      [{ type: 'loadTaskAttempt', sessionId: state.sessionId, taskId: tv.taskId, attempt }],
    );
  }

  if (key.name === 'ctrl-r') {
    const queued = tv.view.queued[tv.queuedIndex];
    if (!queued) return step(say(state, 'system', 'No queued message to remove.'));
    if (queued.handedOver) return step(say(state, 'system', 'The runner already has that message; it can no longer be taken back.'));
    return step(state, [{ type: 'removeTaskMessage', sessionId: state.sessionId, taskId: tv.taskId, messageId: queued.id }]);
  }

  if (key.name === 'ctrl-s') return sendNow(state, tv, state.sessionId);

  if (key.name === 'ctrl-x') {
    return step(state, [{ type: 'interruptTask', sessionId: state.sessionId, taskId: tv.taskId }]);
  }

  if (key.name === 'ctrl-y') return answerWaiting(state, tv, state.sessionId, 'allow');
  if (key.name === 'ctrl-t') return answerApproval(state, tv, state.sessionId, 'allowForTask');
  if (key.name === 'ctrl-g') return answerWaiting(state, tv, state.sessionId, 'deny');

  if (key.name === 'ctrl-n' || key.name === 'ctrl-p') {
    const count = tv.view.queued.length;
    if (count === 0) return null;
    const delta = key.name === 'ctrl-n' ? 1 : -1;
    const queuedIndex = Math.max(0, Math.min(count - 1, tv.queuedIndex + delta));
    return step({ ...state, taskView: { ...tv, queuedIndex } });
  }

  return null;
}
