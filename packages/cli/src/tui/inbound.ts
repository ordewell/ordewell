import { StreamOrder, stampOf } from '@ordewell/core';
import type { Placement, ReplyRun, RunSnapshotFrame, SessionMessage, SessionNotice, StreamStamp } from '@ordewell/core';
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
 * Dedupe is by the broadcast's place in the session's stream (`StreamStamp`):
 * the first copy of a sequence number is shown, any other is dropped. One
 * socket delivers each broadcast once, but a reconnect's new socket can greet
 * with what the old one still drained, and a run snapshot can lag a broadcast
 * already shown. Every broadcast is stamped (a daemon older than the stamp is
 * refused at connect, `drivable`); what is not — the socket's greetings of a
 * compaction or detection in progress — changes nothing when applied twice.
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

function isStreamed(event: WsEvent): event is Streamed {
  return event.type === 'planner_text_delta' || event.type === 'planner_thinking_delta' || event.type === 'plan_token';
}

function isConversation(event: WsEvent): event is ConversationMessage {
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
   * Keeps the connect snapshot instead of delivering it, and every broadcast
   * after it. A load follows the session before it is the one on screen, so
   * anything dispatched at once would meet the reducer's stale check and be
   * dropped — a request answered elsewhere meanwhile among them.
   */
  holdSnapshot(): void;
  /**
   * Delivers the snapshot held and what came after it, in order (when
   * `deliver`), then hands them out as they come again. A load releases them
   * on top of what it read: they are newer.
   */
  releaseSnapshot(deliver: boolean): void;
}

/** One session's inbound stream. Its dedupe state lives as long as the session's link. */
export function createInbound(dispatch: Dispatch, sessionId: string): SessionInbound {
  const delivered = new StreamOrder();
  // Replies already on screen. A backfill with a timestamp is told by its key:
  // a fixed reply that repeats ("Tasks updated") is the same words, not the
  // same reply. One without can only be told by its words.
  const shown = new WindowSet(64);
  const shownTexts = new WindowSet(64);
  // Entries a redraw or a backfill already accounts for; the next matching copy is stale.
  const pending = new WindowSet(16);

  // A burst of deltas is held and dispatched as one, so a fast stream repaints
  // once per burst rather than once per token.
  const DELTA_DEBOUNCE_MS = 75;
  let held: Streamed | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let holdingSnapshot = false;
  let heldSnapshot: RunSnapshotFrame | null = null;
  let limitsPosition: { stream: string; revision: number } | null = null;
  let heldAfter: (() => void)[] = [];

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (held === null) return;
    const message = held;
    held = null;
    dispatch({ type: 'sessionMessage', message, sessionId });
  };

  // Anything that is not the same stream's next piece flushes the held burst
  // first, so dispatch order stays exactly the order the session sent.
  const hold = (event: Streamed): void => {
    const joined = held && joinStreamed(held, event);
    if (joined) {
      held = joined;
      return;
    }
    flush();
    held = event;
    timer = setTimeout(flush, DELTA_DEBOUNCE_MS);
  };

  const showReply = (message: Extract<SessionMessage, { type: 'planner_message' }>): void => {
    shown.add(replyKey(message.content, message.timestamp));
    shownTexts.add(message.content);
    dispatch({ type: 'sessionMessage', message, sessionId });
  };

  // A number past the next one is a broadcast this surface missed — a socket
  // that blipped and reconnected — so the conversation is read back.
  const placed = (placement: Placement): boolean => {
    if (placement.keep && placement.jump) dispatch({ type: 'streamGap', sessionId });
    return placement.keep;
  };

  /** Whether this delivery is the first of a broadcast this surface has not shown. */
  const fresh = (event: Partial<StreamStamp> & { type: string }): boolean => {
    const stamp = stampOf(event);
    return stamp ? placed(delivered.first(stamp, event.type)) : true;
  };

  const acceptReply = (event: Extract<ConversationMessage, { type: 'planner_message' }>): void => {
    if (fresh(event) && !pending.take(replyKey(event.content, event.timestamp))) showReply(event);
  };

  const deliverSnapshot = ({ view, approvals }: RunSnapshotFrame): void => {
    dispatch({ type: 'runSnapshot', view, ...(approvals ? { approvals } : {}), sessionId });
  };

  const deliverConversation = (event: ConversationMessage): void => {
    if (event.type === 'planner_message') {
      acceptReply(event);
      return;
    }
    if (!fresh(event)) return;
    if (event.type === 'plan_generated') {
      dispatch({ type: 'sessionMessage', message: event, sessionId });
      // Every plan a turn lands, one this surface did not send included (a
      // supervisor's edit, an input replayed after a reload), and whichever
      // socket's copy came first. With this surface's own turn out, the
      // reducer only draws it: `converse` settles the plan it gets back, and
      // ending the turn here would send the held prompts early.
      dispatch({ type: 'planBroadcast', plan: event.plan, sessionId });
      return;
    }
    dispatch({ type: 'sessionMessage', message: event, sessionId });
  };

  const receive = (event: WsEvent): void => {
    // The daemon greets every socket with the run as it stands, so a client
    // that joins mid-run has it before the next update. Never counted as a
    // copy: a reconnect greets with a view identical to an earlier one, and
    // adopting a snapshot twice changes nothing. One older than a broadcast
    // already shown came in late on a newer socket, and is passed over.
    if (event.type === 'run_snapshot') {
      flush();
      const stamp = stampOf(event);
      if (stamp && !placed(delivered.adopt(stamp))) return;
      if (holdingSnapshot) heldSnapshot = event;
      else deliverSnapshot(event);
      return;
    }
    if (holdingSnapshot) {
      heldAfter.push(() => receive(event));
      return;
    }
    // Whole each time and unstamped: the latest one is all of it, copies included.
    if (event.type === 'child_tree') {
      if (event.sessionId === sessionId) dispatch({ type: 'childTree', sessionId, children: event.children });
      return;
    }
    if (event.type === 'account_limits') {
      if (event.sessionId !== sessionId) return;
      if (limitsPosition?.stream === event.stream && event.revision <= limitsPosition.revision) return;
      limitsPosition = { stream: event.stream, revision: event.revision };
      dispatch({ type: 'accountLimits', limits: event.limits, sessionId });
      return;
    }
    // Whoever started the turn: a wake-up's prose streams as a sent turn's does.
    if (isStreamed(event)) {
      if (fresh(event)) hold(event);
      return;
    }
    flush();
    if (isConversation(event)) {
      deliverConversation(event);
      return;
    }
    if (!fresh(event)) return;
    dispatchLifecycle(dispatch, event, sessionId);
  };

  return {
    receive,
    backfill: (content, timestamp, runs) => {
      if (timestamp ? shown.has(replyKey(content, timestamp)) : shownTexts.has(content)) return;
      const message = { type: 'planner_message' as const, content, timestamp: timestamp ?? new Date().toISOString(), ...(runs ? { runs } : {}) };
      showReply(message);
      // A copy still in flight — the REST answer can beat the socket frame —
      // is this same reply, so the next matching copy is swallowed.
      if (timestamp) pending.add(replyKey(content, timestamp));
    },
    flush,
    holdSnapshot: () => {
      holdingSnapshot = true;
      heldSnapshot = null;
      heldAfter = [];
    },
    releaseSnapshot: (deliver) => {
      holdingSnapshot = false;
      const snapshot = heldSnapshot;
      const after = heldAfter;
      heldSnapshot = null;
      heldAfter = [];
      if (!deliver) return;
      if (snapshot) deliverSnapshot(snapshot);
      for (const next of after) next();
    },
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

    // Its asker already has the words, from the merge request itself. Whether
    // the merge ended the run is the Session's to say, in `run_closed`.
    case 'isolation_merge':
      dispatch({ type: 'isolationMerged', result: event.result, sessionId });
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
