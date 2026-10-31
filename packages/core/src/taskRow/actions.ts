import { NOT_STARTED } from './status';
import type { TaskStatus, TaskType } from '../models/Task';
import type { ExecutionCommand } from '../services/ExecutionCommands';

/**
 * What a user can do to one task from its row. For a task paused on a usage
 * limit, `resume-now` resumes it in its saved session once the user says the
 * limit has reset, and `cancel-resume` keeps it from resuming on its own.
 */
export type TaskRowAction = 'cancel' | 'resume-now' | 'cancel-resume' | 'skip' | 'force-start' | 'complete' | 'uncomplete';

/** A subtask runs with its parent, so its row offers a different set than a top-level task's. */
export type TaskRowPlacement = 'task' | 'subtask';

interface ActionSubject {
  status: string;
  type: TaskType;
  awaitingReason?: string;
  resumeAt?: string | null;
  /** Its last attempt left a runner session to continue (ADR-0018, K1). */
  continuable?: boolean;
  /** A conflict repair of it will start by itself, which Stop withdraws (ADR-0015). */
  repairWaits?: unknown;
}

type Rule = readonly [TaskRowAction, (task: ActionSubject) => boolean];

const UNSTARTED_AI = (t: ActionSubject): boolean => t.type === 'ai' && NOT_STARTED.has(t.status);
/** Not started, and run by Ordewell rather than by hand: an AI task, or a script task (ADR-0035). */
const UNSTARTED_RUN = (t: ActionSubject): boolean => t.type !== 'user' && NOT_STARTED.has(t.status);
const QUEUED = (t: ActionSubject): boolean => t.status === 'pending' || t.status === 'approved';
const PAUSED = (t: ActionSubject): boolean => t.status === 'awaiting_user' && t.awaitingReason === 'usage-limit';
const RESUMES = (t: ActionSubject): boolean => PAUSED(t) && !!t.resumeAt;
const RESUMABLE = (t: ActionSubject): boolean => PAUSED(t) && t.continuable === true;
/** Work that holds up what depends on it until someone acts: Skip lets the run go on without it. */
const HOLDS_UP = (t: ActionSubject): boolean => t.status === 'failed' || t.status === 'blocked' || t.status === 'awaiting_user';

/** There is something for a Stop to end: a runner, or a repair about to start one. */
const STOPPABLE = (t: ActionSubject): boolean => t.status === 'in_progress' || !!t.repairWaits;

// Order is the order a surface lays the actions out in.
const TASK_RULES: readonly Rule[] = [
  ['cancel', STOPPABLE],
  ['resume-now', RESUMABLE],
  ['cancel-resume', RESUMES],
  ['skip', HOLDS_UP],
  ['force-start', UNSTARTED_RUN],
  // A manual task has no runner to report it done, so it can always be marked;
  // a skipped one's kept work can still be vouched for.
  ['complete', (t) => t.status === 'awaiting_user' || t.status === 'skipped' || t.type === 'user'],
  ['uncomplete', (t) => t.status === 'completed'],
];

const SUBTASK_RULES: readonly Rule[] = [
  ['cancel', STOPPABLE],
  ['resume-now', RESUMABLE],
  ['cancel-resume', RESUMES],
  ['complete', (t) => t.status === 'in_progress' && t.type === 'ai'],
  ['force-start', (t) => t.type === 'ai' && QUEUED(t)],
  ['skip', (t) => QUEUED(t) || t.status === 'failed'],
  ['complete', (t) => t.status === 'awaiting_user' || t.status === 'skipped'],
  ['uncomplete', (t) => t.status === 'completed'],
];

/** The actions a task's row offers while a plan runs, in the order they are laid out. */
export function taskRowActions(task: ActionSubject, placement: TaskRowPlacement = 'task'): TaskRowAction[] {
  const rules = placement === 'subtask' ? SUBTASK_RULES : TASK_RULES;
  return rules.filter(([, applies]) => applies(task)).map(([action]) => action);
}

/**
 * One toggle in both directions: a done task is taken back, anything else is
 * marked done. A second control for the reverse is one nobody remembers.
 */
export function markAction(task: { status: string }): 'complete' | 'uncomplete' {
  return task.status === 'completed' ? 'uncomplete' : 'complete';
}

/**
 * What a surface's task control can ask: a row's action, a start, or a fresh
 * retry. Every one is a single call at the command seam; see {@link taskActionCommand}.
 */
export type TaskAction = TaskRowAction | 'run' | 'retry';

/**
 * The command a task control sends the seam as the user (ADR-0029). One table
 * for every surface, so a button means the same command in the terminal, the
 * editor and the daemon. Skip is no mark: it ends the task without vouching for
 * its work, which only `complete` does. `reason` is skip's, optional for the user.
 */
export function taskActionCommand(action: TaskAction, task: string, reason?: string): ExecutionCommand {
  switch (action) {
    case 'run': return { command: 'run_task', task };
    case 'retry': return { command: 'retry_task', task, from: 'fresh' };
    case 'cancel': return { command: 'stop_task', task };
    // The user says the limit has reset early: the task resumes in its saved session now.
    case 'resume-now': return { command: 'retry_task', task, from: 'session' };
    case 'cancel-resume': return { command: 'cancel_resume', task };
    case 'skip': return { command: 'skip_task', task, ...(reason ? { reason } : {}) };
    case 'force-start': return { command: 'force_start', task };
    case 'complete': return { command: 'mark_complete', task };
    case 'uncomplete': return { command: 'mark_not_done', task };
  }
}

/**
 * Whether Mark complete or Mark not done on this task needs the user's explicit
 * yes (ADR-0029): an AI or script task's override vouches for work no verdict
 * passed. A manual task's is the user's own sign-off, and is asked of no one.
 */
export function overrideNeedsConfirmation(task: { type: TaskType }): boolean {
  return task.type !== 'user';
}

/**
 * An override command carrying the user's yes. `seen` is the status they were
 * asked about: a task that moved on meanwhile is refused, not overridden. A
 * caller that never looked, like a scripted `--yes`, leaves it out. Any other
 * command is returned as it was.
 */
export function confirmedOverride(command: ExecutionCommand, seen?: TaskStatus): ExecutionCommand {
  return command.command === 'mark_complete' || command.command === 'mark_not_done' ? { ...command, confirmed: true, ...(seen ? { seen } : {}) } : command;
}

/** Change versus ops can still be flipped (ADR-0020): an AI task that has not started. */
export function opsEditable(task: ActionSubject): boolean {
  return UNSTARTED_AI(task);
}
