import * as fs from 'fs';
import * as path from 'path';
import { isWithin, type NodePath, type TreeEvent, type TreeFact } from '../models/TreeEvent';
import { CorruptEventLogError, type EventStore } from '../services/eventStore';
import { sessionDataDir } from './sessionStore';

/*
 * A tree's event log on disk (ADR-0058 S3): the JSONL backend of `EventStore`.
 * One line is one batch, a JSON array, so a batch lands whole: a torn line loses
 * that batch and nothing else. The newline is what says a line landed. A read
 * drops a torn last line and leaves the file alone; only the writer, which holds
 * the root's session lease, cuts it off, before its first append, or the next
 * line would join it and be lost too.
 */

const LOG_FILE = 'tree-events.jsonl';

/** Under the root's directory, so a tree's log goes with its root (`deleteSession`). */
export function treeEventLogFile(rootSessionId: string, baseDir: string): string {
  return path.join(sessionDataDir(rootSessionId, baseDir), LOG_FILE);
}

interface Batch {
  events: TreeEvent[];
  /** The offset just past this line. */
  end: number;
}

function batchOf(line: Buffer): TreeEvent[] | null {
  try {
    const parsed: unknown = JSON.parse(line.toString('utf-8'));
    return Array.isArray(parsed) ? parsed as TreeEvent[] : null;
  } catch {
    return null;
  }
}

/**
 * Every batch that landed, in order. Split on bytes: a read can end inside a
 * character. An unreadable line is torn only if it is the last, which is not
 * known until the next one reads.
 */
async function* landed(file: string): AsyncGenerator<Batch> {
  let stream: fs.ReadStream;
  try {
    await fs.promises.access(file);
    stream = fs.createReadStream(file);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  let held = Buffer.alloc(0);
  let offset = 0;
  let lineNumber = 0;
  let unread: number | null = null;
  for await (const chunk of stream) {
    held = Buffer.concat([held, chunk as Buffer]);
    for (let at = held.indexOf(10); at !== -1; at = held.indexOf(10)) {
      lineNumber += 1;
      offset += at + 1;
      const events = batchOf(held.subarray(0, at));
      held = held.subarray(at + 1);
      if (unread !== null) throw new CorruptEventLogError(file, unread);
      if (events) yield { events, end: offset };
      else unread = lineNumber;
    }
  }
}

function logged(events: readonly TreeFact[], next: number): TreeEvent[] {
  return events.map((event, i) => ({ ...event, seq: next + i }));
}

/** The log at `file`, created by its first append. */
export function jsonlEventStore(file: string): EventStore {
  let writer: { handle: fs.promises.FileHandle; next: number } | null = null;
  let turn: Promise<unknown> = Promise.resolve();
  let closed = false;

  /** The file ready to take a line: its tail clean, and the next number known. */
  async function open(): Promise<NonNullable<typeof writer>> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    let end = 0;
    let next = 1;
    for await (const batch of landed(file)) {
      end = batch.end;
      next = (batch.events.at(-1)?.seq ?? next - 1) + 1;
    }
    const size = await fs.promises.stat(file).then(({ size }) => size, () => 0);
    if (size > end) await fs.promises.truncate(file, end);
    return { handle: await fs.promises.open(file, 'a'), next };
  }

  async function write(events: readonly TreeFact[]): Promise<void> {
    writer ??= await open();
    const { handle, next } = writer;
    const numbered = logged(events, next);
    try {
      await handle.appendFile(`${JSON.stringify(numbered)}\n`);
      writer.next = next + numbered.length;
    } catch (err) {
      // Part of the line may be there: the next append cuts it off as it would a crash's.
      writer = null;
      await handle.close().catch(() => undefined);
      throw err;
    }
  }

  return {
    append(events) {
      if (closed) return Promise.reject(new Error('This event log is closed.'));
      if (events.length === 0) return Promise.resolve();
      const appended = turn.then(() => write(events));
      turn = appended.catch(() => undefined);
      return appended;
    },
    async *read(after, node?: NodePath) {
      // Behind the writes already asked for, so a reader finds what it just appended.
      await turn;
      for await (const { events } of landed(file)) {
        for (const event of events) {
          if (event.seq > after && (node === undefined || isWithin(event.node, node))) yield event;
        }
      }
    },
    async close() {
      closed = true;
      await turn;
      await writer?.handle.close();
      writer = null;
    },
  };
}
