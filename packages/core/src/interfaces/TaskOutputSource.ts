import type { IRunnerSession } from './IRunner';

export interface LiveTailOptions {
  maxLines: number;
  /** A previous {@link LiveTail.nextOffset}: only output after it is rendered. */
  sinceOffset?: number;
}

export interface LiveTail {
  /** Plain text, escapes and control characters removed. */
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
  attach(taskId: string, session: IRunnerSession): void;
  /** Stop capturing the task's session; what was captured stays readable. */
  detach(taskId: string): void;
  /** Drop every capture (a new plan reuses task ids). */
  reset(): void;
  /** The task's final answer: the summary its runner reported through `task_complete`, else what its last turn said. */
  finalText(taskId: string): string;
  /** Recent output of the task's latest capture, or null if it never had one. */
  liveTail(taskId: string, opts: LiveTailOptions): LiveTail | null;
}
