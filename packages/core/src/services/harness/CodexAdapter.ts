import { randomUUID } from 'crypto';
import { isAbsolute, relative, sep } from 'path';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, TaskModeAgentAdapter } from './AgentAdapter';
import type { SubagentOutcome } from '../../models/Task';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { UsageRecord } from '../../models/Usage';
import { StdioAgentAdapter, type SpawnSpec } from './StdioAgentAdapter';
import { markedLines } from './fileDiff';
import { probeCodexSandbox, codexSandboxUnavailableMessage, type CodexSandboxDecision } from './codexSandbox';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp';
import { CODEX_ORDEWELL } from './codexOrdewell';
import { awaitAttach, type AttachState } from './ordewellBinding';
import { CodexRpc, type RpcMessage, type RpcResponse } from './codexRpc';
import { settleWithin } from './settleWithin';

const HANDSHAKE_TIMEOUT_MS = 30000;
/** Codex starts a thread's MCP servers as the thread opens; one that is not up by now is not coming. */
const MCP_ATTACH_TIMEOUT_MS = 10_000;

/**
 * One entry of a Codex turn. Field names are the app-server protocol's, taken
 * from `codex app-server generate-json-schema`, not invented here.
 */
interface ThreadItem {
  id?: string;
  type?: string;
  text?: string;
  /** Reasoning carries arrays of blocks, not a string — see `flattenText`. */
  summary?: unknown;
  content?: unknown;
  command?: string | string[];
  cwd?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  status?: string;
  success?: boolean;
  query?: string;
  /** `final_answer` vs `commentary`; both are prose the user should see. */
  phase?: string;
  /** `collabAgentToolCall`: the brief a spawned subagent was given. */
  prompt?: string | null;
  /** `collabAgentToolCall`: the model a spawned subagent runs. */
  model?: string | null;
  /** `collabAgentToolCall`: threads on the receiving end of the call. */
  receiverThreadIds?: string[];
  /** `fileChange`: the files the patch touches. */
  changes?: FileUpdateChange[];
  /** `collabAgentToolCall`: last known status of each target thread. */
  agentsStates?: Record<string, { status?: string; message?: string | null } | undefined>;
  /** `userMessage`: the `clientUserMessageId` the input was steered under. */
  clientId?: string | null;
}

/** A message steered into a turn (ADR-0023), until its `userMessage` item shows the model has it. */
interface Steer {
  /** The session's id for the message. */
  id: string;
  /** Codex answered the `turn/steer` with the turn's id. */
  accepted: boolean;
  settle(accepted: boolean): void;
}

interface CodexTurn {
  /** Arrives with `turn/started` or the `turn/start` response, whichever lands first. */
  id: string | null;
  /** By the `clientUserMessageId` each was sent under. */
  steers: Map<string, Steer>;
  /** Steers asked for before Codex named the turn, sent once it does. */
  onNamed: Array<() => void>;
}

interface FileUpdateChange {
  path?: string;
  kind?: { type?: string; move_path?: string | null };
  diff?: string;
}

/** A row's name is the change in Codex's own patch vocabulary, not a tool it did not call (ADR-0009). */
const CHANGE_NAMES: Record<string, string> = { add: 'Add', update: 'Update', delete: 'Delete' };

function changeName(change: FileUpdateChange): string {
  return CHANGE_NAMES[change.kind?.type ?? ''] ?? 'file_change';
}

/**
 * Codex's `diff` is a hunk only for an update: an added file arrives as its
 * whole content and a deleted one as what it held.
 */
function changeDiff(change: FileUpdateChange): string {
  const diff = change.diff ?? '';
  if (change.kind?.type === 'add') return markedLines(diff, '+');
  if (change.kind?.type === 'delete') return markedLines(diff, '-');
  return diff;
}

/** One model call's usage, from `thread/tokenUsage/updated` — see {@link emitUsage}. */
interface TokenUsageBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

interface ThreadTokenUsageParams {
  threadId?: string;
  tokenUsage?: {
    last?: TokenUsageBreakdown;
    modelContextWindow?: number | null;
  };
}

/**
 * The terminal `CollabAgentStatus` a subagent has reached, or undefined while it
 * is still working. `notFound` is terminal the only way it can be: the thread
 * the planner asked about is not there, so the work will not report.
 */
function subagentOutcome(status: string | undefined): SubagentOutcome | undefined {
  switch (status) {
    case 'completed': return 'done';
    case 'errored':
    case 'notFound': return 'failed';
    case 'interrupted':
    case 'shutdown': return 'stopped';
    default: return undefined;
  }
}

/**
 * Codex carries prose as arrays of blocks — `reasoning.summary`, and the
 * `content` of an MCP tool result — where each block is a string or an object
 * with a `text` field. Reading them as plain strings produced empty thinking
 * events against the real CLI, which is why this exists.
 */
function flattenText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') return text;
    const content = (value as { content?: unknown }).content;
    if (content !== undefined) return flattenText(content);
  }
  return '';
}

/**
 * Server→client requests that carry a refusal in their own result schema, and
 * the exact payload that expresses it. Anything not listed here is refused with
 * a JSON-RPC error instead — see {@link CodexAdapter.answerServerRequest}.
 */
const DECLINE_RESULTS: Record<string, Record<string, unknown>> = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'mcpServer/elicitation/request': { action: 'decline' },
  // The pre-`item/*` spellings, still emitted by older app-servers.
  execCommandApproval: { decision: 'denied' },
  applyPatchApproval: { decision: 'denied' },
};

/**
 * The task-mode requests a person can answer (ADR-0018, A1): how each is
 * named in the timeline, the session-wide grant "Allow for this task" stands
 * for where the protocol has one, and the answer each decision becomes in the
 * request's own result schema.
 */
interface TaskApproval {
  name: string;
  forSession?: Record<string, unknown>;
  answer(decision: ApprovalDecision['decision'], params: Record<string, unknown>): Record<string, unknown>;
}

/**
 * The name Codex shows an Ordewell tool under, as Claude Code's CLI does, so
 * the task log and the planner's research steps read the same on every runner.
 */
function shownToolName(item: ThreadItem): string {
  const tool = item.tool ?? 'mcp_tool';
  return item.server === ORDEWELL_MCP_SERVER_NAME ? CODEX_ORDEWELL.toolName(tool) : tool;
}

const REVIEW_DECISIONS = { allow: 'accept', allowForTask: 'acceptForSession', deny: 'decline' } as const;

const TASK_APPROVALS: Record<string, TaskApproval> = {
  'item/commandExecution/requestApproval': {
    name: 'shell',
    forSession: { decision: 'acceptForSession' },
    answer: (decision) => ({ decision: REVIEW_DECISIONS[decision] }),
  },
  'item/fileChange/requestApproval': {
    name: 'file_change',
    forSession: { decision: 'acceptForSession' },
    answer: (decision) => ({ decision: REVIEW_DECISIONS[decision] }),
  },
  // A denial grants nothing rather than refusing: the schema has no "no".
  'item/permissions/requestApproval': {
    name: 'permissions',
    forSession: { scope: 'session' },
    answer: (decision, params) => (decision === 'deny'
      ? { permissions: {}, scope: 'turn' }
      : { permissions: params.permissions ?? {}, scope: decision === 'allowForTask' ? 'session' : 'turn' }),
  },
  // Only the yes-or-no kind reaches here — see `isYesNoElicitation`. MCP has
  // no session-wide answer.
  'mcpServer/elicitation/request': {
    name: 'mcp_elicitation',
    answer: (decision) => (decision === 'deny' ? { action: 'decline', content: null } : { action: 'accept', content: {} }),
  },
};

/**
 * An elicitation whose form asks for nothing is a yes-or-no question an
 * approval card can answer. One that asks for fields, or sends the user to a
 * URL, is a structured question, refused like `requestUserInput`.
 */
function isYesNoElicitation(params: Record<string, unknown>): boolean {
  const schema = params.requestedSchema as { properties?: Record<string, unknown> } | undefined;
  return params.mode === 'form' && Object.keys(schema?.properties ?? {}).length === 0;
}

/** Plain-text questions for now (#54): a structured one would wait on a form no surface renders. */
const ASK_IN_PLAIN_TEXT = 'Ordewell cannot show structured questions. Ask in plain text in your reply instead, then end your turn; the answer arrives as the next message.';

function landlockFallbackNote(role: 'planner' | 'task'): string {
  return [
    role === 'task'
      ? "Codex's bubblewrap sandbox cannot create user namespaces on this machine, so this task runs under its legacy Landlock backend."
      : "Codex's bubblewrap sandbox cannot create user namespaces on this machine, so planning fell back to its legacy Landlock backend.",
    role === 'task'
      ? 'The sandbox still holds, but that backend is deprecated upstream. To fix the host:'
      : 'Exploration works and writes are still denied, but that backend is deprecated upstream. To fix the host:',
    '  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
  ].join('\n');
}

/** Requests worth showing in the timeline: the planner reached for something it may not have. */
const ANNOUNCED_REQUESTS = new Set([
  ...Object.keys(DECLINE_RESULTS),
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'item/tool/call',
]);

/**
 * Codex as a planner (ADR-0009) and as a task's runner (ADR-0018, #54), over
 * its `app-server` stdio JSON-RPC transport. The start switch decides the
 * thread's settings and who answers its requests; everything a turn reports
 * is read the same way for both.
 *
 * Ordewell already speaks a slice of this protocol — `ModelDiscovery` drives
 * `initialize` → `model/list` to build the Codex model catalog — so the
 * handshake here is that one continued into a thread.
 *
 * Codex's own CLI marks `app-server` experimental, and it is the transport
 * most likely to drift: the method names below (`thread/start`, `turn/start`,
 * `item/completed`) come from the schema the installed binary generates, and a
 * version that renames them will surface as a visible dead turn rather than a
 * hang, because the base class watches the process as well as the protocol.
 */
export class CodexAdapter extends StdioAgentAdapter implements TaskModeAgentAdapter {
  readonly agentId = 'codex';

  private threadId: string | null = null;
  /** The model Codex opened the thread with — usage records name it. */
  private threadModel: string | null = null;
  private readonly rpc = new CodexRpc((payload) => this.writeLine(payload));
  private startOpts: AgentStartOptions | null = null;
  /** Whether this turn has already emitted prose — see the `agentMessage` case. */
  private turnHasText = false;
  /** The turn in flight. `turn/interrupt` and `turn/steer` cannot be sent before it has an id. */
  private turn: CodexTurn | null = null;
  /** The last turn this adapter ended — so its second end signal, landing late, ends nothing. */
  private endedTurnId: string | null = null;
  /** An interrupt was asked for during this turn, so however it ends, it was cut short. */
  private interruptRequested = false;
  /**
   * Turns an interrupt cut short. Codex leaves their command running and
   * reports it when it ends, inside whatever turn is live by then — a report
   * that belongs to no turn of the agent's any more (ADR-0023, F4).
   */
  private readonly interruptedTurnIds = new Set<string>();
  /** A task's approval requests still waiting for an answer, by the request id as a string. */
  private readonly openPermissions = new Map<string, { requestId: number | string; method: string; params: Record<string, unknown> }>();
  /** The tool each MCP server's latest call is for, which names the tool an approval asks about when its question does not. */
  private readonly mcpCallsInProgress = new Map<string, string>();
  /**
   * The files each in-flight `fileChange` item touches. Its approval request
   * names only the item, and a person deciding needs to see the files.
   */
  private readonly fileChangePaths = new Map<string, string[]>();
  /** The row each announced file of an in-flight `fileChange` item is shown under, by the file's shown path. */
  private readonly fileChangeRows = new Map<string, Map<string, string>>();
  private sandbox: CodexSandboxDecision = 'default';
  /** The Ordewell server's startup state, as Codex last reported it for this thread. */
  private mcpStartup: string | null = null;
  private mcpStartupSettled: (() => void) | null = null;
  /**
   * Subagent threads this session has spawned, keyed by the child thread id.
   * Codex runs a subagent in its own thread and replays both threads' events on
   * one stream; the thread id is what tells them apart (see {@link subagentOf}).
   */
  private readonly subagents = new Map<string, { model?: string }>();

  constructor(deps: AgentProcessDeps) {
    super(deps);
    void this.processEnded.then(() => this.rpc.close('The Codex app-server process ended.'));
  }

  protected spawnSpec(opts: AgentStartOptions): SpawnSpec {
    this.startOpts = opts;
    return { command: 'codex', args: ['app-server'], ...(opts.mcp ? { env: CODEX_ORDEWELL.env(opts.mcp) } : {}) };
  }

  /**
   * `initialize`, then `thread/start`, both before the first user message. A
   * planner's thread is pinned to the read-only sandbox with approvals set to
   * `never` — with nobody watching a planner's prompts, "ask" would mean
   * "hang", which is ADR-0008's absent-is-denial invariant kept by
   * construction. A task's runs as its mode says (see {@link threadParams}).
   */
  protected async handshake(opts: AgentStartOptions): Promise<void> {
    // Before the protocol, the machine: a Codex whose sandbox cannot start runs
    // no command and works from imagination instead of from the repository.
    this.sandbox = await probeCodexSandbox(this.deps, opts.cwd, this.spawnEnv);
    // A full-access task asks for no sandbox, so a host without one is no reason to refuse it.
    const needsSandbox = opts.kind === 'planner' || opts.flags.permissionMode !== 'danger-full-access';
    if (this.sandbox === 'unavailable' && needsSandbox) throw new Error(codexSandboxUnavailableMessage(opts.kind));

    // A binary that rejects `app-server` outright dies immediately; waiting
    // out the timeout would turn a one-line diagnostic into a 30s stall.
    const incomplete = () => { throw this.handshakeIncomplete(); };
    await settleWithin(this.openThread(opts), { timeoutMs: HANDSHAKE_TIMEOUT_MS, ended: this.processEnded, onTimeout: incomplete, onEnded: incomplete });
  }

  private handshakeIncomplete(): Error {
    return new Error(`The Codex app-server did not complete its handshake.\n\n${this.exitMessage()}`);
  }

  /**
   * Open this session's thread. A resume id means the previous
   * process died mid-session: `thread/resume` puts the agent back in front of
   * the context it already paid to read. A planner's failed resume is not an
   * error — it falls back to a fresh thread, which is the same degradation
   * `restoreChat` performs on every surface (T4). A task's is: Continue (K1)
   * offers the session that did the work, and a fresh thread in its place
   * would pretend it was resumed.
   */
  private async openThread(opts: AgentStartOptions): Promise<void> {
    const initialized = await this.rpc.call('initialize', { clientInfo: { name: 'ordewell', title: 'Ordewell', version: '0.1.0' } });
    if (!initialized.ok) {
      throw initialized.closed ? this.handshakeIncomplete() : new Error(`The Codex app-server rejected initialize: ${initialized.message ?? 'unknown error'}`);
    }

    const resumeId = opts.resumeSessionId;
    let opened = await this.requestThread(resumeId);
    if ('reason' in opened && resumeId) {
      if (opts.kind === 'task') throw new Error(`Codex could not resume thread ${resumeId}: ${opened.reason}`);
      opened = await this.requestThread();
    }
    if ('reason' in opened) throw new Error(`The Codex app-server could not start a thread: ${opened.reason}`);
    this.threadId = opened.id;
    this.sessionId = opened.id;
    this.threadModel = opened.model;
  }

  private async requestThread(resumeSessionId?: string): Promise<{ id: string; model: string | null } | { reason: string }> {
    const response = await this.rpc.call(resumeSessionId ? 'thread/resume' : 'thread/start', {
      ...(resumeSessionId ? { threadId: resumeSessionId } : {}),
      ...this.threadParams(),
    });
    if (!response.ok && response.closed) throw this.handshakeIncomplete();
    const thread = response.ok ? response.result.thread as { id?: string } | undefined : undefined;
    if (!thread?.id) return { reason: (!response.ok && response.message) || 'no thread id returned' };
    const model = response.ok ? response.result.model : undefined;
    return { id: thread.id, model: typeof model === 'string' ? model : null };
  }

  private threadParams(): Record<string, unknown> {
    const opts = this.startOpts;
    const common = {
      cwd: opts?.cwd,
      ...(opts?.model ? { model: opts.model } : {}),
    };
    const config = {
      ...(this.sandbox === 'legacy-landlock' ? { features: { use_legacy_landlock: true } } : {}),
      ...(opts?.mcp ? { mcp_servers: CODEX_ORDEWELL.threadServers(opts.mcp) } : {}),
    };
    const threadConfig = Object.keys(config).length ? { config } : {};
    if (opts?.kind === 'task') {
      // What the mode means is the manifest's (ADR-0001); this only spells it
      // in the protocol. No `developerInstructions`: the task prompt is the
      // first turn.
      const { approvalPolicy, approvalsReviewer } = opts.flags.modeSettings;
      return {
        ...common,
        sandbox: opts.flags.permissionMode,
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(approvalsReviewer ? { approvalsReviewer } : {}),
        ...(opts.mcp ? { developerInstructions: CODEX_ORDEWELL.taskInstructions() } : {}),
        ...threadConfig,
      };
    }
    return {
      ...common,
      sandbox: 'read-only',
      // `on-request`, so a user's MCP tool reaches the planner's envelope as an approval
      // (ADR-0026); under `never` Codex fails the call without asking. Commands and file
      // changes it asks about are still declined: the sandbox holds, and commands go
      // through Ordewell's `run_command`.
      approvalPolicy: 'on-request',
      ...threadConfig,
      // `developerInstructions` layers on top of Codex's own base prompt, the
      // way Claude Code's `--append-system-prompt` does. `baseInstructions`
      // replaces it — which takes Codex's description of its own tools with
      // it, and a planner that has forgotten it can read the workspace
      // answers from a web search instead.
      developerInstructions: [opts?.systemPrompt, opts?.mcp ? CODEX_ORDEWELL.plannerInstructions() : ''].filter(Boolean).join('\n\n') || undefined,
    };
  }

  /**
   * Codex's own startup report for the server, which it sends once the thread
   * has tried to connect (ADR-0022, S4). A report that came before this was
   * asked is kept, so asking late still gets the answer.
   */
  async mcpAttached(): Promise<boolean> {
    if (!this.startOpts?.mcp || !this.process) return false;
    return awaitAttach(async (left) => {
      const known = CODEX_ORDEWELL.attachState(this.mcpStartup);
      if (known !== 'pending') return known;
      const reported = new Promise<AttachState>((resolve) => { this.mcpStartupSettled = () => resolve(CODEX_ORDEWELL.attachState(this.mcpStartup)); });
      const state = await settleWithin(reported, {
        timeoutMs: left,
        ended: this.processEnded,
        onTimeout: () => CODEX_ORDEWELL.attachState(this.mcpStartup),
        onEnded: (): AttachState => 'failed',
      });
      this.mcpStartupSettled = null;
      return state;
    }, MCP_ATTACH_TIMEOUT_MS, 0);
  }

  private effort(): string | undefined {
    const opts = this.startOpts;
    return opts?.kind === 'task' ? opts.flags.effort : opts?.effort;
  }

  /**
   * `turn/interrupt` names the turn as well as the thread, so an interrupt
   * asked for before Codex has named the turn waits for it, as a steer does.
   * Codex acknowledges with an empty result, then ends the turn as `interrupted`.
   */
  interrupt(timeoutMs: number): Promise<boolean> {
    const turn = this.turn;
    if (!this.process || !turn) return Promise.resolve(false);
    this.interruptRequested = true;
    const acknowledged = new Promise<boolean>((resolve) => {
      this.whenNamed(turn, () => this.rpc.send('turn/interrupt', { threadId: this.threadId, turnId: turn.id }, (response) => resolve(response.ok)));
    });
    return settleWithin(acknowledged, { timeoutMs, ended: this.processEnded, onTimeout: () => false, onEnded: () => false });
  }

  /** Run `send` now if Codex has named the turn, and once it does if not. */
  private whenNamed(turn: CodexTurn, send: () => void): void {
    if (turn.id) send();
    else turn.onNamed.push(send);
  }

  /**
   * `turn/steer` into the running turn (ADR-0023). Codex answers with the
   * turn's id at once — acceptance, not delivery — and shows the input to the
   * model after the item in flight, as a `userMessage` item carrying the
   * `clientUserMessageId` sent; that item is the delivery. The request needs
   * the turn's id, so a steer asked for before Codex named the turn waits for
   * it, as an interrupt does. Refused when the turn has ended or is another one.
   */
  steer(id: string, text: string): Promise<boolean> {
    const turn = this.turn;
    if (!this.process || !turn) return Promise.resolve(false);
    const clientId = randomUUID();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const steer: Steer = {
        id,
        accepted: false,
        settle: (accepted) => {
          if (settled) return;
          settled = true;
          if (!accepted) turn.steers.delete(clientId);
          resolve(accepted);
        },
      };
      turn.steers.set(clientId, steer);
      const send = () => this.requestSteer(turn.id!, text, clientId, (ok) => {
        // An answer landing after the turn closed is for a steer already refused there.
        if (!ok || this.turn !== turn) {
          steer.settle(false);
          return;
        }
        steer.accepted = true;
        steer.settle(true);
      });
      void this.processEnded.then(() => steer.settle(false));
      this.whenNamed(turn, send);
    });
  }

  /** The one way input reaches a running turn: a task message, or a deny note. */
  private requestSteer(turnId: string, text: string, clientUserMessageId?: string, answered?: (ok: boolean) => void): void {
    this.rpc.send(
      'turn/steer',
      { threadId: this.threadId, expectedTurnId: turnId, input: [{ type: 'text', text }], ...(clientUserMessageId ? { clientUserMessageId } : {}) },
      (response) => answered?.(response.ok),
    );
  }

  /**
   * Answer an open approval in its own result schema. Codex's decline carries
   * no message, so a deny note reaches the agent as input steered into the
   * running turn.
   */
  answerPermission(id: string, decision: ApprovalDecision): boolean {
    const open = this.openPermissions.get(id);
    if (!open || !this.process) return false;
    this.openPermissions.delete(id);
    this.rpc.respond(open.requestId, TASK_APPROVALS[open.method].answer(decision.decision, open.params));
    // A planner's denial note is the envelope's, not a person's message, and stays out of its thread.
    const note = decision.decision === 'deny' && this.role === 'task' ? decision.note?.trim() : undefined;
    if (note && this.turn?.id) this.requestSteer(this.turn.id, note);
    return true;
  }

  protected turnPayload(message: string): string {
    const turn: CodexTurn = { id: null, steers: new Map(), onNamed: [] };
    this.turn = turn;
    this.interruptRequested = false;
    return this.rpc.frame('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: message }],
      ...(this.effort() ? { effort: this.effort() } : {}),
    }, (response, emit) => this.turnAnswered(turn, response, emit));
  }

  /** `turn/start`'s answer. One for a turn that has since closed or been replaced names and closes nothing. */
  private turnAnswered(turn: CodexTurn, response: RpcResponse, emit: (event: AgentEvent) => void): void {
    if (this.turn !== turn) return;
    if (response.ok) {
      this.turnStarted((response.result.turn as { id?: unknown } | undefined)?.id);
    } else if (!response.closed) {
      this.closeTurn(emit);
      emit({ type: 'error', message: `Codex refused the turn: ${response.message ?? 'unknown error'}` });
    }
  }

  protected handleLine(line: string, emit: (event: AgentEvent) => void): void {
    const msg = StdioAgentAdapter.parse<RpcMessage>(line);
    if (!msg) return;

    if (this.rpc.dispatch(msg, emit)) return;

    // Every server→client request — one that carries both a method and an id —
    // gets an answer, because an unanswered one stalls the turn forever. That
    // is ADR-0008's absent-is-denial invariant applied to the whole request
    // surface rather than to the three approval methods that happened to be
    // known when this adapter was written.
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'currentTime/read') {
        // Answered rather than refused: it is not a capability request, and
        // failing it would break a tool for no reason.
        this.rpc.respond(msg.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      } else if (this.startOpts?.kind === 'task') {
        this.openTaskRequest(msg, emit);
      } else {
        this.answerServerRequest(msg, emit);
      }
      return;
    }

    switch (msg.method) {
      case 'item/started':
        if (this.fromInterruptedTurn(msg.params)) return;
        this.emitItemStart(msg.params?.item as ThreadItem | undefined, emit, this.subagentOf(msg.params?.threadId));
        return;
      case 'item/completed':
        if (this.fromInterruptedTurn(msg.params)) return;
        this.emitItemDone(msg.params?.item as ThreadItem | undefined, emit, this.subagentOf(msg.params?.threadId));
        return;
      // Reply text streams before its completed item. The completed item is
      // authoritative — the service replaces the deltas with it — so both are
      // forwarded and no run is counted twice.
      case 'item/agentMessage/delta': {
        const params = msg.params as { threadId?: string; delta?: string } | undefined;
        // A subagent's words are addressed to the planner, not the user: let
        // them through and the planner's reply becomes an answer to a prompt
        // the user never sent.
        if (!params?.delta || this.subagentOf(params.threadId)) return;
        emit({ type: 'assistant_text_delta', text: params.delta });
        return;
      }
      // `summaryTextDelta` streams a reasoning summary part, `textDelta` the raw
      // reasoning. Both are thinking; the completed item repeats whichever it
      // carries and is superseded by what streamed.
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const params = msg.params as { threadId?: string; delta?: string } | undefined;
        if (!params?.delta) return;
        const subagentId = this.subagentOf(params.threadId);
        emit({ type: 'thinking_delta', text: params.delta, ...(subagentId ? { subagentId } : {}) });
        return;
      }
      // Marks where one summary part ends and the next begins. The text arrives
      // as deltas; the boundary carries none of its own.
      case 'item/reasoning/summaryPartAdded':
        return;
      // Codex settled a request itself — the turn it belonged to ended, or its
      // reviewer answered first. One this adapter answered is already closed.
      case 'serverRequest/resolved': {
        const id = String(msg.params?.requestId ?? '');
        if (this.openPermissions.delete(id)) emit({ type: 'permission_cancelled', id });
        return;
      }
      case 'mcpServer/startupStatus/updated': {
        const startup = msg.params as { name?: string; status?: string } | undefined;
        if (startup?.name !== ORDEWELL_MCP_SERVER_NAME || !startup.status) return;
        this.mcpStartup = startup.status;
        this.mcpStartupSettled?.();
        return;
      }
      case 'thread/tokenUsage/updated':
        this.emitUsage(msg.params as ThreadTokenUsageParams | undefined, emit);
        return;
      case 'turn/started': {
        // A subagent runs its own turn in its own thread; its start must not
        // reset the planner turn's paragraph state.
        if (this.subagentOf(msg.params?.threadId)) return;
        this.turnHasText = false;
        const turn = msg.params?.turn as { id?: unknown } | undefined;
        this.turnStarted(turn?.id ?? msg.params?.turnId);
        return;
      }
      // Codex announces a finished turn twice — `turn/completed` and the
      // thread going idle — in either order, and either may come alone. The
      // first ends the turn. An idle before the turn has an id is the previous
      // turn's, arriving late.
      case 'thread/status/changed': {
        const params = msg.params as { threadId?: string; status?: { type?: string } } | undefined;
        if (params?.threadId !== this.threadId || params?.status?.type !== 'idle' || !this.turn?.id) return;
        this.closeTurn(emit);
        emit(this.interruptRequested ? { type: 'turn_end', interrupted: true } : { type: 'turn_end' });
        return;
      }
      // Codex reports a setup problem once, at startup, and then plans anyway.
      // Surfacing it is enough: the warning is not always fatal, and refusing to
      // plan on an unrecognized one would be worse than showing it.
      case 'configWarning': {
        const warning = msg.params as { summary?: string; details?: string } | undefined;
        const text = [warning?.summary, warning?.details].filter(Boolean).join('\n');
        // Codex emits the bubblewrap warning from its default config, before the
        // thread picks a backend, so it arrives even on the Landlock fallback
        // that just fixed it. Passing it through would be a false alarm, and
        // dropping it would hide a host that still needs fixing — Landlock is
        // deprecated upstream, so this is a reprieve, not a repair.
        if (this.sandbox === 'legacy-landlock' && /bubblewrap|user namespace/i.test(text)) {
          emit({ type: 'thinking', text: landlockFallbackNote(this.role) });
          return;
        }
        if (text) emit({ type: 'thinking', text: `Codex configuration warning: ${text}` });
        return;
      }
      // A turn that fails without retry may never reach `turn/completed` — a
      // rate limit or an exhausted context window would otherwise hang until
      // the process died.
      case 'error': {
        // A subagent's failure is reported by its own lifecycle, not by ending
        // the planner's turn: the planner is still working and may recover.
        if (this.subagentOf(msg.params?.threadId)) return;
        const failure = msg.params as { error?: { message?: string }; willRetry?: boolean } | undefined;
        if (failure?.willRetry) return;
        this.closeTurn(emit);
        emit({ type: 'error', message: failure?.error?.message || 'Codex ended the turn with an error.' });
        return;
      }
      case 'turn/completed': {
        // A subagent thread completes independently of the planner's turn.
        // Settling the planner on a child's completion cut the turn short
        // before the planner had read the subagent's report.
        if (this.subagentOf(msg.params?.threadId)) return;
        const turn = msg.params?.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
        if (!this.turn || (turn?.id && turn.id === this.endedTurnId)) return;
        this.closeTurn(emit);
        if (this.interruptRequested || turn?.status === 'interrupted') {
          emit({ type: 'turn_end', interrupted: true });
        } else if (turn?.status === 'failed') {
          emit({ type: 'error', message: turn.error?.message || 'Codex ended the turn with an error.' });
        } else {
          emit({ type: 'turn_end' });
        }
        return;
      }
      // Deltas for command output and MCP progress are skipped: the completed
      // item follows and would otherwise be counted twice.
      default:
        return;
    }
  }

  private turnStarted(id: unknown): void {
    const turn = this.turn;
    if (!turn || turn.id || typeof id !== 'string') return;
    turn.id = id;
    for (const send of turn.onNamed.splice(0)) send();
  }

  /**
   * Ahead of the event that ends the turn: a steer Codex accepted and the turn
   * never consumed is gone — Codex keeps no queue across turns — and one not
   * yet accepted never will be (ADR-0023, D4).
   */
  private closeTurn(emit: (event: AgentEvent) => void): void {
    const turn = this.turn;
    this.endedTurnId = turn?.id ?? null;
    if (turn?.id && this.interruptRequested) this.interruptedTurnIds.add(turn.id);
    this.turn = null;
    if (!turn) return;
    for (const steer of [...turn.steers.values()]) {
      if (steer.accepted) emit({ type: 'message_dropped', id: steer.id });
      else steer.settle(false);
    }
    turn.steers.clear();
  }

  private fromInterruptedTurn(params: Record<string, unknown> | undefined): boolean {
    const turnId = params?.turnId;
    return typeof turnId === 'string' && this.interruptedTurnIds.has(turnId) && !this.subagentOf(params?.threadId);
  }

  /** The `userMessage` item a steer turns into once the item before it completes: the model has it. */
  private steerDelivered({ clientId }: ThreadItem, emit: (event: AgentEvent) => void): void {
    const steer = clientId ? this.turn?.steers.get(clientId) : undefined;
    if (!clientId || !steer) return;
    this.turn?.steers.delete(clientId);
    steer.settle(true);
    emit({ type: 'message_delivered', id: steer.id });
  }

  /**
   * The child thread id when `threadId` names a subagent's thread, or undefined
   * for the planner's own. Codex replays both threads on one stream and only
   * the thread id separates them; the first time a thread is seen it is
   * registered so its usage and steps can be tagged with it as a subagent id.
   */
  private subagentOf(threadId: unknown): string | undefined {
    if (typeof threadId !== 'string' || !this.threadId || threadId === this.threadId) return undefined;
    this.subagents.set(threadId, this.subagents.get(threadId) ?? {});
    return threadId;
  }

  /**
   * One usage record per model call, from `thread/tokenUsage/updated`.
   *
   * The notification carries two breakdowns: `total` is cumulative for the
   * thread and `last` is the model call that just finished (verified against
   * the installed binary — a two-call turn ends with `last` equal to the second
   * call and `total` equal to both summed). Emitting `total` on each update
   * would count every earlier call again, so `last` is the record. Mapping
   * `last.outputTokens` already includes `reasoningOutputTokens` — the thread
   * total is `inputTokens + outputTokens`, not a sum of three — so reasoning is
   * not added a second time. Codex reports no price.
   */
  private emitUsage(params: ThreadTokenUsageParams | undefined, emit: (e: AgentEvent) => void): void {
    const last = params?.tokenUsage?.last;
    if (!last) return;
    const subagentId = this.subagentOf(params?.threadId);
    const record: UsageRecord = { source: this.agentId };
    const model = subagentId ? this.subagents.get(subagentId)?.model : this.threadModel ?? this.startOpts?.model;
    if (model) record.model = model;
    let hasMeasure = false;
    if (last.inputTokens !== undefined) { record.inputTokens = last.inputTokens; hasMeasure = true; }
    if (last.outputTokens !== undefined) { record.outputTokens = last.outputTokens; hasMeasure = true; }
    if (last.cachedInputTokens !== undefined) { record.cachedInputTokens = last.cachedInputTokens; hasMeasure = true; }
    if (!hasMeasure) return;
    if (subagentId) {
      record.subagentId = subagentId;
    } else {
      // A subagent's window says nothing about the planner's own context. A
      // reported window of 0 means "not known", not "no room".
      const window = params?.tokenUsage?.modelContextWindow;
      if (typeof window === 'number' && window > 0) record.contextWindow = window;
    }
    emit({ type: 'usage', record });
  }

  /**
   * A task's server→client request. An approval stays open for someone to
   * answer (ADR-0018, A1); everything else is answered at once, because an
   * unanswered request stalls the turn forever.
   */
  private openTaskRequest(msg: RpcMessage, emit: (e: AgentEvent) => void): void {
    const method = msg.method!;
    const params = msg.params ?? {};
    const approval = TASK_APPROVALS[method];
    if (CODEX_ORDEWELL.isOrdewellAsk({ method, params })) {
      this.rpc.respond(msg.id!, { action: 'accept', content: {} });
      return;
    }
    if (approval && (method !== 'mcpServer/elicitation/request' || isYesNoElicitation(params))) {
      const id = String(msg.id);
      const input = this.approvalInput(method, params);
      this.openPermissions.set(id, { requestId: msg.id!, method, params });
      emit({
        type: 'permission_request',
        id,
        name: approval.name,
        detail: JSON.stringify(input),
        input,
        suggestions: approval.forSession ? [approval.forSession] : [],
        ...(typeof params.itemId === 'string' ? { toolUseId: params.itemId } : {}),
      });
    } else if (method === 'mcpServer/elicitation/request') {
      this.rpc.respond(msg.id!, { action: 'decline', content: null });
    } else {
      this.rpc.respondError(msg.id!, -32601, method === 'item/tool/requestUserInput' ? ASK_IN_PLAIN_TEXT : `Ordewell does not handle ${method}.`);
    }
  }

  /** The request as a person sees it, led by the field that says what it is about. */
  private approvalInput(method: string, params: Record<string, unknown>): Record<string, unknown> {
    const paths = typeof params.itemId === 'string' ? this.fileChangePaths.get(params.itemId) : undefined;
    if (method === 'item/fileChange/requestApproval' && paths?.length) return { path: paths.join(', '), ...params };
    const about = typeof params.reason === 'string' ? params.reason : params.message;
    if (method !== 'item/commandExecution/requestApproval' && typeof about === 'string') return { description: about, ...params };
    return params;
  }

  /**
   * Refuse one server→client request. Requests whose result schema can express
   * a refusal get that payload; everything else — a permission grant, a
   * question for a user who is not watching, a tool call the client is supposed
   * to run — gets a JSON-RPC error, which Codex surfaces to the model as a
   * failed request and plans around, rather than waiting on.
   */
  private answerServerRequest(msg: RpcMessage, emit: (e: AgentEvent) => void): void {
    const method = msg.method!;
    const params = msg.params ?? {};
    if (CODEX_ORDEWELL.isOrdewellAsk({ method, params })) {
      this.rpc.respond(msg.id!, { action: 'accept', content: {} });
      return;
    }
    if (this.holdMcpToolApproval(msg, method, params, emit)) return;
    const result = DECLINE_RESULTS[method];
    if (result) {
      this.rpc.respond(msg.id!, result);
    } else {
      this.rpc.respondError(msg.id!, -32601, 'The Ordewell planner is read-only and has no user to consult. Mutation belongs to the runners that execute the plan.');
    }
    if (!ANNOUNCED_REQUESTS.has(method)) return;
    emit({
      type: 'permission_request',
      id: String(msg.id ?? ''),
      name: method.split('/').pop() ?? method,
      detail: JSON.stringify(msg.params ?? {}),
      decided: { decision: 'deny' },
    });
  }

  /**
   * A planner's approval for a tool of the user's own MCP server, held for the
   * planner's envelope to answer (ADR-0026). Codex names the server; the tool
   * is in its question, or else the call it last started on that server.
   */
  private holdMcpToolApproval(msg: RpcMessage, method: string, params: Record<string, unknown>, emit: (e: AgentEvent) => void): boolean {
    if (method !== 'mcpServer/elicitation/request') return false;
    const meta = params._meta as { codex_approval_kind?: unknown; tool_params?: unknown } | undefined;
    const server = params.serverName;
    if (meta?.codex_approval_kind !== 'mcp_tool_call' || typeof server !== 'string') return false;
    const asked = typeof params.message === 'string' ? /run tool "([^"]+)"/.exec(params.message)?.[1] : undefined;
    const tool = asked ?? this.mcpCallsInProgress.get(server);
    if (!tool) return false;
    const id = String(msg.id);
    const input = typeof meta.tool_params === 'object' && meta.tool_params !== null ? meta.tool_params as Record<string, unknown> : {};
    const scope = `mcp__${server}__${tool}`;
    this.openPermissions.set(id, { requestId: msg.id!, method, params });
    emit({ type: 'permission_request', id, name: scope, detail: JSON.stringify(input), input, ask: { kind: 'mcp', scope, tool, server } });
    return true;
  }

  /** A tool item entering `inProgress` — announce the call so the timeline moves. */
  private emitItemStart(item: ThreadItem | undefined, emit: (e: AgentEvent) => void, subagentId?: string): void {
    if (!item?.id) return;
    switch (item.type) {
      case 'userMessage':
        if (!subagentId) this.steerDelivered(item, emit);
        return;
      case 'commandExecution':
        emit({ type: 'tool_call', id: item.id, name: 'shell', args: { command: item.command, cwd: item.cwd }, ...(subagentId ? { subagentId } : {}) });
        return;
      case 'mcpToolCall':
        if (item.server && item.tool) this.mcpCallsInProgress.set(item.server, item.tool);
        emit({ type: 'tool_call', id: item.id, name: shownToolName(item), args: item.arguments ?? {}, ...(subagentId ? { subagentId } : {}) });
        return;
      case 'dynamicToolCall':
        emit({ type: 'tool_call', id: item.id, name: item.tool ?? 'tool', args: item.arguments ?? {}, ...(subagentId ? { subagentId } : {}) });
        return;
      case 'webSearch':
        emit({ type: 'tool_call', id: item.id, name: 'web_search', args: { query: item.query }, ...(subagentId ? { subagentId } : {}) });
        return;
      case 'fileChange': {
        const paths = (item.changes ?? []).map((change) => change.path).filter((path): path is string => !!path);
        this.fileChangePaths.set(item.id, paths);
        if (this.startOpts?.kind === 'task') {
          for (const change of item.changes ?? []) this.announceFileChange(item.id, change, emit, subagentId);
        }
        return;
      }
      // Delegation is a tool call like any other: the planner's own call is
      // unparented, and shows in the timeline as the agent tool it really is.
      case 'collabAgentToolCall':
        emit({
          type: 'tool_call', id: item.id, name: item.tool ?? 'collab',
          args: { prompt: item.prompt, model: item.model, receiverThreadIds: item.receiverThreadIds },
        });
        return;
      default:
        return;
    }
  }

  private emitItemDone(item: ThreadItem | undefined, emit: (e: AgentEvent) => void, subagentId?: string): void {
    if (!item?.type) return;
    const id = item.id ?? '';
    if (item.type === 'collabAgentToolCall') {
      this.emitCollabItem(item, id, emit);
      return;
    }
    switch (item.type) {
      // Codex announces the item started and completed; whichever lands first delivers.
      case 'userMessage':
        if (!subagentId) this.steerDelivered(item, emit);
        return;
      // A Codex turn is several whole messages — progress commentary, then the
      // final answer — not a token stream. Concatenated raw they run together
      // ("…as requested.`head` failed because…"), so each one after the first
      // opens a paragraph.
      case 'agentMessage':
        // A subagent's message is addressed to the planner, not the user. Its
        // report reaches the user through the planner's own synthesis.
        if (subagentId || !item.text) return;
        emit({ type: 'assistant_text', text: this.turnHasText ? `\n\n${item.text}` : item.text });
        this.turnHasText = true;
        return;
      case 'reasoning': {
        const text = flattenText(item.summary) || flattenText(item.content) || item.text || '';
        if (text.trim()) emit({ type: 'thinking', text, ...(subagentId ? { subagentId } : {}) });
        return;
      }
      case 'commandExecution':
        emit({
          type: 'tool_result', id, name: 'shell',
          output: item.aggregatedOutput ?? '',
          success: (item.exitCode ?? 0) === 0,
          ...(subagentId ? { subagentId } : {}),
        });
        return;
      case 'mcpToolCall':
      case 'dynamicToolCall':
        emit({
          type: 'tool_result', id, name: item.type === 'mcpToolCall' ? shownToolName(item) : item.tool ?? 'tool',
          output: item.error ?? flattenText(item.result) ?? '',
          success: item.status !== 'error' && item.success !== false && !item.error,
          ...(subagentId ? { subagentId } : {}),
        });
        return;
      // The query is empty when the search starts and filled when it lands, so
      // the result — not the call — is what carries what was actually searched.
      case 'webSearch':
        emit({ type: 'tool_result', id, name: 'web_search', output: item.query ?? '', success: true, ...(subagentId ? { subagentId } : {}) });
        return;
      case 'fileChange':
        this.fileChangePaths.delete(id);
        if (this.startOpts?.kind === 'task') {
          for (const change of item.changes ?? []) {
            const row = this.announceFileChange(id, change, emit, subagentId);
            emit({ type: 'tool_result', id: row, name: changeName(change), output: changeDiff(change), success: item.status === 'completed', ...(subagentId ? { subagentId } : {}) });
          }
          this.fileChangeRows.delete(id);
          return;
        }
        // A planner's `fileChange` can only appear if the read-only sandbox
        // was bypassed; reporting it keeps that visible rather than silent.
        emit({ type: 'tool_result', id, name: 'file_change', output: JSON.stringify(item), success: false, ...(subagentId ? { subagentId } : {}) });
        return;
      default:
        return;
    }
  }

  /**
   * One row per changed file: a patch is several files, and one row naming
   * them all reads as a single cut-off path. The first file keeps the item's
   * id, which an approval for the patch points at. Announcing a file twice
   * returns the row it already has, so a change first seen completed still
   * gets its call.
   */
  private announceFileChange(itemId: string, change: FileUpdateChange, emit: (e: AgentEvent) => void, subagentId?: string): string {
    const rows = this.fileChangeRows.get(itemId) ?? new Map<string, string>();
    this.fileChangeRows.set(itemId, rows);
    const path = this.shownChangePath(change);
    const known = rows.get(path);
    if (known) return known;
    const row = rows.size === 0 ? itemId : `${itemId}:${path}`;
    rows.set(path, row);
    emit({ type: 'tool_call', id: row, name: changeName(change), args: { path }, ...(subagentId ? { subagentId } : {}) });
    return row;
  }

  /** Relative to the task's worktree, where every path but a stray one lies; a move names both ends. */
  private shownChangePath(change: FileUpdateChange): string {
    const shown = (path: string): string => {
      const cwd = this.startOpts?.cwd;
      const rel = cwd ? relative(cwd, path) : path;
      return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : path;
    };
    const from = shown(change.path ?? '');
    return change.kind?.move_path ? `${from} → ${shown(change.kind.move_path)}` : from;
  }

  /**
   * A `collabAgentToolCall` — the planner spawning, waiting on or messaging a
   * subagent. The call itself is planner-level tool activity; the lifecycle it
   * carries becomes `subagent_started` / `subagent_finished`, restated as
   * often as Codex restates it — the service reports each once. Codex tags
   * every collab item with the parent thread, so this one never runs for a
   * subagent.
   */
  private emitCollabItem(item: ThreadItem, id: string, emit: (e: AgentEvent) => void): void {
    if (item.tool === 'spawnAgent') {
      // `receiverThreadIds` is empty while the call is in progress and names
      // the child thread once it lands, which is the first moment the subagent
      // has an id to report under.
      for (const child of item.receiverThreadIds ?? []) {
        const model = item.model || undefined;
        this.subagents.set(child, { model });
        emit({ type: 'subagent_started', subagentId: child, brief: item.prompt ?? '', ...(model ? { model } : {}) });
      }
    }
    // The subagent's outcome arrives on the call that observed it — a `wait`, or
    // any later collab call's `agentsStates` — as the child's last words.
    for (const [child, state] of Object.entries(item.agentsStates ?? {})) {
      const outcome = subagentOutcome(state?.status);
      if (!outcome) continue;
      this.subagents.set(child, this.subagents.get(child) ?? {});
      emit({ type: 'subagent_finished', subagentId: child, outcome, digest: state?.message ?? '' });
    }
    emit({
      type: 'tool_result', id, name: item.tool ?? 'collab',
      output: this.collabSummary(item),
      success: item.status !== 'failed' && item.status !== 'interrupted',
    });
  }

  /** The readable result of a collab call: the brief it sent, or what came back. */
  private collabSummary(item: ThreadItem): string {
    const agents = Object.values(item.agentsStates ?? {})
      .map((state) => state?.message)
      .filter((message): message is string => !!message);
    if (agents.length) return agents.join('\n');
    return item.prompt ?? '';
  }
}
