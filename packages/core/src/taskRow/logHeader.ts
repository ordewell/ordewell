import type { TaskLogView } from '../conversation/taskLog';
import type { TaskLogFollow } from '../conversation/taskLogFollow';
import type { RunnerCommand } from '../models/RunnerCommand';
import type { AwaitingReason } from '../models/Task';
import type { RepairWait } from '../interfaces/IWorktreeIsolation';
import { plannerContextFill, taskUsageSummary, usageText, type AttemptUsage, type ContextFill } from '../models/Usage';
import { approvalLabel, awaitingLabel, repairWaitLabel, resumeLabel, skippedLabel, STALLED_LABEL, taskStatusKind, type TaskStatusKind } from './status';

/**
 * A task as an opened log's header reads it. Structural: the TUI projects its
 * own task shape, and the VS Code host reads a whole `Task` and the live
 * `continuable` it already derives with `canContinue`.
 */
export interface TaskLogHeaderTask {
  status: string;
  awaitingReason?: AwaitingReason;
  skipReason?: string;
  resumeAt?: string | null;
  /** A runner silent for a while leaves the store's `in_progress`; only the row knows. */
  idleSince?: string | null;
  /** Its last attempt left a runner session the task's composer can continue (ADR-0018, K1). */
  continuable?: boolean;
  /** A conflict repair of it starts by itself once this clears (ADR-0015). */
  repairWaits?: RepairWait;
  attemptUsage?: readonly AttemptUsage[];
}

/**
 * What a log header says the task is doing: core's status kinds, plus the two
 * states only a log has — a runner request waiting on the user (ADR-0018, A1)
 * and a checkpoint (W1).
 */
export type TaskLogHeaderKind = TaskStatusKind | 'approval' | 'checkpoint';

export interface TaskLogHeaderUsage {
  /** "ctx 36k (18%) · $1.00", with "attempt 2: " or "task total: " when it labels a second row. */
  text: string;
  /** The meter behind the text, for the hover that names the exact counts. */
  contextFill?: ContextFill;
}

/** What one task's log header says, decided once (ADR-0018, V1). */
export interface TaskLogHeaderView {
  /** The state word, and the kind a surface paints it by. */
  state: { kind: TaskLogHeaderKind; label: string };
  /** "Resumes at 8:10pm" while a task paused on a usage limit resumes on its own; null otherwise. */
  resumes: string | null;
  /** A finished task, or one paused on a usage limit, whose saved session the composer continues (ADR-0018, K1). */
  continuable: boolean;
  /** `continuable` and paused on a usage limit: the composer resumes it now. */
  resumable: boolean;
  /** A turn is live. */
  working: boolean;
  /** The attempt on screen's usage, the task total under a past attempt's own numbers; empty when nothing was measured. */
  usage: TaskLogHeaderUsage[];
  /** The commands the runner reported for the attempt on screen (#66); empty when it reported none. */
  commands: readonly RunnerCommand[];
}

const STATE_LABEL: Record<TaskStatusKind, string> = {
  done: 'Done',
  failed: 'Failed',
  running: 'Running',
  quiet: STALLED_LABEL,
  awaiting: 'Waiting for your input',
  blocked: 'Blocked',
  skipped: 'Skipped',
  todo: 'To do',
};

/**
 * A settled task wins over anything its log still shows, then a runner request
 * waiting for an answer, then a live turn, then what an `awaiting_user` task
 * waits on. Only then does the store's own status speak, and how the last turn
 * ended before it: a turn that failed or was stopped while the task stayed
 * `in_progress` is what the reader needs, not "Running".
 */
function stateOf(task: TaskLogHeaderTask, follow: TaskLogFollow, approvals: number): TaskLogHeaderView['state'] {
  if (task.status === 'completed') return { kind: 'done', label: STATE_LABEL.done };
  if (task.status === 'failed') return { kind: 'failed', label: STATE_LABEL.failed };
  if (task.status === 'skipped') return { kind: 'skipped', label: skippedLabel(task.skipReason ?? null) };
  const approval = approvalLabel(approvals);
  if (approval) return { kind: 'approval', label: approval };
  if (follow.view.working) return { kind: 'running', label: 'Working' };
  if (task.status === 'awaiting_user') {
    return { kind: task.awaitingReason === 'checkpoint' ? 'checkpoint' : 'awaiting', label: awaitingLabel(task) ?? STATE_LABEL.awaiting };
  }
  if (task.status === 'blocked') return { kind: 'blocked', label: STATE_LABEL.blocked };
  if (task.repairWaits) return { kind: 'todo', label: repairWaitLabel(task.repairWaits) };
  if (follow.view.lastTurnEnd === 'failed') return { kind: 'failed', label: 'Turn failed' };
  if (follow.view.lastTurnEnd === 'interrupted') return { kind: 'todo', label: 'Interrupted' };
  const kind = taskStatusKind(task);
  return { kind, label: STATE_LABEL[kind] };
}

/** The last usage block of a log saved before attempt ledgers carried their own numbers. */
function loggedUsage(view: TaskLogView): TaskLogHeaderUsage | null {
  const last = view.blocks.at(-1);
  if (last?.type !== 'usage') return null;
  const text = usageText(last);
  return text ? { text, ...(last.contextFill ? { contextFill: last.contextFill } : {}) } : null;
}

function usageRow(text: string | null, contextFill: ContextFill | undefined): TaskLogHeaderUsage | null {
  return text ? { text, ...(contextFill ? { contextFill } : {}) } : null;
}

/**
 * The attempt on screen's own numbers first and the task total under them, as
 * the TUI's task view has always drawn them; the latest attempt is the total
 * alone. A log saved before logs and ledgers shared a number has only its own
 * last usage block, which stands in for the attempt it cannot identify.
 */
function usageOf(task: TaskLogHeaderTask, follow: TaskLogFollow, attempt: number): TaskLogHeaderUsage[] {
  const attempts = task.attemptUsage ?? [];
  const latest = attempts.at(-1);
  const past = attempt > 0 && attempt !== latest?.attempt;
  const total = taskUsageSummary(task);
  const totalText = usageText(total);
  if (!past) {
    if (attempts.length > 0) return totalText ? [{ text: totalText, ...(total.contextFill ? { contextFill: total.contextFill } : {}) }] : [];
    const logged = loggedUsage(follow.view);
    return logged ? [logged] : [];
  }
  const onScreen = attempts.find((a) => a.attempt === attempt);
  const own = onScreen
    ? usageRow(usageText({ totals: onScreen.totals, contextFill: plannerContextFill(onScreen) }), plannerContextFill(onScreen))
    : loggedUsage(follow.view);
  const rows: TaskLogHeaderUsage[] = [];
  if (own) rows.push(onScreen ? { ...own, text: `attempt ${onScreen.attempt}: ${own.text}` } : own);
  if (totalText) rows.push({ text: `task total: ${totalText}`, ...(total.contextFill ? { contextFill: total.contextFill } : {}) });
  return rows;
}

/** The commands the attempt on screen loaded (#66): the last `runner_loaded` block of its log. */
export function taskLogCommands(view: Pick<TaskLogView, 'blocks'>): readonly RunnerCommand[] {
  for (let i = view.blocks.length - 1; i >= 0; i--) {
    const block = view.blocks[i];
    if (block.type === 'runner_loaded') return block.commands;
  }
  return [];
}

/** Whether an opened task's composer continues it rather than messaging its turn (ADR-0018, K1). */
export function logContinues(task: Pick<TaskLogHeaderTask, 'status' | 'awaitingReason' | 'continuable'>): boolean {
  const finished = task.status === 'completed' || task.status === 'failed' || task.status === 'skipped';
  return task.continuable === true && (finished || task.status === 'awaiting_user' && task.awaitingReason === 'usage-limit');
}

/** Whether the composer resumes it now, once the user says the limit has reset; a subset of `logContinues`. */
export function logResumes(task: Pick<TaskLogHeaderTask, 'status' | 'awaitingReason' | 'continuable'>): boolean {
  return task.continuable === true && task.status === 'awaiting_user' && task.awaitingReason === 'usage-limit';
}

/**
 * Everything a task log's header says about the task it follows, decided once:
 * its state, its resume time, whether its composer continues or resumes it,
 * the attempt on screen's usage and the commands that attempt loaded. Each
 * surface paints these in its own colours and casing; it derives none of them.
 */
export function taskLogHeaderView(task: TaskLogHeaderTask, follow: TaskLogFollow, approvals: number, attempt: number): TaskLogHeaderView {
  return {
    state: stateOf(task, follow, approvals),
    resumes: resumeLabel(task),
    continuable: logContinues(task),
    resumable: logResumes(task),
    working: follow.view.working,
    usage: usageOf(task, follow, attempt),
    commands: taskLogCommands(follow.view),
  };
}
