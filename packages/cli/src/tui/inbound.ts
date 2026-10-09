import { isAwaitingReason, type SessionMessage, type SessionNotice } from '@ordewell/core';
import type { WsEvent } from '../apiClient';
import { sanitize } from './ansi';
import type { Action } from './reducer';
import type { TaskStatusUpdate } from './reducers/shared';

/*
 * One session's inbound events, whichever subscription delivered them.
 *
 * The daemon sends every broadcast to every socket subscribed to a session
 * (`OrchestratorPool.broadcast`), so while a run is under way — the run's own
 * subscription is open, and a planner turn opens a second one around its REST
 * call — the same planner-conversation message arrives on both. This module is
 * the one place that knows that, and the one place that decides what a message
 * shows: the conversation view for anything a planner said or did, the run's
 * own handling for task lifecycle.
 *
 * Dedupe is per identity, not per subscription kind: each identity counts the
 * copies each subscription has delivered, and a copy is real only while it
 * takes a subscription past every other — the first copy of a broadcast is
 * shown, the same broadcast arriving on any other subscription, or a second
 * run socket, is dropped. A message the planner genuinely repeats is a later
 * broadcast and pulls ahead again.
 */

export type Dispatch = (action: Action) => void;

/**
 * Whether a subscription is the planner's or a run's. It decides behaviour
 * (streamed prose has one voice, a run's `plan_generated` also refreshes the
 * pane), never identity: two run sockets are two subscriptions that each get
 * every broadcast, and counting by kind would show one broadcast twice.
 */
type Kind = 'planning' | 'execution';

/** One subscription's event callback. */
export type Receiver = (event: WsEvent) => void;

/** A streamed text piece: one of many that arrive in a burst and read as one. */
type Streamed = Extract<SessionMessage, { type: 'planner_text_delta' | 'planner_thinking_delta' | 'plan_token' }>;

type ConversationMessage = Extract<
  SessionMessage,
  {
    type:
      | 'planner_message' | 'planner_turn_started' | 'planner_turn_ended' | 'planner_text_delta' | 'planner_thinking_delta'
      | 'planner_skill_loaded'
      | 'planner_text_retracted' | 'plan_token' | 'plan_generated' | 'research_step' | 'research_step_done'
      | 'subagent_started' | 'subagent_finished' | 'planner_usage' | 'planner_liveness'
      | 'approval_request' | 'approval_settled' | 'approval_decided';
  }
>;

/** What the lifecycle switch below is left to handle once conversation is routed out. */
type LifecycleMessage = Exclude<SessionMessage, ConversationMessage> | SessionNotice;

const CONVERSATION_TYPES: ReadonlySet<string> = new Set<ConversationMessage['type']>([
  'planner_message', 'planner_turn_started', 'planner_turn_ended', 'planner_text_delta', 'planner_thinking_delta',
  'planner_skill_loaded',
  'planner_text_retracted', 'plan_token', 'plan_generated', 'research_step', 'research_step_done',
  'subagent_started', 'subagent_finished', 'planner_usage', 'planner_liveness',
  'approval_request', 'approval_settled', 'approval_decided',
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
function identity(event: WsEvent): string {
  if (event.type === 'planner_message') return replyKey(event.content, event.timestamp);
  if (event.type === 'approval_request' || event.type === 'approval_settled') return `${event.type}:${event.id}`;
  return JSON.stringify(event);
}

function replyKey(content: string, timestamp?: string): string {
  return timestamp ? `planner_message:${timestamp}:${content}` : `planner_message:content:${content}`;
}

/**
 * How many copies of one identity each subscription has delivered. Counting per
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
  /** A fresh subscription for a run. Each call is its own identity. */
  execution(): Receiver;
  /**
   * The settled reply an awaited call's plan carries. The socket usually spoke
   * it already — the daemon commits before answering — and then the same words
   * are on screen and this is dropped; when the socket lost the frame, this is
   * the only copy there is.
   */
  backfill(content: string, timestamp?: string): void;
  /**
   * A redrawn transcript now holds this entry (a compaction's summary), so a
   * socket copy arriving afterwards is the broadcast the redraw already
   * covers — not a new turn.
   */
  redrawn(content: string, timestamp?: string): void;
  /** A burst held for batching goes out now, in order. */
  flush(): void;
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

function createInbound(dispatch: Dispatch, sessionId: string): SessionInbound {
  const copies = new Copies(64);
  // Reply texts already on screen, so a timestamp-less backfill of one is not spoken again.
  const shown = new WindowSet(64);
  // Entries a redraw or a backfill already accounts for; the next matching copy is stale.
  const pending = new WindowSet(16);

  // A burst of deltas is held and dispatched as one, so a fast stream repaints
  // once per burst rather than once per token.
  const DELTA_DEBOUNCE_MS = 75;
  let held: Streamed | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
    shown.add(message.content);
    dispatch({ type: 'sessionMessage', message, sessionId });
  };

  const acceptReply = (id: string, event: Extract<SessionMessage, { type: 'planner_message' }>): void => {
    const key = replyKey(event.content, event.timestamp);
    if (pending.take(key)) {
      copies.credit(id, key);
      return;
    }
    if (!copies.first(id, key)) return;
    showReply(event);
  };

  const deliverConversation = (kind: Kind, id: string, event: ConversationMessage): void => {
    if (event.type === 'planner_message') {
      acceptReply(id, event);
      return;
    }
    if (!copies.first(id, identity(event))) return;
    if (event.type === 'plan_generated') {
      dispatch({ type: 'sessionMessage', message: event, sessionId });
      // A run's queued edit is reconciled into this broadcast with no turn of
      // its own, so the pane follows it here. On the planning stream the same
      // broadcast is a turn still in flight: `converse` settles the plan it
      // gets back, and ending the turn here would drain the queue early.
      if (kind === 'execution') dispatch({ type: 'planUpdated', plan: event.plan, sessionId });
      return;
    }
    dispatch({ type: 'sessionMessage', message: event, sessionId });
  };

  const receive = (kind: Kind, id: string, event: WsEvent): void => {
    if (isStreamed(event)) {
      // Streamed prose has one voice: the planning subscription. A run's own
      // socket ignores it, as it always has.
      if (kind === 'planning') hold(event);
      return;
    }
    flush();
    if (isConversation(event)) {
      deliverConversation(kind, id, event);
      return;
    }
    if (!copies.first(id, identity(event))) return;
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
    backfill: (content, timestamp) => {
      if (shown.has(content)) return;
      const message = { type: 'planner_message' as const, content, timestamp: timestamp ?? new Date().toISOString() };
      showReply(message);
      // A copy still in flight — the REST answer can beat the socket frame —
      // is this same reply, so the next matching copy is swallowed.
      if (timestamp) pending.add(replyKey(content, timestamp));
    },
    redrawn: (content, timestamp) => {
      shown.add(content);
      pending.add(replyKey(content, timestamp));
    },
    flush,
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
    case 'status_update': {
      const updates: Record<string, TaskStatusUpdate> = {};
      for (const task of event.tasks ?? []) {
        updates[String(task.id)] = {
          status: String(task.status),
          idleSince: task.idleSince ?? null,
          isolation: task.isolation,
          transport: task.transport,
          awaitingReason: isAwaitingReason(task.awaitingReason) ? task.awaitingReason : undefined,
          ...(typeof task.checkpoint === 'string' && task.checkpoint ? { checkpoint: sanitize(task.checkpoint) } : {}),
          ...(task.continuable ? { continuable: true } : {}),
          awaitingApproval: typeof task.awaitingApproval === 'number' && task.awaitingApproval > 0 ? task.awaitingApproval : undefined,
          ...(task.mergeGate?.length ? { mergeGate: task.mergeGate.map(String) } : {}),
          ...(task.forcedPastGate?.length ? { forcedPastGate: task.forcedPastGate.map(String) } : {}),
        };
      }
      // Absent means no task waits at a gate any more, which is news too.
      const gate = event.gate ? { paused: event.gate.paused === true, handoff: { repos: event.gate.repos, landed: event.gate.landed } } : null;
      dispatch({ type: 'tasksStatus', updates, gate, sessionId });
      return;
    }

    case 'task_started':
      dispatch({ type: 'taskStarted', taskId: String(event.taskId), title: String(event.title ?? event.taskId), runner: event.runner, sessionId });
      return;

    // The extension shows these in its checkpoint panel; here they are a
    // transcript line, and the task view carries the card that answers them.
    case 'checkpoint':
      dispatch({ type: 'taskCheckpoint', taskId: String(event.taskId), title: String(event.taskTitle), summary: event.summary, sessionId });
      return;

    case 'review_needed':
      dispatch({ type: 'notice', message: 'Plan needs your sign-off — /approve to continue.' });
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
      dispatch({ type: 'isolationHandoff', handoff: { repos: event.repos, landed: event.landed }, sessionId });
      return;

    // A structured task's log as it happens (ADR-0018, P1): the task view is
    // its only reader, and the reducer drops it unless that view is open on
    // this task. The run's watcher itself does nothing with it.
    case 'task_log':
      dispatch({ type: 'taskLog', taskId: String(event.taskId), attempt: event.attempt, events: event.events, sessionId });
      return;

    // Raw runner chatter. Listed rather than defaulted, so a new lifecycle
    // variant fails to compile here until someone decides what a run's watcher
    // does with it.
    case 'task_updated':
    case 'task_output':
      return;

    // Its asker already has the words, from the merge request itself; a
    // viewer that did not ask still has to drop a run that is gone.
    case 'isolation_merge':
      if (event.result.outcome === 'merged') dispatch({ type: 'runCleared', sessionId });
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
