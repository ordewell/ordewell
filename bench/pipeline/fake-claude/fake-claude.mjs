#!/usr/bin/env node
/**
 * A deterministic stand-in for the `claude` CLI: no model, no API key.
 *
 * Put this folder first on PATH and Ordewell's real Claude Code connector
 * (`ClaudeCodeAdapter`) and `StructuredRunner` drive it exactly as they drive
 * the real binary. It speaks the `-p --input-format stream-json
 * --output-format stream-json` protocol as far as the adapter reads it, and
 * completes tasks the way a real agent does: by calling `task_complete` on the
 * Ordewell MCP server named in the `--mcp-config` file.
 *
 * A task steers it with a cue in its prompt:
 *   <fake-claude>{"delayMs":300,"write":{"A.txt":"hello"},"status":"blocked","reason":"why"}</fake-claude>
 * Every field is optional:
 *   delayMs     work time before the file writes and the completion call
 *   write       files to create under the cwd, name -> contents
 *   status      done (default) | blocked | failed, as passed to task_complete
 *   reason      the reason handed to task_complete for blocked or failed
 *   summary     the summary handed to task_complete
 *   noComplete  end the turn without calling task_complete (reads as "waiting for input")
 *   crash       exit non-zero before completing
 *   untilFile   a file to wait for before the work, for a task that must still run when something else ends
 *   calls       tool calls made on the Ordewell server before the file writes, each `[tool, arguments]`
 *   awaitMessage  after the file writes, wait for a message handed into the turn (a steer) before completing
 *
 * A planner's first message may carry `turnsFrom` instead: a file holding one
 * entry per turn, made in order. An entry is a list of tool calls, each
 * `[tool, arguments]`, made on the Ordewell server, or `{ calls, text }` to end
 * the turn saying `text` too (a summary, say). A call whose tool is one of
 * Claude Code's own reads (`Read`, `Grep`, `Glob`, `LSP`) runs natively
 * instead, as the real CLI runs it: it raises `can_use_tool` first when the
 * `--settings` ask rules name the tool, and waits for the answer, and runs
 * unasked when they do not. A file, since a plan's prompts
 * hold cues of their own. What is left of them is kept beside the session,
 * under FAKE_CLAUDE_STATE, for the session's next turn, in this process or in
 * the `--resume` of a parked subplanner (ADR-0055 D18). A planner writes no
 * file of the workspace.
 *
 * With FAKE_CLAUDE_LOG set, every prompt taken and every call's reply is
 * appended to that file as a line of JSON, for a test to read what was said.
 *
 * The host's probes are answered as the real CLI answers them and exit at once:
 * `--version`, `--help` and `auth status` (signed in). The host runs them with
 * stdin left open, so a probe read as a turn would wait out its timeout and the
 * runner would read as not installed.
 *
 * A `--resume` of the session named by FAKE_CLAUDE_REFUSE_RESUME is answered as
 * the real CLI answers one it cannot find: an error result, no `init`, and a wait
 * on stdin.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const CUE = /<fake-claude>([\s\S]*?)<\/fake-claude>/;
const MODEL = 'fake-claude';
const MCP_PROTOCOL_VERSION = '2025-06-18';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === '--version') {
  process.stdout.write('2.0.0 (Claude Code)\n');
  process.exit(0);
}
if (argv[0] === '--help') {
  process.stdout.write('Usage: claude [options] [prompt]\n\n  --model <model>  Model for the current session. Provide an alias for the latest model (e.g. \'sonnet\' or \'opus\').\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'fake' })}\n`);
  process.exit(0);
}

const sessionId = flag('--resume') ?? `fake-claude-${randomUUID()}`;
const permissionMode = flag('--permission-mode') ?? 'default';
const mcpConfigPath = flag('--mcp-config');
const cwd = process.cwd();

/**
 * The tools the `--settings` ask rules name whole, as the real CLI reads
 * `permissions.ask`. On Windows a multi-line prompt starts this fake through
 * `claude.ps1`, and Windows PowerShell drops every `"` on its way to `node`
 * (ADR-0010), so the list is read from that unquoted form when it is not JSON.
 */
const askedTools = (() => {
  const settings = flag('--settings') ?? '{}';
  let rules;
  try {
    rules = JSON.parse(settings)?.permissions?.ask;
  } catch {
    rules = /\bask:\[([^\]]*)\]/.exec(settings)?.[1].split(',');
  }
  return new Set(Array.isArray(rules) ? rules.filter((rule) => typeof rule === 'string' && rule !== '' && !rule.includes('(')) : []);
})();
const NATIVE_READS = new Set(['Read', 'Grep', 'Glob', 'LSP']);
/** `can_use_tool` requests sent and not yet answered, by request id. */
const pendingAsks = new Map();
let askCount = 0;

let messageCount = 0;
let turnAbort = null;
/** Set while a turn waits for a steer: the next user line resolves it instead of queuing a turn. */
let steerWaiter = null;

function emit(line) {
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, parent_tool_use_id: null, ...line })}\n`);
}

function assistant(content) {
  messageCount += 1;
  emit({ type: 'assistant', message: { id: `msg_fake_${messageCount}`, model: MODEL, role: 'assistant', content } });
}

function toolResult(toolUseId, content, isError = false, structured) {
  emit({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    ...(structured ? { tool_use_result: structured } : {}),
  });
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function readCue(text) {
  const match = CUE.exec(text);
  if (!match) return {};
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`unreadable <fake-claude> cue: ${err.message}`);
  }
}

function promptText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
}

function writeFile(name, contents) {
  const target = path.resolve(cwd, name);
  if (target !== cwd && !target.startsWith(cwd + path.sep)) throw new Error(`cue writes outside the workspace: ${name}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

// The adapter reads `mcp_status` to decide the Ordewell server attached, so a
// config this process can read is reported connected and nothing else is.
function mcpServer() {
  if (!mcpConfigPath) return null;
  const { mcpServers } = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
  const server = mcpServers?.ordewell;
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
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(text)];
  const answer = payloads.find((p) => p.id === body.id);
  if (!answer) throw new Error(`no answer to ${body.method} in: ${text}`);
  if (answer.error) throw new Error(`${body.method} failed: ${answer.error.message}`);
  return answer.result;
}

async function callTool(server, name, args) {
  const init = await post(server, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } },
  });
  const headers = { 'mcp-protocol-version': init.protocolVersion ?? MCP_PROTOCOL_VERSION };
  await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  const result = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, headers);
  const text = (result.content ?? []).map((b) => b.text ?? '').join('\n');
  return { text, isError: result.isError === true };
}

function stateFile() {
  return path.join(process.env.FAKE_CLAUDE_STATE ?? os.tmpdir(), `${sessionId}.json`);
}

/**
 * This turn: from a first message's cue, or what a turn of this session left.
 * Null when this is no scripted planner. A session's own file exists only once
 * a turn of it wrote one, since a new session's id is fresh.
 */
function plannerTurn(cue) {
  const from = cue.turnsFrom ?? (fs.existsSync(stateFile()) ? stateFile() : null);
  const left = from ? JSON.parse(fs.readFileSync(from, 'utf8')) : null;
  if (!left) return null;
  const [turn = [], ...rest] = left;
  fs.writeFileSync(stateFile(), JSON.stringify(rest));
  return Array.isArray(turn) ? { calls: turn } : { calls: turn.calls ?? [], text: turn.text };
}

function logged(entry) {
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ sessionId, ...entry })}\n`);
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === '.ordewell') return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

function globPattern(pattern) {
  const source = pattern.split('**/').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('(?:.*/)?');
  return new RegExp(`^${source}$`);
}

/** What a native read returns: the file, the matching lines or names, or an LSP answer about the file. */
function nativeRead(name, input) {
  const at = (target) => path.resolve(cwd, typeof target === 'string' ? target : '.');
  switch (name) {
    case 'Read': return fs.readFileSync(at(input.file_path), 'utf8');
    case 'Grep': {
      const match = new RegExp(String(input.pattern ?? ''));
      return filesUnder(at(input.path)).flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => (match.test(line) ? `${path.relative(cwd, file)}:${i + 1}:${line}` : null)).filter(Boolean)).join('\n');
    }
    case 'Glob': {
      const match = globPattern(String(input.pattern ?? '**/*'));
      return filesUnder(at(input.path)).map((file) => path.relative(at(input.path), file).split(path.sep).join('/')).filter((rel) => match.test(rel)).join('\n');
    }
    default: return `${input.operation ?? 'documentSymbol'} in ${input.filePath}: ${fs.readFileSync(at(input.filePath), 'utf8').split('\n').length} lines`;
  }
}

/** Asks the host whether a tool may run, as `--permission-prompt-tool stdio` does, and waits for its answer. */
function canUseTool(name, input, toolUseId) {
  askCount += 1;
  const requestId = `fake-ask-${askCount}`;
  const answered = new Promise((resolve) => { pendingAsks.set(requestId, resolve); });
  emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: toolUseId } });
  return answered;
}

async function nativeCall(id, name, input) {
  const answer = askedTools.has(name) ? await canUseTool(name, input, id) : { behavior: 'allow', updatedInput: input };
  if (answer?.behavior !== 'allow') return { text: answer?.message ?? 'denied', isError: true };
  try {
    return { text: nativeRead(name, answer.updatedInput ?? input), isError: false };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

async function makeCalls(calls) {
  const server = mcpServer();
  for (const [name, args] of calls) {
    const id = `toolu_fake_${randomUUID()}`;
    if (NATIVE_READS.has(name)) {
      assistant([{ type: 'tool_use', id, name, input: args }]);
      const reply = await nativeCall(id, name, args);
      logged({ tool: name, native: true, reply });
      toolResult(id, reply.text, reply.isError);
      continue;
    }
    assistant([{ type: 'tool_use', id, name: `mcp__ordewell__${name}`, input: args }]);
    const reply = await callTool(server, name, args);
    logged({ tool: name, reply });
    toolResult(id, reply.text, reply.isError);
  }
}

async function runPlannerTurn({ calls, text }) {
  await makeCalls(calls);
  assistant([{ type: 'text', text: text ?? 'This turn is done.' }]);
}

async function untilFile(file, signal) {
  while (!fs.existsSync(file) && !signal.aborted) await sleep(25, signal);
}

async function runTurn(text, signal) {
  logged({ prompt: text });
  const cue = readCue(text);
  const turn = plannerTurn(cue);
  if (turn) return runPlannerTurn(turn);
  assistant([{ type: 'text', text: 'Starting the task.' }]);

  if (cue.delayMs) await sleep(cue.delayMs, signal);
  if (cue.untilFile) await untilFile(cue.untilFile, signal);
  if (signal.aborted) return;
  if (cue.crash) process.exit(1);
  if (cue.calls) await makeCalls(cue.calls);

  const files = cue.write ?? { 'fake-claude-output.txt': `fake-claude output for ${sessionId}\n` };
  for (const [name, contents] of Object.entries(files)) {
    const id = `toolu_fake_${randomUUID()}`;
    assistant([{ type: 'tool_use', id, name: 'Write', input: { file_path: path.resolve(cwd, name), content: contents } }]);
    writeFile(name, contents);
    toolResult(id, `File created successfully at: ${name}`, false, { type: 'create', content: contents });
  }

  if (cue.awaitMessage) {
    const steer = await new Promise((resolve) => {
      steerWaiter = resolve;
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    steerWaiter = null;
    if (signal.aborted) return;
    logged({ steer: promptText(steer.message) });
    assistant([{ type: 'text', text: 'Read your message.' }]);
  }

  const server = mcpServer();
  if (server && !cue.noComplete) {
    const status = cue.status ?? 'done';
    const args = { status, summary: cue.summary ?? `fake-claude finished (${status})`, ...(cue.reason ? { reason: cue.reason } : {}) };
    const id = `toolu_fake_${randomUUID()}`;
    assistant([{ type: 'tool_use', id, name: 'mcp__ordewell__task_complete', input: args }]);
    const reply = await callTool(server, 'task_complete', args);
    toolResult(id, reply.text, reply.isError);
  }

  assistant([{ type: 'text', text: 'All done.' }]);
}

async function handleUser(msg) {
  turnAbort = new AbortController();
  const { signal } = turnAbort;
  let failure = null;
  try {
    await runTurn(promptText(msg.message), signal);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  const interrupted = signal.aborted;
  turnAbort = null;
  emit({
    type: 'result',
    subtype: failure ? 'error_during_execution' : interrupted ? 'error_during_execution' : 'success',
    is_error: Boolean(failure) || interrupted,
    result: failure ?? '',
    total_cost_usd: 0,
  });
}

function control(msg) {
  const subtype = msg.request?.subtype;
  let response = {};
  if (subtype === 'mcp_status') {
    response = { mcpServers: mcpServer() ? [{ name: 'ordewell', status: 'connected' }] : [] };
  } else if (subtype === 'interrupt') {
    turnAbort?.abort();
  }
  emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
}

if (flag('--resume') !== undefined && flag('--resume') === process.env.FAKE_CLAUDE_REFUSE_RESUME) {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`No conversation found with session ID: ${sessionId}`], total_cost_usd: 0 });
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(1));
} else {
  emit({ type: 'system', subtype: 'init', cwd, model: MODEL, permissionMode });
  acceptInput();
}

// Turns run one at a time, but control requests (an interrupt, an attach
// check) are answered while one is in flight.
function acceptInput() {
  let turns = Promise.resolve();
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'control_request') control(msg);
    else if (msg.type === 'control_response') {
      const requestId = msg.response?.request_id;
      pendingAsks.get(requestId)?.(msg.response?.response);
      pendingAsks.delete(requestId);
    }
    else if (msg.type === 'user') {
      if (msg.uuid) emit({ type: 'user', isReplay: true, uuid: msg.uuid, message: msg.message });
      if (steerWaiter) steerWaiter(msg);
      else turns = turns.then(() => handleUser(msg));
    }
  });
  input.on('close', () => { turns.then(() => process.exit(0)); });
}
