import type { ReplyRun, ResearchStep } from '../models/Task';
import type { RunnerSignIn } from '../services/signInHint';
import type { SerializedConversationMessage, SerializedPendingTurn, SessionMessage } from '../services/SessionMessage';
import { isMeasured } from '../models/Usage';
import { isCheckpoint } from '../services/conversationSummary';
import type { CompactionBlock, DisplayBlock, MessageBlock, MessageRole, PlanBlock, ToolBlock } from './blocks';
import { compactionBlock, pendingTool, planMarker, settledMessage, settledTool, signedOutFailure, skillLoadBlock, toolFromStep, userMessage } from './records';
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
  /** Reloaded arrivals, keyed by pending turn id until the live turn or transcript accounts for them. */
  readonly pendingInputs?: readonly { input: SerializedPendingTurn; blockIds: readonly string[] }[];
}

export const EMPTY_CONVERSATION: ConversationView = { blocks: [], nextId: 1 };

type Message<T extends SessionMessage['type']> = Extract<SessionMessage, { type: T }>;

function isUnsettledSegment(block: DisplayBlock, turnId: string): block is MessageBlock & { segmentId: string } {
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
    // A task log's own blocks; a planner turn never has one.
    if (block.type === 'command' || block.type === 'compaction' || block.type === 'runner_loaded' || block.type === 'handoff') continue;
    if (block.turnId !== turnId) continue;
    return isUnsettledSegment(block, turnId) ? i : -1;
  }
  return -1;
}

function openTurn(view: ConversationView, { turnId, prompt = '', skills = [], wakeUps = [], forced }: Message<'planner_turn_started'>): ConversationView {
  const adopted = takePendingInputs(view, prompt, wakeUps, turnId);
  view = adopted.view;
  wakeUps = wakeUps.slice(adopted.wakeUps);
  if (wakeUps.length === 0) return adopted.prompt || (prompt === '' && adopted.wakeUps > 0) ? view : promptLine(view, turnId, prompt, skills, forced);
  // A wake-up turn has no message; otherwise the run updates go ahead of the
  // message they were delivered with, where the transcript keeps them.
  const said = prompt === '' || adopted.prompt ? view : promptLine(view, turnId, prompt, skills, forced);
  // The usage line stays last (see `insertTop`), so a wake-up turn's updates
  // land above it rather than after it.
  const at = prompt === ''
    ? said.blocks.length - (said.blocks.at(-1)?.type === 'usage' ? 1 : 0)
    : findLastIndex(said.blocks, (b) => b.type === 'message' && b.role === 'user' && b.turnId === turnId);
  const updates = wakeUps.map((text, n) => settledMessage(`b${said.nextId + n}`, 'wake_up', text, turnId));
  return { ...said, blocks: [...said.blocks.slice(0, at), ...updates, ...said.blocks.slice(at)], nextId: said.nextId + updates.length };
}

/**
 * `heldAt`: the entry is one a surface already passed by its time, which a
 * landing turn writes for what it held (its own start) behind the notes written
 * while it ran. Only an input that arrived by then can be that entry's.
 */
function takePendingInputs(view: ConversationView, prompt: string | undefined, wakeUps: readonly string[], turnId?: string, heldAt?: string): { view: ConversationView; prompt: boolean; wakeUps: number } {
  const pending = view.pendingInputs ?? [];
  const arrived = ({ input }: { input: SerializedPendingTurn }) => heldAt === undefined || input.timestamp <= heldAt;
  const users = pending.filter((p) => p.input.source === 'user' && arrived(p));
  const updates = pending.filter((p) => p.input.source === 'supervisor' && arrived(p));
  const taken = new Set<string>();
  let matchedPrompt = false;
  // PlanTurns joins a batch's user messages, but reload draws each arrival.
  for (let n = 1; prompt !== undefined && n <= users.length; n++) {
    if (users.slice(0, n).map(({ input }) => input.text).join('\n\n') !== prompt) continue;
    for (const { input } of users.slice(0, n)) taken.add(input.id);
    matchedPrompt = true;
    break;
  }
  let matchedUpdates = 0;
  while (matchedUpdates < wakeUps.length && updates[matchedUpdates]?.input.text === wakeUps[matchedUpdates]) {
    taken.add(updates[matchedUpdates++].input.id);
  }
  if (taken.size === 0) return { view, prompt: false, wakeUps: 0 };
  const blockIds = new Set(pending.filter(({ input }) => taken.has(input.id)).flatMap(({ blockIds }) => blockIds));
  return {
    view: {
      ...view,
      blocks: turnId === undefined ? view.blocks : view.blocks.map((block) => blockIds.has(block.id) ? { ...block, turnId } : block),
      pendingInputs: pending.filter(({ input }) => !taken.has(input.id)),
    },
    prompt: matchedPrompt,
    wakeUps: matchedUpdates,
  };
}

function promptLine(view: ConversationView, turnId: string, prompt: string, skills: NonNullable<Message<'planner_turn_started'>['skills']>, forced?: boolean): ConversationView {
  // A surface shows its user's prompt the moment it is sent; the turn that
  // answers it adopts that line rather than repeating it.
  const i = findLastIndex(view.blocks, (b) => b.type === 'message' && b.role === 'user');
  const sent = view.blocks[i];
  const adopted = sent?.type === 'message' && sent.turnId === undefined && sent.text === prompt;
  const said: ConversationView = adopted
    ? { ...view, blocks: replaceAt(view.blocks, i, userMessage(sent.id, prompt, skills, { turnId, forced })) }
    : append(view, (id) => userMessage(id, prompt, skills, { turnId, forced }));
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

function settleReply(view: ConversationView, { content, turnId, supervisor, runs, signIn }: Message<'planner_message'>): ConversationView {
  const role = supervisor ? 'supervisor' : 'planner';
  if (runs) return settleRuns(view, runs, role, turnId, signIn);
  const settled = (id: string) => (signIn ? signedOutFailure(id, content, signIn, turnId) : settledMessage(id, role, content, turnId));
  if (turnId !== undefined) {
    const i = finalSegmentIndex(view.blocks, turnId);
    if (i >= 0) {
      return dropBuildingPlan({ ...view, blocks: replaceAt(view.blocks, i, settled(view.blocks[i].id)) }, turnId);
    }
  }
  return append(dropBuildingPlan(view, turnId), settled);
}

/**
 * Settle a reply run by run (ADR-0017 A1): each run's text takes its segment's
 * place, wherever in the turn it streamed, and only a run that never streamed
 * goes last. A segment of the turn the reply no longer contains did not
 * become part of it. Without a turn id (a reply a surface backfilled from the
 * transcript) the turn is the one the runs' segments streamed in.
 */
function settleRuns(view: ConversationView, runs: readonly ReplyRun[], role: MessageRole, turnId: string | undefined, signIn?: RunnerSignIn): ConversationView {
  // A signed-out failure is the note written last, in the reply's place (writtenOver).
  const failure = signIn ? runs.at(-1) : undefined;
  const settle = (id: string, run: ReplyRun, turn: string | undefined) =>
    (signIn && run === failure ? signedOutFailure(id, run.text, signIn, turn) : settledMessage(id, role, run.text, turn));
  const settled = new Map<number, ReplyRun>();
  let turn = turnId;
  for (const run of runs) {
    const i = view.blocks.findIndex((b) => b.type === 'message' && b.segmentId === run.segmentId && b.turnId !== undefined && (turnId === undefined || b.turnId === turnId));
    const segment = view.blocks[i];
    if (segment?.type !== 'message') continue;
    settled.set(i, run);
    turn ??= segment.turnId;
  }
  const contained = new Set(runs.map((run) => run.segmentId));
  const blocks = view.blocks.flatMap((block, i) => {
    const run = settled.get(i);
    if (run) return [settle(view.blocks[i].id, run, turn)];
    return turn !== undefined && isUnsettledSegment(block, turn) && !contained.has(block.segmentId) ? [] : [block];
  });
  const streamed = new Set(settled.values());
  return runs
    .filter((run) => !streamed.has(run))
    .reduce((next, run) => append(next, (id) => settle(id, run, turn)), dropBuildingPlan({ ...view, blocks }, turn));
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

function requestApproval(view: ConversationView, { id: approvalId, kind, subject, scope, detail, body, turnId }: Message<'approval_request'>): ConversationView {
  return append(view, (id) => ({
    type: 'approval', id, approvalId, kind, subject, scope, status: 'pending',
    ...(detail ? { detail } : {}),
    ...(body ? { body } : {}),
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

function compactionAt(view: ConversationView, compactionId: string): number {
  return findLastIndex(view.blocks, (b) => b.type === 'compaction' && b.compactionId === compactionId);
}

/**
 * One phase of a planner compaction, folded by its id so a surface that hears
 * a phase twice, or the transcript first, still draws one block. Once ended it
 * stays as it ended: a late or repeated phase never reopens it, and one that
 * had nothing to do leaves nothing behind. Only an end that changed something
 * draws a block the view never saw start: a harness planner reports nothing else.
 */
function followCompaction(view: ConversationView, { compaction, turnId }: Message<'planner_compaction'>): ConversationView {
  const i = compactionAt(view, compaction.id);
  const at = view.blocks[i];
  const known = at?.type === 'compaction' ? at : undefined;
  if (compaction.phase === 'started') {
    if (known) return view;
    return append(view, (id) => compactionBlock(id, { compactionId: compaction.id, origin: compaction.origin, trigger: compaction.trigger, status: 'running', turnId }));
  }
  const { outcome, preTokens, postTokens } = compaction;
  if (known && known.status !== 'running') return view;
  if (outcome === 'unchanged') return known ? { ...view, blocks: view.blocks.filter((_, n) => n !== i) } : view;
  // One that changed nothing is news only to a view that saw it start.
  if (!known && (outcome === 'stopped' || outcome === 'failed')) return view;
  const ended = (id: string) => compactionBlock(id, {
    compactionId: compaction.id, origin: compaction.origin, trigger: compaction.trigger, status: outcome, preTokens, postTokens, turnId: known?.turnId ?? turnId,
  });
  return known ? { ...view, blocks: replaceAt(view.blocks, i, ended(known.id)) } : append(view, ended);
}

/**
 * A compaction entry in the transcript: the checkpoint its compaction wrote,
 * matched by id, now has the summary to show. An entry without one is from a
 * daemon that announced the summary as a turnless planner message first; that
 * message becomes the block.
 */
function markCompaction(view: ConversationView, entry: SerializedConversationMessage): ConversationView {
  const { content: summary } = entry;
  const checkpoint = isCheckpoint(entry.checkpoint) ? entry.checkpoint : undefined;
  if (checkpoint) {
    const i = compactionAt(view, checkpoint.id);
    const known = view.blocks[i];
    if (known?.type !== 'compaction') {
      return append(view, (id) => compactionBlock(id, { compactionId: checkpoint.id, origin: 'ordewell', trigger: checkpoint.trigger, status: 'condensed', summary }));
    }
    if (known.status === 'condensed' && known.summary === summary) return view;
    return { ...view, blocks: replaceAt(view.blocks, i, { ...known, status: 'condensed', summary } satisfies CompactionBlock) };
  }
  const settled = (id: string) => compactionBlock(id, { origin: 'ordewell', trigger: 'manual', status: 'condensed', summary });
  const i = findLastIndex(view.blocks, (b) => b.type === 'message' && b.role === 'planner' && b.turnId === undefined && b.text === summary);
  const announced = view.blocks[i];
  return announced ? { ...view, blocks: replaceAt(view.blocks, i, settled(announced.id)) } : append(view, settled);
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
    const heldAt = isNew ? undefined : entry.timestamp;
    if (entry.role === 'user' && !entry.kind) next = takePendingInputs(next, entry.content, [], undefined, heldAt).view;
    if (entry.kind === 'wake_up') next = takePendingInputs(next, undefined, [entry.content], undefined, heldAt).view;
    if (isNew && entry.kind === 'plan_generated') next = markPlan(next, entry.content, i === committed ? turnId : undefined);
    if (isNew && entry.kind === 'system') next = append(next, (id) => settledMessage(id, 'system', entry.content));
    if (isNew && entry.kind === 'error') next = append(next, (id) => settledMessage(id, 'error', entry.content));
    if (isNew && entry.kind === 'compaction') next = markCompaction(next, entry);
    if (latest === undefined || entry.timestamp > latest) latest = entry.timestamp;
  }
  return next === view && latest === view.transcriptAt ? view : { ...next, transcriptAt: latest };
}

/**
 * Bring the view's approval cards in line with the planner's requests the
 * session says are still waiting — for a surface that was not listening the
 * whole time: one that reconnected, reloaded, or just attached. A pending card
 * the session no longer has was answered or expired meanwhile; this surface
 * never heard how, so the card goes rather than guessing an answer. A waiting
 * request with no card gets one, answerable as the live one would have been.
 */
export function reconcileApprovals(view: ConversationView, waiting: readonly Message<'approval_request'>[]): ConversationView {
  const ids = new Set(waiting.map((request) => request.id));
  const answered = (block: DisplayBlock): boolean =>
    block.type === 'approval' && block.status === 'pending' && block.approvalId !== undefined && !ids.has(block.approvalId);
  const kept = view.blocks.some(answered) ? { ...view, blocks: view.blocks.filter((block) => !answered(block)) } : view;
  const carded = new Set(kept.blocks.flatMap((block) => (block.type === 'approval' && block.approvalId ? [block.approvalId] : [])));
  return waiting.filter((request) => !carded.has(request.id)).reduce(requestApproval, kept);
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
    case 'execution_action':
      return append(view, (id) => settledMessage(id, 'system', input.text));
    case 'planner_usage':
      return reportUsage(view, input);
    case 'planner_compaction':
      return followCompaction(view, input);
    default:
      return view;
  }
}
