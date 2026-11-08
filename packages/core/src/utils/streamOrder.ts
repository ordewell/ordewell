import type { StreamStamp } from '../daemonContract';

/**
 * Where a stamped frame stands against what a client already holds: `keep` is
 * whether it is news, and `jump` that the client cannot account for every
 * broadcast before it, so what it shows must be read again. A client that has
 * delivered nothing yet has no gap to speak of.
 */
export type Placement = { keep: false } | { keep: true; jump: boolean };

/**
 * What a run snapshot already accounts for. One of these numbered at or below
 * the snapshot adopted is a copy that lagged behind it on an older socket, and
 * applying it after the snapshot would bring back what the snapshot says is
 * over — a preview cleared, a request answered.
 */
const COVERED: ReadonlySet<string> = new Set(['status_update', 'task_updated', 'approval_request', 'approval_settled']);

/** The stamp a frame carries, when it carries a whole one: a daemon older than the stamp sends none. */
export function stampOf(frame: Partial<StreamStamp>): StreamStamp | null {
  return frame.stream !== undefined && frame.seq !== undefined ? { stream: frame.stream, seq: frame.seq } : null;
}

/**
 * The sequence numbers of one daemon's broadcasts a client has delivered for
 * one session (ADR-0017, which both the TUI and the desktop read it by). A
 * window rather than a high-water mark: two sockets' frames can interleave out
 * of order, and a frame numbered below one already shown may still be the
 * first copy of its broadcast.
 */
export class StreamOrder {
  private stream: string | null = null;
  private highest = 0;
  private snapshot = 0;
  /** Everything at or below it is in what a load returned. */
  private floor = 0;
  private readonly seen = new Set<number>();

  constructor(private readonly window = 256) {}

  /** A broadcast of the given type: whether it is the first copy of one not yet shown, and whether it left a gap. */
  first({ stream, seq }: StreamStamp, type: string): Placement {
    const known = this.stream !== null;
    const restarted = this.follow(stream);
    if (seq <= this.floor || seq <= this.highest - this.window || this.seen.has(seq)) return { keep: false };
    if (COVERED.has(type) && seq <= this.snapshot) return { keep: false };
    const jump = restarted || (known && seq > this.highest + 1);
    this.mark(seq);
    return { keep: true, jump };
  }

  /**
   * A run snapshot. It covers the run up to its number, but not the
   * conversation: one past what was delivered left a gap in it. One older than
   * a broadcast already shown came in late on a newer socket, and would undo
   * what came after it.
   */
  adopt({ stream, seq }: StreamStamp): Placement {
    const known = this.stream !== null;
    const restarted = this.follow(stream);
    if (seq < this.highest || seq < this.floor) return { keep: false };
    const jump = restarted || (known && seq > this.highest);
    this.snapshot = seq;
    this.mark(seq);
    return { keep: true, jump };
  }

  /** What a load said it accounts for. */
  cover(position: StreamStamp): void {
    this.follow(position.stream);
    this.floor = Math.max(this.floor, position.seq);
    this.snapshot = Math.max(this.snapshot, position.seq);
    if (position.seq > this.highest) this.mark(position.seq);
  }

  private mark(seq: number): void {
    this.seen.add(seq);
    if (seq <= this.highest) return;
    this.highest = seq;
    for (const old of this.seen) if (old <= seq - this.window) this.seen.delete(old);
  }

  /** A new stream is a restarted daemon: its numbers start over and mean nothing against the last one's. */
  private follow(stream: string): boolean {
    if (stream === this.stream) return false;
    const restarted = this.stream !== null;
    this.stream = stream;
    this.highest = 0;
    this.snapshot = 0;
    this.floor = 0;
    this.seen.clear();
    return restarted;
  }
}
