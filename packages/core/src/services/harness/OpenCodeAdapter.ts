import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { RunnerProcess } from './runnerProcess';
import { OpenCodeV2 } from './OpenCodeV2';
import { OPENCODE_ORDEWELL } from './openCodeOrdewell';
import { awaitAttach } from './ordewellBinding';
import type { McpClientConfig } from '../mcp';
import { hunksOf, markedLines } from './fileDiff';
import {
  OpenCodePermissions, PendingSteers, autoApproves, delay, interruptAcknowledged, newUserMessageId, openEventStream, permissionReply, settleTurn, splitModelId,
  streamTurn, turnLatch, usageRecord, type PermissionAnswer, type PermissionRequest, type StreamTurn, type TurnLatch,
} from './openCodeTransport';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, PlannerStartOptions, TaskModeAgentAdapter, TaskStartOptions } from './AgentAdapter';

const SERVER_READY_TIMEOUT_MS = 30000;
/** The banner is one short line; a longer unterminated one is not it, and is not kept growing. */
const BANNER_LINE_CHARS = 4000;
/** See {@link OpenCodeAdapter.recoverReply}. */
const RECOVERY_POLL_INTERVAL_MS = 2000;
const RECOVERY_TIMEOUT_MS = 900000;
/** How often a task turn reads `/session/status` itself — see {@link OpenCodeAdapter.pollStatus}. */
const STATUS_POLL_INTERVAL_MS = 1000;
/** The Basic-auth username `serve` defaults to. Set explicitly so a host's own `OPENCODE_SERVER_USERNAME` cannot win. */
const SERVER_USERNAME = 'opencode';
/** How long a planner waits for the Ordewell server to show as connected, and how often it asks. */
const MCP_ATTACH_TIMEOUT_MS = 10_000;
const MCP_STATUS_POLL_MS = 200;

/**
 * Tools withheld from a planning session (T1). `question` is the load-bearing
 * one: it blocks the turn on an answer from a user who is not watching, and the
 * message POST then never returns — an absent answer has to mean denial, not a
 * hung planner. The rest are the write tools, withheld for the same reason
 * {@link ClaudeCodeAdapter} names them despite its read-only mode: the
 * `plan` agent refuses them everywhere but its own plan files, and a future
 * default must not quietly hand the planner an edit.
 */
const DISABLED_TOOLS: Record<string, boolean> = {
  question: false,
  edit: false,
  write: false,
  apply_patch: false,
  todowrite: false,
};

/**
 * A task asks its user in plain text for now: the `question` tool blocks the
 * turn on an answer no surface can give yet. Nothing else is withheld — the
 * task's agent decides what it may do.
 */
const TASK_DISABLED_TOOLS: Record<string, boolean> = { question: false };

interface OpenCodePart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  messageID?: string;
  /** Set on a text or reasoning part once it is complete. */
  time?: { start?: number; end?: number };
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    /**
     * On a `task` call once its child session exists: that session's id and
     * the model it runs. On an `edit`, the unified diff it applied; on a
     * `write`, whether the file was there before.
     */
    metadata?: { sessionId?: string; model?: { providerID?: string; modelID?: string }; diff?: unknown; exists?: unknown };
  };
}

/** `permission.asked` (and its v2 spelling) — the only server→client request OpenCode makes. */
interface OpenCodePermissionAsk {
  id?: string;
  sessionID?: string;
  permission?: string;
  action?: string;
  patterns?: string[];
  resources?: string[];
  metadata?: Record<string, unknown>;
  /** The patterns an `always` reply grants for the rest of the server's life — the task's. */
  always?: string[];
  tool?: { messageID?: string; callID?: string };
}

/** OpenCode's errors are tagged unions: `{ name, data: { message } }`. */
interface OpenCodeError {
  name?: string;
  data?: { message?: string };
}

interface OpenCodeMessageInfo {
  id?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  error?: OpenCodeError;
  providerID?: string;
  modelID?: string;
  /** USD, as OpenCode prices the call. */
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
}

/** One `/event` frame, narrowed to the fields this adapter reads. */
interface OpenCodeEvent {
  type?: string;
  properties?: OpenCodePermissionAsk & {
    part?: OpenCodePart;
    info?: OpenCodeMessageInfo & { parentID?: string };
    /** `message.part.delta`: an append to one field of a part already announced. */
    messageID?: string;
    partID?: string;
    field?: string;
    delta?: string;
    /** `session.status`. */
    status?: { type?: string };
    /** `session.error`. */
    error?: OpenCodeError;
    /** `permission.replied`: the request that is no longer open. */
    requestID?: string;
  };
}

/**
 * What one turn has learned from `/event` so far. The stream names a part's
 * message but never its role, and a delta names neither its part's type nor
 * whether it belongs to the reply — so each is remembered from the frame that
 * announced it.
 */
interface TurnState extends StreamTurn<OpenCodeEvent> {
  /** Assistant message ids, from `message.updated`. A part of any other message is the user's own words. */
  assistantMessages: Set<string>;
  partTypes: Map<string, string>;
}

/**
 * When one task turn is over. `prompt_async` returns before the work starts,
 * so the end is read from the session going idle — the way OpenCode's own
 * `run` reads it (see {@link OpenCodeAdapter.sendTask}).
 */
interface TaskTurn extends TurnLatch {
  /** The user messages the server echoed back: storing the prompt is not the model working on it. */
  userMessages: Set<string>;
  /** `session.error` for the task's session, in OpenCode's own words. */
  failure: string | null;
  /** The newest assistant message's own error, cleared by a later message that has none. */
  messageError: string | null;
}

interface OpenCodeMessageResponse {
  parts?: OpenCodePart[];
  info?: OpenCodeMessageInfo;
  error?: { message?: string } | string;
}

/**
 * Flatten an error and its `cause` chain into one line. Node's `fetch` reports
 * every transport failure as the same bare `TypeError: fetch failed`; which
 * failure it was (a socket reset, a refused connect, undici's 300s header
 * timeout) lives only in `cause`, so a message without it names nothing.
 */
function describeError(err: unknown): string {
  const visited = new Set<unknown>();
  const lines: string[] = [];
  let current: unknown = err;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (!(current instanceof Error)) { lines.push(String(current)); break; }
    const code = (current as { code?: unknown }).code;
    const suffix = typeof code === 'string' && !current.message.includes(code) ? ` (${code})` : '';
    lines.push(`${current.message}${suffix}`);
    current = current.cause;
  }
  return lines.join(': ');
}

function permissionName(ask: OpenCodePermissionAsk): string {
  return ask.permission ?? ask.action ?? 'permission';
}

function permissionDetail(ask: OpenCodePermissionAsk): string {
  const scope = (ask.patterns ?? ask.resources ?? []).join(', ');
  return JSON.stringify({ ...(scope ? { scope } : {}), ...(ask.metadata ?? {}) });
}

function errorText(error: OpenCodeError): string {
  return error.data?.message || error.name || 'OpenCode reported an error.';
}

function flatModelId(providerID: string | undefined, modelID: string | undefined): string | undefined {
  return providerID && modelID ? `${providerID}/${modelID}` : undefined;
}

/** The subagent's report without the `<task>` envelope the tool wraps it in. */
function taskDigest(output: string): string {
  const inner = output.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/);
  return inner ? inner[1] : output;
}

/**
 * `read`/`write`/`edit` results come back wrapped in a `<path>`/`<type>`/`<content>`
 * envelope instead of plain text (unlike `bash`'s stdout), so the row's `⎿`
 * preview would otherwise show those tags verbatim. A tool whose output has no
 * `<content>` tag — bash, glob, grep — is returned unchanged.
 */
function unwrapFileToolOutput(output: string): string {
  const inner = output.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
  return inner ? inner[1] : output;
}

/**
 * What a file edit changed, beside the text the model reads ("Edit applied
 * successfully."): an edit's hunks, or a new file's lines. A write over an
 * existing file reports no diff, so it keeps its text.
 */
function editDiff(tool: string, state: OpenCodePart['state']): string {
  const { diff, exists } = state?.metadata ?? {};
  if (typeof diff === 'string' && diff) return hunksOf(diff);
  const content = state?.input?.content;
  return tool === 'write' && exists === false && typeof content === 'string' ? markedLines(content, '+') : '';
}

function newTurnState(): TurnState {
  return { ...streamTurn<OpenCodeEvent>(), assistantMessages: new Set(), partTypes: new Map() };
}

/**
 * OpenCode as a planner or a task runner, over its headless HTTP server
 * (ADR-0009, ADR-0018).
 *
 * The odd one out: `opencode serve` is a real server rather than a stdio
 * protocol, so this adapter owns both halves of the boundary — it starts the
 * process as the same {@link RunnerProcess} every other adapter uses, then
 * talks to it through the injected `fetch`. Both are part of the one seam the
 * tests drive.
 *
 * A planner turn ends when the message POST resolves, and its response is the
 * authoritative copy of the reply's last message. Everything else — reply text
 * as it streams, earlier model calls' text and reasoning, per-call usage, the
 * subagents a `task` call runs — arrives only on the server's `/event` channel.
 * An event name that changes between OpenCode versions therefore costs that
 * detail, never the final reply. A task turn is posted asynchronously and read
 * entirely from the stream — see {@link sendTask}.
 */
export class OpenCodeAdapter implements TaskModeAgentAdapter {
  readonly agentId = 'opencode';

  private process: ChildProcess | null = null;
  private baseUrl: string | null = null;
  /** Sent on every request to a task's server, which a per-task password secures. */
  private authorization: string | null = null;
  private sessionId: string | null = null;
  private readonly runner: RunnerProcess;
  private disposed = false;
  private planner: PlannerStartOptions | null = null;
  private task: TaskStartOptions | null = null;
  /** The last assistant message already settled — the baseline {@link recoverReply} measures a new reply against. */
  private lastAssistantId: string | null = null;
  private taskTurn: TaskTurn | null = null;
  /** An abort was posted during the current task turn, so the idle that follows ends it as interrupted. */
  private interruptRequested = false;
  private readonly permissions = new OpenCodePermissions(
    (id, sessionId, decision) => this.replyPermission(id, sessionId, permissionReply(decision, 'reply')),
    () => this.ordewell,
  );
  /** Messages handed into the running task turn, until the model reads them (ADR-0023). Kept across turns: the server keeps the message too. */
  private readonly steers = new PendingSteers();
  /** Set once the server turns out to speak the 2.x API, which then owns the session. */
  private v2: OpenCodeV2 | null = null;
  /** The Ordewell server this process was configured with; null when none was given or its config could not be merged. */
  private ordewell: McpClientConfig | null = null;

  constructor(private deps: AgentProcessDeps) {
    this.runner = new RunnerProcess(deps);
  }

  private get processEnded(): Promise<void> { return this.runner.ended; }
  private get exited(): boolean { return this.runner.exit !== null; }

  async start(opts: AgentStartOptions): Promise<void> {
    try {
      await this.launch(opts);
    } catch (err) {
      // The server is already down; this clears what the adapter held for it.
      this.dispose();
      throw err;
    }
  }

  private async launch(opts: AgentStartOptions): Promise<void> {
    if (opts.kind === 'task') this.task = opts;
    else this.planner = opts;
    // A task's server edits the worktree, and `serve` without a password
    // takes orders from any local process. The password exists only in this
    // adapter and the server's environment, after the workspace's own
    // variables so none of them can replace it. A planner's gets one too:
    // 2.x answers every `/api` request without credentials with a 401, so a
    // server with no password cannot be spoken to at all.
    const password = randomBytes(24).toString('base64url');
    const command = () => ({
      command: 'opencode',
      args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      env: (workspaceEnv: Record<string, string>) => {
        // The token rides in the server's environment, not its argv (ADR-0022, A5).
        const ordewellConfig = opts.mcp ? OPENCODE_ORDEWELL.configContent(workspaceEnv.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT, opts.mcp) : null;
        if (opts.mcp && ordewellConfig === null) {
          console.error('[opencode] OPENCODE_CONFIG_CONTENT is not a JSON object, so the Ordewell tools were not injected.');
        }
        this.ordewell = ordewellConfig === null ? null : opts.mcp ?? null;
        return {
          ...(ordewellConfig === null ? {} : { OPENCODE_CONFIG_CONTENT: ordewellConfig }),
          OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
          OPENCODE_SERVER_PASSWORD: password,
        };
      },
    });
    await this.runner.start(opts.cwd, command, (child) => {
      this.process = child;
      this.authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString('base64')}`;
      return this.connect(opts, this.serverAddress());
    });
  }

  /**
   * Where `serve` listens, or null once it ends or gives up. Stdout only: that
   * is where `serve` prints its address, and stderr can carry another URL — a
   * warning about a provider it could not reach. Read a line at a time, and
   * only until the address is known.
   */
  private serverAddress(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let partial = '';
      const stopReading = this.runner.readStdout((text) => {
        const lines = (partial + text).split('\n');
        partial = lines.pop()!.slice(-BANNER_LINE_CHARS);
        for (const line of lines) {
          const match = line.match(/https?:\/\/[^\s]+/);
          if (match) return settle(match[0].replace(/[.,)]$/, ''));
        }
      });
      const timer = setTimeout(() => settle(null), SERVER_READY_TIMEOUT_MS);
      timer.unref?.();
      const settle = (url: string | null) => {
        stopReading();
        clearTimeout(timer);
        resolve(url);
      };
      void this.processEnded.then(() => settle(null));
    });
  }

  /** From the server's address to an open session — the 2.x API's, or a 1.x one created or resumed. */
  private async connect(opts: AgentStartOptions, address: Promise<string | null>): Promise<void> {
    this.baseUrl = await address;
    if (!this.baseUrl) {
      throw new Error(this.runner.withStderrTail(`The OpenCode ${this.role()} server did not start.`));
    }

    if (await this.speaksV2()) {
      this.v2 = new OpenCodeV2({
        request: (method, path, body, signal) => this.request(method, path, body, signal),
        json: (method, path, body, signal) => this.json(method, path, body, signal),
        openEvents: (signal) => this.deps.fetch(`${this.baseUrl}/api/event`, { signal, headers: this.headers() }),
        processEnded: this.processEnded,
        isExited: () => this.exited,
        exitMessage: () => this.exitMessage(),
      }, { ...opts, mcp: this.ordewell ?? undefined }, this.role());
      await this.v2.start();
      this.sessionId = this.v2.nativeSessionId();
      return;
    }

    // A resume id names a session on disk, not on this process — so it is
    // checked rather than trusted.
    if (opts.resumeSessionId) {
      const existing = await this.json<{ id?: string }>('GET', `/session/${opts.resumeSessionId}`).catch(() => null);
      if (existing?.id) {
        this.sessionId = existing.id;
        // A resumed session already holds assistant messages. Without a
        // baseline, a recovery poll would accept one of those as this turn's
        // reply, so the newest is claimed as already-seen before any turn runs.
        const history = await this.json<OpenCodeMessageResponse[]>('GET', `/session/${existing.id}/message`).catch(() => null);
        this.lastAssistantId = this.newestAssistantId(history);
        return;
      }
      // A stale planner session degrades to a fresh one (T4), which the
      // caller reseeds from Ordewell's own transcript. A task's continue
      // without its session would run the message against none of the work
      // it continues, so it fails instead.
      if (opts.kind === 'task') {
        throw new Error(`OpenCode could not resume session ${opts.resumeSessionId}: the server does not know it.`);
      }
    }
    const created = await this.json<{ id?: string }>('POST', '/session', {});
    if (!created?.id) throw new Error(`The OpenCode ${this.role()} server did not return a session id.`);
    this.sessionId = created.id;
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    if (!this.baseUrl || !this.sessionId) throw new Error(`OpenCode ${this.role()} session is not started`);
    if (this.exited) {
      onEvent({ type: 'error', message: this.exitMessage() });
      return;
    }
    if (this.v2) {
      await this.v2.send(message, onEvent, signal, onActivity);
      if (signal?.aborted) this.dispose();
      return;
    }
    if (this.task) return this.sendTask(this.task, message, onEvent, signal, onActivity);

    const turn = newTurnState();
    const closeStream = await this.openStream(turn, onEvent, onActivity);

    try {
      const model = this.planner?.model ? splitModelId(this.planner.model) : null;
      const body = {
        parts: [{ type: 'text', text: message }],
        // The read-only guarantee: OpenCode's own plan agent has no write tools.
        agent: 'plan',
        tools: DISABLED_TOOLS,
        ...(model ? { model } : {}),
        ...(this.planner?.effort ? { variant: this.planner.effort } : {}),
        ...(this.planner?.systemPrompt ? { system: this.planner.systemPrompt } : {}),
      };
      const reply = await this.json<OpenCodeMessageResponse>('POST', `/session/${this.sessionId}/message`, body, signal);

      if (signal?.aborted) { this.dispose(); return; }
      this.settle(reply, turn, onEvent);
    } catch (err) {
      if (signal?.aborted) { this.dispose(); return; }
      // The POST is the turn's transport, not its work: the server plans on
      // regardless of what happened to this socket. So a transport failure
      // reads the reply back out of the session rather than losing a turn the
      // server already finished (or is still finishing).
      const recovered = this.exited ? null : await this.recoverReply(signal, onActivity);
      if (recovered) { this.settle(recovered, turn, onEvent); return; }
      onEvent({ type: 'error', message: `The OpenCode planner turn failed: ${describeError(err)}` });
    } finally {
      await closeStream();
    }
  }

  /**
   * One task turn. `prompt_async` only queues the work, so the turn is over
   * when the session goes idle — OpenCode's own `run` rules: an idle frame
   * counts once `/session/status` confirms it, because a late idle can belong
   * to the turn before, and {@link pollStatus} stands behind the stream,
   * which can miss a status frame. No request is held open for the turn, so
   * fetch's 300s header timeout, the planner's reason for
   * {@link recoverReply}, never applies.
   */
  private async sendTask(
    task: TaskStartOptions,
    message: string,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
    onActivity?: () => void,
  ): Promise<void> {
    const state = newTurnState();
    this.interruptRequested = false;
    const turn: TaskTurn = Object.assign(turnLatch(), { userMessages: new Set<string>(), failure: null, messageError: null });
    this.taskTurn = turn;
    const closeStream = await this.openStream(state, onEvent, onActivity);
    const poll = new AbortController();

    try {
      try {
        await this.json('POST', `/session/${this.sessionId}/prompt_async`, this.taskPromptBody(task, message), signal);
      } catch (err) {
        if (signal?.aborted) { this.dispose(); return; }
        onEvent({ type: 'error', message: `OpenCode did not take the message: ${describeError(err)}` });
        return;
      }

      void this.pollStatus(turn, poll.signal);
      const settled = await settleTurn(turn, {
        signal,
        processEnded: this.processEnded,
        exitMessage: () => this.exitMessage(),
        readBack: () => this.readBack(state, onEvent),
        permissions: this.permissions,
        outcome: () => {
          const failure = turn.failure ?? turn.messageError;
          if (this.interruptRequested) return { type: 'turn_end', interrupted: true };
          return failure ? { type: 'error', message: failure } : { type: 'turn_end' };
        },
      }, onEvent);
      // A turn that ends with a message the model never read leaves it stored
      // server-side. Drop it so Ordewell re-sends it as the next turn (ADR-0023,
      // D4) and delete the stored copy so that re-send does not duplicate it.
      if (settled) this.dropUnreadSteers(onEvent);
      else this.dispose();
    } finally {
      this.steers.drain();
      this.taskTurn = null;
      poll.abort();
      await closeStream();
    }
  }

  /**
   * The prompt that carries a task message: the mode as the agent, the task
   * model and effort, and only `question` withheld. A steer names its own
   * `messageID` so the frames can be told apart from the first prompt's.
   */
  private taskPromptBody(task: TaskStartOptions, message: string, messageID?: string): Record<string, unknown> {
    const model = task.model ? splitModelId(task.model) : null;
    return {
      parts: [{ type: 'text', text: message }],
      // The manifest's meaning of the task's mode (ADR-0001): for OpenCode a mode is an agent.
      agent: task.flags.permissionMode,
      tools: TASK_DISABLED_TOOLS,
      ...(model ? { model } : {}),
      ...(task.flags.effort ? { variant: task.flags.effort } : {}),
      ...(messageID ? { messageID } : {}),
    };
  }

  /** Hand a message into the running task turn (ADR-0023, D2), naming it so its delivery is observable. */
  async steer(id: string, text: string): Promise<boolean> {
    const task = this.task;
    const turn = this.taskTurn;
    // 1.x's mid-turn path is the validated one (ADR-0023). 2.x has none yet, so
    // its adapter keeps the turn-end queue by refusing every steer.
    if (this.v2 || !task || !this.process || !this.sessionId || this.exited || !turn || turn.done || this.interruptRequested) return false;
    const messageID = newUserMessageId();
    this.steers.hand(messageID, id);
    const posted = await this.json('POST', `/session/${this.sessionId}/prompt_async`, this.taskPromptBody(task, text, messageID))
      .then(() => true, () => false);
    if (posted) return true;
    // The request failed. If the delivery still arrived, the model has it and
    // there is nothing to fall back to; otherwise the message stays queued.
    return !this.steers.forget(id);
  }

  /**
   * Messages handed over but unread when the turn ended. Each is deleted from
   * the session — so the next turn's re-send is not a duplicate — and reported
   * dropped, which is what puts it back in Ordewell's queue.
   */
  private dropUnreadSteers(onEvent: (event: AgentEvent) => void): void {
    for (const { messageId, id } of this.steers.drain()) {
      void this.json('DELETE', `/session/${this.sessionId}/message/${messageId}`).catch(() => { /* the next turn re-sends it either way */ });
      onEvent({ type: 'message_dropped', id });
    }
  }

  /**
   * Whatever of the turn's own messages the stream missed. Each part is
   * emitted once, so a turn the stream saw whole adds nothing here; one that
   * lost its last text part still reaches the plain-text channel, which a
   * summary falls back to.
   */
  private async readBack(turn: TurnState, onEvent: (e: AgentEvent) => void): Promise<void> {
    const messages = await this.json<OpenCodeMessageResponse[]>('GET', `/session/${this.sessionId}/message`).catch(() => null);
    if (!Array.isArray(messages)) return;
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.info?.role === 'user') { start = i + 1; break; }
    }
    for (const reply of messages.slice(start)) {
      const id = reply.info?.id;
      if (reply.info?.role !== 'assistant' || !id) continue;
      for (const part of reply.parts ?? []) {
        if (part.messageID === id) this.emitPart(part, turn, onEvent);
      }
      this.countUsage(reply.info, turn, onEvent);
    }
  }

  /**
   * The stream can drop a status frame while still delivering the rest, so a
   * task turn also reads the status itself. A busy session is this turn's own
   * work as surely as a frame is.
   */
  private async pollStatus(turn: TaskTurn, signal: AbortSignal): Promise<void> {
    while (!turn.done && !signal.aborted) {
      await delay(STATUS_POLL_INTERVAL_MS, signal);
      if (turn.done || signal.aborted) return;
      const busy = await this.sessionBusy();
      if (busy === true) turn.live = true;
      else if (busy === false && turn.live && !turn.done) turn.finish();
    }
  }

  /** An idle frame ends the turn only if the server agrees now. When it will not say, the frame is trusted, as upstream trusts it. */
  private async confirmIdle(turn: TaskTurn): Promise<void> {
    if (turn.done || !turn.live) return;
    if ((await this.sessionBusy()) !== true && !turn.done) turn.finish();
  }

  /** Whether the task's session is working, or null when the server will not say. A session absent from the map is idle. */
  private async sessionBusy(): Promise<boolean | null> {
    const statuses = await this.json<Record<string, { type?: string } | undefined>>('GET', '/session/status').catch(() => null);
    if (!statuses || typeof statuses !== 'object') return null;
    const type = statuses[this.sessionId ?? '']?.type;
    return type !== undefined && type !== 'idle';
  }

  /** What a frame of the task's own session says about the turn's end. */
  private followTaskTurn(frame: OpenCodeEvent, turn: TaskTurn, onEvent: (e: AgentEvent) => void): void {
    const props = frame.properties ?? {};
    if ((frame.type === 'session.status' && props.status?.type === 'idle') || frame.type === 'session.idle') {
      void this.confirmIdle(turn);
      return;
    }
    if (frame.type === 'message.updated' && props.info?.role === 'user') {
      if (props.info.id) turn.userMessages.add(props.info.id);
      return;
    }
    // An assistant message parented to a message a steer stored is the server's
    // account that the model read it (ADR-0023, OpenCode 1.x).
    if (frame.type === 'message.updated' && props.info?.role === 'assistant') {
      for (const id of this.steers.deliveredBy(props.info.parentID)) onEvent({ type: 'message_delivered', id });
    }
    // Only the model's work counts: the session is retitled and the prompt
    // stored before it is scheduled, and a poll in that gap reads "not busy".
    const partOf = frame.type === 'message.part.updated' || frame.type === 'message.part.delta'
      ? props.part?.messageID ?? props.messageID
      : undefined;
    const working =
      (frame.type === 'session.status' && props.status?.type !== undefined) ||
      (frame.type === 'message.updated' && props.info?.role === 'assistant') ||
      frame.type === 'session.error' ||
      (partOf !== undefined && !turn.userMessages.has(partOf));
    if (working) turn.live = true;
    if (frame.type === 'message.updated' && props.info?.role === 'assistant') {
      turn.messageError = props.info.error ? errorText(props.info.error) : null;
    } else if (frame.type === 'session.error' && props.error) {
      // An overflowing context is compacted and the turn carries on; when it
      // cannot be, the message itself carries the error.
      if (props.error.name !== 'ContextOverflowError') turn.failure = errorText(props.error);
      void this.confirmIdle(turn);
    }
  }

  /**
   * Abort the running turn, keeping the server and its session. OpenCode
   * acknowledges by going idle, which is also what ends the turn — as
   * interrupted, because the request is remembered.
   */
  async interrupt(timeoutMs: number): Promise<boolean> {
    if (!this.process || !this.sessionId || this.exited) return false;
    if (this.v2) return this.v2.interrupt(timeoutMs);
    const turn = this.taskTurn;
    this.interruptRequested = true;
    const posted = await this.json('POST', `/session/${this.sessionId}/abort`).then(() => true, () => false);
    if (!posted) return false;
    if (!turn || turn.done) return true;
    // Whatever the turn had shown so far, the idle after an abort is its end.
    turn.live = true;
    void this.confirmIdle(turn);
    return interruptAcknowledged(turn, this.processEnded, timeoutMs);
  }

  onProcessExit(listener: (code: number) => void): void {
    void this.processEnded.then(() => listener(this.runner.exitCode));
  }

  answerPermission(id: string, decision: ApprovalDecision): boolean {
    if (this.v2) return this.process ? this.v2.answerPermission(id, decision) : false;
    return this.process ? this.permissions.answer(id, decision) : false;
  }

  /**
   * OpenCode 2.x replaced the 1.x HTTP surface rather than extending it, and
   * only 2.x answers `/api/info` with its version. A 1.x server — or one that
   * answers with anything else — keeps the 1.x protocol this class speaks.
   */
  private async speaksV2(): Promise<boolean> {
    const info = await this.json<{ version?: unknown }>('GET', '/api/info').catch(() => null);
    return typeof info === 'object' && info !== null && typeof info.version === 'string';
  }

  private role(): 'planner' | 'task' {
    return this.task ? 'task' : 'planner';
  }

  /**
   * Turn one settled assistant message into events. The settled response is
   * authoritative: it names the assistant message, so its parts are the ones
   * that make up the reply. Parts already completed live are deduplicated;
   * anything the stream missed (including a stream that never connected)
   * arrives here.
   *
   * It is only the turn's *last* message, though. OpenCode writes one
   * assistant message per model call, so the calls before the final one —
   * their text, reasoning and usage — reach Ordewell over the stream or not at
   * all.
   */
  private settle(reply: OpenCodeMessageResponse | null, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    const failure = typeof reply?.error === 'string'
      ? reply.error
      : (reply?.error as { message?: string } | undefined)?.message ?? reply?.info?.error?.data?.message;
    if (failure) {
      onEvent({ type: 'error', message: failure });
      return;
    }
    const assistantId = reply?.info?.id;
    for (const part of reply?.parts ?? []) {
      if (part.type !== 'tool' && assistantId && part.messageID !== assistantId) continue;
      this.emitPart(part, turn, onEvent);
    }
    if (reply?.info) this.countUsage(reply.info, turn, onEvent);
    if (assistantId) this.lastAssistantId = assistantId;
    onEvent({ type: 'turn_end' });
  }

  /**
   * Poll the session for this turn's assistant message after the POST's socket
   * died under it. Node's global `fetch` is undici, which aborts a request
   * whose response headers have not arrived within 300s — and OpenCode sends
   * none until the turn is done, so any turn past five minutes fails as
   * `TypeError: fetch failed` while the server is still working. The message
   * exists server-side either way, so it is waited for and read back.
   *
   * A message that exists but has not completed is progress, not an answer:
   * it refreshes the watchdog and the poll continues.
   */
  private async recoverReply(signal: AbortSignal | undefined, onActivity?: () => void): Promise<OpenCodeMessageResponse | null> {
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    for (;;) {
      if (signal?.aborted || this.exited || this.disposed || !this.sessionId) return null;
      const messages = await this.json<OpenCodeMessageResponse[]>('GET', `/session/${this.sessionId}/message`).catch(() => null);
      const pending = Array.isArray(messages)
        ? [...messages].reverse().find((m) => m.info?.role === 'assistant' && m.info.id && m.info.id !== this.lastAssistantId)
        : undefined;
      if (pending?.info?.time?.completed || pending?.info?.error) return pending;
      if (pending) onActivity?.();
      if (Date.now() >= deadline) return null;
      await delay(RECOVERY_POLL_INTERVAL_MS, signal);
    }
  }

  private newestAssistantId(messages: OpenCodeMessageResponse[] | null): string | null {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info;
      if (info?.role === 'assistant' && info.id) return info.id;
    }
    return null;
  }

  /**
   * Emit one complete message part, once. OpenCode reports a tool part
   * repeatedly as it moves through pending → running → completed, so parts are
   * keyed by id and only the terminal state produces a result. A subagent's
   * text is its report to the planner, not the reply, so it is dropped; the
   * `task` call's result carries it.
   */
  private emitPart(part: OpenCodePart, turn: TurnState, onEvent: (e: AgentEvent) => void, subagentId?: string): void {
    if (!part?.type) return;
    const { seen } = turn;
    const id = part.id ?? part.callID ?? '';

    if (part.type === 'text' && part.text && !subagentId) {
      turn.text.complete(id, part.text, onEvent);
      return;
    }
    if (part.type === 'reasoning' && part.text) {
      if (seen.has(`reasoning:${id}`)) return;
      seen.add(`reasoning:${id}`);
      onEvent({ type: 'thinking', text: part.text, subagentId });
      return;
    }
    if (part.type !== 'tool') return;

    const callId = part.callID ?? id;
    const name = part.tool ?? 'tool';
    const status = part.state?.status;
    const input = part.state?.input;
    // A `pending` tool part carries no input yet, so announcing it there gave
    // every call an empty arg summary. Waiting for the first state that has
    // input costs a moment of liveness and buys a readable timeline.
    if (!seen.has(`call:${callId}`) && (status !== 'pending' || (input && Object.keys(input).length > 0))) {
      seen.add(`call:${callId}`);
      onEvent({ type: 'tool_call', id: callId, name, args: input ?? {}, subagentId });
    }
    if (name === 'task' && !subagentId) this.trackSubagent(part, callId, turn, onEvent);
    if ((status === 'completed' || status === 'error') && !seen.has(`result:${callId}`)) {
      seen.add(`result:${callId}`);
      onEvent({
        type: 'tool_result',
        id: callId,
        name,
        output: (status === 'completed' && editDiff(name, part.state)) || unwrapFileToolOutput(part.state?.output ?? part.state?.error ?? ''),
        success: status === 'completed',
        subagentId,
      });
    }
  }

  /**
   * A `task` call runs a subagent in a child session. The call's part names
   * that session once it exists, which is what ties the child's frames to the
   * call; the subagent ends when the call does. The part is restated at every
   * status change, and so is what it says here — the service reports each
   * start and finish once, and no finish for a call that never had a child.
   */
  private trackSubagent(part: OpenCodePart, callId: string, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    const state = part.state;
    const child = state?.metadata?.sessionId;
    const held = child ? turn.children.adopt(child, callId) : null;
    if (held) {
      const input = state?.input ?? {};
      const brief = typeof input.description === 'string' ? input.description : typeof input.prompt === 'string' ? input.prompt : '';
      const model = flatModelId(state?.metadata?.model?.providerID, state?.metadata?.model?.modelID);
      onEvent({ type: 'subagent_started', subagentId: callId, brief, ...(model ? { model } : {}) });
      for (const frame of held) this.onFrame(frame, turn, onEvent);
    }
    const status = state?.status;
    if (status === 'completed' || status === 'error') {
      onEvent({
        type: 'subagent_finished',
        subagentId: callId,
        outcome: status === 'completed' ? 'done' : 'failed',
        digest: taskDigest(state?.output ?? state?.error ?? ''),
      });
    }
  }

  /**
   * One message's usage, once, when it has completed. Every assistant message
   * is one model call; until it completes its counts are zeros.
   */
  private countUsage(info: OpenCodeMessageInfo, turn: TurnState, onEvent: (e: AgentEvent) => void, subagentId?: string): void {
    if (info.role !== 'assistant' || !info.id || !info.time?.completed || turn.seen.has(`usage:${info.id}`)) return;
    turn.seen.add(`usage:${info.id}`);
    const record = usageRecord(info.tokens, { model: flatModelId(info.providerID, info.modelID), cost: info.cost, subagentId });
    if (record) onEvent({ type: 'usage', record });
  }

  /**
   * One `/event` frame. Only the planner's session and its children are
   * followed: the server's stream is global, and another client's session is
   * none of this turn's business.
   */
  private onFrame(frame: OpenCodeEvent, turn: TurnState, onEvent: (e: AgentEvent) => void): void {
    const props = frame.properties;
    if (!props) return;
    if (frame.type === 'session.created') {
      if (props.info?.parentID === this.sessionId && props.info.id) turn.children.created(props.info.id);
      return;
    }
    const session = props.sessionID;
    if (session && session !== this.sessionId && !turn.children.follows(session)) return;
    if (session === this.sessionId && this.taskTurn) this.followTaskTurn(frame, this.taskTurn, onEvent);
    // Answered before anything waits on the `task` call naming its session: a
    // subagent's request blocks the turn exactly as the session's own does.
    if (frame.type === 'permission.asked' || frame.type === 'permission.v2.asked') {
      this.onPermissionAsked(props, turn.seen, onEvent);
      return;
    }
    if (frame.type === 'permission.replied' || frame.type === 'permission.v2.replied') {
      this.permissions.withdraw(props.requestID, onEvent);
      return;
    }
    let subagentId: string | undefined;
    if (session && session !== this.sessionId) {
      const owner = turn.children.claim(session, frame);
      if (!owner) return;
      subagentId = owner;
    }

    if (frame.type === 'message.updated' && props.info) {
      if (props.info.role === 'assistant' && props.info.id) turn.assistantMessages.add(props.info.id);
      this.countUsage(props.info, turn, onEvent, subagentId);
      return;
    }
    if (frame.type === 'message.part.delta') {
      if (props.field !== 'text' || !props.partID || !props.delta) return;
      if (!props.messageID || !turn.assistantMessages.has(props.messageID)) return;
      const type = turn.partTypes.get(props.partID);
      if (type === 'reasoning') onEvent({ type: 'thinking_delta', text: props.delta, subagentId });
      else if (type === 'text' && !subagentId) turn.text.delta(props.partID, props.delta, onEvent);
      return;
    }
    const part = props.part;
    if (!part) return;
    if (part.type === 'tool') {
      this.emitPart(part, turn, onEvent, subagentId);
      return;
    }
    // The server replays the user's own message back as text parts, with no
    // role on the frame. Letting it through would put the user's goal into the
    // planner's reply, and a goal containing JSON would be parsed as the plan
    // — so a part counts only once `message.updated` has named its message an
    // assistant's.
    if (!part.id || !part.messageID || !turn.assistantMessages.has(part.messageID)) return;
    if (part.type === 'text' || part.type === 'reasoning') turn.partTypes.set(part.id, part.type);
    if (part.time?.end) this.emitPart(part, turn, onEvent, subagentId);
  }

  /** A planner's request is refused (T1); a task's is answered at once or left open for a card. */
  private onPermissionAsked(ask: OpenCodePermissionAsk, seen: Set<string>, onEvent: (e: AgentEvent) => void): void {
    const id = ask.id;
    if (!id) return;
    const sessionId = ask.sessionID ?? this.sessionId ?? '';
    const name = permissionName(ask);
    if (!this.task) {
      this.permissions.refuse({ type: 'permission_request', id, name, detail: permissionDetail(ask) }, sessionId, seen, onEvent);
      return;
    }
    const request: PermissionRequest = {
      type: 'permission_request',
      id,
      name,
      detail: permissionDetail(ask),
      input: ask.metadata ?? {},
      // The patterns `always` would grant: the runner's own offer, and the only grounds for "Allow for this task".
      ...(ask.always?.length ? { suggestions: ask.always } : {}),
      ...(ask.tool?.callID ? { toolUseId: ask.tool.callID } : {}),
    };
    this.permissions.ask(request, sessionId, autoApproves(this.task), seen, onEvent);
  }

  /**
   * `POST /permission/:id/reply` is the current answer. The per-session path
   * it replaced is tried only when a server too old to know the new one 404s.
   */
  private async replyPermission(id: string, sessionId: string, reply: { reply: PermissionAnswer; message?: string }): Promise<void> {
    const response = await this.request('POST', `/permission/${id}/reply`, reply);
    if (response.status !== 404) return;
    await this.request('POST', `/session/${sessionId}/permissions/${id}`, { response: reply.reply });
  }

  /** `/event` for one turn — see {@link openEventStream}. Load-bearing for {@link onPermissionAsked}. */
  private openStream(turn: TurnState, onEvent: (e: AgentEvent) => void, onActivity?: () => void): Promise<() => Promise<void>> {
    return openEventStream<OpenCodeEvent>(
      (signal) => this.deps.fetch(`${this.baseUrl}/event`, { signal, headers: this.headers() }),
      (frame) => this.onFrame(frame, turn, onEvent),
      onActivity,
    );
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
    const response = await this.request(method, path, body, signal);
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${response.statusText}`);
    return (await response.json().catch(() => null)) as T | null;
  }

  private request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    return this.deps.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers({ 'content-type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.authorization ? { ...extra, authorization: this.authorization } : extra;
  }

  nativeSessionId(): string | null { return this.sessionId; }

  /** Asks the server, which lists every MCP server it has with the state of its connection. */
  async mcpAttached(): Promise<boolean> {
    const ordewell = this.ordewell;
    if (!ordewell || !this.baseUrl) return false;
    return awaitAttach(async () => {
      if (this.exited) return 'failed';
      const servers = await this.json<Record<string, { status?: string } | undefined>>('GET', '/mcp').catch(() => null);
      return OPENCODE_ORDEWELL.attachState(servers?.[ordewell.name]?.status);
    }, MCP_ATTACH_TIMEOUT_MS, MCP_STATUS_POLL_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The server is gone with its session; its stored messages are unreachable.
    this.steers.drain();
    this.process = null;
    this.baseUrl = null;
    // A surviving server keeps the port and the session.
    this.runner.dispose();
  }

  private exitMessage(): string {
    return this.runner.withStderrTail(`The OpenCode ${this.role()} server exited.`);
  }
}
