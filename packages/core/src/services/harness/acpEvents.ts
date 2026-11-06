import type { AgentEvent } from './AgentAdapter';
import type { UsageRecord } from '../../models/Usage';
import type { AcpSessionUpdate, AcpToolCall, AcpTokenUsage } from './acpSchema';

/**
 * The turn-by-turn translation of an ACP agent's `session/update`
 * notifications into {@link AgentEvent}s. Pure: no I/O, no clock, so a turn's
 * events follow from the updates alone.
 *
 * A turn is ended in {@link endTurn}, and only there, from the response to
 * `session/prompt`. The v2 draft changes when that response arrives relative
 * to the last update, so no update here ends a turn.
 */

interface Run {
  runId: string;
  text: string;
  messageId?: string;
}

interface OpenCall {
  name: string;
  args: Record<string, unknown>;
  /** Whether its `tool_call` event has gone out; a `pending` call's waits for its input. */
  announced: boolean;
}

export interface AcpTurn {
  readonly source: string;
  readonly model?: string;
  readonly runCount: number;
  /** Message runs in the order they began, kept to be sent whole at the end. */
  readonly messages: readonly Run[];
  readonly thoughts: readonly Run[];
  /** Whether the last run of each kind can still take a chunk: a tool call closes both. */
  readonly messageOpen: boolean;
  readonly thoughtOpen: boolean;
  /** Calls reported and not yet finished, by the agent's id for them. */
  readonly open: Readonly<Record<string, OpenCall>>;
  /** Every id already given a result, so a repeated update cannot report a second one. */
  readonly finished: readonly string[];
}

/** `source` is the id usage is reported under; `model` is the one the task runs on, where known. */
export function newTurn(opts: { source: string; model?: string }): AcpTurn {
  return { ...opts, runCount: 0, messages: [], thoughts: [], messageOpen: false, thoughtOpen: false, open: {}, finished: [] };
}

export interface AcpStep {
  turn: AcpTurn;
  events: AgentEvent[];
}

export function reduceUpdate(turn: AcpTurn, update: AcpSessionUpdate): AcpStep {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return chunk(turn, 'message', update.content, update.messageId);
    case 'agent_thought_chunk':
      return chunk(turn, 'thought', update.content, update.messageId);
    case 'tool_call':
    case 'tool_call_update':
      return toolCall(closeRuns(turn), update);
    case 'usage_update': {
      // A context meter, and `cost` is the session's running total: neither
      // adds up per turn, so only the meter is reported.
      const record: UsageRecord = { source: turn.source, contextTokens: update.used, contextWindow: update.size };
      if (turn.model !== undefined) record.model = turn.model;
      return { turn, events: [{ type: 'usage', record }] };
    }
    // user_message_chunk only replays history on session/load. The rest hold
    // state the connector reads from the update itself, and an unknown kind
    // is none of this reducer's business.
    default:
      return { turn, events: [] };
  }
}

function closeRuns(turn: AcpTurn): AcpTurn {
  return turn.messageOpen || turn.thoughtOpen ? { ...turn, messageOpen: false, thoughtOpen: false } : turn;
}

function chunk(turn: AcpTurn, kind: 'message' | 'thought', content: { type: string; text?: string }, messageId: string | null | undefined): AcpStep {
  if (content.type !== 'text' || content.text === undefined) return { turn, events: [] };
  const key = kind === 'message' ? 'messages' : 'thoughts';
  const openKey = kind === 'message' ? 'messageOpen' : 'thoughtOpen';
  const runs = turn[key];
  const last = runs[runs.length - 1];
  const id = messageId ?? undefined;
  const continues = turn[openKey] && last !== undefined && (id === undefined || last.messageId === undefined || last.messageId === id);

  let next: AcpTurn;
  let runId: string;
  if (continues) {
    runId = last.runId;
    next = { ...turn, [key]: [...runs.slice(0, -1), { ...last, text: last.text + content.text }] };
  } else {
    runId = `acp-${kind === 'message' ? 'msg' : 'thought'}-${turn.runCount + 1}`;
    next = { ...turn, runCount: turn.runCount + 1, [openKey]: true, [key]: [...runs, { runId, text: content.text, ...(id !== undefined ? { messageId: id } : {}) }] };
  }
  const event: AgentEvent = kind === 'message' ? { type: 'assistant_text_delta', runId, text: content.text } : { type: 'thinking_delta', text: content.text };
  return { turn: next, events: [event] };
}

// A tool the agent names by `name` is an extension; the specification only
// has `title`, which an agent rewrites as the call proceeds, so the name a
// call was first seen under is the one its result is reported under.
function toolName(update: AcpToolCall): string {
  return update.name || update.title || update.kind || 'tool';
}

// A `pending` call can still be filling in its input: OpenCode reports its
// shell call with only `{ cwd }` and sends the command in the next update.
// Announcing it there gave the call an empty summary, so it waits for the
// first update past `pending`, as the native OpenCode adapter does. An agent
// that sends no status is announced at once: nothing says more is coming.
function toolCall(turn: AcpTurn, update: AcpToolCall & { sessionUpdate: string }): AcpStep {
  const id = update.toolCallId;
  if (turn.finished.includes(id)) return { turn, events: [] };
  const events: AgentEvent[] = [];
  const prior = turn.open[id];
  const call: OpenCall = {
    name: prior?.name ?? toolName(update),
    args: update.rawInput === undefined || update.rawInput === null ? (prior?.args ?? {}) : toolArgs(update.rawInput),
    announced: prior?.announced ?? false,
  };
  // An update without a status leaves it unchanged, so a call still unannounced stays pending.
  const pending = update.status === 'pending' || ((update.status === undefined || update.status === null) && prior !== undefined);
  if (!call.announced && !pending) {
    events.push(announce(id, call));
    call.announced = true;
  }
  if (update.status !== 'completed' && update.status !== 'failed') return { turn: { ...turn, open: { ...turn.open, [id]: call } }, events };
  const rest = { ...turn.open };
  delete rest[id];
  events.push({ type: 'tool_result', id, name: call.name, output: toolOutput(update), success: update.status === 'completed' });
  return { turn: { ...turn, open: rest, finished: [...turn.finished, id] }, events };
}

function announce(id: string, call: OpenCall): AgentEvent {
  return { type: 'tool_call', id, name: call.name, args: call.args };
}

/** Only called with a present `rawInput`: the caller keeps the prior arguments for an absent one. */
function toolArgs(rawInput: unknown): Record<string, unknown> {
  if (typeof rawInput === 'object' && !Array.isArray(rawInput)) return rawInput as Record<string, unknown>;
  return { input: rawInput };
}

function toolOutput(update: AcpToolCall): string {
  const parts: string[] = [];
  for (const item of update.content ?? []) {
    if (item.type === 'content' && item.content?.type === 'text' && item.content.text !== undefined) parts.push(item.content.text);
    else if (item.type === 'diff' && item.path !== undefined) parts.push(`Changed ${item.path}`);
    else if (item.type === 'terminal' && item.terminalId !== undefined) parts.push(`Terminal ${item.terminalId}`);
  }
  if (parts.length > 0) return parts.join('\n');
  if (update.rawOutput === undefined || update.rawOutput === null) return '';
  return typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput);
}

const NOTE: Readonly<Record<string, string>> = {
  max_tokens: 'The agent stopped because it reached its token limit for the turn.',
  max_turn_requests: 'The agent stopped because it reached its limit on model requests for the turn.',
};

/**
 * The one place a turn ends, on the response to `session/prompt`.
 * `cancelSent` is whether Ordewell sent `session/cancel` for this turn: an
 * agent can answer `end_turn` to a cancel that crossed its own finish, and
 * the turn was still interrupted. A reason Ordewell does not know ends the
 * turn the way `end_turn` does, with the reason named, since the agent did stop.
 * An answer with no stop reason to read (`unreadable`, the parse error) says
 * nothing of why the agent stopped, so it ends the turn as an error rather
 * than passing for a normal end.
 */
export function endTurn(turn: AcpTurn, stopReason: string | { unreadable: string }, usage: AcpTokenUsage | null | undefined, cancelSent: boolean): AgentEvent[] {
  const events: AgentEvent[] = [];

  // A call still open has no result coming: the turn it belonged to is over.
  for (const [id, call] of Object.entries(turn.open)) {
    if (!call.announced) events.push(announce(id, call));
    events.push({ type: 'tool_result', id, name: call.name, output: 'The turn ended before this call reported a result.', success: false });
  }
  for (const run of turn.thoughts) events.push({ type: 'thinking', text: run.text });
  for (const run of turn.messages) events.push({ type: 'assistant_text', runId: run.runId, text: run.text });

  const record = usageRecord(turn, usage);
  if (record) events.push({ type: 'usage', record });

  if (cancelSent || stopReason === 'cancelled') {
    events.push({ type: 'turn_end', interrupted: true });
  } else if (typeof stopReason === 'object') {
    events.push({ type: 'error', message: `The agent ended the turn with an answer Ordewell cannot read: ${stopReason.unreadable}` });
  } else if (stopReason === 'refusal') {
    // An error alone ends the turn, as for the other runners.
    events.push({ type: 'error', message: 'The agent refused to continue this turn.' });
  } else {
    if (stopReason !== 'end_turn') {
      events.push({ type: 'command_output', text: NOTE[stopReason] ?? `The agent stopped the turn with the reason "${stopReason}".` });
    }
    events.push({ type: 'turn_end' });
  }
  return events;
}

// A measure the agent leaves out stays out of the record: unknown, not zero.
// `thoughtTokens` has no place in a record, and `totalTokens` is only a sum.
function usageRecord(turn: AcpTurn, usage: AcpTokenUsage | null | undefined): UsageRecord | undefined {
  if (!usage) return undefined;
  const record: UsageRecord = { source: turn.source };
  if (turn.model !== undefined) record.model = turn.model;
  let reported = false;
  const take = (value: number | null | undefined, set: (n: number) => void) => {
    if (typeof value !== 'number') return;
    set(value);
    reported = true;
  };
  take(usage.inputTokens, (n) => (record.inputTokens = n));
  take(usage.outputTokens, (n) => (record.outputTokens = n));
  take(usage.cachedReadTokens, (n) => (record.cachedInputTokens = n));
  return reported ? record : undefined;
}
