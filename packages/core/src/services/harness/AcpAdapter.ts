import type { AgentEvent, AgentProcessDeps, AgentStartOptions, TaskModeAgentAdapter } from './AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import { findRunnerCommand, type RunnerCommand, type RunnerModelRef } from '../../models/RunnerCommand';
import { StdioAgentAdapter, type SpawnSpec } from './StdioAgentAdapter';
import { JsonRpcError, JsonRpcPeer, METHOD_NOT_FOUND, type RpcMessage, type RpcResponse } from './jsonRpc';
import {
  ACP_ERROR,
  ACP_INITIALIZE_PARAMS,
  ACP_PROTOCOL_VERSION,
  initializeResponseSchema,
  isAuthRequired,
  newSessionResponseSchema,
  parseAcp,
  parseSessionUpdate,
  promptResponseSchema,
  requestPermissionRequestSchema,
  sessionNotificationSchema,
  setConfigOptionResponseSchema,
  type AcpConfigOption,
  type AcpInitializeResponse,
  type AcpPermissionOption,
  type AcpSessionState,
  type AcpToolCall,
} from './acpSchema';
import { endTurn, newTurn, reduceUpdate, type AcpTurn } from './acpEvents';
import { acpOrdewellBinding } from './acpOrdewell';
import { currentValue, findOption, optionValues, type OptionRole } from './acpOptions';
import type { AcpAskedCall, AcpExtensionHandler, AcpProfile } from './acpProfiles';
import { acpAsk, acpRoles, decideRestricted } from './acpRoles';
import { PermissionLedger, type LedgerStance } from './permissionLedger';
import { readOnlyTask } from './plannerPermissions';
import { instructionsBlock, isRecord } from './repoConfig';
import { awaitAttach, listed, MCP_ATTACH_TIMEOUT_MS, type AttachState } from './ordewellBinding';
import { settleWithin } from './settleWithin';
import { compareVersions } from '../../utils/version';
import { acpPrivateDir, type AcpPrivateDir } from './acpPrivateDir';
import { dirname } from 'path';
import { taskCompletionContract, type McpClientConfig } from '../mcp';

const DEFAULT_INIT_TIMEOUT_MS = 30_000;

const MODEL_COMMAND = 'model';

/** Where a process finds its temp directory: POSIX's, then Windows's. */
const TEMP_DIR_VARIABLES = ['TMPDIR', 'TMP', 'TEMP'] as const;

/** The method prefixes ACP gives the client; a profile's extension request is never served under one. */
const ACP_CLIENT_NAMESPACES = ['session/', 'fs/', 'terminal/'] as const;

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

type Started = AgentStartOptions & { mcp: McpClientConfig };

/** One of the plan's settings for the session, by the role of the option that carries it. */
interface PlanSetting {
  role: OptionRole;
  value: string;
}

/**
 * A task runner that speaks the Agent Client Protocol (ACP v1) on stdio: one
 * adapter for every such agent, which differs from the next only by its
 * {@link AcpProfile}. Ordewell is the client and does no I/O for the agent —
 * no file system, no terminal — so the agent works in the worktree itself and
 * reaches Ordewell only through the MCP server `session/new` hands it, or
 * the profile's settings file names to it (ADR-0060, R4).
 *
 * A turn is one `session/prompt`, ended by its response alone: no update the
 * agent streams can end it, and no timer does. There is no steer (ADR-0023; ADR-0060, R8):
 * a message for a running task waits for the turn's end.
 */
export class AcpAdapter extends StdioAgentAdapter implements TaskModeAgentAdapter {
  readonly agentId: string;
  private readonly name: string;
  private readonly profile: AcpProfile;
  private readonly rpc = new JsonRpcPeer((payload) => this.writeLine(payload));
  private readonly binding: ReturnType<typeof acpOrdewellBinding>;
  private readonly ledger: PermissionLedger<HeldRequest>;
  /** Each request the agent waits on, by the ledger's id for it, with its own JSON-RPC id, the call it asks for and what settles its answer. */
  private readonly held = new Map<string, { rpcId: number | string; asked: AcpAskedCall; resolve(outcome: PermissionOutcome): void }>();
  private started: Started | null = null;
  /**
   * A planner's start or a read-only task's: the profile's restricted
   * controls are on, and Ordewell answers every request the agent still
   * raises without a person (ADR-0026, ADR-0046; ADR-0060, R3).
   */
  private restricted = false;
  /**
   * The empty directory this process was started in instead of the worktree
   * (`AcpRestriction.privateCwd`), or null where it started in the worktree.
   * The worktree stays the start's for every decision.
   */
  private startDir: string | null = null;
  /** The mode a restricted session settled in, which it may not leave; watched once the settings are applied. */
  private settledMode: { id: string | undefined } | null = null;
  /** Why this process may take no further turn: it left the mode its restricted start held. */
  private failure: string | null = null;
  private turn: AcpTurn | null = null;
  /**
   * The turn's first report of each tool call, by id. An agent may name a
   * call more fully there than in its permission request for it (Copilot
   * says `ordewell-task_complete` in one, `task_complete` in the other), and
   * only the full name tells Ordewell's tool from another server's.
   */
  private reports = new Map<string, AcpToolCall>();
  /** Whether this turn's `session/cancel` went out, which makes whatever ends the turn an interrupt. */
  private cancelSent = false;
  /** Settles when the agent answers this turn's prompt: true with an answer, false when the process went first. */
  private turnAnswered: Promise<boolean> | null = null;
  private answerTurn: ((answered: boolean) => void) | null = null;
  /** The completion contract still owed to this process's first prompt, under the `prompt` route. */
  private preamble: string | null = null;
  /** The agent refused `session/new`, so it never got the server it would attach to. */
  private sessionRefused = false;
  /** What the agent said it can do at initialize; nothing until then. */
  private capabilities: NonNullable<AcpInitializeResponse['agentCapabilities']> = {};
  /** The session's complete option list as the agent last gave it. */
  private configOptions: AcpConfigOption[] = [];
  /** The session mode as the agent last reported it outside its option list, for an agent with `session/set_mode`. */
  private currentMode: string | undefined;
  /** The commands the agent last listed; `runner_loaded` goes out with the first list only. */
  private commandList: RunnerCommand[] = [];
  private commandsAnnounced = false;
  /** The model the session is on as far as Ordewell has been told, to tell a change from a repeat. */
  private heldModel: string | undefined;
  /** Whether this turn's message was a model command, which makes a model change in it the user's own. */
  private modelCommandSent = false;

  constructor(deps: AgentProcessDeps, profile: AcpProfile) {
    super(deps);
    this.profile = profile;
    this.agentId = profile.manifest.name;
    this.name = profile.manifest.displayName ?? profile.manifest.name;
    this.binding = acpOrdewellBinding(profile);
    this.ledger = new PermissionLedger<HeldRequest>(
      (handle, decision) => this.choose(handle, decision),
      () => this.stance(),
    );
    // ACP's client namespaces are the adapter's alone, so a profile cannot make
    // it serve the file system or terminals it advertises it does not (ADR-0060).
    for (const [method, handler] of Object.entries(profile.extensionRequests ?? {})) {
      if (ACP_CLIENT_NAMESPACES.some((ns) => method.startsWith(ns))) continue;
      this.rpc.onRequest(method, (params) => this.onExtension(method, handler, params));
    }
    this.rpc.onRequest('session/request_permission', (params, request) => this.onPermission(params, request.id, request.cancelled));
    this.rpc.onNotification('session/update', (params) => this.onUpdate(params));
    void this.processEnded.then(() => {
      this.rpc.close('The agent exited.');
      this.cancelPermissions();
    });
  }

  override async start(opts: AgentStartOptions): Promise<void> {
    const roles = acpRoles(this.profile);
    const restricted = opts.kind === 'planner' || readOnlyTask(opts);
    if (opts.kind === 'planner' && !roles.plans) throw new Error(`${this.name} cannot plan in Ordewell: its profile claims no planner role.`);
    if (opts.kind === 'task' && restricted && !roles.readOnly) throw new Error(`${this.name} cannot run a read-only task in Ordewell: its profile claims no read-only role.`);
    if (!opts.mcp) throw new Error(`${this.name} cannot start without the Ordewell MCP server to carry its tools.`);
    // A container starts its runner in the worktree, the one place this start must keep it out of (ADR-0028).
    if (restricted && this.profile.restricted?.privateCwd && this.deps.placement) {
      throw new Error(`${this.name} cannot ${opts.kind === 'planner' ? 'plan' : 'run a read-only task'} in a container: there it would start in the worktree and run the repository's hooks.`);
    }
    // A placement copies only files named in the arguments into the container;
    // the settings file's path goes in the environment, where it would name a
    // file the container does not have (ADR-0060, R4).
    if (this.profile.mcpConfig && this.deps.placement) {
      throw new Error(`${this.name} cannot run in a container: it takes Ordewell's MCP server from a settings file on this machine, which the container does not see.`);
    }
    this.started = { ...opts, mcp: opts.mcp };
    this.restricted = restricted;
    await super.start(opts);
  }

  /**
   * An agent with a switch of its own was put in the plan's mode at spawn
   * (ADR-0001); one without is answered here as that mode would. A restricted
   * start is answered by its role's rules alone: a planner's open requests go
   * to its envelope, and a read-only task has nobody to ask.
   */
  private stance(): LedgerStance {
    const started = this.started;
    if (this.restricted && started) {
      return {
        role: started.kind === 'planner' ? 'planner' : 'task',
        autoApprove: false,
        // The ledger asks while the request is being held, so its call is here.
        decide: (request) => decideRestricted(this.held.get(request.id)!.asked, request.ask ?? { kind: 'other' }, started),
      };
    }
    return { role: 'task', autoApprove: this.profile.mode === undefined && started?.kind === 'task' && started.flags.modeSettings.approvals === 'auto' };
  }

  /**
   * The command line carries the profile's switches and nothing of the task's
   * own: the token reaches the agent only in `session/new`, over stdin, or in
   * the owner-only settings file the profile's `mcpConfig` names, and the
   * instructions only by the profile's route, never as a file in the worktree
   * (ADR-0022, A5; ADR-0018, C2; ADR-0060, R4, R6). A restricted start adds the controls that
   * take the agent's own write and shell tools away; a planner has no mode.
   */
  protected spawnSpec(): SpawnSpec {
    const started = this.requireStarted();
    const { instructions, mode, restricted, mcpConfig } = this.profile;
    const args = [
      ...this.profile.args,
      ...(this.restricted && restricted ? restricted.args : []),
      ...(started.kind === 'task' && mode?.kind === 'args' ? mode.args(started.flags) : []),
      ...(started.model && this.profile.modelArgs ? this.profile.modelArgs(started.model) : []),
    ];
    const env: Record<string, string> = { ...this.profile.env, ...(this.restricted ? restricted?.env : {}) };
    const files: string[] = [];
    const startsOutside = this.restricted && restricted?.privateCwd === true;
    const dir = startsOutside || instructions.kind === 'file' || mcpConfig ? this.ownPrivateDir() : null;
    this.startDir = startsOutside ? dir?.path ?? null : null;
    // The system's temp directory is shared by every process of the user's,
    // other attempts' instructions included, and an agent may read its own
    // temp directory without asking: Copilot does, whatever its flags say.
    if (this.startDir) for (const name of TEMP_DIR_VARIABLES) env[name] = this.startDir;
    if (dir && mcpConfig) {
      const { name, url, headers } = started.mcp;
      env[mcpConfig.pass.env] = dir.write(mcpConfig.fileName, mcpConfig.render({ name, url, headers }));
    }
    const contract = this.instructions(started);
    if (dir && instructions.kind === 'file') {
      const path = dir.write(instructions.fileName, contract);
      if ('flag' in instructions.pass) {
        args.push(instructions.pass.flag, path);
        files.push(path);
      } else if (!('envDir' in instructions.pass)) {
        env[instructions.pass.env] = path;
      } else if (!this.startDir) {
        env[instructions.pass.envDir] = dirname(path);
      }
    }
    // Every process starts without the contract, a resumed one included, so
    // its first prompt carries it again.
    this.preamble = instructions.kind === 'prompt' ? contract : null;
    return { command: this.profile.manifest.runner.command, args, env, ...(files.length ? { files } : {}), ...(this.startDir ? { cwd: this.startDir } : {}) };
  }

  /**
   * A directory of this process's own, owner-only, outside any repository,
   * removed when the process ends, and swept at a later start if Ordewell died
   * first. It holds what the agent is handed as files, so the contract and the
   * token never sit in the worktree; a process started in it loads the
   * contract as that directory's own instructions, which Copilot does with the
   * session, where a file in a directory it is only pointed at, it reads when
   * the model chooses to.
   */
  private ownPrivateDir(): AcpPrivateDir {
    const dir = acpPrivateDir();
    this.own('private-dir', dir.remove);
    return dir;
  }

  protected override async handshake(): Promise<void> {
    const started = this.requireStarted();
    await this.initialize();
    if (started.resumeSessionId) await this.resumeSession(started, started.resumeSessionId);
    else await this.newSession(started);

    await this.applySettings(started);
    this.heldModel = currentValue(findOption(this.configOptions, 'model'));
    if (this.restricted) this.settledMode = { id: this.modeNow() };
  }

  private modeNow(): string | undefined {
    return currentValue(findOption(this.configOptions, 'mode')) ?? this.currentMode;
  }

  /**
   * What a session's answer says of it, taken as it arrives. An update the
   * agent sent first is older and gives way; what the answer leaves out, an
   * update may still have said.
   */
  private takeSession(state: AcpSessionState): void {
    if (state.configOptions) this.configOptions = state.configOptions;
    if (state.modes) this.currentMode = state.modes.currentModeId;
  }

  /**
   * The plan's mode, model and effort, put on the session and then checked
   * against what the agent reports it is on (ADR-0018, B2): the plan is held,
   * or the attempt fails in words, and never silently runs on another. Each
   * change answers the complete list, and a later one can move an option set
   * before it (an effort that puts the model back), so every setting is held
   * to the list the agent ends on, not to the answer to its own change.
   */
  private async applySettings(started: Started): Promise<void> {
    const effort = started.kind === 'task' ? started.flags.effort : started.effort;
    const settings: PlanSetting[] = [
      ...(started.kind === 'task' && this.profile.mode?.kind === 'session-mode' ? [{ role: 'mode' as const, value: started.flags.permissionMode }] : []),
      ...(started.model ? [{ role: 'model' as const, value: started.model }] : []),
      ...(effort ? [{ role: 'effort' as const, value: effort }] : []),
    ];
    const checked: PlanSetting[] = [];
    for (const setting of settings) {
      if (await this.putSetting(started, setting)) checked.push(setting);
    }
    for (const setting of checked) this.holdSetting(started, setting);
  }

  /**
   * Whether the agent can be held to the setting: an option is read back
   * from its list, and a mode taken by the older `session/set_mode` stands
   * until the agent reports another. A model given at spawn has only the
   * agent's word at spawn.
   */
  private async putSetting(started: Started, { role, value }: PlanSetting): Promise<boolean> {
    const option = findOption(this.configOptions, role);
    if (option) {
      await this.setOption(option.id, role, value);
      return true;
    }
    if (role === 'mode') {
      const set = await this.setupCall('session/set_mode', { sessionId: this.sessionId, modeId: value }, () => { this.currentMode = value; });
      if (!set.ok) throw new Error(`${this.name} refused the mode "${value}": ${set.message ?? 'no reason given'}`);
      return true;
    }
    // A model given at spawn reached the agent already (Copilot).
    if (role === 'model' && this.profile.modelArgs) return false;
    const work = started.kind === 'planner' ? 'plan' : 'run this task';
    throw new Error(`${this.name} offers no ${role} setting, so it cannot ${work} on the ${role} "${value}".`);
  }

  /**
   * Another mode than the plan's fails the attempt. A model or an effort
   * where the agent ended up on another fails a task that may change
   * nothing; any other says so and carries on (ADR-0001: said, never
   * silently rewritten).
   */
  private holdSetting(started: Started, { role, value }: PlanSetting): void {
    const actual = role === 'mode' ? this.modeNow() : currentValue(findOption(this.configOptions, role));
    if (actual === value) return;
    const was = `${this.name} did not take the ${role} "${value}": it is on "${actual ?? (role === 'mode' ? 'no mode' : 'none')}".`;
    if (role === 'mode' || (started.kind === 'task' && this.restricted)) throw new Error(was);
    this.announce(role === 'model'
      ? { type: 'model_drifted', from: { model: value }, to: { model: actual ?? 'unknown' } }
      : { type: 'command_output', text: was });
  }

  /**
   * `session/set_config_option` answers the complete list, which replaces the
   * one held: setting one option can add or drop another. An unknown id or
   * value is the agent's invalid-params error, said as what it means.
   */
  private async setOption(configId: string, role: OptionRole, value: string): Promise<void> {
    const response = await this.setupCall('session/set_config_option', { sessionId: this.sessionId, configId, value }, (result) => {
      const parsed = parseAcp(setConfigOptionResponseSchema, result);
      if (!parsed.ok) throw new Error(`${this.name} answered a ${role} change in a shape Ordewell cannot read: ${parsed.error}`);
      this.configOptions = parsed.value.configOptions;
    });
    if (!response.ok) {
      throw new Error(response.code === ACP_ERROR.invalidParams
        ? `${this.name} does not know the ${role} "${value}" (or its setting "${configId}"): ${response.message ?? 'no reason given'}`
        : `${this.name} refused the ${role} "${value}": ${response.message ?? 'no reason given'}`);
    }
  }

  /**
   * Ordewell's server as the session is given it: on a resume and a load too,
   * since the agent keeps none of a session's servers between processes. ACP
   * has a client check `mcpCapabilities.http` before it hands an HTTP server,
   * so an agent that takes its server from a settings file and advertises no
   * HTTP is given none here (ADR-0060, R4).
   */
  private sessionParams(started: Started): Record<string, unknown> {
    const { mcp } = started;
    const takesHttp = this.capabilities.mcpCapabilities?.http === true;
    return {
      cwd: this.deps.placement?.cwd ?? this.startDir ?? started.cwd,
      mcpServers: takesHttp ? [{ type: 'http', name: mcp.name, url: mcp.url, headers: Object.entries(mcp.headers).map(([name, value]) => ({ name, value })) }] : [],
    };
  }

  /** A fresh process has not been told the contract, whether its session is new or resumed. */
  private sessionMeta(started: Started): Record<string, unknown> {
    const { instructions } = this.profile;
    return instructions.kind === 'meta' ? { _meta: { [instructions.key]: this.instructions(started) } } : {};
  }

  private async newSession(started: Started): Promise<void> {
    const opened = await this.setupCall('session/new', {
      ...this.sessionParams(started),
      ...this.sessionMeta(started),
    }, (result) => {
      const session = parseAcp(newSessionResponseSchema, result);
      if (!session.ok || !session.value.sessionId) throw new Error(`${this.name} opened a session without an id Ordewell can read.`);
      // Set here, so the next line's update is told from another session's.
      this.sessionId = session.value.sessionId;
      this.takeSession(session.value);
    });
    if (!opened.ok) {
      this.sessionRefused = true;
      throw new Error(isAuthRequired(opened) ? this.signedOut() : `${this.name} could not open a session: ${opened.message ?? 'no reason given'}`);
    }
  }

  /**
   * Put the agent back in front of the session that did the work. A task's
   * failed resume is an error, never a fresh session in its place: Continue
   * (K1) offers the session that did the work, and a new one would pretend
   * it was resumed.
   */
  private async resumeSession(started: Started, id: string): Promise<void> {
    const { sessionCapabilities, loadSession } = this.capabilities;
    const method = sessionCapabilities?.resume ? 'session/resume' : loadSession ? 'session/load' : null;
    if (!method) throw new Error(`${this.name} could not resume session ${id}: it offers neither session/resume nor session/load.`);
    this.sessionId = id;
    const resumed = await this.setupCall(method, {
      sessionId: id,
      ...this.sessionParams(started),
      ...this.sessionMeta(started),
    }, (result) => {
      const session = parseAcp(newSessionResponseSchema, result);
      if (!session.ok) throw new Error(`${this.name} resumed session ${id} in a shape Ordewell cannot read: ${session.error}`);
      this.takeSession(session.value);
    });
    if (!resumed.ok) {
      this.sessionRefused = true;
      throw new Error(isAuthRequired(resumed) ? this.signedOut() : `${this.name} could not resume session ${id}: ${resumed.message ?? 'no reason given'}`);
    }
  }

  /**
   * The client judges the answer itself: agents answer version 1 even when
   * asked for another, so only the number they give back counts. Sign-in
   * methods are read and never used — signing in is the user's, in the
   * agent's own terminal.
   */
  private async initialize(): Promise<void> {
    const answered = await this.setupCall('initialize', { ...ACP_INITIALIZE_PARAMS });
    if (!answered.ok) throw new Error(isAuthRequired(answered) ? this.signedOut() : `${this.name} could not start: ${answered.message ?? 'no reason given'}`);
    const parsed = parseAcp(initializeResponseSchema, answered.result);
    if (!parsed.ok) throw new Error(`${this.name} answered initialize in a shape Ordewell cannot read: ${parsed.error}`);
    const { protocolVersion, agentCapabilities, agentInfo } = parsed.value;
    this.capabilities = agentCapabilities ?? {};
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
    // process carrying the token, which Ordewell does not run, unless it reads
    // the server from a settings file of its own (ADR-0060, R4).
    if (!this.profile.mcpConfig && !agentCapabilities?.mcpCapabilities?.http) {
      throw new Error(`${this.name} cannot take Ordewell's tools over HTTP, so it cannot run tasks or plan here.`);
    }
  }

  /**
   * A setup request, bounded by the profile's timeout and by the process: an
   * agent that hangs at start fails the start instead of the attempt waiting
   * forever. A reply after the timeout is still taken and discarded.
   *
   * `take` reads what an accepted answer says of the session on the line that
   * carried it, and fails the call by throwing. Taken any later, it would
   * overwrite an update the agent sent after it, on the next line of the same
   * chunk, with the older state.
   */
  private async setupCall(method: string, params: Record<string, unknown>, take?: (result: Record<string, unknown>) => void): Promise<RpcResponse> {
    const timeoutMs = this.profile.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    const response = await new Promise<RpcResponse>((resolve, reject) => this.rpc.send(method, params, (answer) => {
      try {
        if (answer.ok) take?.(answer.result);
        resolve(answer);
      } catch (error) {
        reject(error);
      }
    }, { timeoutMs }));
    if (response.ok) return response;
    if (response.timedOut) throw new Error(`${this.name} did not answer ${method} within ${timeoutMs} ms.`);
    if (response.closed) throw new Error(this.runner.withStderrTail(`${this.name} exited before it answered ${method}.`));
    return response;
  }

  private signedOut(): string {
    const { auth, runner } = this.profile.manifest;
    return auth ? `${this.name} is not signed in. Run \`${[runner.command, ...auth.loginArgs].join(' ')}\`.` : `${this.name} is not signed in.`;
  }

  /**
   * What the process is told before its first prompt. A planner gets its
   * system prompt and where its tools are, all from its planner token
   * (ADR-0022); a task gets the completion contract, and a read-only task
   * also that Ordewell's tools are its only shell and web (ADR-0046). One
   * started in a private directory is first told where the workspace is,
   * since its relative paths now name that empty directory.
   */
  private instructions(started: Started): string {
    const where = this.startDir ? `The workspace is \`${started.cwd}\`, not the directory you start in: name its files by their full path there.` : null;
    return [where, this.contract(started)].filter(Boolean).join('\n\n');
  }

  private contract(started: Started): string {
    const { toolName } = this.binding;
    if (started.kind === 'planner') {
      const { hidden = [], extraTools } = started.mcp;
      const tools = this.binding.toolNames('planner', hidden, extraTools);
      const web = [
        ...(hidden.includes('fetch') ? [] : [`read web pages with \`${toolName('fetch')}\``]),
        ...(hidden.includes('web_search') ? [] : [`search the web with \`${toolName('web_search')}\``]),
      ];
      return [
        started.systemPrompt,
        [
          `Your Ordewell tools come from the \`${started.mcp.name}\` MCP server: ${listed(tools.map((name) => `\`${name}\``))}.`,
          `Your own file edits, shell and web tools are off in this session: run commands with \`${toolName('run_command')}\`${web.length ? `, ${listed(web)}` : ''}.`,
        ].join(' '),
      ].join('\n\n');
    }
    const contract = taskCompletionContract(started.commits ? { commits: true } : {});
    if (!this.restricted) return contract;
    const note = `This task is read-only: your own file edits, shell and web tools are off. Read files, search the repository and run tests with \`${toolName('run_command')}\`, read web pages with \`${toolName('fetch')}\` and search the web with \`${toolName('web_search')}\`.`;
    // Started outside its worktree, the agent loads none of the repository's
    // instruction files itself, so they follow as text. A planner's are in
    // its system prompt already (ADR-0028).
    const repository = this.startDir ? instructionsBlock(this.profile.repoConfig?.instructions(started.cwd) ?? [], 'in this read-only task') : '';
    return [note, contract, repository].filter(Boolean).join('\n\n');
  }

  private requireStarted(): Started {
    if (!this.started) throw new Error(`${this.name} has not been started.`);
    return this.started;
  }

  /** A process that left its restricted mode takes no further turn: the error is said again, since the first may have had no turn to reach. */
  override async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    if (this.failure !== null) {
      onEvent({ type: 'error', message: this.failure });
      return;
    }
    await super.send(message, onEvent, signal, onActivity);
  }

  protected turnPayload(message: string): string {
    const started = this.requireStarted();
    this.turn = newTurn({ source: this.agentId, ...(started.model ? { model: started.model } : {}) });
    this.reports = new Map();
    this.cancelSent = false;
    this.noteModelCommand(message);
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
    this.modelCommandSent = false;
    // The process ending is reported by the base class, with its last words.
    if (!response.ok && response.closed) {
      answered?.(false);
      return;
    }
    this.cancelPermissions();
    if (turn) {
      if (response.ok) {
        const parsed = parseAcp(promptResponseSchema, response.result);
        const { stopReason, usage } = parsed.ok ? parsed.value : { stopReason: { unreadable: parsed.error }, usage: undefined };
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
   * What an update says of the session is kept whenever it arrives; its words
   * belong to a turn, and one outside a turn is not shown, since presenting
   * it in the next turn would pass it off as the answer to its message.
   */
  private onUpdate(params: Record<string, unknown>): void {
    const notification = parseAcp(sessionNotificationSchema, params);
    if (!notification.ok) return;
    // An agent can serve several sessions on one connection; another's
    // updates are none of this task's. Before the session has an id there is
    // nothing to compare with, and nothing of this task's to receive yet.
    if (this.sessionId !== null && notification.value.sessionId !== this.sessionId) return;
    const update = parseSessionUpdate(notification.value.update);
    if (update.sessionUpdate === 'available_commands_update') {
      this.noteCommands(update.availableCommands);
      return;
    }
    if (update.sessionUpdate === 'config_option_update') {
      this.noteOptions(update.configOptions);
      const option = findOption(update.configOptions, 'mode');
      if (option) this.holdSettledMode(currentValue(option));
      return;
    }
    if (update.sessionUpdate === 'current_mode_update') {
      this.currentMode = update.currentModeId;
      this.holdSettledMode(update.currentModeId);
      return;
    }
    if (this.turn) {
      if (update.sessionUpdate === 'tool_call' && !this.reports.has(update.toolCallId)) this.reports.set(update.toolCallId, update);
      const step = reduceUpdate(this.turn, update);
      this.turn = step.turn;
      for (const event of step.events) this.announce(event);
      return;
    }
    console.debug(`[acp] ${this.agentId}: dropped an update (${update.sessionUpdate === 'unknown' ? update.kind ?? 'nameless' : update.sessionUpdate}) outside a turn`);
  }

  /**
   * A restricted session that moves to another mode may have moved to one
   * that writes, so the attempt ends here rather than trusting the agent to
   * keep refusing (ADR-0046). The error goes out before the process does, so
   * an open turn ends on it.
   */
  private holdSettledMode(now: string | undefined): void {
    const settled = this.settledMode;
    if (!settled || now === settled.id || this.failure !== null) return;
    this.failure = `${this.name} left the mode it was started in ("${settled.id ?? 'none'}" to "${now ?? 'none'}"), so this ${this.started?.kind === 'planner' ? 'planner session' : 'read-only task'} cannot go on.`;
    this.announce({ type: 'error', message: this.failure });
    this.dispose();
  }

  private noteCommands(listed: ReadonlyArray<{ name: string; description: string; input?: { hint: string } | null }>): void {
    this.commandList = listed.map(({ name, description, input }): RunnerCommand => ({
      name,
      description,
      ...(input ? { argumentHint: input.hint } : {}),
      kind: 'command',
    }));
    if (this.commandsAnnounced) return;
    this.commandsAnnounced = true;
    this.announce({ type: 'runner_loaded', commands: this.commands(), mcpServers: [] });
  }

  /**
   * `config_option_update` carries the complete list, replacing the one held.
   * A model that differs from the one Ordewell knew is the user's own choice
   * when their message in this turn was a model command, and drift when
   * nobody asked (#106).
   */
  private noteOptions(next: AcpConfigOption[]): void {
    this.configOptions = next;
    const model = findOption(next, 'model');
    const now = currentValue(model);
    const before = this.heldModel;
    this.heldModel = now ?? before;
    if (now === undefined || before === undefined || now === before) return;
    const from = this.modelRef(before, model);
    const to = this.modelRef(now, model);
    const effort = currentValue(findOption(next, 'effort'));
    this.announce(this.modelCommandSent
      ? { type: 'model_switched', from, to, ...(effort !== undefined ? { effort } : {}) }
      : { type: 'model_drifted', from, to });
  }

  private modelRef(model: string, option: AcpConfigOption | undefined): RunnerModelRef {
    const label = option ? optionValues(option).find((value) => value.value === model)?.name : undefined;
    return { model, ...(label !== undefined ? { label } : {}) };
  }

  /** The agent runs a message that starts with a command as that command, however the surface sent it. */
  private noteModelCommand(message: string): void {
    const [, name] = /^\/(\S+)/.exec(message) ?? [];
    this.modelCommandSent = name !== undefined && (findRunnerCommand(this.commandList, name)?.name ?? name) === MODEL_COMMAND;
  }

  commands(): RunnerCommand[] { return this.commandList.map((command) => ({ ...command })); }

  /** ACP has no call for a command: the agent runs one when it is the prompt's text. */
  async invokeCommand(name: string, args: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    const command = findRunnerCommand(this.commandList, name);
    if (!command) {
      onEvent({ type: 'error', message: `${this.name} did not report command /${name}.` });
      return;
    }
    await this.send(`/${command.name}${args.trim() ? ` ${args.trim()}` : ''}`, onEvent, signal);
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
    const report = this.reports.get(toolCall.toolCallId);
    // The request says what is asked; the turn's report fills in what it leaves out.
    const call: AcpToolCall = {
      ...toolCall,
      kind: toolCall.kind ?? report?.kind,
      locations: toolCall.locations ?? report?.locations,
      rawInput: toolCall.rawInput ?? report?.rawInput,
    };
    return new Promise((resolve) => {
      this.held.set(id, { rpcId, asked: { request: call, ...(report ? { report } : {}) }, resolve: (outcome) => resolve({ outcome }) });
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
        ...(this.restricted ? { ask: acpAsk(call) } : {}),
        // By exact name only: a near miss is anyone's tool (ADR-0022, S3; ADR-0060, R7).
        ordewell: this.binding.isOrdewellAsk(report ? { request: toolCall, report } : { request: toolCall }),
      }, { id, options }, (event) => this.announce(event));
    });
  }

  /**
   * One of the agent's own requests, answered by the profile on the line that
   * carried it. A handler that cannot read the request, or throws, leaves it
   * "method not found", as if there were no handler: the agent already copes
   * with that, where an internal error might end its turn (ADR-0060).
   */
  private onExtension(method: string, handler: AcpExtensionHandler, params: unknown): Record<string, unknown> | JsonRpcError {
    const started = this.started;
    let answer: unknown;
    try {
      answer = started ? handler(params, { kind: started.kind, restricted: this.restricted }) : undefined;
    } catch (error) {
      console.debug(`[acp] ${this.agentId}: the handler for ${method} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    return isRecord(answer) ? answer : new JsonRpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
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
   * evidence (ADR-0022, S2; ADR-0060, R5): connected once the token was used, failed when the
   * agent refused the session or exited first, pending while it has not.
   */
  async mcpAttached(): Promise<AttachState> {
    const contact = this.started?.mcp.contact;
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
    // Best effort: the process goes with this call, so the agent may not read it,
    // and nothing waits for its answer.
    if (this.sessionId && this.capabilities.sessionCapabilities?.close) this.rpc.send('session/close', { sessionId: this.sessionId });
    this.rpc.close('The adapter was disposed.');
    super.dispose();
  }
}
