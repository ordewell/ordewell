import type { AgentEvent, TaskRunnerConfig } from '../services/harness/AgentAdapter';
import type { ApplyPatchArgs, CheckpointAnswer, McpToolReply, ReadTaskArgs, TaskCompleteArgs } from '../services/mcp/tools';
import type { ApprovalDecision } from './IApproval';
import type { TaskSkillSnapshot } from '../models/Task';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { RunnerCommand } from '../models/RunnerCommand';
import type { RunnerSessionCost } from '../models/Usage';
import type { ScriptBody } from '../models/ScriptTask';
import type { TaskShell } from './IFileSystem';
import type { HandoffCheck } from '../models/Handoff';
import type { TaskWebReads } from '../services/taskWebReads';
/** How a structured turn ended. `failed` carries the agent's own words in the preceding `error` event. */
export type StructuredTurnEnd = 'completed' | 'interrupted' | 'failed';
/**
 * Who sent a task message that is not the user's: Ordewell itself, for the
 * completion reminder (ADR-0018, W1). Absent means the user.
 */
export type TaskMessageFrom = 'ordewell';

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
   * waited in the queue, `forced` when it was force sent (ADR-0023, Q2), `from`
   * when Ordewell sent it. `command` is set on a turn that runs the runner's
   * own command (#66); `text` is then that command as the runner read it.
   */
  | { type: 'turn_start'; text: string; messageId?: string; forced?: boolean; from?: TaskMessageFrom; command?: InvokedCommand }
  | { type: 'turn_end'; reason: StructuredTurnEnd }
  /**
   * Waiting in Ordewell's queue — again, for a message the runner was handed
   * and let go of (ADR-0023, D4). `forced` puts it ahead of the rest, behind
   * earlier forced ones (F2); a message already listed moves there, still
   * handed over if it was.
   */
  | { type: 'message_queued'; messageId: string; text: string; forced?: boolean; from?: TaskMessageFrom }
  | { type: 'message_removed'; messageId: string }
  | { type: 'message_undelivered'; messageId: string; text: string; from?: TaskMessageFrom }
  /** The runner accepted the message into its running turn; it can no longer be taken back (ADR-0023, D3). */
  | { type: 'message_handed_over'; messageId: string }
  /** The model read the message inside the running turn, at this point of it (ADR-0023, Q2). */
  | { type: 'message_delivered'; messageId: string; text: string; from?: TaskMessageFrom }
  /** An open `permission_request` was answered, by whoever answered it (ADR-0018, A1). */
  | { type: 'permission_decided'; id: string; decision: ApprovalDecision }
  /** An open `permission_request` can no longer be answered: the runner withdrew it, or its process is gone. */
  | { type: 'permission_withdrawn'; id: string }
  /**
   * The runner's `task_complete` call was accepted on the attempt's token, with
   * the status it reported (ADR-0018, L1). A receipt, not evidence: the report
   * reaches {@link IRunnerSession.onTaskComplete} once its turn closes or the
   * interrupt grace runs out, and a turn or message the runner reads first voids it.
   */
  | { type: 'completion_received'; status: TaskCompleteArgs['status'] }
  /** A script task's command as it starts (ADR-0035): its argument vector, or its script, once. */
  | ({ type: 'script_run' } & ScriptRun)
  /**
   * What the running command printed, its stdout and stderr as they came.
   * `omittedChars` is set on the tail of an output too long to keep whole: that
   * much of its middle was left out.
   */
  | { type: 'script_output'; text: string; omittedChars?: number }
  /** How the command ended, and after how long; `timedOut` when the task's time limit ended it. */
  | ({ type: 'script_exit'; durationMs: number; timedOut?: true } & ScriptStatus);

/** What one step of a script task runs: an argument vector of its `commands`, or its `script`. */
export type ScriptRun = { argv: string[] } | { script: string };

/** How a script task's process ended: its exit code, or the signal that ended it; `error` when it could not start. */
export interface ScriptStatus {
  code: number | null;
  signal: string | null;
  error?: string;
}

/**
 * How a script task's body ended (ADR-0035): the evidence its session hands
 * `VerdictEngine`, as a runner's `task_complete` call is handed to it.
 * `command` names the command of `commands` it ended on, as a reader would
 * type it; a `script` body is one step and names none. `errorTail` is the end
 * of what that step wrote to stderr. `fullOutput` is the file that holds all
 * of the attempt's output, since the task log keeps only its ends.
 */
export type ScriptExit = (
  | { outcome: 'passed' }
  | { outcome: 'failed'; command?: string; status: ScriptStatus; errorTail: string }
  | { outcome: 'timed-out'; command?: string; timeoutMs: number; errorTail: string }
  | { outcome: 'stopped'; command?: string }
) & { fullOutput?: ScriptFullOutput };

/** Where a script task attempt's whole output was saved, and how much of it a hard cap did not keep. */
export interface ScriptFullOutput {
  file: string;
  droppedChars: number;
}

/** A runner command a user invoked, with its arguments as typed. */
export interface InvokedCommand {
  name: string;
  args?: string;
}

export interface QueuedTaskMessage {
  id: string;
  text: string;
  /** The runner has it and owes a delivery, so it cannot be taken back (ADR-0023, Q1). */
  handedOver?: boolean;
  /** Force sent: it goes first once the running turn is interrupted (ADR-0023, F1). Every listed message can be, handed over or not. */
  forced?: boolean;
  from?: TaskMessageFrom;
}

export interface IRunnerSession {
  id: string;
  taskId: string;
  onOutput(callback: (text: string) => void): void;
  onExit(callback: (code: number) => void): void;
  /** End the process at once. {@link stop} is how an attempt that is over lets it go. */
  kill(): void;
  /**
   * End the session the way its runner ends a turn (ADR-0018, L1): nothing
   * more is sent, a turn still open is interrupted and given the interrupt
   * grace to close — so what the runner reports as it closes, its cost and a
   * last call's usage, still reaches {@link onEvent} — then the process ends,
   * by itself where its runner can, killed once the grace runs out. Resolves
   * once it is gone, after {@link onExit}; at once when it already is.
   */
  stop(): Promise<void>;
  getOutput(): string;
  write(text: string): void;
  /** `working` while a turn runs; `idle` between turns, waiting for a message. */
  turnState(): 'working' | 'idle';
  onTurnEnd(listener: (reason: StructuredTurnEnd) => void): void;
  onEvent(listener: (event: StructuredEvent) => void): void;
  /**
   * Send a user message: at once when idle; while a turn runs, handed to the
   * runner for its next step where it can take one, otherwise queued until
   * the turn ends (ADR-0023). Returns its id, for {@link removeQueued}.
   * `from` marks a message Ordewell sent rather than the user.
   */
  sendMessage(text: string, from?: TaskMessageFrom): string;
  /**
   * Force send (ADR-0023, F1–F3): interrupt the running turn, as
   * {@link interrupt} does, and deliver this message as the turn that
   * replaces it, ahead of anything still queued. The task does not wait for
   * input in between. With no turn running it is {@link sendMessage}.
   */
  forceSend(text: string): string;
  /**
   * Force send a message not yet delivered, by id — queued, or handed over,
   * which is not sent twice: the interrupt makes it go first (ADR-0023, F1).
   * False once it was delivered.
   */
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
  /** What has been counted of that session's running cost, for a runner that reports one; null while unknown. */
  sessionCost?(): RunnerSessionCost | null;
  /**
   * The slash commands the runner offers this task (#66): its built-ins and
   * the user's and the project's skills and custom commands. Empty for a
   * runner that reports none.
   */
  commands(): RunnerCommand[];
  /**
   * Run the runner's own command `name` as a turn of its own: at once when
   * idle, otherwise queued behind the running turn — never handed into it,
   * where a runner reads it as text. A runner whose commands cannot be invoked
   * over its protocol is sent `/name args` as a message. Returns its id, as
   * {@link sendMessage} does.
   */
  invokeCommand(name: string, args?: string): string;
  /**
   * Answer a `permission_request` this session emitted, by its event id. False
   * when it is no longer open — answered, withdrawn, or never asked. An HTTP
   * answer settles after delivery; on failure it stays open and returns false.
   */
  answerPermission(id: string, decision: ApprovalDecision): boolean | Promise<boolean>;
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
  /**
   * A script task's end (ADR-0035): its exit status, the attempt's evidence in
   * place of a `task_complete` call, for `VerdictEngine` to weigh. Handed once,
   * before the session exits. A runner's session never hands one: its model
   * reports through `task_complete`.
   */
  onScriptExit(listener: (exit: ScriptExit) => void): void;
}

export interface IRunner {
  spawn(opts: {
    taskId: string;
    runner: string;
    prompt: string;
    modelId?: string;
    thinkingEffort?: string;
    modelVariants?: string[];
    mode?: string;
    cwd: string;
    /** The session workspace, also readable by an isolated read-only task (ADR-0046). */
    workspaceRoot?: string;
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
    /** What was counted of that session's running cost before, so its first turn is counted from there. */
    resumeCost?: RunnerSessionCost;
    /**
     * The model that session last ran on and its window, so a resumed turn that
     * states none is measured as before. Runners ignore it; the window fill
     * that wraps one reads it.
     */
    resumeWindow?: { source?: string; model?: string; contextWindow?: number };
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
    /**
     * The runner is being started and has not yet reported Ordewell's tools
     * connected (ADR-0025): on its first spawn, then on its one respawn.
     * Nothing has been sent to it, and the spawn resolves only once they
     * connect or the wait ends.
     */
    onAttaching?: (spawn: 1 | 2) => void;
    /**
     * Aborted once nobody wants the runner any more: a spawn still in flight
     * is taken back at once instead of finishing its start for nobody. Once
     * the spawn has resolved, the session's own stop is what ends it.
     */
    cancelled?: AbortSignal;
    /** The attempt's work lands as a commit (ADR-0047): its runner is told to write the message in `task_complete`. */
    commits?: true;
    /** What the runner loads of the user's own setup (the `taskRunnerConfig` setting); absent means all of it. Runners that cannot narrow it ignore it. */
    runnerConfig?: TaskRunnerConfig;
    /** A script task's body (ADR-0035): only the script runner reads it, and it runs nothing else. */
    script?: ScriptBody;
    /**
     * A read-only attempt's shell (ADR-0046): its token serves `run_command`
     * from it, and only an attempt that has one is given that tool.
     */
    shell?: TaskShell;
    /**
     * Checks a `task_complete` call's handoff against the plan as the call
     * arrives (ADR-0047): a refusal is the call's result, and nothing is
     * recorded. Without one, a `task` reference resolves against no plan.
     */
    checkHandoff?: (completion: TaskCompleteArgs) => HandoffCheck<TaskCompleteArgs>;
    /**
     * Answers the attempt's `read_task` calls (ADR-0047), against the plan
     * and the session's task logs. Without one the call says it is not available.
     */
    readTask?: (args: ReadTaskArgs) => McpToolReply;
    /**
     * Answers a read-only attempt's `save_patch` calls (ADR-0050): its shell
     * captures the worktree's changes and the attempt keeps them. Without one
     * the call says it is not available.
     */
    savePatch?: (signal: AbortSignal) => Promise<McpToolReply>;
    /**
     * Answers a change attempt's `apply_patch` calls (ADR-0050): a saved patch
     * of a task it may read, applied into its worktree. Without one the call
     * says it is not available.
     */
    applyPatch?: (args: ApplyPatchArgs) => Promise<McpToolReply>;
    /**
     * Answers a read-only attempt's `fetch` and `web_search` calls (ADR-0046)
     * through the session's web-read policy, apart from its shell. Only a
     * read-only attempt's token lists them; without one they say they are
     * not available.
     */
    webReads?: TaskWebReads;
  }): Promise<IRunnerSession>;

  /** Wind one session down ({@link IRunnerSession.stop}); resolves once its process is gone. */
  stop(sessionId: string): Promise<void>;
  /** Wind every session down at once, as {@link stop} does one. */
  stopAll(): void;
  activeCount: number;
}
