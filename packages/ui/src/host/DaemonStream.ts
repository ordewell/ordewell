import type {
  AccountLimitsFrame, ChildTreeFrame, RunSnapshotFrame, RunView, SessionMessage, SessionNotice, StreamStamp,
} from '@ordewell/core';
import { DaemonStream } from '@ordewell/core/plan-utils';
import type { HostToWebview } from '../shared/protocol';
import type { SavedConversation } from './ConversationViewHost';
import type { SessionCue, SessionView } from './SessionView';

/** A root session as a load over REST returns it, for the view to redraw from. */
export interface DaemonSessionState {
  /** The transcript the conversation is redrawn from: `SessionResponse.plan` or `AdoptSessionResponse.plan`. */
  conversation: SavedConversation;
  /** The run as the load read it; a later run snapshot replaces it. */
  run?: RunView;
  /** The planner turn running now, as `AdoptSessionResponse.plannerTurnId`: its prose lands in it. */
  plannerTurnId?: string;
  /** What of the socket the load accounts for, as `SessionResponse.position`; absent from a daemon older than it. */
  position?: StreamStamp;
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
  constructor(
    private readonly view: SessionView,
    private readonly post: (msg: HostToWebview) => void,
    private readonly hooks: DaemonSessionHooks,
  ) {
    super(() => hooks.load(), (error) => hooks.failed(error));
  }

  protected tree(frame: ChildTreeFrame): void {
    this.post({ type: 'children', children: frame.children, rootId: frame.sessionId });
  }

  protected limits(frame: AccountLimitsFrame): void {
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

  protected loaded(state: DaemonSessionState): StreamStamp | undefined {
    this.view.reload(state.conversation);
    if (state.run) this.view.adopt({ run: state.run });
    if (state.plannerTurnId) this.view.receive({ type: 'planner_turn_started', turnId: state.plannerTurnId });
    return state.position;
  }
}
