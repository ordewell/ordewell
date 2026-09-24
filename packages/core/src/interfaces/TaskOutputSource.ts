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
