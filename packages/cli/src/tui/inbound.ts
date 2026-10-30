import type { ReplyRun, RunSnapshotFrame, SessionMessage, SessionNotice, StreamStamp } from '@ordewell/core';
import type { WsEvent } from '../apiClient';
import type { Action } from './reducer';

/*
 * One session's inbound events, whichever subscription delivered them.
 *
 * The daemon sends every broadcast to every socket subscribed to a session
 * (`OrchestratorPool.broadcast`), and the TUI holds several: a standing follow
 * of the session it shows, a run's own subscription around a run it asked for,
 * and one a planner turn opens around its REST call — so the same message
 * arrives on each. This module is
 * the one place that knows that, and the one place that decides what a message
 * shows: the conversation view for anything a planner said or did, the run's
 * own handling for task lifecycle.
 *
 * Dedupe is by the broadcast's place in the session's stream (`StreamStamp`):
 * the first copy of a sequence number is shown, every other copy — on another
 * subscription, a second run socket, or the socket a reload opened while the
 * old one still drained — is dropped. Nothing about it belongs to a
 * subscription, so a socket that is gone leaves nothing behind to hold back a
 * later broadcast that happens to read the same, as two identical status
 * updates do. A daemon older than the stamp is deduped by content instead (`Copies`).
 */

export type Dispatch = (action: Action) => void;

/**
 * Whether a subscription is the planner's or a run's. It decides behaviour
 * (streamed prose has one voice), never identity: two run sockets are two
 * subscriptions that each get every broadcast, and counting by kind would
 * show one broadcast twice.
 */
type Kind = 'planning' | 'execution';

/** One subscription's event callback. */
export type Receiver = (event: WsEvent) => void;

/** A streamed text piece: one of many that arrive in a burst and read as one. */
type Streamed = Extract<SessionMessage, { type: 'planner_text_delta' | 'planner_thinking_delta' | 'plan_token' }>;

type ConversationMessage = Partial<StreamStamp> & Extract<
  SessionMessage,
  {
    type:
      | 'planner_message' | 'planner_turn_started' | 'planner_turn_ended' | 'planner_text_delta' | 'planner_thinking_delta'
      | 'planner_skill_loaded'
      | 'planner_text_retracted' | 'plan_token' | 'plan_generated' | 'research_step' | 'research_step_done'
      | 'subagent_started' | 'subagent_finished' | 'planner_usage' | 'planner_liveness' | 'planner_compaction'
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
  'subagent_started', 'subagent_finished', 'planner_usage', 'planner_liveness', 'planner_compaction',
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

/**
 * What one message is, for copy counting. A settled reply has no id, so its
 * timestamp (the daemon stamps the broadcast and the transcript entry with the
 * same `now`) plus its text is the identity; a copy that lost its timestamp —
 * the REST backfill of a test-shaped transcript — falls back to its text.
 */
function identity(event: Broadcast): string {
  if (event.type === 'planner_message') return replyKey(event.content, event.timestamp);
  if (event.type === 'approval_request' || event.type === 'approval_settled') return `${event.type}:${event.id}`;
  return JSON.stringify(event);
}

function replyKey(content: string, timestamp?: string): string {
  return timestamp ? `planner_message:${timestamp}:${content}` : `planner_message:content:${content}`;
}

/** A broadcast this client may have had more than once. */
type Broadcast = Exclude<WsEvent, RunSnapshotFrame | { type: 'account_limits' }>;

function stampOf(frame: Partial<StreamStamp>): StreamStamp | null {
  return frame.stream !== undefined && frame.seq !== undefined ? { stream: frame.stream, seq: frame.seq } : null;
}

/**
 * What a run snapshot already accounts for. One of these numbered at or below
 * the snapshot adopted is a copy that lagged behind it on an older socket, and
 * applying it after the snapshot would bring back what the snapshot says is
 * over — a preview cleared, a request answered.
 */
const COVERED: ReadonlySet<string> = new Set<Broadcast['type']>(['status_update', 'task_updated', 'approval_request', 'approval_settled']);

/**
 * The sequence numbers of one daemon's broadcasts this client has delivered
 * for one session. A window rather than a high-water mark: two sockets'
 * frames can interleave out of order, and a frame numbered below one already
 * shown may still be the first copy of its broadcast.
 */
class Delivered {
  private stream: string | null = null;
  private highest = 0;
  private snapshot = 0;
  private readonly seen = new Set<number>();

  constructor(private readonly window: number) {}

  first({ stream, seq }: StreamStamp): boolean {
    this.follow(stream);
    if (seq <= this.highest - this.window || this.seen.has(seq)) return false;
    this.seen.add(seq);
    if (seq > this.highest) {
      this.highest = seq;
      for (const old of this.seen) if (old <= seq - this.window) this.seen.delete(old);
    }
    return true;
  }

  covered({ seq }: StreamStamp): boolean {
    return seq <= this.snapshot;
  }

  /** Whether a snapshot is as new as everything delivered, and so adopted; an older one would undo what came after it. */
  adopt({ stream, seq }: StreamStamp): boolean {
    this.follow(stream);
    if (seq < this.highest) return false;
    this.snapshot = seq;
    this.highest = seq;
    return true;
  }

  // A new stream is a restarted daemon: its numbers start over and mean nothing against the last one's.
  private follow(stream: string): void {
    if (stream === this.stream) return;
    this.stream = stream;
    this.highest = 0;
    this.snapshot = 0;
    this.seen.clear();
  }
}

/** A clear or a drop: applying one twice changes nothing, so an unstamped copy is never held back. */
function isClear(event: Broadcast): boolean {
  return event.type === 'approval_settled';
}

/**
 * How many copies of one identity each subscription has delivered — the
 * dedupe for a daemon older than the stream stamp. Counting per
 * subscription — rather than per kind — is what keeps a second run socket from
 * showing a broadcast the first already showed. A copy is real only when it
 * takes a subscription past the highest count any subscription has reached:
 * the first delivery of broadcast N is the one that makes some count N, every
 * later copy of the same broadcast is a count already seen.
 */
class Copies {
  private readonly counts = new Map<string, Map<string, number>>();
  private readonly order: string[] = [];

  constructor(private readonly cap: number) {}

  /** Whether this delivery is the first copy of a new broadcast, whichever subscription carried it. */
  first(id: string, key: string): boolean {
    let highest = 0;
    for (const count of this.counts.get(key)?.values() ?? []) {
      if (count > highest) highest = count;
    }
    return this.bump(id, key) === highest + 1;
  }

  /** Account for a copy already shown (a redrawn transcript's entry), so its counterparts are recognized. */
  credit(id: string, key: string): void {
    this.bump(id, key);
  }

  private bump(id: string, key: string): number {
    let keyed = this.counts.get(key);
    if (!keyed) {
      keyed = new Map();
      this.counts.set(key, keyed);
      this.order.push(key);
      if (this.order.length > this.cap) this.counts.delete(this.order.shift()!);
    }
    const count = (keyed.get(id) ?? 0) + 1;
    keyed.set(id, count);
    return count;
  }
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
  /** A fresh subscription for a planning turn. Each call is its own identity. */
  planning(): Receiver;
  /** A fresh subscription for a run, or for the session's standing follow. Each call is its own identity. */
  execution(): Receiver;
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

const inbounds = new WeakMap<object, Map<string, SessionInbound>>();

/**
 * The inbound stream for one session, anchored to the client that owns the
 * sockets. The counting state must outlive a single effect invocation — the
 * duplicate copies arrive on two subscriptions driven by two of them — and it
 * must not outlive the client: a new daemon connection starts clean.
 */
export function inboundFor(api: object, dispatch: Dispatch, sessionId: string): SessionInbound {
  let sessions = inbounds.get(api);
  if (!sessions) {
    sessions = new Map();
    inbounds.set(api, sessions);
  }
  let inbound = sessions.get(sessionId);
  if (!inbound) {
    inbound = createInbound(dispatch, sessionId);
    sessions.set(sessionId, inbound);
  }
  return inbound;
}

/**
 * Drop what one session's sockets counted, for a session the TUI has closed or
 * deleted. A long-lived TUI browsing `/sessions` would otherwise keep a
 * window and three dedupe sets for every session it ever opened.
 */
export function forgetInbound(api: object, sessionId: string): void {
  inbounds.get(api)?.delete(sessionId);
}

function createInbound(dispatch: Dispatch, sessionId: string): SessionInbound {
  const delivered = new Delivered(256);
  const copies = new Copies(64);
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

  /** Whether this delivery is the first of a broadcast this surface has not shown. */
  const fresh = (id: string, event: Broadcast): boolean => {
    const stamp = stampOf(event);
    if (stamp) return delivered.first(stamp) && !(COVERED.has(event.type) && delivered.covered(stamp));
    return isClear(event) || copies.first(id, identity(event));
  };

  const acceptReply = (id: string, event: Extract<ConversationMessage, { type: 'planner_message' }>): void => {
    const key = replyKey(event.content, event.timestamp);
    if (stampOf(event)) {
      if (fresh(id, event) && !pending.take(key)) showReply(event);
      return;
    }
    if (pending.take(key)) {
      copies.credit(id, key);
      return;
    }
    if (!copies.first(id, key)) return;
    showReply(event);
  };

  const deliverSnapshot = ({ view, approvals }: RunSnapshotFrame): void => {
    dispatch({ type: 'runSnapshot', view, ...(approvals ? { approvals } : {}), sessionId });
  };

  const deliverConversation = (id: string, event: ConversationMessage): void => {
    if (event.type === 'planner_message') {
      acceptReply(id, event);
      return;
    }
    if (!fresh(id, event)) return;
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

  const receive = (kind: Kind, id: string, event: WsEvent): void => {
    // The daemon greets every socket with the run as it stands, so a client
    // that joins mid-run has it before the next update. Never counted as a
    // copy: a reconnect greets with a view identical to an earlier one, and
    // adopting a snapshot twice changes nothing. One older than a broadcast
    // already shown came in late on a newer socket, and is passed over.
    if (event.type === 'run_snapshot') {
      flush();
      const stamp = stampOf(event);
      if (stamp && !delivered.adopt(stamp)) return;
      if (holdingSnapshot) heldSnapshot = event;
      else deliverSnapshot(event);
      return;
    }
    if (holdingSnapshot) {
      heldAfter.push(() => receive(kind, id, event));
      return;
    }
    if (event.type === 'account_limits') {
      if (event.sessionId !== sessionId) return;
      if (limitsPosition?.stream === event.stream && event.revision <= limitsPosition.revision) return;
      limitsPosition = { stream: event.stream, revision: event.revision };
      dispatch({ type: 'accountLimits', limits: event.limits, sessionId });
      return;
    }
    if (isStreamed(event)) {
      // Streamed prose has one voice: the planning subscription. A run's own
      // socket ignores it, as it always has — and does not count as its copy.
      if (kind === 'planning' && (!stampOf(event) || fresh(id, event))) hold(event);
      return;
    }
    flush();
    if (isConversation(event)) {
      deliverConversation(id, event);
      return;
    }
    if (!fresh(id, event)) return;
    dispatchLifecycle(dispatch, event, sessionId);
  };

  let subscription = 0;

  return {
    planning: () => {
      const id = `p${++subscription}`;
      return (event) => receive('planning', id, event);
    },
    execution: () => {
      const id = `e${++subscription}`;
      return (event) => receive('execution', id, event);
    },
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
      dispatch({ type: 'notice', message: 'Plan needs your sign-off: /approve to continue.' });
      return;

    case 'review_approved':
      dispatch({ type: 'notice', message: 'Plan approved.' });
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
      dispatch({ type: 'notice', message: event.message, level: event.level });
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
