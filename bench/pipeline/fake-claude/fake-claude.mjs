#!/usr/bin/env node
/**
 * A deterministic stand-in for the `claude` CLI: no model, no API key.
 *
 * Put this folder first on PATH and Ordewell's real Claude Code connector
 * (`ClaudeCodeAdapter`) and `StructuredRunner` drive it exactly as they drive
 * the real binary. It speaks the `-p --input-format stream-json
 * --output-format stream-json` protocol as far as the adapter reads it, and
 * completes tasks the way a real agent does: by calling `task_complete` on the
 * Ordewell MCP server named in the `--mcp-config` file. It never prints the
 * text completion marker, so a pass can only come from the tool.
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
 */
import fs from 'node:fs';
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

const sessionId = flag('--resume') ?? `fake-claude-${randomUUID()}`;
const permissionMode = flag('--permission-mode') ?? 'default';
const mcpConfigPath = flag('--mcp-config');
const cwd = process.cwd();

let messageCount = 0;
let turnAbort = null;

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

async function runTurn(text, signal) {
  const cue = readCue(text);
  assistant([{ type: 'text', text: 'Starting the task.' }]);

  if (cue.delayMs) await sleep(cue.delayMs, signal);
  if (signal.aborted) return;
  if (cue.crash) process.exit(1);

  const files = cue.write ?? { 'fake-claude-output.txt': `fake-claude output for ${sessionId}\n` };
  for (const [name, contents] of Object.entries(files)) {
    const id = `toolu_fake_${randomUUID()}`;
    assistant([{ type: 'tool_use', id, name: 'Write', input: { file_path: path.resolve(cwd, name), content: contents } }]);
    writeFile(name, contents);
    toolResult(id, `File created successfully at: ${name}`, false, { type: 'create', content: contents });
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

emit({ type: 'system', subtype: 'init', cwd, model: MODEL, permissionMode });

// Turns run one at a time, but control requests (an interrupt, an attach
// check) are answered while one is in flight.
let turns = Promise.resolve();
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') control(msg);
  else if (msg.type === 'user') {
    if (msg.uuid) emit({ type: 'user', isReplay: true, uuid: msg.uuid, message: msg.message });
    turns = turns.then(() => handleUser(msg));
  }
});
input.on('close', () => { turns.then(() => process.exit(0)); });
