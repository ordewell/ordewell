import { taskUsageSummary, type AttemptUsage, type TaskUsageSummary } from '../models/Usage';
import type { AwaitingReason, TaskType, Verdict } from '../models/Task';
import type { FindingSeverity, HandoffCommit, HandoffDigest } from '../models/Handoff';
import { savedPatchView, worstSeverity, type PatchView } from '../models/Handoff';
import type { TaskLoop } from '../models/Loop';
import type { RepairWait, TaskIsolationState } from '../interfaces/IWorktreeIsolation';
import { taskOrderLabel, taskRefOf } from '../services/TaskRefs';
import { capConflictFiles } from '../services/conflictFiles';
import { planBlocks, type BlockingSubject, type PlanBlocks } from '../services/blocking';
import { checkOf, loopRoundOf, type LoopSubject } from '../models/Loop';
import { assignedRunnerOf, assignmentConsequence, assignmentIssue, assignmentIssueText, type AssignmentScope } from '../services/AssignmentScope';
import { approvalLabel, attachingLabel, awaitingLabel, isTaskRunning, NOT_STARTED, receiptLabel, repairWaitLabel, resumeLabel, taskStatusKind, WAITS_FOR_APPROVAL_LABEL, type TaskStatusKind } from './status';
import { markAction, opsEditable, taskRowActions, type TaskRowAction, type TaskRowPlacement } from './actions';
import { loopBodyLabel, loopBodyRound, loopCheckLabel, loopCheckState, type LoopCheckFacts, type LoopCheckState } from './loop';

/**
 * A task as both surfaces hold it, with the live state each tracks beside it
 * (silence, approvals, isolation, the merge gate). Structural, because the TUI
 * projects tasks into its own shape.
 */
export interface TaskRowSubject {
  id: string;
  order: number;
  type: TaskType;
  status: string;
  dependencies: readonly string[];
  taskMode?: string;
  ops?: boolean;
  idleSince?: string | null;
  /** What its runner reported through `task_complete` while the attempt winds down (ADR-0018, L1). */
  completionReceived?: Verdict['reported'];
  /** Which spawn of its starting runner waits for Ordewell's tools to connect (ADR-0025). */
  attaching?: 1 | 2;
  awaitingReason?: AwaitingReason;
  skipReason?: string;
  /** When a task paused on a usage limit resumes on its own (ISO time). */
  resumeAt?: string | null;
  /** Its last attempt left a runner session to continue (ADR-0018, K1). */
  continuable?: boolean;
  awaitingApproval?: number;
  /** Added after the user approved the plan, and not approved since (ADR-0035). */
  waitsForApproval?: boolean;
  /** Why it is held out of the scheduler; absent when it is not held. */
  holdReason?: string | null;
  /** A read-only task whose report is addressed to the planner (ADR-0037). */
  research?: boolean;
  isolation?: TaskRowIsolation | null;
  mergeGate?: readonly string[];
  forcedPastGate?: readonly string[];
  /** An attempt of it has started, so its chat exists from then on. */
  attempted?: boolean;
  attemptUsage?: readonly AttemptUsage[];
  assignedRunner?: string;
  assignedModel?: { modelId: string; modelLabel?: string };
  /** A loop's check, its round and what its evidence said: the row's words for the loop are read off them (ADR-0045). */
  loop?: TaskLoop;
  loopRound?: number;
  verdict?: { outcome: string; reported?: string } | null;
  /** Between rounds with nothing to run it: only the run knows that, so it is told (ADR-0045 L5). */
  loopStranded?: boolean;
  /** The latest attempt's handoff as the plan keeps it (ADR-0047); a row shows it without opening the task. */
  handoff?: HandoffDigest;
}

export interface TaskRowIsolation {
  state: TaskIsolationState;
  repos?: string[];
  conflictRepo?: string;
  conflictFiles?: string[];
  repair?: { attempt: number; limit: number };
  repairedFiles?: string[];
  /** Core's word that its landing can be reverted (ADR-0054); a surface offers the action only then. */
  revertible?: true;
  repairWaits?: RepairWait;
  /** The task added to resolve its conflict, by id. */
  resolver?: string;
}

/**
 * The plan a row labels its references against: the tree, so a subtask's
 * dependency reads dotted ("#2.1") rather than by its parent-scoped order.
 * With statuses and dependencies it also tells which tasks a failure blocks.
 */
interface PlanRefTask {
  id: string;
  order: number;
  title: string;
  status?: string;
  dependencies?: readonly string[];
  subtasks?: readonly PlanRefTask[];
  /** A loop's check and its round, read so its dependents are not shown blocked between rounds (ADR-0045 L3). */
  loop?: TaskLoop;
  loopRound?: number;
  verdict?: { outcome: string; reported?: string } | null;
}

export interface TaskRowContext {
  /** Set for a subtask: it is labelled by its dotted order. */
  parent?: { order: number } | null;
  /** Which action set the row offers; a row with a parent is a subtask's unless told otherwise. */
  placement?: TaskRowPlacement;
  /** The plan tree a dependency, gate or block is labelled against; one it does not hold is shown by id. */
  tasks?: readonly PlanRefTask[];
  /** The modes the task's runner declares; autonomy is a tag on one of them (ADR-0001). */
  modes?: readonly { id: string; autonomous?: boolean }[];
  /** What a resume time is read against; the clock when absent. */
  now?: Date;
  /** The enabled runners and allowlist an assignment is read against; without it no assignment is flagged. */
  runnerScope?: AssignmentScope;
}

/**
 * Whether the row stands for an AI task, a manual one, an ops task (ADR-0020),
 * or a script task (ADR-0035): an ops task by nature, drawn with its body and
 * with no prompt, runner or model to edit.
 */
export type TaskRowKind = 'ai' | 'user' | 'ops' | 'script';

/** The task's whole spend (see `taskUsageSummary`); `attempt` is the latest one, 0 before any reported. */
export interface TaskRowUsage extends Pick<TaskUsageSummary, 'totals' | 'contextFill'> {
  attempt: number;
}

/**
 * What a task handed over, as a collapsed row says it (ADR-0047): the
 * author's summary, how many findings the handoff holds (the digest's cut
 * included) and the worst severity the plan still keeps. The whole handoff,
 * with every finding and the report, is in the attempt's log.
 */
export interface TaskRowHandoff {
  /** The commit message the task stated, when it did. */
  commit?: HandoffCommit;
  summary: string;
  findingCount: number;
  severity: FindingSeverity | null;
  /** The patch its attempt saved (ADR-0050), when it saved one. */
  patch?: PatchView;
}

/**
 * A loop's check and its body, as a row draws them. The check says its round
 * and how the loop stands; a body task says which check it runs for.
 */
export type TaskRowLoop =
  | {
    role: 'check';
    state: LoopCheckState;
    /** "Round 2 of 3", "Passed in round 2 of 3", "Failed after 3 rounds". */
    label: string;
    /** What the label leaves out — what the loop waits for, or what stopped it; null when it leaves nothing. */
    detail: string | null;
    /** Its body tasks, by reference. */
    body: string[];
  }
  | {
    role: 'body';
    /** "Runs if #1 fails", and its round once it runs. */
    label: string;
    /** The check, by reference. */
    check: string;
    round: number | null;
  };

export interface TaskRowView {
  usage: TaskRowUsage | null;
  /** "2", or "2.1" for a subtask. */
  orderLabel: string;
  kind: TaskRowKind;
  status: TaskStatusKind;
  /** A runner is live behind it — `quiet` included. */
  running: boolean;
  /** An attempt has started, so its chat exists: the one fact the open control reads, never its status. */
  chatAvailable: boolean;
  /** What an awaiting task waits on, in sentence case; null when nothing was saved. */
  awaiting: string | null;
  /** "Resumes at 8:10pm" while a task paused on a usage limit resumes on its own; null otherwise. */
  resumes: string | null;
  /** Runner requests waiting on the user, in sentence case; null when none do. */
  approvals: string | null;
  /** "Completion received" while its runner's report waits for the verdict (ADR-0018, L1), in sentence case; null otherwise. Never a pass. */
  receipt: string | null;
  /** "Connecting Ordewell's tools" while its runner starts and they have not connected (ADR-0025), in sentence case; null otherwise. */
  attaching: string | null;
  /** That it waits for the user's approval to start, in sentence case; null once it started, or when it needs none. */
  waitsForApproval: string | null;
  /** Why it is held out of the scheduler, in sentence case; null when it is not held. */
  holdReason: string | null;
  /** The runner an AI task is assigned; null for any other task, which has none. */
  runner: string | null;
  /** Why the task's runner or model is one the user has since moved away from, in sentence case; null when it is not. The task still runs. */
  assignmentFlag: string | null;
  /** What the flag means for this task as it stands (a failed one runs again only if retried); set exactly when `assignmentFlag` is. */
  assignmentConsequence: string | null;
  /** An AI task whose report goes to the planner and wakes it (ADR-0037). */
  research: boolean;
  /** The task's mode is tagged autonomous: it runs without permission prompts. */
  autonomous: boolean;
  /** The repos its isolated work changed, by path; empty for a group of one. */
  repos: string[];
  /** Integration stopped on a conflict: the one isolation state that needs the user. `resolver` is the task, by reference, that has it; then a second is not offered. */
  conflict: { repo: string | null; files: string | null; resolver: string | null } | null;
  /** A conflict repair that starts by itself once what it waits for clears (ADR-0015): `label` says what, in sentence case. Progress, so `conflict` is null. */
  repairWaiting: { label: string; files: string | null } | null;
  /** A conflict repair in flight (ADR-0015) — progress, not a blocker. */
  repairing: { files: string | null; attempt: { attempt: number; limit: number } | null } | null;
  /** The files a conflict repair was started for; `landed` once the task is integrated. */
  repaired: { files: string; landed: boolean } | null;
  /** The ancestors, by reference, whose work is not merged into the user's branch yet. */
  mergeGate: string[] | null;
  /** The failed tasks, by reference, a task not started waits on through its dependencies (ADR-0034); null when none. */
  blockedBy: string[] | null;
  /** Why a skipped task was skipped, as whoever skipped it put it; null for any other, or one skipped without a reason. */
  skipReason: string | null;
  /** An ops task changed tracked files in the user's checkout and nothing was committed. */
  opsChangedFiles: boolean;
  /** The ancestors, by title, a force start went past the merge gate of. */
  forcedPastGate: readonly string[] | null;
  /** Where the task stands in a loop (ADR-0045); null for a task in none. */
  loop: TaskRowLoop | null;
  /** What it handed over (ADR-0047); null for an attempt that left none, or a plan saved before handoffs. */
  handoff: TaskRowHandoff | null;
  /** The task's dependencies, by reference. */
  dependencies: string[];
  /** What the row offers while a plan runs. */
  actions: TaskRowAction[];
  /** Its landed work can be reverted before Merge all (ADR-0054): a surface offers Revert only then, and core's preview says the rest. */
  revertible: boolean;
  /** The one mark its toggle sets. */
  mark: 'complete' | 'uncomplete';
  opsEditable: boolean;
}

/**
 * Whether a task's chat exists: only once an attempt of it has started. A
 * manual task runs nothing, so it has none however it was marked. The attempt
 * ledger of a plan saved before the mark stands in for an AI task; a script's
 * attempt has no ledger, so neither gains one from a status alone.
 */
export function taskChatAvailable(task: { type?: string; attempted?: boolean; attemptUsage?: readonly AttemptUsage[] }): boolean {
  if (task.type === 'user') return false;
  return task.attempted === true || (task.attemptUsage?.length ?? 0) > 0;
}

const refsOf = (ids: readonly string[], tasks: readonly PlanRefTask[] | undefined): string[] =>
  ids.map((id) => (tasks?.length ? taskRefOf(tasks, id) ?? id : id));

/** A lone repository at the workspace root is not named: a group of one reads as it did before repo groups. */
const namedRepo = (repo: string | undefined): string | null => (repo && repo !== '.' ? repo : null);

/** The repos a task changed, for a row that names them; none for a group of one. */
export const namedRepos = (repos: readonly string[] | undefined): string[] => (repos ?? []).filter((r) => r !== '.');

const filesOf = (files: string[] | undefined): string | null => (files?.length ? capConflictFiles(files) : null);

const asBlocking = (tasks: readonly PlanRefTask[]): BlockingSubject[] =>
  tasks.map((t) => ({
    id: t.id, status: t.status ?? '', dependencies: t.dependencies ?? [], subtasks: asBlocking(t.subtasks ?? []),
    ...(t.loop ? { loop: t.loop, loopRound: t.loopRound, ...(t.verdict ? { verdict: t.verdict } : {}) } : {}),
  }));

/** A plan tree that carries statuses, read once: who it blocks, and which loops go on. */
interface PlanReading {
  tasks: readonly PlanRefTask[];
  blocks: PlanBlocks;
}

/** What blocks a task not started, read off the plan tree; empty without one that carries statuses. */
function blockedBy(task: TaskRowSubject, reading: PlanReading | null): string[] {
  if (!reading || !NOT_STARTED.has(task.status)) return [];
  return reading.blocks.blocked.get(task.id) ?? [];
}

/** What moves a check on that nothing will run: a start of it once its body landed and its dependencies finished, Execute before that (ADR-0045 L5, L7). */
function strandedDetail(check: LoopCheckFacts, dependencies: readonly string[], reading: PlanReading | null): string {
  const status = (id: string) => reading?.tasks.find((t) => t.id === id)?.status;
  const landed = reading && check.loop.body.every((id) => status(id) === 'completed');
  const finished = dependencies.every((id) => [undefined, 'completed', 'skipped'].includes(status(id)));
  return landed && finished ? `Nothing runs it now: start it for round ${loopRoundOf(check) + 1} of ${check.loop.maxRounds}` : 'Nothing runs it now: execute the plan and the loop goes on';
}

function loopOf(task: TaskRowSubject, reading: PlanReading | null): TaskRowLoop | null {
  const tasks = reading?.tasks;
  if (task.loop) {
    const check: LoopSubject & { loop: TaskLoop } = { id: task.id, status: task.status, loop: task.loop, loopRound: task.loopRound, ...(task.verdict ? { verdict: task.verdict } : {}) };
    // With no plan to read the body from, a check between rounds is taken to be going on.
    const state = loopCheckState(check, !task.loopStranded && (reading ? reading.blocks.repeating.has(task.id) : true));
    const body = refsOf(task.loop.body, tasks);
    // What stops a loop: a body task that failed, was skipped or is blocked (ADR-0045 L7).
    const halted = reading ? task.loop.body.filter((id) => {
      const status = reading.tasks.find((t) => t.id === id)?.status;
      return status === 'failed' || status === 'skipped' || reading.blocks.blocked.has(id);
    }) : [];
    const detail = state === 'repeating'
      ? `Found problems: runs again once ${body.join(', ')} ${body.length === 1 ? 'has' : 'have'} landed`
      : state === 'stopped'
        ? task.loopStranded
          ? strandedDetail(check, task.dependencies, reading)
          : `${refsOf(halted, tasks).join(', ')} did not pass: retry ${halted.length === 1 ? 'it' : 'them'} and the loop goes on`
        : null;
    return { role: 'check', state, label: loopCheckLabel(check, state), detail, body };
  }
  const owner = reading && checkOf(reading.tasks, task.id);
  if (!owner?.loop) return null;
  const [check] = refsOf([owner.id], tasks);
  const round = loopBodyRound({ status: owner.status ?? '', loopRound: owner.loopRound }, task.status);
  return { role: 'body', label: loopBodyLabel(check, round, owner.loop.maxRounds), check, round };
}

/** The compact handoff a row shows: a summary, its finding count and the worst severity the digest still holds. */
function handoffOf(task: TaskRowSubject): TaskRowHandoff | null {
  if (!task.handoff) return null;
  const patch = savedPatchView(task.handoff);
  return {
    ...(task.handoff.commit ? { commit: task.handoff.commit } : {}),
    summary: task.handoff.summary,
    findingCount: task.handoff.findingCount,
    severity: worstSeverity(task.handoff.findings),
    ...(patch ? { patch } : {}),
  };
}

function flagOf(task: TaskRowSubject, scope: AssignmentScope | undefined): Pick<TaskRowView, 'assignmentFlag' | 'assignmentConsequence'> {
  const issue = scope && task.assignedRunner !== undefined ? assignmentIssue({ ...task, assignedRunner: task.assignedRunner }, scope) : null;
  return issue
    ? { assignmentFlag: assignmentIssueText(issue), assignmentConsequence: assignmentConsequence(task) }
    : { assignmentFlag: null, assignmentConsequence: null };
}

/**
 * Everything a plan row says about one task, decided once: each surface picks
 * its own words, glyphs and casing for these facts, and derives none of them.
 */
export function taskRowView(task: TaskRowSubject, context: TaskRowContext = {}): TaskRowView {
  const parent = context.parent ?? undefined;
  const isolation = task.isolation && task.isolation.state !== 'none' ? task.isolation : null;
  const spend = taskUsageSummary(task);
  const latestAttempt = task.attemptUsage?.at(-1);
  // A check's own row is the newest word on it: the plan beside it may hold its verdict from before.
  const tasks = task.loop ? context.tasks?.map((t) => (t.id === task.id ? { ...t, status: task.status, loopRound: task.loopRound, verdict: task.verdict } : t)) : context.tasks;
  const reading = tasks?.length ? { tasks, blocks: planBlocks(asBlocking(tasks)) } : null;
  const blocked = blockedBy(task, reading);
  const loop = loopOf(task, reading);
  return {
    usage: latestAttempt ? { totals: spend.totals, ...(spend.contextFill ? { contextFill: spend.contextFill } : {}), attempt: latestAttempt.attempt } : task.type === 'ai' && ['completed', 'failed', 'in_progress', 'awaiting_user'].includes(task.status) ? { totals: {}, attempt: 0 } : null,
    orderLabel: taskOrderLabel(task, parent),
    kind: task.type === 'user' ? 'user' : task.type === 'script' ? 'script' : task.ops ? 'ops' : 'ai',
    // Between rounds a check waits for its fix as a task waits for its dependencies, and is no failure (ADR-0045 L3).
    status: blocked.length > 0 ? 'blocked' : loop?.role === 'check' && loop.state === 'repeating' ? 'todo' : taskStatusKind(task),
    running: isTaskRunning(task),
    chatAvailable: taskChatAvailable(task),
    awaiting: awaitingLabel(task),
    resumes: resumeLabel(task, context.now),
    approvals: approvalLabel(task.awaitingApproval),
    receipt: receiptLabel(task),
    attaching: attachingLabel(task),
    waitsForApproval: task.waitsForApproval && NOT_STARTED.has(task.status) ? WAITS_FOR_APPROVAL_LABEL : null,
    holdReason: task.holdReason?.trim() || null,
    research: task.type === 'ai' && task.research === true,
    runner: assignedRunnerOf(task) ?? null,
    ...flagOf(task, context.runnerScope),
    autonomous: task.type === 'ai' && context.modes?.find((m) => m.id === task.taskMode)?.autonomous === true,
    repos: namedRepos(isolation?.repos),
    conflict: isolation?.state === 'conflict' && !isolation.repairWaits
      ? { repo: namedRepo(isolation.conflictRepo), files: filesOf(isolation.conflictFiles), resolver: isolation.resolver ? refsOf([isolation.resolver], context.tasks)[0] : null }
      : null,
    repairWaiting: isolation?.state === 'conflict' && isolation.repairWaits
      ? { label: repairWaitLabel(isolation.repairWaits), files: filesOf(isolation.conflictFiles) }
      : null,
    repairing: isolation?.state === 'repairing'
      ? { files: filesOf(isolation.conflictFiles), attempt: isolation.repair ?? null }
      : null,
    repaired: isolation?.repairedFiles?.length
      ? { files: capConflictFiles(isolation.repairedFiles), landed: isolation.state === 'integrated' }
      : null,
    mergeGate: task.mergeGate?.length ? refsOf(task.mergeGate, context.tasks) : null,
    blockedBy: blocked.length > 0 ? refsOf(blocked, context.tasks) : null,
    skipReason: task.status === 'skipped' ? task.skipReason ?? null : null,
    opsChangedFiles: task.status === 'awaiting_user' && task.awaitingReason === 'files-changed',
    forcedPastGate: task.forcedPastGate?.length ? task.forcedPastGate : null,
    loop,
    handoff: handoffOf(task),
    dependencies: refsOf(task.dependencies, context.tasks),
    // A block read off the plan offers what a stored one does: Skip among them.
    actions: taskRowActions({ ...task, ...(blocked.length > 0 ? { status: 'blocked' } : {}), ...(isolation?.repairWaits ? { repairWaits: isolation.repairWaits } : {}) }, context.placement ?? (parent ? 'subtask' : 'task')),
    // Read off the mark itself: a task with merges left and no record has state `none`.
    revertible: task.isolation?.revertible === true,
    mark: markAction(task),
    opsEditable: opsEditable(task),
  };
}

/**
 * What a loop's row says, as the parts a surface joins: the check's round and
 * what the loop waits for or stopped at (or which tasks run if it fails, while
 * it has not failed yet); a body task's "runs if #1 fails". Sentence case.
 */
export function loopRowParts(loop: TaskRowLoop): string[] {
  if (loop.role === 'body') return [loop.label];
  const runs = loop.state === 'waiting' || loop.state === 'running' ? `Runs ${loop.body.join(', ')} if it fails` : null;
  return [loop.label, loop.detail ?? runs].filter((part): part is string => part !== null);
}
