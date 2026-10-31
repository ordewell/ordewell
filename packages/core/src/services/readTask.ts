import { flattenTasks, type Task } from '../models/Task';
import type { TaskLogEvent } from '../models/TaskLog';
import { handoffLines, readableTaskIds, removedPin, resolveWrittenRef, wordsFrom, type HandoffDigest, type HandoffLogs, type HandoffTaskName, type StoredHandoff } from '../models/Handoff';
import type { McpToolReply, ReadTaskArgs } from './mcp/tools';
import { listed } from './harness/ordewellBinding';
import { taskRefOf, titledTaskRefOf } from './TaskRefs';

/** The session's saved task logs, as `read_task` reads them (ADR-0018, P1). */
export interface TaskLogReader {
  /** The attempts of a task that have a saved log, oldest first. */
  attempts(taskId: string): number[];
  events(taskId: string, attempt: number): readonly TaskLogEvent[];
  /** The patch a read-only attempt saved beside its log (ADR-0050), or undefined when it kept none. */
  patch?(taskId: string, attempt: number): Buffer | undefined;
}

/** The saved logs as a reference is pinned against (ADR-0057 R1). */
export function handoffLogs(log: Pick<TaskLogReader, 'attempts' | 'events'>): HandoffLogs {
  return {
    attempts: (taskId) => log.attempts(taskId),
    handoff: (taskId, attempt) => loggedHandoff(log.events(taskId, attempt)),
  };
}

/**
 * A task's `read_task` call (ADR-0047): the whole handoff of one attempt of a
 * task in `plan`, from that attempt's log, with its report only when asked.
 * Only a task in the reader's readable set is read, so the plan's own graph
 * scopes what one task learns of another's work. It reads a handoff and
 * nothing else: no transcript, no tool calls, no output. A pinned reference
 * pasted as `task`, `#4@2/F3`, reads the attempt it names (ADR-0057 R1), of a
 * task since removed too, when a handoff the reader may read cites it.
 */
export function readTask(args: ReadTaskArgs, readerId: string, plan: readonly Task[], log: TaskLogReader): McpToolReply {
  const written = resolveWrittenRef(plan, String(args.task));
  if (!written) return readRemoved(args, readerId, plan, log) ?? { isError: true, text: `${JSON.stringify(String(args.task))} names no task in the plan: give its "#order", its id or its title.` };
  const target = written.task;
  const named = (id: string) => titledTaskRefOf(plan, id) ?? id;
  const name = named(target.id);
  const readable = readableTaskIds(plan, readerId);
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
  const attempt = asked ?? latest;
  const of = `attempt ${attempt} of ${attempts.length}`;
  const taskName: HandoffTaskName = (id) => taskRefOf(plan, id);
  const logged = attempt === undefined ? undefined : loggedHandoff(log.events(target.id, attempt));
  if (logged) return { text: [wordsFrom('Handoff', `${name}, ${of}`), '', ...storedLines(logged, args.include_report === true, taskName)].join('\n') };
  // What the plan keeps is one attempt's, so it stands in for no other.
  if (attempt !== latest && !digested) return { text: `${name} has no handoff from ${of}: it ended without a task_complete call, or ran before handoffs.` };
  if (target.handoff && (asked === undefined || digested)) return { text: [`${name}: no saved log of this session holds its handoff, so this is what the plan keeps of it.`, '', wordsFrom('Handoff', name), ...digestLines(target.handoff, taskName)].join('\n') };
  return { text: noHandoff(target, name, attempt === undefined ? undefined : of) };
}

/**
 * A pinned read of a removed task. The graph no longer reaches it, so a citation
 * does: a task cannot read work it was never given (ADR-0047), and one that
 * cites nothing is told what any unknown reference is told.
 */
function readRemoved(args: ReadTaskArgs, readerId: string, plan: readonly Task[], log: TaskLogReader): McpToolReply | undefined {
  const pin = removedPin(String(args.task), args.attempt);
  if (!pin || !log.attempts(pin.taskId).includes(pin.attempt)) return undefined;
  const readable = readableTaskIds(plan, readerId);
  const cited = flattenTasks(plan).some((t) => readable.has(t.id) && handoffsOf(t, log).some((h) => cites(h, pin.taskId, pin.attempt)));
  if (!cited) return undefined;
  const handoff = loggedHandoff(log.events(pin.taskId, pin.attempt));
  const name = `${pin.taskId}, removed from the plan`;
  const of = `attempt ${pin.attempt} of ${log.attempts(pin.taskId).length}`;
  if (!handoff) return { text: `${name}, has no handoff from ${of}: it ended without a task_complete call, or ran before handoffs.` };
  return { text: [wordsFrom('Handoff', `${name}, ${of}`), '', ...storedLines(handoff, args.include_report === true, (id) => taskRefOf(plan, id))].join('\n') };
}

/** Every handoff a task has left: the plan's digest and each attempt's log. */
function handoffsOf(task: Task, log: TaskLogReader): HandoffDigest[] {
  const logged = log.attempts(task.id).map((attempt) => loggedHandoff(log.events(task.id, attempt)));
  return [task.handoff, ...logged].filter((h): h is HandoffDigest => h !== undefined);
}

function cites(handoff: HandoffDigest, taskId: string, attempt: number): boolean {
  return [...handoff.findings.flatMap((f) => f.evidence ?? []), ...(handoff.artifacts ?? [])].some((ref) => ref.kind === 'task' && ref.task === taskId && ref.attempt === attempt);
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
  return [...lines, '', `It also wrote a report of ${report.length} characters, left out here: call read_task again with include_report: true to read it.`];
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
