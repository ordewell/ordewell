import type { Task } from '../models/Task';

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

export function collectDirectDependencyOutputs(task: Task, allTasks: Task[]): PriorOutput[] {
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
 */
function defuseMarkers(text: string): string {
  return text.replace(/<<<ORDEWELL_/g, '<<<ORDEWELL-');
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

export function augmentPromptWithPriorOutputs(task: Task, allTasks: Task[]): string {
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

function pickWindow(sorted: Task[], currentIdx: number, max: number): { window: Task[]; omitted: number } {
  if (sorted.length <= max) return { window: sorted, omitted: 0 };
  if (currentIdx < 0) return { window: sorted.slice(0, max), omitted: sorted.length - max };
  const lookBack = Math.min(currentIdx, Math.floor(max / 3));
  let start = currentIdx - lookBack;
  if (start + max > sorted.length) start = sorted.length - max;
  if (start < 0) start = 0;
  const window = sorted.slice(start, start + max);
  return { window, omitted: sorted.length - window.length };
}

export function renderPlanMap(allTasks: Task[], currentTaskId: string, opts?: { maxEntries?: number }): string {
  if (allTasks.length < PLAN_MAP_MIN_TASKS) return '';

  const sorted = [...allTasks].sort((a, b) => a.order - b.order);
  const max = opts?.maxEntries ?? DEFAULT_PLAN_MAP_MAX_ENTRIES;
  const currentIdx = sorted.findIndex((t) => t.id === currentTaskId);
  const { window, omitted } = pickWindow(sorted, currentIdx, max);

  const currentTask = sorted.find((t) => t.id === currentTaskId);

  const widthOrder = Math.max(2, String(sorted[sorted.length - 1]?.order ?? sorted.length).length);
  const lines = window.map((t) => {
    const isCurrent = t.id === currentTaskId;
    const tag = planMapStatus(t, isCurrent);
    const order = String(t.order).padStart(widthOrder, ' ');
    const arrow = isCurrent ? '   ← you are here' : '';
    const runner = t.assignedRunner ? ` (${t.assignedRunner})` : '';
    return `${order}. [${tag.padEnd(7, ' ')}] ${t.title}${runner}${arrow}`;
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
  tddEnabled?: boolean;
}

function renderCompletionMarker(task: Task): string {
  // The marker is given in two halves so the assembled token never appears in
  // this prompt. Interactive TUIs echo the prompt into the terminal, and the
  // watcher scans terminal output for the token — a literal marker here would
  // complete the task the moment the session starts.
  return `\n\nWhen you have fully completed this task, print one final line containing only the completion marker. Build it by writing \`<<<ORDEWELL_\` immediately followed by \`DONE_${task.completionMarker}>>>\` — joined into a single unbroken token, with no space, quote, or any other character between the two parts.`;
}

function renderTddInstruction(): string {
  return [
    '## Implementation workflow (TDD)',
    '',
    'Work test-first in vertical slices at the seams your task prompt names. A seam is the public boundary you test at — if the prompt names none, identify the highest public interface and test there, never against internals.',
    '',
    '1. RED: Write ONE failing test for the next behavior, through the public interface',
    '2. GREEN: Write minimal production code to make that test pass',
    '',
    'Rules:',
    '- One test per RED-GREEN cycle — do not write all tests first',
    '- Expected values must come from an independent source of truth (spec, worked example, known-good literal), never recomputed the way the code computes them',
    '- Prefer integration-style tests over unit tests with mocks; tests should survive internal refactors',
    '- Use the project\'s existing test framework and patterns',
    '- While iterating, run the typechecker and the single test file you are touching frequently; run the full test suite once at the end of the task',
    '- Refactoring is not part of the red-green cycle: only once all tests are green, tidy what this task touched, keeping tests green',
  ].join('\n');
}

function renderCheckpointInstruction(): string {
  return [
    '## Human-in-the-loop checkpoints',
    '',
    'When you reach a decision point that requires human judgment — before destructive',
    'operations, after major design decisions, or when multiple viable paths exist — pause',
    'and request input:',
    '',
    // Two halves, for the same reason as the completion marker above: the
    // watcher scans terminal output for this token, and interactive runners echo
    // the prompt — a literal marker here checkpointed the task (dropping it out
    // of `in_progress`) the moment the session started.
    '1. Print one line holding only the checkpoint marker. Build it by writing `<<<ORDEWELL_` immediately followed by `CHECKPOINT:` — no space, quote, or any other character between those two parts — then a brief summary of what you are about to do and why human input is needed, closed with `>>>`',
    '2. Wait for the human to respond (they will send ORDEWELL_CONTINUE or ORDEWELL_REJECT)',
    '3. On CONTINUE: proceed with the action you described',
    '4. On REJECT: adjust your approach and re-emit a checkpoint if needed',
  ].join('\n');
}

function isHitlTask(task: Task): boolean {
  return task.autonomy === 'HITL' || task.sliceType === 'HITL';
}

export function composeAugmentedPrompt(task: Task, allTasks: Task[], opts?: ComposeOptions): string {
  const basePrompt = task.prompt ?? '';
  const blocks: string[] = [];

  if (opts?.planMapEnabled !== false) {
    const map = renderPlanMap(allTasks, task.id, { maxEntries: opts?.planMapMaxEntries });
    if (map) blocks.push(map);
  }

  const outputs = collectDirectDependencyOutputs(task, allTasks);
  if (outputs.length > 0) blocks.push(renderPriorOutputs(outputs));

  if (opts?.tddEnabled) {
    blocks.push(renderTddInstruction());
  }

  if (isHitlTask(task)) {
    blocks.push(renderCheckpointInstruction());
  }

  const marker = renderCompletionMarker(task);

  if (blocks.length === 0) return basePrompt + marker;
  return `${blocks.join('\n\n')}\n\n${basePrompt}${marker}`;
}
