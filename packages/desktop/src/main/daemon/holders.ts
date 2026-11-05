import type { DaemonProbe, SessionLeaseRecord } from '@ordewell/core/daemon-client';
import type { DaemonCallResult, HolderView, JoinResult, StreamEvent } from '../../shared/bridge';
import type { DaemonRequest } from '../../shared/routes';

/** What a joined session's calls and socket go through: a {@link DaemonProxy} at the holder's port. */
export interface HolderProxy {
  call(request: DaemonRequest): Promise<DaemonCallResult>;
  stream(path: string, onEvent: (event: StreamEvent) => void): () => void;
}

export interface HolderDeps {
  /** The daemon contract this app speaks (ADR-0060 H3). */
  contract: number;
  /** The app's own daemon, which never needs joining. */
  ownPort(): number;
  /** The live holder of a session, from its lease file; null when none holds it. */
  readHolder(sessionId: string, workspace: string): SessionLeaseRecord | null;
  readToken(port: number): string | undefined;
  probe(port: number): Promise<DaemonProbe>;
  /** A proxy at `port` that reads `token` at each call, as a restarted daemon mints a new one. */
  connect(port: number, token: () => string | undefined): HolderProxy;
}

interface Connection {
  proxy: HolderProxy;
  /** The joins using it, as `owner\0sessionId`. */
  users: Set<string>;
  /** Every socket opened through it and not yet closed. */
  streams: Set<() => void>;
}

const joinKey = (owner: number, sessionId: string): string => `${owner}\0${sessionId}`;

function holderName(record: SessionLeaseRecord, port: number): string {
  return record.host?.kind === 'daemon' && record.host.ownerPid !== undefined ? "The TUI's daemon" : `The daemon on :${port}`;
}

/**
 * The desktop app's connections to the daemons that hold sessions it shows
 * (ADR-0060 H8). A session another Ordewell daemon holds is joined, not taken:
 * that daemon stays its one live host (ADR-0049) and the app is one more of
 * its clients, as the TUI that started it is.
 *
 * Main decides what to join from the lease file, never from a port the page
 * names, and presents the holder's token itself, so the renderer sees neither.
 * A daemon is joined only once it proves it is the lease's own process and
 * speaks this app's contract. One connection serves every window and session
 * held by that daemon, and closes, with its sockets, when the last leaves.
 */
export class HolderConnections {
  private readonly byPort = new Map<number, Connection>();
  private readonly joins = new Map<string, number>();

  constructor(private readonly deps: HolderDeps) {}

  async join(owner: number, workspace: string, sessionId: string): Promise<JoinResult> {
    const record = this.deps.readHolder(sessionId, workspace);
    if (!record) return { ok: false, reason: 'free', message: 'Nothing holds this session now.' };
    const host = record.host;
    if (host?.kind === 'vscode') {
      return { ok: false, reason: 'vscode', message: "VS Code runs this session inside its own window, so the app can't join it." };
    }
    if (!host) {
      return { ok: false, reason: 'no-host', message: `Held by an older Ordewell process (pid ${record.pid}) that doesn't say how to reach it.` };
    }
    const { port } = host;
    if (port === this.deps.ownPort()) return { ok: false, reason: 'own', message: "This app's own daemon holds the session." };
    const tokenless = { ok: false, reason: 'token', message: `Can't read the token of the daemon on :${port}.` } as const;
    if (this.deps.readToken(port) === undefined) return tokenless;

    const probe = await this.deps.probe(port);
    if (probe.kind === 'unauthorized') return tokenless;
    if (probe.kind === 'unverifiable') {
      // Before /api/server a daemon could not name itself: joining it would
      // drive a contract nobody checked.
      const who = host.ownerPid !== undefined ? "The TUI's daemon" : 'The daemon';
      return { ok: false, reason: 'mismatch', message: `${who} on :${port} can't say which Ordewell it is, likely an older version, so the app can't join it.` };
    }
    if (probe.kind !== 'daemon' || probe.identity.pid !== record.pid) {
      return { ok: false, reason: 'unreachable', message: `The daemon that holds this session no longer answers on :${port}.` };
    }
    const { version, contract } = probe.identity;
    if (contract !== this.deps.contract) {
      const speaks = `${version ?? 'an older version'} (contract ${contract ?? 'unknown'})`;
      return {
        ok: false,
        reason: 'mismatch',
        message: `${holderName(record, port)} is ${speaks}; this app speaks contract ${this.deps.contract}, so it can't join.`,
      };
    }

    const key = joinKey(owner, sessionId);
    const previous = this.joins.get(key);
    if (previous !== undefined && previous !== port) this.leave(owner, sessionId);
    let connection = this.byPort.get(port);
    if (!connection) {
      connection = { proxy: this.deps.connect(port, () => this.deps.readToken(port)), users: new Set(), streams: new Set() };
      this.byPort.set(port, connection);
    }
    connection.users.add(key);
    this.joins.set(key, port);
    const holder: HolderView = {
      port,
      pid: record.pid,
      ...(host.ownerPid !== undefined ? { ownerPid: host.ownerPid } : {}),
      ...(version !== undefined ? { version } : {}),
      contract,
      since: record.since,
    };
    return { ok: true, holder };
  }

  /** The holder's proxy for a session this window joined; undefined sends it to the app's own daemon. */
  route(owner: number, sessionId: string | undefined): HolderProxy | undefined {
    if (sessionId === undefined) return undefined;
    const port = this.joins.get(joinKey(owner, sessionId));
    const connection = port === undefined ? undefined : this.byPort.get(port);
    if (!connection) return undefined;
    return {
      call: (request) => connection.proxy.call(request),
      stream: (path, onEvent) => {
        let open = true;
        const closeSocket = connection.proxy.stream(path, (event) => {
          if (event.kind === 'closed') forget();
          onEvent(event);
        });
        const forget = (): void => { open = false; connection.streams.delete(close); };
        const close = (): void => {
          if (!open) return;
          forget();
          closeSocket();
        };
        connection.streams.add(close);
        return close;
      },
    };
  }

  leave(owner: number, sessionId: string): void {
    const key = joinKey(owner, sessionId);
    const port = this.joins.get(key);
    if (port === undefined) return;
    this.joins.delete(key);
    const connection = this.byPort.get(port);
    if (!connection) return;
    connection.users.delete(key);
    if (connection.users.size > 0) return;
    this.byPort.delete(port);
    for (const close of [...connection.streams]) close();
  }

  /** A window that closes or navigates away leaves every session it joined. */
  leaveAll(owner: number): void {
    const prefix = `${owner}\0`;
    for (const key of [...this.joins.keys()]) {
      if (key.startsWith(prefix)) this.leave(owner, key.slice(prefix.length));
    }
  }
}
