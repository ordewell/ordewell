import { walkPlan } from '@ordewell/core/plan-utils';
import type { RunTask, RunView, TaskDiffCause } from '@ordewell/core';

/*
 * What the Changes view reads, as plain data: the daemon's task diff text and
 * unified patches parsed, a file's two sides rebuilt from its patch, and the
 * sidebar's groups. Pure, so the shapes the view draws are tested without it.
 */

export type ChangeLetter = 'A' | 'M' | 'D';

export interface ChangedFile {
  repo: string;
  path: string;
  /** Null for a binary change. */
  added: number | null;
  removed: number | null;
  /** Absent when no read said how it changed. */
  status?: ChangeLetter;
}

export interface TaskDiffList {
  files: ChangedFile[];
  /** The saved-patch line of a task whose worktree is gone (ADR-0050): what the list is read from. */
  savedPatch?: string;
}

const LIST_LINE = /^\[repo (.+?)\] (.+): (?:\+(\d+) -(\d+)|binary change)$/;
const SAVED_HEAD = /^The patch attempt \d+ saved, against commit [0-9a-f]+;/;

/** The task diff route's list form (`readTaskDiff`): one line per file, or one saying none changed. */
export function parseTaskDiffList(text: string): TaskDiffList {
  const list: TaskDiffList = { files: [] };
  for (const line of text.split('\n')) {
    if (SAVED_HEAD.test(line)) { list.savedPatch = line; continue; }
    const match = LIST_LINE.exec(line);
    if (!match) continue;
    const [, repo, path, added, removed] = match;
    list.files.push({ repo: repo!, path: path!, added: added === undefined ? null : Number(added), removed: removed === undefined ? null : Number(removed) });
  }
  return list;
}

/** One file's patch from the task diff route's path form, without the `[repo X] path` line it opens with. */
export function taskFilePatch(text: string): string {
  return /^\[repo .+?\] .*\n/.test(text) ? text.slice(text.indexOf('\n') + 1) : text;
}

/** git's name-status letter, as the sidebar shows it: a type change or copy reads as a modification. */
export function changeLetter(status: string | undefined): ChangeLetter | undefined {
  if (status === undefined) return undefined;
  if (status.startsWith('A')) return 'A';
  if (status.startsWith('D')) return 'D';
  return 'M';
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The hunk's body lines, each with its ' ', '-' or '+' mark. */
  lines: string[];
}

export interface FilePatch {
  hunks: Hunk[];
  binary: boolean;
  added: boolean;
  deleted: boolean;
  /** Whether each side's last line ends without a newline. */
  noNewline: { old: boolean; new: boolean };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One file's unified diff, as `git diff -- <path>` writes it. */
export function parsePatch(patch: string): FilePatch {
  const parsed: FilePatch = { hunks: [], binary: false, added: false, deleted: false, noNewline: { old: false, new: false } };
  let hunk: Hunk | undefined;
  let last: ' ' | '-' | '+' | undefined;
  for (const line of patch.split('\n')) {
    const head = HUNK_HEAD.exec(line);
    if (head) {
      hunk = { oldStart: Number(head[1]), oldLines: head[2] === undefined ? 1 : Number(head[2]), newStart: Number(head[3]), newLines: head[4] === undefined ? 1 : Number(head[4]), lines: [] };
      parsed.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line.startsWith('new file mode')) parsed.added = true;
      else if (line.startsWith('deleted file mode')) parsed.deleted = true;
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') parsed.binary = true;
      continue;
    }
    if (line.startsWith('\\')) {
      if (last === '-' || last === ' ') parsed.noNewline.old = true;
      if (last === '+' || last === ' ') parsed.noNewline.new = true;
      continue;
    }
    const mark = line[0];
    if (mark === ' ' || mark === '-' || mark === '+') { hunk.lines.push(line); last = mark; continue; }
    // The blank line git leaves between sections, or the next file: this hunk is over.
    if (line.startsWith('diff ')) hunk = undefined;
  }
  return parsed;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * The file before the change, from the file after it and the patch between
 * them: the daemon reads a scope's files as they are now, so the old side is
 * the patch undone. Undefined when the patch does not fit the text, as when
 * the file moved on since the diff was read.
 */
export function originalOf(modified: string, patch: FilePatch): string | undefined {
  const lines = splitLines(modified);
  const out: string[] = [];
  let at = 0;
  for (const hunk of patch.hunks) {
    const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    if (start < at || start > lines.length) return undefined;
    out.push(...lines.slice(at, start));
    at = start;
    for (const line of hunk.lines) {
      const body = line.slice(1);
      if (line[0] === '-') { out.push(body); continue; }
      if (lines[at] !== body) return undefined;
      if (line[0] === ' ') out.push(body);
      at++;
    }
  }
  out.push(...lines.slice(at));
  if (out.length === 0) return '';
  return out.join('\n') + (patch.noNewline.old ? '' : '\n');
}

/** Two sides of a diff to draw, and which line of the file each drawn line is (0 for a separator). */
export interface DiffSides {
  original: string;
  modified: string;
  lines: { original: number[]; modified: number[] };
  /** Only the changed regions are drawn: the file itself could not be read. */
  partial: boolean;
}

function numbered(text: string): number[] {
  return Array.from({ length: splitLines(text).length }, (_, i) => i + 1);
}

/**
 * What a diff tab draws: the whole file on each side when the after side was
 * read and the patch undoes cleanly, or else the hunks alone, a separator
 * between them that both sides share so it never reads as a change.
 */
export function diffSides(patch: FilePatch, modified: string | undefined): DiffSides {
  if (modified !== undefined) {
    const original = patch.added ? '' : originalOf(modified, patch);
    if (original !== undefined) {
      return { original, modified, lines: { original: numbered(original), modified: numbered(modified) }, partial: false };
    }
  }
  const sides = { original: [] as string[], modified: [] as string[] };
  const lines = { original: [] as number[], modified: [] as number[] };
  patch.hunks.forEach((hunk, index) => {
    if (index > 0 || hunk.oldStart > 1 || hunk.newStart > 1) {
      const separator = `⋯ @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      sides.original.push(separator); lines.original.push(0);
      sides.modified.push(separator); lines.modified.push(0);
    }
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const body = line.slice(1);
      if (line[0] !== '+') { sides.original.push(body); lines.original.push(oldLine++); }
      if (line[0] !== '-') { sides.modified.push(body); lines.modified.push(newLine++); }
    }
  });
  const join = (all: string[]): string => (all.length ? `${all.join('\n')}\n` : '');
  return { original: join(sides.original), modified: join(sides.modified), lines, partial: true };
}

/** Why the daemon had no diff for a task, as `plans.taskDiff` answers it; a cause this app does not know reads as an error. */
export interface TaskDiffUnavailable {
  cause: TaskDiffCause;
  reason: string;
}

/**
 * What the view says of a task with no diff to show. *Quiet*: nothing is
 * wrong, the task has changed nothing yet, or its record has not reached the
 * saved run (`retry`: a run saves a record after it broadcasts it). *Unavailable*:
 * the task's kind or its end leaves no diff of its own. *Error*: a read
 * failed, and the person should hear it.
 */
export interface TaskDiffNote {
  tone: 'quiet' | 'unavailable' | 'error';
  text: string;
  retry: boolean;
}

const RUNNING = new Set(['in_progress', 'awaiting_user']);
const UNSETTLED = new Set(['pending', 'approved', 'in_progress', 'awaiting_user']);

export const NO_CHANGES_YET = 'No changes yet.';
const OPS = 'An ops task works in the checkout, so its changes are not told apart from anyone else\'s.';
const READ_ONLY = 'A read-only task lands no changes: its report is its result.';
const SHARED = 'This run shares the checkout among its tasks, so their changes are not told apart by task.';
const NO_RECORD = 'No diff to show: the saved run holds no worktree record for this task.';

/**
 * Read with the live task, since the saved run the daemon answers from trails
 * it, and a saved status cannot tell a task that is starting from one that ended.
 * The task's kind is the daemon's to judge: it reads the saved plan, which
 * holds what the run view leaves out (a script's `readOnly`).
 */
export function taskDiffNote(answer: TaskDiffUnavailable, task: Pick<RunTask, 'status' | 'isolation' | 'type' | 'ops'>): TaskDiffNote {
  const unavailable = (text: string): TaskDiffNote => ({ tone: 'unavailable', text, retry: false });
  switch (answer.cause) {
    case 'read-only':
      return unavailable(READ_ONLY);
    case 'not-attributable':
      // A read-only script is answered read-only, so a script here is one that writes.
      return unavailable(task.ops === true || task.type === 'script' ? OPS : answer.reason);
    case 'no-record':
    case 'no-run': {
      // A running task with no isolation at all is one the live run gave no worktree: the run is shared.
      if (!task.isolation && RUNNING.has(task.status)) return unavailable(SHARED);
      const recorded = !!task.isolation && task.isolation.state !== 'none';
      if (RUNNING.has(task.status) || recorded) return { tone: 'quiet', text: NO_CHANGES_YET, retry: true };
      if (UNSETTLED.has(task.status)) return { tone: 'quiet', text: NO_CHANGES_YET, retry: false };
      return unavailable(answer.cause === 'no-run' ? answer.reason : NO_RECORD);
    }
    default:
      return { tone: 'error', text: answer.reason, retry: false };
  }
}

/** A task with work of its own to review: one that has had a worktree, a branch, or a saved patch. */
export interface TaskGroupSource {
  task: RunTask;
  label: string;
}

/** The tasks the sidebar groups files under, in plan order: those an isolated run gave a worktree. */
export function reviewableTasks(run: RunView): TaskGroupSource[] {
  const out: TaskGroupSource[] = [];
  for (const { task, label } of walkPlan(run.tasks)) {
    if (task.isolation && task.isolation.state !== 'none') out.push({ task, label });
  }
  return out;
}

export type FinishedStatus = 'completed' | 'failed' | 'skipped';

/** A finished task reads no more messages, so a comment on its work goes to the planner instead. */
export function isFinished(task: { status: string }): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'skipped';
}

export interface ConflictRow {
  taskId: string;
  label: string;
  title: string;
  repo: string;
  files: string[];
  /** A repair under way or waiting to start by itself: progress, not a conflict to act on (ADR-0015). */
  repairing: boolean;
}

/** The conflicts the run holds, for the top of the sidebar. */
export function conflictRows(run: RunView): ConflictRow[] {
  const rows: ConflictRow[] = [];
  for (const { task, label } of walkPlan(run.tasks)) {
    const isolation = task.isolation;
    if (!isolation || (isolation.state !== 'conflict' && isolation.state !== 'repairing')) continue;
    rows.push({
      taskId: task.id,
      label,
      title: task.title,
      repo: isolation.conflictRepo ?? '.',
      files: isolation.conflictFiles ?? [],
      repairing: isolation.state === 'repairing' || isolation.repairWaits !== undefined || isolation.resolver !== undefined,
    });
  }
  return rows;
}

/** Case-blind match of a filter against a file's path and its task's title. */
export function matchesFilter(filter: string, ...fields: string[]): boolean {
  const needle = filter.trim().toLowerCase();
  return needle === '' || fields.some((field) => field.toLowerCase().includes(needle));
}

export interface LineComment {
  repo: string;
  path: string;
  side: 'original' | 'modified';
  startLine: number;
  endLine: number;
  /** The lines quoted, as the diff drew them. */
  quote: string;
  body: string;
}

function lineRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

/** Where a comment points, as one line names it: the repo only when it is not the workspace root. */
export function commentPlace(comment: Pick<LineComment, 'repo' | 'path' | 'side' | 'startLine' | 'endLine'>): string {
  const file = comment.repo === '.' ? comment.path : `${comment.repo}/${comment.path}`;
  return `${file}, ${lineRange(comment.startLine, comment.endLine)}${comment.side === 'original' ? ' (before your change)' : ''}`;
}

/** The message a line comment sends to its task, or the planner's prompt it becomes: the place, the lines quoted, then the comment. */
export function commentMessage(comment: LineComment, about: string): string {
  const quoted = comment.quote.split('\n').map((line) => `> ${line}`).join('\n');
  return `On ${commentPlace(comment)} of ${about}:\n${quoted}\n\n${comment.body.trim()}`;
}
