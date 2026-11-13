import { readOnlyTaskPolicy, readOnlyTask } from './plannerPermissions';
import type { RunnerCommand, RunnerMcpServer } from '../../models/RunnerCommand';
import { randomBytes } from 'crypto';
import { isCredentialVariable } from './credentialEnv';
import type { NativeShellLauncher } from '../sandbox/nativeShellLauncher';
import { ProcessLifecycle } from './ProcessLifecycle';
import { OpenCodeV2 } from './OpenCodeV2';
import { OPENCODE_CONFIG_VARIABLE, OPENCODE_ORDEWELL, OPENCODE_PLANNER_ENV, OPENCODE_READ_ONLY_PERMISSION, leaseGateway } from './openCodeOrdewell';
import { envValue } from '../../utils/shellPath';
import { awaitAttach, MCP_ATTACH_TIMEOUT_MS, type AttachState } from './ordewellBinding';
import { taskCompletionContract, type McpClientConfig } from '../mcp';
import type { ProjectMcpServer } from './repoConfig';
import { hunksOf, markedLines } from './fileDiff';
import {
  PendingSteers, autoApproves, delay, interruptAcknowledged, newUserMessageId, openCodePermissions, openCodePlannerAsk, plannerSystem, openEventStream, permissionReply, raiseOnce, settleTurn, splitModelId,
  REQUEST_TIMEOUT_MS, SESSION_TITLE, streamTurn, turnLatch, usageRecord, withDeadline, type EventStream, type PermissionAnswer, type StreamTurn, type TurnLatch,
} from './openCodeTransport';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { AgentEvent, AgentStartOptions, PlannerStartOptions, TaskModeAgentAdapter, TaskStartOptions } from './AgentAdapter';
import { SubagentTracker, subagentBrief } from './subagentTracker';
import { TurnOutcome } from './turnOutcome';

const SERVER_READY_TIMEOUT_MS = 30000;
/** The banner is one short line; a longer unterminated one is not it, and is not kept growing. */
const BANNER_LINE_CHARS = 4000;
/** See {@link OpenCodeAdapter.recoverReply}. */
const RECOVERY_POLL_INTERVAL_MS = 2000;
const RECOVERY_TIMEOUT_MS = 900000;
/** How often a task turn reads `/session/status` itself — see {@link OpenCodeAdapter.pollStatus}. */
const STATUS_POLL_INTERVAL_MS = 1000;
/** The Basic-auth username `serve` accepts: 2.x ignores `OPENCODE_SERVER_USERNAME` and takes only this one. Set explicitly so a host's own variable cannot win on 1.x. */
export const SERVER_USERNAME = 'opencode';
const MCP_STATUS_POLL_MS = 200;
/**
 * How long 2.x takes, after it says a server is connected, to offer the model
 * that server's tools: its tool list refreshes 100 ms after a server's tools
 * change, debounced (checked against 2.1.4). A prompt sent sooner is offered
 * none of them.
 */
const V2_TOOLS_OFFERED_MS = 300;
/** The error name of a message that was aborted, which an interrupt causes. */
const ABORTED = 'MessageAbortedError';

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
  bash: false,
  task: false,
};

/**
 * A task asks its user in plain text for now: the `question` tool blocks the
 * turn on an answer no surface can give yet. Nothing else is withheld — the
 * task's agent decides what it may do.
 */
const TASK_DISABLED_TOOLS: Record<string, boolean> = { question: false };
const READ_ONLY_DISABLED_TOOLS: Record<string, boolean> = Object.fromEntries(
  Object.entries(OPENCODE_READ_ONLY_PERMISSION).filter(([name, effect]) => name !== '*' && name !== 'external_directory' && effect === 'deny').map(([name]) => [name, false]),
);

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
  /** Whether {@link messageError} is the abort of an interrupt, not a failure. */
  messageAborted: boolean;
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
/** The server answered, and refused. */
class OpenCodeHttpError extends Error {}

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
export class OpenCodeAdapter extends ProcessLifecycle implements TaskModeAgentAdapter {
  readonly agentId = 'opencode';
  private nativeCommands: RunnerCommand[] = [];
  private readonly nativeSkills = new Map<string, string>();
  private manualCompaction = false;
  private loaded: { commands: RunnerCommand[]; mcpServers: RunnerMcpServer[] } | null = null;

  private baseUrl: string | null = null;
  /** The server's version from `/api/info`; null on 1.x, which does not report one (ADR-0036 N2). */
  private serverVersion: string | null = null;
  /** Sent on every request to a task's server, which a per-task password secures. */
  private authorization: string | null = null;
  private sessionId: string | null = null;
  private planner: PlannerStartOptions | null = null;
  private task: TaskStartOptions | null = null;
  /** The last assistant message already settled — the baseline {@link recoverReply} measures a new reply against. */
  private lastAssistantId: string | null = null;
  private taskTurn: TaskTurn | null = null;
  /** Whether an abort was posted in the current task turn, and so how the idle that follows ends it (ADR-0018 W1). */
  private readonly outcome = new TurnOutcome();
  private readonly subagents = new SubagentTracker(this.outcome);
  /** The user's MCP servers, as `/mcp` last listed them: what tells a planner's MCP tool request from a built-in's (ADR-0026). */
  private mcpServers: string[] = [];
  private readonly permissions = openCodePermissions(
    (id, sessionId, decision) => this.replyPermission(id, sessionId, permissionReply(decision, 'reply')),
    () => ({ role: this.task ? 'task' : 'planner', autoApprove: !!this.task && autoApproves(this.task), decide: readOnlyTaskPolicy(this.task) }),
  );
  /** Messages handed into the running task turn, until the model reads them (ADR-0023). Kept across turns: the server keeps the message too. */
  private readonly steers = new PendingSteers();
  /** Set once the server turns out to speak the 2.x API, which then owns the session. */
  private v2: OpenCodeV2 | null = null;
  /** The Ordewell server this process was configured with; null when none was given or its config could not be merged. */
  private ordewell: McpClientConfig | null = null;
  /** The sealed launcher this planner's own shell goes through, when the opt-in is on (ADR-0036 N2). */
  private nativeShell: NativeShellLauncher | null = null;

  async start(opts: AgentStartOptions): Promise<void> {
    this.role = opts.kind;
    try {
      // OpenCode takes a shell program rather than a prefix, so the launcher is
      // named as `SHELL` and as the `shell` of the config layer that carries
      // Ordewell's policy.
      this.nativeShell = await this.ownNativeShell(opts);
      await this.launch(opts);
      if (opts.kind === 'task') await this.loadCommands();
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
    const nativeShell = this.nativeShell?.prefix;
    // What a lease holds in place of an Anthropic key (ADR-0059 L7), read before the server starts: a task's model traffic must go to its gateway, not to Anthropic with a token that means nothing there.
    const gateway = leaseGateway(this.deps.placement?.env);
    const command = () => ({
      command: 'opencode',
      args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      env: (workspaceEnv: Record<string, string>) => {
        // The token rides in the server's environment, not its argv (ADR-0022, A5).
        // A planner always gets its permission policy (ADR-0026), with the server or without it, and
        // over content that cannot be merged too: a planner without its policy may not start.
        // A container gets Ordewell's own configuration, never this host's: an inline config here may name host paths, providers or a key, and none of it crosses (ADR-0059 L5).
        // Read in any case on Windows, where the workspace's spelling is the one the server would otherwise get.
        const existing = this.deps.placement ? undefined : envValue(workspaceEnv, OPENCODE_CONFIG_VARIABLE, this.deps.platform) ?? process.env[OPENCODE_CONFIG_VARIABLE];
        const projectServers = opts.kind === 'planner' ? Object.fromEntries((opts.projectServers ?? []).map((server) => [server.name, server.definition])) : {};
        const readOnly = opts.kind === 'task' && readOnlyTask(opts);
        const role = readOnly ? 'readOnlyTask' : opts.kind;
        const ordewellConfig = opts.kind === 'planner' || readOnly
          ? OPENCODE_ORDEWELL.configContent(existing, opts.mcp ?? null, role, projectServers, opts.kind === 'task' ? opts : undefined, nativeShell, gateway ?? undefined, opts.kind === 'planner' && opts.readsAsk) ?? OPENCODE_ORDEWELL.configContent(undefined, opts.mcp ?? null, role, projectServers, opts.kind === 'task' ? opts : undefined, nativeShell, gateway ?? undefined, opts.kind === 'planner' && opts.readsAsk)
          : opts.mcp || gateway ? OPENCODE_ORDEWELL.configContent(existing, opts.mcp ?? null, 'task', undefined, undefined, undefined, gateway ?? undefined) : null;
        if ((opts.mcp || gateway) && ordewellConfig === null) {
          console.error('[opencode] OPENCODE_CONFIG_CONTENT is not a JSON object, so the Ordewell tools were not injected.');
        }
        this.ordewell = ordewellConfig === null ? null : opts.mcp ?? null;
        return {
          PWD: opts.cwd,
          ...(opts.kind === 'planner' || readOnly ? OPENCODE_PLANNER_ENV : {}),
          ...(ordewellConfig === null ? {} : { [OPENCODE_CONFIG_VARIABLE]: ordewellConfig }),
          OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
          OPENCODE_SERVER_PASSWORD: password,
          // N2: the config layer's `shell` wins over this, and both beat the
          // user's global config. Last so no workspace variable replaces it.
          ...(nativeShell ? { SHELL: nativeShell } : {}),
        };
      },
      // N2.2: a sandboxed command can read its parent's environment on macOS,
      // so the credentials must not be in this process at all. The harness's
      // own login stays (N3).
      ...(nativeShell ? { envDrop: isCredentialVariable } : {}),
    });
    await this.startProcess(opts.cwd, command, () => {
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
      throw new Error(this.runner.withStderrTail(`The OpenCode ${this.role} server did not start.`));
    }
    // In a container the server listens on its own loopback, which this host cannot reach: the lease's relay carries this host's port to it (ADR-0059 L6).
    if (this.deps.placement?.reachIn) this.baseUrl = await this.deps.placement.reachIn(this.baseUrl);

    const version = await this.v2Version();
    this.serverVersion = version;
    if (version !== null) {
      this.v2 = new OpenCodeV2({
        version,
        nativeShell: this.nativeShell?.prefix ?? null,
        request: (method, path, body, signal, timeoutMs) => this.request(method, path, body, signal, timeoutMs),
        json: (method, path, body, signal, timeoutMs) => this.json(method, path, body, signal, timeoutMs),
        openEvents: (signal) => this.deps.fetch(`${this.baseUrl}/api/event`, { signal, headers: this.headers() }),
        processEnded: this.processEnded,
        isExited: () => this.exited,
        exitMessage: () => this.exitMessage(),
        mcpServers: () => this.mcpServers,
      }, { ...opts, mcp: this.ordewell ?? undefined }, this.role);
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
    const created = await this.json<{ id?: string }>('POST', '/session', { title: SESSION_TITLE[this.role] });
    if (!created?.id) throw new Error(`The OpenCode ${this.role} server did not return a session id.`);
    this.sessionId = created.id;
  }

  commands(): RunnerCommand[] { return this.nativeCommands.map((command) => ({ ...command })); }

  private async loadCommands(): Promise<void> {
    // OpenCode 2.0.28's model route awaits plugin activation; its command and skill routes can return an incomplete startup list.
    if (this.v2) await this.json('GET', '/api/model');
    const prefix = this.v2 ? '/api' : '';
    const listed = await this.json<unknown>('GET', `${prefix}/command`).catch(() => null);
    const skills = await this.json<unknown>('GET', `${prefix}/skill`).catch(() => null);
    const entries = (value: unknown): unknown[] | null => {
      const data = this.v2 && value && typeof value === 'object' ? (value as { data?: unknown }).data : value;
      return Array.isArray(data) ? data : null;
    };
    const commands = entries(listed);
    const skillList = entries(skills);
    if (!commands && !skillList) return;
    // Checked on 1.18.34 and 2.0.28: TUI-only built-ins have no command API; compaction has its own session route.
    this.nativeCommands = [{ name: 'compact', description: 'Compact the conversation context', kind: 'builtin', aliases: ['summarize'] }];
    for (const entry of commands ?? []) {
      if (!entry || typeof entry !== 'object') continue;
      const command = entry as { name?: unknown; description?: unknown; source?: unknown };
      const name = command.name;
      if (typeof name !== 'string' || this.nativeCommands.some((c) => c.name === name || c.aliases?.includes(name))) continue;
      this.nativeCommands.push({ name, description: typeof command.description === 'string' ? command.description : '', kind: command.source === 'skill' ? 'skill' : 'command' });
    }
    for (const entry of skillList ?? []) {
      if (!entry || typeof entry !== 'object') continue;
      const skill = entry as { name?: unknown; id?: unknown; description?: unknown };
      const name = skill.name;
      if (typeof name !== 'string' || this.nativeCommands.some((c) => c.name === name || c.aliases?.includes(name))) continue;
      this.nativeSkills.set(name, typeof skill.id === 'string' ? skill.id : name);
      this.nativeCommands.push({ name, description: typeof skill.description === 'string' ? skill.description : '', kind: 'skill' });
    }
    const servers = this.v2 ? await this.v2McpStatus() : await this.json<Record<string, { status?: string }>>('GET', '/mcp').catch(() => null);
    this.loaded = { commands: this.commands(), mcpServers: Object.entries(servers ?? {}).filter(([name]) => name !== 'ordewell').map(([name, state]) => ({ name, ...(state.status ? { status: state.status } : {}) })) };
  }

  async invokeCommand(name: string, args: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    const command = this.nativeCommands.find((entry) => entry.name === name || entry.aliases?.includes(name));
    if (!command) { onEvent({ type: 'error', message: `OpenCode did not report command /${name}.` }); return; }
    this.emitLoaded(onEvent);
    if (this.v2) {
      await this.v2.invokeCommand(command.name, args, onEvent, signal, this.nativeSkills.get(command.name));
      if (signal?.aborted) this.dispose();
      return;
    }
    if (!this.task || !this.baseUrl || !this.sessionId) throw new Error('OpenCode task session is not started');
    await this.sendTask(this.task, args, onEvent, signal, undefined, { name: command.name, args });
  }

  private emitLoaded(onEvent: (event: AgentEvent) => void): void {
    if (!this.loaded) return;
    onEvent({ type: 'runner_loaded', ...this.loaded });
    this.loaded = null;
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    if (!this.baseUrl || !this.sessionId) throw new Error(`OpenCode ${this.role} session is not started`);
    this.emitLoaded(onEvent);
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
    const stream = await this.openStream(turn, onEvent, onActivity);

    try {
      const model = this.planner?.model ? splitModelId(this.planner.model) : null;
      const body = {
        parts: [{ type: 'text', text: message }],
        // The read-only guarantee: OpenCode's own plan agent has no write tools.
        agent: 'plan',
        tools: DISABLED_TOOLS,
        ...(model ? { model } : {}),
        ...(this.planner?.effort ? { variant: this.planner.effort } : {}),
        ...(this.planner ? plannerSystem(this.planner) : {}),
      };
      const reply = await Promise.race([this.json<OpenCodeMessageResponse>('POST', `/session/${this.sessionId}/message`, body, signal, null), stream.failed]);

      if (signal?.aborted) { this.dispose(); return; }
      this.settle(reply, turn, onEvent);
    } catch (err) {
      if (signal?.aborted) { this.dispose(); return; }
      if (stream.broken) throw err;
      // The POST is the turn's transport, not its work: the server plans on
      // regardless of what happened to this socket. So a transport failure
      // reads the reply back out of the session rather than losing a turn the
      // server already finished (or is still finishing).
      const recovered = this.exited ? null : await this.recoverReply(signal, onActivity);
      if (recovered) { this.settle(recovered, turn, onEvent); return; }
      onEvent({ type: 'error', message: `The OpenCode planner turn failed: ${describeError(err)}` });
    } finally {
      await stream.close();
    }
  }

  /**
   * One task turn. `prompt_async` only queues the work, so the turn is over
   * when the session goes idle — OpenCode's own `run` rules: an idle frame
   * counts once `/session/status` confirms it, because a late idle can belong
   * to the turn before, and {@link pollStatus} stands behind the stream,
   * which can miss a status frame. No request is held open for the turn, so
   * fetch's 300s header timeout, the planner's reason for
   * {@link recoverReply}, never applies — except to a native command, whose
   * POST is held and is followed by {@link heldPost}.
   */
  private async sendTask(
    task: TaskStartOptions,
    message: string,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
    onActivity?: () => void,
    command?: { name: string; args: string },
  ): Promise<void> {
    const state = newTurnState();
    this.outcome.open();
    const turn: TaskTurn = Object.assign(turnLatch(), { userMessages: new Set<string>(), failure: null, messageError: null, messageAborted: false });
    this.taskTurn = turn;
    const stream = await this.openStream(state, onEvent, onActivity);
    const poll = new AbortController();

    try {
      try {
        if (command) {
          const post = this.commandPost(task, command, onEvent, signal);
          if (!post) return;
          void this.pollStatus(turn, poll.signal);
          const held = await this.heldPost(post, turn);
          if (signal?.aborted) { this.dispose(); return; }
          // An interrupted command's reply is the abort, not the turn's end: the idle after it is.
          if (held.kind === 'answered' && !this.outcome.requested) {
            this.permissions.endTurn(onEvent);
            if (command.name !== 'compact') this.settle(held.value as OpenCodeMessageResponse | null, state, onEvent);
            else if (held.value === true) onEvent({ type: 'turn_end' });
            else onEvent({ type: 'error', message: 'OpenCode did not compact the session.' });
            return;
          }
          if (held.kind === 'refused') {
            this.permissions.endTurn(onEvent);
            onEvent({ type: 'error', message: `OpenCode did not take the message: ${describeError(held.reason)}` });
            return;
          }
        } else {
          await this.json('POST', `/session/${this.sessionId}/prompt_async`, this.taskPromptBody(task, message), signal);
        }
      } catch (err) {
        if (signal?.aborted) { this.dispose(); return; }
        onEvent({ type: 'error', message: `OpenCode did not take the message: ${describeError(err)}` });
        return;
      }

      if (!command) void this.pollStatus(turn, poll.signal);
      const settled = await settleTurn(turn, {
        signal,
        processEnded: this.processEnded,
        streamFailed: stream.failed,
        exitMessage: () => this.exitMessage(),
        readBack: () => this.readBack(state, onEvent),
        permissions: this.permissions,
        outcome: () => {
          // 1.x names no end status. The abort the interrupt asked for is no failure of the turn, but an error of its own is.
          const failure = turn.failure ?? (turn.messageAborted && this.outcome.requested ? null : turn.messageError);
          return this.outcome.settle('completed', failure ? { message: failure } : undefined);
        },
      }, onEvent);
      // A turn that ends with a message the model never read leaves it stored
      // server-side. Drop it so Ordewell re-sends it as the next turn (ADR-0023,
      // D4) and delete the stored copy so that re-send does not duplicate it.
      if (settled) this.dropUnreadSteers(onEvent);
      else this.dispose();
    } finally {
      this.steers.drain();
      this.manualCompaction = false;
      this.taskTurn = null;
      poll.abort();
      await stream.close();
    }
  }

  /**
   * The POST of a native command, or null when it was refused before sending
   * (and said so). Unlike `prompt_async`, `/command` and `/summarize` answer
   * only when the turn is done, so the request carries no deadline.
   */
  private commandPost(task: TaskStartOptions, command: { name: string; args: string }, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<unknown> | null {
    if (command.name !== 'compact') {
      return this.json<OpenCodeMessageResponse>('POST', `/session/${this.sessionId}/command`, {
        command: command.name, arguments: command.args, agent: task.flags.permissionMode,
        ...(task.model ? { model: task.model } : {}),
        ...(task.flags.effort ? { variant: task.flags.effort } : {}),
      }, signal, null);
    }
    if (command.args.trim()) { onEvent({ type: 'error', message: 'OpenCode native compaction does not accept arguments.' }); return null; }
    const model = task.model ? splitModelId(task.model) : null;
    if (!model) { onEvent({ type: 'error', message: 'OpenCode 1.x compaction requires an assigned model.' }); return null; }
    this.manualCompaction = true;
    return this.json<boolean>('POST', `/session/${this.sessionId}/summarize`, { ...model, auto: false }, signal, null);
  }

  /**
   * How a command turn's held POST came out. A socket that died under it says
   * nothing about the turn — the server works on regardless, as it does for
   * the planner's {@link recoverReply} — so that, like the session going idle
   * first, leaves the turn to the idle wait. Only a server's refusal, or a
   * transport that failed with the session never seen working, is the
   * message not having been taken.
   */
  private async heldPost<T>(post: Promise<T | null>, turn: TaskTurn): Promise<{ kind: 'answered'; value: T | null } | { kind: 'refused'; reason: unknown } | { kind: 'lost' }> {
    const outcome = post.then(
      (value) => ({ kind: 'answered' as const, value }),
      async (reason: unknown) => {
        if (reason instanceof OpenCodeHttpError) return { kind: 'refused' as const, reason };
        if (this.outcome.requested || turn.live) return { kind: 'lost' as const };
        if (await this.sessionBusy() === true) { turn.live = true; return { kind: 'lost' as const }; }
        return { kind: 'refused' as const, reason };
      },
    );
    return Promise.race([outcome, turn.ended.then(() => ({ kind: 'lost' as const }))]);
  }

  /**
   * The prompt that carries a task message: the mode as the agent, the task
   * model and effort, and only `question` withheld. A steer names its own
   * `messageID` so the frames can be told apart from the first prompt's. Every
   * prompt carries the completion contract as its `system`, which the server
   * keeps whole where it summarises the messages themselves.
   */
  private taskPromptBody(task: TaskStartOptions, message: string, messageID?: string): Record<string, unknown> {
    const model = task.model ? splitModelId(task.model) : null;
    return {
      parts: [{ type: 'text', text: message }],
      // The manifest's meaning of the task's mode (ADR-0001): for OpenCode a mode is an agent.
      agent: task.flags.permissionMode,
      tools: readOnlyTask(task) ? READ_ONLY_DISABLED_TOOLS : TASK_DISABLED_TOOLS,
      ...(task.mcp ? { system: taskCompletionContract(task) } : {}),
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
    if (this.v2 || !task || !this.process || !this.sessionId || this.exited || !turn || turn.done || this.outcome.requested) return false;
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
   * emitted once, so a turn the stream saw whole adds nothing here; a text
   * part whose completion was lost completes as the run its deltas streamed
   * under, its part's id; one that lost every frame still reaches the
   * plain-text channel, which a summary falls back to.
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
      turn.messageAborted = props.info.error?.name === ABORTED;
    } else if (frame.type === 'session.error' && props.error) {
      // An overflowing context is compacted and the turn carries on; when it
      // cannot be, the message itself carries the error.
      if (props.error.name !== 'ContextOverflowError' && !(props.error.name === ABORTED && this.outcome.requested)) turn.failure = errorText(props.error);
      void this.confirmIdle(turn);
    }
  }

  /** Only 2.x streams a step's start and end; 1.x has none to wait on. */
  stepEnded(timeoutMs: number): Promise<boolean> {
    return this.v2 && !this.exited ? this.v2.stepEnded(timeoutMs) : Promise.resolve(true);
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
    this.outcome.request();
    const posted = await this.json('POST', `/session/${this.sessionId}/abort`, undefined, undefined, timeoutMs).then(() => true, () => false);
    if (!posted) {
      this.outcome.refused();
      return false;
    }
    if (!turn || turn.done) return true;
    // Whatever the turn had shown so far, the idle after an abort is its end.
    turn.live = true;
    void this.confirmIdle(turn);
    return interruptAcknowledged(turn, this.processEnded, timeoutMs);
  }

  answerPermission(id: string, decision: ApprovalDecision): boolean | Promise<boolean> {
    if (this.v2) return this.process ? this.v2.answerPermission(id, decision) : false;
    return this.process ? this.permissions.answerAsync(id, decision) : false;
  }

  /**
   * OpenCode 2.x replaced the 1.x HTTP surface rather than extending it, and
   * only 2.x answers `/api/info` with its version. A 1.x server — or one that
   * answers with anything else — keeps the 1.x protocol this class speaks.
   */
  private async v2Version(): Promise<string | null> {
    const info = await this.json<{ version?: unknown }>('GET', '/api/info').catch(() => null);
    return typeof info === 'object' && info !== null && typeof info.version === 'string' ? info.version : null;
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
      if (signal?.aborted || this.exited || this.isDisposed || !this.sessionId) return null;
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
      const model = flatModelId(state?.metadata?.model?.providerID, state?.metadata?.model?.modelID);
      this.subagents.start({ id: callId, brief: subagentBrief(state?.input), model }, onEvent);
      for (const frame of held) this.onFrame(frame, turn, onEvent);
    }
    const status = state?.status;
    if (status === 'completed' || status === 'error') {
      this.subagents.finish(callId, { success: status === 'completed' }, taskDigest(state?.output ?? state?.error ?? ''), onEvent);
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
    if (frame.type === 'session.compacted' && session === this.sessionId) {
      onEvent({ type: 'compaction', trigger: this.manualCompaction ? 'manual' : 'auto' });
      // OpenCode states no size after it: the next call's usage is the first.
      onEvent({ type: 'usage', record: { source: 'opencode', compacted: true } });
      return;
    }
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

  /** A planner's request is held for its envelope (ADR-0026); a task's is answered at once or left open for a card. */
  private onPermissionAsked(ask: OpenCodePermissionAsk, seen: Set<string>, onEvent: (e: AgentEvent) => void): void {
    const id = ask.id;
    if (!id) return;
    const name = permissionName(ask);
    raiseOnce(this.permissions, {
      id,
      name,
      detail: permissionDetail(ask),
      input: ask.metadata ?? {},
      // The patterns `always` would grant: the runner's own offer, and the only grounds for "Allow for this task".
      ...(ask.always?.length ? { suggestions: ask.always } : {}),
      ...(ask.tool?.callID ? { toolUseId: ask.tool.callID } : {}),
      ...(!this.task || readOnlyTask(this.task) ? { ask: openCodePlannerAsk(name, ask, this.mcpServers, false, this.planner?.readsAsk === true) } : {}),
      ordewell: !!this.ordewell && OPENCODE_ORDEWELL.isOrdewellAsk(name),
    }, ask.sessionID ?? this.sessionId ?? '', seen, onEvent);
  }

  /**
   * `POST /permission/:id/reply` is the current answer. The per-session path
   * it replaced is tried only when a server too old to know the new one 404s.
   */
  private async replyPermission(id: string, sessionId: string, reply: { reply: PermissionAnswer; message?: string }): Promise<void> {
    const response = await this.request('POST', `/permission/${id}/reply`, reply);
    const delivered = response.status === 404
      ? await this.request('POST', `/session/${sessionId}/permissions/${id}`, { response: reply.reply })
      : response;
    if (!delivered.ok) throw new Error(`OpenCode permission reply failed: ${delivered.status} ${delivered.statusText}`);
  }

  /** `/event` for one turn — see {@link openEventStream}. Load-bearing for {@link onPermissionAsked}. */
  private openStream(turn: TurnState, onEvent: (e: AgentEvent) => void, onActivity?: () => void): Promise<EventStream> {
    return openEventStream<OpenCodeEvent>(
      (signal) => this.deps.fetch(`${this.baseUrl}/event`, { signal, headers: this.headers() }),
      (frame) => this.onFrame(frame, turn, onEvent),
      onActivity,
    );
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number | null): Promise<T | null> {
    const response = await this.request(method, path, body, signal, timeoutMs);
    if (!response.ok) throw new OpenCodeHttpError(`${method} ${path} failed: ${response.status} ${response.statusText}`);
    return (await response.json().catch(() => null)) as T | null;
  }

  /** `timeoutMs` null is for a turn's own POST, which the server answers when the turn is done. */
  private request(method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<Response> {
    const deadline = withDeadline(signal, timeoutMs);
    return this.deps.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers({ 'content-type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(deadline.signal ? { signal: deadline.signal } : {}),
    }).finally(deadline.clear);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.authorization ? { ...extra, authorization: this.authorization } : extra;
  }

  nativeSessionId(): string | null { return this.sessionId; }

  version(): string | null { return this.serverVersion; }

  unusableProjectServers(): ProjectMcpServer[] { return this.v2?.unusableProjectServers() ?? []; }

  /** 2.x only: a 1.x server's saved output was never checked, so it is asked about as any outside read. */
  savedOutput(abs: string): boolean { return this.v2?.savedOutput(abs) ?? false; }

  /**
   * Asks the server, which lists every MCP server it has with the state of its
   * connection. On 2.x, connected once the model would be offered the tools.
   */
  async mcpAttached(): Promise<AttachState> {
    const ordewell = this.ordewell;
    if (!ordewell || !this.baseUrl) return 'failed';
    const state = await awaitAttach(async () => {
      if (this.exited) return 'failed';
      const servers = this.v2 ? await this.v2McpStatus() : await this.json<Record<string, { status?: string } | undefined>>('GET', '/mcp').catch(() => null);
      if (servers) this.mcpServers = Object.keys(servers).filter((name) => name !== ordewell.name);
      return OPENCODE_ORDEWELL.attachState(servers?.[ordewell.name]?.status);
    }, MCP_ATTACH_TIMEOUT_MS, MCP_STATUS_POLL_MS, this.processEnded);
    if (state === 'connected' && this.v2) await new Promise((resolve) => setTimeout(resolve, V2_TOOLS_OFFERED_MS));
    return state;
  }

  /** 2.x lists its servers as `{ name, status: { status } }`, and only once it has started connecting them. */
  private async v2McpStatus(): Promise<Record<string, { status?: string }> | null> {
    const listed = await this.json<{ data?: { name?: unknown; status?: { status?: unknown } }[] }>('GET', '/api/mcp').catch(() => null);
    if (!Array.isArray(listed?.data)) return null;
    const servers: Record<string, { status?: string }> = {};
    for (const { name, status } of listed.data) {
      if (typeof name === 'string') servers[name] = typeof status?.status === 'string' ? { status: status.status } : {};
    }
    return servers;
  }

  override dispose(): void {
    if (this.isDisposed) return;
    // The server is gone with its session; its stored messages are unreachable.
    this.steers.drain();
    this.baseUrl = null;
    // A surviving server keeps the port and the session.
    super.dispose();
  }

  protected exitMessage(): string {
    return this.runner.withStderrTail(`The OpenCode ${this.role} server exited.`);
  }
}
