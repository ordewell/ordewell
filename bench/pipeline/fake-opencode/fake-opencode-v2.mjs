#!/usr/bin/env node
/*
 * A fake OpenCode 2.x `serve`, for the login-backed research agent
 * (ADR-0066). It speaks the slice of the 2.x HTTP API Ordewell's research
 * runner uses, and models the one rule that decides what a session is offered,
 * as v2.2.7 does it: a tool is dropped when the last permission rule whose
 * action matches it denies resource "*" (tool.ts `whollyDisabled`); agent
 * (config) rules come first, session rules last (session/context.ts).
 *
 * The "model" is a cue in the brief: <fake-opencode>{...}</fake-opencode> with
 *   steps: [{ calls: [{ name, args }] }]  tool calls, one step each
 *   text: the final answer;  delayMs: wait before answering;
 *   usage: { input, output } per step;  child: true starts a child session;
 *   fail: { type, message } ends the run with session.execution.failed.
 *
 * An interrupt first fails the step in flight, if any, with session.step.failed
 * { type: MessageAbortedError, message: "Step interrupted" }, as v2.2.7 records an
 * interrupted step, then sends session.execution.interrupted.
 *
 * A call with hang: true delegates to a child session and never returns: an
 * interrupt fails that call (session.tool.failed, MessageAbortedError), as v2.2.7
 * does the parent's delegating call, before session.execution.interrupted.
 *
 * An untitled session's first prompt makes the hidden title call v2.2.7 makes:
 * its usage arrives only as a session.usage.recorded frame with source "title"
 * (no step carries it). A session created with a title makes no such call.
 *
 * What the serve loaded beyond Ordewell's config, for the pre-use check to
 * find: FAKE_OPENCODE_EXTRA_RULE (a permission rule, JSON), FAKE_OPENCODE_EXTRA_MCP
 * (a server name) and FAKE_OPENCODE_EXTRA_PLUGIN (a package name).
 * FAKE_OPENCODE_VERSION is what `--version` and /api/info report;
 * FAKE_OPENCODE_EXIT=1 exits before listening.
 *
 * Test-only routes: GET /api/fake/offered/:id, GET /api/fake/ran, GET /api/fake/env, GET /api/fake/sessions.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const VERSION = process.env.FAKE_OPENCODE_VERSION || '2.2.7';
if (process.argv.includes('--version')) { process.stdout.write(`${VERSION}\n`); process.exit(0); }
if (process.env.FAKE_OPENCODE_EXIT) { process.stderr.write('fake opencode: refusing to start\n'); process.exit(1); }
const extra = (name) => { try { return process.env[name] ? JSON.parse(process.env[name]) : undefined; } catch { return process.env[name]; } };
const BUILT_INS = ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'webfetch', 'websearch', 'question', 'execute', 'subagent', 'skill',
  'opencode_session_rename', 'opencode_session_move', 'opencode_worktree_create', 'opencode_worktree_list', 'opencode_worktree_remove', 'opencode_models'];

const config = (() => { try { return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}'); } catch { return {}; } })();
const legacyRules = Object.entries(typeof config.permission === 'string' ? { '*': config.permission } : config.permission ?? {})
  .map(([action, effect]) => ({ action, resource: '*', effect }));
const extraRule = extra('FAKE_OPENCODE_EXTRA_RULE');
// As Config.Entry[]: a document a user or integration layer would add, then Ordewell's OPENCODE_CONFIG_CONTENT.
const entries = [
  ...(extraRule ? [{ type: 'document', path: '/etc/opencode/opencode.json', info: { permissions: [extraRule] } }] : []),
  { type: 'document', info: { ...config, ...(legacyRules.length ? { permissions: [...legacyRules, ...(config.permissions ?? [])] } : {}) } },
];
const configRules = entries.flatMap((entry) => entry.info.permissions ?? []);
const servers = new Map(Object.entries(config.mcp ?? {}));
if (process.env.FAKE_OPENCODE_EXTRA_MCP) servers.set(process.env.FAKE_OPENCODE_EXTRA_MCP, { type: 'remote', url: 'http://127.0.0.1:9/mcp', enabled: false });
const plugins = [{ id: 'opencode', source: { type: 'builtin' }, features: { server: true }, state: { status: 'active' } },
  ...(process.env.FAKE_OPENCODE_EXTRA_PLUGIN ? [{ source: { type: 'package', target: process.env.FAKE_OPENCODE_EXTRA_PLUGIN }, features: { server: true }, state: { status: 'active' } }] : [])];
const sessions = new Map();
const streams = new Set();
const ran = [];
// Real OpenCode 2.x ignores OPENCODE_SERVER_USERNAME and accepts only `opencode` (checked on 2.2.5).
const auth = process.env.OPENCODE_SERVER_PASSWORD
  ? `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` : null;

const glob = (pattern, value) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);
const whollyDisabled = (rules, tool) => { const last = rules.findLast((r) => glob(r.action, tool)); return !!last && last.resource === '*' && last.effect === 'deny'; };
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const frame = (type, data) => { for (const s of streams) s.write(`data: ${JSON.stringify({ type, data })}\n\n`); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });

async function post(server, body, extra = {}) {
  const res = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...server.headers, ...extra }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP server answered ${res.status}: ${text}`);
  if (body.id === undefined) return null;
  const payloads = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))) : [JSON.parse(text)];
  const answer = payloads.find((p) => p.id === body.id);
  if (answer?.error) throw new Error(answer.error.message);
  return answer?.result;
}
async function mcp(server, method, params) {
  const init = await post(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'fake-opencode-v2', version: '1' } } });
  const headers = { 'mcp-protocol-version': init.protocolVersion ?? MCP_PROTOCOL_VERSION };
  await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  return post(server, { jsonrpc: '2.0', id: 2, method, params }, headers);
}

async function offered(session) {
  const rules = [...configRules, ...session.permissions];
  const names = [...BUILT_INS];
  for (const [name, server] of servers) {
    if (server.enabled === false) continue;
    const listed = await mcp(server, 'tools/list', {}).catch(() => ({ tools: [] }));
    for (const tool of listed?.tools ?? []) names.push(`${name}_${tool.name}`);
  }
  return names.filter((tool) => !whollyDisabled(rules, tool));
}

async function run(session, text) {
  const cue = (() => { const m = /<fake-opencode>([\s\S]*?)<\/fake-opencode>/.exec(text); try { return m ? JSON.parse(m[1]) : {}; } catch { return {}; } })();
  const id = session.id;
  const stopped = () => session.interrupted;
  session.inFlight = undefined;
  frame('session.execution.started', { sessionID: id });
  if (cue.fail) {
    const message = `msg_${randomUUID()}`;
    frame('session.step.started', { sessionID: id, assistantMessageID: message, model: session.model ?? { providerID: 'fake', id: 'fake-model' } });
    frame('session.step.failed', { sessionID: id, assistantMessageID: message, error: cue.fail });
    frame('session.execution.failed', { sessionID: id, error: cue.fail });
    return;
  }
  if (cue.child) frame('session.created', { sessionID: `ses_${randomUUID()}`, parentID: id });
  if (!session.title && !session.titled) {
    session.titled = true;
    frame('session.usage.recorded', { sessionID: id, source: 'title', cost: 0.0004, tokens: { input: 900, output: 12, reasoning: 0, cache: { read: 0, write: 0 } } });
  }
  const tools = await offered(session);
  const steps = [...(cue.steps ?? []), { final: true }];
  for (const step of steps) {
    if (stopped()) return;
    const message = `msg_${randomUUID()}`;
    session.inFlight = message;
    frame('session.step.started', { sessionID: id, assistantMessageID: message, model: session.model ?? { providerID: 'fake', id: 'fake-model' } });
    for (const call of step.calls ?? []) {
      if (stopped()) return;
      const callId = `call_${randomUUID()}`;
      frame('session.tool.input.started', { sessionID: id, id: callId, name: call.name });
      if (!tools.includes(call.name)) {
        frame('session.tool.failed', { sessionID: id, id: callId, error: { message: `No tool named ${call.name} is currently available` } });
        continue;
      }
      frame('session.tool.called', { sessionID: id, id: callId, input: call.args ?? {} });
      if (call.hang) {
        const child = `ses_${randomUUID()}`;
        frame('session.created', { sessionID: child, parentID: id });
        frame('session.tool.progress', { sessionID: id, assistantMessageID: message, id: callId, metadata: { sessionID: child, status: 'running' } });
        session.hanging = callId;
        while (!stopped()) await delay(10);
        return;
      }
      const server = [...servers].find(([name]) => call.name.startsWith(`${name}_`));
      if (server) {
        const result = await mcp(server[1], 'tools/call', { name: call.name.slice(server[0].length + 1), arguments: call.args ?? {} })
          .catch((err) => ({ isError: true, content: [{ type: 'text', text: err.message }] }));
        ran.push({ session: id, tool: call.name, isError: result?.isError === true });
        const out = (result?.content ?? []).map((p) => p.text ?? '').join('');
        if (result?.isError) frame('session.tool.failed', { sessionID: id, id: callId, error: { message: out } });
        else frame('session.tool.success', { sessionID: id, id: callId, content: [{ type: 'text', text: out }] });
      } else {
        ran.push({ session: id, tool: call.name, builtIn: true });
        frame('session.tool.success', { sessionID: id, id: callId, content: [{ type: 'text', text: `${call.name} ran` }] });
      }
    }
    if (step.final && cue.delayMs) await delay(cue.delayMs);
    if (stopped()) return;
    const usage = cue.usage ?? { input: 10, output: 5 };
    if (step.final) {
      const answer = cue.text ?? 'done';
      session.messages.unshift({ id: message, type: 'assistant', content: [{ type: 'text', text: answer }] });
      frame('session.text.ended', { sessionID: id, assistantMessageID: message, ordinal: 0, text: answer });
    }
    session.inFlight = undefined;
    frame('session.step.ended', { sessionID: id, assistantMessageID: message, tokens: { input: usage.input, output: usage.output, reasoning: 0, cache: { read: 0, write: 0 } }, cost: usage.cost ?? 0.001 });
  }
  if (!stopped() && !cue.noEnd) frame('session.execution.succeeded', { sessionID: id });
}

const server = createServer(async (req, res) => {
  if (auth && req.headers.authorization !== auth) return json(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  let m;
  if (req.method === 'GET' && path === '/api/info') return json(res, 200, { version: VERSION, data: { version: VERSION } });
  if (req.method === 'GET' && path === '/api/config') return json(res, 200, entries);
  if (req.method === 'GET' && path === '/api/mcp') return json(res, 200, { location: {}, data: [...servers.keys()].map((name) => ({ name, status: { status: 'connected' } })) });
  if (req.method === 'GET' && path === '/api/plugin') return json(res, 200, { location: {}, data: plugins });
  if (req.method === 'GET' && path === '/api/fake/sessions') return json(res, 200, { sessions: [...sessions.values()].map((s) => ({ id: s.id, title: s.title, agent: s.agent, model: s.model })) });
  if (req.method === 'GET' && path === '/api/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': connected\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  if (req.method === 'GET' && path === '/api/fake/ran') return json(res, 200, { ran });
  if (req.method === 'GET' && path === '/api/fake/env') {
    return json(res, 200, { home: process.env.HOME, xdgData: process.env.XDG_DATA_HOME, xdgConfig: process.env.XDG_CONFIG_HOME, configDir: process.env.OPENCODE_CONFIG_DIR, noProject: process.env.OPENCODE_DISABLE_PROJECT_CONFIG, config, cwd: process.cwd(), xdgCache: process.env.XDG_CACHE_HOME, openCodeKeys: Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('OPENCODE_')).sort() });
  }
  if (req.method === 'GET' && (m = /^\/api\/fake\/offered\/([^/]+)$/.exec(path))) {
    const s = sessions.get(m[1]);
    return s ? json(res, 200, { tools: await offered(s) }) : json(res, 404, {});
  }
  if (req.method === 'PUT' && (m = /^\/api\/experimental\/mcp\/([^/]+)$/.exec(path))) {
    const body = await readBody(req);
    servers.set(m[1], { ...body.config, enabled: true });
    return json(res, 200, { data: true });
  }
  if (req.method === 'PUT' && /^\/api\/experimental\/session\/[^/]+\/instructions\/entries\/[^/]+$/.test(path)) { await readBody(req); return json(res, 200, { data: true }); }
  if (req.method === 'POST' && path === '/api/session') {
    const body = await readBody(req);
    const id = `ses_${randomUUID()}`;
    sessions.set(id, { id, title: body.title, permissions: body.permissions ?? [], model: body.model, agent: body.agent, messages: [], interrupted: false });
    frame('session.created', { sessionID: id });
    return json(res, 200, { data: { id, permissions: body.permissions ?? [] } });
  }
  if ((m = /^\/api\/session\/([^/]+)\/(prompt|interrupt|message)$/.exec(path))) {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, {});
    if (req.method === 'POST' && m[2] === 'prompt') {
      const body = await readBody(req);
      s.interrupted = false;
      json(res, 200, { data: true });
      run(s, body.text ?? '').catch((err) => frame('session.execution.failed', { sessionID: s.id, error: { message: String(err) } }));
      return;
    }
    if (req.method === 'POST' && m[2] === 'interrupt') {
      s.interrupted = true;
      if (s.hanging) frame('session.tool.failed', { sessionID: s.id, assistantMessageID: s.inFlight, id: s.hanging, error: { type: 'MessageAbortedError', message: 'Tool execution aborted' } });
      s.hanging = undefined;
      if (s.inFlight) frame('session.step.failed', { sessionID: s.id, assistantMessageID: s.inFlight, error: { type: 'MessageAbortedError', message: 'Step interrupted' } });
      frame('session.execution.interrupted', { sessionID: s.id });
      return json(res, 200, { data: { interrupted: true } });
    }
    if (req.method === 'GET' && m[2] === 'message') return json(res, 200, { data: s.messages });
  }
  return json(res, 404, { error: `no route ${req.method} ${path}` });
});

const portArg = process.argv.indexOf('--port');
server.listen(portArg >= 0 ? Number(process.argv[portArg + 1]) : 0, '127.0.0.1', () => {
  process.stdout.write(`opencode server listening on http://127.0.0.1:${server.address().port}\n`);
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
