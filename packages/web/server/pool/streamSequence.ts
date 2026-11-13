import type { StreamStamp } from '@ordewell/core';

/**
 * This daemon's broadcast numbering (see `StreamStamp`), one count per stream
 * a socket follows: a root session's id, or a child plan's own key. A count
 * outlives every Session and every watcher that used it, so a client that
 * comes back never sees the numbers go backward.
 */
export class StreamSequence {
  private readonly counts = new Map<string, number>();

  constructor(private readonly stream: string) {}

  /** The stamp of the next frame on `key`'s stream. */
  next(key: string): StreamStamp {
    const seq = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, seq);
    return { stream: this.stream, seq };
  }

  /** The last frame on `key`'s stream: a read taken now accounts for it and everything before. */
  position(key: string): StreamStamp {
    return { stream: this.stream, seq: this.counts.get(key) ?? 0 };
  }
}
