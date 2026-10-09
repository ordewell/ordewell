import type { ApprovalDecision } from '../interfaces/IApproval';
import type { StructuredEvent, StructuredTurnEnd } from '../interfaces/ITerminalRunner';
import type { SubagentOutcome, TaskSkillSnapshot } from './Task';
import type { UsageRecord } from './Usage';

/**
 * One entry of a structured task's log (ADR-0018, P1): what a runner did,
 * normalized and serializable, streamed live as `task_log` and appended to
 * the attempt's `.jsonl` file. The live view and the reload fold the same
 * events through `reduceTaskLog`, so the two cannot disagree.
 *
 * Readers skip a type they do not know, which is how later events join
 * without a format version.
 */
export type TaskLogEvent =
  /** The task skills this attempt's prompt carried, as read at its spawn (ADR-0024): first in its log. */
  | { type: 'task_skills'; skills: TaskSkillSnapshot[] }
  /** A turn began by delivering `message`; `messageId` names it when it had been queued, `forced` when it was force sent. */
  | { type: 'turn_start'; message: string; messageId?: string; forced?: boolean }
  | { type: 'turn_end'; reason: StructuredTurnEnd }
  | { type: 'text_delta'; text: string }
  /** A complete run of the agent's reply, authoritative over the deltas streamed for it. */
  | { type: 'text'; text: string }
  | { type: 'thinking_delta'; text: string; subagentId?: string }
  | { type: 'thinking'; text: string; subagentId?: string }
  /** `args` is the call's arguments as JSON, exactly as the runner announced them. */
  | { type: 'tool_call'; id: string; name: string; args: string; subagentId?: string }
  /** `omittedLines` is set when {@link trimToolOutput} cut the middle of `output`. */
  | { type: 'tool_result'; id: string; output: string; success: boolean; omittedLines?: number; subagentId?: string }
  | { type: 'subagent_started'; subagentId: string; brief: string; model?: string }
  | { type: 'subagent_finished'; subagentId: string; outcome: SubagentOutcome; digest: string }
  | { type: 'usage'; record: UsageRecord }
  /**
   * Waiting in Ordewell's queue — again, for a message the runner was handed
   * and let go of (ADR-0023, D4). `forced` moves it ahead of the rest (F2).
   */
  | { type: 'message_queued'; messageId: string; text: string; forced?: boolean }
  | { type: 'message_removed'; messageId: string }
  | { type: 'message_undelivered'; messageId: string; text: string }
  /** The runner accepted a queued message into its running turn; it can no longer be taken back. */
  | { type: 'message_handed_over'; messageId: string }
  /**
   * The model read a message inside its running turn (ADR-0023, Q2), logged
   * where it read it. A message that opened a turn is that turn's `turn_start`.
   */
  | { type: 'message_delivered'; messageId: string; text: string }
  /** The agent's own words for a failed turn. */
  | { type: 'error'; message: string }
  /**
   * The runner asked to use a tool its mode does not cover (ADR-0018, A1).
   * `approvalId` is what the answer is given under; `args` is the call's
   * arguments as JSON; `allowForTask` says the runner offered its own
   * session-scoped grant.
   */
  | { type: 'approval_requested'; approvalId: string; tool: string; args: string; allowForTask: boolean; toolCallId?: string }
  | { type: 'approval_decided'; approvalId: string; decision: ApprovalDecision['decision']; note?: string }
  /** The request went unanswered: the runner withdrew it, or its process ended. */
  | { type: 'approval_withdrawn'; approvalId: string };

const HEAD_LINES = 60;
const TAIL_LINES = 40;
const MAX_LINE_CHARS = 2000;
const DIGEST_ARGS_CHARS = 120;
const DIGEST_MESSAGE_CHARS = 1000;

function capLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/**
 * Keep a tool result's head and tail. A build log or a whole file read can
 * run to megabytes, and every attempt's file keeps it for good; the ends are
 * where a reader looks — the command's start, and how it finished.
 */
export function trimToolOutput(output: string): { output: string; omittedLines?: number } {
  const lines = output.split('\n');
  const long = lines.some((l) => l.length > MAX_LINE_CHARS);
  if (lines.length <= HEAD_LINES + TAIL_LINES) return long ? { output: lines.map(capLine).join('\n') } : { output };
  const omittedLines = lines.length - HEAD_LINES - TAIL_LINES;
  const kept = [
    ...lines.slice(0, HEAD_LINES),
    `… ${omittedLines} line${omittedLines === 1 ? '' : 's'} omitted …`,
    ...lines.slice(-TAIL_LINES),
  ];
  return { output: kept.map(capLine).join('\n'), omittedLines };
}

function withSubagent<E extends TaskLogEvent>(event: E, subagentId: string | undefined): E {
  return subagentId ? { ...event, subagentId } : event;
}

/**
 * The log entry for one structured event, or null for what the log does not
 * keep: background-agent launches, which the subagent's own events already show.
 */
export function toTaskLogEvent(event: StructuredEvent): TaskLogEvent | null {
  switch (event.type) {
    case 'turn_start':
      return {
        type: 'turn_start', message: event.text, ...(event.messageId ? { messageId: event.messageId } : {}), ...(event.forced ? { forced: true } : {}),
      };
    case 'turn_end':
      return { type: 'turn_end', reason: event.reason };
    case 'assistant_text_delta':
      return { type: 'text_delta', text: event.text };
    case 'assistant_text':
      return { type: 'text', text: event.text };
    case 'thinking_delta':
    case 'thinking':
      return withSubagent({ type: event.type, text: event.text }, event.subagentId);
    case 'tool_call':
      return withSubagent({ type: 'tool_call', id: event.id, name: event.name, args: JSON.stringify(event.args) }, event.subagentId);
    case 'tool_result': {
      const { output, omittedLines } = trimToolOutput(event.output);
      return withSubagent({ type: 'tool_result', id: event.id, output, success: event.success, ...(omittedLines ? { omittedLines } : {}) }, event.subagentId);
    }
    case 'subagent_started':
      return { type: 'subagent_started', subagentId: event.subagentId, brief: event.brief, ...(event.model ? { model: event.model } : {}) };
    case 'subagent_finished':
      return { type: 'subagent_finished', subagentId: event.subagentId, outcome: event.outcome, digest: event.digest };
    case 'usage':
      return { type: 'usage', record: event.record };
    case 'message_queued':
      return { type: 'message_queued', messageId: event.messageId, text: event.text, ...(event.forced ? { forced: true } : {}) };
    case 'message_undelivered':
      return { type: 'message_undelivered', messageId: event.messageId, text: event.text };
    case 'message_removed':
      return { type: 'message_removed', messageId: event.messageId };
    case 'message_handed_over':
      return { type: 'message_handed_over', messageId: event.messageId };
    case 'message_delivered':
      return { type: 'message_delivered', messageId: event.messageId, text: event.text };
    case 'error':
      return { type: 'error', message: event.message };
    case 'permission_request':
      return {
        type: 'approval_requested',
        approvalId: event.id,
        tool: event.name,
        args: event.detail,
        allowForTask: (event.suggestions?.length ?? 0) > 0,
        ...(event.toolUseId ? { toolCallId: event.toolUseId } : {}),
      };
    case 'permission_decided': {
      const note = event.decision.decision === 'deny' ? event.decision.note : undefined;
      return { type: 'approval_decided', approvalId: event.id, decision: event.decision.decision, ...(note ? { note } : {}) };
    }
    case 'permission_withdrawn':
      return { type: 'approval_withdrawn', approvalId: event.id };
    case 'background_agent':
      return null;
  }
}

/**
 * Merge runs of deltas into one event each. Deltas arrive a few characters at
 * a time; merged, a batch is one message on the wire and one line on disk,
 * and the view folds to the same blocks either way.
 */
export function coalesceTaskLog(events: readonly TaskLogEvent[]): TaskLogEvent[] {
  const out: TaskLogEvent[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (last?.type === 'text_delta' && event.type === 'text_delta') {
      out[out.length - 1] = { ...last, text: last.text + event.text };
    } else if (last?.type === 'thinking_delta' && event.type === 'thinking_delta' && last.subagentId === event.subagentId) {
      out[out.length - 1] = { ...last, text: last.text + event.text };
    } else {
      out.push(event);
    }
  }
  return out;
}

/**
 * What an attempt did to the world, for the retry of a task whose effects
 * outlive it (ADR-0020): one line per tool call and how it ended.
 */
export function digestTaskLog(events: readonly TaskLogEvent[], maxCalls: number): string {
  const outcomes = new Map<string, boolean>();
  let lastText: string | undefined;
  let lastError: string | undefined;
  for (const event of events) {
    if (event.type === 'tool_result') outcomes.set(event.id, event.success);
    else if (event.type === 'text') lastText = event.text;
    else if (event.type === 'error') lastError = event.message;
  }
  const lines: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool_call') continue;
    const outcome = outcomes.get(event.id);
    const args = event.args.length > DIGEST_ARGS_CHARS ? `${event.args.slice(0, DIGEST_ARGS_CHARS)}…` : event.args;
    lines.push(`- ${event.name} ${args} → ${outcome === undefined ? 'no result' : outcome ? 'ok' : 'failed'}`);
  }
  const omitted = lines.length - maxCalls;
  const out = omitted > 0 ? [`… ${omitted} earlier call${omitted === 1 ? '' : 's'} omitted …`, ...lines.slice(omitted)] : lines;
  const gap = (): string[] => (out.length > 0 ? [''] : []);
  const said = lastText?.trim();
  if (said) {
    const end = said.length > DIGEST_MESSAGE_CHARS ? `…${said.slice(-DIGEST_MESSAGE_CHARS)}` : said;
    out.push(...gap(), 'Its last message:', ...end.split('\n').map((l) => `  ${l}`));
  }
  if (lastError) out.push(...gap(), `It stopped with an error: ${lastError}`);
  return out.join('\n');
}
