import { readFile, stat, writeFile } from 'node:fs/promises';
import { lockKey, withFileLock } from './fileLock';
import { display, PathRefusal, resolveWritable } from './paths';
import type { OrdewellTool, ToolResult } from './types';

type Tier = 'exact' | 'normalized' | 'trailing-whitespace';

/** A span of the file the edit replaces. */
interface Span {
  start: number;
  end: number;
}

const NUL = '\0';
const CLOSEST_LINES = 3;

/**
 * Each of these maps one character to one, so a match found in the normalized
 * text has the same offsets in the file and the replacement can be cut from
 * the original.
 */
const CHAR_EQUIVALENTS: ReadonlyArray<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' '],
];

function normalizeChars(text: string): string {
  return CHAR_EQUIVALENTS.reduce((acc, [pattern, to]) => acc.replace(pattern, to), text);
}

function occurrences(haystack: string, needle: string): Span[] {
  const spans: Span[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    spans.push({ start: at, end: at + needle.length });
  }
  return spans;
}

interface FileLine {
  text: string;
  start: number;
  /** End of the text, before its line break. */
  end: number;
  /** End including the line break. */
  next: number;
}

function fileLines(content: string): FileLine[] {
  const lines: FileLine[] = [];
  let start = 0;
  while (start <= content.length) {
    const nl = content.indexOf('\n', start);
    if (nl === -1) {
      if (start < content.length) lines.push({ text: content.slice(start), start, end: content.length, next: content.length });
      break;
    }
    const end = nl > start && content[nl - 1] === '\r' ? nl - 1 : nl;
    lines.push({ text: content.slice(start, end), start, end, next: nl + 1 });
    start = nl + 1;
  }
  return lines;
}

/** Runs of lines equal to `oldString`'s once trailing whitespace is ignored; the span runs from the first line's start to the last line's end. */
function lineMatches(content: string, oldString: string): Span[] {
  const wanted = oldString.replace(/\r\n/g, '\n').split('\n');
  const trailingBreak = wanted.length > 1 && wanted[wanted.length - 1] === '';
  if (trailingBreak) wanted.pop();
  const target = wanted.map((l) => l.trimEnd());
  const lines = fileLines(content);
  const spans: Span[] = [];
  for (let i = 0; i + target.length <= lines.length; ) {
    if (target.every((t, k) => lines[i + k].text.trimEnd() === t)) {
      const last = lines[i + target.length - 1];
      spans.push({ start: lines[i].start, end: trailingBreak ? last.next : last.end });
      i += target.length;
    } else {
      i += 1;
    }
  }
  return spans;
}

function findMatches(content: string, oldString: string): { tier: Tier; spans: Span[] } | null {
  const exact = occurrences(content, oldString);
  if (exact.length) return { tier: 'exact', spans: exact };
  const normalized = occurrences(normalizeChars(content), normalizeChars(oldString));
  if (normalized.length) return { tier: 'normalized', spans: normalized };
  const byLine = lineMatches(content, oldString);
  if (byLine.length) return { tier: 'trailing-whitespace', spans: byLine };
  return null;
}

/** Overlap of two strings' character pairs, 0 to 1: cheap enough to run over every line of a big file. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) pairs.set(a.slice(i, i + 2), (pairs.get(a.slice(i, i + 2)) ?? 0) + 1);
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const pair = b.slice(i, i + 2);
    const left = pairs.get(pair) ?? 0;
    if (left > 0) {
      shared += 1;
      pairs.set(pair, left - 1);
    }
  }
  return (2 * shared) / (a.length + b.length - 2);
}

function closestLines(content: string, oldString: string): string | null {
  const probe = oldString.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!probe) return null;
  const scored = fileLines(content)
    .map((line, i) => ({ n: i + 1, text: line.text, score: similarity(probe.toLowerCase(), line.text.trim().toLowerCase()) }))
    .filter((l) => l.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.n - b.n)
    .slice(0, CLOSEST_LINES)
    .sort((a, b) => a.n - b.n);
  return scored.length ? scored.map((l) => `${l.n}: ${l.text}`).join('\n') : null;
}

/** The line break the file mostly uses; LF for a file with none. */
function dominantEol(content: string): '\n' | '\r\n' {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function withEol(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, eol);
}

function failure(text: string): ToolResult {
  return { text, isError: true };
}

export const editTool: OrdewellTool = {
  name: 'edit',
  description: 'Replace text in an existing file. oldString must identify exactly one place: include enough surrounding lines to be unique, or set replaceAll to change every occurrence. Matching tries the exact text first, then text with curly quotes, dashes and special spaces normalized, then lines that differ only in trailing whitespace. Line endings of the file are kept. To create a file or replace it whole, use write.',
  effect: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit, relative to the worktree.' },
      oldString: { type: 'string', description: 'The text to replace.' },
      newString: { type: 'string', description: 'The text to put in its place.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one. Default false.' },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const raw = String(args.path);
    const oldString = String(args.oldString);
    const newString = String(args.newString);
    const replaceAll = args.replaceAll === true;
    if (oldString === '') return failure('oldString is empty; to create a file or replace one whole, use write.');
    if (oldString === newString) return failure('oldString and newString are identical, so the edit would change nothing.');

    let file: string;
    try {
      file = resolveWritable(context, raw);
    } catch (err) {
      if (err instanceof PathRefusal) return failure(err.message);
      throw err;
    }

    // Read, match and write inside the lock: a parallel edit of the same file waits and then sees this one's change.
    return withFileLock(lockKey(file), async () => {
      const info = await stat(file).catch(() => null);
      if (!info) return failure(`${raw} does not exist; to create it, use write.`);
      if (info.isDirectory()) return failure(`${raw} is a directory, not a file.`);
      const content = await readFile(file, 'utf8');
      if (content.includes(NUL)) return failure(`${raw} is a binary file; edit changes text files only.`);

      const eol = dominantEol(content);
      const found = findMatches(content, withEol(oldString, eol));
      if (!found) {
        const applied = content.includes(withEol(newString, eol));
        const near = closestLines(content, oldString);
        return failure([
          'No match for oldString in the file.',
          applied ? 'newString is already in the file, so the edit may already have been applied; read the file to check.' : '',
          near ? `Closest lines:\n${near}\nRead the file and copy the text exactly.` : 'Read the file and copy the text exactly.',
        ].filter(Boolean).join('\n'));
      }
      if (found.spans.length > 1 && !replaceAll) {
        const where = found.spans.slice(0, 5).map((s) => content.slice(0, s.start).split('\n').length).join(', ');
        return failure(`Found ${found.spans.length} matches (at lines ${where}${found.spans.length > 5 ? ', …' : ''}), but oldString must match once: found ${found.spans.length} matches, add surrounding context or set replaceAll.`);
      }

      const replacement = withEol(newString, eol);
      let next = '';
      let at = 0;
      for (const span of found.spans) {
        next += content.slice(at, span.start) + replacement;
        at = span.end;
      }
      next += content.slice(at);
      await writeFile(file, next);

      const firstLine = content.slice(0, found.spans[0].start).split('\n').length;
      return {
        text: `Edited ${display(context, file)}: ${found.spans.length} replacement${found.spans.length === 1 ? '' : 's'}, starting at line ${firstLine}${found.tier === 'exact' ? '' : ` (matched ${found.tier === 'normalized' ? 'after normalizing quotes, dashes and spaces' : 'ignoring trailing whitespace'})`}.`,
        isError: false,
        details: { path: file, replacements: found.spans.length, tier: found.tier, firstLine },
      };
    });
  },
};
