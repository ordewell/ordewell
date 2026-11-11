#!/usr/bin/env node
/**
 * The `opencode` the Harbor capture puts first on PATH: bench/pipeline's
 * fake-opencode 1.x server (`serve`, `/event`, `prompt_async`, `abort`), with
 * the probes model discovery asks and its task's scene played as OpenCode's
 * own parts: reasoning and text streamed as deltas, and read, bash, edit and
 * write tool parts that move from running to completed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { callTool, contact } from './mcp.mjs';
import { Cancelled, beat, note, perform, play, replyTo, sceneFor, userMessage } from './scene.mjs';

const argv = process.argv.slice(2);
note('opencode', argv.join(' '));
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === '--version') {
  process.stdout.write('1.14.0\n');
  process.exit(0);
}
if (argv[0] === 'models') {
  process.stdout.write('opencode-go/kimi-k2.6\n{"id":"kimi-k2.6","name":"Kimi K2.6","variants":{"high":{}},"limit":{"context":262144}}\n');
  process.exit(0);
}
if (argv[0] === 'auth') {
  process.stdout.write('1 credential\n  OpenCode Go  api\n');
  process.exit(0);
}
if (argv[0] !== 'serve') {
  process.stderr.write(`the Harbor opencode has no "${argv.join(' ')}"\n`);
  process.exit(2);
}

const PROVIDER = 'opencode-go';
const MODEL = 'kimi-k2.6';
const id = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;

let ordewell = null;
try {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}').mcp?.ordewell;
  if (config?.url) ordewell = { url: config.url, headers: config.headers ?? {} };
} catch {
  // No config the server can read is a task with no Ordewell tools, which the scene reports.
}

const sessionId = `ses_${randomUUID().slice(0, 12)}`;
const subscribers = new Set();
let busy = false;
/** The turn in flight: how to stop it, the assistant message its parts belong to, and the messages sent while it ran. */
let turn = null;
const state = { scene: null, next: 0 };

function publish(type, properties) {
  const frame = `data: ${JSON.stringify({ type, properties: { sessionID: sessionId, ...properties } })}\n\n`;
  for (const res of subscribers) res.write(frame);
}

function status(type) {
  busy = type === 'busy';
  publish('session.status', { status: { type } });
}

/** A new assistant message, one per model call, answering `parentID`. */
function assistantMessage(parentID, extra = {}) {
  const info = { id: id('msg'), sessionID: sessionId, role: 'assistant', parentID, providerID: PROVIDER, modelID: MODEL, time: { created: Date.now() }, ...extra };
  publish('message.updated', { info });
  return info;
}

function closeMessage(info, extra = {}) {
  publish('message.updated', { info: { ...info, time: { ...info.time, completed: Date.now() }, ...extra } });
}

async function streamed(type, text, signal) {
  const part = { id: id('prt'), sessionID: sessionId, messageID: turn.message.id, type, text: '', time: { start: Date.now() } };
  publish('message.part.updated', { part });
  for (let at = 0; at < text.length; at += 14) {
    publish('message.part.delta', { messageID: part.messageID, partID: part.id, field: 'text', delta: text.slice(at, at + 14) });
    await beat(28, signal);
  }
  publish('message.part.updated', { part: { ...part, text, time: { start: part.time.start, end: Date.now() } } });
}

function toolPart(tool, input, stateFields) {
  return { id: turn.toolPart, sessionID: sessionId, messageID: turn.message.id, type: 'tool', tool, callID: turn.callID, state: { input, ...stateFields } };
}

/** A scene step as OpenCode's own tools, announced running, then completed with what they returned. */
async function tool(step, signal) {
  const target = step.read ?? step.edit ?? step.write;
  const name = step.read ? 'read' : step.run ? 'bash' : step.edit ? 'edit' : 'write';
  const input = step.read ? { filePath: target }
    : step.run ? { command: step.run, description: step.why ?? '' }
    : step.edit ? { filePath: target, oldString: step.find, newString: step.replace }
    : { filePath: target, content: step.content };
  const existed = target ? fs.existsSync(path.resolve(process.cwd(), target)) : false;
  turn.toolPart = id('prt');
  turn.callID = `call_${randomBytes(8).toString('hex')}`;
  publish('message.part.updated', { part: toolPart(name, input, { status: 'running', time: { start: Date.now() } }) });
  await beat(step.run ? 1400 : 500, signal);
  const done = perform(step, process.cwd());
  const output = done.kind === 'read' ? `<path>${target}</path>\n<type>file</type>\n<content>\n${done.content}</content>`
    : done.kind === 'run' ? done.output
    : done.kind === 'edit' ? 'Edit applied successfully.'
    : 'Wrote file successfully.';
  const metadata = done.kind === 'edit' ? { diff: done.diff } : done.kind === 'write' ? { exists: existed } : {};
  publish('message.part.updated', { part: toolPart(name, input, { status: done.success ? 'completed' : 'error', output, ...(done.success ? {} : { error: output }), metadata, time: { start: Date.now(), end: Date.now() } }) });
}

async function mcp(name, args) {
  turn.toolPart = id('prt');
  turn.callID = `call_${randomBytes(8).toString('hex')}`;
  const tool = `ordewell_${name}`;
  publish('message.part.updated', { part: toolPart(tool, args, { status: 'running', time: { start: Date.now() } }) });
  const reply = await callTool(ordewell, 'opencode', name, args);
  publish('message.part.updated', { part: toolPart(tool, args, { status: reply.isError ? 'error' : 'completed', output: reply.text, ...(reply.isError ? { error: reply.text } : {}), metadata: {}, time: { start: Date.now(), end: Date.now() } }) });
  return reply;
}

/**
 * Messages posted while the turn ran. The model reads them at its next call,
 * which is a new assistant message parented to the newest: the server's
 * account, which Ordewell reads as their delivery.
 */
function inbox() {
  const waiting = turn?.steers.splice(0) ?? [];
  if (waiting.length === 0) return [];
  closeMessage(turn.message);
  turn.message = assistantMessage(waiting.at(-1).messageID);
  return waiting.map((steer) => userMessage(steer.text));
}

const io = {
  think: (text, signal) => streamed('reasoning', text, signal),
  say: (text, signal) => streamed('text', text, signal),
  tool,
  mcp,
  inbox,
};

async function runTurn(text, userId) {
  const abort = new AbortController();
  status('busy');
  turn = { abort, message: assistantMessage(userId), steers: [] };
  let error;
  try {
    const scene = state.scene ?? sceneFor(text);
    if (!scene) await io.say('I could not find what this task asks for.', abort.signal);
    else {
      if (state.scene) await io.say(replyTo(scene, userMessage(text)), abort.signal);
      state.scene = scene;
      await play(scene, state, io, abort.signal);
    }
  } catch (err) {
    error = err instanceof Cancelled
      ? { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } }
      : { name: 'UnknownError', data: { message: 'The Harbor scene failed.' } };
    if (!(err instanceof Cancelled)) note('opencode', `turn failed: ${err instanceof Error ? err.stack : String(err)}`);
  }
  closeMessage(turn.message, error ? { error } : {});
  turn = null;
  status('idle');
}

let turns = Promise.resolve();

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = url.pathname;
  if (req.method === 'GET' && route === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
    return;
  }
  if (route === '/api/info' || route.startsWith('/api/')) return json(res, 404, { name: 'NotFound' });
  if (req.method === 'POST' && route === '/session') return json(res, 200, { id: sessionId });
  if (req.method === 'GET' && route === '/session/status') return json(res, 200, busy ? { [sessionId]: { type: 'busy' } } : {});
  if (req.method === 'GET' && route === '/mcp') return json(res, 200, ordewell ? { ordewell: { status: 'connected' } } : {});
  if (req.method === 'GET' && (route === '/command' || route === '/skill')) return json(res, 200, []);
  const session = route.match(/^\/session\/([^/]+)(\/.*)?$/);
  if (session) {
    const rest = session[2] ?? '';
    if (req.method === 'GET' && rest === '') return json(res, 200, { id: sessionId });
    if (req.method === 'GET' && rest === '/message') return json(res, 200, []);
    if (req.method === 'POST' && rest === '/abort') {
      turn?.abort.abort();
      return json(res, 200, true);
    }
    if (req.method === 'POST' && rest === '/prompt_async') {
      const body = await readBody(req);
      const text = (body.parts ?? []).map((part) => (part?.type === 'text' ? part.text : '')).join('\n');
      const messageID = typeof body.messageID === 'string' ? body.messageID : id('msg');
      res.writeHead(204);
      res.end();
      publish('message.updated', { info: { id: messageID, sessionID: sessionId, role: 'user', time: { created: Date.now() } } });
      if (turn) turn.steers.push({ messageID, text });
      else turns = turns.then(() => runTurn(text, messageID));
      return;
    }
  }
  return json(res, 200, true);
});

server.listen(Number(flag('--port') ?? 0), flag('--hostname') ?? '127.0.0.1', async () => {
  const address = server.address();
  if (ordewell) {
    try { await contact(ordewell, 'opencode'); } catch (err) { note('opencode', `mcp contact failed: ${err instanceof Error ? err.message : String(err)}`); }
  }
  process.stdout.write(`opencode server listening on http://127.0.0.1:${address.port}\n`);
});

process.stdin.resume();
process.stdin.on('end', () => { turns.then(() => process.exit(0)); });
