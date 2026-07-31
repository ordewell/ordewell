import { stripModelNoise } from './JsonExtractor';

/** A task as seen in a still-streaming plan: its title (possibly partial) and whether its object has closed. */
export interface PartialPlanTask {
  title: string;
  status: 'streaming' | 'complete';
  /** Assigned model label, once it has streamed in — for the live row's chip. */
  model?: string;
  /** Task mode ("build"|"plan"), once it has streamed in — for the live row's chip. */
  mode?: string;
}

/**
 * Parse a partial (still-streaming) plan-JSON string into an ordered list of task
 * rows for the live progress view. Pure and lenient: it walks the characters of the
 * `tasks` array, emitting one row per task object once it has opened, with the title
 * read incrementally and the status flipping to `complete` when the object's brace
 * closes. The currently-streaming object stays `streaming` even with a partial title.
 * The React view is a thin renderer over this — it never parses JSON itself.
 */
export function parsePartialPlan(partial: string): PartialPlanTask[] {
  const text = stripModelNoise(partial);
  const arrayStart = findTasksArrayStart(text);
  if (arrayStart === -1) return [];

  const tasks: PartialPlanTask[] = [];
  let depth = 0;          // brace depth relative to a task object (0 = between objects)
  let objText = '';       // accumulated text of the in-progress task object
  let inString = false;
  let escaped = false;

  for (let i = arrayStart; i < text.length; i++) {
    const ch = text[i];
    if (depth > 0) objText += ch;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === ']' && depth === 0) break; // end of the tasks array
    if (ch === '{') {
      if (depth === 0) objText = '{';
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        tasks.push(rowFromObject(objText, 'complete'));
        objText = '';
      }
    }
  }

  // A task object that opened but never closed is the row currently streaming in.
  if (depth > 0) tasks.push(rowFromObject(objText, 'streaming'));
  return tasks;
}

/** Index just after the `[` that opens the top-level `tasks` array, or -1 if not present yet. */
function findTasksArrayStart(text: string): number {
  const key = /"tasks"\s*:\s*\[/.exec(text);
  return key ? key.index + key[0].length : -1;
}

/** Build a live row from a (possibly unterminated) task-object fragment. */
function rowFromObject(objText: string, status: PartialPlanTask['status']): PartialPlanTask {
  const model = stringField(objText, 'modelLabel');
  const mode = stringField(objText, 'taskMode');
  return {
    title: titleFromObject(objText),
    status,
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
  };
}

/** Read the `title` value out of a (possibly unterminated) task-object fragment. */
function titleFromObject(objText: string): string {
  const m = /"title"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(objText);
  if (!m) return '';
  // The captured group may include a trailing closing quote's content only up to an
  // unescaped quote; for a completed value that's the whole title, for a streaming
  // one it's whatever has arrived so far.
  return m[1].replace(/\\"/g, '"');
}

/** Read a fully-streamed (closing-quote present) string field's value, or undefined. */
function stringField(objText: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(objText);
  return m ? m[1].replace(/\\"/g, '"') : undefined;
}
