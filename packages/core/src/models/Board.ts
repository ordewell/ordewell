import { HANDOFF_LIMITS, wordsFrom } from './Handoff';
import { quotedLine, splitLines } from './lineBreaks';
import type { NodePath } from './TreeEvent';

/**
 * A board's entries (ADR-0057 R8 to R10), as the tree's log keeps them and as a
 * reader is shown them. Every word an author wrote here is untrusted data (R3):
 * a one-line field reaches a reader as a quoted string, a detail indented under
 * Ordewell's own line, so neither can pass for one of Ordewell's lines.
 */

/** What anyone on a board may post. */
export const TASK_ENTRY_TYPES = ['finding', 'claim', 'attempt', 'artifact', 'contract', 'assume', 'scope_change'] as const;

/** What only a planner posts: `pin` is the one push down a tree (R10). */
export const PLANNER_ENTRY_TYPES = ['decision', 'pin'] as const;

export const BOARD_TYPES = [...TASK_ENTRY_TYPES, ...PLANNER_ENTRY_TYPES] as const;

export type BoardEntryType = (typeof BOARD_TYPES)[number];

export const BOARD_LIMITS = {
  title: HANDOFF_LIMITS.title,
  detail: HANDOFF_LIMITS.detail,
  key: 200,
  value: 500,
  files: 10,
  /** A board is read whole, so a loop that posts is stopped before it costs every reader. */
  entries: 200,
  /** A map stops here and counts the rest. */
  mapped: 100,
  /** What a new descendant is told of the pins above it, in all (R10). */
  pinChars: 2_000,
} as const;

/** `file` evidence, with the blobs R9 compares: Ordewell reads both as the entry is posted, so neither is an author's claim. */
export interface BoardFile {
  kind: 'file';
  path: string;
  /** The file as its author had it, where it could be read. */
  sha?: string;
  /** What the board's branch held then, absent where it held no such file. */
  tip?: string;
}

/** What an author sends. */
export interface BoardPost {
  type: BoardEntryType;
  title: string;
  detail?: string;
  /** What `contested` compares (R9): entries with one key and different values. */
  key?: string;
  value?: string;
  files?: string[];
}

/** Whose words an entry is, as the token that posted it says and never the entry. */
export interface BoardAuthor {
  node: NodePath;
  /** Its task's label in that plan; absent for that plan's planner. */
  task?: string;
  attempt?: number;
}

export interface BoardEntry extends Omit<BoardPost, 'files'> {
  /** The board it is on, and its number there: together its reference. */
  node: NodePath;
  id: number;
  by: BoardAuthor;
  at: string;
  files?: BoardFile[];
  /** The branch `files` was read against, which is the same for every reader. */
  branch?: string;
  /** The entry it was raised from at a landing (R6), which keeps its author. */
  raisedFrom?: { node: NodePath; id: number };
}

/** An entry as the log is told of it: the ledger numbers it and the clock stamps it. */
export type BoardDraft = Omit<BoardEntry, 'node' | 'id' | 'at'>;

/** What a reader writes to read the map, and what starts the reference to one entry. */
export const BOARD_REF = 'board';

/** `board:root/1:E3`: what the map shows and `read` takes back. */
export function boardRef({ node, id }: Pick<BoardEntry, 'node' | 'id'>): string {
  return `${BOARD_REF}:${node}:E${id}`;
}

export function isBoardRef(written: string): boolean {
  return written === BOARD_REF || written.startsWith(`${BOARD_REF}:`);
}

/** The board and number a reference names, or null for what is not one. */
export function parseBoardRef(written: string): { node: NodePath; id: number } | null {
  const match = /^board:(root(?:\/[0-9]+)*):E([1-9][0-9]*)$/.exec(written);
  return match ? { node: match[1], id: Number(match[2]) } : null;
}

/** What code found of an entry (R9): flags in the map, never an author's word. */
export interface BoardMarks {
  stale: boolean;
  contested: boolean;
}

/** The keys these entries hold more than one value of. */
export function contestedKeys(entries: readonly BoardEntry[]): Set<string> {
  const values = new Map<string, Set<string>>();
  for (const { key, value } of entries) {
    if (key === undefined || value === undefined) continue;
    values.set(key, (values.get(key) ?? new Set()).add(value.trim()));
  }
  return new Set([...values].filter(([, held]) => held.size > 1).map(([key]) => key));
}

/** An author's one-line field: quoted, so it stays one line and reads as a value. */
const quoted = quotedLine;

/** An author's detail, under a line of Ordewell's. */
function indented(detail: string, by: string): string[] {
  return splitLines(detail).map((line) => `${by}${line}`);
}

function byText({ node, task }: BoardAuthor): string {
  return task ? `${node} ${task}` : node;
}

function flagText({ stale, contested }: BoardMarks): string {
  return [...(stale ? ['stale'] : []), ...(contested ? ['contested'] : [])].map((flag) => ` ${flag}`).join('');
}

function keyText({ key, value }: Pick<BoardEntry, 'key' | 'value'>): string {
  return key === undefined ? '' : ` ${quoted(key)}${value === undefined ? '' : `=${quoted(value)}`}`;
}

/** One entry, one line, from its typed fields: no model reads or writes this (R8). */
function mapLine(entry: BoardEntry, marks: BoardMarks): string {
  return `  - ${boardRef(entry)} [${entry.type}${flagText(marks)}] by ${byText(entry.by)}${keyText(entry)}: ${quoted(entry.title)}`;
}

/** The map of what a node reads, with its provenance: `nodes` nearest first, `more` what it leaves out. */
export function boardMapLines(nodes: readonly NodePath[], shown: readonly { entry: BoardEntry; marks: BoardMarks }[], more: number): string[] {
  return [
    wordsFrom('Board', nodes.join(', ')),
    ...(shown.length > 0 ? shown.map(({ entry, marks }) => mapLine(entry, marks)) : ['  (nothing on it yet)']),
    ...(more > 0 ? [`  +${more} more`] : []),
  ];
}

/** One entry whole, as `read` answers with it. */
export function boardEntryLines(entry: BoardEntry, marks: BoardMarks): string[] {
  return [
    wordsFrom(`Board entry ${boardRef(entry)}`, byText(entry.by)),
    `  [${entry.type}${flagText(marks)}]${keyText(entry)}: ${quoted(entry.title)}`,
    ...(entry.raisedFrom ? [`  Raised from ${boardRef(entry.raisedFrom)} as it landed.`] : []),
    ...(entry.files?.length ? [`  Files: ${entry.files.map((file) => quoted(file.path)).join(', ')}`] : []),
    ...(entry.detail ? indented(entry.detail, '    ') : []),
  ];
}

function pinItem(entry: BoardEntry): string[] {
  return [`  - ${boardRef(entry)} by ${byText(entry.by)}: ${quoted(entry.title)}`, ...(entry.detail ? indented(entry.detail, '    ') : [])];
}

/**
 * What a new descendant is told of the pins above it (R10): nearest ancestor
 * first, whole items within the ceiling, then a count. Decisions, with their
 * authors' path, and still data: they say what was decided, and not what to do.
 */
export function pinLines(pins: readonly BoardEntry[]): string[] {
  if (pins.length === 0) return [];
  const lines = [wordsFrom('Decisions pinned', 'the plans above')];
  let size = lines[0].length;
  let told = 0;
  for (const pin of pins) {
    const item = pinItem(pin);
    size += item.join('\n').length + 1;
    if (size > BOARD_LIMITS.pinChars) break;
    lines.push(...item);
    told += 1;
  }
  const more = pins.length - told;
  return more > 0 ? [...lines, `  +${more} more on the board: read "${BOARD_REF}".`] : lines;
}
