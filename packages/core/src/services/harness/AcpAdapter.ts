import type { AgentProcessDeps, AgentStartOptions, TaskModeAgentAdapter, TaskStartOptions } from './AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import { StdioAgentAdapter, type SpawnSpec } from './StdioAgentAdapter';
import { JsonRpcError, JsonRpcPeer, type RpcMessage, type RpcResponse } from './jsonRpc';
import {
  ACP_ERROR,
  ACP_PROTOCOL_VERSION,
  initializeResponseSchema,
  isAuthRequired,
  newSessionResponseSchema,
  parseAcp,
  parseSessionUpdate,
  promptResponseSchema,
  requestPermissionRequestSchema,
  sessionNotificationSchema,
  type AcpPermissionOption,
} from './acpSchema';
import { endTurn, newTurn, reduceUpdate, type AcpTurn } from './acpEvents';
import { acpOrdewellBinding } from './acpOrdewell';
import type { AcpProfile } from './acpProfiles';
import { PermissionLedger } from './permissionLedger';
import { awaitAttach, MCP_ATTACH_TIMEOUT_MS, type AttachState } from './ordewellBinding';
import { settleWithin } from './settleWithin';
import { compareVersions } from '../../utils/version';
import { ownerOnlyConfigFile, taskCompletionContract, type McpClientConfig } from '../mcp';

const DEFAULT_INIT_TIMEOUT_MS = 30_000;

/** What Ordewell tells an agent about itself; the same words the Codex app-server is given. */
const CLIENT_INFO = { name: 'ordewell', title: 'Ordewell', version: '0.1.0' };

type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
const CANCELLED: PermissionOutcome = { outcome: 'cancelled' };

/**
 * The option kinds that carry each answer, most fitting first. An agent names
 * its options with ids of its own choosing, so only the kind says what one
 * does; the second kind keeps the answer's sense when the agent offers only
 * the other scope.
 */
const KINDS_FOR: Record<ApprovalDecision['decision'], readonly string[]> = {
  allow: ['allow_once', 'allow_always'],
  allowForTask: ['allow_always', 'allow_once'],
  deny: ['reject_once', 'reject_always'],
};

interface HeldRequest {
  id: string;
  options: readonly AcpPermissionOption[];
}

type RunningTask = TaskStartOptions & { mcp: McpClientConfig };

/**
 * A task runner that speaks the Agent Client Protocol (ACP v1) on stdio: one
 * adapter for every such agent, which differs from the next only by its
 * {@link AcpProfile}. Ordewell is the client and does no I/O for the agent —
 * no file system, no terminal — so the agent works in the worktree itself and
 * reaches Ordewell only through the MCP server `session/new` hands it.
 *
 * A turn is one `session/prompt`, ended by its response alone: no update the
 * agent streams can end it, and no timer does. There is no steer (ADR-0023):
 * a message for a running task waits for the turn's end.
 */
export class AcpAdapter extends StdioAgentAdapter implements TaskModeAgentAdapter {
  readonly agentId: string;
  private readonly name: string;
  private readonly profile: AcpProfile;
  private readonly rpc = new JsonRpcPeer((payload) => this.writeLine(payload));
  private readonly binding: ReturnType<typeof acpOrdewellBinding>;
  private readonly ledger: PermissionLedger<HeldRequest>;
  /** Each request the agent waits on, by the ledger's id for it, with its own JSON-RPC id and what settles its answer. */
  private readonly held = new Map<string, { rpcId: number | string; resolve(outcome: PermissionOutcome): void }>();
  private task: RunningTask | null = null;
  private turn: AcpTurn | null = null;
  /** Whether this turn's `session/cancel` went out, which makes whatever ends the turn an interrupt. */
  private cancelSent = false;
  /** Settles when the agent answers this turn's prompt: true with an answer, false when the process went first. */
  private turnAnswered: Promise<boolean> | null = null;
  private answerTurn: ((answered: boolean) => void) | null = null;
  /** The completion contract still owed to this process's first prompt, under the `prompt` route. */
  private preamble: string | null = null;
  /** The agent refused `session/new`, so it never got the server it would attach to. */
  private sessionRefused = false;

  constructor(deps: AgentProcessDeps, profile: AcpProfile) {
    super(deps);
    this.profile = profile;
    this.agentId = profile.manifest.name;
    this.name = profile.manifest.displayName ?? profile.manifest.name;
    this.binding = acpOrdewellBinding(profile);
    this.ledger = new PermissionLedger<HeldRequest>(
      (handle, decision) => this.choose(handle, decision),
      // An agent with a switch of its own was put in the plan's mode at spawn
      // (ADR-0001); one without is answered here as that mode would.
      () => ({ role: 'task', autoApprove: profile.mode === undefined && this.task?.flags.modeSettings.approvals === 'auto' }),
    );
    this.rpc.onRequest('session/request_permission', (params, request) => this.onPermission(params, request.id, request.cancelled));
    this.rpc.onNotification('session/update', (params) => this.onUpdate(params));
    void this.processEnded.then(() => {
      this.rpc.close('The agent exited.');
      this.cancelPermissions();
    });
  }

  override async start(opts: AgentStartOptions): Promise<void> {
    if (opts.kind === 'planner') throw new Error(`${this.name} cannot plan in Ordewell yet.`);
    if (opts.flags.readOnly) throw new Error(`${this.name} cannot run a read-only task in Ordewell yet.`);
    if (!opts.mcp) throw new Error(`${this.name} cannot start without the Ordewell MCP server to carry its tools.`);
    this.task = { ...opts, mcp: opts.mcp };
    await super.start(opts);
  }

  /**
   * The command line carries the profile's switches and nothing of the task's
   * own: the token reaches the agent only in `session/new`, over stdin, and the
   * instructions only by the profile's route, never as a file in the worktree
   * (ADR-0022, A5; ADR-0018, C2).
   */
  protected spawnSpec(): SpawnSpec {
    const task = this.requireTask();
    const { instructions, mode } = this.profile;
    const args = [...this.profile.args, ...(mode?.kind === 'args' ? mode.args(task.flags) : [])];
    const env: Record<string, string> = { ...this.profile.env };
    const files: string[] = [];
    const contract = this.contract(task);
    if (instructions.kind === 'file') {
      const file = ownerOnlyConfigFile(instructions.fileName, contract);
      this.own('instructions', file.remove);
      if ('flag' in instructions.pass) {
        args.push(instructions.pass.flag, file.path);
        files.push(file.path);
      } else {
        env[instructions.pass.env] = file.path;
      }
    }
    // Every process starts without the contract, a resumed one included, so
    // its first prompt carries it again.
    this.preamble = instructions.kind === 'prompt' ? contract : null;
    return { command: this.profile.manifest.runner.command, args, env, ...(files.length ? { files } : {}) };
  }

  protected override async handshake(): Promise<void> {
    const task = this.requireTask();
    await this.initialize();

    const { mcp } = task;
    const opened = await this.setupCall('session/new', {
      cwd: this.deps.placement?.cwd ?? task.cwd,
      mcpServers: [{ type: 'http', name: mcp.name, url: mcp.url, headers: Object.entries(mcp.headers).map(([name, value]) => ({ name, value })) }],
      ...(this.profile.instructions.kind === 'meta' ? { _meta: { [this.profile.instructions.key]: this.contract(task) } } : {}),
    });
    if (!opened.ok) {
      this.sessionRefused = true;
      throw new Error(isAuthRequired(opened) ? this.signedOut() : `${this.name} could not open a session: ${opened.message ?? 'no reason given'}`);
    }
    const session = parseAcp(newSessionResponseSchema, opened.result);
    if (!session.ok || !session.value.sessionId) throw new Error(`${this.name} opened a session without an id Ordewell can read.`);
    this.sessionId = session.value.sessionId;

    if (this.profile.mode?.kind === 'session-mode') {
      const modeId = task.flags.permissionMode;
      const set = await this.setupCall('session/set_mode', { sessionId: this.sessionId, modeId });
      if (!set.ok) throw new Error(`${this.name} refused the mode "${modeId}": ${set.message ?? 'no reason given'}`);
    }
  }

  /**
   * The client judges the answer itself: agents answer version 1 even when
   * asked for another, so only the number they give back counts. Sign-in
   * methods are read and never used — signing in is the user's, in the
   * agent's own terminal.
   */
  private async initialize(): Promise<void> {
    const answered = await this.setupCall('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: CLIENT_INFO,
    });
    if (!answered.ok) throw new Error(isAuthRequired(answered) ? this.signedOut() : `${this.name} could not start: ${answered.message ?? 'no reason given'}`);
    const parsed = parseAcp(initializeResponseSchema, answered.result);
    if (!parsed.ok) throw new Error(`${this.name} answered initialize in a shape Ordewell cannot read: ${parsed.error}`);
    const { protocolVersion, agentCapabilities, agentInfo } = parsed.value;
    if (protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(`${this.name} speaks ACP version ${protocolVersion}; Ordewell speaks version ${ACP_PROTOCOL_VERSION}.`);
    }
    const { minVersion } = this.profile;
    if (minVersion !== undefined) {
      const version = agentInfo?.version;
      if (version === undefined) throw new Error(`${this.name} did not say its version; Ordewell needs ${minVersion} or later.`);
      if (compareVersions(version, minVersion) < 0) throw new Error(`${this.name} ${version} is older than Ordewell needs (${minVersion} or later).`);
    }
    // Without HTTP the agent could reach Ordewell only through a local bridge
    // process carrying the token, which Ordewell does not run.
    if (!agentCapabilities?.mcpCapabilities?.http) {
      throw new Error(`${this.name} cannot take Ordewell's tools over HTTP, so it cannot run tasks or plan here.`);
    }
  }

  /**
   * A setup request, bounded by the profile's timeout and by the process: an
   * agent that hangs at start fails the start instead of the attempt waiting
   * forever. A reply after the timeout is still taken and discarded.
   */
  private async setupCall(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const timeoutMs = this.profile.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    const response = await this.rpc.call(method, params, { timeoutMs });
    if (response.ok) return response;
    if (response.timedOut) throw new Error(`${this.name} did not answer ${method} within ${timeoutMs} ms.`);
    if (response.closed) throw new Error(this.runner.withStderrTail(`${this.name} exited before it answered ${method}.`));
    return response;
  }

  private signedOut(): string {
    const { auth, runner } = this.profile.manifest;
    return auth ? `${this.name} is not signed in. Run \`${[runner.command, ...auth.loginArgs].join(' ')}\`.` : `${this.name} is not signed in.`;
  }

  private contract(task: RunningTask): string {
    return taskCompletionContract(task.commits ? { commits: true } : {});
  }

  private requireTask(): RunningTask {
    if (!this.task) throw new Error(`${this.name} has no task to run.`);
    return this.task;
  }

  protected turnPayload(message: string): string {
    const task = this.requireTask();
    this.turn = newTurn({ source: this.agentId, ...(task.model ? { model: task.model } : {}) });
    this.cancelSent = false;
    this.turnAnswered = new Promise<boolean>((resolve) => { this.answerTurn = resolve; });
    const text = this.preamble ? `${this.preamble}\n\n${message}` : message;
    this.preamble = null;
    return this.rpc.frame('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, (response) => this.promptAnswered(response));
  }

  /**
   * The turn's one end. Whatever the agent still had open is over with it, so
   * every request it was waiting on is cancelled before the end is shown.
   */
  private promptAnswered(response: RpcResponse): void {
    const turn = this.turn;
    const answered = this.answerTurn;
    this.turn = null;
    this.answerTurn = null;
    // The process ending is reported by the base class, with its last words.
    if (!response.ok && response.closed) {
      answered?.(false);
      return;
    }
    this.cancelPermissions();
    if (turn) {
      if (response.ok) {
        const parsed = parseAcp(promptResponseSchema, response.result);
        const { stopReason, usage } = parsed.ok ? parsed.value : { stopReason: 'end_turn', usage: undefined };
        for (const event of endTurn(turn, stopReason, usage, this.cancelSent)) this.announce(event);
      } else if (this.cancelSent) {
        // Some agents answer a cancelled prompt with an error rather than a
        // `cancelled` stop: it is still the interrupt we asked for.
        for (const event of endTurn(turn, 'cancelled', undefined, true)) this.announce(event);
      } else {
        this.announce({ type: 'error', message: isAuthRequired(response) ? this.signedOut() : `${this.name} could not run the turn: ${response.message ?? 'no reason given'}` });
      }
    }
    answered?.(true);
  }

  /**
   * An update outside a turn has no turn to belong to: what it says of the
   * session would be kept, but its words are not shown, since presenting them
   * in the next turn would pass them off as the answer to its message.
   */
  private onUpdate(params: Record<string, unknown>): void {
    const notification = parseAcp(sessionNotificationSchema, params);
    if (!notification.ok) return;
    const update = parseSessionUpdate(notification.value.update);
    if (this.turn) {
      const step = reduceUpdate(this.turn, update);
      this.turn = step.turn;
      for (const event of step.events) this.announce(event);
      return;
    }
    console.debug(`[acp] ${this.agentId}: dropped an update (${update.sessionUpdate === 'unknown' ? update.kind ?? 'nameless' : update.sessionUpdate}) outside a turn`);
  }

  protected handleLine(line: string): void {
    const message = StdioAgentAdapter.parse<RpcMessage>(line);
    if (message) this.rpc.dispatch(message, (event) => this.announce(event));
  }

  /**
   * A request is answered once: by the ledger (an Ordewell tool, the mode, or
   * a person), by a cancel, or by the agent withdrawing it. Until then the
   * agent waits on the returned promise.
   */
  private onPermission(params: Record<string, unknown>, rpcId: number | string, cancelled: AbortSignal): Promise<Record<string, unknown>> | JsonRpcError {
    const parsed = parseAcp(requestPermissionRequestSchema, params);
    if (!parsed.ok) return new JsonRpcError(ACP_ERROR.invalidParams, `Ordewell cannot read this permission request: ${parsed.error}`);
    const { toolCall, options } = parsed.value;
    // A request that crossed this turn's session/cancel was pending when the
    // agent read it: ACP has the client answer it `cancelled`, never ask anyone.
    if (this.cancelSent && this.turn) return Promise.resolve({ outcome: CANCELLED });
    const id = String(rpcId);
    return new Promise((resolve) => {
      this.held.set(id, { rpcId, resolve: (outcome) => resolve({ outcome }) });
      cancelled.addEventListener('abort', () => {
        if (!this.settle(id, CANCELLED)) return;
        this.ledger.withdraw(id, (event) => this.announce(event));
      }, { once: true });
      const input = toolCall.rawInput;
      this.ledger.raise({
        id,
        name: toolCall.title ?? toolCall.kind ?? 'tool',
        detail: toolCall.title ?? '',
        ...(typeof input === 'object' && input !== null && !Array.isArray(input) ? { input: input as Record<string, unknown> } : {}),
        toolUseId: toolCall.toolCallId,
        // By exact name only: a near miss is anyone's tool (ADR-0022, S3).
        ordewell: this.binding.isOrdewellAsk(toolCall),
      }, { id, options }, (event) => this.announce(event));
    });
  }

  /** ACP's answer carries an option, not a note: a denial's reason has nowhere to go. */
  private choose(handle: HeldRequest, decision: ApprovalDecision): void {
    const option = KINDS_FOR[decision.decision]
      .map((kind) => handle.options.find((candidate) => candidate.kind === kind))
      .find((candidate) => candidate !== undefined);
    this.settle(handle.id, option ? { outcome: 'selected', optionId: option.optionId } : CANCELLED);
  }

  private settle(id: string, outcome: PermissionOutcome): boolean {
    const request = this.held.get(id);
    if (!request) return false;
    this.held.delete(id);
    request.resolve(outcome);
    return true;
  }

  /** ACP requires a client that cancels a turn to answer every request of it `cancelled`. */
  private cancelPermissions(): void {
    for (const id of [...this.held.keys()]) this.settle(id, CANCELLED);
    this.ledger.endTurn((event) => this.announce(event));
  }

  /**
   * `session/cancel`, then the turn's own end: true once the agent answers the
   * prompt, false when it does not within `timeoutMs` or the process ends.
   */
  async interrupt(timeoutMs: number): Promise<boolean> {
    if (!this.process || this.exited || !this.turn || !this.turnAnswered) return false;
    this.cancelSent = true;
    this.rpc.notify('session/cancel', { sessionId: this.sessionId });
    this.cancelPermissions();
    return settleWithin(this.turnAnswered, { timeoutMs, onTimeout: () => false, ended: this.processEnded, onEnded: () => false });
  }

  answerPermission(id: string, decision: ApprovalDecision): boolean {
    return this.process ? this.ledger.answer(id, decision) : false;
  }

  /**
   * ACP reports no MCP status, so the server's first-contact record is the
   * evidence (ADR-0022, S2): connected once the token was used, failed when the
   * agent refused the session or exited first, pending while it has not.
   */
  async mcpAttached(): Promise<AttachState> {
    const contact = this.task?.mcp.contact;
    if (!contact || this.sessionRefused || !this.process) return 'failed';
    return awaitAttach(
      () => contact.whenContacted().then((used): AttachState => (used ? 'connected' : 'failed')),
      this.profile.attachTimeoutMs ?? MCP_ATTACH_TIMEOUT_MS,
      0,
      this.processEnded,
    );
  }

  override dispose(): void {
    if (this.isDisposed) return;
    // Answered on the wire now: the process goes with this call, before a
    // promise-settled answer could be written.
    for (const { rpcId } of this.held.values()) this.rpc.respond(rpcId, { outcome: CANCELLED });
    this.held.clear();
    this.ledger.endTurn((event) => this.announce(event));
    this.answerTurn?.(false);
    this.answerTurn = null;
    this.rpc.close('The adapter was disposed.');
    super.dispose();
  }
}
