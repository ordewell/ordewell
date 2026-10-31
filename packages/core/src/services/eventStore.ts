import type { NodePath, TreeEvent, TreeFact } from '../models/TreeEvent';

/**
 * One append-only log per root (ADR-0058 S3), behind a port so that a daemon
 * host can back it with SQLite later. Only the host holding the root's session
 * lease writes it (ADR-0055 D13).
 */
export interface EventStore {
  /** In order, each batch whole: after a crash a reader finds all of a batch or none of it. Numbers them. */
  append(events: readonly TreeFact[]): Promise<void>;
  /** What came after the cursor, at `path` and below when one is named. */
  read(after: number, path?: NodePath): AsyncIterable<TreeEvent>;
  close(): Promise<void>;
}

/** A line that is not the last will not read: no crash leaves that, and a fold that skipped it would lose spend. */
export class CorruptEventLogError extends Error {
  constructor(readonly file: string, readonly line: number) {
    super(`The tree's event log ${file} is damaged at line ${line}, before its end.`);
    this.name = 'CorruptEventLogError';
  }
}
