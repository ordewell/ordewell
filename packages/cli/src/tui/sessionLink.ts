import { ReconnectBackoff } from '@ordewell/core';
import { DaemonError, type ApiClient, type SessionSocket, type SocketEnd } from '../apiClient';
import { createInbound, type Dispatch, type SessionInbound, type TuiRead } from './inbound';

/*
 * The TUI's sockets: one per session it follows, and one per child plan on
 * screen. A session's socket carries everything the session broadcasts — a
 * turn this surface sent and one it did not (a wake-up, a resend at a reset, a
 * message from another window), a run it asked for and one it did not
 * (autorun, the planner's `run_plan`, the supervisor) — so there is nothing to
 * open around a request and no second copy to tell apart.
 *
 * Anchored to the client that owns the sockets, so a new daemon connection
 * starts clean.
 */

export interface LinkDeps {
  api: Pick<ApiClient, 'followSession' | 'followChild' | 'getChild'>;
  dispatch: Dispatch;
}

/** What a request sent with a link open may do with the session's inbound stream. */
export type LinkInbound = Pick<SessionInbound, 'backfill' | 'flush'>;

interface Links {
  sessions: Map<string, SessionLink>;
  /** The session on screen: the one link that reconnects when its socket drops. */
  shown: SessionLink | null;
  /** The shown session's reconnects, for the backoff and its one notice per outage. */
  backoff: ReconnectBackoff;
  children: Map<string, ChildLink>;
}

const registries = new WeakMap<object, Links>();

function linksOf(api: object): Links {
  let links = registries.get(api);
  if (!links) {
    links = { sessions: new Map(), shown: null, backoff: new ReconnectBackoff(), children: new Map() };
    registries.set(api, links);
  }
  return links;
}

/** A reconnect at the backoff's next wait, which grows while the daemon stays down. Unref'd, so it never holds the process open. */
function retryAfter(backoff: ReconnectBackoff, retry: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(retry, backoff.next());
  timer.unref?.();
  return timer;
}

/** The link to one session, made on first use. */
export function sessionLink(deps: LinkDeps, sessionId: string): SessionLink {
  const links = linksOf(deps.api);
  let link = links.sessions.get(sessionId);
  if (!link) {
    link = new SessionLink(links, deps, sessionId);
    links.sessions.set(sessionId, link);
  }
  return link;
}

/** The session the TUI follows as the one on screen, if any. */
export function shownSession(api: object): string | undefined {
  return registries.get(api)?.shown?.sessionId;
}

type RunEnd = 'ended' | 'lost' | 'superseded';

/** One socket's life: opened, then ended. */
interface Attempt {
  socket: SessionSocket;
  ready: Promise<boolean>;
}

export class SessionLink {
  private readonly receiver: SessionInbound;
  private attempt: Attempt | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Runs this surface asked for and still waits on; while any is out, the socket stays open off screen. */
  private runs = 0;
  private runEnded: ((how: RunEnd) => void) | null = null;

  constructor(private readonly links: Links, private readonly deps: LinkDeps, readonly sessionId: string) {
    this.receiver = createInbound(deps.dispatch, sessionId);
  }

  get inbound(): LinkInbound {
    return this.receiver;
  }

  /**
   * Opens the session on screen from `read`: the socket is followed first and
   * every frame it sends is held behind the read (see {@link SessionInbound.openFrom}),
   * so nothing the session does between the two is missed. Rejects with the
   * read's failure, leaving the link as it was.
   */
  openFrom(read: () => Promise<TuiRead>): Promise<void> {
    const opening = this.ensure();
    return this.receiver.openFrom(async () => {
      await opening;
      return read();
    });
  }

  /**
   * Makes this the session on screen and follows it, resolving whether its
   * socket is open; never rejects. Ensured before every request that may make
   * the session broadcast, since the daemon tells only the sockets already
   * subscribed: a status_update emitted before the socket listened is lost.
   */
  ensure(): Promise<boolean> {
    return this.follow().ready;
  }

  /**
   * Runs a request that spawns runner work, and stays until the run settles:
   * its completion on the socket, the socket's loss (`executionLost`), or a
   * later run asked for on the same session, which reports from then on. A
   * socket that cannot open fails the request unsent, with the socket's own
   * error, so a refused connection is the daemon to revive.
   */
  async withRun(request: () => Promise<unknown>): Promise<void> {
    const { socket, ready } = this.follow();
    if (!(await ready)) throw (await socket.ended)?.error ?? new Error('Execution stream closed before connecting');
    this.runEnded?.('superseded');
    const ended = new Promise<RunEnd>((resolve) => { this.runEnded = resolve; });
    const waiter = this.runEnded;
    this.runs += 1;
    try {
      try {
        await request();
      } catch (err) {
        if (this.runEnded === waiter) this.runEnded = null;
        throw err;
      }
      if (await ended === 'lost') this.deps.dispatch({ type: 'executionLost', sessionId: this.sessionId });
    } finally {
      this.runs -= 1;
      if (this.runs === 0 && this.links.shown !== this) this.disconnect();
    }
  }

  /**
   * Stops following the session and forgets what its stream delivered, for a
   * session the TUI let go of: a reconnect would open a socket on nothing, and
   * a long-lived TUI browsing `/sessions` would keep every session's dedupe
   * state. A run still waited on keeps its socket until it settles.
   */
  close(): void {
    this.cancelRetry();
    if (this.links.shown === this) {
      this.links.shown = null;
      this.links.backoff.reset();
    }
    if (this.links.sessions.get(this.sessionId) === this) this.links.sessions.delete(this.sessionId);
    if (this.runs === 0) this.disconnect();
  }

  private follow(): Attempt {
    const previous = this.links.shown;
    if (previous !== this) {
      previous?.leave();
      this.links.shown = this;
    }
    if (!this.attempt) {
      this.cancelRetry();
      this.open(false);
    }
    return this.attempt!;
  }

  /** Another session is on screen now. */
  private leave(): void {
    this.cancelRetry();
    if (this.runs === 0) this.disconnect();
  }

  private open(restored: boolean): void {
    const socket = this.deps.api.followSession(this.sessionId, (event) => {
      this.receiver.receive(event);
      if ((event.type === 'execution_complete' || event.type === 'execution_stopped') && this.runEnded) this.endRun('ended');
    });
    const attempt: Attempt = {
      socket,
      ready: socket.ready.then((opened) => {
        if (opened) {
          this.links.backoff.reset();
          // A turn whose reply was lost has no `planner_turn_ended` to settle
          // it; a reconnect is the moment the session can be read back for its end.
          if (restored) this.deps.dispatch({ type: 'followRestored', sessionId: this.sessionId });
        }
        return opened;
      }),
    };
    this.attempt = attempt;
    void socket.ended.then((end) => {
      if (this.attempt === attempt && end !== null) this.lost();
    });
  }

  /**
   * The daemon dropped the socket. The session on screen must keep following
   * it — a run started by the daemon's own timer or by another client
   * broadcasts to sockets only, so an idle TUI that gave up would never see
   * it — so it reconnects, backing off while the daemon stays down.
   */
  private lost(): void {
    this.attempt = null;
    if (this.runEnded) this.endRun('lost');
    if (this.links.shown !== this) return;
    const first = this.links.backoff.failed === 0;
    // One notice per outage: a daemon that stays down would otherwise add a
    // line every backoff interval. A run waited on says so itself when it goes
    // with the daemon; two notices for one loss is noise.
    if (first && this.runs === 0) this.deps.dispatch({ type: 'followLost', sessionId: this.sessionId });
    this.timer = retryAfter(this.links.backoff, () => {
      this.timer = null;
      // A send, a load or a new session opened one meanwhile: that follow owns the screen now.
      if (this.links.shown === this && !this.attempt) this.open(true);
    });
  }

  private endRun(how: RunEnd): void {
    const ended = this.runEnded;
    this.runEnded = null;
    ended?.(how);
  }

  private disconnect(): void {
    const attempt = this.attempt;
    this.attempt = null;
    attempt?.socket.close();
  }

  private cancelRetry(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

const WENT_WITH_ITS_ROOT = 'The session above this plan closed, so this plan closed with it.';
const NO_LONGER_LISTED = 'That plan is no longer in this session.';

/**
 * Follows one child plan on screen. The plans on screen hold one socket each,
 * not one shown link: a plan a person went down from keeps its socket, so Esc
 * lands on one that kept up.
 */
export async function openChildLink(deps: LinkDeps, rootId: string, childId: string): Promise<void> {
  const links = linksOf(deps.api);
  if (links.children.has(childId)) return;
  const link = new ChildLink(links, deps, rootId, childId);
  links.children.set(childId, link);
  await link.connect();
}

export function closeChildLink(api: object, childId: string): void {
  registries.get(api)?.children.get(childId)?.close();
}

class ChildLink {
  private readonly inbound: SessionInbound;
  private socket: SessionSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly backoff = new ReconnectBackoff();

  constructor(private readonly links: Links, private readonly deps: LinkDeps, private readonly rootId: string, private readonly childId: string) {
    this.inbound = createInbound(deps.dispatch, childId);
  }

  /**
   * Socket first, then the read, as `loadSession` orders them: nothing the plan
   * does between the two is missed, and the read lands before any frame after it.
   */
  async connect(): Promise<void> {
    const { api, dispatch } = this.deps;
    const { rootId, childId, inbound } = this;
    const socket = api.followChild(rootId, childId, (event) => inbound.receive(event));
    this.socket = socket;
    void socket.ended.then((end) => this.ended(end)).catch(() => {});
    try {
      await inbound.openFrom(async () => {
        // A socket that never opened has nothing to follow: its close asks again.
        if (!(await socket.ready)) return { apply: () => {} };
        const view = await api.getChild(rootId, childId);
        return {
          position: view.position,
          apply: () => {
            if (this.closed) return;
            dispatch({ type: 'childOpened', sessionId: childId, view });
            this.backoff.reset();
          },
        };
      });
    } catch (err) {
      if (this.closed || this.socket !== socket) return;
      if (err instanceof DaemonError && err.code === 'child_not_found') {
        this.gone(NO_LONGER_LISTED);
        return;
      }
      // An open socket never asks again, and its frames would land on a plan
      // missing what this read held. `followLost` is said once by the reducer,
      // and the close that led here may not have said it at all.
      socket.close();
      dispatch({ type: 'followLost', sessionId: childId });
      this.retry();
      throw err;
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    if (this.links.children.get(this.childId) === this) this.links.children.delete(this.childId);
  }

  /**
   * What each close asks for. 4404 is an unknown child or a root the daemon has
   * not loaded, which only a read tells apart: the client's read loads the root.
   */
  private async ended(end: SocketEnd | null): Promise<void> {
    if (this.closed || end === null) return;
    if (end.code === 1001) {
      this.gone(WENT_WITH_ITS_ROOT);
      return;
    }
    if (end.code === 4404) {
      const read = await this.deps.api.getChild(this.rootId, this.childId).then(() => 'there' as const, (err: unknown) => err);
      if (read instanceof DaemonError && read.code === 'child_not_found') {
        this.gone(NO_LONGER_LISTED);
        return;
      }
    } else if (end.code !== 1012 && this.backoff.failed === 0) {
      // One notice per outage, as a session's link does. A replaced root is back at once.
      this.deps.dispatch({ type: 'followLost', sessionId: this.childId });
    }
    if (!this.closed) this.retry();
  }

  private gone(message: string): void {
    this.close();
    this.deps.dispatch({ type: 'childGone', sessionId: this.childId, message });
  }

  private retry(): void {
    // A failed read and its socket's close can both ask, and one link holds one socket.
    if (this.timer) return;
    this.timer = retryAfter(this.backoff, () => {
      this.timer = null;
      if (!this.closed) void this.connect().catch(() => {});
    });
  }
}
