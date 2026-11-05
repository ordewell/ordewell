import { OUTPUT_LINES_DEFAULT, OUTPUT_LINES_MAX, OUTPUT_TAIL_MAX_CHARS } from './TaskQuery';
import { redactAgentText } from '../utils/redactSecrets';

export interface TaskReadPageOptions {
  lines?: number;
  since?: number;
}

export function taskReadPage(text: string, { lines, since }: TaskReadPageOptions) {
  // A saved log is runner text, so a value under a credential name goes whatever its shape.
  const clean = redactAgentText(text);
  const start = Math.min(since ?? 0, clean.length);
  const rest = clean.slice(start);
  const maxLines = Math.min(lines ?? OUTPUT_LINES_DEFAULT, OUTPUT_LINES_MAX);
  let end = 0;
  for (let n = 0; n < maxLines && end < rest.length; n++) {
    const newline = rest.indexOf('\n', end);
    end = newline < 0 ? rest.length : newline + 1;
  }
  end = Math.min(end, OUTPUT_TAIL_MAX_CHARS);
  const nextOffset = start + end;
  const hasMore = nextOffset < clean.length;
  return {
    output: rest.slice(0, end) + (hasMore ? `\n[truncated; continue with since: ${nextOffset}]` : ''),
    nextOffset,
    hasMore,
  };
}
