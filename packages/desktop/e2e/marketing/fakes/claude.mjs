#!/usr/bin/env node
/**
 * The `claude` the Harbor capture puts first on PATH: bench/pipeline's
 * fake-claude protocol (`-p` stream-json, its probes, `mcp_status`, an
 * interrupt), playing the Harbor scene its task's prompt names instead of a
 * cue. Text streams as partial messages, the way `--include-partial-messages`
 * relays the real CLI's, and edits carry the structured patch the adapter
 * draws a diff from.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import { callTool, contact } from './mcp.mjs';
import { Cancelled, beat, perform, play, replyTo, sceneFor, userMessage } from './scene.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === '--version') {
  process.stdout.write('2.1.330 (Claude Code)\n');
  process.exit(0);
}
if (argv[0] === '--help') {
  process.stdout.write('Usage: claude [options] [prompt]\n\n  --model <model>  Model for the current session. Provide an alias for the latest model (e.g. \'sonnet\' or \'opus\').\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })}\n`);
  process.exit(0);
}

const sessionId = flag('--resume') ?? randomUUID();
const model = flag('--model') ?? 'sonnet';
const cwd = process.cwd();
let messageCount = 0;
let turnAbort = null;
let inbox = [];
let busy = false;
/** Where the scene stands, kept across turns so a message mid-scene resumes it. */
const state = { scene: null, next: 0 };

function emit(line) {
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, parent_tool_use_id: null, ...line })}\n`);
}

function nextId() {
  messageCount += 1;
  return `msg_${sessionId.slice(0, 8)}_${messageCount}`;
}

function assistant(content, id = nextId()) {
  emit({ type: 'assistant', message: { id, model, role: 'assistant', content } });
}

function toolResult(toolUseId, content, isError = false, structured) {
  emit({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    ...(structured ? { tool_use_result: structured } : {}),
  });
}

function server() {
  const config = flag('--mcp-config');
  if (!config) return null;
  const ordewell = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers?.ordewell;
  return ordewell?.url ? ordewell : null;
}

/** A block of text or thinking, streamed in short chunks and then sent whole, as the CLI does. */
async function streamBlock(kind, text, signal) {
  const id = nextId();
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id, model } } });
  const delta = kind === 'text' ? (chunk) => ({ type: 'text_delta', text: chunk }) : (chunk) => ({ type: 'thinking_delta', thinking: chunk });
  for (let at = 0; at < text.length; at += 14) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: delta(text.slice(at, at + 14)) } });
    await beat(28, signal);
  }
  assistant([kind === 'text' ? { type: 'text', text } : { type: 'thinking', thinking: text, signature: '' }], id);
}

function numbered(content) {
  return content.replace(/\n$/, '').split('\n').map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n');
}

/** One scene step as Claude Code's own tools: Read, Bash, Edit and Write, each announced, then done, then answered. */
async function tool(step, signal) {
  const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const target = step.read ?? step.edit ?? step.write;
  const input = step.read ? { file_path: target }
    : step.run ? { command: step.run, description: step.why }
    : step.edit ? { file_path: target, old_string: step.find, new_string: step.replace }
    : { file_path: target, content: step.content };
  const name = step.read ? 'Read' : step.run ? 'Bash' : step.edit ? 'Edit' : 'Write';
  assistant([{ type: 'tool_use', id, name, input }]);
  await beat(step.run ? 1400 : 500, signal);
  const done = perform(step, cwd);
  if (done.kind === 'read') toolResult(id, numbered(done.content));
  else if (done.kind === 'run') toolResult(id, done.output, !done.success);
  else if (done.kind === 'edit') toolResult(id, `The file ${target} has been updated.`, false, { filePath: target, oldString: step.find, newString: step.replace, structuredPatch: done.patch });
  else toolResult(id, done.created ? `File created successfully at: ${target}` : `The file ${target} has been updated.`, false, done.created ? { type: 'create', filePath: target, content: done.content } : { type: 'update', filePath: target, content: done.content, structuredPatch: done.patch });
}

async function mcp(name, args) {
  const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  assistant([{ type: 'tool_use', id, name: `mcp__ordewell__${name}`, input: args }]);
  const reply = await callTool(server(), 'claude-code', name, args);
  toolResult(id, reply.text, reply.isError);
  return reply;
}

const io = {
  think: (text, signal) => streamBlock('thinking', text, signal),
  say: (text, signal) => streamBlock('text', text, signal),
  tool,
  mcp,
  inbox: () => inbox.splice(0),
};

function promptText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
}

async function runTurn(text, signal) {
  const scene = state.scene ?? sceneFor(text);
  if (!scene) {
    await io.say('I could not find what this task asks for.', signal);
    return;
  }
  if (state.scene) await io.say(replyTo(scene, userMessage(text)), signal);
  state.scene = scene;
  await play(scene, state, io, signal);
}

async function handleUser(message) {
  turnAbort = new AbortController();
  busy = true;
  let failure = null;
  try {
    await runTurn(promptText(message), turnAbort.signal);
  } catch (err) {
    if (!(err instanceof Cancelled)) failure = err instanceof Error ? err.message : String(err);
  }
  const interrupted = turnAbort.signal.aborted;
  busy = false;
  turnAbort = null;
  emit({
    type: 'result',
    subtype: failure || interrupted ? 'error_during_execution' : 'success',
    is_error: Boolean(failure) || interrupted,
    result: failure ?? '',
    total_cost_usd: 0,
  });
}

function control(message) {
  const subtype = message.request?.subtype;
  let response = {};
  if (subtype === 'mcp_status') response = { mcpServers: server() ? [{ name: 'ordewell', status: 'connected' }] : [] };
  else if (subtype === 'interrupt') turnAbort?.abort();
  emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
}

const ordewell = server();
if (ordewell) await contact(ordewell, 'claude-code');
emit({ type: 'system', subtype: 'init', cwd, model, permissionMode: flag('--permission-mode') ?? 'default', tools: ['Bash', 'Edit', 'Read', 'Write'], claude_code_version: '2.1.330' });

// Turns run one at a time; a message that arrives during one is a steer the
// scene answers after its current step, and control requests are answered at once.
let turns = Promise.resolve();
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'control_request') control(message);
  else if (message.type === 'user') {
    if (message.uuid) emit({ type: 'user', isReplay: true, uuid: message.uuid, message: message.message });
    if (busy) inbox.push(userMessage(promptText(message.message)));
    else turns = turns.then(() => handleUser(message.message));
  }
});
input.on('close', () => { turns.then(() => process.exit(0)); });
