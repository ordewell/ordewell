import type {
  AccountLimitsFrame, ChildTreeFrame, RunSnapshotFrame, SessionFrame, StreamStamp,
} from '../daemonContract';
import type { SessionMessage, SessionNotice } from '../services/SessionMessage';
import { StreamOrder, stampOf, type Placement } from './streamOrder';

/** The greeting a daemon socket opens with. */
export interface ConnectedFrame {
  type: 'connected';
  sessionId: string;
}

/** Everything a daemon session socket, root or child, may carry. */
export type DaemonFrame = SessionFrame | RunSnapshotFrame | ChildTreeFrame | AccountLimitsFrame | ConnectedFrame;

/**
 * Where a frame stands, as {@link StreamOrder} judges it. A frame a daemon
 * older than the stamp sends, or one it sends unnumbered (the planner state
 * after a snapshot), has nothing to order it by.
 */
function placeBroadcast(order: StreamOrder, frame: SessionFrame): Placement {
  const stamp = stampOf(frame);
  return stamp ? order.first(stamp, frame.type) : { keep: true, jump: false };
}

function placeSnapshot(order: StreamOrder, frame: RunSnapshotFrame): Placement {
  const stamp = stampOf(frame);
  return stamp ? order.adopt(stamp) : { keep: true, jump: true };
}

function coveredBy(position: StreamStamp | undefined, frame: Partial<StreamStamp>): boolean {
  const stamp = stampOf(frame);
  return position !== undefined && stamp !== null && stamp.stream === position.stream && stamp.seq <= position.seq;
}

type Ordered = SessionFrame | RunSnapshotFrame;

/**
 * One daemon socket's frames, held while what they follow is read over REST
 * (ADR-0017). A view built from frames alone is whole only from the first
 * frame on, so a socket that joins, rejoins after a drop, or finds a restarted
 * daemon loads the session first and goes on from there. Nothing is drawn
 * from a frame before the load it follows: a run snapshot adopted before the
 * transcript is redrawn would be undone by the redraw. A frame the load says
 * it accounts for is dropped, or what the read already holds is drawn twice.
 *
 * Host-neutral: a surface supplies the read and draws what each hook hands it.
 */
export abstract class DaemonStream<L> {
  private readonly order = new StreamOrder();
  /** Whether the view accounts for everything up to the last frame delivered. */
  private whole = false;
  private loading = false;
  /** A gap opened while a load was out: what it returns may not cover it. */
  private again = false;
  private held: Ordered[] = [];
  private closed = false;
  /** Quota reads are numbered on their own count, per daemon. */
  private limitsAt: { stream: string; revision: number } | null = null;

  constructor(private readonly read: () => Promise<L>, private readonly failed: (error: unknown) => void) {}

  receive(frame: DaemonFrame): void {
    if (this.closed) return;
    switch (frame.type) {
      // The snapshot after it says what this socket accounts for.
      case 'connected':
        return;
      case 'child_tree':
        this.tree(frame);
        return;
      case 'account_limits':
        if (this.limitsAt?.stream === frame.stream && frame.revision <= this.limitsAt.revision) return;
        this.limitsAt = { stream: frame.stream, revision: frame.revision };
        this.limits(frame);
        return;
      case 'run_snapshot':
        this.ordered(frame, placeSnapshot(this.order, frame));
        return;
      default:
        this.ordered(frame, placeBroadcast(this.order, frame));
    }
  }

  close(): void {
    this.closed = true;
    this.held = [];
  }

  /** The tree is whole each time, so it is never held behind a load. */
  protected abstract tree(frame: ChildTreeFrame): void;
  /** A quota read newer than any this stream passed on; never held behind a load either. */
  protected abstract limits(frame: AccountLimitsFrame): void;
  protected abstract snapshot(frame: RunSnapshotFrame): void;
  protected abstract broadcast(frame: SessionMessage | SessionNotice): void;
  /**
   * Redraw from a load; returns what of the stream the load accounts for, when
   * it says. Every held frame at or below it is dropped, a running turn's
   * streamed deltas included: a read shows the saved transcript only
   * (ADR-0017 R1), and the turn's settled message restores them.
   */
  protected abstract loaded(state: L): StreamStamp | undefined;

  private ordered(frame: Ordered, judgement: Placement): void {
    if (!judgement.keep) return;
    if (this.loading) {
      this.held.push(frame);
      if (judgement.jump) this.again = true;
      return;
    }
    if (!this.whole || judgement.jump) {
      this.held.push(frame);
      this.load();
      return;
    }
    this.deliver(frame);
  }

  private load(): void {
    this.loading = true;
    this.whole = false;
    this.again = false;
    this.read().then((state) => {
      if (this.closed) return;
      this.loading = false;
      // What was read may predate the gap: read again, still holding.
      if (this.again) { this.load(); return; }
      const position = this.loaded(state);
      if (position) this.order.cover(position);
      this.whole = true;
      const held = this.held;
      this.held = [];
      for (const frame of held) if (!coveredBy(position, frame)) this.deliver(frame);
    }, (error: unknown) => {
      if (this.closed) return;
      // Still held, and the next frame asks again.
      this.loading = false;
      this.failed(error);
    });
  }

  private deliver(frame: Ordered): void {
    if (frame.type === 'run_snapshot') this.snapshot(frame);
    else this.broadcast(frame);
  }
}
