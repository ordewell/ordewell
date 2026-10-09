import type { Task, TaskSkillSnapshot } from '../models/Task';
import { flattenTasks, flattenTasksWithParents, taskOrderLabel } from '../models/Task';
import { renderTaskSkills } from './taskSkills';

const MAX_TAIL_CHARS = 500;
const DEFAULT_PLAN_MAP_MAX_ENTRIES = 30;
const PLAN_MAP_MIN_TASKS = 3;

export interface PriorOutput {
  order: number;
  title: string;
  reviewReason: string;
  logTail: string;
}

export function summarizeOutput(reviewReason: string | undefined, output: string): { reviewReason: string; logTail: string; capturedAt: string } {
  return {
    reviewReason: (reviewReason ?? '').trim(),
    logTail: (output ?? '').slice(-MAX_TAIL_CHARS).trim(),
    capturedAt: new Date().toISOString(),
  };
}

export function collectDirectDependencyOutputs(task: Task, allTasks: readonly Task[]): PriorOutput[] {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const out: PriorOutput[] = [];
  for (const depId of task.dependencies ?? []) {
    const dep = byId.get(depId);
    if (!dep || !dep.outputSummary) continue;
    out.push({
      order: dep.order,
      title: dep.title,
      reviewReason: dep.outputSummary.reviewReason,
      logTail: dep.outputSummary.logTail,
    });
  }
  return out;
}

export function renderPriorOutputs(outputs: PriorOutput[]): string {
  if (outputs.length === 0) return '';
  const blocks = outputs
    .sort((a, b) => a.order - b.order)
    .map((o) => {
      const tail = o.logTail
        ? o.logTail.split('\n').map((l) => '  ' + l).join('\n')
        : '  (no output captured)';
      const reason = o.reviewReason || '(no review note)';
      return `### Task ${o.order}: ${o.title}\n- Review: ${reason}\n- Tail:\n${tail}`;
    });
  return `## Prior task outputs\n\n${blocks.join('\n\n')}`;
}

export function augmentPromptWithPriorOutputs(task: Task, allTasks: readonly Task[]): string {
  const basePrompt = task.prompt ?? '';
  const outputs = collectDirectDependencyOutputs(task, allTasks);
  if (outputs.length === 0) return basePrompt;
  return `${renderPriorOutputs(outputs)}\n\n${basePrompt}`;
}

function planMapStatus(task: Task, isCurrent: boolean): string {
  if (isCurrent) return 'NOW';
  if (task.status === 'completed') return 'done';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'in_progress') return 'running';
  if (task.type === 'user') return 'user';
  return 'next';
}

interface PlanMapRow {
  task: Task;
  parent: Task | null;
  label: string;
}

function pickWindow(sorted: PlanMapRow[], currentIdx: number, max: number): { window: PlanMapRow[]; omitted: number } {
  if (sorted.length <= max) return { window: sorted, omitted: 0 };
  if (currentIdx < 0) return { window: sorted.slice(0, max), omitted: sorted.length - max };
  const lookBack = Math.min(currentIdx, Math.floor(max / 3));
  let start = currentIdx - lookBack;
  if (start + max > sorted.length) start = sorted.length - max;
  if (start < 0) start = 0;
  const window = sorted.slice(start, start + max);
  return { window, omitted: sorted.length - window.length };
}

/**
 * Numbered task list for the model's context. `planTasks` is the nested task
 * tree; subtasks render indented under their parent with the same dotted
 * `taskOrderLabel` the other surfaces use, so an `N.M` the model echoes back
 * matches what `resolveTaskId` accepts.
 */
export function renderPlanMap(planTasks: readonly Task[], currentTaskId: string, opts?: { maxEntries?: number }): string {
  const rows = flattenTasksWithParents(planTasks);
  if (rows.length < PLAN_MAP_MIN_TASKS) return '';

  // Top-level tasks first in order, then each parent's subtasks under it.
  const sorted = rows.map((r) => ({
    ...r,
    label: taskOrderLabel(r.task, r.parent ?? undefined),
  })).sort((a, b) => {
    const parentDiff = (a.parent?.order ?? -1) - (b.parent?.order ?? -1);
    if (parentDiff !== 0) return parentDiff;
    return a.task.order - b.task.order;
  });
  const max = opts?.maxEntries ?? DEFAULT_PLAN_MAP_MAX_ENTRIES;
  const currentIdx = sorted.findIndex((r) => r.task.id === currentTaskId);
  const { window, omitted } = pickWindow(sorted, currentIdx, max);

  const currentTask = sorted.find((r) => r.task.id === currentTaskId)?.task;

  const lines = window.map((row) => {
    const isCurrent = row.task.id === currentTaskId;
    const tag = planMapStatus(row.task, isCurrent);
    const order = row.parent ? row.label : row.label.padStart(2, ' ');
    const arrow = isCurrent ? '   ← you are here' : '';
    const runner = row.task.assignedRunner ? ` (${row.task.assignedRunner})` : '';
    return `${order}. [${tag.padEnd(7, ' ')}] ${row.task.title}${runner}${arrow}`;
  });

  const footer = omitted > 0 ? `\n(${omitted} task${omitted === 1 ? '' : 's'} omitted from this view)` : '';
  const runnerNote = currentTask?.assignedRunner
    ? `\nYou are running as: ${currentTask.assignedRunner}`
    : '';

  return [
    '## Plan map',
    '',
    'This is for context only — do ONLY the task marked `← you are here`. Future tasks will handle their own scope; do not preempt them.',
    '',
    lines.join('\n') + footer + runnerNote,
  ].join('\n');
}

export interface ComposeOptions {
  planMapEnabled?: boolean;
  planMapMaxEntries?: number;
  /** The task's skills as resolved where this attempt runs. */
  skills?: readonly TaskSkillSnapshot[];
  /** An ops task's last attempt, as its output ended (ADR-0020); absent on a first attempt. */
  previousAttempt?: string;
}

/**
 * What an ops task's retry is told (ADR-0020). Its effects are outside the
 * repository and are never rolled back, so the last attempt may have done
 * part of the work already.
 */
function renderPreviousAttempt(output: string): string {
  const tail = output.trim()
    ? output.trim().split('\n').map((l) => '  ' + l).join('\n')
    : '  (no output captured)';
  return [
    '## Previous attempt',
    '',
    'This task ran before and did not finish. What it did outside the repository was not undone: before acting, check what already exists — resources, deployments, pushed refs — and do not repeat a step that already took effect.',
    '',
    'The end of its output:',
    tail,
  ].join('\n');
}

const COMPLETION_INSTRUCTION = '\n\nWhen you have fully completed this task, call the `task_complete` tool with status `done` and a summary of what you did; the tasks that depend on this one are given that summary. If you cannot complete it, call `task_complete` with status `blocked` or `failed` and the reason instead.';

const CHECKPOINT_INSTRUCTION = [
  '## Human-in-the-loop checkpoints',
  '',
  'When you reach a decision point that requires human judgment — before destructive',
  'operations, after major design decisions, or when multiple viable paths exist — pause',
  'and request input:',
  '',
  '1. Call the `checkpoint` tool with a brief summary of what you are about to do and why human input is needed. The call waits for the human, and its result is their answer',
  '2. If the result is `continue`: proceed with the action you described',
  '3. If the result starts with `rejected:`: the rest is why. Adjust your approach and call `checkpoint` again if needed',
].join('\n');

function isHitlTask(task: Task): boolean {
  return task.autonomy === 'HITL' || task.sliceType === 'HITL';
}

export function composeAugmentedPrompt(task: Task, allTasks: readonly Task[], opts?: ComposeOptions): string {
  const basePrompt = task.prompt ?? '';
  const blocks: string[] = [];

  if (opts?.planMapEnabled !== false) {
    const map = renderPlanMap(allTasks, task.id, { maxEntries: opts?.planMapMaxEntries });
    if (map) blocks.push(map);
  }

  const flat = flattenTasks(allTasks);
  const outputs = collectDirectDependencyOutputs(task, flat);
  if (outputs.length > 0) blocks.push(renderPriorOutputs(outputs));

  if (opts?.previousAttempt !== undefined) blocks.push(renderPreviousAttempt(opts.previousAttempt));

  if (opts?.skills?.length) blocks.push(renderTaskSkills(opts.skills));

  if (isHitlTask(task)) blocks.push(CHECKPOINT_INSTRUCTION);

  if (blocks.length === 0) return basePrompt + COMPLETION_INSTRUCTION;
  return `${blocks.join('\n\n')}\n\n${basePrompt}${COMPLETION_INSTRUCTION}`;
}

/**
 * The first turn of a continue (ADR-0018, K1): the user's message, then a
 * short reminder of the protocol. The resumed session already holds the
 * original prompt, so it is not sent again — but it holds the old worktree
 * too, and this attempt's is fresh from the integration branch.
 */
export function composeContinuationPrompt(task: Task, message: string, opts: { ops?: boolean } = {}): string {
  const reminder = [
    opts.ops
      ? '(Ordewell) You are continuing this task in the same session, in the same checkout. What your earlier attempt did outside the repository was not undone: check what already exists before acting again.'
      : '(Ordewell) You are continuing this task in the same session. Your working directory was recreated from the integration branch: work from your earlier attempt is there only if it landed, so check the files before relying on them.',
  ];
  if (isHitlTask(task)) {
    reminder.push('If you reach a decision that needs human judgment, call the `checkpoint` tool: its result is `continue` or `rejected: <why>`.');
  }
  return `${message.trim()}\n\n---\n${reminder.join('\n\n')}${COMPLETION_INSTRUCTION}`;
}
