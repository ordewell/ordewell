import type { ITerminalSession } from './ITerminalRunner';

/** Context of one task attempt, enough to locate its transcript. */
export interface TranscriptQuery {
  runner: string;
  /** The task's working directory (the agent's cwd at spawn). */
  cwd: string;
  /** When the agent process started, ISO — used to reject older sessions. */
  startedAt?: string;
  /**
   * The task's completion marker UUID. The prompt carries it, so a transcript
   * that does not contain it belongs to some other task — parallel attempts in
   * one cwd are otherwise indistinguishable by directory and recency.
   */
  marker: string;
}

/** Reads the agent's own session transcript for a task's final answer. */
export interface TranscriptReader {
  /** Last assistant-authored prose, clamped to `maxChars` from the end, or null. */
  finalAssistantText(query: TranscriptQuery, maxChars?: number): Promise<string | null>;
}

/** The part of a task attempt its output is looked up by. */
export interface TaskOutputAttempt {
  readonly taskId: string;
  readonly runner: string;
  /** Null when the attempt ended before its working directory was settled. */
  readonly cwd: string | null;
  readonly startedAt: string;
  /** The completion marker UUID the attempt's prompt carried. */
  readonly completionMarker: string;
}

export interface LiveTailOptions {
  maxLines: number;
  /** A previous {@link LiveTail.nextOffset}: only output after it is rendered. */
  sinceOffset?: number;
}

export interface LiveTail {
  /** Clean terminal render, not raw ANSI. */
  text: string;
  /** Total output received so far; pass it back as `sinceOffset` to read only what follows. */
  nextOffset: number;
  running: boolean;
}

/**
 * The one owner of a task attempt's output: what it printed while running
 * and what it answered once it ended.
 */
export interface TaskOutputSource {
  /** Start capturing a session; replaces any earlier capture of the task. */
  attach(taskId: string, session: ITerminalSession): void;
  /** Stop capturing the task's session; what was captured stays readable. */
  detach(taskId: string): void;
  /** Drop every capture (a new plan reuses task ids). */
  reset(): void;
  /** The attempt's final answer: its transcript first, the clean terminal render otherwise. */
  finalText(attempt: TaskOutputAttempt, doneToken: string): Promise<string>;
  /** Recent output of the task's latest capture, or null if it never had one. */
  liveTail(taskId: string, opts: LiveTailOptions): LiveTail | null;
}
