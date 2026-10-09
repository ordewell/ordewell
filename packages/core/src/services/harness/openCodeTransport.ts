import { randomBytes } from 'crypto';
import { partedPromptUsage, type UsageRecord } from '../../models/Usage';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { McpClientConfig } from '../mcp';
import { LineBuffer, type AgentEvent, type TaskStartOptions } from './AgentAdapter';
import { OPENCODE_ORDEWELL } from './openCodeOrdewell';
import { settleWithin } from './settleWithin';

/**
 * The HTTP protocol work OpenCode's two server APIs share: 1.x (`/event`,
 * {@link OpenCodeAdapter}) and 2.x (`/api/event`, {@link OpenCodeV2}). The
 * event names and shapes differ between them; how a turn is streamed, how a
 * permission request is answered, how a child session is tied to the call
 * that spawned it and how a turn is settled do not. Each version reads its
 * own frames and hands what they mean to the pieces here.
 */

/** How long a turn waits for the event stream before posting anyway. */
const STREAM_CONNECT_TIMEOUT_MS = 5000;

type OnEvent = (event: AgentEvent) => void;
export type PermissionRequest = Extract<AgentEvent, { type: 'permission_request' }>;

/**
 * OpenCode addresses a model as a provider id and a model id; discovery and
 * the plan artifact carry the flat `provider/model` id the CLI's `--model`
 * flag takes. Split on the first slash — provider ids never contain one, model
 * ids sometimes do (`openrouter/anthropic/claude-sonnet-4`).
 */
export function splitModelId(id: string): { providerID: string; modelID: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Removed when the timer fires: the polls wait on one turn's signal every
    // second, and a listener left per wait accumulates for the turn's life.
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** One model call's token counts, as both versions report them. */
export interface OpenCodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/**
 * One model call's usage. OpenCode's `input` counts only the uncached prompt —
 * cache reads and writes sit beside it, as with Anthropic
 * ({@link partedPromptUsage}): in the recordings `tokens.total` is input +
 * output + both cache counts. Its `output` excludes `reasoning` (a recorded
 * reply with text reports output 0 beside reasoning 127), and reasoning is
 * billed as output, so it is counted as output.
 */
export function usageRecord(tokens: OpenCodeTokens | undefined, call: { model?: string; cost?: number; subagentId?: string }): UsageRecord | null {
  if (!tokens) return null;
  const prompt = partedPromptUsage({ uncached: tokens.input, cacheRead: tokens.cache?.read, cacheWrite: tokens.cache?.write });
  const outputTokens = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  // A call that failed before the provider answered reports all zeros. That
  // is no measurement, and a zero prompt would read as an empty context.
  if ((prompt.inputTokens ?? 0) + outputTokens === 0) return null;
  const record: UsageRecord = { source: 'opencode', ...prompt, outputTokens };
  if (call.model) record.model = call.model;
  // OpenCode prices a call itself, from its model catalog, so a reported 0
  // means a free model or one the catalog has no price for. Those cannot be
  // told apart, so 0 is left unreported: a ledger may not claim a bill of
  // nothing.
  if (typeof call.cost === 'number' && call.cost > 0) record.reportedCost = { amount: call.cost, currency: 'USD' };
  if (call.subagentId) record.subagentId = call.subagentId;
  return record;
}

export type PermissionAnswer = 'once' | 'always' | 'reject';

/**
 * OpenCode's three answers to a permission request, from Ordewell's three
 * (ADR-0018, A1), under the body key the version names it by: 1.x `reply`,
 * 2.x `decision`.
 */
export function permissionReply<K extends string>(decision: ApprovalDecision, key: K): Record<K, PermissionAnswer> & { message?: string } {
  const answer = (value: PermissionAnswer, message?: string) =>
    ({ [key]: value, ...(message ? { message } : {}) }) as Record<K, PermissionAnswer> & { message?: string };
  if (decision.decision === 'allow') return answer('once');
  if (decision.decision === 'allowForTask') return answer('always');
  // With a message OpenCode hands the note to the agent as a correction; without one it is a bare refusal.
  return answer('reject', decision.note?.trim());
}

/**
 * Whether a task's mode answers every request the way `opencode run --auto`
 * does: its manifest sets `approvals: auto` for `build`.
 */
export function autoApproves(task: TaskStartOptions): boolean {
  return task.flags.modeSettings.approvals === 'auto';
}

/** An id in the shape OpenCode's prompt body takes for `messageID` (`^msg`), so a steer names its own message. */
export function newUserMessageId(): string {
  return `msg_${randomBytes(12).toString('hex')}`;
}

/**
 * The messages handed into a running OpenCode turn and not yet shown to the
 * model, by the user message id the server stored each under (ADR-0023). The
 * server keeps a stored message in the session, so a delivery the stream never
 * carried is still owed when the turn ends — {@link drain} is what re-sends it.
 */
export class PendingSteers {
  /** User message id → the Ordewell message id it was sent for. */
  private readonly pending = new Map<string, string>();
  /** The user message ids in the order they were handed over. */
  private readonly order: string[] = [];

  hand(messageId: string, id: string): void {
    this.pending.set(messageId, id);
    this.order.push(messageId);
  }

  /**
   * The Ordewell ids an assistant message parented at `parentID` delivers: a
   * pending whose stored message it is, or one handed over before it — the
   * model read past the earlier message to answer this one.
   */
  deliveredBy(parentID: string | undefined): string[] {
    if (!parentID) return [];
    const upto = this.order.indexOf(parentID);
    if (upto < 0) return [];
    const delivered: string[] = [];
    for (const messageId of [...this.pending.keys()]) {
      // `hand` records the order too, so every pending id is in it.
      if (this.order.indexOf(messageId) <= upto) {
        delivered.push(this.pending.get(messageId)!);
        this.pending.delete(messageId);
      }
    }
    return delivered;
  }

  /**
   * Stop expecting delivery of one handed over whose request then failed.
   * False when it was already delivered, so a late failure does not recall it.
   */
  forget(id: string): boolean {
    for (const [messageId, held] of this.pending) {
      if (held !== id) continue;
      this.pending.delete(messageId);
      return true;
    }
    return false;
  }

  /** Every message still owed, oldest first, and empty this — what the server must be told to forget. */
  drain(): Array<{ messageId: string; id: string }> {
    const all = this.order.flatMap((messageId) => {
      const id = this.pending.get(messageId);
      return id === undefined ? [] : [{ messageId, id }];
    });
    this.pending.clear();
    this.order.length = 0;
    return all;
  }
}

const ALLOW: ApprovalDecision = { decision: 'allow' };
const DENY: ApprovalDecision = { decision: 'deny' };

/**
 * A session's permission requests, from the frame that raises one to the
 * answer. OpenCode blocks the turn on every request until it is answered, so
 * each one is answered or left open for a person — never dropped.
 */
export class OpenCodePermissions {
  /** Requests waiting for an answer, by request id, with the session that asked. */
  private readonly open = new Map<string, string>();

  constructor(
    private readonly reply: (id: string, sessionId: string, decision: ApprovalDecision) => Promise<void>,
    /** The Ordewell server the runner was given; its tools are never refused (ADR-0022, S3). */
    private readonly ordewell: () => McpClientConfig | null | undefined,
  ) {}

  /**
   * A planner's request (T1): refused, which is the same "absent answer is a
   * denial" invariant ADR-0008 states for Ordewell's own tools. The refusal is
   * announced so the timeline shows the planner reaching for something it may
   * not have. The planner's own submission path, which the allow rule should
   * already have settled, is the one request it may not be refused.
   */
  refuse(request: PermissionRequest, sessionId: string, seen: Set<string>, onEvent: OnEvent): void {
    if (!firstSight(request.id, seen)) return;
    if (this.isOrdewellTool(request.name)) {
      this.send(request.id, sessionId, ALLOW);
      return;
    }
    onEvent(request);
    this.send(request.id, sessionId, DENY);
  }

  /**
   * A task's request. Under a mode whose manifest sets `approvals: auto` it is
   * answered at once with what `opencode run --auto` answers, so the same plan
   * follows the manifest (ADR-0001), and announced already
   * decided so the log still shows it. Any other mode leaves it open for an
   * approval card.
   */
  ask(request: PermissionRequest, sessionId: string, autoApprove: boolean, seen: Set<string>, onEvent: OnEvent): void {
    if (!firstSight(request.id, seen)) return;
    // Whatever the mode, a completion that waited on a person would hold the verdict hostage (ADR-0022, S3).
    if (this.isOrdewellTool(request.name) || autoApprove) {
      onEvent({ ...request, decided: ALLOW });
      this.send(request.id, sessionId, ALLOW);
      return;
    }
    this.open.set(request.id, sessionId);
    onEvent(request);
  }

  /** A person's answer to an open request. False when it is not open. */
  answer(id: string, decision: ApprovalDecision): boolean {
    const sessionId = this.open.get(id);
    if (sessionId === undefined) return false;
    this.open.delete(id);
    this.send(id, sessionId, decision);
    return true;
  }

  /** Answered by OpenCode itself: a reject also refuses the session's other requests and an `always` grants the ones it covers. */
  withdraw(id: string | undefined, onEvent: OnEvent): void {
    if (id && this.open.delete(id)) onEvent({ type: 'permission_cancelled', id });
  }

  /** OpenCode asks only mid-turn and blocks on the answer, so a request still open once the turn is over was dropped by the abort that ended it. */
  cancelAll(onEvent: OnEvent): void {
    for (const id of [...this.open.keys()]) {
      this.open.delete(id);
      onEvent({ type: 'permission_cancelled', id });
    }
  }

  private isOrdewellTool(name: string): boolean {
    return !!this.ordewell() && OPENCODE_ORDEWELL.isOrdewellAsk(name);
  }

  private send(id: string, sessionId: string, decision: ApprovalDecision): void {
    void this.reply(id, sessionId, decision).catch(() => { /* a server that forgot the request will not hang on it either */ });
  }
}

function firstSight(id: string, seen: Set<string>): boolean {
  if (seen.has(`perm:${id}`)) return false;
  seen.add(`perm:${id}`);
  return true;
}

/**
 * The reply's text as it streams and once each run of it completes. A message
 * can carry text on both sides of a tool call, so each run after the first
 * opens a paragraph; the break goes out with a run's first visible delta, so
 * the deltas add up to exactly the text the completed run then re-sends.
 */
export class ReplyText {
  private hasText = false;
  private readonly runs = new Map<string, { held: string; lead: string | null }>();
  private readonly completed = new Set<string>();

  /** One complete run, once. */
  complete(id: string, text: string, onEvent: OnEvent): void {
    if (this.completed.has(id)) return;
    this.completed.add(id);
    // Some models open a message with text of nothing but newlines before
    // calling a tool. It says nothing, and as a paragraph of its own it would
    // push the real reply down by a blank one.
    if (!text.trim()) return;
    const lead = this.runs.get(id)?.lead ?? (this.hasText ? '\n\n' : '');
    onEvent({ type: 'assistant_text', text: `${lead}${text}` });
    this.hasText = true;
  }

  /** One piece of a run. A run that is only whitespace so far is held back, for the reason {@link complete} drops one. */
  delta(id: string, delta: string, onEvent: OnEvent): void {
    if (this.completed.has(id)) return;
    const run = this.runs.get(id) ?? { held: '', lead: null };
    this.runs.set(id, run);
    if (run.lead !== null) {
      onEvent({ type: 'assistant_text_delta', text: delta });
      return;
    }
    run.held += delta;
    if (!run.held.trim()) return;
    run.lead = this.hasText ? '\n\n' : '';
    this.hasText = true;
    onEvent({ type: 'assistant_text_delta', text: `${run.lead}${run.held}` });
  }
}

/**
 * The child sessions a turn's subagents run in. The server's stream is
 * global, so only children of the turn's own session are followed, and a
 * child's frames can arrive before the call that spawned it names it — those
 * are held and replayed once it does.
 */
export class ChildSessions<F> {
  /** Child session → the call that owns it, or null until that call names it. */
  private readonly owners = new Map<string, string | null>();
  private readonly held = new Map<string, F[]>();

  created(child: string): void {
    if (!this.owners.has(child)) this.owners.set(child, null);
  }

  follows(session: string): boolean {
    return this.owners.has(session);
  }

  /** The subagent a child's frame belongs to, or null when the frame is held until its call is named. */
  claim(session: string, frame: F): string | null {
    const owner = this.owners.get(session);
    if (owner) return owner;
    this.held.set(session, [...(this.held.get(session) ?? []), frame]);
    return null;
  }

  /** Tie a child to its call, once. The frames held for it, to replay, or null when it was already tied. */
  adopt(child: string, callId: string): F[] | null {
    if (this.owners.get(child)) return null;
    this.owners.set(child, callId);
    const held = this.held.get(child) ?? [];
    this.held.delete(child);
    return held;
  }

  owns(callId: string): boolean {
    return [...this.owners.values()].includes(callId);
  }
}

/** What one turn has learned from the stream, as far as both versions share it. */
export interface StreamTurn<F> {
  seen: Set<string>;
  text: ReplyText;
  children: ChildSessions<F>;
}

export function streamTurn<F>(): StreamTurn<F> {
  return { seen: new Set(), text: new ReplyText(), children: new ChildSessions<F>() };
}

/** When one posted turn is over. */
export interface TurnLatch {
  /** This turn's own work has been seen, so an end the server reports is this turn's and not a late one from the turn before. */
  live: boolean;
  done: boolean;
  finish: () => void;
  /** Resolves when {@link finish} is called. */
  ended: Promise<void>;
}

export function turnLatch(): TurnLatch {
  let markDone!: () => void;
  const ended = new Promise<void>((resolve) => { markDone = resolve; });
  const turn: TurnLatch = { live: false, done: false, ended, finish: () => { turn.done = true; markDone(); } };
  return turn;
}

export interface TurnSettlement {
  signal?: AbortSignal;
  processEnded: Promise<void>;
  exitMessage(): string;
  /** Whatever of the turn's own messages the stream missed. */
  readBack(): Promise<void>;
  permissions: OpenCodePermissions;
  /** The event that ends a turn that ran to its end. */
  outcome(): AgentEvent;
}

/**
 * Wait out a posted turn, then settle it: what the stream missed, the requests
 * left open, and how it ended. A server that exits first fails the turn.
 * False when the caller's signal aborted it, which the caller answers by
 * disposing of the server.
 */
export async function settleTurn(turn: TurnLatch, how: TurnSettlement, onEvent: OnEvent): Promise<boolean> {
  const { signal } = how;
  const aborted = new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  await Promise.race([turn.ended, aborted, how.processEnded]);
  if (signal?.aborted) return false;
  if (!turn.done) {
    onEvent({ type: 'error', message: how.exitMessage() });
    return true;
  }
  await how.readBack();
  how.permissions.cancelAll(onEvent);
  onEvent(how.outcome());
  return true;
}

/** Whether a posted interrupt is acknowledged: the turn ends before the server does and before `timeoutMs`. */
export async function interruptAcknowledged(turn: TurnLatch, processEnded: Promise<void>, timeoutMs: number): Promise<boolean> {
  return settleWithin(turn.ended.then(() => true), { timeoutMs, ended: processEnded, onTimeout: () => false, onEnded: () => false });
}

/**
 * Open the event stream for one turn and wait until it is connected. The
 * stream stopped being best-effort the moment permission answers moved onto
 * it: a request raised before we connect is one nobody answers, and the turn
 * hangs on it. Waiting is bounded so a server that never opens the stream
 * still gets its turn. Resolves to the stream's close.
 */
export async function openEventStream<F>(
  connect: (signal: AbortSignal) => Promise<Response | null>,
  onFrame: (frame: F) => void,
  onActivity?: () => void,
): Promise<() => Promise<void>> {
  const streamAbort = new AbortController();
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => { connected = resolve; });
  const live = streamEvents(connect, streamAbort.signal, onFrame, connected, onActivity);
  await settleWithin(ready, { timeoutMs: STREAM_CONNECT_TIMEOUT_MS, onTimeout: () => undefined });
  return async () => {
    streamAbort.abort();
    await live.catch(() => { /* the stream is best-effort */ });
  };
}

/**
 * Server-sent events: the turn's live text, reasoning, tool activity and
 * usage, and the only channel permission requests arrive on.
 */
async function streamEvents<F>(
  connect: (signal: AbortSignal) => Promise<Response | null>,
  signal: AbortSignal,
  onFrame: (frame: F) => void,
  onConnected: () => void,
  onActivity?: () => void,
): Promise<void> {
  const response = await connect(signal).catch(() => null);
  const body = response?.body;
  onConnected();
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lines = new LineBuffer();
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done) return;
    // Any bytes at all mean the server is still talking, independent of
    // whether this chunk resolves into an event that is forwarded — the same
    // gap that made Claude Code's watchdog false-positive on filtered
    // subagent output, closed here before it can recur.
    onActivity?.();
    lines.push(decoder.decode(value, { stream: true }), (line) => {
      if (!line.startsWith('data:')) return;
      try {
        onFrame(JSON.parse(line.slice(5).trim()) as F);
      } catch {
        // A partial or unrecognized frame costs one event, not the turn.
      }
    });
  }
}
