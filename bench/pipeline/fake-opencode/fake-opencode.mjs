#!/usr/bin/env node
/**
 * A deterministic stand-in for `opencode serve`: no model, no API key.
 *
 * It speaks the 1.x HTTP surface Ordewell's `OpenCodeAdapter` drives as far as
 * the adapter reads it — `/session`, `/session/:id/prompt_async`, `/event`,
 * `/session/status` — and completes tasks the way a real agent does: by calling
 * `task_complete` on the Ordewell MCP server named in `OPENCODE_CONFIG_CONTENT`.
 *
 * A task steers it with a cue in its prompt:
 *   <fake-opencode>{"delayMs":300,"write":{"A.txt":"hello"},"status":"blocked","reason":"why"}</fake-opencode>
 * Every field is optional:
 *   delayMs     work time before the file writes and the completion call
 *   write       files to create under the cwd, name -> contents
 *   status      done (default) | blocked | failed, as passed to task_complete
 *   reason      the reason handed to task_complete for blocked or failed
 *   summary     the summary handed to task_complete
 *   noComplete  end the turn without calling task_complete
 *   crash       exit non-zero before completing
 *   calls       tool calls made on the Ordewell server before the file writes, each `[tool, arguments]`
 *
 * Sessions are named after `$HOME`, so a Continue in a kept volume resumes the
 * id a previous process made.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CUE = /<fake-opencode>([\s\S]*?)<\/fake-opencode>/;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const cwd = process.cwd();
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const wantedPort = Number(flag('--port') ?? 0) || 0;

const sessions = new Set();
const streams = new Set();
const busy = new Set();
const messages = new Map();
const stateFile = path.join(process.env.HOME ?? cwd, '.fake-opencode-sessions');
try {
  for (const id of fs.readFileSync(stateFile, 'utf8').split('\n')) if (id) sessions.add(id);
} catch { /* no previous process */ }

const json = (res, status, body) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

function frame(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of streams) res.write(line);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function readCue(text) {
  const match = CUE.exec(text ?? '');
  if (!match) return {};
  try { return JSON.parse(match[1]); } catch { return {}; }
}

function writeFile(name, contents) {
  const target = path.resolve(cwd, name);
  if (target !== cwd && !target.startsWith(cwd + path.sep)) throw new Error(`cue writes outside the workspace: ${name}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/** The Ordewell server the adapter injected, and the bearer it gave. */
function mcpServer() {
  let config;
  try { config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}'); } catch { return null; }
  const server = config?.mcp?.ordewell;
  return server?.url ? server : null;
}

async function post(server, body, extraHeaders = {}) {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...server.headers, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ordewell MCP server answered ${res.status}: ${text}`);
  if (body.id === undefined) return null;
  const payloads = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(text)];
  const answer = payloads.find((payload) => payload.id === body.id);
  if (!answer) throw new Error(`no answer to ${body.method} in: ${text}`);
  if (answer.error) throw new Error(`${body.method} failed: ${answer.error.message}`);
  return answer.result;
}

async function callTool(server, name, args) {
  const init = await post(server, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'fake-opencode', version: '1' } },
  });
  const headers = { 'mcp-protocol-version': init.protocolVersion ?? MCP_PROTOCOL_VERSION };
  await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  const result = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, headers);
  return { text: (result.content ?? []).map((part) => part.text ?? '').join('\n'), isError: result.isError === true };
}

function assistant(session, text, parts = []) {
  const id = `msg_${randomUUID()}`;
  const info = { id, sessionID: session, role: 'assistant', time: { created: Date.now() }, providerID: 'fake', modelID: 'fake-opencode' };
  frame({ type: 'message.updated', properties: { sessionID: session, info } });
  const all = [];
  if (text) all.push({ id: `prt_${randomUUID()}`, sessionID: session, messageID: id, type: 'text', text, time: { start: Date.now(), end: Date.now() } });
  for (const part of parts) all.push({ id: `prt_${randomUUID()}`, sessionID: session, messageID: id, ...part });
  for (const part of all) frame({ type: 'message.part.updated', properties: { sessionID: session, part } });
  return id;
}

function toolPart(session, name, input, output, failed = false) {
  return { type: 'tool', tool: name, callID: `call_${randomUUID()}`, state: { status: failed ? 'error' : 'completed', input, output } };
}

async function runTurn(session, text, signal) {
  const cue = readCue(text);
  frame({ type: 'message.updated', properties: { sessionID: session, info: { id: `msg_${randomUUID()}`, sessionID: session, role: 'user', time: { created: Date.now() } } } });
  busy.add(session);
  frame({ type: 'session.status', properties: { sessionID: session, status: { type: 'busy' } } });
  if (cue.delayMs) await sleep(cue.delayMs);
  if (signal.aborted) return;
  if (cue.crash) process.exit(1);

  const parts = [];
  const server = mcpServer();
  for (const [name, args] of cue.calls ?? []) {
    if (!server) break;
    const reply = await callTool(server, name, args);
    parts.push(toolPart(session, name, args, reply.text, reply.isError));
  }
  for (const [name, contents] of Object.entries(cue.write ?? { 'fake-opencode-output.txt': `fake-opencode output for ${session}\n` })) {
    writeFile(name, contents);
    parts.push(toolPart(session, 'write', { filePath: path.resolve(cwd, name) }, `Wrote ${name}`));
  }
  // Where OpenCode keeps its logins, which a lease copies into the task's own volume: a task reads its copy, and a write it makes stays there.
  const store = path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? cwd, '.local', 'share'), 'opencode', 'auth.json');
  if (cue.readSignIn) {
    writeFile('sign-in-read.txt', fs.readFileSync(store, 'utf8'));
    parts.push(toolPart(session, 'read', { filePath: store }, 'read the sign-in copy'));
  }
  if (cue.forgeSignIn) {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, 'forged');
    parts.push(toolPart(session, 'write', { filePath: store }, 'forged the sign-in copy'));
  }
  if (server && !cue.noComplete) {
    const status = cue.status ?? 'done';
    const args = { status, summary: cue.summary ?? `fake-opencode finished (${status})`, ...(cue.reason ? { reason: cue.reason } : {}) };
    const reply = await callTool(server, 'task_complete', args);
    parts.push(toolPart(session, 'ordewell_task_complete', args, reply.text, reply.isError));
  }
  assistant(session, 'All done.', parts);
}

async function prompt(session, body) {
  const text = (body.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
  const controller = new AbortController();
  aborters.set(session, controller);
  try {
    await runTurn(session, text, controller.signal);
  } catch (error) {
    frame({ type: 'session.error', properties: { sessionID: session, error: { name: 'FakeError', data: { message: error instanceof Error ? error.message : String(error) } } } });
  } finally {
    aborters.delete(session);
    busy.delete(session);
    frame({ type: 'session.status', properties: { sessionID: session, status: { type: 'idle' } } });
  }
}

const aborters = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake');
  const pathname = url.pathname;
  if (pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  if (pathname === '/api/info') return json(res, 404, { error: 'not the 2.x API' });
  if (pathname === '/session' && req.method === 'POST') {
    const id = `ses_${randomUUID()}`;
    sessions.add(id);
    try { fs.appendFileSync(stateFile, `${id}\n`); } catch { /* a read-only home still runs one attempt */ }
    return json(res, 200, { id });
  }
  if (pathname === '/session/status') {
    return json(res, 200, Object.fromEntries([...busy].map((id) => [id, { type: 'busy' }])));
  }
  const one = /^\/session\/([^/]+)(\/.*)?$/.exec(pathname);
  if (one) {
    const [, id, rest = ''] = one;
    if (rest === '' && req.method === 'GET') return sessions.has(id) ? json(res, 200, { id }) : json(res, 404, { error: 'no such session' });
    if (rest === '/message' && req.method === 'GET') return json(res, 200, messages.get(id) ?? []);
    if (rest === '/prompt_async' && req.method === 'POST') {
      const body = await readBody(req);
      void prompt(id, body);
      return json(res, 204);
    }
    if (rest === '/abort' && req.method === 'POST') {
      aborters.get(id)?.abort();
      return json(res, 200, true);
    }
  }
  if (pathname === '/command' || pathname === '/skill') return json(res, 200, []);
  if (pathname === '/mcp') return json(res, 200, { ordewell: { status: 'connected' } });
  return json(res, 200, true);
});

server.listen(wantedPort, '127.0.0.1', () => {
  process.stdout.write(`opencode server listening on http://127.0.0.1:${server.address().port}\n`);
});
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
