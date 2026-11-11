#!/usr/bin/env node
/**
 * The `copilot` the Harbor capture puts first on PATH: bench/pipeline's
 * fake-acp (ACP v1 over newline JSON-RPC on stdio, the Ordewell server from
 * `session/new`, a `session/cancel` that ends the prompt as cancelled), with
 * the probes model discovery asks and its task's scene played as Copilot's
 * own session updates: thought and message chunks, and read, execute and edit
 * tool calls that move from pending to completed.
 *
 * ACP has no way to add to a running prompt, so Ordewell holds a message for
 * the end of the turn, or cancels the turn to send it now: the next prompt is
 * that message, answered before the scene goes on from where it stopped.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { callTool, contact } from './mcp.mjs';
import { Cancelled, beat, note, perform, play, replyTo, sceneFor, userMessage } from './scene.mjs';

const argv = process.argv.slice(2);
note('copilot', argv.join(' '));

if (argv[0] === '--version') {
  process.stdout.write('GitHub Copilot CLI 1.0.105.\n');
  process.exit(0);
}
if (argv[0] === 'help' && argv[1] === 'config') {
  // The one setting parseCopilotModels reads, in the words `copilot help config` prints it.
  const models = ['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-haiku-5.5', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gemini-3.8-flash'];
  process.stdout.write(`Configuration Settings:\n\n  \`model\`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.\n${models.map((m) => `    - "${m}"`).join('\n')}\n\n  \`theme\`: the color theme.\n`);
  process.exit(0);
}
if (argv[0] === 'login') process.exit(0);
if (!argv.includes('--acp')) {
  process.stderr.write(`the Harbor copilot has no "${argv.join(' ')}"\n`);
  process.exit(2);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const respond = (id, result) => send({ id, result });
const respondError = (id, code, message) => send({ id, error: { code, message } });

let session = null;
/** The prompt in flight: its request id and how to stop it. */
let prompt = null;
const state = { scene: null, next: 0 };
let used = 15200;

function update(payload) {
  send({ method: 'session/update', params: { sessionId: session.id, update: payload } });
}

async function chunks(sessionUpdate, text, signal) {
  const messageId = `msg_${randomUUID()}`;
  for (let at = 0; at < text.length; at += 14) {
    update({ sessionUpdate, messageId, content: { type: 'text', text: text.slice(at, at + 14) } });
    await beat(28, signal);
  }
}

const callId = () => `call_${randomBytes(18).toString('base64url')}`;
const text = (value) => [{ type: 'content', content: { type: 'text', text: value } }];

/**
 * A scene step as Copilot's own tools. Copilot titles a call in its own fixed
 * words or the model's description; the `name` beside them is the tool's, so
 * the row reads as the read, shell or edit it is and an edit draws its diff.
 */
async function tool(step, signal) {
  const target = step.read ?? step.edit ?? step.write;
  const abs = target ? path.resolve(session.cwd, target) : undefined;
  const created = step.write ? !fs.existsSync(abs) : false;
  const toolCallId = callId();
  const call = step.read ? { name: 'read', title: `Viewing ${target}`, kind: 'read', rawInput: { path: target } }
    : step.run ? { name: 'bash', title: step.why ?? step.run, kind: 'execute', rawInput: { command: step.run, description: step.why ?? step.run, mode: 'sync', initial_wait: 30 } }
    : step.edit ? { name: 'edit', title: `Editing ${target}`, kind: 'edit', rawInput: { path: target, old_str: step.find, new_str: step.replace } }
    : { name: 'write', title: `${created ? 'Creating' : 'Editing'} ${target}`, kind: 'edit', rawInput: { path: target, file_text: step.content } };
  update({ sessionUpdate: 'tool_call', toolCallId, ...call, status: 'pending', ...(abs ? { locations: [{ path: abs }] } : {}) });
  update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
  await beat(step.run ? 1400 : 500, signal);
  const done = perform(step, session.cwd);
  const output = done.kind === 'read' ? done.content : done.kind === 'run' ? done.output : done.diff;
  update({ sessionUpdate: 'tool_call_update', toolCallId, status: done.success ? 'completed' : 'failed', content: text(output) });
  used += 400 + Math.round(output.length / 4);
  update({ sessionUpdate: 'usage_update', used, size: 128000 });
}

/** An Ordewell tool, which Copilot reports on its server's name as `ordewell-<tool>`. */
async function mcp(name, args) {
  const toolCallId = callId();
  update({ sessionUpdate: 'tool_call', toolCallId, title: `ordewell-${name}`, kind: 'other', status: 'pending', rawInput: args });
  update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
  const reply = await callTool(session.mcp, 'copilot', name, args);
  update({ sessionUpdate: 'tool_call_update', toolCallId, status: reply.isError ? 'failed' : 'completed', content: text(reply.text), rawOutput: { content: reply.text, detailedContent: reply.text } });
  return reply;
}

const io = {
  think: (value, signal) => chunks('agent_thought_chunk', value, signal),
  say: (value, signal) => chunks('agent_message_chunk', value, signal),
  tool,
  mcp,
};

/** The contract Copilot reads from the AGENTS.md in each directory this variable lists. */
function instructions() {
  return (process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? '').split(path.delimiter).filter(Boolean).map((dir) => {
    try { return fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'); } catch { return ''; }
  }).join('\n');
}

async function runTurn(words, signal) {
  const scene = state.scene ?? sceneFor(words) ?? sceneFor(instructions());
  if (!scene) {
    await io.say('I could not find what this task asks for.', signal);
    return;
  }
  if (state.scene) await io.say(replyTo(scene, userMessage(words)), signal);
  state.scene = scene;
  await play(scene, state, io, signal);
}

/**
 * A turn ends without its token usage: usage with no price would put "copilot-cli reports no cost" atop the Plan panel in
 * every shot, a true line but not one the product story needs. The context meter still moves with usage_update.
 */
function finish(id, stopReason) {
  if (prompt?.id !== id) return;
  prompt = null;
  respond(id, { stopReason });
}

function onPrompt(id, params) {
  if (!session || params.sessionId !== session.id) return respondError(id, -32602, `unknown session ${params.sessionId}`);
  const controller = new AbortController();
  prompt = { id, controller };
  const words = (Array.isArray(params.prompt) ? params.prompt : []).map((part) => (part?.type === 'text' ? part.text ?? '' : '')).join('\n');
  runTurn(words, controller.signal).then(
    () => finish(id, 'end_turn'),
    (err) => {
      if (err instanceof Cancelled) return finish(id, 'cancelled');
      note('copilot', `turn failed: ${err instanceof Error ? err.stack : String(err)}`);
      return finish(id, 'refusal');
    },
  );
  return undefined;
}

function serverFrom(params) {
  const server = (Array.isArray(params.mcpServers) ? params.mcpServers : []).find((candidate) => candidate?.name === 'ordewell' && candidate.url);
  if (!server) return null;
  return { url: server.url, headers: Object.fromEntries((server.headers ?? []).filter((h) => h?.name).map((h) => [h.name, h.value ?? ''])) };
}

async function openSession(id, params, sessionId = `${randomUUID()}`) {
  session = { id: sessionId, cwd: typeof params.cwd === 'string' ? params.cwd : process.cwd(), mcp: serverFrom(params) };
  if (session.mcp) {
    try { await contact(session.mcp, 'copilot'); } catch (err) { note('copilot', `mcp contact failed: ${err instanceof Error ? err.message : String(err)}`); }
  }
  // Copilot lists no model over ACP: `help config` is its catalog, and the model reaches it as --model.
  respond(id, { sessionId: session.id, configOptions: [] });
}

function request({ id, method, params = {} }) {
  switch (method) {
    case 'initialize':
      return respond(id, {
        protocolVersion: 1,
        agentInfo: { name: 'Copilot', title: 'Copilot', version: '1.0.105' },
        authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI', description: 'Run `copilot login` in the terminal' }],
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false },
          sessionCapabilities: { resume: {}, close: {} },
        },
      });
    case 'session/new': return void openSession(id, params);
    case 'session/load':
    case 'session/resume': return void openSession(id, params, typeof params.sessionId === 'string' ? params.sessionId : undefined);
    case 'session/prompt': return onPrompt(id, params);
    case 'session/close': return respond(id, {});
    default: return respondError(id, -32601, `Method not found: ${method}`);
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (typeof message?.method !== 'string') return;
  if (message.id !== undefined) request(message);
  else if (message.method === 'session/cancel' && prompt) {
    // Answered at once, as Copilot does: a checkpoint still waiting on its answer must not hold the prompt open.
    prompt.controller.abort();
    finish(prompt.id, 'cancelled');
  }
});
input.on('close', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
