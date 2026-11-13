import { DaemonStream, stampOf } from '@ordewell/core';
import type {
  AccountLimitsFrame, ChildTreeFrame, DaemonFrame, ReplyRun, RunSnapshotFrame, RunView, SessionMessage, SessionNotice, StreamStamp,
} from '@ordewell/core';
import type { WsEvent } from '../apiClient';
import type { Action } from './reducer';

/*
 * One session's inbound events, as the session's one socket delivers them.
 *
 * The TUI holds one socket per session it follows (`SessionLink`), whoever
 * started the turn or the run it carries: a turn this surface sent, a
 * supervisor's or research wake-up, a resend at a usage-limit reset, a message
 * from another window. This module is the one place that decides what a
 * message shows: the conversation view for anything a planner said or did,
 * the run's own handling for task lifecycle.
 *
 * Ordering, dedupe, the hold behind a load and the gap's reread are core's
 * `DaemonStream` (ADR-0017), the base the desktop's session stream shares; what
 * is left here is what only a terminal does: batch a stream of deltas into one
 * repaint, and route each message to the reducer action that draws it.
 */

export type Dispatch = (action: Action) => void;

/** A streamed text piece: one of many that arrive in a burst and read as one. */
type Streamed = Extract<SessionMessage, { type: 'planner_text_delta' | 'planner_thinking_delta' | 'plan_token' }>;

type ConversationMessage = Partial<StreamStamp> & Extract<
  SessionMessage,
  {
    type:
      | 'planner_message' | 'planner_turn_started' | 'planner_turn_ended' | 'planner_text_delta' | 'planner_thinking_delta'
      | 'planner_skill_loaded'
      | 'planner_text_retracted' | 'plan_token' | 'plan_generated' | 'research_step' | 'research_step_done'
      | 'subagent_started' | 'subagent_finished' | 'planner_usage' | 'planner_liveness' | 'planner_compaction' | 'planner_detection'
      | 'approval_request' | 'approval_settled' | 'approval_decided'
      | 'execution_action';
  }
>;

/** What the lifecycle switch below is left to handle once conversation is routed out. */
type LifecycleMessage = (Exclude<SessionMessage, ConversationMessage> | SessionNotice) & Partial<StreamStamp>;

const CONVERSATION_TYPES: ReadonlySet<string> = new Set<ConversationMessage['type']>([
  'planner_message', 'planner_turn_started', 'planner_turn_ended', 'planner_text_delta', 'planner_thinking_delta',
  'planner_skill_loaded',
  'planner_text_retracted', 'plan_token', 'plan_generated', 'research_step', 'research_step_done',
  'subagent_started', 'subagent_finished', 'planner_usage', 'planner_liveness', 'planner_compaction', 'planner_detection',
  'approval_request', 'approval_settled', 'approval_decided',
  'execution_action',
]);

function isStreamed(event: { type: string }): event is Streamed {
  return event.type === 'planner_text_delta' || event.type === 'planner_thinking_delta' || event.type === 'plan_token';
}

function isConversation(event: { type: string }): event is ConversationMessage {
  return CONVERSATION_TYPES.has(event.type);
}

/** Two streamed pieces as one, when the second continues the same stream; otherwise null. */
function joinStreamed(held: Streamed, next: Streamed): Streamed | null {
  if (held.type === 'planner_text_delta' && next.type === 'planner_text_delta') {
    return held.turnId === next.turnId && held.segmentId === next.segmentId ? { ...held, text: held.text + next.text } : null;
  }
  if (held.type === 'planner_thinking_delta' && next.type === 'planner_thinking_delta') {
    const same = held.turnId === next.turnId && held.segmentId === next.segmentId && held.subagentId === next.subagentId;
    return same ? { ...held, text: held.text + next.text } : null;
  }
  if (held.type === 'plan_token' && next.type === 'plan_token') {
    return held.turnId === next.turnId && held.segmentId === next.segmentId ? { ...held, token: held.token + next.token } : null;
  }
  return null;
}

function replyKey(content: string, timestamp?: string): string {
  return timestamp ? `planner_message:${timestamp}:${content}` : `planner_message:content:${content}`;
}

/** A bounded set that can hand an entry back once — the redraw's stale copies. */
class WindowSet {
  private readonly items = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly cap: number) {}

  add(value: string): void {
    if (this.items.has(value)) return;
    this.items.add(value);
    this.order.push(value);
    if (this.order.length > this.cap) this.items.delete(this.order.shift()!);
  }

  has(value: string): boolean {
    return this.items.has(value);
  }

  /** Removes the value and answers whether it was there. */
  take(value: string): boolean {
    if (!this.items.has(value)) return false;
    this.items.delete(value);
    return true;
  }
}

/** What a load read: the redraw to apply and how much of the stream it accounts for. */
export interface TuiRead {
  position?: StreamStamp;
  /** The run the read holds, for a greeting snapshot's approvals to ride on when the read covers it. */
  run?: RunView;
  /** Draws it. Called once, when the read is the one the stream goes on from. */
  apply(): void;
}

export interface SessionInbound {
  /** One frame from the session's socket, or from a reconnect's socket that overlaps it. */
  receive(event: WsEvent): void;
  /**
   * The settled reply an awaited call's plan carries. The socket usually spoke
   * it already — the daemon commits before answering — and then the same words
   * are on screen and this is dropped; when the socket lost the frame, this is
   * the only copy there is. `runs` are the entry's, so each settles in the
   * segment it streamed under.
   */
  backfill(content: string, timestamp?: string, runs?: ReplyRun[]): void;
  /** A burst held for batching goes out now, in order. */
  flush(): void;
  /**
   * Opens the session from a read, holding every frame behind it: a session
   * is followed before it is the one on screen, so a greeting dispatched at
   * once would meet the reducer's stale check and be dropped — a request
   * answered elsewhere meanwhile among them. The read draws the session; what
   * the stream sent meanwhile goes on top, in order, unless the read says it
   * already holds it. Rejects with the read's own failure.
   */
  openFrom(read: () => Promise<TuiRead>): Promise<void>;
}

/** What a stream's reader consults, shared with its constructor because `super` runs before `this` exists. */
interface Reader {
  custom: (() => Promise<TuiRead>) | null;
}

const DELTA_DEBOUNCE_MS = 75;

/**
 * One session's inbound stream. It starts whole: the TUI draws a session it
 * opens itself (a new one has no transcript to read), and a load is asked for
 * by `openFrom`, or by the base on a gap.
 */
class TuiStream extends DaemonStream<TuiRead> {
  // Replies already on screen. A backfill with a timestamp is told by its key:
  // a fixed reply that repeats ("Tasks updated") is the same words, not the
  // same reply. One without can only be told by its words.
  private readonly shown = new WindowSet(64);
  private readonly shownTexts = new WindowSet(64);
  // Entries a backfill already accounts for; the next matching copy is stale.
  private readonly pending = new WindowSet(16);
  // A burst of deltas is held and dispatched as one, so a fast stream repaints
  // once per burst rather than once per token.
  private burst: Streamed | null = null;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;
  /** A load of this surface's own is out: the session is not on screen yet. */
  private opening = false;
  /** The newest greeting snapshot with approvals seen while opening: no read returns them. */
  private approvals: RunSnapshotFrame | null = null;
  /** Frames the reducer would drop as stale before the session is on screen, said once it is. */
  private deferred: Array<() => void> = [];

  constructor(private readonly dispatch: Dispatch, private readonly sessionId: string, private readonly reader: Reader = { custom: null }) {
    // A gap needs no read of its own: the reducer's `streamGap` reads the
    // conversation back, or not, by whether a turn is drawing it (the effect
    // is gated there, not here), and what the frames hold goes on after it.
    super(
      () => reader.custom ? reader.custom() : Promise.resolve(gapRead(dispatch, sessionId)),
      () => {},
    );
    this.assumeWhole();
  }

  override receive(frame: DaemonFrame): void {
    if (frame.type === 'run_snapshot') {
      if (this.opening && frame.approvals) this.approvals = frame;
      // Only a fixture sends a snapshot without its stamp (a daemon older than
      // it is refused at connect), and it has nothing to order it by.
      if (!this.opening && stampOf(frame) === null) {
        this.snapshot(frame);
        return;
      }
    }
    super.receive(frame);
  }

  async openFrom(read: () => Promise<TuiRead>): Promise<void> {
    const outcome: { error?: unknown; failed: boolean } = { failed: false };
    const mine = async (): Promise<TuiRead> => {
      try {
        outcome.failed = false;
        return await read();
      } catch (error) {
        outcome.failed = true;
        outcome.error = error;
        throw error;
      }
    };
    this.reader.custom = mine;
    this.opening = true;
    this.approvals = null;
    try {
      await this.reload();
    } finally {
      if (this.reader.custom === mine) {
        this.reader.custom = null;
        this.opening = false;
        this.approvals = null;
        const later = this.deferred;
        this.deferred = [];
        for (const run of later) run();
      }
    }
    if (outcome.failed) throw outcome.error;
  }

  backfill(content: string, timestamp?: string, runs?: ReplyRun[]): void {
    if (timestamp ? this.shown.has(replyKey(content, timestamp)) : this.shownTexts.has(content)) return;
    const message = { type: 'planner_message' as const, content, timestamp: timestamp ?? new Date().toISOString(), ...(runs ? { runs } : {}) };
    this.showReply(message);
    // A copy still in flight — the REST answer can beat the socket frame —
    // is this same reply, so the next matching copy is swallowed.
    if (timestamp) this.pending.add(replyKey(content, timestamp));
  }

  flush(): void {
    if (this.burstTimer !== null) {
      clearTimeout(this.burstTimer);
      this.burstTimer = null;
    }
    if (this.burst === null) return;
    const message = this.burst;
    this.burst = null;
    this.dispatch({ type: 'sessionMessage', message, sessionId: this.sessionId });
  }

  protected loaded(read: TuiRead): StreamStamp | undefined {
    read.apply();
    // A read that covers the greeting drops it, and with it the approvals only
    // a snapshot carries; the transcript just drawn holds no approval card.
    const greeting = this.approvals;
    if (greeting?.approvals) {
      this.dispatch({ type: 'runSnapshot', view: read.run ?? greeting.view, approvals: greeting.approvals, sessionId: this.sessionId });
    }
    return read.position;
  }

  protected snapshot({ view, approvals }: RunSnapshotFrame): void {
    this.flush();
    this.dispatch({ type: 'runSnapshot', view, ...(approvals ? { approvals } : {}), sessionId: this.sessionId });
  }

  protected tree(frame: ChildTreeFrame): void {
    if (frame.sessionId !== this.sessionId) return;
    this.later(() => this.dispatch({ type: 'childTree', sessionId: this.sessionId, children: frame.children }));
  }

  protected limits(frame: AccountLimitsFrame): void {
    if (frame.sessionId !== this.sessionId) return;
    this.later(() => this.dispatch({ type: 'accountLimits', limits: frame.limits, sessionId: this.sessionId }));
  }

  protected broadcast(frame: SessionMessage | SessionNotice): void {
    const event = frame as LifecycleMessage | ConversationMessage;
    // Whoever started the turn: a wake-up's prose streams as a sent turn's does.
    // Anything that is not the same stream's next piece flushes the burst
    // first, so dispatch order stays exactly the order the session sent.
    if (isStreamed(event)) {
      this.hold(event);
      return;
    }
    this.flush();
    if (isConversation(event)) {
      this.conversation(event);
      return;
    }
    dispatchLifecycle(this.dispatch, event, this.sessionId);
  }

  private later(run: () => void): void {
    if (this.opening) this.deferred.push(run);
    else run();
  }

  private hold(event: Streamed): void {
    const joined = this.burst && joinStreamed(this.burst, event);
    if (joined) {
      this.burst = joined;
      return;
    }
    this.flush();
    this.burst = event;
    this.burstTimer = setTimeout(() => this.flush(), DELTA_DEBOUNCE_MS);
  }

  private showReply(message: Extract<SessionMessage, { type: 'planner_message' }>): void {
    this.shown.add(replyKey(message.content, message.timestamp));
    this.shownTexts.add(message.content);
    this.dispatch({ type: 'sessionMessage', message, sessionId: this.sessionId });
  }

  private conversation(event: ConversationMessage): void {
    if (event.type === 'planner_message') {
      if (!this.pending.take(replyKey(event.content, event.timestamp))) this.showReply(event);
      return;
    }
    this.dispatch({ type: 'sessionMessage', message: event, sessionId: this.sessionId });
    if (event.type !== 'plan_generated') return;
    // Every plan a turn lands, one this surface did not send included (a
    // supervisor's edit, an input replayed after a reload), and whichever
    // socket's copy came first. With this surface's own turn out, the
    // reducer only draws it: `converse` settles the plan it gets back, and
    // ending the turn here would send the held prompts early.
    this.dispatch({ type: 'planBroadcast', plan: event.plan, sessionId: this.sessionId });
  }
}

/** The read a gap owes: the reducer decides whether the conversation is read back (`streamGap`); frames are the news after it. */
function gapRead(dispatch: Dispatch, sessionId: string): TuiRead {
  dispatch({ type: 'streamGap', sessionId });
  return { apply: () => {} };
}

/** One session's inbound stream. Its ordering state lives as long as the session's link. */
export function createInbound(dispatch: Dispatch, sessionId: string): SessionInbound {
  const stream = new TuiStream(dispatch, sessionId);
  // Bound, since callers hand `receive` on as a callback.
  return {
    receive: (event) => stream.receive(event),
    backfill: (content, timestamp, runs) => stream.backfill(content, timestamp, runs),
    flush: () => stream.flush(),
    openFrom: (read) => stream.openFrom(read),
  };
}

/**
 * A run's task lifecycle, and the session notices with no other surface. A
 * planner-conversation message never reaches here (see `receive`), but the
 * switch still names every `SessionMessage` so a new variant fails to compile
 * until someone decides where it belongs.
 */
function dispatchLifecycle(dispatch: Dispatch, event: LifecycleMessage, sessionId: string): void {
  switch (event.type) {
    case 'status_update':
      dispatch({
        type: 'statusUpdate',
        tasks: event.tasks,
        ...(event.runMerge ? { runMerge: event.runMerge } : {}),
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.activity ? { activity: event.activity } : {}),
        ...(event.escalations ? { escalations: event.escalations } : {}),
        sessionId,
      });
      return;

    case 'task_started':
      dispatch({ type: 'taskStarted', taskId: String(event.taskId), order: event.order, title: String(event.title ?? event.taskId), runner: event.runner, sessionId });
      return;

    // The extension shows these in its checkpoint panel; here they are a
    // transcript line, and the task view carries the card that answers them.
    case 'checkpoint':
      dispatch({ type: 'taskCheckpoint', taskId: String(event.taskId), title: String(event.taskTitle), summary: event.summary, sessionId });
      return;

    case 'review_needed':
      dispatch({ type: 'notice', message: 'Plan needs your sign-off: /approve to continue.', sessionId });
      return;

    case 'review_approved':
      dispatch({ type: 'notice', message: 'Plan approved.', sessionId });
      return;

    case 'execution_complete':
      dispatch({ type: 'executionComplete', summary: event.summary, sessionId });
      return;

    // A stop carries no tally — the reducer counts the pane instead.
    case 'execution_stopped':
      dispatch({ type: 'executionComplete', stopped: true, sessionId });
      return;

    // Nothing started; the user chooses how to go on.
    case 'isolation_blocked':
      dispatch({ type: 'isolationBlocked', message: event.message, ...(event.repos ? { repos: event.repos } : {}), sessionId });
      return;

    // How the run isolates. The daemon has no toast channel, so this is the only place the user hears it.
    case 'notice':
      dispatch({ type: 'notice', message: event.message, level: event.level, sessionId });
      return;

    case 'isolation_handoff':
      dispatch({ type: 'isolationHandoff', handoff: { repos: event.repos, landed: event.landed, ...(event.deferredTo ? { deferredTo: event.deferredTo } : {}) }, sessionId });
      return;

    // A structured task's log as it happens (ADR-0018, P1): the task view is
    // its only reader, and the reducer drops it unless that view is open on
    // this task. The run's watcher itself does nothing with it.
    case 'task_log':
      dispatch({ type: 'taskLog', taskId: String(event.taskId), attempt: event.attempt, events: event.events, position: stampOf(event) ?? undefined, sessionId });
      return;

    case 'task_updated':
      dispatch({ type: 'taskUpdated', taskId: String(event.taskId), changes: event.changes, sessionId });
      return;

    // Raw runner chatter. Listed rather than defaulted, so a new lifecycle
    // variant fails to compile here until someone decides what a run's watcher
    // does with it.
    case 'task_output':
      return;

    // Whether the merge ended the run is the Session's to say, in `run_closed`.
    // The reducer words the result unless this pane asked for the merge itself.
    case 'isolation_merge':
      dispatch({ type: 'isolationMerged', result: event.result, ...(event.trigger ? { trigger: event.trigger } : {}), sessionId });
      return;

    case 'run_closed':
      dispatch({ type: 'runClosed', sessionId });
      return;

    default: {
      // Compile-time only. The socket also greets with `connected`, which is
      // not a SessionMessage and must stay ignorable.
      const unhandled: never = event;
      void unhandled;
      return;
    }
  }
}
