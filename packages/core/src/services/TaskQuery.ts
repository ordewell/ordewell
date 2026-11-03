import type { DiscoveredModel, RunnerId, Task, Verdict } from '../models/Task';
import { extractObjectsWithKey, stripTrailingCommas, escapeControlCharsInStrings, PlanParseError, TASK_QUERY_ENVELOPE_KEY } from './JsonExtractor';
import { readOnlyMode, type RunnerModeInfo } from './ModeResolver';
import type { LiveTail, LiveTailOptions } from '../interfaces/TaskOutputSource';
import { resolveTaskRef, taskRefOf } from './TaskRefs';
import { commandLine, scriptBodyOf, type ScriptBody } from '../models/ScriptTask';
import { betweenRounds, checkOf, loopRoundOf } from '../models/Loop';
import { handoffLines, namedHandoff, type HandoffDigest } from '../models/Handoff';

/**
 * The planner's read channel: a `{"taskQuery":{...}}` reply asking Ordewell to
 * show it what the plan block deliberately leaves out.
 *
 * The plan block carries only short fields, so a planner asked to "add a line
 * to task 3's prompt" would be rewriting text it has never read. Inlining every
 * body on every turn was rejected — a twenty-task plan re-sends thousands of
 * tokens per message — so the planner asks instead, and pays for the detail
 * only on the turns it uses it.
 *
 * This module owns the wire shape, the one read of a task both channels render,
 * and the rendering of the answer; the loop, the budgets and the injection
 * live in the Session, and the classification lives in PlanRepair alongside
 * the plan and task-ops envelopes.
 */

/** The long fields a query may ask for. Everything else is already in the plan block. */
export const TASK_QUERY_FIELDS = [
  'description', 'prompt', 'userSteps', 'verdict', 'outputSummary', 'handoff', 'userStoriesCovered', 'skills', 'output',
] as const;

export type TaskQueryField = typeof TASK_QUERY_FIELDS[number];

/** What `task_query` reads: every field but `output`, which has its own tool (ADR-0022). */
export const TASK_QUERY_TASK_FIELDS = TASK_QUERY_FIELDS.filter((f): f is Exclude<TaskQueryField, 'output'> => f !== 'output');

/** Where a handoff's digest sends a planner for what it leaves out (ADR-0047): the attempt's log, read with `task_output`. */
export function handoffRest(handoff: HandoffDigest): string {
  const shown = handoff.findings.length;
  return handoff.findingCount > shown
    ? `Findings F${shown + 1} to F${handoff.findingCount} and the report are in the attempt's log: read them with task_output.`
    : 'The report, if the task wrote one, is in the attempt\'s log: read it with task_output.';
}

/** Lines a `output` read returns when the query sets no count. */
export const OUTPUT_LINES_DEFAULT = 80;
/** Hard cap on `outputLines` — the tail read is bounded however the planner asks. */
export const OUTPUT_LINES_MAX = 400;

/**
 * Character budget the rendered answer converges to. A running output tail is
 * trimmed to what is left of it, and the tasks asked for stop where it runs out
 * ({@link readsInCap}); the catalog is bounded upstream. One task is the
 * exception: it is read whole, so a task with a long prompt can pass this.
 */
export const TASK_QUERY_ANSWER_MAX_CHARS = 20_000;
/** Room for the closing instruction and whatever follows a task's tail. */
const ANSWER_TAIL_RESERVE = 4_000;
/** The most an output read returns; what a read of one task's tail gets when nothing else is in the answer. */
export const OUTPUT_TAIL_MAX_CHARS = TASK_QUERY_ANSWER_MAX_CHARS - ANSWER_TAIL_RESERVE;
/** How many references a stopped answer names before it counts the rest. */
const UNREAD_NAMED_MAX = 50;

/**
 * What one query reads, for both channels: each task once however it was named,
 * in the order asked, stopping before the one that would pass the budget. The
 * first is read whole at any length, since a planner rewrites what it reads and
 * a cut prompt would be rewritten as if it were all. `unread` says what stopped
 * the answer, so a long read costs another query and loses nothing.
 */
export function readsInCap<R>(
  refs: readonly string[],
  tasks: readonly Task[],
  read: (ref: string, task: Task | undefined) => R,
  chars: (one: R) => number,
): { reads: R[]; unread?: string } {
  const seen = new Set<string>();
  const reads: R[] = [];
  const left: string[] = [];
  let used = 0;
  for (const ref of refs) {
    const task = resolveTaskRef(tasks, ref);
    const key = task?.id ?? ref;
    if (seen.has(key)) continue;
    seen.add(key);
    if (left.length > 0) {
      left.push(ref);
      continue;
    }
    const one = read(ref, task);
    used += chars(one);
    if (used > OUTPUT_TAIL_MAX_CHARS && reads.length > 0) left.push(ref);
    else reads.push(one);
  }
  if (left.length === 0) return { reads };
  const more = left.length - UNREAD_NAMED_MAX;
  const named = [...left.slice(0, UNREAD_NAMED_MAX), ...(more > 0 ? [`+${more} more`] : [])].join(', ');
  return { reads, unread: `Not read, to keep this answer bounded: ${named}. Ask for them in another query.` };
}

export interface TaskQuery {
  /** Task references to read in full, as {@link resolveTaskRef} reads them. */
  tasks: string[];
  /** Narrows what comes back. Omitted means every field in {@link TASK_QUERY_FIELDS}. */
  fields?: TaskQueryField[];
  /** Also return the full runner/model catalog with labels, variants and mode descriptions. */
  catalog: boolean;
  /** Line count for `output` reads. Clamped at render to [1, {@link OUTPUT_LINES_MAX}]. */
  outputLines?: number;
  /** A previous answer's next offset: the output tail then covers only what came after it. */
  outputSince?: number;
}

export function textHasTaskQuery(text: string): boolean {
  return text.includes(`"${TASK_QUERY_ENVELOPE_KEY}"`);
}

/** Parse a `{"taskQuery":...}` reply. Throws PlanParseError when the JSON is unusable. */
export function parseTaskQueryJson(text: string): TaskQuery {
  const { matches, fallback } = extractObjectsWithKey(text, TASK_QUERY_ENVELOPE_KEY);
  const candidates = matches.length > 0 ? [...matches].reverse() : [fallback.json];

  let lastError: PlanParseError | null = null;
  for (const json of candidates) {
    try {
      return parseTaskQueryObject(json, text);
    } catch (err) {
      if (!(err instanceof PlanParseError)) throw err;
      if (!lastError) lastError = err;
    }
  }
  throw lastError ?? new PlanParseError('No JSON object found in task-query reply', text);
}

function parseTaskQueryObject(json: string, text: string): TaskQuery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(escapeControlCharsInStrings(stripTrailingCommas(json)));
  } catch (err) {
    throw new PlanParseError(`Task-query JSON is invalid: ${err instanceof Error ? err.message : String(err)}`, text);
  }
  const raw = (parsed as { taskQuery?: unknown }).taskQuery;
  // A bare array is the shorthand models reach for; it means "read these tasks".
  const body = Array.isArray(raw) ? { tasks: raw } : raw;
  if (typeof body !== 'object' || body === null) {
    throw new PlanParseError('"taskQuery" must be an object (or an array of task references)', text);
  }

  const { tasks: rawTasks, fields: rawFields, catalog: rawCatalog, outputLines: rawLines, outputSince: rawSince } = body as Record<string, unknown>;

  const tasks: string[] = [];
  if (rawTasks !== undefined) {
    if (!Array.isArray(rawTasks)) throw new PlanParseError('"tasks" in a taskQuery must be an array of task references', text);
    for (const ref of rawTasks) {
      if (typeof ref !== 'string' && typeof ref !== 'number') {
        throw new PlanParseError(`Invalid task reference "${String(ref)}" in taskQuery`, text);
      }
      tasks.push(String(ref).trim());
    }
  }

  let fields: TaskQueryField[] | undefined;
  if (rawFields !== undefined) {
    if (!Array.isArray(rawFields)) throw new PlanParseError('"fields" in a taskQuery must be an array of field names', text);
    fields = [];
    for (const f of rawFields) {
      if (typeof f !== 'string' || !(TASK_QUERY_FIELDS as readonly string[]).includes(f)) {
        throw new PlanParseError(`Unknown taskQuery field "${String(f)}" — choose from ${TASK_QUERY_FIELDS.join(', ')}`, text);
      }
      fields.push(f as TaskQueryField);
    }
  }

  const catalog = rawCatalog === true;

  let outputLines: number | undefined;
  if (rawLines !== undefined) {
    if (typeof rawLines !== 'number' || !Number.isFinite(rawLines) || rawLines < 1) {
      throw new PlanParseError('"outputLines" in a taskQuery must be a positive number of lines', text);
    }
    outputLines = rawLines;
  }

  let outputSince: number | undefined;
  if (rawSince !== undefined) {
    if (typeof rawSince !== 'number' || !Number.isFinite(rawSince) || rawSince < 0) {
      throw new PlanParseError('"outputSince" in a taskQuery must be the non-negative offset a previous answer reported', text);
    }
    outputSince = rawSince;
  }

  if (tasks.length === 0 && !catalog) {
    throw new PlanParseError('A taskQuery must name at least one task or set "catalog": true', text);
  }
  return { tasks, fields, catalog, outputLines, outputSince };
}

/** Stable identity of a query, so a turn can recognise the planner asking the same thing twice. */
export function taskQuerySignature(query: TaskQuery): string {
  return JSON.stringify([query.tasks, query.fields ?? null, query.catalog, query.outputLines ?? null, query.outputSince ?? null]);
}

// ---------------------------------------------------------------------------
// The answer — the block Ordewell injects in reply to a read.
// ---------------------------------------------------------------------------

/** What a full-catalog read is answered from. Models arrive already allowlist-filtered. */
export interface TaskQueryCatalog {
  runners: RunnerId[];
  models: Partial<Record<RunnerId, DiscoveredModel[]>>;
  modes: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault: boolean;
}

/**
 * Appended when the planner has spent its read budget, or asked the identical
 * question twice. The detail still comes back — refusing it would leave the
 * planner editing text it has not read, which is the whole failure this
 * channel exists to prevent — but the turn is told to land.
 */
export const TASK_QUERY_ANSWER_OR_OPS =
  'You have now read everything you asked for. Do not send another taskQuery this turn: ' +
  'answer the user in prose, or emit the taskOps JSON for the change you came to make.';

/** {@link TASK_QUERY_ANSWER_OR_OPS} for a planner that reads and edits through tools. */
export const TASK_READ_ANSWER_OR_EDIT =
  'You have now read everything you asked for. Do not read again this turn: ' +
  'answer the user in prose, or call edit_plan for the change you came to make.';

/**
 * The protocol as the planner is taught it, owned here beside the parser so the
 * two cannot drift. Both planner backends get these lines verbatim (ADR-0009):
 * a harness planner has no tool loop to reach, so the envelope is the channel.
 */
export const TASK_QUERY_PROTOCOL: string[] = [
  'READING A TASK BEFORE YOU EDIT IT:',
  'The plan block you are shown (whole once per live context, then what changed) carries only short fields — it never contains a task\'s prompt, its user steps, or a completed task\'s verdict. Never rewrite a field you have not read. To read one, reply with ONLY this JSON object:',
  `  {"${TASK_QUERY_ENVELOPE_KEY}":{"tasks":["<id or #order>", "..."],"fields":[${TASK_QUERY_FIELDS.map((f) => `"${f}"`).join(', ')}],"catalog":true}}`,
  '- "tasks": one or more task references. Ask for everything you need in ONE query — each query costs a round-trip.',
  '- "fields": optional. Omit it to get every field above.',
  '- "fields" may include "output": the recent clean output of a task that is running right now — the way to diagnose a task that looks stuck mid-execution. "outputLines" (default 80, at most 400) sets how many lines; "outputSince" resumes a previous read at the offset its answer reported. A task that is not running answers with a pointer to its outputSummary, handoff and verdict instead.',
  '- "catalog": optional. Set it to true for the full runner and model catalog — every model id with its label and thinking-effort variants, and whether each runner takes read-only tasks. It works before any task exists, and may be used on its own.',
  'Ordewell answers immediately with the detail and changes nothing. Then reply again with your taskOps JSON, or with prose for the user.',
  'Three queries per user message; after that every answer also tells you to land the turn. Do not ask the same question twice.',
];

/**
 * {@link TASK_QUERY_PROTOCOL} for a planner that has Ordewell's tools (ADR-0022):
 * the same reads, as calls, with the same budget.
 */
export const TASK_READ_TOOLS_PROTOCOL: string[] = [
  'READING A TASK BEFORE YOU EDIT IT:',
  'The plan block you are shown (whole once per live context, then what changed) carries only short fields — it never contains a task\'s prompt, its user steps, or a completed task\'s verdict. Never rewrite a field you have not read. Read with these tools; they change nothing:',
  '- task_query: "tasks" are one or more task references ("<id or #order>"). Ask for everything you need in ONE call. "fields" is optional (omit it to get description, prompt, userSteps, verdict, outputSummary, handoff, userStoriesCovered and skills). A handoff is what a task told the tasks after it: a summary, findings F1, F2, … and artifacts. "catalog": true also returns every runner with its models, thinking-effort variants and modes.',
  '- task_output: the recent output of a task that is running right now — the way to diagnose a task that looks stuck mid-execution. "lines" (default 80, at most 400) sets how many; pass an answer\'s "nextOffset" back as "since" to read only what follows. A task that is not running answers with its verdict, output summary, its whole handoff, its findings and report, and a digest of its last attempt. Supply "attempt" (a saved attempt number) or "kinds" (TaskLogEvent types such as tool_call, tool_result, error, text, approval_requested, approval_decided, usage) to read its structured log; attempt defaults to latest. Continue truncated entries with since/nextOffset.',
  '- task_diff: changes since a task started, with repo paths and file stats. Pass "path" for one file patch and "repo" to select a repository. Page with since/nextOffset. Shared runs without task-specific records report not available.',
  'Three reads per user message; after that every answer also tells you to land the turn, and after six they are refused. Do not ask the same question twice.',
  'Once a plan exists, change it with edit_plan — the last whole plan block shows you its operations; later turns only say what changed. Never reply with taskOps or taskQuery JSON.',
];

/** The one-line reminder the whole plan block carries, so the protocol has a single owner. */
export const TASK_QUERY_REMINDER =
  `- To READ a task in full (prompt, user steps, verdict, output, handoff, user stories) or the whole model/mode catalog before editing, reply with ONLY {"${TASK_QUERY_ENVELOPE_KEY}":{"tasks":["<id or #order>"],"catalog":true}} — it changes nothing, and you then reply again with your ops.`;

/** {@link TASK_QUERY_REMINDER} for a planner that has Ordewell's tools. */
export const TASK_READ_TOOLS_REMINDER =
  '- To READ a task in full (prompt, user steps, verdict, handoff, user stories), a running task\'s output, or the whole model/mode catalog before editing, call task_query, task_output or task_diff — they change nothing — and then call edit_plan with your ops.';

/**
 * Where an `output` read is answered from: the orchestrator's live capture of
 * the task's latest attempt. Injected so this module stays planner-side and
 * never imports the orchestrator.
 */
export type LiveOutputLookup = (taskId: string, opts: LiveTailOptions) => LiveTail | null;

interface OutputRenderContext {
  liveOutput?: LiveOutputLookup;
  outputLines: number;
  outputSince?: number;
  /** Chars committed to the answer so far, so a tail is clamped against what remains. */
  used: number;
}

/** Keep the newest of an over-long tail, dropping whole lines from the front. */
export function fitTail(text: string, budget: number): { text: string; trimmed: boolean } {
  if (text.length <= budget) return { text, trimmed: false };
  if (budget <= 0) return { text: '', trimmed: true };
  const lines = text.split('\n');
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + (kept.length > 0 ? 1 : 0);
    if (total + cost > budget) break;
    kept.unshift(lines[i]);
    total += cost;
  }
  if (kept.length === 0) return { text: text.slice(text.length - budget), trimmed: true };
  return { text: kept.join('\n'), trimmed: true };
}

// ---------------------------------------------------------------------------
// One read of a task, and the two channels that render it.
// ---------------------------------------------------------------------------

/** Where a task stands in a loop (ADR-0045), as a read states it. */
export type TaskLoopRead =
  /** A loop's check: the body it repeats with, its round, and whether it is between them. */
  | { body: string[]; maxRounds: number; round: number; betweenRounds: boolean }
  /** A task in a loop's body: the check it runs for, its title kept for the text channel. */
  | { check: string; checkTitle: string };

export interface TaskStepRead {
  order: number;
  instruction: string;
  completed: boolean;
}

export interface TaskCheckRead {
  name: string;
  result: 'pass' | 'fail' | 'skipped';
}

export interface TaskVerdictRead {
  outcome: Verdict['outcome'];
  reason: string;
  checks: TaskCheckRead[];
}

/** How an attempt ended, as a read states it: a task with a handoff carries its report there (ADR-0047). */
export interface TaskOutputSummaryRead {
  reviewReason: string;
  report?: string;
  logTail?: string;
}

/** A task's handoff: the digest a read shows, and where the findings past it and the report live. */
export type TaskHandoffRead = HandoffDigest & { rest: string };

/**
 * One task's read, from live plan state. Every rule that shapes what a read
 * says lives here — the loop position, and the handoff owning a report the
 * summary would otherwise repeat (ADR-0047) — so the envelope's text answer
 * and the JSON tool can only render the same data (ADR-0012 T1, ADR-0022).
 * `output` is not read here: it is a live capture each channel reads itself.
 */
export interface TaskRead {
  ref: string;
  id: string;
  title: string;
  status: Task['status'];
  type: Task['type'];
  /** Where the task stands in a loop; absent for a task in none. */
  loop?: TaskLoopRead;
  /** The fields asked for, in the order asked: what each channel renders. */
  fields: readonly TaskQueryField[];
  description?: string | null;
  /** A task's prompt, or null when it has none. */
  prompt?: string | null;
  /** A script task's body in place of a prompt (ADR-0035), or null when the plan's rules refuse it. */
  body?: ScriptBody | null;
  userSteps?: TaskStepRead[] | null;
  verdict?: TaskVerdictRead | null;
  outputSummary?: TaskOutputSummaryRead | null;
  handoff?: TaskHandoffRead | null;
  userStoriesCovered?: string[] | null;
  skills?: string[] | null;
}

/** One task's read, its rules applied once for both channels. */
export function readTask(plan: readonly Task[], task: Task, fields: readonly TaskQueryField[]): TaskRead {
  const wants = (field: TaskQueryField) => fields.includes(field);
  const loop = loopRead(plan, task);
  return {
    ref: taskRefOf(plan, task.id) ?? `#${task.order}`,
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    fields,
    ...(loop ? { loop } : {}),
    ...(wants('description') ? { description: task.description || null } : {}),
    ...(wants('prompt') ? (task.type === 'script' ? { body: scriptBodyOf(task) } : { prompt: task.prompt || task.goal || null }) : {}),
    ...(wants('userSteps') ? { userSteps: task.userSteps?.length ? task.userSteps.map((s) => ({ order: s.order, instruction: s.instruction, completed: s.completed === true })) : null } : {}),
    ...(wants('verdict') ? { verdict: verdictRead(task.verdict) } : {}),
    ...(wants('outputSummary') ? { outputSummary: outputSummaryRead(task) } : {}),
    ...(wants('handoff') ? { handoff: handoffRead(plan, task.handoff) } : {}),
    ...(wants('userStoriesCovered') ? { userStoriesCovered: task.userStoriesCovered?.length ? task.userStoriesCovered : null } : {}),
    ...(wants('skills') ? { skills: task.skills?.length ? task.skills : null } : {}),
  };
}

function loopRead(plan: readonly Task[], task: Task): TaskLoopRead | undefined {
  if (task.loop) {
    return {
      body: task.loop.body.map((id) => taskRefOf(plan, id) ?? id),
      maxRounds: task.loop.maxRounds,
      round: loopRoundOf(task),
      betweenRounds: betweenRounds(task),
    };
  }
  const check = checkOf(plan, task.id);
  return check ? { check: taskRefOf(plan, check.id) ?? check.id, checkTitle: check.title } : undefined;
}

/** A verdict as a read states it; null when the task has none. */
export function verdictRead(verdict: Verdict | undefined): TaskVerdictRead | null {
  if (!verdict) return null;
  return {
    outcome: verdict.outcome,
    reason: verdict.reason,
    checks: verdict.checks.map((c) => ({ name: c.name, result: c.skipped ? 'skipped' : c.passed ? 'pass' : 'fail' })),
  };
}

/** How an attempt ended, as a read states it; a task with a handoff carries its report there (ADR-0047). */
export function outputSummaryRead({ outputSummary, handoff }: Pick<Task, 'outputSummary' | 'handoff'>): TaskOutputSummaryRead | null {
  if (!outputSummary) return null;
  const { reviewReason, logTail } = outputSummary;
  const report = handoff ? undefined : outputSummary.report;
  return { reviewReason, ...(report ? { report } : {}), ...(logTail ? { logTail } : {}) };
}

/** A handoff's digest, its cited tasks named by the plan's references, and where the rest is. */
function handoffRead<H extends HandoffDigest>(plan: readonly Task[], handoff: H | undefined): (H & { rest: string }) | null {
  return handoff ? { ...namedHandoff(plan, handoff), rest: handoffRest(handoff) } : null;
}

/**
 * A task read as the JSON tool answers it (ADR-0022): a field asked for and
 * empty reads `null`, never absent, so a missing answer is never mistaken for
 * a field not asked for.
 */
export function taskReadDetail(read: TaskRead) {
  const wants = (field: TaskQueryField) => read.fields.includes(field);
  return {
    id: read.id,
    ref: read.ref,
    title: read.title,
    status: read.status,
    type: read.type,
    ...(read.loop ? { loop: loopDetail(read.loop) } : {}),
    ...(wants('description') ? { description: read.description ?? null } : {}),
    // A script task's body is what it runs, as a prompt is what a runner is told (ADR-0035).
    ...(wants('prompt') ? (read.type === 'script' ? { body: read.body ?? null } : { prompt: read.prompt ?? null }) : {}),
    ...(wants('userSteps') ? { userSteps: read.userSteps ?? null } : {}),
    ...(wants('verdict') ? { verdict: read.verdict ?? null } : {}),
    ...(wants('outputSummary') ? { outputSummary: read.outputSummary ?? null } : {}),
    ...(wants('handoff') ? { handoff: read.handoff ?? null } : {}),
    ...(wants('userStoriesCovered') ? { userStoriesCovered: read.userStoriesCovered ?? null } : {}),
    ...(wants('skills') ? { skills: read.skills ?? null } : {}),
  };
}

function loopDetail(loop: TaskLoopRead) {
  return 'check' in loop ? { check: loop.check } : loop;
}

function renderLiveOutput(taskId: string, ctx: OutputRenderContext): string[] {
  const tail = ctx.liveOutput?.(taskId, { maxLines: ctx.outputLines, sinceOffset: ctx.outputSince }) ?? null;
  if (!tail) return ['output: (no captured output — the task has not run in this session)'];
  if (!tail.running) return ['output: (not running — read "outputSummary", "handoff" and "verdict" for how it ended)'];
  if (!tail.text) return [`output: (running; nothing new past offset ${tail.nextOffset})`];
  const budget = Math.max(0, TASK_QUERY_ANSWER_MAX_CHARS - ctx.used - ANSWER_TAIL_RESERVE);
  const fitted = fitTail(tail.text, budget);
  const trimmed = fitted.trimmed ? 'earliest output trimmed to fit the answer budget; ' : '';
  return [
    `output: (running; ${trimmed}pass offset ${tail.nextOffset} back as "outputSince" to read only what follows)`,
    ...fitted.text.split('\n'),
  ];
}

function renderField(read: TaskRead, field: TaskQueryField, ctx: OutputRenderContext): string[] {
  switch (field) {
    case 'description':
      return [`description: ${read.description ?? '(none)'}`];
    case 'prompt':
      if (read.type === 'script') return scriptBodyLines(read.body ?? null);
      return read.prompt ? ['prompt:', read.prompt] : ['prompt: (none)'];
    case 'userSteps': {
      const steps = read.userSteps ?? [];
      if (steps.length === 0) return ['userSteps: (none)'];
      return ['userSteps:', ...steps.map((s) => `  ${s.order}. [${s.completed ? 'x' : ' '}] ${s.instruction}`)];
    }
    case 'verdict': {
      const v = read.verdict;
      if (!v) return ['verdict: (none)'];
      const checks = v.checks.map((c) => `${c.name}=${c.result}`).join(', ');
      return [`verdict: ${v.outcome.toUpperCase()} — ${v.reason}${checks ? ` [${checks}]` : ''}`];
    }
    case 'outputSummary': {
      const o = read.outputSummary;
      if (!o) return ['outputSummary: (none)'];
      return [`outputSummary: ${o.reviewReason}`, ...(o.report ? ['report:', o.report] : []), ...(o.logTail ? ['log tail:', o.logTail] : [])];
    }
    case 'handoff':
      return read.handoff
        ? ['handoff:', ...handoffLines(read.handoff), '(The whole handoff, report and all, is in the attempt\'s log.)']
        : ['handoff: (none)'];
    case 'userStoriesCovered': {
      const stories = read.userStoriesCovered ?? [];
      if (stories.length === 0) return ['userStoriesCovered: (none)'];
      return ['userStoriesCovered:', ...stories.map((s) => `  - ${s}`)];
    }
    case 'skills':
      return [`skills: ${read.skills?.length ? read.skills.join(', ') : '(none)'}`];
    case 'output':
      return renderLiveOutput(read.id, ctx);
  }
}

const TYPE_LABELS: Record<Task['type'], string> = { ai: 'AI', user: 'MAN', script: 'SCRIPT', delegated: 'DELEGATED' };

/** A script task's body in place of a prompt (ADR-0035): each command as typed, or the script, and its time limit. */
function scriptBodyLines(body: ScriptBody | null): string[] {
  if (!body) return ['body: (none)'];
  const limit = `timeoutMs: ${body.timeoutMs}`;
  return 'commands' in body ? ['commands:', ...body.commands.map((argv) => `  $ ${commandLine(argv)}`), limit] : ['script:', body.script, limit];
}

/** Where a task stands in a loop (ADR-0045), in the text channel's words. */
function loopLines(loop: TaskLoopRead | undefined): string[] {
  if (!loop) return [];
  if ('check' in loop) return [`loop: in the body of ${loop.check} "${loop.checkTitle}", so it runs only when that check fails`];
  const between = loop.betweenRounds
    ? `; failed round ${loop.round}, so its body is fixing what it found and it runs again after`
    : `; round ${loop.round}`;
  return [`loop: body ${loop.body.join(', ')}; at most ${loop.maxRounds} rounds${between}`];
}

function renderTask(read: TaskRead, ctx: OutputRenderContext): string[] {
  // The tail renders after the task's other fields and before the closing
  // blank, so its budget is computed against everything already committed —
  // including this task's own bounded fields.
  const lines = [
    `${read.ref} id=${read.id} "${read.title}" [${read.status}] type:${TYPE_LABELS[read.type]}`,
    ...loopLines(read.loop),
    ...read.fields.filter((f) => f !== 'output').flatMap((f) => renderField(read, f, ctx)),
    ...(read.fields.includes('output') ? renderLiveOutput(read.id, ctx) : []),
    '',
  ];
  ctx.used += lines.reduce((n, l) => n + l.length + 1, 0);
  return lines;
}

function renderCatalog(catalog: TaskQueryCatalog): string[] {
  const lines: string[] = [];
  for (const runner of catalog.runners) {
    const models = catalog.models[runner] ?? [];
    lines.push(`${runner} models:`);
    if (models.length === 0) lines.push('  (none discovered)');
    for (const m of models) {
      const variants = m.variants?.length
        ? ` variants: ${m.variants.map((v) => `${v.id}${v.label && v.label !== v.id ? ` (${v.label})` : ''}`).join(', ')}`
        : ' variants: none';
      lines.push(`  - ${m.modelId} — ${m.modelLabel}${variants}`);
    }
    lines.push(`${runner} takes read-only tasks: ${readOnlyMode(catalog.modes[runner]) ? 'yes' : 'no'}`);
  }
  return lines;
}

/**
 * Render the injected answer to one read. Never persisted — it is context for
 * the planner's next reply and nothing else — so it is built fresh from live
 * state on every query rather than cached. `liveOutput` backs the `output`
 * field; omitting it reads as "nothing captured".
 */
export function renderTaskQueryAnswer(
  query: TaskQuery,
  tasks: readonly Task[],
  catalog: TaskQueryCatalog,
  liveOutput?: LiveOutputLookup,
): string {
  const fields = query.fields ?? TASK_QUERY_FIELDS;
  const ctx: OutputRenderContext = {
    liveOutput,
    outputLines: Math.min(Math.max(1, Math.round(query.outputLines ?? OUTPUT_LINES_DEFAULT)), OUTPUT_LINES_MAX),
    outputSince: query.outputSince,
    used: 0,
  };
  const blocks: string[] = [];

  if (query.tasks.length > 0) {
    const { reads, unread } = readsInCap(
      query.tasks,
      tasks,
      // A miss is answered, not swallowed: silence reads to the planner as a
      // transport failure and it asks again, burning the same budget twice.
      (ref, task) => (task ? renderTask(readTask(tasks, task, fields), ctx) : [`${ref}: no task matches this reference in the current plan.`, '']),
      (lines) => lines.reduce((n, line) => n + line.length + 1, 0),
    );
    blocks.push(['<task_detail>', ...reads.flat(), ...(unread ? [unread] : []), '</task_detail>'].join('\n'));
  }

  if (query.catalog) {
    blocks.push(['<runner_catalog>', ...renderCatalog(catalog), '</runner_catalog>'].join('\n'));
  }

  blocks.push(
    'That is everything you asked for. Nothing has changed. Reply now with the taskOps JSON for the edit you intended, or answer the user in prose.',
  );
  return blocks.join('\n\n');
}
