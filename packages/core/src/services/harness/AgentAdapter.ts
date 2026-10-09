import type { ChildProcess } from 'child_process';
import type { SubagentOutcome } from '../../models/Task';
import type { UsageRecord } from '../../models/Usage';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { McpClientConfig } from '../mcp';


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
 * One normalized event from a running agent turn. Deliberately smaller than
 * any single agent's native protocol: this is the intersection Ordewell can act
 * on, not a lossless re-encoding. Event fidelity differs by agent — `thinking`
 * is rich on Claude Code and absent elsewhere — so consumers must tolerate a
 * turn that emits nothing but `assistant_text` and `turn_end`.
 */
export type AgentEvent =
  /**
   * A complete run of the assistant's reply. Concatenated in order to form the
   * turn's text. When the same run already streamed as `assistant_text_delta`,
   * this is the authoritative copy of it — it replaces the deltas, it is not
   * appended after them.
   */
  | { type: 'assistant_text'; text: string }
  /**
   * An incremental piece of the assistant's reply, for agents that stream
   * partial messages. The planner's own text only: a subagent's words never
   * arrive here, so they can never become the reply.
   */
  | { type: 'assistant_text_delta'; text: string }
  /**
   * Reasoning the agent chose to expose. Never contributes to the reply text.
   * Like `assistant_text`, it supersedes deltas already streamed for it.
   */
  | { type: 'thinking'; text: string; subagentId?: string }
  | { type: 'thinking_delta'; text: string; subagentId?: string }
  /** `subagentId` marks a call made inside a subagent rather than by the planner itself. */
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; subagentId?: string }
  | { type: 'tool_result'; id: string; name: string; output: string; success: boolean; subagentId?: string }
  /** One model call's usage, as the agent reported it — never estimated. */
  | { type: 'usage'; record: UsageRecord }
  /** The agent delegated `brief` to a subagent, whose events carry `subagentId` until it finishes. */
  | { type: 'subagent_started'; subagentId: string; brief: string; model?: string }
  | { type: 'subagent_finished'; subagentId: string; outcome: SubagentOutcome; digest: string }
  /**
   * The agent asked to do something its mode does not cover. A planner always
   * auto-denies it (T1) — a planner that can mutate is not a planner — and the
   * adapter answers so the turn does not hang. A task's request stays open
   * until {@link TaskModeAgentAdapter.answerPermission} (ADR-0018, A1).
   *
   * `input` and `suggestions` are the raw request; `suggestions` are the
   * agent's own session-scoped grants, what "Allow for this task" answers with.
   * `decided` marks a request the task's mode already answered — the adapter
   * replied as the manifest says that mode does — so it is shown, never asked.
   */
  | { type: 'permission_request'; id: string; name: string; detail: string; input?: Record<string, unknown>; suggestions?: unknown[]; toolUseId?: string; decided?: ApprovalDecision }
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
  /** The turn failed. Carries the agent's own words — never a Ordewell paraphrase. */
  | { type: 'error'; message: string };

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
}

/**
 * What a runner manifest says the task's mode and effort mean (ADR-0001),
 * resolved by the same code terminal tasks use — see `resolveTaskRunnerFlags`.
 * The adapter adds only its protocol flags around these.
 */
export interface TaskRunnerFlags {
  /** The runner's own permission-mode value for the task's mode. */
  permissionMode: string;
  /** The task's raw effort id, present only alongside a model. Each adapter maps it to its own protocol. */
  effort?: string;
  /** The manifest's further settings for the task's mode, by setting name — see `RunnerFeatures.modeSettings`. */
  modeSettings: Record<string, string>;
}

/** A plan task driven over the runner's programmatic protocol (ADR-0018, C1). */
export interface TaskStartOptions extends AgentStartCommon {
  kind: 'task';
  /** The task's runner mode id, as the plan names it. */
  mode: string;
  flags: TaskRunnerFlags;
  /**
   * The Ordewell MCP server and this attempt's token (ADR-0022). An adapter
   * that can inject it does, with its tools pre-approved; one that cannot
   * ignores it, and the task completes by its marker.
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

  /** Kill the process and release its resources. Idempotent. */
  dispose(): void;

  /**
   * Whether the Ordewell MCP server passed in {@link PlannerStartOptions.mcp}
   * is connected, as the runner itself reports it (ADR-0022, S4). Absent on an
   * adapter that cannot inject the server at all.
   */
  mcpAttached?(): Promise<boolean>;
}

/** What an adapter adds to run a task rather than a planner (ADR-0018). */
export interface TaskModeAgentAdapter extends AgentAdapter {
  /**
   * Ask the running turn to stop, keeping the process and its session. Resolves
   * true once the agent acknowledged it; the turn then ends with
   * `turn_end { interrupted: true }`. False means the agent did not answer
   * within `timeoutMs`, and the caller must fall back to killing it.
   */
  interrupt(timeoutMs: number): Promise<boolean>;
  /**
   * Registers the listener for what the agent does after a turn has ended and
   * before the next message — a turn it opens itself when background work
   * finishes, most often. Without one that output is dropped, which is right
   * for a planner and wrong for a task, whose marker may be said there.
   */
  onOutOfTurn?(listener: (event: AgentEvent) => void): void;
  /** Registers a listener for the process ending, for any reason. Fires at most once. */
  onProcessExit(listener: (code: number) => void): void;
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
  /**
   * Answer an open `permission_request`. False when the id is not open — it
   * was answered, cancelled, or never asked.
   */
  answerPermission(id: string, decision: ApprovalDecision): boolean;
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
