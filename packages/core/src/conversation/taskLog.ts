import type { QueuedTaskMessage, StructuredTurnEnd } from '../interfaces/ITerminalRunner';
import type { TaskLogEvent } from '../models/TaskLog';
import { addPlannerUsage, isMeasured, usageLine, type PlannerUsage } from '../models/Usage';
import { mapAgentTool, normalizeAgentArgs } from '../services/harness/agentTools';
import type { ApprovalBlock, MessageBlock, SubagentChild, SubagentStatus, ThinkingDisplayBlock } from './blocks';
import { toolHeadline } from './format';
import {
  append, appendOutput, replaceAt, closeOpenBlocks, findLastIndex, laneAppend, laneBlocks, laneOf, laneReplace, setUsageLine, updateSubagent, sealed,
  type BlockList, type Lane,
} from './lanes';
import { finishedTool, pendingTool, settledMessage } from './records';

/**
 * What a surface draws for one attempt of a structured task (ADR-0018, O1b):
 * the same display blocks as the planner conversation, built from the task's
 * {@link TaskLogEvent}s. No planner turn ids — a task's turns are its own,
 * one at a time.
 */
export interface TaskLogView extends BlockList {
  /** Messages not yet delivered, oldest first; `handedOver` marks the ones the runner already has. */
  readonly queued: readonly QueuedTaskMessage[];
  /** A turn is running. */
  readonly working: boolean;
  /** How the last turn ended; absent before the first one does. */
  readonly lastTurnEnd?: StructuredTurnEnd;
  /** What the runner reported over the attempt, subagents included. */
  readonly usage?: PlannerUsage;
  /**
   * The block each run of deltas streams into, keyed by stream, so the run's
   * authoritative copy replaces it instead of repeating it below.
   */
  readonly streams: Readonly<Record<string, string>>;
}

export const EMPTY_TASK_LOG: TaskLogView = { blocks: [], nextId: 1, queued: [], working: false, streams: {} };

type Event<T extends TaskLogEvent['type']> = Extract<TaskLogEvent, { type: T }>;

const TEXT_STREAM = 'text';
const thinkingStream = (subagentId: string | undefined) => `thinking:${subagentId ?? ''}`;

function withoutStream(view: TaskLogView, key: string): TaskLogView {
  if (!(key in view.streams)) return view;
  return { ...view, streams: Object.fromEntries(Object.entries(view.streams).filter(([k]) => k !== key)) };
}

// A later text block of the same turn opens with a paragraph break (the
// adapter joins a turn's messages that way); as a block of its own it needs none.
function blockText(text: string): string {
  return text.replace(/^\n+/, '');
}

type Streamed = MessageBlock | ThinkingDisplayBlock;

/** The lane's streaming block for `key`, while it is still the lane's latest output and still streaming. */
function openStream(view: TaskLogView, lane: Lane, key: string): number {
  const id = view.streams[key];
  if (id === undefined) return -1;
  const blocks = laneBlocks(view, lane);
  const i = findLastIndex(blocks, (b) => b.type !== 'usage');
  const block = blocks[i];
  return block?.id === id && (block.type === 'message' || block.type === 'thinking') && block.streaming ? i : -1;
}

function streamDelta(view: TaskLogView, lane: Lane, key: string, text: string, make: (id: string, text: string) => Streamed): TaskLogView {
  const i = openStream(view, lane, key);
  const open = laneBlocks(view, lane)[i];
  if (open?.type === 'message' || open?.type === 'thinking') return laneReplace(view, lane, i, { ...open, text: open.text + text });
  const next = appendOutput(view, lane, (id) => make(id, blockText(text)));
  return { ...next, streams: { ...next.streams, [key]: `b${view.nextId}` } };
}

/**
 * A run's authoritative copy: it replaces the text its deltas built, wherever
 * that block now sits in the lane, and is added whole when nothing streamed.
 */
function streamWhole(view: TaskLogView, lane: Lane, key: string, text: string, make: (id: string) => SubagentChild): TaskLogView {
  const id = view.streams[key];
  const blocks = laneBlocks(view, lane);
  const i = id === undefined ? -1 : findLastIndex(blocks, (b) => b.id === id);
  const streamed = blocks[i];
  const next = withoutStream(view, key);
  if (streamed?.type === 'message' || streamed?.type === 'thinking') {
    return laneReplace(next, lane, i, { ...streamed, text: blockText(text), streaming: false });
  }
  return appendOutput(next, lane, make);
}

function agentText(view: TaskLogView, text: string): TaskLogView {
  return streamWhole(view, null, TEXT_STREAM, text, (id) => settledMessage(id, 'agent', blockText(text)));
}

function agentTextDelta(view: TaskLogView, text: string): TaskLogView {
  return streamDelta(view, null, TEXT_STREAM, text, (id, t) => ({ type: 'message', id, role: 'agent', text: t, streaming: true }));
}

function thinkingBlock(id: string, text: string, streaming: boolean, subagentId: string | undefined): ThinkingDisplayBlock {
  return { type: 'thinking', id, text, streaming, ...(subagentId ? { subagentId } : {}) };
}

function thinkingDelta(view: TaskLogView, { text, subagentId }: Event<'thinking_delta'>): TaskLogView {
  const [placed, lane] = laneOf(view, subagentId);
  return streamDelta(placed, lane, thinkingStream(subagentId), text, (id, t) => thinkingBlock(id, t, true, subagentId));
}

function thinkingWhole(view: TaskLogView, { text, subagentId }: Event<'thinking'>): TaskLogView {
  const [placed, lane] = laneOf(view, subagentId);
  return streamWhole(placed, lane, thinkingStream(subagentId), text, (id) => thinkingBlock(id, blockText(text), false, subagentId));
}

function announceTool(view: TaskLogView, { id: toolCallId, name, args, subagentId }: Event<'tool_call'>): TaskLogView {
  const { tool, toolLabel } = mapAgentTool(name);
  const [placed, lane] = laneOf(view, subagentId);
  return appendOutput(placed, lane, (id) => {
    const call = pendingTool(id, { tool, toolLabel, args, toolCallId });
    const parsed = parseArgs(args);
    // Headline from the normalized arguments, as the harness planner's rows
    // are, so a `Read` or a Codex argv reads the same in both views.
    return parsed ? { ...call, headline: toolHeadline(tool, JSON.stringify(normalizeAgentArgs(tool, parsed)), toolLabel) } : call;
  });
}

function parseArgs(args: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function settleTool(view: TaskLogView, { id: toolCallId, output, success, subagentId }: Event<'tool_result'>): TaskLogView {
  const [placed, lane] = laneOf(view, subagentId);
  const blocks = laneBlocks(placed, lane);
  const i = findLastIndex(blocks, (b) => b.type === 'tool' && b.status === 'pending' && b.toolCallId === toolCallId);
  const pending = blocks[i];
  const outcome = success ? 'success' : 'failure';
  if (pending?.type === 'tool') return laneReplace(placed, lane, i, finishedTool(pending, output, outcome));
  // The call that spawned a subagent is shown by the subagent's block, and
  // only the subagent's own finish settles it: a backgrounded agent's call
  // returns at launch, long before the work ends.
  if (lane === null && blocks.some((b) => b.type === 'subagent' && b.toolCallId === toolCallId)) return view;
  return laneAppend(placed, lane, (id) => finishedTool(pendingTool(id, { tool: 'agent_tool', toolLabel: 'Tool', args: '', toolCallId }), output, outcome));
}

function startSubagent(view: TaskLogView, { subagentId, brief, model }: Event<'subagent_started'>): TaskLogView {
  return updateSubagent(view, subagentId, undefined, (block) => ({ ...block, ...(brief ? { brief } : {}), ...(model ? { model } : {}) }));
}

function finishSubagent(view: TaskLogView, { subagentId, outcome, digest }: Event<'subagent_finished'>): TaskLogView {
  const usage = view.usage?.bySubagent?.[subagentId];
  const next = updateSubagent(view, subagentId, undefined, (block) => ({
    ...block, status: outcome, digest, children: block.children.map(sealed), ...(usage ? { usage } : {}),
  }));
  return withoutStream(next, thinkingStream(subagentId));
}

function reportUsage(view: TaskLogView, { record }: Event<'usage'>): TaskLogView {
  const usage = addPlannerUsage(view.usage ?? { totals: {} }, record);
  const next = { ...view, usage };
  return isMeasured(usage.totals) ? setUsageLine(next, usageLine(usage)) : next;
}

/** A runner's tool request, read the way its call's row reads: `Bash(npm test)`. */
export function runnerToolSubject(tool: string, args: string): string {
  const { tool: mapped, toolLabel } = mapAgentTool(tool);
  const parsed = parseArgs(args);
  const headline = toolHeadline(mapped, parsed ? JSON.stringify(normalizeAgentArgs(mapped, parsed)) : args, toolLabel);
  return headline.keyArg ? `${headline.name}(${headline.keyArg})` : headline.name;
}

function requestApproval(view: TaskLogView, { approvalId, tool, args, allowForTask, toolCallId }: Event<'approval_requested'>): TaskLogView {
  if (view.blocks.some((b) => b.type === 'approval' && b.approvalId === approvalId)) return view;
  return append(view, (id) => ({
    type: 'approval', id, approvalId, kind: 'runner_tool',
    subject: runnerToolSubject(tool, args),
    scope: tool,
    status: 'pending',
    ...(allowForTask ? { allowForTask } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  }));
}

function settleApproval(view: TaskLogView, approvalId: string, settle: (block: ApprovalBlock) => ApprovalBlock): TaskLogView {
  const i = findLastIndex(view.blocks, (b) => b.type === 'approval' && b.approvalId === approvalId);
  const block = view.blocks[i];
  if (block?.type !== 'approval' || block.status !== 'pending') return view;
  return { ...view, blocks: replaceAt(view.blocks, i, settle(block)) };
}

function decideApproval(view: TaskLogView, { approvalId, decision, note }: Event<'approval_decided'>): TaskLogView {
  return settleApproval(view, approvalId, (block) => ({
    ...block,
    status: decision === 'deny' ? 'denied' : 'granted',
    decidedBy: 'asked',
    ...(decision === 'allowForTask' ? { forTask: true } : {}),
    ...(note ? { note } : {}),
  }));
}

function startTurn(view: TaskLogView, { message, messageId }: Event<'turn_start'>): TaskLogView {
  const queued = messageId ? view.queued.filter((m) => m.id !== messageId) : view.queued;
  const working = { ...view, queued, working: true };
  // A turn the runner opened itself has no user message to show.
  return message ? append(working, (id) => settledMessage(id, 'user', message)) : working;
}

const CUT: Record<StructuredTurnEnd, SubagentStatus | null> = { completed: null, interrupted: 'stopped', failed: 'failed' };

function endTurn(view: TaskLogView, { reason }: Event<'turn_end'>): TaskLogView {
  const closed = closeOpenBlocks({ ...view, working: false, lastTurnEnd: reason, streams: {} }, CUT[reason]);
  return reason === 'interrupted' ? append(closed, (id) => settledMessage(id, 'system', 'Interrupted.')) : closed;
}

function queueMessage(view: TaskLogView, { messageId, text, forced }: Event<'message_queued'>): TaskLogView {
  const listed = view.queued.find((m) => m.id === messageId);
  if (forced) {
    // The session's own order (ADR-0023, F2): behind earlier forced messages, ahead of the rest.
    const rest = view.queued.filter((m) => m !== listed);
    const at = rest.findIndex((m) => !m.forced);
    const placed = at < 0 ? rest.length : at;
    return { ...view, queued: [...rest.slice(0, placed), { id: messageId, text, forced: true }, ...rest.slice(placed)] };
  }
  if (!listed) return { ...view, queued: [...view.queued, { id: messageId, text }] };
  if (!listed.handedOver) return view;
  return { ...view, queued: view.queued.map((m) => (m === listed ? { id: m.id, text: m.text } : m)) };
}

function handOver(view: TaskLogView, { messageId }: Event<'message_handed_over'>): TaskLogView {
  const listed = view.queued.find((m) => m.id === messageId);
  if (!listed || listed.handedOver) return view;
  return { ...view, queued: view.queued.map((m) => (m === listed ? { ...m, handedOver: true } : m)) };
}

/** The message joins the transcript where the runner read it, between the steps around it. */
function deliverMidTurn(view: TaskLogView, event: Event<'message_delivered'>): TaskLogView {
  return appendOutput(unqueueMessage(view, event), null, (id) => settledMessage(id, 'user', event.text));
}

function unqueueMessage(view: TaskLogView, { messageId }: { messageId: string }): TaskLogView {
  const queued = view.queued.filter((m) => m.id !== messageId);
  return queued.length === view.queued.length ? view : { ...view, queued };
}

/**
 * Fold one task-log event into the view. Pure and incremental, like
 * `reduceConversation`: an event that changes nothing returns `view` itself,
 * and an event of a type this build does not know is skipped — a log written
 * by a newer Ordewell still reads.
 */
export function reduceTaskLog(view: TaskLogView, event: TaskLogEvent): TaskLogView {
  switch (event.type) {
    case 'task_skills': return append(view, (id) => settledMessage(id, 'system', `Skills: ${event.skills.map((s) => `${s.name} (${s.path})`).join(', ')}`));
    case 'turn_start': return startTurn(view, event);
    case 'turn_end': return endTurn(view, event);
    case 'text_delta': return agentTextDelta(view, event.text);
    case 'text': return agentText(view, event.text);
    case 'thinking_delta': return thinkingDelta(view, event);
    case 'thinking': return thinkingWhole(view, event);
    case 'tool_call': return announceTool(view, event);
    case 'tool_result': return settleTool(view, event);
    case 'subagent_started': return startSubagent(view, event);
    case 'subagent_finished': return finishSubagent(view, event);
    case 'usage': return reportUsage(view, event);
    case 'message_queued': return queueMessage(view, event);
    case 'message_removed': return unqueueMessage(view, event);
    case 'message_handed_over': return handOver(view, event);
    case 'message_delivered': return deliverMidTurn(view, event);
    case 'message_undelivered': return append(unqueueMessage(view, event), (id) => settledMessage(id, 'system', `${event.text} · not delivered`));
    case 'error': return appendOutput(view, null, (id) => settledMessage(id, 'error', event.message));
    case 'approval_requested': return requestApproval(view, event);
    case 'approval_decided': return decideApproval(view, event);
    case 'approval_withdrawn': return settleApproval(view, event.approvalId, (block) => ({ ...block, status: 'withdrawn' }));
    default: return view;
  }
}

/** A whole attempt's events, folded from the start — what a reload shows. */
export function replayTaskLog(events: readonly TaskLogEvent[], from: TaskLogView = EMPTY_TASK_LOG): TaskLogView {
  return events.reduce(reduceTaskLog, from);
}
