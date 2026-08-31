import type { SpawnFn } from '../HeadlessRunner';


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
  /** A chunk of the assistant's reply. Concatenated in order to form the turn's text. */
  | { type: 'assistant_text'; text: string }
  /** Reasoning the agent chose to expose. Never contributes to the reply text. */
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: string; success: boolean }
  /**
   * The agent asked to do something its read-only mode does not cover. Always
   * auto-denied (T1) — a planner that can mutate is not a planner. The adapter
   * is responsible for answering the agent so the turn does not hang.
   */
  | { type: 'permission_request'; id: string; name: string; detail: string }
  /**
   * The agent delegated work to a subagent it left running in the background,
   * and may end its turn before that work reports. Ordewell's conversation is
   * request/response: a turn that ends hands control back to the user, and
   * anything the agent says afterwards arrives with no turn open and is lost.
   * Naming the launch is what lets the service ask for the results in time.
   */
  | { type: 'background_agent'; id: string }
  /** The agent finished its turn and is waiting for the next user message. */
  | { type: 'turn_end' }
  /** The turn failed. Carries the agent's own words — never a Ordewell paraphrase. */
  | { type: 'error'; message: string };

export interface AgentStartOptions {
  /** Workspace root. The agent explores from here and, in read-only mode, cannot leave it. */
  cwd: string;
  /** The planner system prompt, in its harness variant. */
  systemPrompt: string;
  /** Model id from the runner's own discovery catalog. Omitted means the agent's default. */
  model?: string;
  /** Variant / reasoning effort id from that model's `variants` list. */
  effort?: string;
  /**
   * The agent's own session id from a previous run. A hint only: Ordewell's
   * transcript is the source of truth (T4), so a failed resume degrades to a
   * fresh session seeded from the stored history rather than an error.
   */
  resumeSessionId?: string;
}

export interface AgentAdapter {
  /** The runner id this adapter drives — `claude-code`, `codex`, `opencode`. */
  readonly agentId: string;

  /** Spawn the agent in its read-only mode and get it ready to receive messages. */
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
}

/**
 * The single injected boundary between Ordewell and the operating system —
 * the same pattern `HeadlessRunnerDeps` uses for task execution. Tests feed
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
