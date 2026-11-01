import { pausedOnLimit, type Task } from '../models/Task';

/** Whether a task can be continued in its saved runner session (ADR-0018, K1), and in which. */
export type Continuability = { ok: true; sessionId: string } | { ok: false; reason: string };

/**
 * The runner a task's saved session belongs to: the one recorded when it was
 * saved, else — for a plan from before that — the runner of its last attempt.
 * Undefined when neither is known.
 */
export function sessionOwner(task: Task): string | undefined {
  return task.runnerSessionOwner ?? task.attemptUsage?.at(-1)?.runner;
}

/**
 * The rule every surface offers Continue by and the orchestrator enforces: a
 * completed, failed or skipped task, or one paused on a usage limit, whose last
 * attempt left a session id behind. A conflict is resolved by its repair, not a
 * new turn — Retry covers it. A delegated task whose question a restart lost
 * still has its child, so Continue is what keeps that work (ADR-0055 D17).
 */
export function continuability(task: Task): Continuability {
  const refuse = (reason: string): Continuability => ({ ok: false, reason: `Task "${task.title}" cannot be continued: ${reason}` });
  const delegated = task.type === 'delegated';
  if (!delegated && task.type !== 'ai') return refuse('it is not run by an agent.');
  // Its work has landed and its child has gone with it; a stopped child reads as not started, and is still there to reopen (ADR-0055 D17).
  if (delegated && task.status === 'completed') return refuse('its child plan has landed. Mark it not done and start it, which starts a new child.');
  if (task.status === 'awaiting_user' && task.awaitingReason === 'conflict') {
    return refuse('its work is waiting on a merge conflict. Resolve or repair the conflict instead.');
  }
  const finished = task.status === 'completed' || task.status === 'failed' || task.status === 'skipped' || (delegated && (task.status === 'pending' || task.awaitingReason === 'question-lost'));
  if (!finished && !pausedOnLimit(task)) return refuse('only a completed, failed or skipped task, or one paused on a usage limit, can be.');
  if (!task.runnerSessionId) return refuse(delegated ? 'it has no child to reopen. Use Retry instead, which starts one.' : 'its runner left no saved session to resume. Use Retry instead.');
  const owner = sessionOwner(task);
  if (owner && owner !== task.assignedRunner) {
    return refuse(`its saved session belongs to ${owner}; Retry starts fresh on ${task.assignedRunner} and carries over its files.`);
  }
  return { ok: true, sessionId: task.runnerSessionId };
}

export function canContinue(task: Task): boolean {
  return continuability(task).ok;
}
