import type { Task, TaskOutputSummary, TaskSkillSnapshot } from '../models/Task';
import { flattenTasksWithParents } from '../models/Task';
import type { PreservedWork, PreviousWork } from '../interfaces/IWorktreeIsolation';
import { SELF_REPO } from './isolationRecord';
import { renderTaskSkills } from './taskSkills';
import { assignedRunnerOf } from './AssignmentScope';
import { betweenRounds, loopRoundOf } from '../models/Loop';
import { REPORT_MAX_CHARS, artifactLines, boundedHandoffLines, findingLines, namedHandoff, openingLines, wordsFrom, type HandoffDigest, type StoredHandoff } from '../models/Handoff';

const MAX_TAIL_CHARS = 500;
/** Each dependency's share of a dependent's prompt, which carries every direct dependency's handoff (ADR-0047). */
const MAX_HANDOFF_CHARS = 4_000;
const DEFAULT_PLAN_MAP_MAX_ENTRIES = 30;
const PLAN_MAP_MIN_TASKS = 3;

export interface PriorOutput {
  /** The dependency's path label, dotted for a subtask (`1.1`). */
  label: string;
  title: string;
  reviewReason: string;
  /** What the dependency handed over (ADR-0047), the tasks it cites named as the plan names them; absent on a plan saved before handoffs. */
  handoff?: HandoffDigest;
  report?: string;
  logTail: string;
  /** Set for a dependency that was skipped: nothing of it landed. `reason` is the skipper's, when they gave one. */
  skipped?: { reason?: string };
  /** Set for the dependent's own loop's check, between rounds: the round its report is from (ADR-0045 L4). */
  round?: { round: number; maxRounds: number };
}

/** The session file holds every task's report, so a runaway one is cut; the whole handoff stays in the attempt's log (ADR-0047). */
function capReport(report: string): string {
  if (report.length <= REPORT_MAX_CHARS) return report;
  return `${report.slice(0, REPORT_MAX_CHARS).trimEnd()}\n\n[Report cut by Ordewell at ${REPORT_MAX_CHARS} characters; the whole handoff is in the attempt's log.]`;
}

export function summarizeOutput(reviewReason: string | undefined, output: string, report?: string): TaskOutputSummary {
  const kept = report?.trim();
  return {
    reviewReason: (reviewReason ?? '').trim(),
    ...(kept ? { report: capReport(kept) } : {}),
    logTail: kept ? '' : (output ?? '').slice(-MAX_TAIL_CHARS).trim(),
    capturedAt: new Date().toISOString(),
  };
}

/** `allTasks` is the plan tree, read in plan order, so a subtask is named by its dotted label. */
export function collectDirectDependencyOutputs(task: Task, allTasks: readonly Task[]): PriorOutput[] {
  const deps = new Set(task.dependencies ?? []);
  const out: PriorOutput[] = [];
  for (const { task: dep, label } of flattenTasksWithParents(allTasks)) {
    const skipped = dep.status === 'skipped' ? { ...(dep.skipReason ? { reason: dep.skipReason } : {}) } : undefined;
    // A skip is said even of a task that never ran: the dependent starts without it.
    if (!deps.has(dep.id) || (!dep.outputSummary && !dep.handoff && !skipped)) continue;
    // A check's summary is its latest round's: the loop clears it as the check runs again.
    const round = dep.loop?.body.includes(task.id) && betweenRounds(dep) ? { round: loopRoundOf(dep), maxRounds: dep.loop.maxRounds } : undefined;
    out.push({
      label,
      title: dep.title,
      reviewReason: dep.outputSummary?.reviewReason ?? '',
      ...(dep.handoff ? { handoff: namedHandoff(allTasks, dep.handoff) } : {}),
      report: dep.outputSummary?.report,
      logTail: dep.outputSummary?.logTail ?? '',
      ...(skipped ? { skipped } : {}),
      ...(round ? { round } : {}),
    });
  }
  return out;
}

function indent(text: string): string {
  return text.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
}

/**
 * A dependency's handoff within its share of the prompt (ADR-0047): the
 * commit and summary, then whole findings in the producer's order, stopping before the
 * first that would pass the ceiling, then the artifacts, which it does not
 * count. A finding is never cut. Those left out are counted from
 * `findingCount`, which includes the ones the plan's digest does not hold,
 * and pointed at where `read_task` finds them.
 */
function handoffText(handoff: HandoffDigest, label: string): string {
  return boundedHandoffLines(handoff, (more) => `(+${more} more finding${more === 1 ? '' : 's'}; read task #${label})`).join('\n');
}

/** A plan saved before handoffs has only the report, so its share is cut as it always was. */
function dependencyReport(report: string): string {
  if (report.length <= MAX_HANDOFF_CHARS) return report;
  return `${report.slice(0, MAX_HANDOFF_CHARS)}\n(report cut here: ${report.length - MAX_HANDOFF_CHARS} more characters)`;
}

/** Plan order of two path labels: `2` before `10`, and `1.2` before `1.10`. */
function compareLabels(a: string, b: string): number {
  const as = a.split('.').map(Number);
  const bs = b.split('.').map(Number);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const diff = (as[i] ?? -1) - (bs[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** A handoff's findings by their ids, which Ordewell numbers from F1 without gaps. */
function findingRange(count: number): string {
  return count === 1 ? 'F1' : count === 2 ? 'F1 and F2' : `F1 to F${count}`;
}

/** The pull beside the push (ADR-0047): the readable set reaches past the direct dependencies the prompt carries. */
const READ_TASK_NOTE = '`read_task` reads any of these tasks in full, every finding and its report, and the tasks they depend on too.';

export function renderPriorOutputs(outputs: PriorOutput[]): string {
  if (outputs.length === 0) return '';
  const blocks = outputs
    .sort((a, b) => compareLabels(a.label, b.label))
    .map((o) => {
      const heading = `### Task ${o.label}: ${o.title}`;
      const skip = o.skipped ? `- Skipped${o.skipped.reason ? `: ${o.skipped.reason.replace(/\.$/, '')}` : ' (no reason given)'}. None of its work landed, so it is not in your tree; do not count on it.` : '';
      if (o.skipped && !o.handoff && !o.reviewReason && !o.report && !o.logTail) return `${heading}\n${skip}`;
      const reason = o.reviewReason || '(no review note)';
      // Whose words, and that they are data: what a dependency says is never this task's brief (ADR-0057 R3).
      const output = o.handoff ? `- ${wordsFrom('Handoff', `#${o.label}`)}\n${indent(handoffText(o.handoff, o.label))}`
        : o.report ? `- ${wordsFrom('Report', `#${o.label}`)}\n${indent(dependencyReport(o.report))}`
        : `- ${wordsFrom('Tail', `#${o.label}`)}\n${o.logTail ? indent(o.logTail) : '  (no output captured)'}`;
      const answer = o.handoff?.findingCount ? `Answer its findings ${findingRange(o.handoff.findingCount)}. ` : '';
      const round = o.round
        ? `- The check of your loop: it failed round ${o.round.round} of ${o.round.maxRounds}, and you are part of the fix. ${answer}Fix what its report found; it runs again once the fix has landed.\n`
        : '';
      return `${heading}\n${skip ? `${skip}\n` : ''}${round}- Review: ${reason}\n${output}`;
    });
  // Only beside a handoff: a plan saved before them reads as it always did.
  const pull = outputs.some((o) => o.handoff) ? `${READ_TASK_NOTE}\n\n` : '';
  return `## Prior task outputs\n\n${pull}${blocks.join('\n\n')}`;
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
  if (task.status === 'skipped') return 'skipped';
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
 * path label the other surfaces use, so an `N.M` the model echoes back
 * matches what `resolveTaskId` accepts.
 */
export function renderPlanMap(planTasks: readonly Task[], currentTaskId: string, opts?: { maxEntries?: number }): string {
  const rows = flattenTasksWithParents(planTasks);
  if (rows.length < PLAN_MAP_MIN_TASKS) return '';

  // Top-level tasks first in order, then each parent's subtasks under it.
  const sorted = [...rows].sort((a, b) => {
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
    // A script task runs on no runner (ADR-0035): what it is says more than the runner it was never given.
    const assigned = assignedRunnerOf(row.task);
    const runner = row.task.type === 'script' ? ' (script)' : assigned ? ` (${assigned})` : '';
    return `${order}. [${tag.padEnd(7, ' ')}] ${row.task.title}${runner}${arrow}`;
  });

  const footer = omitted > 0 ? `\n(${omitted} task${omitted === 1 ? '' : 's'} omitted from this view)` : '';
  const currentRunner = currentTask && assignedRunnerOf(currentTask);
  const runnerNote = currentRunner ? `\nYou are running as: ${currentRunner}` : '';

  return [
    '## Plan map',
    '',
    'This is for context only — do ONLY the task marked `← you are here`. Future tasks will handle their own scope; do not preempt them.',
    '',
    lines.join('\n') + footer + runnerNote,
  ].join('\n');
}

/** What a read-only task is told it may do beyond reading (ADR-0050): the tool that keeps its prototype past its worktree. */
export const READ_ONLY_PATCH_NOTE = 'This task is read-only and its worktree is thrown away when it ends. If you build a prototype there, keep it with the `save_patch` tool before you finish: a later task can then apply it.';

export const READ_ONLY_WEB_NOTE = 'Read the web with the `fetch` and `web_search` tools: your runner\'s own web tools are off on this task, and these work whether or not your commands run sealed. Nobody is asked: a read the user\'s web-read settings do not already allow is refused, saying why. Do not retry a refusal; report what you could not read in your handoff.';

export interface ComposeOptions {
  /** A read-only task: told of `save_patch` (ADR-0050) and of its web reads (ADR-0046). */
  readOnly?: boolean;
  planMapEnabled?: boolean;
  planMapMaxEntries?: number;
  /** The task's skills as resolved where this attempt runs. */
  skills?: readonly TaskSkillSnapshot[];
  /** An ops task's last attempt, as its output ended (ADR-0020); absent on a first attempt. */
  previousAttempt?: string;
  /** A carry-over: the runner whose usage-limit-paused attempt this one starts from, and what became of that work. */
  carriedOver?: { from: string; work?: PreviousWork };
  /** The AI check's next round, after its body has landed (ADR-0047). */
  loop?: { round: number; previousHandoff?: StoredHandoff; previousReport?: string };
}

function renderSinceLastRound(task: Task, allTasks: readonly Task[], loop: NonNullable<ComposeOptions['loop']>): string {
  const lines = ['## Since your last round', '', '### Your previous handoff'];
  if (loop.previousHandoff) {
    // The opening the shared renderer writes, so a commit-only handoff is not blank; the findings stay one line each.
    const previous = namedHandoff(allTasks, loop.previousHandoff);
    lines.push(...openingLines(previous), ...previous.findings.flatMap(({ id, severity, title }) => findingLines({ id, severity, title })), ...artifactLines(previous));
  } else {
    lines.push('Your previous findings are not structured.', loop.previousReport || '(no previous report captured)');
  }
  const body = new Set(task.loop?.body);
  for (const { task: fix, label } of flattenTasksWithParents(allTasks)) {
    if (!body.has(fix.id)) continue;
    lines.push('', `### Task ${label}: ${fix.title}`);
    if (fix.handoff) lines.push(`- ${wordsFrom('Handoff', `#${label}`)}\n${indent(handoffText(namedHandoff(allTasks, fix.handoff), label))}`);
    else if (fix.outputSummary?.report) lines.push(`- ${wordsFrom('Report', `#${label}`)}\n${indent(dependencyReport(fix.outputSummary.report))}`);
  }
  lines.push('', `You are the check, round ${loop.round} of ${task.loop?.maxRounds}. Verify the fix claims against the tree; do not trust its summary. Answer each previous finding by its F number: fixed, still open, or superseded. Report only what still fails and anything new.`);
  return lines.join('\n');
}

/**
 * What an ops task's retry is told (ADR-0020). Its effects are outside the
 * repository and are never rolled back, so the last attempt may have done
 * part of the work already.
 */
function renderPreviousAttempt(output: string): string {
  const tail = output.trim() ? indent(output.trim()) : '  (no output captured)';
  return [
    '## Previous attempt',
    '',
    'This task ran before and did not finish. What it did outside the repository was not undone: before acting, check what already exists — resources, deployments, pushed refs — and do not repeat a step that already took effect.',
    '',
    'The end of its output:',
    tail,
  ].join('\n');
}

/** Where each repo's preserved work is, and how to look at it before recovering it. */
function keptWorkLines(preserved: readonly PreservedWork[], whose: string): string {
  return preserved.map((kept) => {
    const where = kept.repo === SELF_REPO ? `${whose[0].toUpperCase()}${whose.slice(1)}` : `In repository \`${kept.repo}\`, ${whose}`;
    return `${where} is kept on branch \`${kept.branch}\`. `
      + `Inspect it with \`git log ${kept.branch}\` and \`git diff HEAD...${kept.branch}\` before recovering it.`;
  }).join('\n');
}

/**
 * What a continued session is told became of the edits it remembers
 * (ADR-0018, K1). Absent work is in the checkout, where it was left.
 */
/** What a read-only task's continue is told of its earlier attempt's files: they went with its worktree (ADR-0046). */
export const READ_ONLY_CONTINUED_NOTE = 'This task is read-only, so nothing your earlier attempt changed was kept: check the working tree before relying on files you remember.';

export function continuedWorkNote(work: PreviousWork | undefined): string {
  if (!work) return 'Your previous changes are in the working tree (shared workspace).';
  if (work.outcome === 'restored') return 'Your previous changes are in the working tree.';
  return 'Your previous changes conflicted with the integration tip, so this working tree starts at the integration tip. '
    + keptWorkLines(work.preserved, 'your previous work');
}

/**
 * What a carry-over is told (ADR-0018, U1). A fresh session on another
 * runner finds files it did not write, and nothing of the reasoning behind
 * them, so it is told where they came from and not to trust them as done.
 */
function renderCarriedOver(from: string, work: PreviousWork | undefined): string {
  const moved = `This task was paused on ${from}'s usage limit and moved to you.`;
  const body = work?.outcome === 'fallback'
    ? `${moved} The work its previous attempt on ${from} left could not be applied on top of the integration tip, so your working tree starts fresh at the integration tip. `
      + `${keptWorkLines(work.preserved, "the previous attempt's work")} It may be unfinished.`
    : `${moved} The files in your working tree come from a previous attempt on ${from} and may be unfinished: check what is already there before building on it. That attempt's session is not continued.`;
  return ['## Work carried over', '', body].join('\n');
}

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

/**
 * A task's first message. How it ends — the `task_complete` call and its
 * report — is in the runner's instructions, not here (`TASK_COMPLETION_CONTRACT`).
 */
export function composeAugmentedPrompt(task: Task, allTasks: readonly Task[], opts?: ComposeOptions): string {
  const basePrompt = task.prompt ?? '';
  const blocks: string[] = [];

  if (opts?.loop && task.type === 'ai' && task.loop && opts.loop.round > 1) {
    blocks.push(renderSinceLastRound(task, allTasks, opts.loop));
  }

  if (opts?.planMapEnabled !== false) {
    const map = renderPlanMap(allTasks, task.id, { maxEntries: opts?.planMapMaxEntries });
    if (map) blocks.push(map);
  }

  const outputs = collectDirectDependencyOutputs(task, allTasks);
  if (outputs.length > 0) blocks.push(renderPriorOutputs(outputs));

  if (opts?.previousAttempt !== undefined) blocks.push(renderPreviousAttempt(opts.previousAttempt));

  if (opts?.carriedOver) blocks.push(renderCarriedOver(opts.carriedOver.from, opts.carriedOver.work));

  if (opts?.skills?.length) blocks.push(renderTaskSkills(opts.skills));

  if (opts?.readOnly) blocks.push(READ_ONLY_PATCH_NOTE, READ_ONLY_WEB_NOTE);

  if (isHitlTask(task)) blocks.push(CHECKPOINT_INSTRUCTION);

  if (blocks.length === 0) return basePrompt;
  return `${blocks.join('\n\n')}\n\n${basePrompt}`;
}

/**
 * The first turn of a continue (ADR-0018, K1): the user's message, then a
 * short reminder of the protocol. The resumed session already holds the
 * original prompt, so it is not sent again. The attempt supplies what happened
 * to its previous work once its working directory has been prepared.
 */
export function composeContinuationPrompt(task: Task, message: string, opts: { ops?: boolean } = {}): string {
  const reminder = [
    opts.ops
      ? '(Ordewell) You are continuing this task in the same session, in the same checkout. What your earlier attempt did outside the repository was not undone: check what already exists before acting again.'
      : '(Ordewell) You are continuing this task in the same session. Check the working tree before relying on the files remembered from your earlier attempt.',
  ];
  if (isHitlTask(task)) {
    reminder.push('If you reach a decision that needs human judgment, call the `checkpoint` tool: its result is `continue` or `rejected: <why>`.');
  }
  return `${message.trim()}\n\n---\n${reminder.join('\n\n')}`;
}
