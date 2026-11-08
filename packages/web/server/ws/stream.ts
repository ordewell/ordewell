import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { DAEMON_SUBPROTOCOL, type RunSnapshotFrame, type SessionFrame } from '@ordewell/core';
import { OrchestratorPool } from '../pool/orchestratorPool';

const CHILD_PATH = /^\/ws\/session\/([^/]+)\/child\/([^/]+)$/;

/** One id from the path, as a client encodes it (`/`, `?` and `#` cannot travel raw); undefined for a malformed escape. */
function idOf(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Nothing is sent before the tree has named the child, so a stray id learns only that it was refused. */
function joinChild(pool: OrchestratorPool, ws: WebSocket, rootId: string, childId: string, workspace: string | undefined): void {
  const leave = () => pool.unwatchChild(rootId, childId, ws);
  ws.on('close', leave);
  ws.on('error', leave);
  const refuse = () => ws.close(4404, 'No such child plan in this tree');
  void pool.watchChild(rootId, childId, ws, workspace).then((watching) => { if (!watching) refuse(); }, refuse);
}

export function createWsHandler(pool: OrchestratorPool) {
  const wss = new WebSocketServer({
    noServer: true,
    // Select the plain subprotocol explicitly. Left to itself `ws` echoes back
    // whichever was offered first, which would put the token in the 101
    // response; selecting nothing makes the client fail the handshake.
    handleProtocols: (protocols) => (protocols.has(DAEMON_SUBPROTOCOL) ? DAEMON_SUBPROTOCOL : false),
  });

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    const malformed = () => ws.close(4400, 'Malformed id in the socket path');
    // A socket naming its workspace hears only that workspace's session: the
    // pool keeps one per id, so another project's copy of the id would hear
    // this one's run. Refused here while another holds the id, and by the pool
    // when another takes it later.
    const workspace = url.searchParams.get('workspace') || undefined;
    const elsewhere = (id: string) => {
      if (workspace === undefined) return false;
      try {
        pool.live(id, workspace);
        return false;
      } catch {
        ws.close(4409, 'Session open for another workspace');
        return true;
      }
    };
    const child = CHILD_PATH.exec(url.pathname);
    if (child) {
      const rootId = idOf(child[1]);
      const childId = idOf(child[2]);
      if (rootId === undefined || childId === undefined) return malformed();
      if (elsewhere(rootId)) return;
      joinChild(pool, ws, rootId, childId, workspace);
      return;
    }
    const sessionId = idOf(url.pathname.split('/').pop() || '');
    if (sessionId === undefined) return malformed();
    if (elsewhere(sessionId)) return;

    ws.on('close', () => {
      pool.unsubscribe(sessionId, ws);
    });

    ws.on('error', () => {
      pool.unsubscribe(sessionId, ws);
    });

    ws.send(JSON.stringify({ type: 'connected', sessionId }));
    // The stream reports changes only. Taken and subscribed in one turn, so no
    // broadcast can fall between the snapshot and the first message after it.
    const view = pool.runSnapshot(sessionId);
    if (view) {
      ws.send(JSON.stringify({
        type: 'run_snapshot', sessionId, view, approvals: pool.announcedApprovals(sessionId), ...pool.streamPosition(sessionId),
      } satisfies RunSnapshotFrame));
    }
    // A compaction has no turn id to adopt, so a client joining mid-way would
    // not know the planner is busy. Unstamped: the client's fold is idempotent
    // by the compaction's id, and a stamp would let it count this as the
    // broadcast it already holds.
    const compaction = pool.plannerCompaction(sessionId);
    if (compaction) ws.send(JSON.stringify(compaction satisfies SessionFrame));
    // Nor has a turn at the planner gate, which no planner has heard of yet.
    const detection = pool.plannerDetection(sessionId);
    if (detection?.waiting) ws.send(JSON.stringify(detection satisfies SessionFrame));
    // Subscribing also greets with host-owned account limits, independently
    // of the run snapshot above, even when the host knows none yet.
    pool.subscribe(sessionId, ws, workspace);
  });

  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };
}
