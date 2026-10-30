import { isRunnerApproval } from '../interfaces/IApproval';
import { betweenRounds, loopRoundOf, outOfRounds } from '../models/Loop';
import { flattenTasksWithParents, type Task, type TaskWithParent } from '../models/Task';
import { manualOverrideConfirmation, pastGateConfirmation } from '../taskRow/texts';
import { holdLabel } from '../taskRow/status';
import { canContinue } from './continuation';
import { waitOf, type StartWait, type StartWaitKind } from './readiness';
import { taskRefOf } from './TaskRefs';
import type { ExecutionCommand } from './ExecutionCommands';
import type { PendingApproval } from './PendingApprovals';
import type { RunMergeView } from './SessionMessage';

/**
 * What an escalation waits on (ADR-0053). `approval`, `checkpoint`, `input`,
 * `conflict`, `files-changed` and `usage-limit` are a task's wait; `failed` and
 * `out-of-rounds` its end; `merge-gate`, `unapproved`, `on-hold`, `no-prompt`
 * and `by-hand` what alone keeps a task from starting; `merge-all` and
 * `blocked-run` are the run's own.
 */
export type EscalationKind =
  | 'approval'
  | 'checkpoint'
  | 'input'
  | 'conflict'
  | 'files-changed'
  | 'usage-limit'
  | 'failed'
  | 'out-of-rounds'
  | 'merge-gate'
  | 'unapproved'
  | 'on-hold'
  | 'no-prompt'
  | 'by-hand'
  | 'merge-all'
  | 'blocked-run';

export type EscalationOptionId =
  | 'allow'
  | 'allow-for-task'
  | 'deny'
  | 'approve'
  | 'reject'
  | 'reply'
  | 'resume'
  | 'continue'
  | 'retry'
  | 'run'
  | 'force-start'
  | 'skip'
  | 'complete'
  | 'merge-all'
  | 'resolve-conflict'
  | 'stash'
  | 'run-without-isolation';

/** One answer the user may give: what the wait's own card or command offers. */
export interface EscalationOption {
  id: EscalationOptionId;
  label: string;
  /** What this answer does with a note; absent when it takes none. */
  note?: 'optional' | 'required';
  /** The question a surface asks first, as it does on the card; the answer then carries the user's yes. */
  confirm?: string;
}

/**
 * One thing the run waits on a person for, derived and never stored
 * (ADR-0053). No deadline and no default answer: answering for the user on a
 * timer is a consent decision, which belongs to the mandate (#23).
 */
export interface Escalation {
  /** Kind, task, attempt and approval: a later attempt's wait is another escalation, so a stale answer is told from a live one. */
  id: string;
  kind: EscalationKind;
  /** The task it belongs to, the link to its evidence; absent on the run's own. */
  task?: { id: string; ref: string; title: string };
  /** The attempt it was raised in; absent before any ran. */
  attempt?: number;
  /** The runner request it answers, for `approval`. */
  approval?: string;
  reason: string;
  options: EscalationOption[];
}

/** What the list reads of the run. */
export interface EscalationRun {
  /** A full-plan run is scheduling, held, or ended on a failure a retry continues: only then does a task that has not started wait on anyone, a reverted one apart. */
  open: boolean;
  /** Something could move a task on unasked, so the seam refuses a Mark complete (ADR-0029). */
  advancing: boolean;
  /** A Merge all is under way. */
  merging: boolean;
  /** Ordewell merges at gates by itself: the setting is on, and no merge has stopped it. */
  autoMerges: boolean;
  /** What Merge all would merge now. */
  merge: RunMergeView | null;
  /** The isolated run's id. */
  id: string | null;
  /** Which opening of the run waits on a dirty checkout; null when none does. */
  blocked: number | null;
}

/** What the list is derived from: nothing here is kept for it. */
export interface EscalationInput {
  /** The plan tree. */
  tasks: readonly Task[];
  /** Every task's start waits; see `planStartWaits`. */
  waits: ReadonlyMap<string, readonly StartWait[]>;
  approvals: readonly PendingApproval[];
  /** The task's latest attempt, 0 before any ran. */
  attempt: (task: Readonly<Task>) => number;
  /** An attempt of the task is live, so a runner is there to hear an answer. */
  live: (taskId: string) => boolean;
  /** What the task's waiting checkpoint asks, whole. */
  checkpoint: (taskId: string) => string | undefined;
  /** Added since the user approved the plan, and left for them (ADR-0035). */
  waitsForApproval: (taskId: string) => boolean;
  /** Why the task is on hold. */
  holdReason: (taskId: string) => string | null | undefined;
  run: EscalationRun;
}

/**
 * Whether a person alone can lift this start wait. Written out so that a new
 * wait fails to compile until someone decides. A task with any `false` wait is
 * left out: that wait clears by itself, or the task's cause is listed in its
 * place, and the task's turn comes after.
 */
const ONLY_A_PERSON: Record<StartWaitKind, boolean> = {
  started: false,
  repeating: false,
  completing: false,
  blocked: false,
  'loop-check': false,
  dependencies: false,
  queued: false,
  merging: false,
  'usage-limit': false,
  'start-hold': false,
  'no-prompt': true,
  unapproved: true,
  'on-hold': true,
  'merge-gate': true,
  'by-hand': true,
};

const label = ({ task, ref }: Pick<TaskWithParent, 'task' | 'ref'>): string => `task ${ref} "${task.title}"`;

const RETRY: EscalationOption = { id: 'retry', label: 'Retry' };
const SKIP: EscalationOption = { id: 'skip', label: 'Skip', note: 'optional' };
const MERGE_ALL: EscalationOption = { id: 'merge-all', label: 'Merge all' };

/** Mark complete, as the seam would take it now: an AI or script task's waits until nothing can move it on (ADR-0029). */
function completeOption(row: TaskWithParent, run: EscalationRun): EscalationOption[] {
  if (row.task.type === 'user') return [{ id: 'complete', label: 'Mark complete' }];
  if (run.advancing) return [];
  return [{ id: 'complete', label: 'Mark complete', confirm: manualOverrideConfirmation('complete', label(row)) }];
}

/** A wait of the task, before the id and task every escalation carries. */
type Wait = Pick<Escalation, 'kind' | 'reason' | 'options'>;

function askedOf(row: TaskWithParent, pending: PendingApproval, attempt: number): Escalation {
  const { task, ref } = row;
  return {
    id: `approval:${task.id}:${attempt}:${pending.id}`,
    kind: 'approval',
    task: { id: task.id, ref, title: task.title },
    ...(attempt > 0 ? { attempt } : {}),
    approval: pending.id,
    reason: `Its runner asks: ${pending.request.subject}`,
    options: [
      { id: 'allow', label: 'Allow' },
      ...(pending.request.allowForTask ? [{ id: 'allow-for-task' as const, label: 'Allow for this task' }] : []),
      { id: 'deny', label: 'Deny', note: 'optional' },
    ],
  };
}

/** What starts an ended attempt's task again: a saved session is offered beside a fresh attempt. */
function startedOver(row: TaskWithParent, input: EscalationInput): EscalationOption[] {
  return [
    RETRY,
    ...(canContinue(row.task) ? [{ id: 'continue' as const, label: 'Continue', note: 'required' as const }] : []),
    SKIP,
    ...completeOption(row, input.run),
  ];
}

/** An `awaiting_user` task, but for one that resumes by itself at its usage limit's reset. */
function awaiting(row: TaskWithParent, input: EscalationInput): Wait | null {
  const { task } = row;
  const live = input.live(task.id);
  switch (task.awaitingReason) {
    case 'usage-limit':
      if (task.resumeAt) return null;
      return {
        kind: 'usage-limit',
        reason: 'Paused on its runner\'s usage limit, with no resume scheduled.',
        options: [canContinue(task) ? { id: 'resume', label: 'Resume now', note: 'optional' } : RETRY, SKIP, ...completeOption(row, input.run)],
      };
    case 'checkpoint': {
      if (!live) return { kind: 'checkpoint', reason: 'It stopped at a checkpoint, and no runner is left to hear an answer.', options: startedOver(row, input) };
      const question = input.checkpoint(task.id);
      return {
        kind: 'checkpoint',
        reason: question ? `Checkpoint: ${question}` : 'Waiting at a checkpoint.',
        options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject', note: 'optional' }, SKIP],
      };
    }
    case 'conflict':
      return {
        kind: 'conflict',
        reason: 'Its work could not land: it conflicts with what landed before it.',
        options: [{ id: 'resolve-conflict', label: 'Add a resolver task' }, RETRY, SKIP, ...completeOption(row, input.run)],
      };
    case 'files-changed':
      return { kind: 'files-changed', reason: 'It changed tracked files in your checkout, and nothing was committed.', options: [RETRY, SKIP, ...completeOption(row, input.run)] };
    case 'input':
    case undefined:
      return live
        ? { kind: 'input', reason: 'Waiting for your input.', options: [{ id: 'reply', label: 'Reply', note: 'required' }, SKIP, ...completeOption(row, input.run)] }
        : { kind: 'input', reason: 'It was waiting for your input, and no runner is left to read a reply.', options: startedOver(row, input) };
  }
}

/**
 * A failed task, but for a loop's check that is no failure yet (ADR-0045 L3),
 * and one stopped by a body task that is listed in its place: retrying that
 * task is what lets the loop go on (L7), so the check would be the same wait twice.
 */
function failed(row: TaskWithParent, input: EscalationInput, rows: readonly TaskWithParent[]): Wait | null {
  const { task } = row;
  if (outOfRounds(task)) return { kind: 'out-of-rounds', reason: `Its loop ran out of rounds: it failed round ${loopRoundOf(task)} of ${task.loop?.maxRounds}.`, options: startedOver(row, input) };
  if (!betweenRounds(task)) return { kind: 'failed', reason: task.verdict?.reason || 'It failed.', options: startedOver(row, input) };
  if (waitOf(input.waits.get(task.id) ?? [], 'repeating')) return null;
  const body = rows.filter((r) => task.loop?.body.includes(r.task.id));
  if (body.some((r) => r.task.status === 'failed' || waitOf(input.waits.get(r.task.id) ?? [], 'blocked'))) return null;
  return { kind: 'failed', reason: `Its loop stopped: ${body.map((r) => r.ref).join(', ')} did not run.`, options: startedOver(row, input) };
}

/** A task not started that only a person can start, once a run is there for it to be late for. */
function unstarted(row: TaskWithParent, input: EscalationInput, rows: readonly TaskWithParent[]): Wait | null {
  const { task } = row;
  const waits = input.waits.get(task.id) ?? [];
  // A reverted task waits for the user's decision however the run stands: it is reverted before Merge all, usually after the last task landed (ADR-0054).
  if (!(input.run.open || task.reverted) || waits.some((w) => !ONLY_A_PERSON[w.kind])) return null;
  // In a plan nobody has approved yet nothing is theirs to start, and a manual task needs no approval to be done.
  if (waitOf(waits, 'unapproved') && task.type !== 'user' && !input.waitsForApproval(task.id)) return null;
  if (waitOf(waits, 'no-prompt')) {
    return { kind: 'no-prompt', reason: task.type === 'script' ? 'It has no body to run.' : 'It has no prompt, so there is nothing to run.', options: [SKIP] };
  }
  if (waitOf(waits, 'on-hold')) {
    return {
      kind: 'on-hold',
      reason: holdLabel(input.holdReason(task.id) ?? 'start it again'),
      options: [RETRY, { id: 'force-start', label: 'Force start' }],
    };
  }
  const gate = waitOf(waits, 'merge-gate');
  if (gate) {
    if (input.run.autoMerges) return null;
    const refs = gate.unmerged.map((id) => rows.find((r) => r.task.id === id)?.ref ?? id);
    return {
      kind: 'merge-gate',
      reason: `Waits for Merge all: the work of ${refs.join(', ')} is not merged into your branch yet.`,
      options: [
        MERGE_ALL,
        ...(task.type === 'user' ? completeOption(row, input.run) : [{ id: 'force-start' as const, label: 'Force start', confirm: pastGateConfirmation(refs, 'It') }]),
      ],
    };
  }
  if (task.type === 'user') return waitOf(waits, 'by-hand') ? { kind: 'by-hand', reason: 'A manual task: it is yours to do, and to mark complete.', options: completeOption(row, input.run) } : null;
  if (waitOf(waits, 'unapproved')) {
    return { kind: 'unapproved', reason: 'Added since you approved the plan, so it waits for you to start it.', options: [{ id: 'run', label: 'Start' }] };
  }
  return null;
}

function waitOfTask(row: TaskWithParent, input: EscalationInput, rows: readonly TaskWithParent[]): Wait | null {
  switch (row.task.status) {
    case 'awaiting_user': return awaiting(row, input);
    case 'failed': return failed(row, input, rows);
    case 'pending':
    case 'approved': return unstarted(row, input, rows);
    default: return null;
  }
}

function ofTask(row: TaskWithParent, input: EscalationInput, rows: readonly TaskWithParent[]): Escalation[] {
  const { task, ref } = row;
  const attempt = input.attempt(task);
  const asked = input.approvals
    .filter(({ request }) => isRunnerApproval(request) && request.taskId === task.id)
    .map((pending) => askedOf(row, pending, attempt));
  const wait = waitOfTask(row, input, rows);
  if (!wait) return asked;
  return [...asked, {
    id: `${wait.kind}:${task.id}:${attempt}`,
    kind: wait.kind,
    task: { id: task.id, ref, title: task.title },
    ...(attempt > 0 ? { attempt } : {}),
    reason: wait.reason,
    options: wait.options,
  }];
}

/**
 * Everything that will not move without a person (ADR-0053), in the order of
 * what stops the most first: a run that cannot start, then the plan's tasks in
 * order, then the work waiting to be merged. Pure and derived, as `planBlocks`
 * and `startWaits` are: nothing is stored, so nothing has to be cleared, and it
 * survives a reload as the waits it reads do.
 */
export function escalations(input: EscalationInput): Escalation[] {
  const rows = flattenTasksWithParents(input.tasks);
  const tasks = rows.flatMap((row) => ofTask(row, input, rows));
  const { run } = input;
  const blocked: Escalation[] = run.blocked === null ? [] : [{
    id: `blocked-run:${run.blocked}`,
    kind: 'blocked-run',
    reason: 'Tracked files have uncommitted changes, so tasks cannot run in isolated worktrees.',
    options: [{ id: 'stash', label: 'Stash and continue' }, { id: 'run-without-isolation', label: 'Run without isolation' }],
  }];
  // A gate's own escalation offers the same Merge all, and work still moving may land more.
  const mergeOwed = run.merge && !run.merging && !run.advancing && !tasks.some((e) => e.kind === 'merge-gate');
  const merge: Escalation[] = !mergeOwed ? [] : [{
    id: `merge-all:${run.id ?? ''}`,
    kind: 'merge-all',
    reason: `The run's landed work waits for Merge all: ${run.merge?.landed.map((t) => taskRefOf(input.tasks, t.taskId) ?? t.taskId).join(', ')}.`,
    options: [MERGE_ALL],
  }];
  return [...blocked, ...tasks, ...merge];
}

/** What a chosen option comes to: a command at the seam, or a Session operation that has none. */
export type EscalationAct =
  | { kind: 'command'; command: ExecutionCommand }
  | { kind: 'resolve-conflict'; task: string }
  | { kind: 'continue-run'; how: 'stash' | 'shared' };

/**
 * The existing command behind an option, so each check it has still applies.
 * A surface offering Mark complete asked first, and the seam only hears of it
 * with the user's yes: `answerEscalation` holds back an option that needs one.
 */
export function escalationAct(escalation: Escalation, option: EscalationOptionId, note?: string): EscalationAct {
  const task = escalation.task?.id ?? '';
  const command = (issued: ExecutionCommand): EscalationAct => ({ kind: 'command', command: issued });
  const request = { command: 'answer_approval', task, ...(escalation.approval ? { approval: escalation.approval } : {}) } as const;
  const said = note?.trim() ? note : undefined;
  switch (option) {
    case 'allow': return command({ ...request, answer: 'allow' });
    case 'allow-for-task': return command({ ...request, answer: 'allowForTask' });
    case 'deny': return command({ ...request, answer: 'deny', ...(said ? { note: said } : {}) });
    case 'approve': return command({ command: 'answer_checkpoint', task, answer: 'approve' });
    case 'reject': return command({ command: 'answer_checkpoint', task, answer: 'reject', ...(said ? { reason: said } : {}) });
    case 'reply': return command({ command: 'message_task', task, text: note ?? '' });
    case 'resume':
    case 'continue': return command({ command: 'retry_task', task, from: 'session', ...(said ? { message: said } : {}) });
    case 'retry': return command({ command: 'retry_task', task, from: 'fresh' });
    case 'run': return command({ command: 'run_task', task });
    case 'force-start': return command({ command: 'force_start', task });
    case 'skip': return command({ command: 'skip_task', task, ...(said ? { reason: said } : {}) });
    case 'complete': return command({ command: 'mark_complete', task, confirmed: true });
    case 'merge-all': return command({ command: 'merge_all' });
    case 'resolve-conflict': return { kind: 'resolve-conflict', task };
    case 'stash': return { kind: 'continue-run', how: 'stash' };
    case 'run-without-isolation': return { kind: 'continue-run', how: 'shared' };
  }
}
