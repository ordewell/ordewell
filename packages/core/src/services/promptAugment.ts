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

/**
 * Break marker tokens carried in a predecessor's captured output. Interactive
 * runners echo the prompt they are given, and the watcher scans that terminal
 * output — a quoted marker would settle this task on the previous one's
 * evidence. Hyphenated rather than spaced: the scanner also reads a
 * whitespace-flattened view of the terminal, which would rejoin a space.
 *
 * A completion marker also loses its id: transcripts are bound to a task by
 * that id, and a dependent's transcript quoting it would answer for the
 * predecessor the next time the predecessor runs.
 */
export function defuseMarkers(text: string): string {
  return text
    .replace(/<<<ORDEWELL_DONE_[^\s>]*>>>/g, '<<<ORDEWELL-DONE>>>')
    .replace(/<<<ORDEWELL_/g, '<<<ORDEWELL-');
}

export function renderPriorOutputs(outputs: PriorOutput[]): string {
  if (outputs.length === 0) return '';
  const blocks = outputs
    .sort((a, b) => a.order - b.order)
    .map((o) => {
      const tail = o.logTail
        ? defuseMarkers(o.logTail).split('\n').map((l) => '  ' + l).join('\n')
        : '  (no output captured)';
      const reason = defuseMarkers(o.reviewReason) || '(no review note)';
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
  /** The runner is given the `task_complete` and `checkpoint` tools (ADR-0022); the markers stay as their fallback. */
  completionTool?: boolean;
}

/**
 * What an ops task's retry is told (ADR-0020). Its effects are outside the
 * repository and are never rolled back, so the last attempt may have done
 * part of the work already.
 */
function renderPreviousAttempt(output: string): string {
  const tail = output.trim()
    ? defuseMarkers(output.trim()).split('\n').map((l) => '  ' + l).join('\n')
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

function renderCompletionMarker(task: Task, completionTool = false): string {
  // The marker is given in two halves so the assembled token never appears in
  // this prompt. Interactive TUIs echo the prompt into the terminal, and the
  // watcher scans terminal output for the token — a literal marker here would
  // complete the task the moment the session starts.
  const howto = `Build it by writing \`<<<ORDEWELL_\` immediately followed by \`DONE_${task.completionMarker}>>>\` — joined into a single unbroken token, with no space, quote, or any other character between the two parts.`;
  if (!completionTool) return `\n\nWhen you have fully completed this task, print one final line containing only the completion marker. ${howto}`;
  return `\n\nWhen you have fully completed this task, call the \`task_complete\` tool with status \`done\` and a summary of what you did; the tasks that depend on this one are given that summary. If you cannot complete it, call \`task_complete\` with status \`blocked\` or \`failed\` and the reason instead, and print no marker. After a \`done\` call, or if the tool is not available to you, also print one final line containing only the completion marker. ${howto}`;
}

/*
 * Two halves, for the same reason as the completion marker above: the
 * watcher scans terminal output for this token, and interactive runners echo
 * the prompt — a literal marker here checkpointed the task (dropping it out
 * of `in_progress`) the moment the session started.
 */
const CHECKPOINT_MARKER_HOWTO = 'Build it by writing `<<<ORDEWELL_` immediately followed by `CHECKPOINT:` — no space, quote, or any other character between those two parts — then a brief summary of what you are about to do and why human input is needed, closed with `>>>`';

function renderCheckpointInstruction(checkpointTool = false): string {
  if (checkpointTool) {
    return [
      '## Human-in-the-loop checkpoints',
      '',
      'When you reach a decision point that requires human judgment — before destructive',
      'operations, after major design decisions, or when multiple viable paths exist — pause',
      'and request input:',
      '',
      '1. Call the `checkpoint` tool with a brief summary of what you are about to do and why human input is needed. The call waits for the human, and its result is their answer',
      '2. If the result is `continue`: proceed with the action you described',
      '3. If the result starts with `rejected:`: the rest is why. Adjust your approach and call `checkpoint` again if needed',
      `4. If the \`checkpoint\` tool is not available to you, or the call fails, fall back to the marker: print one line holding only the checkpoint marker and wait for ORDEWELL_CONTINUE or ORDEWELL_REJECT. ${CHECKPOINT_MARKER_HOWTO}`,
    ].join('\n');
  }
  return [
    '## Human-in-the-loop checkpoints',
    '',
    'When you reach a decision point that requires human judgment — before destructive',
    'operations, after major design decisions, or when multiple viable paths exist — pause',
    'and request input:',
    '',
    `1. Print one line holding only the checkpoint marker. ${CHECKPOINT_MARKER_HOWTO}`,
    '2. Wait for the human to respond (they will send ORDEWELL_CONTINUE or ORDEWELL_REJECT)',
    '3. On CONTINUE: proceed with the action you described',
    '4. On REJECT: adjust your approach and re-emit a checkpoint if needed',
  ].join('\n');
}

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

  if (isHitlTask(task)) {
    blocks.push(renderCheckpointInstruction(opts?.completionTool));
  }

  const marker = renderCompletionMarker(task, opts?.completionTool);

  if (blocks.length === 0) return basePrompt + marker;
  return `${blocks.join('\n\n')}\n\n${basePrompt}${marker}`;
}

/**
 * The first turn of a continue (ADR-0018, K1): the user's message, then a
 * short reminder of the protocol. The resumed session already holds the
 * original prompt, so it is not sent again — but it holds the old worktree
 * too, and this attempt's is fresh from the integration branch.
 */
export function composeContinuationPrompt(task: Task, message: string, opts: { ops?: boolean; completionTool?: boolean } = {}): string {
  const reminder = [
    opts.ops
      ? '(Ordewell) You are continuing this task in the same session, in the same checkout. What your earlier attempt did outside the repository was not undone: check what already exists before acting again.'
      : '(Ordewell) You are continuing this task in the same session. Your working directory was recreated from the integration branch: work from your earlier attempt is there only if it landed, so check the files before relying on them.',
  ];
  if (isHitlTask(task)) {
    reminder.push(opts.completionTool
      ? `If you reach a decision that needs human judgment, call the \`checkpoint\` tool: its result is \`continue\` or \`rejected: <why>\`. Only if the tool is not available to you, print one line holding only the checkpoint marker and wait for ORDEWELL_CONTINUE or ORDEWELL_REJECT. ${CHECKPOINT_MARKER_HOWTO}.`
      : `If you reach a decision that needs human judgment, print one line holding only the checkpoint marker and wait for ORDEWELL_CONTINUE or ORDEWELL_REJECT. ${CHECKPOINT_MARKER_HOWTO}.`);
  }
  return `${message.trim()}\n\n---\n${reminder.join('\n\n')}${renderCompletionMarker(task, opts.completionTool)}`;
}
