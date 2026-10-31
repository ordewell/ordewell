import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { DAEMON_SUBPROTOCOL, type RunSnapshotFrame, type SessionFrame } from '@ordewell/core';
import { OrchestratorPool } from '../pool/orchestratorPool';

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
    const sessionId = url.pathname.split('/').pop() || '';

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
    pool.subscribe(sessionId, ws);
  });

  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };
}
