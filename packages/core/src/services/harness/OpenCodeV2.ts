import { readOnlyTaskPolicy, readOnlyTask } from './plannerPermissions';
import { realpathSync } from 'fs';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { AgentEvent, PlannerStartOptions, TaskStartOptions } from './AgentAdapter';
import { taskCompletionContract } from '../mcp';
import { OPENCODE_ORDEWELL, plannerPermission, readOnlySessionRules, OPENCODE_SEARCH_OFF, type OpenCodeSessionRule as SessionRule } from './openCodeOrdewell';
import { hunksOf } from './fileDiff';
import { heldServersNote } from './projectServers';
import type { ProjectMcpServer } from './repoConfig';
import type { RaisedRequest } from './permissionLedger';
import {
  autoApproves, delay, interruptAcknowledged, openCodePermissions, openCodePlannerAsk, plannerSystem, openEventStream, permissionReply, raiseOnce, settleTurn, splitModelId, streamTurn,
  turnLatch, usageRecord, type EventStream, type OpenCodeTokens, type StreamTurn, type TurnLatch,
} from './openCodeTransport';
/** A turn's end is also read from `/api/session/active`, behind the stream, which can drop a frame. */
const ACTIVE_POLL_INTERVAL_MS = 1000;
/** Polls that find the session inactive before any frame of this turn arrived, after which it is taken as already over. */
const IDLE_POLLS_BEFORE_START = 3;

/**
 * The planner's session gets the same policy its server is configured with
 * (ADR-0026), catch-all first: 2.x, like 1.x, applies the last rule that
 * matches, after the agent's and the user's own. With the native-shell
 * opt-in, `bash` and `shell` ask instead of denying (ADR-0036 N2).
 */
function plannerRules(nativeShell: boolean): SessionRule[] {
  return Object.entries(plannerPermission(nativeShell))
    .map(([action, effect]) => ({ action, resource: '*', effect }));
}
const SEARCH_OFF_RULES: SessionRule[] = Object.entries(OPENCODE_SEARCH_OFF)
  .map(([action, effect]) => ({ action, resource: '*', effect }));
/**
 * 2.x raises no permission for `execute` itself, so no approval or refusal
 * reaches it: it runs model-written code over every tool and HTTP at once.
 * A planner's session denies it outright.
 */
const CODE_MODE_OFF_RULES: SessionRule[] = [{ action: 'execute', resource: '*', effect: 'deny' }];
function codeModeOnly(version: string | undefined, role: 'planner' | 'task'): string {
  return `OpenCode${version ? ` ${version}` : ''} cannot run the ${role} safely: it can only offer Ordewell's tools inside code mode, which runs code the model writes without asking. `
    + `This ${role} needs an OpenCode version that can list MCP tools outside code mode. Update OpenCode, or choose another runner.`;
}
function toolsNotTakenBack(role: 'planner' | 'task'): string {
  return `OpenCode would not list Ordewell's tools as tools of their own again, and the ${role} may not reach them inside code mode: the message was not sent.`;
}
/** Why an approved project server's tools are missing, when this OpenCode cannot list them as tools of their own. */
const UNUSABLE = 'not usable on this OpenCode version: its tools are only reachable through code mode\'s `execute`, which the planner may not use';
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
    reason?: string;
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
    /**
     * On a delegating call's progress, the child session it runs; on a file
     * edit's success, the diff of each file it changed; on a result too long
     * for the context, the file the whole of it was saved to.
     */
    metadata?: { sessionID?: string; status?: string; files?: unknown; truncated?: unknown; outputPath?: unknown };
    /** `shell.created`: the shell a command was started in (ADR-0036 N2). */
    info?: { id?: string; shell?: string; command?: string; metadata?: { sessionID?: string } };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether OpenCode would send a `websearch` somewhere without asking which
 * provider (checked against 2.0.26): the last config layer that sets
 * `websearch` names one, as OpenCode reads it. A pick made in OpenCode's own
 * UI is stored where its API does not reach, so it is not seen here; such a
 * planner searches through Ordewell's tool instead.
 */
function searchProviderChosen(config: unknown): boolean {
  const layers = Array.isArray(config) ? config : isRecord(config) && Array.isArray(config.data) ? config.data : [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer: unknown = layers[i];
    if (!isRecord(layer) || layer.type !== 'document' || !isRecord(layer.info) || layer.info.websearch === undefined) continue;
    const setting = layer.info.websearch;
    return isRecord(setting) && typeof setting.provider === 'string' && setting.provider !== '';
  }
  return false;
}

/** The effect of the last `*`-resource rule for `action`, as OpenCode reads a session's own rules. */
function ruleEffect(rules: unknown, action: string): string | undefined {
  if (!Array.isArray(rules)) return undefined;
  const last = [...rules].reverse().find((rule: unknown) => isRecord(rule) && rule.action === action && (rule.resource === '*' || rule.resource === undefined));
  return isRecord(last) && typeof last.effect === 'string' ? last.effect : undefined;
}

/** Whether a session's own rules deny `action` outright, as {@link SEARCH_OFF_RULES} and {@link CODE_MODE_OFF_RULES} do. */
function rulesDeny(rules: unknown, action: string): boolean {
  return ruleEffect(rules, action) === 'deny';
}

/**
 * What of a project server's 1.x definition starts it: the command and its
 * variables, or the URL and its headers. The rest is left out, as 2.x's route
 * refuses some of it — a 1.x `timeout` is a number, a 2.x one an object.
 */
function transportFields(definition: Record<string, unknown>): Record<string, unknown> {
  const fields = definition.type === 'remote' ? ['type', 'url', 'headers'] : ['type', 'command', 'environment'];
  return Object.fromEntries(fields.filter((field) => definition[field] !== undefined).map((field) => [field, definition[field]]));
}

interface V2Message {
  id?: string;
  type?: string;
  outcome?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** What the adapter that owns the server lends this module. */
export interface OpenCodeV2Host {
  /** What `/api/info` reports. */
  version?: string;
  /** The native-shell launcher every command of a planner must run in (ADR-0036 N2); null when the opt-in is off. */
  nativeShell?: string | null;
  /** The user's MCP servers the server listed, for telling a planner's MCP tool request from a built-in's (ADR-0026). */
  mcpServers?(): readonly string[];
  /** `timeoutMs` is how long the server may take to answer, a default when left out and none when null. */
  request(method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number | null): Promise<Response>;
  /** A request whose body is the answer or throws, as `request` + status check. */
  json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number | null): Promise<T | null>;
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
  /** A `read` call's id → the path it reads; its `external_directory` request names only the folder. */
  readPaths: Map<string, string>;
  /** A `bash`/`shell` call's id → the command it asked for, and the session that runs it. */
  shellCalls: Map<string, { command: string; session: string }>;
  /** A shell call whose command OpenCode ran outside Ordewell's launcher (ADR-0036 N2), and why it failed. */
  wrongShell: Map<string, string>;
}

interface Turn extends TurnLatch {
  outcome: 'succeeded' | 'failed' | 'interrupted' | null;
  failure: string | null;
}

function newTurnState(): TurnState {
  return {
    ...streamTurn<V2Frame>(),
    toolNames: new Map(),
    stepModels: new Map(),
    briefs: new Map(),
    readPaths: new Map(),
    shellCalls: new Map(),
    wrongShell: new Map(),
  };
}

/**
 * A run of reply text: one text part of an assistant message, by its ordinal,
 * which counts the message's text parts alone (OpenCode 2.0.32's runner keeps
 * a counter per part kind).
 */
function textRun(messageId: string, ordinal: number | undefined): string {
  return `${messageId}:${ordinal ?? 0}`;
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
  /** Whether a planner's own `websearch` is on for its session (ADR-0027). */
  private ownSearch = true;
  /** Approved project servers whose tools are listed as tools of their own. */
  private exposed: string[] = [];
  /** Approved project servers whose tools this OpenCode would list only inside `execute`, which a planner may not use. */
  private unusable: ProjectMcpServer[] = [];
  /**
   * The files this session's long tool results were saved to, resolved on
   * disk. OpenCode keeps every session's in one shared folder, so the planner
   * reads back only these, never the folder (ADR-0032).
   */
  private readonly saved = new Set<string>();
  private readonly permissions = openCodePermissions(
    (id, sessionId, decision) => this.replyPermission(id, sessionId, decision),
    () => ({ role: this.role, autoApprove: this.opts.kind === 'task' && autoApproves(this.opts), decide: readOnlyTaskPolicy(this.opts) }),
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

  /** The launcher every command must run in, or null when the user's opt-in is off (ADR-0036 N2). */
  private get nativeShell(): string | null { return this.host.nativeShell ?? null; }

  unusableProjectServers(): ProjectMcpServer[] { return [...this.unusable]; }

  savedOutput(abs: string): boolean { return this.saved.has(abs); }

  async start(): Promise<void> {
    await this.exposeServers();
    const resume = this.opts.resumeSessionId;
    if (resume) {
      // A resume id names a session on disk, not on this process — so it is checked rather than trusted.
      const existing = await this.host.json<{ data?: { id?: string; permissions?: unknown } }>('GET', `/api/session/${resume}`).catch(() => null);
      // Its rules are the ones it was created with, which no route changes: a planner session from before
      // `execute` was denied would keep running the planner's code unasked, so it is treated as stale.
      // The shell rules must match the opt-in too (ADR-0036 N1): resuming a session created without it
      // would leave the new process with a shell it may not use, or with one it may when the user turned it off.
      const resumable = !readOnlyTask(this.opts)
        && (this.role === 'task' || rulesDeny(existing?.data?.permissions, 'execute'))
        && this.shellRulesMatch(existing?.data?.permissions);
      if (existing?.data?.id && resumable) {
        this.sessionId = existing.data.id;
        // The instructions follow its rules too.
        if (this.role === 'planner') this.ownSearch = !rulesDeny(existing.data.permissions, 'websearch');
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
    // With no provider chosen, 2.x's `websearch` asks the user to pick one through `question`, which a
    // planner is denied: the search ends "cancelled", and the model reads that as a refusal (ADR-0027).
    if (this.role === 'planner') this.ownSearch = searchProviderChosen(await this.host.json<unknown>('GET', '/api/config').catch(() => null));
    const created = await this.host.json<{ data?: { id?: string } }>('POST', '/api/session', {
      agent: this.agent,
      ...(this.model ? { model: this.model } : {}),
      permissions: [...(this.opts.kind === 'task' && readOnlyTask(this.opts) ? readOnlySessionRules(this.opts) : this.role === 'planner' ? [...plannerRules(this.nativeShell !== null), ...(this.ownSearch ? [] : SEARCH_OFF_RULES), ...CODE_MODE_OFF_RULES] : TASK_RULES), ...this.ordewellRules()],
    });
    if (!created?.data?.id) throw new Error(`The OpenCode ${this.role} server did not return a session id.`);
    this.sessionId = created.data.id;
    await this.applyInstructions();
  }

  /** Whether a planner session's own shell rules are the ones the current opt-in needs (ADR-0036 N2). */
  private shellRulesMatch(rules: unknown): boolean {
    if (this.role !== 'planner') return true;
    const expected = this.nativeShell ? 'ask' : 'deny';
    return ruleEffect(rules, 'bash') === expected && ruleEffect(rules, 'shell') === expected;
  }

  /**
   * 2.x lists an MCP server's tools inside its code-mode `execute` tool, where
   * a model told to call `task_complete` does not look for it, and where a
   * planner may not reach them: `execute` runs model-written code over every
   * tool at once, past per-tool approval. Each server is replaced at runtime
   * with `codemode: false`, which lists its tools as tools of their own: the
   * config it started with is in the 1.x shape both versions read, and that
   * shape drops the setting. Replaced before anything lists the servers, a
   * local one starts once; replaced later, OpenCode stops it and starts the
   * new one. If the route is gone, Ordewell's tools are reachable only
   * through `execute`: a task keeps that, but a planner would have to choose
   * between an unchecked code runner and no way to submit a plan, so it is
   * not started. A project server's tools are then not reachable at all.
   */
  private async exposeServers(): Promise<void> {
    if (!await this.exposeOrdewell()) throw new Error(codeModeOnly(this.host.version, this.role));
    const project = this.opts.kind === 'planner' ? this.opts.projectServers ?? [] : [];
    for (const server of project) {
      if (await this.expose(server.name, transportFields(server.definition))) this.exposed.push(server.name);
      else this.unusable.push(server);
    }
  }

  /**
   * The same replacements, made again before every turn. 2.x rebuilds a
   * location from the configuration it was launched with when it evicts or
   * reloads one, and every server is back in code mode then: still connected,
   * its tools offered to the model only inside `execute`, which a planner is
   * denied (checked against 2.1.4). The launch configuration turns eviction
   * off; this puts the servers back after any rebuild that still happens,
   * though the model is offered a server put back only a moment later, so the
   * turn's first step may go without it. A replacement that changes nothing
   * restarts nothing. False when Ordewell's tools are left where this session
   * may not reach them (ADR-0022 S4).
   */
  private async reexposeServers(): Promise<boolean> {
    if (!await this.exposeOrdewell()) return false;
    const project = this.opts.kind === 'planner' ? this.opts.projectServers ?? [] : [];
    for (const server of project) {
      if (this.exposed.includes(server.name)) await this.expose(server.name, transportFields(server.definition));
    }
    return true;
  }

  /** Whether Ordewell's tools are listed as tools of their own, or this session can do without that: a task reaches them through `execute`. */
  private async exposeOrdewell(): Promise<boolean> {
    const mcp = this.opts.mcp;
    if (!mcp || await this.expose(mcp.name, { type: 'remote', url: mcp.url, headers: mcp.headers })) return true;
    return this.role === 'task' && !readOnlyTask(this.opts);
  }

  private async expose(name: string, config: Record<string, unknown>): Promise<boolean> {
    return this.host.request('PUT', `/api/experimental/mcp/${name}`, { config: { ...config, codemode: false } })
      .then((response) => response.ok, () => false);
  }

  /** Allow the Ordewell server's tools, so a call never waits on a person (ADR-0022, S3). */
  private ordewellRules(): SessionRule[] {
    return this.opts.mcp ? OPENCODE_ORDEWELL.sessionRules(this.opts.mcp, readOnlyTask(this.opts) ? 'readOnlyTask' : this.role) : [];
  }

  /**
   * The planner's system prompt rides on the session as an instruction entry —
   * a prompt has no system field — and so does a task's completion contract,
   * which the server's own compaction leaves whole.
   */
  private async applyInstructions(): Promise<void> {
    if (this.opts.kind === 'task') {
      if (!this.opts.mcp) return;
      const response = await this.host.request('PUT', `/api/experimental/session/${this.sessionId}/instructions/entries/ordewell-task`, { value: taskCompletionContract(this.opts) });
      if (!response.ok) throw new Error(`OpenCode did not take the task instructions: ${response.status} ${response.statusText}`);
      return;
    }
    const unusable = heldServersNote(this.unusable.map((server) => ({ server, reason: UNUSABLE })));
    const system = [plannerSystem(this.opts, this.ownSearch).system, unusable].filter(Boolean).join('\n\n');
    if (!system) return;
    const response = await this.host.request('PUT', `/api/experimental/session/${this.sessionId}/instructions/entries/ordewell-planner`, { value: system });
    if (!response.ok) throw new Error(`OpenCode did not take the planner instructions: ${response.status} ${response.statusText}`);
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    return this.runTurn(() => this.host.json('POST', `/api/session/${this.sessionId}/prompt`, { text: message }, signal, null), onEvent, signal, onActivity);
  }

  async invokeCommand(name: string, args: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, skillId?: string): Promise<void> {
    if (name === 'compact') {
      if (args.trim()) { onEvent({ type: 'error', message: 'OpenCode native compaction does not accept arguments.' }); return; }
      await this.runTurn(() => this.host.json('POST', `/api/session/${this.sessionId}/compact`, {}, signal, null), onEvent, signal);
      return;
    }
    return this.runTurn(() => this.host.json('POST', `/api/session/${this.sessionId}/${skillId ? 'prompt' : 'command'}`,
      skillId ? { text: args, skills: [{ id: skillId }] } : { name, text: args }, signal, null), onEvent, signal);
  }

  private async runTurn(post: () => Promise<unknown>, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    if (!this.sessionId) throw new Error(`OpenCode ${this.role} session is not started`);
    if (this.host.isExited()) {
      onEvent({ type: 'error', message: this.host.exitMessage() });
      return;
    }
    // Before the stream, so the location a rebuild leaves is the one it listens to.
    if (!await this.reexposeServers()) {
      onEvent({ type: 'error', message: toolsNotTakenBack(this.role) });
      return;
    }
    const state = newTurnState();
    this.interruptRequested = false;
    const turn: Turn = Object.assign(turnLatch(), { outcome: null, failure: null });
    this.turn = turn;
    const stream = await this.openStream(state, turn, onEvent, onActivity);
    const poll = new AbortController();

    try {
      try {
        await post();
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
        streamFailed: stream.failed,
        exitMessage: () => this.host.exitMessage(),
        readBack: () => this.readBack(state, onEvent),
        permissions: this.permissions,
        outcome: () => {
          // OpenCode's own end decides; the request only stands in where it named none.
          if (turn.outcome === 'interrupted' || (turn.outcome === null && this.interruptRequested)) return { type: 'turn_end', interrupted: true };
          if (turn.outcome === 'failed' || turn.failure) return { type: 'error', message: turn.failure ?? 'OpenCode reported that the turn failed.' };
          return { type: 'turn_end' };
        },
      }, onEvent);
    } finally {
      this.turn = null;
      poll.abort();
      await stream.close();
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
        turn.outcome ??= this.interruptRequested ? 'interrupted' : 'succeeded';
        if (!turn.done) turn.finish();
      }
    }
  }

  private async messages(): Promise<V2Message[] | null> {
    const response = await this.host.json<{ data?: V2Message[] }>('GET', `/api/session/${this.sessionId}/message`).catch(() => null);
    return Array.isArray(response?.data) ? response.data : null;
  }

  /**
   * Whatever of the turn's own replies the stream missed, each text part as
   * the run the stream names it. A run the stream completed adds nothing; one
   * whose end frame was dropped is completed as the run it streamed as; one
   * that lost every frame still reaches the plain-text channel, which a
   * summary falls back to.
   */
  private async readBack(state: TurnState, onEvent: (e: AgentEvent) => void): Promise<void> {
    const messages = await this.messages();
    if (!messages) return;
    // The server lists newest first, so this turn's own replies are the ones before the latest user message.
    const latestUser = messages.findIndex((m) => m.type === 'user');
    const own = latestUser < 0 ? messages : messages.slice(0, latestUser);
    for (const message of [...own].reverse()) {
      if (message.type !== 'assistant' || !message.id) continue;
      const id = message.id;
      (message.content ?? []).filter((part) => part.type === 'text').forEach((part, ordinal) => {
        if (part.text) state.text.complete(textRun(id, ordinal), part.text, onEvent);
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
    const response = await this.host.json<{ interrupted?: boolean }>('POST', `/api/session/${this.sessionId}/interrupt`, undefined, undefined, timeoutMs).catch(() => null);
    if (!response) {
      // An interrupt the server did not take stops nothing, so it must not colour the turn's end.
      this.interruptRequested = false;
      return false;
    }
    if (!turn || turn.done) return true;
    return interruptAcknowledged(turn, this.host.processEnded, timeoutMs);
  }

  answerPermission(id: string, decision: ApprovalDecision): Promise<boolean> {
    return this.permissions.answerAsync(id, decision);
  }

  private async replyPermission(id: string, sessionId: string, decision: ApprovalDecision): Promise<void> {
    const response = await this.host.request('POST', `/api/session/${sessionId}/permission/${id}/reply`, permissionReply(decision, 'decision'));
    if (!response.ok) throw new Error(`OpenCode permission reply failed: ${response.status} ${response.statusText}`);

  }

  /** `/api/event` for one turn — see {@link openEventStream}. */
  private openStream(state: TurnState, turn: Turn, onEvent: (e: AgentEvent) => void, onActivity?: () => void): Promise<EventStream> {
    return openEventStream<V2Frame>((signal) => this.host.openEvents(signal), (frame) => this.onFrame(frame, state, turn, onEvent), onActivity);
  }

  /**
   * One frame. Only this session and its children are followed: the stream is
   * the whole server's, and another client's session is none of this turn's business.
   */
  private onFrame(frame: V2Frame, state: TurnState, turn: Turn, onEvent: (e: AgentEvent) => void): void {
    const data = frame.data;
    if (!data || !frame.type) return;
    // Not a session event: it names the session only inside the shell's own
    // metadata. Checked before the session filter below (ADR-0036 N2).
    if (frame.type === 'shell.created') {
      this.checkShell(data, state, turn);
      return;
    }
    if (frame.type === 'session.created') {
      if (data.parentID && data.parentID === this.sessionId && data.sessionID) state.children.created(data.sessionID);
      return;
    }
    const session = data.sessionID;
    if (!session) return;
    const isChild = session !== this.sessionId;
    if (isChild && !state.children.follows(session)) return;

    if (!isChild) {
      if (frame.type === 'session.compaction.failed' && data.reason === 'manual') {
        turn.failure = data.error?.message ?? data.error?.type ?? 'OpenCode did not compact the session.';
        return;
      }
      if (frame.type === 'session.compaction.ended') {
        onEvent({ type: 'compaction', trigger: data.reason === 'manual' ? 'manual' : 'auto' });
        // OpenCode states no size after it: the next call's usage is the first.
        onEvent({ type: 'usage', record: { source: 'opencode', compacted: true } });
        return;
      }
      if (frame.type === 'session.execution.started') { turn.live = true; return; }
      if (frame.type === 'session.execution.succeeded' || frame.type === 'session.execution.failed' || frame.type === 'session.execution.interrupted') {
        if (!turn.live || turn.done) return;
        turn.outcome = frame.type === 'session.execution.succeeded' ? 'succeeded' : frame.type === 'session.execution.failed' ? 'failed' : 'interrupted';
        // A shell that escaped the launcher already named the failure (N2); OpenCode's own error must not replace it.
        if (turn.outcome === 'failed') turn.failure ??= data.error?.message ?? data.error?.type ?? null;
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

  /**
   * Each shell OpenCode starts names the program it runs in. With the opt-in
   * on, anything but Ordewell's launcher means the command escaped the sandbox
   * (ADR-0036 N2): the turn fails, and the call whose command it was reports
   * that failure rather than a success it cannot vouch for.
   */
  private checkShell(data: NonNullable<V2Frame['data']>, state: TurnState, turn: Turn): void {
    const expected = this.nativeShell;
    const info = data.info;
    if (!expected || !info?.shell || info.shell === expected) return;
    const session = info.metadata?.sessionID;
    if (session && session !== this.sessionId && !state.children.follows(session)) return;
    const reason = `OpenCode ran a command in ${info.shell}, not Ordewell's launcher (${expected}). This planner's own shell is not sandboxed, so the turn is failed.`;
    const call = [...state.shellCalls].find(([id, held]) => !state.wrongShell.has(id)
      && held.command === info.command
      && (!session || held.session === session))?.[0];
    if (call) state.wrongShell.set(call, reason);
    turn.failure = reason;
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
        if (!subagentId && data.delta) state.text.delta(textRun(message, data.ordinal), data.delta, onEvent);
        return;
      case 'session.text.ended':
        if (subagentId || !data.text) return;
        state.text.complete(textRun(message, data.ordinal), data.text, onEvent);
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
        if (name === 'read' && typeof input.path === 'string') state.readPaths.set(id, input.path);
        // The shell's own `shell.created` carries no call id, so the command is
        // what ties the process Ordewell checks to the call the model made (N2).
        if ((name === 'bash' || name === 'shell') && typeof input.command === 'string') {
          state.shellCalls.set(id, { command: input.command, session: data.sessionID ?? '' });
        }
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
        const wrongShell = state.wrongShell.get(id);
        const success = frame.type === 'session.tool.success' && !wrongShell;
        if (success && this.role === 'planner') this.rememberSaved(data.metadata);
        const output = wrongShell ?? (success ? editDiff(data.metadata) || contentText(data.content) : data.error?.message ?? data.error?.type ?? '');
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

  /** Checked live on 2.0.27: the result names its file in `outputPath` beside `truncated: true`. */
  private rememberSaved(metadata: NonNullable<V2Frame['data']>['metadata']): void {
    if (metadata?.truncated !== true || typeof metadata.outputPath !== 'string') return;
    let real: string;
    try { real = realpathSync.native(metadata.outputPath); } catch { return; }
    this.saved.add(real);
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

  private permissionRequest(ask: NonNullable<V2Frame['data']>): RaisedRequest | null {
    const id = ask.id;
    if (!id) return null;
    const scope = (ask.resources ?? []).join(', ');
    const name = ask.action ?? 'permission';
    return {
      id,
      name,
      detail: JSON.stringify(scope ? { scope } : {}),
      input: ask.resources ? { resources: ask.resources } : {},
      // The patterns `always` would grant: the runner's own offer, and the only grounds for "Allow for this task".
      ...(ask.save?.length ? { suggestions: ask.save } : {}),
      ...(ask.source?.id ? { toolUseId: ask.source.id } : {}),
      ordewell: !!this.opts.mcp && OPENCODE_ORDEWELL.isOrdewellAsk(name),
    };
  }

  /** A planner's request is held for its envelope (ADR-0026); a task's is answered at once or left open for a card. */
  private onPermissionAsked(ask: NonNullable<V2Frame['data']>, session: string, state: TurnState, onEvent: (e: AgentEvent) => void): void {
    const request = this.permissionRequest(ask);
    if (!request) return;
    if (this.role !== 'task' || readOnlyTask(this.opts)) {
      // `/api/mcp` may have been read before OpenCode listed the approved servers; they are known from the start.
      // An unusable one is running too, but what reaches its tools is `execute`, and the planner was told it has none.
      const listed = (this.host.mcpServers?.() ?? []).filter((name) => !this.unusable.some((server) => server.name === name));
      const read = request.name === 'external_directory' && ask.source?.id ? state.readPaths.get(ask.source.id) : undefined;
      request.ask = openCodePlannerAsk(request.name, { patterns: ask.resources, ...(read ? { metadata: { filepath: read } } : {}) }, [...listed, ...this.exposed], this.nativeShell !== null);
    }
    raiseOnce(this.permissions, request, session, state.seen, onEvent);
  }
}
