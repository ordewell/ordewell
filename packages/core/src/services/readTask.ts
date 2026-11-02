import { flattenTasks, type Task } from '../models/Task';
import type { TaskLogEvent } from '../models/TaskLog';
import { handoffLines, nodeText, parseListingPage, parsePlanPath, readableTaskIds, removedAttempt, resolveWrittenRef, wordsFrom, type HandoffDigest, type HandoffLogs, type HandoffTaskName, type StoredHandoff } from '../models/Handoff';
import type { McpToolReply, ReadTaskArgs } from './mcp/tools';
import { listed } from './harness/ordewellBinding';
import { subtreeListing, type NodePlan, type Subtree } from './Subtree';
import { taskRefOf, titledTaskRefOf } from './TaskRefs';

/** The session's saved task logs, as `read` reads them (ADR-0018, P1). */
export interface TaskLogReader {
  /** The attempts of a task that have a saved log, oldest first. */
  attempts(taskId: string): number[];
  events(taskId: string, attempt: number): readonly TaskLogEvent[];
  /** The patch a read-only attempt saved beside its log (ADR-0050), or undefined when it kept none. */
  patch?(taskId: string, attempt: number): Buffer | undefined;
}

/** The attempt a read that names none reads: the latest, but a delegated task's report outlasts the attempt of a repair (ADR-0057 R2). */
export function handoffAttempt(task: Task | undefined, attempts: readonly number[]): number | undefined {
  const report = task?.type === 'delegated' ? task.handoff?.attempt : undefined;
  return report !== undefined && attempts.includes(report) ? report : attempts.at(-1);
}

/** The saved logs as a reference is pinned against (ADR-0057 R1). */
export function handoffLogs(log: Pick<TaskLogReader, 'attempts' | 'events'>): HandoffLogs {
  return {
    attempts: (taskId) => log.attempts(taskId),
    handoff: (taskId, attempt) => loggedHandoff(log.events(taskId, attempt)),
  };
}

/** Where a `read` lands: a plan, what the reader may read of it, and how that plan's tasks are named to it. */
interface ReadScope {
  plan: readonly Task[];
  log: TaskLogReader;
  readable: ReadonlySet<string>;
  /** The reader's plan names its own tasks; a plan below names them with its path. */
  path: string;
  subtree: Subtree | null;
}

/**
 * A `read` call (ADR-0047): the whole handoff of one attempt of a task, from
 * that attempt's log, with its report only when asked. A task reads only what
 * is in its readable set, so the plan's own graph scopes what one task learns
 * of another's work, and `readerId` absent is a planner, which reads its whole
 * plan. It reads a handoff and nothing else: no transcript, no tool calls, no
 * output. A pinned reference pasted as `task`, `#4@2/F3`, reads the attempt it
 * names (ADR-0057 R1), of a task since removed too, when a handoff the reader
 * may read cites it; one with no attempt reads the newest such attempt. One
 * with a path, `3/2:#4@2/F3`, reads a plan below, as a delegated task's report
 * shows it, within what `subtree` reaches.
 */
export function readTask(args: ReadTaskArgs, readerId: string | undefined, plan: readonly Task[], log: TaskLogReader, subtree: Subtree | null = null): McpToolReply {
  const text = String(args.task);
  const readable = readerId === undefined ? new Set(flattenTasks(plan).map((t) => t.id)) : readableTaskIds(plan, readerId);
  const across = subtree && !resolveWrittenRef(plan, text) ? parsePlanPath(text) : undefined;
  if (across) {
    const lower = subtree?.at(across.path);
    if (!lower) return { isError: true, text: `${JSON.stringify(text)} names no plan below this one that you may read.` };
    return readIn({ ...args, task: across.rest }, belowScope(lower, subtree));
  }
  return readIn(args, { plan, log, readable, path: '', subtree });
}

function belowScope({ node, tasks, logs }: NodePlan, subtree: Subtree | null): ReadScope {
  return { plan: tasks, log: logs, readable: new Set(flattenTasks(tasks).map((t) => t.id)), path: `${nodeText(node)}:`, subtree };
}

function readIn(args: ReadTaskArgs, scope: ReadScope): McpToolReply {
  const { plan, log, readable, path } = scope;
  const page = resolveWrittenRef(plan, String(args.task)) ? undefined : parseListingPage(String(args.task));
  const task = page?.rest ?? String(args.task);
  const written = resolveWrittenRef(plan, task);
  if (!written) return readRemoved({ ...args, task }, scope, page?.from) ?? { isError: true, text: `${JSON.stringify(String(args.task))} names no task in the plan: give its "#order", its id or its title.` };
  const target = written.task;
  const named = (id: string) => { const name = titledTaskRefOf(plan, id) ?? id; return `${path}${name}`; };
  const name = named(target.id);
  if (!readable.has(target.id)) {
    const allowed = flattenTasks(plan).filter((t) => readable.has(t.id)).map((t) => named(t.id));
    return { isError: true, text: `${name} is not a task this one may read. It may read itself, the tasks it depends on, directly or not, and its loop's other end: ${listed(allowed)}.` };
  }
  const attempts = log.attempts(target.id);
  const latest = attempts.at(-1);
  const asked = args.attempt ?? written.attempt;
  // A forked session has the plan's digests and none of the logs behind them, so a digest answers for the attempt it is from.
  const digested = asked !== undefined && target.handoff !== undefined && (target.handoff.attempt ?? latest) === asked;
  if (asked !== undefined && !attempts.includes(asked) && !digested) {
    return { isError: true, text: `${name} has no saved attempt ${asked}: ${attempts.length > 0 ? `its saved attempts are ${listed(attempts.map(String))}` : 'it has none'}.` };
  }
  const attempt = asked ?? handoffAttempt(target, attempts);
  const of = `attempt ${attempt} of ${attempts.length}`;
  const taskName = namesIn(scope);
  const logged = attempt === undefined ? undefined : loggedHandoff(log.events(target.id, attempt));
  const at = `${taskName(target.id)}@${attempt}`;
  if (page) return listingPage(logged, `${name}, ${of}`, at, page.from, scope);
  if (logged) return wholeHandoff(logged, `${name}, ${of}`, at, args, scope);
  // What the plan keeps is one attempt's, so it stands in for no other.
  if (attempt !== latest && !digested) return { text: `${name} has no handoff from ${of}: it ended without a task_complete call, or ran before handoffs.` };
  if (target.handoff && (asked === undefined || digested)) return { text: [`${name}: no saved log of this session holds its handoff, so this is what the plan keeps of it.`, '', wordsFrom('Handoff', name), ...digestLines(target.handoff, taskName)].join('\n') };
  return { text: noHandoff(target, name, attempt === undefined ? undefined : of) };
}

/** A read of a removed task, reached by citation ({@link removedAttempt}); a reader with none is told what any unknown reference is told. */
function readRemoved(args: ReadTaskArgs, scope: ReadScope, from?: number): McpToolReply | undefined {
  const { plan, log, readable, path } = scope;
  const pin = removedAttempt(plan, readable, handoffLogs(log), String(args.task), args.attempt);
  if (!pin) return undefined;
  const handoff = loggedHandoff(log.events(pin.taskId, pin.attempt));
  const name = `${path}${pin.taskId}, removed from the plan`;
  const of = `attempt ${pin.attempt} of ${log.attempts(pin.taskId).length}`;
  const at = `${path}${pin.taskId}@${pin.attempt}`;
  if (from !== undefined) return listingPage(handoff, `${name}, ${of}`, at, from, scope);
  if (!handoff) return { text: `${name}, has no handoff from ${of}: it ended without a task_complete call, or ran before handoffs.` };
  return wholeHandoff(handoff, `${name}, ${of}`, at, args, scope);
}

/** How a plan's tasks are named to its reader. */
function namesIn({ plan, path }: ReadScope): HandoffTaskName {
  return (id) => { const ref = taskRefOf(plan, id); return ref && `${path}${ref}`; };
}

/** A logged handoff as a read gives it, what a report left out after it. `at` is the attempt as this reader names it, which is how it asks for more. */
function wholeHandoff(handoff: StoredHandoff, of: string, at: string, args: ReadTaskArgs, scope: ReadScope): McpToolReply {
  const lines = storedLines(handoff, args.include_report === true, namesIn(scope));
  return { text: [wordsFrom('Handoff', of), '', ...lines, ...(handoff.subtree ? subtreeListing(handoff.subtree, scope.subtree, at, 1) : [])].join('\n') };
}

/** A page of what a report left out, and no more: the handoff has been read already (ADR-0057 R2). */
function listingPage(handoff: StoredHandoff | undefined, of: string, at: string, from: number, { subtree }: ReadScope): McpToolReply {
  if (!handoff?.subtree) return { isError: true, text: `${of}: no report of a subtree here to list.` };
  return { text: [wordsFrom('Handoff', of), ...subtreeListing(handoff.subtree, subtree, at, from)].join('\n') };
}

/** The handoff an attempt ended with: the last one its log holds. */
export function loggedHandoff(events: readonly TaskLogEvent[]): StoredHandoff | undefined {
  return events.filter((e): e is Extract<TaskLogEvent, { type: 'handoff' }> => e.type === 'handoff').at(-1)?.handoff;
}

/** A logged handoff whole, its report only when asked for and otherwise named, so the reader knows to ask. */
function storedLines(handoff: StoredHandoff, includeReport: boolean, taskName: HandoffTaskName): string[] {
  const { report, ...rest } = handoff;
  const lines = handoffLines(includeReport ? handoff : rest, taskName);
  if (!report || includeReport) return lines;
  return [...lines, '', `It also wrote a report of ${report.length} characters, left out here: call read again with include_report: true to read it.`];
}

/** The plan's digest, saying what it does not hold rather than pointing at a log there is not. */
function digestLines(digest: HandoffDigest, taskName: HandoffTaskName): string[] {
  const more = digest.findingCount - digest.findings.length;
  const lines = handoffLines({ ...digest, findingCount: digest.findings.length }, taskName);
  return more > 0 ? [...lines, '', `Its other ${more} finding${more === 1 ? '' : 's'}, and any report, were not kept in the plan.`] : lines;
}

/**
 * A task with no handoff to read: one still running, or saved before
 * handoffs, whose output summary's report is what it said it did. The end
 * of its output is not a handoff, so it is not read.
 */
function noHandoff(task: Task, name: string, attempt: string | undefined): string {
  const why = task.status === 'in_progress' ? 'it is still running'
    : attempt ? 'it ended without a task_complete call, or ran before handoffs'
    : 'no attempt of it has ended with one';
  const said = `${name} has no handoff ${attempt ? `from ${attempt}` : 'yet'}: ${why}.`;
  const { reviewReason, report } = task.outputSummary ?? {};
  if (!reviewReason && !report) return said;
  return [
    said,
    '',
    wordsFrom('Output summary, as the plan keeps it,', name),
    ...(reviewReason ? [`Review: ${reviewReason}`] : []),
    ...(report ? ['Report:', report] : []),
  ].join('\n');
}
