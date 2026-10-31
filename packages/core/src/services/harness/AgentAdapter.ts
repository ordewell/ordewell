import type { ChildProcess } from 'child_process';
import type { SubagentOutcome } from '../../models/Task';
import type { RunnerSessionCost, UsageRecord } from '../../models/Usage';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { McpClientConfig } from '../mcp';
import type { ProjectMcpServer } from './repoConfig';
import type { RunnerCommand, RunnerMcpServer, RunnerModelRef } from '../../models/RunnerCommand';
import type { PlannerShellSandbox } from '../sandbox/plannerSandbox';
import type { AttachState } from './ordewellBinding';


/**
 * The harness-planner transport contract (ADR-0009).
 *
 * One adapter per coding agent, each speaking that agent's own programmatic
 * protocol and normalizing it to the event union below. Everything above this
 * line — reply classification, the repair loop, plan validation, the four
 * surfaces — is already provider-agnostic, so an adapter is the entire cost of
 * teaching Ordewell to plan with another agent.
 */

/**
 * A runner's structured word that its account's usage limit ended the turn
 * (ADR-0018, U1). `resetsAt` (ISO) is when, where the runner's own limit state
 * says so; without it the reset is read from the error's words, as for a
 * runner that reports the limit in words alone.
 */
export interface UsageLimitSignal {
  resetsAt?: string;
}

/**
 * One normalized event from a running agent turn. Deliberately smaller than
 * any single agent's native protocol: this is the intersection Ordewell can act
 * on, not a lossless re-encoding. Event fidelity differs by agent — `thinking`
 * is rich on Claude Code and absent elsewhere — so consumers must tolerate a
 * turn that emits nothing but `assistant_text` and `turn_end`.
 */
export type AgentEvent =
  /**
   * A complete run of the assistant's reply — one text block, message or
   * part — under `runId`, the runner's own id for it. It is the authoritative
   * copy of the deltas streamed under the same id: it replaces them wherever
   * they now sit, it is not appended after them. No run carries the
   * paragraph break between it and the one before; a consumer joining runs
   * puts one there itself.
   */
  | { type: 'assistant_text'; runId: string; text: string }
  /**
   * An incremental piece of the run `runId`, for agents that stream partial
   * messages. A run's first delta marks where it began, which is where it
   * stays when its complete copy arrives after later steps. The planner's own
   * text only: a subagent's words never arrive here, so they can never
   * become the reply.
   */
  | { type: 'assistant_text_delta'; runId: string; text: string }
  /**
   * Reasoning the agent chose to expose. Never contributes to the reply text.
   * Like `assistant_text`, it supersedes deltas already streamed for it.
   */
  | { type: 'thinking'; text: string; subagentId?: string }
  | { type: 'thinking_delta'; text: string; subagentId?: string }
  /** `subagentId` marks a call made inside a subagent rather than by the planner itself. */
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; subagentId?: string }
  | { type: 'tool_result'; id: string; name: string; output: string; success: boolean; subagentId?: string }
  /** Usage and session billing facts as the agent reported them — never priced by Ordewell. */
  | { type: 'usage'; record: UsageRecord }
  /** The agent delegated `brief` to a subagent, whose events carry `subagentId` until it finishes. */
  | { type: 'subagent_started'; subagentId: string; brief: string; model?: string }
  | { type: 'subagent_finished'; subagentId: string; outcome: SubagentOutcome; digest: string }
  /**
   * The agent asked to do something its mode does not cover. Without
   * `decided` the request stays open until {@link AgentAdapter.answerPermission}:
   * a task's for a person (ADR-0018, A1), a planner's for the planner's
   * envelope (ADR-0026). An adapter that cannot hold a planner's request open
   * denies it itself and says so in `decided`, so the turn does not hang.
   *
   * `input` and `suggestions` are the raw request; `suggestions` are the
   * agent's own session-scoped grants, what "Allow for this task" answers with.
   * `decided` marks a request already answered — by the adapter, as the
   * manifest says the task's mode does, or as a denial — so it is shown, never asked.
   * `ask` is what a planner's open request is for, in the envelope's terms.
   */
  | { type: 'permission_request'; id: string; name: string; detail: string; input?: Record<string, unknown>; suggestions?: unknown[]; toolUseId?: string; decided?: ApprovalDecision; ask?: PlannerAsk }
  /** The agent withdrew an open request — an interrupt cancels the call it was for. It takes no answer now. */
  | { type: 'permission_cancelled'; id: string }
  /**
   * The agent delegated work to a subagent it left running in the background,
   * and may end its turn before that work reports. Ordewell's conversation is
   * request/response: a turn that ends hands control back to the user, and
   * anything the agent says afterwards arrives with no turn open and is lost.
   * Naming the launch is what lets the service ask for the results in time.
   */
  | { type: 'background_agent'; id: string }
  /**
   * The agent finished its turn and is waiting for the next user message.
   * `interrupted` marks a turn cut short by {@link TaskModeAgentAdapter.interrupt}
   * rather than one the agent chose to end.
   */
  | { type: 'turn_end'; interrupted?: boolean }
  /**
   * The model has a message handed over by {@link TaskModeAgentAdapter.steer},
   * by the runner's own account rather than because the write succeeded
   * (ADR-0023, D3). With no turn open, the runner opened one for it.
   */
  | { type: 'message_delivered'; id: string }
  /**
   * The runner let go of a message it accepted from `steer` without showing it
   * to the model — Codex does, for one its turn ended before consuming. It is
   * Ordewell's to send again (ADR-0023, D4).
   */
  | { type: 'message_dropped'; id: string }
  /**
   * The turn failed. Carries the agent's own words — never a Ordewell paraphrase.
   * `usageLimit` is set where the runner's protocol says in a field, not only
   * in words, whether its account's usage limit failed the turn: `false` when
   * the field names another cause, which its words then cannot overrule.
   */
  | { type: 'error'; message: string; usageLimit?: UsageLimitSignal | false }
  /**
   * What the runner loaded for this process from the user's and the
   * project's own setup (#66): its commands and skills, and its MCP servers.
   * Once per process, as it starts its first turn.
   */
  | { type: 'runner_loaded'; commands: RunnerCommand[]; mcpServers: RunnerMcpServer[] }
  /** The runner compacted its own context: asked to (`manual`) or on its own (`auto`). */
  | { type: 'compaction'; trigger: 'manual' | 'auto'; preTokens?: number; postTokens?: number }
  /** What a runner command that runs without the model printed, as the runner reported it. */
  | { type: 'command_output'; text: string }
  /**
   * The runner's main thread now answers on another model, after a model
   * command sent through the task's chat (#106): the user's own choice, which
   * the plan follows. Each side is named by the id the runner lists it under,
   * the one a plan holds. `effort` only where the runner reports one.
   */
  | { type: 'model_switched'; from: RunnerModelRef; to: RunnerModelRef; effort?: string }
  /**
   * The runner's main thread now answers on another model with no model
   * command before it (#106). Nobody in the chat chose it, so the plan does
   * not follow; the drift is reported so it is stated, not hidden.
   */
  | { type: 'model_drifted'; from: RunnerModelRef; to: RunnerModelRef };

/**
 * What a planner's permission request is for, read from the runner's own
 * request by its adapter, so one envelope decides it whichever runner asked
 * (ADR-0026). `other` is anything the envelope never grants a planner.
 */
export type PlannerAsk =
  /** `scope` is the tool's full name as the runner reports it; `tool` its own name, without the server. */
  | { kind: 'mcp'; scope: string; tool: string; server?: string }
  | { kind: 'fetch'; url: string }
  /**
   * A search the runner carries itself, at `provider`; Ordewell decides it, it does not run it.
   * `providerLabel` names that party in the approval.
   */
  | { kind: 'search'; query: string; provider: string; providerLabel?: string }
  | { kind: 'path'; path: string; directory: boolean }
  /** A command through the harness's own shell, allowed by the user's opt-in and held in Ordewell's sandbox (ADR-0036 N2, N3). */
  | { kind: 'native-shell'; tool: string; command?: string }
  /** `note` is why, for a tool the runner knows the planner must not use, in place of the envelope's generic refusal. */
  | { kind: 'other'; note?: string };

interface AgentStartCommon {
  /** Workspace root. The agent works from here and, in read-only mode, cannot leave it. */
  cwd: string;
  /** Model id from the runner's own discovery catalog. Omitted means the agent's default. */
  model?: string;
  /**
   * The agent's own session id from a previous run. For the planner a hint
   * only: Ordewell's transcript is the source of truth (T4), so a failed resume
   * degrades to a fresh session seeded from the stored history, not an error.
   */
  resumeSessionId?: string;
  /** What was counted of the cost of `resumeSessionId` before, for a runner that reports a running total. */
  resumeCost?: RunnerSessionCost;
}

/** The read-only planner (ADR-0008/0009). The only start `CliAgentAiService` can express. */
export interface PlannerStartOptions extends AgentStartCommon {
  kind: 'planner';
  /** The planner system prompt, in its harness variant. */
  systemPrompt: string;
  /** Variant / reasoning effort id from that model's `variants` list. */
  effort?: string;
  /** The Ordewell MCP server to inject, pre-authorized (ADR-0022). Only for an adapter with {@link AgentAdapter.mcpAttached}. */
  mcp?: McpClientConfig;
  /**
   * Whether the runner's own search is on, for a runner whose search raises
   * no permission request and is set on or off when its session starts
   * (ADR-0027). Decided once, before the planner token is issued, so the
   * tools the token serves and the session's config cannot disagree. Absent
   * means off.
   */
  nativeSearch?: boolean;
  /**
   * Whether the user let this planner use its harness's own shell beside
   * Ordewell's tools (ADR-0036 N1). The caller sets it only for a version that
   * passed N2's live checks (see `nativeShellOffer`); absent means off. When
   * true, the adapter puts every command in Ordewell's sealed profile (N2).
   */
  nativeShell?: boolean;
  /**
   * The repository's own MCP servers this planner may start, as approved
   * (ADR-0028). The runner is launched without the repository's config, so
   * these are the only ones it gets, and each is handed over as parsed.
   */
  projectServers?: ProjectMcpServer[];
}

/**
 * What a runner manifest says the task's mode and effort mean (ADR-0001),
 * resolved from the runner manifest — see `resolveTaskRunnerFlags`.
 * The adapter adds only its protocol flags around these.
 */
export interface TaskRunnerFlags {
  /** Ordewell's read-only profile, independent of the runner's native modes (ADR-0046). */
  readOnly?: true;
  /** The runner's own permission-mode value for the task's mode. */
  permissionMode: string;
  /** The task's raw effort id, present only alongside a model. Each adapter maps it to its own protocol. */
  effort?: string;
  /** The manifest's further settings for the task's mode, by setting name — see `RunnerFeatures.modeSettings`. */
  modeSettings: Record<string, string>;
}

/**
 * What a task runner loads of the user's own setup (the `taskRunnerConfig`
 * setting): `user` is everything the runner would load for the user,
 * `minimal` only what a task needs — Ordewell's server, the repository's
 * instructions — so the user's connectors, skills and settings do not ride in
 * every attempt's context. Runners that cannot narrow their setup ignore it.
 */
export type TaskRunnerConfig = 'user' | 'minimal';

/** A plan task driven over the runner's programmatic protocol (ADR-0018, C1). */
export interface TaskStartOptions extends AgentStartCommon {
  kind: 'task';
  /** The session workspace, also readable when cwd is an isolated task worktree (ADR-0046). */
  workspaceRoot?: string;
  /** The task's runner mode id, as the plan names it. */
  mode: string;
  flags: TaskRunnerFlags;
  /** What the runner loads of the user's setup; absent means `user`. */
  runnerConfig?: TaskRunnerConfig;
  /** The attempt's work lands as a commit (ADR-0047): its completion contract asks for the message. */
  commits?: true;
  /**
   * The Ordewell MCP server and this attempt's token (ADR-0022), injected
   * with its tools pre-approved. A task is never started without it: its
   * `task_complete` call is how it reports it is done.
   */
  mcp?: McpClientConfig;
}

/**
 * The explicit start switch. Discriminated so that a read-only planner and a
 * mutating task can never be confused by a missing field: every caller names
 * which one it is starting.
 */
export type AgentStartOptions = PlannerStartOptions | TaskStartOptions;

/** A runner asked to start in task mode that has no task-mode connector yet. */
export class TaskModeUnsupportedError extends Error {
  constructor(readonly runner: string) {
    super(`${runner} has no structured task connector, so Ordewell cannot run its tasks.`);
    this.name = 'TaskModeUnsupportedError';
  }
}

export interface AgentAdapter {
  /** The runner id this adapter drives — `claude-code`, `codex`, `opencode`. */
  readonly agentId: string;

  /** Spawn the agent — read-only for a planner, in the task's mode for a task — ready to receive messages. */
  start(opts: AgentStartOptions): Promise<void>;

  /**
   * Send one user message and stream the turn's events until it ends. Resolves
   * when the agent yields the floor; rejects only when the transport itself
   * failed in a way no `error` event could describe.
   *
   * `onActivity`, when given, fires on raw transport traffic — every stdio
   * line or stream chunk the process produces — independent of whether that
   * traffic becomes an `AgentEvent`. An adapter may legitimately emit nothing
   * for long stretches (a subagent's filtered output, most often); a caller
   * using presence-of-events as a liveness signal would read that silence as
   * a hang. `onActivity` is the seam that keeps liveness detection from being
   * coupled to what each adapter chooses to surface.
   */
  send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void>;

  /** The agent's native session id once it has announced one. Resumption hint only. */
  nativeSessionId(): string | null;

  /**
   * The installed version the agent reported, once it has (ADR-0036 N2):
   * Claude Code's `claude_code_version` on its first `init`, an OpenCode 2.x
   * server's `/api/info`. Null while unknown, and on OpenCode 1.x, which does
   * not report one.
   */
  version?(): string | null;

  /** What has been counted of the session's running cost, for a runner that reports one; null while unknown. */
  sessionCost?(): RunnerSessionCost | null;

  /** Kill the process and release its resources. Idempotent. */
  dispose(): void;

  /** Whether the process has ended, for any reason. One that has can take no further turn. */
  readonly exited: boolean;

  /**
   * Whether the Ordewell MCP server passed in the start options' `mcp` is
   * connected, as the runner itself reports it (ADR-0022, S4). Absent on an
   * adapter that cannot inject the server at all, which cannot run tasks.
   * `false` is the old boolean answer for "not attached"; a real adapter says
   * `pending` while its process is still starting, or `failed` when the
   * runner reports the server cannot connect.
   */
  mcpAttached?(): Promise<boolean | AttachState>;

  /**
   * Registers a listener for the process ending, for any reason; a planner
   * reads it to tell a runner that exited while it started. Fires at most
   * once. `lastWords` is how it ended, with its stderr tail.
   */
  onProcessExit?(listener: (code: number, lastWords?: string) => void): void;

  /**
   * The approved project servers (ADR-0028) this runner started but cannot
   * give the planner as tools of their own, known once `start` resolved.
   * Absent on an adapter that gives the planner every one it starts.
   */
  unusableProjectServers?(): ProjectMcpServer[];

  /**
   * Whether `abs`, already resolved on disk, is output this runner saved
   * outside the workspace for this session and told its planner to read back
   * (ADR-0032). The planner reads it as it reads the workspace. Absent on a
   * runner that saves none.
   */
  savedOutput?(abs: string): boolean;

  /**
   * Answer an open `permission_request`. False when the id is not open — it
   * was answered, cancelled, or never asked. Absent on an adapter that leaves
   * no planner request open. HTTP replies resolve only after delivery and
   * reject on failure, leaving the request open for another attempt.
   */
  answerPermission?(id: string, decision: ApprovalDecision): boolean | Promise<boolean>;
}

/** What an adapter adds to run a task rather than a planner (ADR-0018). */
export interface TaskModeAgentAdapter extends AgentAdapter {
  mcpAttached(): Promise<boolean | AttachState>;
  /**
   * Ask the running turn to stop, keeping the process and its session. Resolves
   * true once the agent acknowledged it; the turn then ends with
   * `turn_end { interrupted: true }`. False means the agent did not answer
   * within `timeoutMs`, and the caller must fall back to killing it.
   */
  interrupt(timeoutMs: number): Promise<boolean>;
  /**
   * Tell the process nothing more is coming, once its turn has closed, so it
   * ends by itself and keeps what it saves on the way out. The process exit
   * reports its end. Absent on a runner whose process is only ever killed.
   */
  endInput?(): void;
  /**
   * Registers the listener for what the agent does after a turn has ended and
   * before the next message — a turn it opens itself when background work
   * finishes, most often. Without one that output is dropped, which is right
   * for a planner and wrong for a task, which may report completion there.
   */
  onOutOfTurn?(listener: (event: AgentEvent) => void): void;
  /**
   * Registers a listener for the process ending, for any reason. Fires at most
   * once. `lastWords` is how it ended, with its stderr tail.
   */
  onProcessExit(listener: (code: number, lastWords?: string) => void): void;
  /**
   * Hand a message to the running turn, for the runner to show the model at
   * its next step boundary (ADR-0023, D1–D2). Resolves true once the runner
   * accepted it: handed over, not yet delivered — the turn's events later
   * carry `message_delivered` or `message_dropped` for `id`. False when the
   * runner refused it or no turn is running; the caller keeps it for the
   * turn's end. Absent on an adapter whose runner cannot take a message
   * mid-turn.
   */
  steer?(id: string, text: string): Promise<boolean>;
  answerPermission(id: string, decision: ApprovalDecision): boolean | Promise<boolean>;
  /**
   * The slash commands the runner offers this session — its built-ins, the
   * user's and the project's skills and custom commands (#66) — as it
   * reported them. Empty until it has; absent on a runner that reports none.
   */
  commands?(): RunnerCommand[];
  /**
   * Run the runner's own command `name` as a turn, the way {@link send} runs
   * a message: resolves when the turn ends. Absent on a runner whose
   * commands cannot be invoked over its protocol.
   */
  invokeCommand?(name: string, args: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<void>;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: Array<'pipe' | 'ignore'>;
    cwd: string;
    /** Set by the Windows batch route, where `args` is already a quoted command line. */
    windowsVerbatimArguments?: boolean;
    /** Set on POSIX so the runner leads its own process group (see `spawnInOwnGroup`). */
    detached?: boolean;
  },
) => ChildProcess;

/**
 * The single injected boundary between Ordewell and the operating system.
 * Tests feed
 * recorded agent output through `spawn` (and, for HTTP-transport agents,
 * `fetch`) so one test exercises adapter parsing, event mapping, reply
 * classification and the repair loop as a single observable behavior.
 */
export interface AgentProcessDeps {
  spawn: SpawnFn;
  fetch: typeof globalThis.fetch;
  /** Resolves the PATH agents are spawned under. Defaults to the augmented PATH. */
  resolvePath?: () => Promise<string>;
  /** Host platform. Defaults to the real one; injected so OS-specific behavior is testable anywhere. */
  platform?: NodeJS.Platform;
  /** True when `workspace` names an existing directory. Defaults to a real filesystem check. */
  isDirectory?: (workspace: string) => boolean;
  /** True when `candidate` names an existing, spawnable file. Defaults to a real filesystem check. */
  exists?: (candidate: string) => boolean;
  /** The workspace's own variables for a cwd (ADR-0016). Defaults to {@link resolveWorkspaceEnv}. */
  workspaceEnv?: (cwd: string) => Promise<Record<string, string>>;
  /** Builds the sandbox around a planner's own shell (ADR-0036 N2). Defaults to the host's probe. */
  nativeShellSandbox?: () => PlannerShellSandbox;
}

/** Builds the adapter for one runner id, or null when that runner cannot plan. */
export type AgentAdapterFactory = (runner: string, deps: AgentProcessDeps) => AgentAdapter | null;

/**
 * Split a stream of chunks into complete lines. Every agent transport here is
 * newline-delimited JSON of some shape, and a chunk boundary lands mid-object
 * often enough that parsing per-chunk silently drops events.
 */
export class LineBuffer {
  private buffer = '';

  push(chunk: string, onLine: (line: string) => void): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) onLine(line);
    }
  }

  /** Anything left unterminated when the stream closed. */
  flush(): string {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest;
  }
}
