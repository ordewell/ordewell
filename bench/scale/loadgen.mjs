#!/usr/bin/env node
/**
 * The runners' side of the MCP server, in its own process so a client's work
 * is not on the daemon's event loop. It reaches the server over socketpairs
 * the daemon handed it as stdio (fd 3 up), which cross the kernel as a real
 * runner's connection does and need no listening port, so this runs sealed.
 * Jobs come in on stdin and answers go out on stdout, a JSON line each.
 */
import http from 'node:http';
import net from 'node:net';
import readline from 'node:readline';

const [host, count] = [process.argv[2], Number(process.argv[3])];
const sockets = Array.from({ length: count }, (_, i) => new net.Socket({ fd: 3 + i, readable: true, writable: true }));

class Pool extends http.Agent {
  createConnection() { return sockets.pop(); }
}
const agent = new Pool({ keepAlive: true, maxSockets: count, maxFreeSockets: count });

function post(path, headers, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request({ agent, host, path, method: 'POST', setHost: true, headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(text), ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'loadgen', version: '1' } } };
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const VERSION = { 'mcp-protocol-version': '2025-06-18' };

async function run(job) {
  const headers = { ...job.headers, ...VERSION };
  const t = performance.now();
  if (job.kind === 'attach') {
    await post(job.path, job.headers, INITIALIZE);
    await post(job.path, headers, INITIALIZED);
  }
  if (job.kind === 'attach' || job.kind === 'list') {
    const list = await post(job.path, headers, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    return { ok: list.status === 200, bytes: list.data.length, ms: performance.now() - t };
  }
  const reply = await post(job.path, headers, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task_complete', arguments: job.args } });
  const line = reply.data.split('\n').find((l) => l.startsWith('data:'));
  const answer = line ? JSON.parse(line.slice(5)) : JSON.parse(reply.data);
  return { ok: reply.status === 200 && !answer.error, text: (answer.result?.content ?? []).map((b) => b.text).join('\n'), bytes: reply.data.length, ms: performance.now() - t };
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const job = JSON.parse(line);
  run(job).then((answer) => process.stdout.write(`${JSON.stringify({ id: job.id, ...answer })}\n`), (err) => process.stdout.write(`${JSON.stringify({ id: job.id, ok: false, text: String(err), ms: 0 })}\n`));
});
process.stdin.on('end', () => process.exit(0));
// The daemon is gone: what was still on its way has nobody to read it.
process.stdout.on('error', () => process.exit(0));
