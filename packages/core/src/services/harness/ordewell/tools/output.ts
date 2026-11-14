import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { ToolResult } from './types';

/** What the model is shown of one tool result: past either, the rest is saved to a file it can page with `read`. */
export const MAX_OUTPUT_LINES = 2000;
export const MAX_OUTPUT_BYTES = 50 * 1024;

export interface Capped {
  text: string;
  /** Where the full text was saved; absent when nothing was cut. */
  savedTo?: string;
  totalLines: number;
}

/** `text` cut to a whole number of characters inside `bytes` bytes. */
function headBytes(text: string, bytes: number): string {
  const cut = Buffer.from(text, 'utf8').subarray(0, bytes).toString('utf8');
  // A character split by the byte limit decodes to U+FFFD at the end.
  return cut.endsWith('�') ? cut.slice(0, -1) : cut;
}

function tailBytes(text: string, bytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  const cut = buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8');
  return cut.startsWith('�') ? cut.slice(1) : cut;
}

function headLines(lines: string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines.slice(0, MAX_OUTPUT_LINES)) {
    const size = Buffer.byteLength(line) + (kept.length ? 1 : 0);
    if (used + size > budget) {
      if (kept.length === 0) kept.push(headBytes(line, budget));
      break;
    }
    kept.push(line);
    used += size;
  }
  return kept.join('\n');
}

function tailLines(lines: string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines.slice(-MAX_OUTPUT_LINES).reverse()) {
    const size = Buffer.byteLength(line) + (kept.length ? 1 : 0);
    if (used + size > budget) {
      if (kept.length === 0) kept.push(tailBytes(line, budget));
      break;
    }
    kept.push(line);
    used += size;
  }
  return kept.reverse().join('\n');
}

/**
 * The one place a tool's output is bounded (so no tool counts lines of its
 * own). A result inside both limits comes back as it is. A longer one is saved
 * whole to a file under `outputDir`, which sits outside the worktree
 * (ADR-0032), and what the model reads is its head (its tail for a tool that
 * says so) with the file's path and how to page it.
 */
export function capOutput(text: string, outputDir: string, keep: 'head' | 'tail' = 'head'): Capped {
  const lines = text.split('\n');
  if (lines.length <= MAX_OUTPUT_LINES && Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) {
    return { text, totalLines: lines.length };
  }
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const savedTo = path.join(outputDir, `tool-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.txt`);
  writeFileSync(savedTo, text, { mode: 0o600 });

  // The notice takes its own room, so that note and body together fit the byte limit.
  const note = `[Output truncated: ${keep === 'head' ? 'first' : 'last'} lines of ${lines.length} lines shown. Full output saved to ${savedTo}; use the read tool on that file with an offset to page through it.]`;
  const budget = Math.max(1024, MAX_OUTPUT_BYTES - Buffer.byteLength(note) - 2);
  const shown = keep === 'head' ? headLines(lines, budget) : tailLines(lines, budget);
  return { text: keep === 'head' ? `${shown}\n\n${note}` : `${note}\n\n${shown}`, savedTo, totalLines: lines.length };
}

/** A {@link ToolResult} with its text capped; where the full text went is recorded in its details. */
export function capResult(result: ToolResult, outputDir: string, keep: 'head' | 'tail' = 'head'): ToolResult {
  if (result.paged) return result;
  const capped = capOutput(result.text, outputDir, keep);
  if (!capped.savedTo) return result;
  return { ...result, text: capped.text, details: { ...result.details, savedTo: capped.savedTo, totalLines: capped.totalLines } };
}
