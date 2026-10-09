import type { ResearchStep } from '../models/Task';
import type { SessionMessage } from '../services/SessionMessage';
import { isMeasured } from '../models/Usage';
import type { DisplayBlock, MessageBlock, PlanBlock, ToolBlock } from './blocks';
import { pendingTool, planMarker, settledMessage, settledTool, skillLoadBlock, toolFromStep, userMessage } from './records';
import {
  append, appendOutput, closeOpenBlocks, findLastIndex, laneBlocks, laneOf, laneAppend, laneReplace, replaceAt, sealLane, sealed, setUsageLine,
  think, updateSubagent, type BlockList,
} from './lanes';

/**
 * A line a surface adds to the conversation itself rather than receiving from
 * the session: the user's prompt as it is sent, a notice, an error.
 */
export interface LocalEntry {
  type: 'local_entry';
  role: 'user' | 'system' | 'error';
  text: string;
}

export type ConversationInput = SessionMessage | LocalEntry;

export interface ConversationView extends BlockList {
  /**
   * The newest transcript entry the view accounts for. Plan markers and system
   * notes reach a surface only inside the transcript a `plan_generated`
   * carries, so entries after this one are what is new in it.
   */
  readonly transcriptAt?: string;
}

export const EMPTY_CONVERSATION: ConversationView = { blocks: [], nextId: 1 };

type Message<T extends SessionMessage['type']> = Extract<SessionMessage, { type: T }>;

function isUnsettledSegment(block: DisplayBlock, turnId: string): block is MessageBlock {
  return block.type === 'message' && block.turnId === turnId && block.segmentId !== undefined;
}

function isBuildingPlan(block: DisplayBlock, turnId: string | undefined): block is PlanBlock {
  return block.type === 'plan' && block.status === 'building' && block.turnId === turnId;
}

/**
 * Where the turn's final segment is, if its text streamed: the turn's latest
 * block, when that is streamed text. Anything the turn did after a segment —
 * a tool call, a plan envelope — means a later segment follows it, and a later
 * segment never rewrites an earlier one. `pastPlan` looks past the turn's plan
 * block, for a plan that settled after its own text.
 */
function finalSegmentIndex(blocks: readonly DisplayBlock[], turnId: string, pastPlan = false): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === 'usage' || block.type === 'thinking' || block.type === 'approval' || (pastPlan && block.type === 'plan')) continue;
    if (block.turnId !== turnId) continue;
    return isUnsettledSegment(block, turnId) ? i : -1;
  }
  return -1;
}

function openTurn(view: ConversationView, { turnId, prompt = '', skills = [] }: Message<'planner_turn_started'>): ConversationView {
  // A surface shows its user's prompt the moment it is sent; the turn that
  // answers it adopts that line rather than repeating it.
  const i = findLastIndex(view.blocks, (b) => b.type === 'message' && b.role === 'user');
  const sent = view.blocks[i];
  const adopted = sent?.type === 'message' && sent.turnId === undefined && sent.text === prompt;
  const said: ConversationView = adopted
    ? { ...view, blocks: replaceAt(view.blocks, i, userMessage(sent.id, prompt, skills, turnId)) }
    : append(view, (id) => userMessage(id, prompt, skills, turnId));
  if (skills.length === 0) return said;
  // Directly under the message that loaded them, wherever that line sits.
  const at = adopted ? i + 1 : findLastIndex(said.blocks, (b) => b.type === 'message' && b.role === 'user') + 1;
  const loads = skills.map((skill, n) => skillLoadBlock(`b${said.nextId + n}`, skill, turnId));
  return { ...said, blocks: [...said.blocks.slice(0, at), ...loads, ...said.blocks.slice(at)], nextId: said.nextId + loads.length };
}

function streamText(view: ConversationView, { turnId, segmentId, text }: Message<'planner_text_delta'>): ConversationView {
  const i = findLastIndex(view.blocks, (b) => isUnsettledSegment(b, turnId) && b.segmentId === segmentId);
  const segment = view.blocks[i];
  if (segment?.type === 'message') {
    return sealLane(laneReplace(view, null, i, { ...segment, text: segment.text + text, streaming: true }), null, i);
  }
  return appendOutput(view, null, (id) => ({ type: 'message', id, role: 'planner', text, streaming: true, turnId, segmentId }));
}

/**
 * Drop the turn's plan display while it is still building: whatever streamed
 * there did not become a plan — a task-ops or task-query envelope, or, from a
 * daemon older than turns, the reply's prose.
 */
function dropBuildingPlan(view: ConversationView, turnId: string | undefined, segmentId?: string): ConversationView {
  const blocks = view.blocks.filter((b) => !(isBuildingPlan(b, turnId) && (segmentId === undefined || b.segmentId === segmentId)));
  return blocks.length === view.blocks.length ? view : { ...view, blocks };
}

function settleReply(view: ConversationView, { content, turnId }: Message<'planner_message'>): ConversationView {
  if (turnId !== undefined) {
    const i = finalSegmentIndex(view.blocks, turnId);
    if (i >= 0) {
      return dropBuildingPlan({ ...view, blocks: replaceAt(view.blocks, i, settledMessage(view.blocks[i].id, 'planner', content, turnId)) }, turnId);
    }
  }
  return append(dropBuildingPlan(view, turnId), (id) => settledMessage(id, 'planner', content, turnId));
}

// A retracted envelope takes the turn's plan display with it, or its retry
// would build on the botched JSON and the partial-plan rows read both.
function retractText(view: ConversationView, { turnId, segmentId }: Message<'planner_text_retracted'>): ConversationView {
  const blocks = view.blocks.filter((b) => !(isUnsettledSegment(b, turnId) && (segmentId === undefined || b.segmentId === segmentId)));
  return dropBuildingPlan(blocks.length === view.blocks.length ? view : { ...view, blocks }, turnId, segmentId);
}

function startSubagent(view: ConversationView, { subagentId, brief, model, turnId }: Message<'subagent_started'>): ConversationView {
  return updateSubagent(view, subagentId, turnId, (block) => ({ ...block, ...(brief ? { brief } : {}), ...(model ? { model } : {}) }));
}

function finishSubagent(view: ConversationView, { subagentId, outcome, digest, usage, turnId }: Message<'subagent_finished'>): ConversationView {
  return updateSubagent(view, subagentId, turnId, (block) => ({
    ...block, status: outcome, digest, children: block.children.map(sealed), ...(usage ? { usage } : {}),
  }));
}

function announceTool(view: ConversationView, call: Message<'research_step'>): ConversationView {
  // A spawn call names the subagent it starts; any other call tagged with a
  // subagent is that subagent's own.
  const spawns = call.tool === 'spawn_research_agent' ? call.subagentId : undefined;
  const [placed, lane] = laneOf(view, spawns ? undefined : call.subagentId, call.turnId);
  return appendOutput(placed, lane, (id) => ({ ...pendingTool(id, call), ...(spawns ? { spawns } : {}) }));
}

// By the call's id: results of a parallel round return in any order, and a
// name match would put one call's output on another's row (ADR-0008). The
// name scan survives only for calls that announced no id.
function isPendingCallOf(block: DisplayBlock, step: ResearchStep): block is ToolBlock {
  if (block.type !== 'tool' || block.status !== 'pending') return false;
  return step.toolCallId ? block.toolCallId === step.toolCallId : block.toolCallId === undefined && block.tool === step.tool;
}

function settleTool(view: ConversationView, { step, turnId }: Message<'research_step_done'>): ConversationView {
  const [placed, lane] = laneOf(view, step.subagentId, turnId);
  const blocks = laneBlocks(placed, lane);
  const i = findLastIndex(blocks, (b) => isPendingCallOf(b, step));
  const pending = blocks[i];
  if (pending?.type === 'tool') return laneReplace(placed, lane, i, settledTool(pending, step));
  // The call that spawned a subagent is shown by the subagent's block, and
  // only the subagent's own finish settles it: a backgrounded agent's call
  // returns at launch, long before the work ends.
  if (lane === null && step.toolCallId && blocks.some((b) => b.type === 'subagent' && b.toolCallId === step.toolCallId)) return view;
  return laneAppend(placed, lane, (id) => toolFromStep(id, step, turnId));
}

/**
 * The building display shows one envelope: the segment streaming now. A turn's
 * later envelope (a plan after a read it asked for) starts it over, below
 * whatever the turn did in between, rather than running on from the last one.
 */
function streamPlan(view: ConversationView, { token, turnId, segmentId }: Message<'plan_token'>): ConversationView {
  const i = findLastIndex(view.blocks, (b) => isBuildingPlan(b, turnId));
  const building = view.blocks[i];
  if (building?.type === 'plan' && building.segmentId === segmentId) {
    return { ...view, blocks: replaceAt(view.blocks, i, { ...building, text: building.text + token }) };
  }
  return append(dropBuildingPlan(view, turnId), (id) => ({
    type: 'plan', id, status: 'building', text: token, ...(turnId ? { turnId } : {}), ...(segmentId ? { segmentId } : {}),
  }));
}

/** A plan landed: the building display of the turn that committed it becomes its marker. */
function markPlan(view: ConversationView, content: string, turnId: string | undefined): ConversationView {
  const marker = planMarker(content);
  const i = findLastIndex(view.blocks, (b) => isBuildingPlan(b, turnId));
  const building = view.blocks[i];
  if (building?.type === 'plan') {
    const settled: PlanBlock = { type: 'plan', id: building.id, ...marker, text: '', ...(building.turnId ? { turnId: building.turnId } : {}) };
    return { ...view, blocks: replaceAt(view.blocks, i, settled) };
  }
  return append(view, (id) => ({ type: 'plan', id, text: '', ...marker }));
}

function requestApproval(view: ConversationView, { id: approvalId, kind, subject, scope, detail, turnId }: Message<'approval_request'>): ConversationView {
  return append(view, (id) => ({
    type: 'approval', id, approvalId, kind, subject, scope, status: 'pending',
    ...(detail ? { detail } : {}),
    ...(turnId ? { turnId } : {}),
  }));
}

function settleApproval(view: ConversationView, { id, granted }: Message<'approval_settled'>): ConversationView {
  const i = findLastIndex(view.blocks, (b) => b.type === 'approval' && b.approvalId === id);
  const request = view.blocks[i];
  if (request?.type !== 'approval') return view;
  return { ...view, blocks: replaceAt(view.blocks, i, { ...request, status: granted ? 'granted' : 'denied', decidedBy: 'asked' }) };
}

function decideApproval(view: ConversationView, { kind, subject, scope, detail, granted, source }: Message<'approval_decided'>): ConversationView {
  return append(view, (id) => ({
    type: 'approval', id, kind, subject, scope, status: granted ? 'granted' : 'denied', decidedBy: source,
    ...(detail ? { detail } : {}),
  }));
}

function reportUsage(view: ConversationView, message: Message<'planner_usage'>): ConversationView {
  return isMeasured(message.totals) ? setUsageLine(view, message) : view;
}

/**
 * Nothing carries the turn's id after this, so whatever it left open is closed:
 * streaming stops, and on a stop or failure its unanswered calls and running
 * subagents say they were cut short. A plan reply that streamed as text (a
 * prose preamble decides a segment's route) gives way to its plan block, as a
 * settled message would have replaced it.
 */
function endTurn(view: ConversationView, { turnId, outcome }: Message<'planner_turn_ended'>): ConversationView {
  let next = dropBuildingPlan(view, turnId);
  const planText = outcome === 'plan' ? finalSegmentIndex(next.blocks, turnId, true) : -1;
  if (planText >= 0) next = { ...next, blocks: next.blocks.filter((_, i) => i !== planText) };
  return closeOpenBlocks(next, outcome === 'stopped' ? 'stopped' : outcome === 'error' ? 'failed' : null);
}

// The summary is announced as a planner message before the transcript it now
// heads arrives; the transcript records it as a notice, and so does the view.
function markCompaction(view: ConversationView, summary: string): ConversationView {
  const i = findLastIndex(view.blocks, (b) => b.type === 'message' && b.role === 'planner' && b.turnId === undefined && b.text === summary);
  const announced = view.blocks[i];
  if (announced?.type === 'message') return { ...view, blocks: replaceAt(view.blocks, i, { ...announced, role: 'system' }) };
  return append(view, (id) => settledMessage(id, 'system', summary));
}

function syncTranscript(view: ConversationView, { plan, turnId }: Message<'plan_generated'>): ConversationView {
  const history = plan.conversationHistory ?? [];
  // Only the newest marker can be the committing turn's; older ones a surface
  // is only now catching up on belong to turns long over.
  const committed = findLastIndex(history, (e) => e.kind === 'plan_generated');
  let next = view;
  let latest = view.transcriptAt;
  for (const [i, entry] of history.entries()) {
    const isNew = view.transcriptAt === undefined || entry.timestamp > view.transcriptAt;
    if (isNew && entry.kind === 'plan_generated') next = markPlan(next, entry.content, i === committed ? turnId : undefined);
    if (isNew && entry.kind === 'system') next = append(next, (id) => settledMessage(id, 'system', entry.content));
    if (isNew && entry.kind === 'compaction') next = markCompaction(next, entry.content);
    if (latest === undefined || entry.timestamp > latest) latest = entry.timestamp;
  }
  return next === view && latest === view.transcriptAt ? view : { ...next, transcriptAt: latest };
}

/**
 * Fold one input into the view. Pure and incremental: blocks the input does
 * not touch keep their identity, and an input that changes nothing returns
 * `view` itself — surfaces memoize their drawing on that, and text deltas
 * arrive quickly.
 */
export function reduceConversation(view: ConversationView, input: ConversationInput): ConversationView {
  switch (input.type) {
    case 'local_entry':
      return append(view, (id) => settledMessage(id, input.role, input.text));
    case 'planner_turn_started':
      return input.prompt === undefined ? view : openTurn(view, input);
    case 'planner_skill_loaded':
      return append(sealLane(view, null, -1), (id) => skillLoadBlock(id, input.skill, input.turnId));
    case 'planner_text_delta':
      return streamText(view, input);
    case 'planner_message':
      return settleReply(view, input);
    case 'planner_text_retracted':
      return retractText(view, input);
    case 'planner_thinking_delta':
      return think(view, input.text, input.turnId, input.segmentId, input.subagentId);
    case 'research_step':
      return announceTool(view, input);
    case 'research_step_done':
      return settleTool(view, input);
    case 'subagent_started':
      return startSubagent(view, input);
    case 'subagent_finished':
      return finishSubagent(view, input);
    case 'plan_token':
      return streamPlan(view, input);
    case 'plan_generated':
      return syncTranscript(view, input);
    case 'planner_turn_ended':
      return endTurn(view, input);
    case 'approval_request':
      return requestApproval(view, input);
    case 'approval_settled':
      return settleApproval(view, input);
    case 'approval_decided':
      return decideApproval(view, input);
    case 'planner_usage':
      return reportUsage(view, input);
    default:
      return view;
  }
}
