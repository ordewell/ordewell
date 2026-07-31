/**
 * Live runner output, kept per task so a running or failed task card can show
 * what the runner actually printed. Only the tail is retained: a long build
 * log is unbounded, and the interesting part of a failure is always at the end.
 */
export type TaskOutputMap = Record<string, string>;

export const TASK_OUTPUT_TAIL_CHARS = 8000;

export function appendTaskOutput(
  map: TaskOutputMap,
  taskId: string,
  chunk: string,
  cap = TASK_OUTPUT_TAIL_CHARS,
): TaskOutputMap {
  if (!taskId || !chunk) return map;
  const combined = (map[taskId] ?? '') + chunk;
  const tail = combined.length > cap ? combined.slice(combined.length - cap) : combined;
  return { ...map, [taskId]: tail };
}

/** The last non-empty line — the one-line signal for a collapsed card. */
export function lastLine(output: string): string {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return '';
}
