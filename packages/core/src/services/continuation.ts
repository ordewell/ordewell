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
 * new turn — Retry covers it.
 */
export function continuability(task: Task): Continuability {
  const refuse = (reason: string): Continuability => ({ ok: false, reason: `Task "${task.title}" cannot be continued: ${reason}` });
  // Reopening a child is ADR-0055 D17's, and not built yet: a fresh retry starts a new child.
  if (task.type === 'delegated') return refuse('reopening its child plan is not built yet. Retry it fresh, which starts a new child.');
  if (task.type !== 'ai') return refuse('it is not run by an agent.');
  if (task.status === 'awaiting_user' && task.awaitingReason === 'conflict') {
    return refuse('its work is waiting on a merge conflict. Resolve or repair the conflict instead.');
  }
  const finished = task.status === 'completed' || task.status === 'failed' || task.status === 'skipped';
  if (!finished && !pausedOnLimit(task)) return refuse('only a completed, failed or skipped task, or one paused on a usage limit, can be.');
  if (!task.runnerSessionId) return refuse('its runner left no saved session to resume. Use Retry instead.');
  const owner = sessionOwner(task);
  if (owner && owner !== task.assignedRunner) {
    return refuse(`its saved session belongs to ${owner}; Retry starts fresh on ${task.assignedRunner} and carries over its files.`);
  }
  return { ok: true, sessionId: task.runnerSessionId };
}

export function canContinue(task: Task): boolean {
  return continuability(task).ok;
}
