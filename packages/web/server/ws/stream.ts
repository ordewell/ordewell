import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { OrchestratorPool } from '../pool/orchestratorPool';

export function createWsHandler(pool: OrchestratorPool) {
  const wss = new WebSocketServer({ noServer: true });

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
    // Subscribe after 'connected' so the chat-backlog replay arrives in order.
    pool.subscribe(sessionId, ws);
  });

  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };
}
