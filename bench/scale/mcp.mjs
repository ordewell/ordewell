/** The real MCP server on connections a load process holds, without a listening port. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { core } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1:9';

/**
 * The server as it is but for its listener: `listen` is what a sealed run is
 * refused, so its HTTP server is built the same way and fed connections
 * through `emit('connection')`. Everything past the socket is the real path.
 */
export function mcpServerWithoutPort() {
  const server = new core.OrdewellMcpServer();
  const http = createServer((req, res) => {
    server.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end('Internal error');
      else res.destroy();
    });
  });
  // These connections are opened ahead and cannot be opened again, where a real
  // runner connects as it needs to: none may be timed out for sitting idle.
  http.keepAliveTimeout = 0;
  http.headersTimeout = 0;
  http.requestTimeout = 0;
  http.emit('listening');
  server.http = http;
  server.boundHost = HOST;
  server.boundUrl = `http://${HOST}/mcp`;
  server.listening = Promise.resolve(server.boundUrl);
  return server;
}

/** Load processes over `connections` socketpairs. One process is one core of client. */
export class LoadGen {
  latencies = { attach: [], complete: [], list: [] };
  failures = 0;
  children = [];
  pending = new Map();
  sequence = 0;

  constructor(server, connections, processes = 4) {
    const { http } = server;
    const share = Math.ceil(connections / processes);
    for (let p = 0; p < processes && p * share < connections; p += 1) {
      const fds = Math.min(share, connections - p * share);
      const child = spawn(process.execPath, [path.join(here, 'loadgen.mjs'), HOST, String(fds)], {
        stdio: ['pipe', 'pipe', 'inherit', ...Array.from({ length: fds }, () => 'pipe')],
      });
      for (let i = 0; i < fds; i += 1) http.emit('connection', child.stdio[3 + i]);
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const answer = JSON.parse(line);
        const job = this.pending.get(answer.id);
        this.pending.delete(answer.id);
        if (!answer.ok) {
          this.failures += 1;
          this.firstFailure ??= answer.text;
        }
        job.resolve(answer);
      });
      this.children.push(child);
    }
  }

  send(job) {
    const id = (this.sequence += 1);
    const child = this.children[id % this.children.length];
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      child.stdin.write(`${JSON.stringify({ id, ...job })}\n`);
    }).then((answer) => {
      this.latencies[job.kind]?.push(answer.ms);
      return answer;
    });
  }

  attach(url, headers) {
    return this.send({ kind: 'attach', path: new URL(url).pathname, headers });
  }

  complete(url, headers, args) {
    return this.send({ kind: 'complete', path: new URL(url).pathname, headers, args });
  }

  stop() {
    for (const child of this.children) child.stdin.end();
  }
}

export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
