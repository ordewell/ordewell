/**
 * Live runner output, kept per task so a running or failed task card can show
 * what the runner actually printed. Only the tail is retained: a long build
 * log is unbounded, and the interesting part of a failure is always at the end.
 */
export type TaskOutputMap = Record<string, string>;

export const TASK_OUTPUT_TAIL_CHARS = 8000;

// ANSI and control bytes are the point of these regexes.
/* eslint-disable no-control-regex */
/** ANSI SGR, cursor movement, OSC title, and charset-select escapes a TUI emits. */
const ANSI_ESCAPE =
  /(?:\u001B\[[\d:;<=>?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[()][A-Za-z0-9]|\u001B[@-Z\\-_])/g;
/** Bare control bytes left once escapes are gone: BELL, NUL, cursor-home, … */
const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/* eslint-enable no-control-regex */

/**
 * Runner output is PTY text: full of ANSI colour/cursor codes that only make
 * sense to a real terminal. The webview's `<pre>` renders them as literal
 * garbage, so they are stripped here. Line redraws come back as `\r`, which
 * would jam every spinner frame onto one line — split them instead.
 */
export function sanitizeRunnerOutput(text: string): string {
  return text
    .replace(ANSI_ESCAPE, '')
    .replace(CONTROL_CHAR, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

export function appendTaskOutput(
  map: TaskOutputMap,
  taskId: string,
  chunk: string,
  cap = TASK_OUTPUT_TAIL_CHARS,
): TaskOutputMap {
  if (!taskId || !chunk) return map;
  // Clean each chunk as it arrives: escape sequences arrive in single PTY
  // writes, so the stored text never holds a raw escape for the tail cap to
  // slice in half later.
  const combined = (map[taskId] ?? '') + sanitizeRunnerOutput(chunk);
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
