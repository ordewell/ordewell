import type { AccountLimitSnapshot, ApprovalDecision, DisplayBlock, TaskLogHeaderView } from '@ordewell/core';

/*
 * The messages between the extension host and a task-log panel (ADR-0018, V1).
 * Types only: the host (tsup) and the panel (Vite) each compile this file, so
 * neither can drift from what the other sends. The panel is its own webview —
 * one editor tab per task — so it has its own protocol rather than borrowing
 * the chat's, which is shaped around the planner conversation.
 */

/** One message a structured task's runner has not read yet. */
export interface TaskLogQueuedMessage {
  id: string;
  text: string;
  /** The runner already has it, for its next step, so it cannot be taken back (ADR-0023). */
  handedOver?: boolean;
  /** Force sent: it goes as soon as the running turn is interrupted (ADR-0023, F1). */
  forced?: boolean;
}

/**
 * Everything the panel draws besides the log blocks: the header's identity,
 * core's one reading of what it says, the attempt switcher, and the
 * composer's queue. Derived on the host from the reduced view and the task, so
 * the panel never has to know the plan.
 */
export interface TaskLogStatus {
  taskId: string;
  order: number;
  /** The task's dotted reference ("2", "2.1"), for a subtask whose own order restarts at 1. */
  orderLabel?: string;
  title: string;
  runner: string;
  /** A script task (ADR-0035) runs no model: its log is output only, with no composer or queue. */
  script?: boolean;
  /** The state, resume time, continuation, usage and runner commands, worded once in core (ADR-0018, V1). */
  header: TaskLogHeaderView;
  /** The plan task's status: the activity line shows only for a running task, whatever its log's turn says. */
  taskStatus: string;
  /** When the runner last went quiet, as the status stream says it; null while it is not. The line goes static from it. */
  idleSince: string | null;
  /** When the open turn began (ISO), which the activity line counts its time from (#81); null between turns and for a log saved before it was kept. */
  turnStartedAt: string | null;
  /** Messages the runner has not read yet, oldest first. */
  queued: readonly TaskLogQueuedMessage[];
  /** Attempts that have a saved log, oldest first. */
  attempts: readonly number[];
  /** Which attempt the blocks below belong to. */
  attempt: number;
}

export type HostToTaskLog =
  /** The panel opened, or switched attempt: the whole view it should draw. */
  | { type: 'init'; status: TaskLogStatus; blocks: readonly DisplayBlock[] }
  /** Blocks new or changed since the last patch, with the new order. */
  | { type: 'patch'; order: readonly string[]; changed: readonly DisplayBlock[] }
  /** The header or queue changed; the blocks did not. */
  | { type: 'status'; status: TaskLogStatus }
  /**
   * The account limits of the runner the task is assigned to now — live,
   * whichever attempt is on screen — or none when that runner has no
   * monitored account. Sent apart from the status so a poll does not redraw
   * the header.
   */
  | { type: 'accountLimits'; limits: readonly AccountLimitSnapshot[] }
  | { type: 'showError'; error: string };

export type TaskLogToHost =
  | { type: 'ready' }
  | { type: 'invokeTaskCommand'; name: string; args: string }
  | { type: 'sendTaskMessage'; text: string }
  | { type: 'removeQueuedTaskMessage'; id: string }
  /** Force send (ADR-0023, F1): interrupt the running turn and deliver `text` next. */
  | { type: 'sendTaskMessageNow'; text: string }
  /** Force send a message still queued. */
  | { type: 'sendQueuedTaskMessageNow'; id: string }
  | { type: 'interruptTask' }
  /** Keep a task paused on a usage limit from resuming on its own (#84). */
  | { type: 'cancelResume' }
  /** Resume a task paused on a usage limit now, once the user says the limit has reset. */
  | { type: 'resumeNow' }
  /** Continue the finished task in its saved session, with `text` as its next turn. */
  | { type: 'continueTask'; text: string }
  /** Answer one of the runner's tool requests (ADR-0018, A1). */
  | { type: 'answerApproval'; id: string; decision: ApprovalDecision }
  /** Show an earlier attempt; the host answers with `init`. */
  | { type: 'selectAttempt'; attempt: number }
  /** Open a workspace-relative file the handoff saved, such as its patch (ADR-0050). */
  | { type: 'openFile'; path: string };
