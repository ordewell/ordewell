import type { AgentEvent } from '../services/harness/AgentAdapter';
import type { CheckpointAnswer, TaskCompleteArgs } from '../services/mcp/tools';
import type { ApprovalDecision } from './IApproval';
import type { TaskSkillSnapshot } from '../models/Task';

export interface ITerminalSession {
  id: string;
  taskId: string;
  onOutput(callback: (text: string) => void): void;
  onExit(callback: (code: number) => void): void;
  kill(): void;
  getOutput(): string;
  write(text: string): void;
}

/** How a structured turn ended. `failed` carries the agent's own words in the preceding `error` event. */
export type StructuredTurnEnd = 'completed' | 'interrupted' | 'failed';

/**
 * One normalized event from a structured task (ADR-0018, O1b): the adapter's
 * events, with the turn made explicit at both ends and the message queue (M1)
 * alongside. Subagent work carries its `subagentId`. The source for the
 * full-fidelity task log, never for verdicts.
 */
export type StructuredEvent =
  | Exclude<AgentEvent, { type: 'turn_end' | 'permission_cancelled' | 'message_delivered' | 'message_dropped' }>
  /**
   * `text` is the user message the turn answers; `messageId` is set when it had
   * waited in the queue, `forced` when it was force sent (ADR-0023, Q2).
   */
  | { type: 'turn_start'; text: string; messageId?: string; forced?: boolean }
  | { type: 'turn_end'; reason: StructuredTurnEnd }
  /**
   * Waiting in Ordewell's queue — again, for a message the runner was handed
   * and let go of (ADR-0023, D4). `forced` puts it ahead of the rest, behind
   * earlier forced ones (F2); a message already listed moves there.
   */
  | { type: 'message_queued'; messageId: string; text: string; forced?: boolean }
  | { type: 'message_removed'; messageId: string }
  | { type: 'message_undelivered'; messageId: string; text: string }
  /** The runner accepted the message into its running turn; it can no longer be taken back (ADR-0023, D3). */
  | { type: 'message_handed_over'; messageId: string }
  /** The model read the message inside the running turn, at this point of it (ADR-0023, Q2). */
  | { type: 'message_delivered'; messageId: string; text: string }
  /** An open `permission_request` was answered, by whoever answered it (ADR-0018, A1). */
  | { type: 'permission_decided'; id: string; decision: ApprovalDecision }
  /** An open `permission_request` can no longer be answered: the runner withdrew it, or its process is gone. */
  | { type: 'permission_withdrawn'; id: string };

export interface QueuedTaskMessage {
  id: string;
  text: string;
  /** The runner has it and owes a delivery, so it cannot be taken back (ADR-0023, Q1). */
  handedOver?: boolean;
  /** Force sent: it goes out as soon as the running turn is interrupted (ADR-0023, F1). */
  forced?: boolean;
}

/**
 * What a session driven over its runner's protocol can do that a terminal
 * cannot (ADR-0018, S2). Optional: callers feature-detect it with
 * {@link isStructuredSession}, and code that does not look behaves as it did.
 */
export interface StructuredSessionCapability {
  readonly transport: 'structured';
  /** `working` while a turn runs; `idle` between turns, waiting for a message. */
  turnState(): 'working' | 'idle';
  onTurnEnd(listener: (reason: StructuredTurnEnd) => void): void;
  onEvent(listener: (event: StructuredEvent) => void): void;
  /**
   * Send a user message: at once when idle; while a turn runs, handed to the
   * runner for its next step where it can take one, otherwise queued until
   * the turn ends (ADR-0023). Returns its id, for {@link removeQueued}.
   */
  sendMessage(text: string): string;
  /**
   * Force send (ADR-0023, F1–F3): interrupt the running turn, as
   * {@link interrupt} does, and deliver this message as the turn that
   * replaces it, ahead of anything still queued. The task does not wait for
   * input in between. With no turn running it is {@link sendMessage}.
   */
  forceSend(text: string): string;
  /** Force send a message still queued, by id. False once it was handed over or delivered. */
  forceSendQueued(id: string): boolean;
  /** Take a message back before the runner has it. False once it was handed over or delivered. */
  removeQueued(id: string): boolean;
  /** Messages not yet delivered, oldest first: queued ones, and ones handed over that the runner owes. */
  queued(): QueuedTaskMessage[];
  /**
   * Stop the running turn, keeping the session: a soft interrupt first, then —
   * if the runner does not answer in time — kill and resume. Either way the
   * turn ends `interrupted`. Resolves once it has.
   */
  interrupt(): Promise<void>;
  /** The runner's own session id once announced — what a continue resumes (ADR-0018, K1). */
  nativeSessionId(): string | null;
  /**
   * Answer a `permission_request` this session emitted, by its event id. False
   * when it is no longer open — answered, withdrawn, or never asked.
   */
  answerPermission(id: string, decision: ApprovalDecision): boolean;
  /**
   * The runner's `task_complete` calls on this attempt's token (ADR-0022):
   * the only completion evidence, for `VerdictEngine` to weigh.
   */
  onTaskComplete(listener: (report: TaskCompleteArgs) => void): void;
  /**
   * Answers the runner's `checkpoint` calls (ADR-0022, V5): the call stays
   * open until the returned promise settles, and its result is the answer.
   * `signal` aborts when the caller goes away.
   */
  onToolCheckpoint(handler: (question: string, signal: AbortSignal) => Promise<CheckpointAnswer>): void;
}

export function isStructuredSession(session: ITerminalSession): session is ITerminalSession & StructuredSessionCapability {
  return (session as Partial<StructuredSessionCapability>).transport === 'structured';
}

import type { RunnerRegistry } from '../plugins/RunnerRegistry';

export interface ITerminalRunner {
  spawn(opts: {
    taskId: string;
    runner: string;
    prompt: string;
    modelId?: string;
    thinkingEffort?: string;
    modelVariants?: string[];
    mode?: string;
    cwd: string;
    registry?: RunnerRegistry;
    /** Task order and title — surfaces use these to label task_started/output events. */
    order?: number;
    title?: string;
    /**
     * The owning plan session. Task ids are only unique within one plan, so
     * a runner that keys anything by task (the attempt's MCP token) needs this
     * to keep two plans' identically named tasks apart.
     */
    planSessionId?: string;
    /**
     * The workspace's own variables (ADR-0016), under the runner's: a
     * manifest's env still wins over them.
     */
    env?: Record<string, string>;
    /** The runner's own session to continue in (ADR-0018, K1). */
    resumeSessionId?: string;
    /**
     * Which run of the task this is, from 1. A structured runner binds the
     * attempt's MCP token to it (ADR-0022, A2).
     */
    attempt?: number;
    /**
     * The task skills already rendered into `prompt`, as resolved for this
     * attempt. Runners ignore it; it is for what wraps one to record (task logs).
     */
    skills?: readonly TaskSkillSnapshot[];
    /** Something the user should know about how the spawn went that did not stop it — a respawn, most often. */
    onNotice?: (message: string) => void;
  }): Promise<ITerminalSession>;

  stop(sessionId: string): void;
  stopAll(): void;
  activeCount: number;
}
