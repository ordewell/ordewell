import type { Task } from '../models/Task';

/** Whether a task can be continued in its saved runner session (ADR-0018, K1), and in which. */
export type Continuability = { ok: true; sessionId: string } | { ok: false; reason: string };

/**
 * The rule every surface offers Continue by and the orchestrator enforces: a
 * completed or failed task whose last attempt left a session id behind. A
 * conflict is resolved by its repair, not a new turn — Retry covers it.
 */
export function continuability(task: Task): Continuability {
  const refuse = (reason: string): Continuability => ({ ok: false, reason: `Task "${task.title}" cannot be continued: ${reason}` });
  if (task.type !== 'ai') return refuse('it is not run by an agent.');
  if (task.status === 'awaiting_user' && task.awaitingReason === 'conflict') {
    return refuse('its work is waiting on a merge conflict. Resolve or repair the conflict instead.');
  }
  if (task.status !== 'completed' && task.status !== 'failed') return refuse('only a completed or failed task can be.');
  if (!task.runnerSessionId) return refuse('its runner left no saved session to resume. Use Retry instead.');
  return { ok: true, sessionId: task.runnerSessionId };
}

export function canContinue(task: Task): boolean {
  return continuability(task).ok;
}
