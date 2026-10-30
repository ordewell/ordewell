import type { QueuedTaskMessage, StructuredTurnEnd, TaskMessageFrom } from '../interfaces/IRunner';
import type { ApprovalDecision } from '../interfaces/IApproval';
import { scriptExitText, type TaskLogEvent } from '../models/TaskLog';
import type { StoredHandoff } from '../models/Handoff';
import { commandLine } from '../models/ScriptTask';
import { addPlannerUsage, isMeasured, usageLine, type PlannerUsage } from '../models/Usage';
import { sameMessage } from '../utils/sameMessage';
import { mapAgentTool, normalizeAgentArgs } from '../services/harness/agentTools';
import type { ApprovalBlock, CommandStatus, DisplayBlock, MessageBlock, SubagentChild, SubagentStatus, ThinkingDisplayBlock } from './blocks';
import { outputLines, toolHeadline } from './format';
import {
  append, appendOutput, replaceAt, closeOpenBlocks, findLastIndex, laneAppend, laneBlocks, laneOf, laneReplace, setUsageLine, updateSubagent, sealed, sealLane,
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
  /** When the open turn began (ISO), for a surface to count from; absent between turns and for a log saved before it was kept (#81). */
  readonly turnStartedAt?: string;
  /** How the last turn ended; absent before the first one does. */
  readonly lastTurnEnd?: StructuredTurnEnd;
  /** What the runner reported over the attempt, subagents included. */
  readonly usage?: PlannerUsage;
  /**
   * The block each stream of deltas writes into — a run of text by its id,
   * thinking by whose it is — so the stream's authoritative copy replaces it
   * instead of repeating it below.
   */
  readonly streams: Readonly<Record<string, string>>;
  /** The turn's latest agent text block, which a failure that repeats it takes the place of. */
  readonly latestText?: string;
}

export const EMPTY_TASK_LOG: TaskLogView = { blocks: [], nextId: 1, queued: [], working: false, streams: {} };

type Event<T extends TaskLogEvent['type']> = Extract<TaskLogEvent, { type: T }>;

/** A log saved before runs of text carried an id streams every run through one key. */
const textStream = (runId: string | undefined) => (runId === undefined ? 'text' : `text:${runId}`);
const thinkingStream = (subagentId: string | undefined) => `thinking:${subagentId ?? ''}`;

function withoutStream(view: TaskLogView, key: string): TaskLogView {
  if (!(key in view.streams)) return view;
  return { ...view, streams: Object.fromEntries(Object.entries(view.streams).filter(([k]) => k !== key)) };
}

// A later run of a turn in a log saved before runs carried an id opens with
// the paragraph break that joined it; as a block of its own it needs none.
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

/** The lane's block for `key`, wherever it now sits. */
function streamBlock(view: TaskLogView, lane: Lane, key: string): number {
  const id = view.streams[key];
  return id === undefined ? -1 : findLastIndex(laneBlocks(view, lane), (b) => b.id === id);
}

/**
 * One delta of `key`, into its block: the one it has wherever that sits when
 * `anywhere`, else only while that is still the lane's latest output.
 * Otherwise it opens a block of its own.
 */
function streamDelta(view: TaskLogView, lane: Lane, key: string, text: string, make: (id: string, text: string) => Streamed, anywhere = false): TaskLogView {
  const i = anywhere ? streamBlock(view, lane, key) : openStream(view, lane, key);
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
  const i = streamBlock(view, lane, key);
  const streamed = laneBlocks(view, lane)[i];
  const next = withoutStream(view, key);
  if (streamed?.type === 'message' || streamed?.type === 'thinking') {
    return laneReplace(next, lane, i, { ...streamed, text: blockText(text), streaming: false });
  }
  return appendOutput(next, lane, make);
}

/** The turn's latest text block is the one a run opened last; a run settling elsewhere leaves it be. */
function openedText(view: TaskLogView, next: TaskLogView): TaskLogView {
  return next.nextId > view.nextId ? { ...next, latestText: `b${view.nextId}` } : next;
}

function agentText(view: TaskLogView, { runId, text }: Event<'text'>): TaskLogView {
  return openedText(view, streamWhole(view, null, textStream(runId), text, (id) => settledMessage(id, 'agent', blockText(text))));
}

/**
 * A run with an id streams into its own block wherever that now sits, so a
 * note or another run landing in the middle of it splits nothing. A log saved
 * without ids has one stream for every run, which streams into the latest
 * output only.
 */
function agentTextDelta(view: TaskLogView, { runId, text }: Event<'text_delta'>): TaskLogView {
  const make = (id: string, t: string): Streamed => ({ type: 'message', id, role: 'agent', text: t, streaming: true });
  return openedText(view, streamDelta(view, null, textStream(runId), text, make, runId !== undefined));
}

/**
 * Claude Code says a usage limit twice — as an assistant message and as the
 * `result` of the failed turn. The log keeps both; the view shows the failure
 * alone when the turn's latest agent text only repeats it. Text before that
 * block is a real reply, and text that merely mentions the failure is not a
 * repeat.
 */
function failTurn(view: TaskLogView, message: string): TaskLogView {
  const repeated = view.blocks.find((b) => b.id === view.latestText);
  const settled = repeated?.type === 'message' && repeated.role === 'agent' && sameMessage(repeated.text, message)
    ? {
      ...view,
      blocks: view.blocks.filter((b) => b !== repeated),
      streams: Object.fromEntries(Object.entries(view.streams).filter(([, id]) => id !== repeated.id)),
    }
    : view;
  return appendOutput({ ...settled, latestText: undefined }, null, (id) => settledMessage(id, 'error', message));
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

function requestApproval(view: TaskLogView, { approvalId, tool, args, allowForTask, toolCallId, decided }: Event<'approval_requested'>): TaskLogView {
  if (view.blocks.some((b) => b.type === 'approval' && b.approvalId === approvalId)) return view;
  return append(view, (id) => {
    const block: ApprovalBlock = {
      type: 'approval', id, approvalId, kind: 'runner_tool',
      subject: runnerToolSubject(tool, args),
      scope: tool,
      status: 'pending',
      ...(allowForTask ? { allowForTask } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    };
    // Already answered at the source (an Ordewell tool, an auto-approving
    // mode): shown settled rather than as something still waiting on a person.
    return decided ? answered(block, decided) : block;
  });
}

function settleApproval(view: TaskLogView, approvalId: string, settle: (block: ApprovalBlock) => ApprovalBlock): TaskLogView {
  const i = findLastIndex(view.blocks, (b) => b.type === 'approval' && b.approvalId === approvalId);
  const block = view.blocks[i];
  if (block?.type !== 'approval' || block.status !== 'pending') return view;
  return { ...view, blocks: replaceAt(view.blocks, i, settle(block)) };
}

function answered(block: ApprovalBlock, decision: ApprovalDecision['decision'], note?: string): ApprovalBlock {
  return {
    ...block,
    status: decision === 'deny' ? 'denied' : 'granted',
    decidedBy: 'asked',
    ...(decision === 'allowForTask' ? { forTask: true } : {}),
    ...(note ? { note } : {}),
  };
}

function decideApproval(view: TaskLogView, { approvalId, decision, note }: Event<'approval_decided'>): TaskLogView {
  return settleApproval(view, approvalId, (block) => answered(block, decision, note));
}

function startTurn(view: TaskLogView, { message, messageId, from, forced, startedAt }: Event<'turn_start'>): TaskLogView {
  const queued = messageId ? view.queued.filter((m) => m.id !== messageId) : view.queued;
  const working = { ...view, queued, working: true, turnStartedAt: startedAt, latestText: undefined };
  // A turn the runner opened itself has no user message to show.
  return message ? append(working, (id) => ({ ...sentMessage(id, message, from), ...(forced ? { forced: true } : {}) })) : working;
}

/** A message to the runner, drawn as the user's unless Ordewell sent it (ADR-0018, W1). */
function sentMessage(id: string, text: string, from: TaskMessageFrom | undefined): MessageBlock {
  return from === 'ordewell' ? settledMessage(id, 'system', `Ordewell: ${text}`) : settledMessage(id, 'user', text);
}

/** A runner command opens its turn as a message would, shown as the command it runs (#66). */
function startCommand(view: TaskLogView, { name, args, messageId, startedAt }: Event<'command'>): TaskLogView {
  const queued = messageId ? view.queued.filter((m) => m.id !== messageId) : view.queued;
  return append({ ...view, queued, working: true, turnStartedAt: startedAt, latestText: undefined }, (id) => ({
    type: 'command', id, name, ...(args ? { args } : {}), status: 'running', output: '',
  }));
}

function runningCommand(view: TaskLogView): number {
  return findLastIndex(view.blocks, (b) => b.type === 'command' && b.status === 'running');
}

function commandOutput(view: TaskLogView, { text }: Event<'command_output'>): TaskLogView {
  const i = runningCommand(view);
  const block = view.blocks[i];
  if (block?.type !== 'command') return append(view, (id) => settledMessage(id, 'system', text));
  return { ...view, blocks: replaceAt(view.blocks, i, { ...block, output: block.output ? `${block.output}\n${text}` : text }) };
}

function modelSwitchNotice({ from, to, plan, kept }: Event<'model_switched'>): string {
  if (!plan) return `Model changed in the runner: ${from.label ?? from.model} → ${to.label ?? to.model}${kept ? ` (${kept})` : ''}`;
  const planned = plan.model ? `${plan.model.label ?? plan.model.model}${plan.effort ? `, ${plan.effort}` : ''}` : undefined;
  if (!kept) return `Model changed in the runner: ${from.label ?? from.model} → ${to.label ?? to.model}; the plan now says ${planned ?? to.label ?? to.model}`;
  return `The runner now answers on ${to.label ?? to.model}; ${planned ? `the plan still says ${planned}` : 'the plan names no model'} (${kept})`;
}

/** Among the turn's steps, as a tool call is: what streamed before it is settled. */
function appendStep(view: TaskLogView, make: (id: string) => DisplayBlock): TaskLogView {
  const next = append(view, make);
  return sealLane(next, null, findLastIndex(next.blocks, (b) => b.type !== 'usage'));
}

const CUT: Record<StructuredTurnEnd, SubagentStatus | null> = { completed: null, interrupted: 'stopped', failed: 'failed' };
const COMMAND_END: Record<StructuredTurnEnd, CommandStatus> = { completed: 'done', interrupted: 'stopped', failed: 'failed' };

function endTurn(view: TaskLogView, { reason }: Event<'turn_end'>): TaskLogView {
  const i = runningCommand(view);
  const command = view.blocks[i];
  const settled = command?.type === 'command' ? { ...view, blocks: replaceAt(view.blocks, i, { ...command, status: COMMAND_END[reason] }) } : view;
  const closed = closeOpenBlocks({ ...settled, working: false, turnStartedAt: undefined, lastTurnEnd: reason, streams: {}, latestText: undefined }, CUT[reason]);
  return reason === 'interrupted' ? append(closed, (id) => settledMessage(id, 'system', 'Interrupted.')) : closed;
}

function queueMessage(view: TaskLogView, { messageId, text, forced, from }: Event<'message_queued'>): TaskLogView {
  const listed = view.queued.find((m) => m.id === messageId);
  const sender = from ? { from } : {};
  if (forced) {
    // The session's own order (ADR-0023, F2): behind earlier forced messages, ahead of the rest.
    // Forcing one the runner already has moves it without taking it back.
    const rest = view.queued.filter((m) => m !== listed);
    const at = rest.findIndex((m) => !m.forced);
    const placed = at < 0 ? rest.length : at;
    const handedOver = listed?.handedOver ? { handedOver: true } : {};
    return { ...view, queued: [...rest.slice(0, placed), { id: messageId, text, forced: true, ...handedOver, ...sender }, ...rest.slice(placed)] };
  }
  if (!listed) return { ...view, queued: [...view.queued, { id: messageId, text, ...sender }] };
  if (!listed.handedOver) return view;
  return { ...view, queued: view.queued.map((m) => (m === listed ? { id: m.id, text: m.text, ...(m.forced ? { forced: true } : {}), ...sender } : m)) };
}

function handOver(view: TaskLogView, { messageId }: Event<'message_handed_over'>): TaskLogView {
  const listed = view.queued.find((m) => m.id === messageId);
  if (!listed || listed.handedOver) return view;
  return { ...view, queued: view.queued.map((m) => (m === listed ? { ...m, handedOver: true } : m)) };
}

/** The message joins the transcript where the runner read it, between the steps around it. */
function deliverMidTurn(view: TaskLogView, event: Event<'message_delivered'>): TaskLogView {
  return appendOutput(unqueueMessage(view, event), null, (id) => sentMessage(id, event.text, event.from));
}

function unqueueMessage(view: TaskLogView, { messageId }: { messageId: string }): TaskLogView {
  const queued = view.queued.filter((m) => m.id !== messageId);
  return queued.length === view.queued.length ? view : { ...view, queued };
}

/**
 * A script task's step reads as the command it is (ADR-0035): a row that its
 * output fills as it runs, and that its exit status settles.
 */
function runScriptStep(view: TaskLogView, event: Event<'script_run'>): TaskLogView {
  const [command, toolLabel] = 'argv' in event ? [commandLine(event.argv), 'Run'] : [event.script, 'Script'];
  return appendOutput({ ...view, working: true }, null, (id) => pendingTool(id, { tool: 'bash', toolLabel, args: JSON.stringify({ command }) }));
}

function runningScriptStep(view: TaskLogView): number {
  return findLastIndex(view.blocks, (b) => b.type === 'tool' && b.status === 'pending' && b.tool === 'bash');
}

function scriptStepOutput(view: TaskLogView, { text, omittedChars }: Event<'script_output'>): TaskLogView {
  const said = omittedChars ? `… ${omittedChars} characters omitted …\n${text}` : text;
  const i = runningScriptStep(view);
  const block = view.blocks[i];
  if (block?.type !== 'tool') return append(view, (id) => settledMessage(id, 'system', said));
  const output = block.output + said;
  return { ...view, blocks: replaceAt(view.blocks, i, { ...block, output, outputLineCount: outputLines(output).length }) };
}

function endScriptStep(view: TaskLogView, event: Event<'script_exit'>): TaskLogView {
  const status = scriptExitText(event);
  const passed = event.code === 0 && !event.signal && event.error === undefined;
  const i = runningScriptStep(view);
  const block = view.blocks[i];
  const ended = { ...view, working: false, turnStartedAt: undefined };
  if (block?.type !== 'tool') return append(ended, (id) => settledMessage(id, 'system', status));
  const output = block.output.trim() ? `${block.output.replace(/\n+$/, '')}\n${status}` : status;
  return { ...ended, blocks: replaceAt(view.blocks, i, finishedTool(block, output, passed ? 'success' : 'failure')) };
}

/** The log holds one handoff; a live copy of the one a reload already folded is the same handoff. */
function sameHandoff(a: StoredHandoff, b: StoredHandoff): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The attempt's handoff at its end (ADR-0047), before the usage line. Written
 * once, but a reload and the live stream can deliver it twice; the second copy
 * leaves the view alone, and a newer one replaces the block rather than adding
 * a second.
 */
function showHandoff(view: TaskLogView, { handoff }: Event<'handoff'>): TaskLogView {
  const i = findLastIndex(view.blocks, (b) => b.type === 'handoff');
  const block = view.blocks[i];
  if (block?.type !== 'handoff') return appendStep(view, (id) => ({ type: 'handoff', id, handoff }));
  if (sameHandoff(block.handoff, handoff)) return view;
  return { ...view, blocks: replaceAt(view.blocks, i, { ...block, handoff }) };
}

function endCall<B extends SubagentChild>(block: B): B {
  return block.type === 'tool' && block.status === 'pending' ? finishedTool(block, '', 'not_executed') as B : block;
}

/** Whatever the runner left without a result ended with it. */
function endOpenCalls(view: TaskLogView): TaskLogView {
  let changed = false;
  const blocks = view.blocks.map((block) => {
    const ended = block.type === 'subagent'
      ? (block.children.some((c) => c.type === 'tool' && c.status === 'pending') ? { ...block, children: block.children.map(endCall) } : block)
      : block.type === 'tool' ? endCall(block)
      : block.type === 'command' && block.status === 'running' ? { ...block, status: 'stopped' as const } : block;
    if (ended !== block) changed = true;
    return ended;
  });
  return changed ? { ...view, blocks } : view;
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
    case 'command': return startCommand(view, event);
    case 'command_output': return commandOutput(view, event);
    case 'model_switched': return append(view, (id) => settledMessage(id, 'system', modelSwitchNotice(event)));
    case 'compaction': return appendStep(view, (id) => ({
      type: 'compaction', id, trigger: event.trigger,
      ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}), ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
    }));
    case 'runner_loaded': return append(view, (id) => ({ type: 'runner_loaded', id, commands: event.commands, mcpServers: event.mcpServers }));
    case 'turn_end': return endTurn(view, event);
    case 'text_delta': return agentTextDelta(view, event);
    case 'text': return agentText(view, event);
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
    case 'error': return failTurn(view, event.message);
    case 'approval_requested': return requestApproval(view, event);
    case 'approval_decided': return decideApproval(view, event);
    case 'approval_withdrawn': return settleApproval(view, event.approvalId, (block) => ({ ...block, status: 'withdrawn' }));
    case 'script_run': return runScriptStep(view, event);
    case 'script_output': return scriptStepOutput(view, event);
    case 'script_exit': return endScriptStep(view, event);
    case 'handoff': return showHandoff(view, event);
    case 'runner_ended': return closeOpenBlocks({ ...endOpenCalls(view), working: false, turnStartedAt: undefined, streams: {}, latestText: undefined }, 'stopped');
    default: return view;
  }
}

/** A whole attempt's events, folded from the start — what a reload shows. */
export function replayTaskLog(events: readonly TaskLogEvent[], from: TaskLogView = EMPTY_TASK_LOG): TaskLogView {
  return events.reduce(reduceTaskLog, from);
}
