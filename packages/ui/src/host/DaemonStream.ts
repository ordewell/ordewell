import type {
  AccountLimitsFrame, ChildFrame, ChildPlanEntry, ChildPlanResponse, ChildPlanView, ChildTreeFrame, RunSnapshotFrame,
  RunView, SessionFrame, SessionMessage, SessionNotice, StreamStamp,
} from '@ordewell/core';
import { reduceRun } from '@ordewell/core/plan-utils';
import type { HostToWebview } from '../shared/protocol';
import { ChildView } from './ChildView';
import type { SavedConversation } from './ConversationViewHost';
import type { SessionCue, SessionView } from './SessionView';

/** The greeting a daemon socket opens with. */
export interface ConnectedFrame {
  type: 'connected';
  sessionId: string;
}

/** Everything a daemon session socket, root or child, may carry. */
export type DaemonFrame = SessionFrame | RunSnapshotFrame | ChildTreeFrame | AccountLimitsFrame | ConnectedFrame;

/** As the TUI's window: frames of two sockets on one session can interleave, so a frame below the highest may still be new. */
const WINDOW = 256;

/**
 * What a run snapshot already accounts for. One numbered at or below the
 * snapshot adopted is a copy that lagged behind it on an older socket, and
 * applying it after would bring back what the snapshot says is over.
 */
const COVERED: ReadonlySet<string> = new Set<SessionFrame['type']>(['status_update', 'task_updated', 'approval_request', 'approval_settled']);

/** A child's socket never carries these (ADR-0056 M8); one that did would answer for the root. */
const ROOT_ONLY: ReadonlySet<string> = new Set<SessionFrame['type']>(['approval_request', 'approval_settled', 'approval_decided']);

function stampOf(frame: Partial<StreamStamp>): StreamStamp | null {
  return frame.stream !== undefined && frame.seq !== undefined ? { stream: frame.stream, seq: frame.seq } : null;
}

/** `jump`: the view cannot account for every broadcast before this one, so what it holds must be read again. */
type Judgement = { keep: false } | { keep: true; jump: boolean };

/**
 * A session's broadcasts as one socket after another delivered them: which
 * frame is a copy, and where one was missed. Dedupe is the TUI's
 * (`packages/cli/src/tui/inbound.ts`); this adds the gap, since a surface that
 * redraws from frames alone must know when frames alone no longer suffice.
 */
class FrameOrder {
  private stream: string | null = null;
  private highest = 0;
  private snapshot = 0;
  /** Everything at or below it is in what a load returned. */
  private floor = 0;
  private readonly seen = new Set<number>();

  broadcast(frame: SessionFrame): Judgement {
    const stamp = stampOf(frame);
    // A daemon older than the stamp, or a frame it sends unnumbered (the
    // planner state after a snapshot): nothing to order it by.
    if (!stamp) return { keep: true, jump: false };
    const restarted = this.follow(stamp.stream);
    const { seq } = stamp;
    if (seq <= this.floor || seq <= this.highest - WINDOW || this.seen.has(seq)) return { keep: false };
    if (COVERED.has(frame.type) && seq <= this.snapshot) return { keep: false };
    const jump = restarted || seq > this.highest + 1;
    this.mark(seq);
    return { keep: true, jump };
  }

  /** A snapshot covers the run up to its number, but not the conversation: one past what was delivered left a gap in it. */
  snapshotOf(frame: RunSnapshotFrame): Judgement {
    const stamp = stampOf(frame);
    if (!stamp) return { keep: true, jump: true };
    const restarted = this.follow(stamp.stream);
    if (stamp.seq < this.highest || stamp.seq < this.floor) return { keep: false };
    const jump = restarted || stamp.seq > this.highest;
    this.snapshot = stamp.seq;
    this.mark(stamp.seq);
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
    for (const old of this.seen) if (old <= seq - WINDOW) this.seen.delete(old);
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

function coveredBy(position: StreamStamp | undefined, frame: Partial<StreamStamp>): boolean {
  const stamp = stampOf(frame);
  return position !== undefined && stamp !== null && stamp.stream === position.stream && stamp.seq <= position.seq;
}

type Ordered = SessionFrame | RunSnapshotFrame;

/**
 * One daemon socket's frames, held while what they follow is read over REST.
 * A view built from frames alone is whole only from the first frame on, so a
 * socket that joins, rejoins after a drop, or finds a restarted daemon loads
 * the session first and goes on from there. Nothing is drawn from a frame
 * before the load it follows: a run snapshot adopted before the transcript is
 * redrawn would be undone by the redraw.
 */
abstract class DaemonStream<L> {
  private readonly order = new FrameOrder();
  /** Whether the view accounts for everything up to the last frame delivered. */
  private whole = false;
  private loading = false;
  /** A gap opened while a load was out: what it returns may not cover it. */
  private again = false;
  private held: Ordered[] = [];
  private closed = false;

  constructor(private readonly read: () => Promise<L>, private readonly failed: (error: unknown) => void) {}

  receive(frame: DaemonFrame): void {
    if (this.closed) return;
    switch (frame.type) {
      // The snapshot after it says what this socket accounts for.
      case 'connected':
        return;
      case 'child_tree':
      case 'account_limits':
        this.unordered(frame);
        return;
      case 'run_snapshot':
        this.ordered(frame, this.order.snapshotOf(frame));
        return;
      default:
        this.ordered(frame, this.order.broadcast(frame));
    }
  }

  close(): void {
    this.closed = true;
    this.held = [];
  }

  /** Whole each time, or numbered on their own: never held behind a load. */
  protected abstract unordered(frame: ChildTreeFrame | AccountLimitsFrame): void;
  protected abstract snapshot(frame: RunSnapshotFrame): void;
  protected abstract broadcast(frame: SessionMessage | SessionNotice): void;
  /** Redraw from a load; returns what of the stream the load accounts for, when it says. */
  protected abstract loaded(state: L): StreamStamp | undefined;

  private ordered(frame: Ordered, judgement: Judgement): void {
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

/** A root session as a load over REST returns it, for the view to redraw from. */
export interface DaemonSessionState {
  /** The transcript the conversation is redrawn from: `SessionResponse.plan` or `AdoptSessionResponse.plan`. */
  conversation: SavedConversation;
  /** The run as the load read it; a later run snapshot replaces it. */
  run?: RunView;
  /** The planner turn running now, as `AdoptSessionResponse.plannerTurnId`: its prose lands in it. */
  plannerTurnId?: string;
}

export interface DaemonSessionHooks {
  /** Read the session as it stands, after the socket opened: `GET /api/sessions/:id`. */
  load(): Promise<DaemonSessionState>;
  /** What only the host can do, as {@link SessionView.receive} asks it. */
  cue(cue: SessionCue): void;
  /** A daemon's own word on the session; a chat has no place of its own for it. */
  notice?(notice: SessionNotice): void;
  failed(error: unknown): void;
}

/**
 * A root session's socket (`/ws/session/:id`) turned into the view the
 * in-process host draws: the same {@link SessionView}, fed frame by frame.
 */
export class DaemonSessionStream extends DaemonStream<DaemonSessionState> {
  private limits: { stream: string; revision: number } | null = null;

  constructor(
    private readonly view: SessionView,
    private readonly post: (msg: HostToWebview) => void,
    private readonly hooks: DaemonSessionHooks,
  ) {
    super(() => hooks.load(), (error) => hooks.failed(error));
  }

  protected unordered(frame: ChildTreeFrame | AccountLimitsFrame): void {
    if (frame.type === 'child_tree') {
      this.post({ type: 'children', children: frame.children, rootId: frame.sessionId });
      return;
    }
    // Quota reads are numbered on their own count, per daemon.
    if (this.limits?.stream === frame.stream && frame.revision <= this.limits.revision) return;
    this.limits = { stream: frame.stream, revision: frame.revision };
    this.post({ type: 'accountLimits', limits: frame.limits });
  }

  protected snapshot(frame: RunSnapshotFrame): void {
    this.view.adopt({ run: frame.view, ...(frame.approvals ? { approvals: frame.approvals } : {}) });
  }

  protected broadcast(frame: SessionMessage | SessionNotice): void {
    if (frame.type === 'notice') { this.hooks.notice?.(frame); return; }
    const cue = this.view.receive(frame);
    if (cue) this.hooks.cue(cue);
  }

  /**
   * The root's REST read carries no stream position, so every frame held
   * behind it is applied after it: a frame the read already holds is drawn
   * twice, where the in-process host draws it once.
   */
  protected loaded(state: DaemonSessionState): undefined {
    this.view.reload(state.conversation);
    if (state.run) this.view.adopt({ run: state.run });
    if (state.plannerTurnId) this.view.receive({ type: 'planner_turn_started', turnId: state.plannerTurnId });
    return undefined;
  }
}

const NOT_OPEN = 'The child plan is no longer open.';

export interface DaemonChildHooks {
  /** `GET /api/sessions/:root/children/:childId`, read after the child's socket opened. */
  load(): Promise<ChildPlanResponse>;
  failed(error: unknown): void;
}

/**
 * A child plan's own socket (`/ws/session/:root/child/:childId`) turned into
 * the child pane's view. The in-process host reads the child's view off its
 * handle at each change; here it is folded from the load and the frames after
 * it, with the same `reduceRun` the handle's run comes from.
 */
export class DaemonChildStream extends DaemonStream<ChildPlanResponse> {
  private view: ChildPlanView | null = null;
  private readonly child: ChildView;

  constructor(private readonly childId: string, private readonly post: (msg: HostToWebview) => void, hooks: DaemonChildHooks) {
    super(() => hooks.load(), (error) => hooks.failed(error));
    this.child = new ChildView(childId, post, () => {
      if (!this.view) throw new Error(NOT_OPEN);
      return this.view;
    });
  }

  /**
   * The root's `child_tree`, which a child's socket does not carry: the
   * child's entry moves with it, and a child gone from the tree is closed,
   * as the in-process host closes one its directory no longer finds.
   */
  tree(children: readonly ChildPlanEntry[]): void {
    const entry = children.find((candidate) => candidate.sessionId === this.childId);
    if (!entry) {
      this.close();
      this.post({ type: 'childClosed' });
      this.post({ type: 'childNotice', childId: this.childId, message: NOT_OPEN });
      return;
    }
    if (!this.view) return;
    this.view = { ...this.view, child: entry };
    this.child.show();
  }

  /** A webview that comes back holds nothing. */
  resend(): void {
    if (this.view) this.child.resend();
  }

  protected unordered(): void {
    // A child's socket carries neither: the tree is the root's, and so are account limits.
  }

  protected snapshot(frame: RunSnapshotFrame): void {
    if (!this.view) return;
    this.view = { ...this.view, run: frame.view };
    this.child.show();
  }

  protected broadcast(frame: ChildFrame): void {
    if (!this.view || ROOT_ONLY.has(frame.type)) return;
    if (frame.type !== 'notice') this.view = { ...this.view, run: reduceRun(this.view.run, frame) };
    this.child.receive(frame);
  }

  protected loaded({ position, ...view }: ChildPlanResponse): StreamStamp {
    this.view = view;
    this.child.open();
    return position;
  }
}
