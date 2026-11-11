#!/usr/bin/env node
/**
 * The `codex` the Harbor capture puts first on PATH. It speaks the app-server
 * protocol CodexAdapter reads (newline JSON-RPC on stdio: `initialize`,
 * `model/list`, `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`)
 * and plays its task's scene as Codex's own items: reasoning, agent messages,
 * command executions, file changes and Ordewell MCP calls. Its probes answer
 * as a signed-in codex-cli whose sandbox starts.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { callTool, contact } from './mcp.mjs';
import { Cancelled, beat, note, perform, play, replyTo, sceneFor, userMessage } from './scene.mjs';

const argv = process.argv.slice(2);
note('codex', argv.join(' '));

if (argv[0] === '--version') {
  process.stdout.write('codex-cli 0.162.1\n');
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}
if (argv[0] === 'sandbox') process.exit(0);
if (argv[0] !== 'app-server') {
  process.stderr.write(`the Harbor codex has no "${argv.join(' ')}"\n`);
  process.exit(2);
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort }));
const MODELS = [
  { id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: EFFORTS },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini', hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: EFFORTS },
];

let threadId = null;
let ordewell = null;
/** The turn in flight: its id, how to stop it, and the steers waiting for the step in flight to end. */
let turn = null;
const state = { scene: null, next: 0 };
let itemCount = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}
const respond = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params: { threadId, ...(turn ? { turnId: turn.id } : {}), ...params } });
const nextItem = (kind) => `${kind}_${String(++itemCount).padStart(3, '0')}`;

function started(item) { notify('item/started', { item }); }
function completed(item) { notify('item/completed', { item }); }

async function streamed(type, text, signal) {
  const id = nextItem(type === 'reasoning' ? 'rs' : 'msg');
  started(type === 'reasoning' ? { type, id, summary: [], content: [] } : { type, id, text: '' });
  for (let at = 0; at < text.length; at += 14) {
    notify(type === 'reasoning' ? 'item/reasoning/summaryTextDelta' : 'item/agentMessage/delta', { itemId: id, delta: text.slice(at, at + 14), ...(type === 'reasoning' ? { summaryIndex: 0 } : {}) });
    await beat(28, signal);
  }
  completed(type === 'reasoning' ? { type, id, summary: [text], content: [] } : { type, id, text, phase: 'commentary' });
}

/** A scene step as Codex does it: a shell command, or a patch of one file. */
async function tool(step, signal) {
  if (step.read || step.run) {
    const command = step.run ?? `cat ${step.read}`;
    const id = nextItem('exec');
    started({ type: 'commandExecution', id, command, cwd: process.cwd(), status: 'inProgress' });
    await beat(step.run ? 1400 : 500, signal);
    const done = perform(step.run ? step : { run: command }, process.cwd());
    completed({ type: 'commandExecution', id, command, cwd: process.cwd(), status: done.success ? 'completed' : 'failed', aggregatedOutput: done.output, exitCode: done.exitCode });
    return;
  }
  const id = nextItem('patch');
  const abs = path.resolve(process.cwd(), step.edit ?? step.write);
  const kind = { type: fs.existsSync(abs) ? 'update' : 'add' };
  started({ type: 'fileChange', id, status: 'inProgress', changes: [{ path: abs, kind, diff: '' }] });
  await beat(500, signal);
  const done = perform(step, process.cwd());
  const change = done.kind === 'write' && done.created
    ? { path: done.abs, kind: { type: 'add' }, diff: done.content }
    : { path: done.abs, kind: { type: 'update', move_path: null }, diff: done.diff };
  completed({ type: 'fileChange', id, status: 'completed', changes: [change] });
}

async function mcp(name, args) {
  const id = nextItem('mcp');
  started({ type: 'mcpToolCall', id, server: 'ordewell', tool: name, arguments: args, status: 'inProgress' });
  const reply = await callTool(ordewell, 'codex', name, args);
  completed({ type: 'mcpToolCall', id, server: 'ordewell', tool: name, arguments: args, status: reply.isError ? 'failed' : 'completed', result: { content: [{ type: 'text', text: reply.text }] } });
  return reply;
}

/** Steers the step in flight has let through: each reaches the model as a userMessage item, then is answered. */
function inbox() {
  const waiting = turn?.steers.splice(0) ?? [];
  for (const steer of waiting) {
    const item = { type: 'userMessage', id: nextItem('user'), clientId: steer.clientId, content: [{ type: 'text', text: steer.text }] };
    started(item);
    completed(item);
  }
  return waiting.map((steer) => userMessage(steer.text));
}

const io = {
  think: (text, signal) => streamed('reasoning', text, signal),
  say: (text, signal) => streamed('agentMessage', text, signal),
  tool,
  mcp,
  inbox,
};

function inputText(input) {
  return (Array.isArray(input) ? input : []).map((part) => (part?.type === 'text' ? part.text : '')).join('\n');
}

async function runTurn(id, text) {
  const abort = new AbortController();
  turn = { id, abort, steers: [] };
  notify('turn/started', { turn: { id, status: 'inProgress', items: [] } });
  let status = 'completed';
  try {
    const scene = state.scene ?? sceneFor(text);
    if (!scene) await io.say('I could not find what this task asks for.', abort.signal);
    else {
      if (state.scene) await io.say(replyTo(scene, userMessage(text)), abort.signal);
      state.scene = scene;
      await play(scene, state, io, abort.signal);
    }
  } catch (err) {
    status = err instanceof Cancelled ? 'interrupted' : 'failed';
    if (!(err instanceof Cancelled)) note('codex', `turn failed: ${err instanceof Error ? err.stack : String(err)}`);
  }
  notify('turn/completed', { turn: { id, status, items: [], ...(status === 'failed' ? { error: { message: 'The Harbor scene failed.' } } : {}) } });
  turn = null;
  notify('thread/status/changed', { status: { type: 'idle' } });
}

async function openThread(id, params) {
  const config = params.config?.mcp_servers?.ordewell;
  threadId = `thr_${randomUUID().slice(0, 12)}`;
  respond(id, { thread: { id: threadId }, model: params.model ?? 'gpt-5.5', sandbox: { type: 'workspaceWrite' } });
  if (!config?.url) return;
  const headers = Object.fromEntries(Object.entries(config.env_http_headers ?? {}).map(([header, variable]) => [header, process.env[variable] ?? '']));
  ordewell = { url: config.url, headers };
  try {
    await contact(ordewell, 'codex');
    notify('mcpServer/startupStatus/updated', { name: 'ordewell', status: 'ready' });
  } catch (err) {
    note('codex', `mcp contact failed: ${err instanceof Error ? err.message : String(err)}`);
    notify('mcpServer/startupStatus/updated', { name: 'ordewell', status: 'failed' });
  }
}

let turns = Promise.resolve();

function request({ id, method, params = {} }) {
  switch (method) {
    case 'initialize': return respond(id, { userAgent: 'codex-cli/0.162.1' });
    case 'model/list': return respond(id, { data: MODELS, nextCursor: null });
    case 'config/read': return respond(id, { config: { mcp_servers: {} } });
    case 'windowsSandbox/readiness': return respond(id, { status: 'ready' });
    case 'skills/list': return respond(id, { data: [] });
    case 'mcpServerStatus/list': return respond(id, { data: [], nextCursor: null });
    case 'thread/start':
    case 'thread/resume': return void openThread(id, params);
    case 'turn/start': {
      const turnId = `turn_${randomUUID().slice(0, 8)}`;
      respond(id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      const text = inputText(params.input);
      turns = turns.then(() => runTurn(turnId, text));
      return undefined;
    }
    case 'turn/steer':
      if (!turn) return send({ id, error: { code: -32600, message: 'no turn is running' } });
      turn.steers.push({ clientId: params.clientUserMessageId, text: inputText(params.input) });
      return respond(id, { turnId: turn.id });
    case 'turn/interrupt':
      respond(id, {});
      turn?.abort.abort();
      return undefined;
    default:
      return respond(id, {});
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method && message.id !== undefined) request(message);
});
input.on('close', () => { turns.then(() => process.exit(0)); });
