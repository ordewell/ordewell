import { randomBytes } from 'crypto';
import { partedPromptUsage } from '../../models/Usage';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import { LineBuffer, type AgentEvent, type PlannerAsk, type PlannerStartOptions, type TaskStartOptions } from './AgentAdapter';
import { OPENCODE_ORDEWELL, OPENCODE_READ_TOOLS, OPENCODE_SEARCH_PROVIDER } from './openCodeOrdewell';
import { PermissionLedger, type LedgerStance, type RaisedRequest } from './permissionLedger';
import { ReplyRuns } from './replyRuns';
import { settleWithin } from './settleWithin';
import type { CallUsage } from './usageBuilder';

/**
 * The HTTP protocol work OpenCode's two server APIs share: 1.x (`/event`,
 * {@link OpenCodeAdapter}) and 2.x (`/api/event`, {@link OpenCodeV2}). The
 * event names and shapes differ between them; how a turn is streamed, how a
 * permission request is answered, how a child session is tied to the call
 * that spawned it and how a turn is settled do not. Each version reads its
 * own frames and hands what they mean to the pieces here.
 */

/** How long each event-stream connection attempt can take. */
const STREAM_CONNECT_TIMEOUT_MS = 5000;

/**
 * How long an ordinary request to the server may take. Only a turn's own
 * POST is held open for the turn, and it opts out; anything else is a quick
 * read or write, and a server that never answers one would hold the start, the
 * attach check or an interrupt for undici's 300s header timeout.
 */
export const REQUEST_TIMEOUT_MS = 30000;

/**
 * `signal` joined with a deadline of `timeoutMs`; null leaves the request
 * undated. The deadline aborts with an error that names itself, which is what
 * a failed request reports. `clear` drops the timer once the headers are in.
 */
export function withDeadline(signal: AbortSignal | undefined, timeoutMs: number | null): { signal: AbortSignal | undefined; clear(): void } {
  if (timeoutMs === null) return { signal, clear: () => {} };
  const controller = new AbortController();
  const follow = () => controller.abort(signal?.reason);
  if (signal?.aborted) follow();
  else signal?.addEventListener('abort', follow, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`OpenCode did not answer within ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

type OnEvent = (event: AgentEvent) => void;

/**
 * OpenCode's own tools and permission kinds. Anything else a planner is asked
 * about is a tool of a configured MCP server only when its name starts with a
 * server OpenCode reported: a built-in added in a later release must never be
 * mistaken for an MCP tool a person could approve.
 */
const OPENCODE_BUILTINS = new Set([
  'bash', 'edit', 'write', 'patch', 'apply_patch', 'multiedit', 'read', 'glob', 'grep', 'list', 'lsp', 'task',
  'question', 'todowrite', 'todoread', 'skill', 'websearch', 'codesearch', 'webfetch', 'external_directory',
  'doom_loop', 'invalid', 'batch',
  'shell', 'subagent', 'browser', 'execute', 'search', 'opencode_read_mcp_resource', 'opencode_list_mcp_resources',
]);

/**
 * What a planner's OpenCode permission request is for (ADR-0026). `servers`
 * are the MCP servers `/mcp` lists. `nativeShell` is on only where the
 * opt-in put the launcher around this server's shell (ADR-0036 N2): then a
 * `bash` or `shell` request is the user's grant being exercised, not an
 * unknown tool. `readsAsk` is on where the planner read limit made the read
 * tools ask (ADR-0068): then such a request is a read to count.
 */
export function openCodePlannerAsk(
  permission: string,
  details: { metadata?: Record<string, unknown>; patterns?: readonly string[] },
  servers: readonly string[],
  nativeShell = false,
  readsAsk = false,
): PlannerAsk {
  const meta = details.metadata ?? {};
  const pattern = details.patterns?.[0];
  if (readsAsk && OPENCODE_READ_TOOLS.includes(permission)) {
    return { kind: 'native-read', tool: permission, ...(pattern ? { pattern } : {}) };
  }
  if (nativeShell && (permission === 'bash' || permission === 'shell')) {
    return { kind: 'native-shell', tool: permission, ...(pattern ? { command: pattern } : {}) };
  }
  // `webfetch` is denied in the planner's policy and never asks, so it is left to `other`.
  if (permission === 'websearch' || permission === 'codesearch') {
    const query = typeof meta.query === 'string' ? meta.query : pattern;
    return query ? { kind: 'search', query, ...OPENCODE_SEARCH_PROVIDER } : { kind: 'other' };
  }
  if (permission === 'external_directory') {
    if (typeof meta.filepath === 'string') return { kind: 'path', path: meta.filepath, directory: false };
    const dir = typeof meta.parentDir === 'string' ? meta.parentDir : pattern?.replace(/[\\/]\*$/, '');
    return dir ? { kind: 'path', path: dir, directory: true } : { kind: 'other' };
  }
  if (OPENCODE_BUILTINS.has(permission)) return { kind: 'other' };
  const server = servers.filter((s) => permission.startsWith(`${s}_`)).sort((a, b) => b.length - a.length)[0];
  if (!server) return { kind: 'other' };
  return { kind: 'mcp', scope: permission, tool: permission.slice(server.length + 1), server };
}

/** A planner's system prompt and, when it has the Ordewell server, where its web reads go (ADR-0027). */
export function plannerSystem(opts: Pick<PlannerStartOptions, 'systemPrompt' | 'mcp'>, ownSearch = true): { system?: string } {
  const system = [opts.systemPrompt, opts.mcp ? OPENCODE_ORDEWELL.plannerInstructions(ownSearch) : ''].filter(Boolean).join('\n\n');
  return system ? { system } : {};
}

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
 * Any title but OpenCode's placeholder one stops it naming the session itself.
 * It would do that with a call of its own: the whole first prompt, to the
 * provider's small model (a gpt-luna, gemini or haiku outside the model the
 * user chose), billed outside every step the usage here counts. 1.x names a
 * session the same way, from its first prompt, while its title is still the
 * placeholder.
 */
export const SESSION_TITLE = { planner: 'Ordewell planner', task: 'Ordewell task' } as const;

/**
 * One model call's usage, in a usage record's terms. OpenCode's `input` counts
 * only the uncached prompt — cache reads and writes sit beside it, as with Anthropic
 * ({@link partedPromptUsage}): in the recordings `tokens.total` is input +
 * output + both cache counts. Its `output` excludes `reasoning` (a recorded
 * reply with text reports output 0 beside reasoning 127), and reasoning is
 * billed as output, so it is counted as output. The main thread's context is
 * all five counts, as OpenCode sums a step's tokens against the model's
 * context limit itself (`input + output + reasoning + cache.read +
 * cache.write`, read in the 2.0.32 binary) — so the prompt and output here.
 */
export function openCodeCall(tokens: OpenCodeTokens | undefined, call: { model?: string; cost?: number; subagentId?: string; purpose?: string }): CallUsage | undefined {
  if (!tokens) return undefined;
  const prompt = partedPromptUsage({ uncached: tokens.input, cacheRead: tokens.cache?.read, cacheWrite: tokens.cache?.write });
  const outputTokens = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  return {
    ...prompt,
    outputTokens,
    contextTokens: (prompt.inputTokens ?? 0) + outputTokens,
    ...(call.model ? { model: call.model } : {}),
    // OpenCode prices a call itself, from its model catalog: an estimate.
    ...(typeof call.cost === 'number' ? { cost: { amount: call.cost, kind: 'estimate' as const } } : {}),
    ...(call.subagentId ? { subagentId: call.subagentId } : {}),
    ...(call.purpose ? { purpose: call.purpose } : {}),
  };
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

/** What answering an OpenCode request takes: its id, and the session that asked, which the older reply path names. */
export interface OpenCodeAskHandle {
  id: string;
  sessionId: string;
}

/** A session's permission requests (ADR-0026), answered through `reply`. */
export function openCodePermissions(
  reply: (id: string, sessionId: string, decision: ApprovalDecision) => Promise<void>,
  stance: () => LedgerStance,
): PermissionLedger<OpenCodeAskHandle> {
  return new PermissionLedger(({ id, sessionId }, decision) => reply(id, sessionId, decision), stance);
}

/**
 * OpenCode blocks the turn on every request until it is answered, and can
 * send one twice in a turn; it is raised once, and never dropped.
 */
export function raiseOnce(
  permissions: PermissionLedger<OpenCodeAskHandle>,
  request: RaisedRequest,
  sessionId: string,
  seen: Set<string>,
  onEvent: OnEvent,
): void {
  if (seen.has(`perm:${request.id}`)) return;
  seen.add(`perm:${request.id}`);
  permissions.raise(request, { id: request.id, sessionId }, onEvent);
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
}

/** What one turn has learned from the stream, as far as both versions share it. */
export interface StreamTurn<F> {
  seen: Set<string>;
  /** The reply's runs, each under its text part's id. */
  text: ReplyRuns;
  children: ChildSessions<F>;
}

export function streamTurn<F>(): StreamTurn<F> {
  return { seen: new Set(), text: new ReplyRuns(), children: new ChildSessions<F>() };
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
  /** The turn's {@link EventStream.failed}. */
  streamFailed: Promise<never>;
  exitMessage(): string;
  /** Runs once the turn has ended on its own, before {@link readBack}, while the stream is still open to frames that trail the end. */
  drain?(): Promise<void>;
  /** Whatever of the turn's own messages the stream missed. */
  readBack(): Promise<void>;
  permissions: PermissionLedger<OpenCodeAskHandle>;
  /** The event that ends a turn that ran to its end. */
  outcome(): AgentEvent;
}

/**
 * Wait out a posted turn, then settle it: what the stream missed, the requests
 * left open, and how it ended. A server that exits first fails the turn; a
 * frame handler that throws rejects it with that error. False when the
 * caller's signal aborted it, which the caller answers by disposing of the
 * server.
 */
export async function settleTurn(turn: TurnLatch, how: TurnSettlement, onEvent: OnEvent): Promise<boolean> {
  const { signal } = how;
  let onAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    if (signal?.aborted) resolve();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([turn.ended, aborted, how.processEnded, how.streamFailed]);
  } catch (err) {
    how.permissions.endTurn(onEvent);
    throw err;
  } finally {
    // A signal reused across turns would otherwise gather one listener per turn.
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) return false;
  if (!turn.done) {
    onEvent({ type: 'error', message: how.exitMessage() });
    return true;
  }
  await how.drain?.();
  await how.readBack();
  how.permissions.endTurn(onEvent);
  onEvent(how.outcome());
  return true;
}

/** Whether a posted interrupt is acknowledged: the turn ends before the server does and before `timeoutMs`. */
export async function interruptAcknowledged(turn: TurnLatch, processEnded: Promise<void>, timeoutMs: number): Promise<boolean> {
  return settleWithin(turn.ended.then(() => true), { timeoutMs, ended: processEnded, onTimeout: () => false, onEnded: () => false });
}

/** One turn's event stream, open. */
export interface EventStream {
  /**
   * Rejects after one failed reconnect, or with what a frame handler threw;
   * never resolves. The stream is dead from then on, and it is the only
   * channel permission requests arrive on: a turn still waiting on its server would wait on a request nobody
   * sees, so it fails instead, as a stdio adapter's turn does.
   */
  readonly failed: Promise<never>;
  /** Whether {@link failed} has rejected. */
  readonly broken: boolean;
  /** Ends the stream; rejects, as {@link failed} does, if a handler threw. */
  close(): Promise<void>;
}

/**
 * Open the event stream for one turn and wait until it is connected. The
 * stream stopped being best-effort the moment permission answers moved onto
 * it: a request raised before we connect is one nobody answers, and the turn
 * hangs on it. A lost connection is retried once; a second loss fails the
 * turn rather than leaving it blocked on an unseen request.
 */
export async function openEventStream<F>(
  connect: (signal: AbortSignal) => Promise<Response | null>,
  onFrame: (frame: F) => void,
  onActivity?: () => void,
): Promise<EventStream> {
  const streamAbort = new AbortController();
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => { connected = resolve; });
  let fail!: (err: unknown) => void;
  const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
  // Heard by whoever races it; a turn that ended first never does.
  failed.catch(() => {});
  // A handler failure belongs to Ordewell; reconnecting cannot repair it.
  let handlerError: unknown;
  const live = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const attemptAbort = new AbortController();
      const abortAttempt = () => attemptAbort.abort();
      streamAbort.signal.addEventListener('abort', abortAttempt, { once: true });
      const stopped = new Promise<void>((resolve) => attemptAbort.signal.addEventListener('abort', () => resolve(), { once: true }));
      try {
        await streamEvents((signal) => settleWithin(connect(signal), {
          timeoutMs: STREAM_CONNECT_TIMEOUT_MS, ended: stopped,
          onTimeout: () => { throw new EventStreamLostError(); }, onEnded: () => null,
        }), attemptAbort.signal, onFrame, connected, onActivity);
        return;
      } catch (err) {
        if (streamAbort.signal.aborted && err instanceof EventStreamLostError) return;
        if (err instanceof EventStreamLostError && attempt === 0) continue;
        handlerError = err;
        fail(err);
        connected();
        return;
      } finally {
        streamAbort.signal.removeEventListener('abort', abortAttempt);
        attemptAbort.abort();
      }
    }
  })();
  await ready;
  return {
    failed,
    get broken() { return handlerError !== undefined; },
    close: async () => {
      streamAbort.abort();
      await live;
      if (handlerError !== undefined) throw handlerError;
    },
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
  const response = await connect(signal).catch(() => { throw new EventStreamLostError(); });
  if (signal.aborted) return;
  const body = response?.body;
  if (response?.status !== 200 || !body) throw new EventStreamLostError();
  onConnected();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lines = new LineBuffer();
  for (;;) {
    const { done, value } = await reader.read().catch(() => { throw new EventStreamLostError(); });
    if (signal.aborted) return;
    if (done) throw new EventStreamLostError();
    // Any bytes at all mean the server is still talking, independent of
    // whether this chunk resolves into an event that is forwarded — the same
    // gap that made Claude Code's watchdog false-positive on filtered
    // subagent output, closed here before it can recur.
    onActivity?.();
    lines.push(decoder.decode(value, { stream: true }), (line) => {
      if (!line.startsWith('data:')) return;
      let frame: F;
      try {
        frame = JSON.parse(line.slice(5).trim()) as F;
      } catch {
        // A partial or unrecognized frame costs one event, not the turn.
        return;
      }
      // Outside the try: a throw here is the handler's, not the frame's, and
      // must reach {@link openEventStream} as such.
      onFrame(frame);
    });
  }
}

export class EventStreamLostError extends Error {
  constructor() { super("The OpenCode runner's event stream was lost."); }
}
