import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { AgentEvent, PlannerStartOptions, TaskStartOptions } from './AgentAdapter';
import { OPENCODE_ORDEWELL, type OpenCodeSessionRule as SessionRule } from './openCodeOrdewell';
import { hunksOf } from './fileDiff';
import {
  OpenCodePermissions, autoApproves, delay, interruptAcknowledged, openEventStream, permissionReply, settleTurn, splitModelId, streamTurn,
  turnLatch, usageRecord, type OpenCodeTokens, type PermissionRequest, type StreamTurn, type TurnLatch,
} from './openCodeTransport';
/** A turn's end is also read from `/api/session/active`, behind the stream, which can drop a frame. */
const ACTIVE_POLL_INTERVAL_MS = 1000;
/** Polls that find the session inactive before any frame of this turn arrived, after which it is taken as already over. */
const IDLE_POLLS_BEFORE_START = 3;

/**
 * Asked of the planner's session, which nobody is watching. `question` blocks
 * the turn on an answer that cannot come; a denied request makes the model say
 * so in text. `edit` is the write tools, withheld for the reason ADR-0009 gives
 * for the plan agent alone not being the guarantee.
 */
const PLANNER_RULES: SessionRule[] = [
  { action: 'question', resource: '*', effect: 'deny' },
  { action: 'edit', resource: '*', effect: 'deny' },
];
/** A task asks its user in plain text for now, through its runner session. */
const TASK_RULES: SessionRule[] = [{ action: 'question', resource: '*', effect: 'deny' }];

interface V2Model {
  id: string;
  providerID: string;
  variant?: string;
}

interface V2ToolContent {
  type?: string;
  text?: string;
}

/** One `/api/event` frame, narrowed to the fields read here. */
interface V2Frame {
  type?: string;
  data?: {
    sessionID?: string;
    parentID?: string;
    assistantMessageID?: string;
    ordinal?: number;
    delta?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    content?: V2ToolContent[];
    error?: { type?: string; message?: string };
    model?: { id?: string; providerID?: string };
    cost?: number;
    tokens?: OpenCodeTokens;
    requestID?: string;
    action?: string;
    resources?: string[];
    save?: string[];
    source?: { type?: string; messageID?: string; id?: string };
    /** On a delegating call's progress, the child session it runs; on a file edit's success, the diff of each file it changed. */
    metadata?: { sessionID?: string; status?: string; files?: unknown };
  };
}

interface V2Message {
  id?: string;
  type?: string;
  outcome?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** What the adapter that owns the server lends this module. */
export interface OpenCodeV2Host {
  request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response>;
  /** A request whose body is the answer or throws, as `request` + status check. */
  json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T | null>;
  /** The server's event stream, as `data:` frames. */
  openEvents(signal: AbortSignal): Promise<Response | null>;
  /** Resolves when the server process is gone. */
  processEnded: Promise<void>;
  isExited(): boolean;
  exitMessage(): string;
}

interface TurnState extends StreamTurn<V2Frame> {
  /** Tool call id → tool name, from `session.tool.input.started`; `tool.called` carries no name. */
  toolNames: Map<string, string>;
  /** Assistant message id → the model that ran it, from `session.step.started`. */
  stepModels: Map<string, string>;
  /** A delegation call's own id and its brief, remembered so `subagent_started` can name it. */
  briefs: Map<string, string>;
  /** Assistant messages whose text the stream delivered, so a read-back does not repeat them. */
  streamedMessages: Set<string>;
}

interface Turn extends TurnLatch {
  outcome: 'succeeded' | 'failed' | 'interrupted' | null;
  failure: string | null;
}

function newTurnState(): TurnState {
  return { ...streamTurn<V2Frame>(), toolNames: new Map(), stepModels: new Map(), briefs: new Map(), streamedMessages: new Set() };
}

function contentText(content: V2ToolContent[] | undefined): string {
  return (content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

/** The subagent's report without the `<subagent …>` envelope the delegating tool wraps it in. */
function subagentDigest(output: string): string {
  const inner = output.match(/<subagent[^>]*>\n?([\s\S]*?)\n?<\/subagent>/);
  return inner ? inner[1] : output;
}

/**
 * What a file edit changed, beside the text the model reads ("Edited sum.js
 * (1 replacement)"): the hunks of each file diff its result carries, in the
 * shape {@link OpenCodeAdapter} gives 1.x's. A write's result carries none, so
 * it keeps its text.
 */
function editDiff(metadata: NonNullable<V2Frame['data']>['metadata']): string {
  const files = metadata?.files;
  if (!Array.isArray(files)) return '';
  const patches = (files as unknown[]).flatMap((file) => {
    const patch = typeof file === 'object' && file !== null ? (file as { patch?: unknown }).patch : undefined;
    return typeof patch === 'string' && patch ? [patch] : [];
  });
  return patches.length ? hunksOf(patches.join('\n')) : '';
}

/**
 * OpenCode's 2.x server (`opencode serve`, the `/api` surface), as a planner
 * or a task runner. The 1.x surface it replaced is {@link OpenCodeAdapter}'s own.
 *
 * What differs, and why this is a module of its own: a session carries its
 * model, agent and permission rules rather than each message, a prompt is
 * always queued and returns at once, and a turn ends on a `session.execution.*`
 * frame — so planner and task turns read the same way, from the stream with
 * `/api/session/active` behind it.
 */
export class OpenCodeV2 {
  private sessionId: string | null = null;
  private model: V2Model | null = null;
  private agent: string;
  private turn: Turn | null = null;
  private interruptRequested = false;
  private readonly permissions = new OpenCodePermissions(
    (id, sessionId, decision) => this.replyPermission(id, sessionId, decision),
    () => this.opts.mcp,
  );

  constructor(
    private host: OpenCodeV2Host,
    private opts: PlannerStartOptions | TaskStartOptions,
    private role: 'planner' | 'task',
  ) {
    this.agent = opts.kind === 'task' ? opts.flags.permissionMode : 'plan';
    const split = opts.model ? splitModelId(opts.model) : null;
    const variant = opts.kind === 'task' ? opts.flags.effort : opts.effort;
    if (split) this.model = { providerID: split.providerID, id: split.modelID, ...(variant ? { variant } : {}) };
  }

  nativeSessionId(): string | null { return this.sessionId; }

  async start(): Promise<void> {
    const resume = this.opts.resumeSessionId;
    if (resume) {
      // A resume id names a session on disk, not on this process — so it is checked rather than trusted.
      const existing = await this.host.json<{ data?: { id?: string } }>('GET', `/api/session/${resume}`).catch(() => null);
      if (existing?.data?.id) {
        this.sessionId = existing.data.id;
        // The session keeps the model and agent it last ran with, which the plan may have changed since.
        if (this.model) await this.host.request('POST', `/api/session/${this.sessionId}/model`, { model: this.model }).catch(() => undefined);
        await this.host.request('POST', `/api/session/${this.sessionId}/agent`, { agent: this.agent }).catch(() => undefined);
        await this.applyInstructions();
        return;
      }
      // A stale planner session degrades to a fresh one, which the caller reseeds from Ordewell's own
      // transcript. A task's continue without its session would run against none of the work it continues.
      if (this.opts.kind === 'task') throw new Error(`OpenCode could not resume session ${resume}: the server does not know it.`);
    }
    const created = await this.host.json<{ data?: { id?: string } }>('POST', '/api/session', {
      agent: this.agent,
      ...(this.model ? { model: this.model } : {}),
      permissions: [...(this.role === 'planner' ? PLANNER_RULES : TASK_RULES), ...this.ordewellRules()],
    });
    if (!created?.data?.id) throw new Error(`The OpenCode ${this.role} server did not return a session id.`);
    this.sessionId = created.data.id;
    await this.applyInstructions();
  }

  /** Allow the Ordewell server's tools, so a call never waits on a person (ADR-0022, S3). */
  private ordewellRules(): SessionRule[] {
    return this.opts.mcp ? OPENCODE_ORDEWELL.sessionRules() : [];
  }

  /** The planner's system prompt rides on the session as an instruction entry — a prompt has no system field. */
  private async applyInstructions(): Promise<void> {
    if (this.opts.kind !== 'planner' || !this.opts.systemPrompt) return;
    const response = await this.host.request('PUT', `/api/experimental/session/${this.sessionId}/instructions/entries/ordewell-planner`, { value: this.opts.systemPrompt });
    if (!response.ok) throw new Error(`OpenCode did not take the planner instructions: ${response.status} ${response.statusText}`);
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    if (!this.sessionId) throw new Error(`OpenCode ${this.role} session is not started`);
    if (this.host.isExited()) {
      onEvent({ type: 'error', message: this.host.exitMessage() });
      return;
    }
    const state = newTurnState();
    this.interruptRequested = false;
    const turn: Turn = Object.assign(turnLatch(), { outcome: null, failure: null });
    this.turn = turn;
    const closeStream = await this.openStream(state, turn, onEvent, onActivity);
    const poll = new AbortController();

    try {
      try {
        await this.host.json('POST', `/api/session/${this.sessionId}/prompt`, { text: message }, signal);
      } catch (err) {
        if (signal?.aborted) return;
        onEvent({ type: 'error', message: `OpenCode did not take the message: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }

      void this.pollActive(turn, poll.signal);
      // An aborted turn is left to the owning adapter, which disposes of the server.
      await settleTurn(turn, {
        signal,
        processEnded: this.host.processEnded,
        exitMessage: () => this.host.exitMessage(),
        readBack: () => this.readBack(state, onEvent),
        permissions: this.permissions,
        outcome: () => {
          if (turn.outcome === 'interrupted' || this.interruptRequested) return { type: 'turn_end', interrupted: true };
          if (turn.outcome === 'failed') return { type: 'error', message: turn.failure ?? 'OpenCode reported that the turn failed.' };
          return { type: 'turn_end' };
        },
      }, onEvent);
    } finally {
      this.turn = null;
      poll.abort();
      await closeStream();
    }
  }

  /**
   * The stream can drop the end frame while still delivering the rest, so the
   * turn also asks which sessions are running. A session that is not, after
   * this turn's work was seen, is over; one never seen working after a few
   * polls had already finished before the stream connected.
   */
  private async pollActive(turn: Turn, signal: AbortSignal): Promise<void> {
    let idlePolls = 0;
    while (!turn.done && !signal.aborted) {
      await delay(ACTIVE_POLL_INTERVAL_MS, signal);
      if (turn.done || signal.aborted) return;
      const active = await this.host.json<{ data?: Record<string, unknown> }>('GET', '/api/session/active').catch(() => null);
      if (!active?.data) continue;
      if (this.sessionId && this.sessionId in active.data) {
        turn.live = true;
        idlePolls = 0;
        continue;
      }
      idlePolls++;
      if (turn.live || idlePolls >= IDLE_POLLS_BEFORE_START) {
        // The idle message at the end of the session says how it ended.
        const messages = await this.messages();
        const idle = [...(messages ?? [])].reverse().find((m) => m.type === 'idle');
        if (idle?.outcome === 'failed' || idle?.outcome === 'interrupted' || idle?.outcome === 'succeeded') turn.outcome ??= idle.outcome;
        turn.outcome ??= 'succeeded';
        if (!turn.done) turn.finish();
      }
    }
  }

  private async messages(): Promise<V2Message[] | null> {
    const response = await this.host.json<{ data?: V2Message[] }>('GET', `/api/session/${this.sessionId}/message`).catch(() => null);
    return Array.isArray(response?.data) ? response.data : null;
  }

  /**
   * Whatever of the turn's own replies the stream missed. A message whose text
   * the stream delivered adds nothing here; one that lost its text frames still
   * reaches the plain-text channel, which a summary falls back to.
   */
  private async readBack(state: TurnState, onEvent: (e: AgentEvent) => void): Promise<void> {
    const messages = await this.messages();
    if (!messages) return;
    // The server lists newest first, so this turn's own replies are the ones before the latest user message.
    const latestUser = messages.findIndex((m) => m.type === 'user');
    const own = latestUser < 0 ? messages : messages.slice(0, latestUser);
    for (const message of [...own].reverse()) {
      if (message.type !== 'assistant' || !message.id || state.streamedMessages.has(message.id)) continue;
      (message.content ?? []).forEach((part, index) => {
        if (part.type === 'text' && part.text) state.text.complete(`${message.id}:readback:${index}`, part.text, onEvent);
      });
    }
  }

  /**
   * Abort the running turn, keeping the server and its session. OpenCode
   * acknowledges with `session.execution.interrupted`, which also ends the turn.
   */
  async interrupt(timeoutMs: number): Promise<boolean> {
    if (!this.sessionId || this.host.isExited()) return false;
    const turn = this.turn;
    this.interruptRequested = true;
    const response = await this.host.json<{ interrupted?: boolean }>('POST', `/api/session/${this.sessionId}/interrupt`).catch(() => null);
    if (!response) return false;
    if (!turn || turn.done) return true;
    return interruptAcknowledged(turn, this.host.processEnded, timeoutMs);
  }

  answerPermission(id: string, decision: ApprovalDecision): boolean {
    return this.permissions.answer(id, decision);
  }

  private async replyPermission(id: string, sessionId: string, decision: ApprovalDecision): Promise<void> {
    await this.host.request('POST', `/api/session/${sessionId}/permission/${id}/reply`, permissionReply(decision, 'decision'));
  }

  /** `/api/event` for one turn — see {@link openEventStream}. */
  private openStream(state: TurnState, turn: Turn, onEvent: (e: AgentEvent) => void, onActivity?: () => void): Promise<() => Promise<void>> {
    return openEventStream<V2Frame>((signal) => this.host.openEvents(signal), (frame) => this.onFrame(frame, state, turn, onEvent), onActivity);
  }

  /**
   * One frame. Only this session and its children are followed: the stream is
   * the whole server's, and another client's session is none of this turn's business.
   */
  private onFrame(frame: V2Frame, state: TurnState, turn: Turn, onEvent: (e: AgentEvent) => void): void {
    const data = frame.data;
    if (!data || !frame.type) return;
    if (frame.type === 'session.created') {
      if (data.parentID && data.parentID === this.sessionId && data.sessionID) state.children.created(data.sessionID);
      return;
    }
    const session = data.sessionID;
    if (!session) return;
    const isChild = session !== this.sessionId;
    if (isChild && !state.children.follows(session)) return;

    if (!isChild) {
      if (frame.type === 'session.execution.started') { turn.live = true; return; }
      if (frame.type === 'session.execution.succeeded' || frame.type === 'session.execution.failed' || frame.type === 'session.execution.interrupted') {
        if (!turn.live || turn.done) return;
        turn.outcome = frame.type === 'session.execution.succeeded' ? 'succeeded' : frame.type === 'session.execution.failed' ? 'failed' : 'interrupted';
        if (turn.outcome === 'failed') turn.failure = data.error?.message ?? data.error?.type ?? null;
        turn.finish();
        return;
      }
    }

    // Answered before anything waits on the delegating call naming its session: a subagent's
    // request blocks the turn exactly as the session's own does.
    if (frame.type === 'permission.asked') {
      this.onPermissionAsked(data, session, state, onEvent);
      return;
    }
    if (frame.type === 'permission.replied') {
      this.permissions.withdraw(data.requestID, onEvent);
      return;
    }

    let subagentId: string | undefined;
    if (isChild) {
      const owner = state.children.claim(session, frame);
      if (!owner) return;
      subagentId = owner;
    }
    this.onContentFrame(frame, data, state, turn, onEvent, subagentId);
  }

  private onContentFrame(frame: V2Frame, data: NonNullable<V2Frame['data']>, state: TurnState, turn: Turn, onEvent: (e: AgentEvent) => void, subagentId?: string): void {
    const message = data.assistantMessageID ?? '';
    switch (frame.type) {
      case 'session.step.started':
        if (message && data.model?.providerID && data.model.id) state.stepModels.set(message, `${data.model.providerID}/${data.model.id}`);
        return;
      case 'session.reasoning.delta':
        if (data.delta) onEvent({ type: 'thinking_delta', text: data.delta, subagentId });
        return;
      case 'session.reasoning.ended': {
        const key = `reasoning:${message}:${data.ordinal ?? 0}`;
        if (!data.text || state.seen.has(key)) return;
        state.seen.add(key);
        onEvent({ type: 'thinking', text: data.text, subagentId });
        return;
      }
      case 'session.text.delta':
        // A subagent's text is its report to its caller, not the reply; the delegating call's result carries it.
        if (!subagentId && data.delta) state.text.delta(`${message}:${data.ordinal ?? 0}`, data.delta, onEvent);
        return;
      case 'session.text.ended':
        if (subagentId || !data.text) return;
        if (message) state.streamedMessages.add(message);
        state.text.complete(`${message}:${data.ordinal ?? 0}`, data.text, onEvent);
        return;
      case 'session.tool.input.started':
        if (data.id && data.name) state.toolNames.set(data.id, data.name);
        return;
      case 'session.tool.called': {
        const id = data.id;
        if (!id || state.seen.has(`call:${id}`)) return;
        state.seen.add(`call:${id}`);
        const input = data.input ?? {};
        const name = state.toolNames.get(id) ?? 'tool';
        const brief = typeof input.description === 'string' ? input.description : typeof input.prompt === 'string' ? input.prompt : '';
        state.briefs.set(id, brief);
        onEvent({ type: 'tool_call', id, name, args: input, subagentId });
        return;
      }
      case 'session.tool.progress':
        // A delegating call names the child session it runs once that exists, which is what ties the child's frames to it.
        if (!subagentId) this.adoptChild(data, state, onEvent, turn);
        return;
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = data.id;
        if (!id || state.seen.has(`result:${id}`)) return;
        state.seen.add(`result:${id}`);
        const success = frame.type === 'session.tool.success';
        const output = success ? editDiff(data.metadata) || contentText(data.content) : data.error?.message ?? data.error?.type ?? '';
        onEvent({ type: 'tool_result', id, name: state.toolNames.get(id) ?? 'tool', output, success, subagentId });
        if (!subagentId) this.finishChild(id, success, output, state, onEvent);
        return;
      }
      case 'session.step.ended':
      case 'session.step.failed':
        this.countUsage(data, state, onEvent, subagentId);
        return;
      default:
    }
  }

  private adoptChild(data: NonNullable<V2Frame['data']>, state: TurnState, onEvent: (e: AgentEvent) => void, turn: Turn): void {
    const child = data.metadata?.sessionID;
    const callId = data.id;
    const held = child && callId ? state.children.adopt(child, callId) : null;
    if (!held || !callId) return;
    const model = state.stepModels.get(data.assistantMessageID ?? '');
    onEvent({ type: 'subagent_started', subagentId: callId, brief: state.briefs.get(callId) ?? '', ...(model ? { model } : {}) });
    for (const frame of held) this.onFrame(frame, state, turn, onEvent);
  }

  private finishChild(callId: string, success: boolean, output: string, state: TurnState, onEvent: (e: AgentEvent) => void): void {
    if (!state.children.owns(callId)) return;
    onEvent({ type: 'subagent_finished', subagentId: callId, outcome: success ? 'done' : 'failed', digest: subagentDigest(output) });
  }

  /** One model call's usage, once, when its step ends. Zeros mean the call failed before the provider answered. */
  private countUsage(data: NonNullable<V2Frame['data']>, state: TurnState, onEvent: (e: AgentEvent) => void, subagentId?: string): void {
    const message = data.assistantMessageID;
    if (!message || !data.tokens || state.seen.has(`usage:${message}`)) return;
    state.seen.add(`usage:${message}`);
    const record = usageRecord(data.tokens, { model: state.stepModels.get(message), cost: data.cost, subagentId });
    if (record) onEvent({ type: 'usage', record });
  }

  private permissionRequest(ask: NonNullable<V2Frame['data']>): PermissionRequest | null {
    const id = ask.id;
    if (!id) return null;
    const scope = (ask.resources ?? []).join(', ');
    return {
      type: 'permission_request',
      id,
      name: ask.action ?? 'permission',
      detail: JSON.stringify(scope ? { scope } : {}),
      input: ask.resources ? { resources: ask.resources } : {},
      // The patterns `always` would grant: the runner's own offer, and the only grounds for "Allow for this task".
      ...(ask.save?.length ? { suggestions: ask.save } : {}),
      ...(ask.source?.id ? { toolUseId: ask.source.id } : {}),
    };
  }

  /** A planner's request is refused; a task's is answered at once or left open for a card. */
  private onPermissionAsked(ask: NonNullable<V2Frame['data']>, session: string, state: TurnState, onEvent: (e: AgentEvent) => void): void {
    const request = this.permissionRequest(ask);
    if (!request) return;
    if (this.role !== 'task') this.permissions.refuse(request, session, state.seen, onEvent);
    else this.permissions.ask(request, session, this.opts.kind === 'task' && autoApproves(this.opts), state.seen, onEvent);
  }
}
