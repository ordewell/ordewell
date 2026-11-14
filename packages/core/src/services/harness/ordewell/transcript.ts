import { promises as fs } from 'fs';
import * as path from 'path';
import { globalDataDir } from '../../../utils/globalDataDir';
import type { ModelMessage, ModelUsage, SystemPart } from '../../model';

/**
 * One line of a transcript. `session` comes first and once: the system prompt
 * an attempt was started with, kept so a resume sends the same prefix rather
 * than one rebuilt on another day. Every model or tool message follows as a
 * `message`; `usage` lines are the provider's report per step, which a resume
 * does not replay but a later reader (compaction, cost) can.
 */
export type TranscriptEntry =
  | { v: 1; kind: 'session'; at: string; model: string; system: SystemPart[] }
  | { v: 1; kind: 'message'; at: string; step: number; message: ModelMessage }
  | { v: 1; kind: 'usage'; at: string; step: number; usage: ModelUsage };

/** What a transcript holds once read back: the prefix and the conversation to send next. */
export interface LoadedTranscript {
  model?: string;
  system?: SystemPart[];
  messages: ModelMessage[];
  /** The last step recorded, so a resumed loop numbers on from it. */
  steps: number;
}

/**
 * Where an attempt's conversation lives (ADR-0070). The loop reads it back
 * before every step and appends to it after, so it is the one source of what
 * the model has seen: the compaction task replaces how `load` folds old
 * messages, and the caching task reads it to keep the prefix stable.
 */
export interface TranscriptStore {
  readonly sessionId: string;
  /** The session's own directory, outside every workspace (ADR-0032). */
  readonly dir: string;
  exists(): Promise<boolean>;
  load(): Promise<LoadedTranscript>;
  append(entry: TranscriptEntry): Promise<void>;
}

/** The root under which every session of the runner keeps its directory. */
export function ordewellSessionsRoot(): string {
  return path.join(globalDataDir(), 'runners', 'ordewell', 'sessions');
}

/**
 * A transcript as JSON lines in `<root>/<sessionId>/transcript.jsonl`. Lines are
 * appended whole, one write each, so a crash loses at most the line being
 * written, and a torn last line is skipped on read rather than failing the
 * resume.
 */
export class FileTranscriptStore implements TranscriptStore {
  readonly dir: string;
  private readonly file: string;
  /** Serialises appends: concurrent tool completions must not interleave lines. */
  private tail: Promise<void> = Promise.resolve();
  /** Whether this store has checked the file's end, which a crash may have left mid-line. */
  private mended = false;

  constructor(readonly sessionId: string, root: string = ordewellSessionsRoot()) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`Invalid Ordewell session id: ${sessionId}`);
    this.dir = path.join(root, sessionId);
    this.file = path.join(this.dir, 'transcript.jsonl');
  }

  /** Rejects on any failure but a missing file: one that cannot be read now is not one that is gone. */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async load(): Promise<LoadedTranscript> {
    await this.tail;
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { messages: [], steps: 0 };
      throw err;
    }
    return foldTranscript(parseLines(raw));
  }

  append(entry: TranscriptEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    const write = this.tail.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      // A resumed session's first line would otherwise join the torn one, and be skipped with it.
      const lead = this.mended ? '' : await this.tornTail();
      await fs.appendFile(this.file, lead + line, 'utf8');
      this.mended = true;
    });
    // A failed write fails its own caller, never every later one.
    this.tail = write.catch(() => undefined);
    return write;
  }

  /** A line break when the file ends inside a line, else nothing. */
  private async tornTail(): Promise<string> {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(this.file, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return '';
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      return last[0] === 0x0a ? '' : '\n';
    } finally {
      await handle.close();
    }
  }
}

function parseLines(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) entries.push(parsed);
    } catch {
      // A torn line from a crash mid-write: what came before it still stands.
    }
  }
  return entries;
}

function isEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { v?: unknown; kind?: unknown };
  return entry.v === 1 && (entry.kind === 'session' || entry.kind === 'message' || entry.kind === 'usage');
}

/** The entries as the conversation the next request sends. */
export function foldTranscript(entries: readonly TranscriptEntry[]): LoadedTranscript {
  const out: LoadedTranscript = { messages: [], steps: 0 };
  for (const entry of entries) {
    if (entry.kind === 'session') {
      out.model = entry.model;
      out.system = entry.system;
    } else if (entry.kind === 'message') {
      out.messages.push(entry.message);
      out.steps = Math.max(out.steps, entry.step);
    } else {
      out.steps = Math.max(out.steps, entry.step);
    }
  }
  return out;
}
