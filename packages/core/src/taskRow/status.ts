import type { AwaitingReason, Verdict } from '../models/Task';
import type { RepairWait } from '../interfaces/IWorktreeIsolation';

/**
 * What a row's status means to a reader, before any surface picks a word,
 * icon or colour for it. `quiet` is a running task whose runner has printed
 * nothing for a while — the status is still `in_progress`, so only the row,
 * never the store, tells the two apart.
 */
export type TaskStatusKind = 'todo' | 'running' | 'quiet' | 'awaiting' | 'blocked' | 'failed' | 'skipped' | 'done';

/** A task with a runner live behind it. `in_progress` is the store's own status. */
export const isTaskRunning = (task: { status: string }): boolean =>
  task.status === 'in_progress' || task.status === 'running';

/** Statuses of a task that has not started: what can still be started by hand, or flipped between change and ops (ADR-0020). */
export const NOT_STARTED: ReadonlySet<string> = new Set(['pending', 'approved', 'blocked']);

export function taskStatusKind(task: { status: string; idleSince?: string | null }): TaskStatusKind {
  switch (task.status) {
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    case 'blocked': return 'blocked';
    case 'awaiting_user': return 'awaiting';
  }
  if (!isTaskRunning(task)) return 'todo';
  return task.status === 'in_progress' && task.idleSince ? 'quiet' : 'running';
}

/** The word for a running task whose runner has printed nothing for a while (`quiet`). */
export const STALLED_LABEL = 'Stalled';

const AWAITING_LABELS: Record<AwaitingReason, string> = {
  input: 'Waiting for your input',
  checkpoint: 'Checkpoint',
  conflict: 'Merge conflict',
  'files-changed': 'Changed tracked files',
  'usage-limit': 'Paused on a usage limit',
};

/** What an awaiting_user task waits on (ADR-0018, W1); null when no reason was saved. */
export function awaitingLabel(task: { status: string; awaitingReason?: AwaitingReason }): string | null {
  return task.status === 'awaiting_user' && task.awaitingReason ? AWAITING_LABELS[task.awaitingReason] : null;
}

const REPAIR_WAIT_LABELS: Record<RepairWait, string> = {
  slot: 'Repair waits for a free slot',
  planner: 'Repair waits for the planner\'s turn to end',
  'usage-limit': 'Repair waits for its runner\'s usage limit to reset',
};

/** A conflict repair that will start by itself (ADR-0015): progress, in words that ask nothing of the user. */
export function repairWaitLabel(wait: RepairWait): string {
  return REPAIR_WAIT_LABELS[wait];
}

/** "Blocked by #1, #2.1": the failed tasks a blocked task waits on, by reference (ADR-0034). */
export function blockedByLabel(refs: readonly string[]): string {
  return `Blocked by ${refs.join(', ')}`;
}

/** "On hold: could not connect to Ordewell's tools; start it again": why a task is out of the scheduler. */
export function holdLabel(reason: string): string {
  return `On hold: ${reason}`;
}

/** "Skipped: no GPU on this host", or "Skipped" when no reason was given. */
export function skippedLabel(reason: string | null): string {
  return reason ? `Skipped: ${reason}` : 'Skipped';
}

/**
 * A task added after the user approved the plan, which the scheduler leaves
 * for them (ADR-0035). Not a runner approval: nothing has started, so no
 * runner is asking anything.
 */
export const WAITS_FOR_APPROVAL_LABEL = 'Waits for your approval';

const RECEIPT_LABELS: Record<NonNullable<Verdict['reported']>, string> = {
  done: 'Completion received',
  failed: 'Failure report received',
  blocked: 'Blocked report received',
};

/**
 * That a running task's runner reported through `task_complete` and its
 * attempt is winding down (ADR-0018, L1); null otherwise. Worded as received,
 * never as passed: the verdict, and what it lands, come after.
 */
export function receiptLabel(task: { status: string; completionReceived?: Verdict['reported'] }): string | null {
  return isTaskRunning(task) && task.completionReceived ? RECEIPT_LABELS[task.completionReceived] : null;
}

/**
 * That a running task's runner is up and has not yet reported Ordewell's
 * tools connected (ADR-0025), on its first spawn or its one respawn; null
 * otherwise. Nothing was sent to it, and no person is being asked anything.
 */
export function attachingLabel(task: { status: string; attaching?: 1 | 2 }): string | null {
  if (!isTaskRunning(task) || !task.attaching) return null;
  return task.attaching === 2 ? "Connecting Ordewell's tools, retry" : "Connecting Ordewell's tools";
}

/** Runner requests a task waits on (ADR-0018, A1); null when none do. */
export function approvalLabel(count: number | undefined): string | null {
  if (!count) return null;
  return count > 1 ? `Waiting for approval (${count})` : 'Waiting for approval';
}

/**
 * When a paused task resumes, as a reader's clock shows it: "8:10pm", or
 * "Oct 14, 8:10pm" when it is not today. Read in the local time zone of
 * whoever formats it.
 */
export function resumeTime(at: Date, now: Date = new Date()): string {
  const clock = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: at.getMinutes() === 0 ? undefined : '2-digit', hour12: true })
    .replace(/[ \u202f]([AP]M)$/i, (_m, meridiem: string) => meridiem.toLowerCase());
  if (at.toDateString() === now.toDateString()) return clock;
  return `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${clock}`;
}

/** "Resumes at 8:10pm" for a task paused on a usage limit that resumes on its own; null for any other. */
export function resumeLabel(task: { status: string; awaitingReason?: AwaitingReason; resumeAt?: string | null }, now: Date = new Date()): string | null {
  if (task.status !== 'awaiting_user' || task.awaitingReason !== 'usage-limit' || !task.resumeAt) return null;
  const at = new Date(task.resumeAt);
  return Number.isNaN(at.getTime()) ? null : `Resumes at ${resumeTime(at, now)}`;
}
