#!/usr/bin/env node
/**
 * A deterministic stand-in for an ACP v1 agent: no model, no API key.
 *
 * Put this folder first on PATH and Ordewell's real copilot-cli connector
 * (`AcpAdapter`) launches it as `copilot --acp --stdio`. It answers ACP v1 over
 * newline-delimited JSON-RPC 2.0 on stdio, reports the HTTP MCP capability,
 * remembers the Ordewell server `session/new` hands it (url and Authorization
 * header), and completes tasks the way a real agent does: by calling
 * `task_complete` on that server over Streamable HTTP.
 *
 * A task steers it with a cue in its prompt:
 *   <fake-acp>{"delayMs":300,"write":{"A.txt":"hello"},"status":"blocked","reason":"why"}</fake-acp>
 * Every field is optional:
 *   delayMs       work time before the file writes and the completion call
 *   write         files to create under the cwd, name -> contents
 *   edit          files to ask permission for, then create if allowed; each
 *                 one is a `session/request_permission` of kind `edit`
 *   read          files the agent reads with its own tool before its calls, each
 *                 a path or `{ "path": ..., "ask": false }`, resolved from its
 *                 cwd: an asked one is a `session/request_permission` of kind
 *                 `read` and is read only if allowed; an unasked one is read at
 *                 once and only reported, as an agent's allowed read is
 *   calls         Ordewell tool calls made before the writes, each `[tool, arguments]`
 *   role          `planner` for a planner turn: no task_complete is added, so a
 *                 `calls` list of planner tools stands alone
 *   status        done (default) | blocked | failed, as passed to task_complete
 *   reason        the reason handed to task_complete for blocked or failed
 *   summary       the summary handed to task_complete
 *   noComplete    end the turn without calling task_complete (and stay quiet
 *                 through the nudge Ordewell sends after such a turn)
 *   exitAfterTurn end the process after answering the prompt, so a task that
 *                 never reported reads as failed verification
 *   crash         exit non-zero before completing
 *   text          the agent's closing message, said in place of the default
 *                 (a planner's summary, say)
 *   turns         cues for this session's later prompts, one per prompt that
 *                 carries no cue of its own, in order: a planner's next turns
 *
 * A `session/cancel` answers the open prompt with stopReason `cancelled`, and
 * the work it began stops with it. With FAKE_ACP_LOG set, every prompt, tool
 * call and reply is appended to that file as a line of JSON. With
 * FAKE_ACP_NO_RESUME set, it offers neither session/resume nor session/load, as
 * an agent that cannot take a saved session up again.
 *
 * The planner half is for a driver or test that starts copilot-cli as the
 * planner: core's decision record restart test does (ADR-0067). The pipeline
 * plans through its API planner, so it exercises this agent as a task runner
 * only.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const CUE = /<fake-acp>([\s\S]*?)<\/fake-acp>/;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const cwd = process.cwd();
const resumable = !process.env.FAKE_ACP_NO_RESUME;

const sessions = new Map();
const agentRequests = new Map();
const pendingPrompts = new Map();
let nextAgentRequest = 1;
let nextMcpId = 1;

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const respondError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

/** A request of the agent's own, answered by the client; resolves with its result or error. */
function ask(method, params) {
  const id = nextAgentRequest++;
  return new Promise((resolve) => {
    agentRequests.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function logged(session, entry) {
  if (!process.env.FAKE_ACP_LOG) return;
  try {
    fs.appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify({ sessionId: session?.id, ...entry })}\n`);
  } catch { /* a read-only log dir still runs one attempt */ }
}

function readCue(text) {
  const match = CUE.exec(text ?? '');
  if (!match) return {};
  try { return JSON.parse(match[1]); } catch { return {}; }
}

function promptText(params) {
  return (Array.isArray(params.prompt) ? params.prompt : [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

function writeFile(base, name, contents) {
  const root = path.resolve(base);
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`cue writes outside the workspace: ${name}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

/** The Ordewell server from `session/new`, with the bearer that reached the agent over stdin. */
function mcpServerFrom(params) {
  const servers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
  const server = servers.find((candidate) => candidate?.name === 'ordewell' && candidate.url)
    ?? servers.find((candidate) => candidate?.type === 'http' && candidate.url);
  if (!server?.url) return null;
  return {
    url: server.url,
    headers: Object.fromEntries((server.headers ?? [])
      .filter((header) => header?.name)
      .map((header) => [header.name, header.value ?? ''])),
  };
}

async function post(server, body, extraHeaders = {}) {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...server.headers,
      ...extraHeaders,
    },
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

/**
 * The first contact the real Copilot makes eagerly while opening a session:
 * Ordewell reads it as the server attached (ADR-0022, S2), before any turn.
 */
async function contactMcp(server) {
  if (server.contacted) return;
  const init = await post(server, {
    jsonrpc: '2.0', id: nextMcpId++, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'fake-acp', version: '1' } },
  });
  server.protocolVersion = init?.protocolVersion ?? MCP_PROTOCOL_VERSION;
  server.contacted = true;
  const headers = { 'mcp-protocol-version': server.protocolVersion };
  await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  await post(server, { jsonrpc: '2.0', id: nextMcpId++, method: 'tools/list', params: {} }, headers);
}

async function callTool(session, name, args) {
  const server = session.mcp;
  if (!server) throw new Error('no Ordewell MCP server was given in session/new');
  await contactMcp(server);
  const result = await post(server, {
    jsonrpc: '2.0', id: nextMcpId++, method: 'tools/call',
    params: { name, arguments: args },
  }, { 'mcp-protocol-version': server.protocolVersion });
  return { text: (result.content ?? []).map((part) => part.text ?? '').join('\n'), isError: result.isError === true };
}

function update(session, payload) {
  notify('session/update', { sessionId: session.id, update: payload });
}

function message(session, text, messageId = `msg_${randomUUID()}`) {
  update(session, { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
}

function beginTool(session, { toolCallId, title, kind = 'other', status = 'in_progress', locations, rawInput }) {
  update(session, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    kind,
    status,
    ...(locations ? { locations } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
  });
}

function finishTool(session, toolCallId, status, output) {
  update(session, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
    ...(output !== undefined ? { content: [{ type: 'content', content: { type: 'text', text: String(output) } }] } : {}),
  });
}

async function runCalls(session, calls, signal) {
  let completed = false;
  let attempted = false;
  for (const entry of calls) {
    if (signal.aborted) return { completed, attempted };
    const [name, args = {}] = Array.isArray(entry) ? entry : [entry?.name, entry?.arguments];
    if (typeof name !== 'string') continue;
    const toolCallId = `call_${randomUUID()}`;
    beginTool(session, { toolCallId, title: `ordewell-${name}`, rawInput: args });
    try {
      const reply = await callTool(session, name, args);
      finishTool(session, toolCallId, reply.isError ? 'failed' : 'completed', reply.text);
      logged(session, { tool: name, reply });
      if (name === 'task_complete') {
        attempted = true;
        if (!reply.isError) completed = true;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      finishTool(session, toolCallId, 'failed', text);
      logged(session, { tool: name, error: text });
      if (name === 'task_complete') attempted = true;
    }
    if (signal.aborted) return { completed, attempted };
  }
  return { completed, attempted };
}

/** ACP nests the answer (`{ outcome: { outcome, optionId } }`); a flat `{ outcome, optionId }` is taken too. */
function outcomeOf(answer) {
  return typeof answer?.outcome === 'object' && answer.outcome !== null ? answer.outcome : answer;
}

function allowedBy(answer) {
  const outcome = outcomeOf(answer);
  return outcome?.outcome === 'selected' && (outcome.optionId === 'allow_once' || outcome.optionId === 'allow_always');
}

async function applyReads(session, reads, signal) {
  for (const entry of reads) {
    if (signal.aborted) return;
    const { path: name, ask: asks = true } = typeof entry === 'string' ? { path: entry } : entry ?? {};
    if (typeof name !== 'string') continue;
    const target = path.resolve(session.cwd, name);
    const toolCall = {
      toolCallId: `read_${randomUUID()}`,
      title: `Read ${name}`,
      kind: 'read',
      status: 'pending',
      locations: [{ path: target }],
      rawInput: { path: target },
    };
    beginTool(session, toolCall);
    if (asks) {
      const answer = await ask('session/request_permission', {
        sessionId: session.id,
        toolCall,
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      if (signal.aborted || outcomeOf(answer)?.outcome === 'cancelled') return;
      if (!allowedBy(answer)) {
        finishTool(session, toolCall.toolCallId, 'failed', 'The read was not allowed.');
        logged(session, { read: name, asked: true, allowed: false });
        continue;
      }
    }
    let text;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch (error) {
      finishTool(session, toolCall.toolCallId, 'failed', error instanceof Error ? error.message : String(error));
      logged(session, { read: name, asked: asks, allowed: true, missing: true });
      continue;
    }
    finishTool(session, toolCall.toolCallId, 'completed', text);
    logged(session, { read: name, asked: asks, allowed: true });
  }
}

async function applyEdits(session, edits, signal) {
  for (const [name, contents] of Object.entries(edits)) {
    if (signal.aborted) return false;
    const target = path.resolve(session.cwd, name);
    const toolCall = {
      toolCallId: `edit_${randomUUID()}`,
      title: `Edit ${name}`,
      kind: 'edit',
      status: 'pending',
      locations: [{ path: target }],
      rawInput: { path: target, content: contents },
    };
    beginTool(session, toolCall);
    const answer = await ask('session/request_permission', {
      sessionId: session.id,
      toolCall,
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    if (signal.aborted || outcomeOf(answer)?.outcome === 'cancelled') return false;
    if (!allowedBy(answer)) {
      finishTool(session, toolCall.toolCallId, 'failed', 'The edit was not allowed.');
      logged(session, { edit: name, allowed: false });
      return false;
    }
    writeFile(session.cwd, name, contents);
    finishTool(session, toolCall.toolCallId, 'completed', `Wrote ${name}`);
    logged(session, { edit: name, allowed: true });
  }
  return true;
}

async function completeTask(session, cue, signal) {
  const status = cue.status ?? 'done';
  const args = {
    status,
    summary: cue.summary ?? `fake-acp finished (${status})`,
    ...(cue.reason ? { reason: cue.reason } : {}),
  };
  try {
    return (await runCalls(session, [['task_complete', args]], signal)).completed;
  } catch (error) {
    logged(session, { completionError: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function runTurn(session, text, signal) {
  let cue = readCue(text);
  if (Array.isArray(cue.turns)) session.turns = cue.turns;
  else if (!CUE.test(text) && session.turns?.length) cue = session.turns.shift() ?? {};
  logged(session, { prompt: text, cue });
  // A nudge after a turn that reported nothing carries no cue of its own; the
  // task's first cue still decides whether this agent ever reports.
  if (typeof cue.noComplete === 'boolean') session.noComplete = cue.noComplete;
  if (typeof cue.exitAfterTurn === 'boolean') session.exitAfterTurn = cue.exitAfterTurn;
  if (cue.role === 'planner' || cue.planner === true) session.planner = true;
  if (cue.role !== undefined && cue.role !== 'planner') session.planner = false;
  if (cue.planner === false) session.planner = false;
  message(session, 'Working on it.');
  if (cue.delayMs) await sleep(cue.delayMs, signal);
  if (signal.aborted) return { stopReason: 'cancelled', exitAfterTurn: false };
  if (cue.crash) process.exit(1);
  const planner = session.planner === true;
  let completed = false;
  let attempted = false;
  if (Array.isArray(cue.read)) await applyReads(session, cue.read, signal);
  if (signal.aborted) return { stopReason: 'cancelled', exitAfterTurn: false };
  if (Array.isArray(cue.calls)) {
    const result = await runCalls(session, cue.calls, signal);
    completed = result.completed;
    attempted = result.attempted;
  }
  if (signal.aborted) return { stopReason: 'cancelled', exitAfterTurn: false };

  if (cue.edit && typeof cue.edit === 'object') {
    const allowed = await applyEdits(session, cue.edit, signal);
    if (signal.aborted) return { stopReason: 'cancelled', exitAfterTurn: false };
    if (!allowed) {
      message(session, 'That edit was not allowed.');
      return { stopReason: 'end_turn', exitAfterTurn: session.exitAfterTurn === true };
    }
  }

  if (cue.write && typeof cue.write === 'object') {
    for (const [name, contents] of Object.entries(cue.write)) {
      if (signal.aborted) return { stopReason: 'cancelled', exitAfterTurn: false };
      const toolCallId = `write_${randomUUID()}`;
      beginTool(session, {
        toolCallId,
        title: `Write ${name}`,
        kind: 'edit',
        rawInput: { path: path.resolve(session.cwd, name), content: contents },
      });
      writeFile(session.cwd, name, contents);
      finishTool(session, toolCallId, 'completed', `Wrote ${name}`);
    }
  }

  if (!planner && !session.noComplete && !completed && !attempted) completed = await completeTask(session, cue, signal);
  if (signal.aborted) return { stopReason: 'cancelled', exitAfterTurn: false };
  message(session, typeof cue.text === 'string' ? cue.text : completed ? 'All done.' : 'The turn is done.');
  return { stopReason: 'end_turn', exitAfterTurn: session.exitAfterTurn === true };
}

function configOptions(session) {
  return [
    {
      id: 'model',
      name: 'Model',
      description: 'The model this fake pretends to run',
      category: 'model',
      type: 'select',
      currentValue: session.model,
      options: [
        { value: 'auto', name: 'Auto', description: 'Let the agent choose' },
        { value: 'fake-acp', name: 'Fake ACP', description: 'The fake agent' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: session.mode,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'allowAll', name: 'Allow all' },
      ],
    },
  ];
}

function newSession(params) {
  const id = `ses_${randomUUID()}`;
  return {
    id,
    cwd: typeof params.cwd === 'string' ? params.cwd : cwd,
    mcp: mcpServerFrom(params),
    model: 'auto',
    mode: 'default',
    planner: false,
    noComplete: false,
    exitAfterTurn: false,
  };
}

async function openSession(session) {
  sessions.set(session.id, session);
  if (!session.mcp) return;
  try {
    await contactMcp(session.mcp);
  } catch (error) {
    // A session still opens: the agent will fail its tools rather than its handshake.
    logged(session, { mcpError: error instanceof Error ? error.message : String(error) });
  }
}

function finishPrompt(session, id, result) {
  const prompt = pendingPrompts.get(session.id);
  if (!prompt || prompt.id !== id) return;
  pendingPrompts.delete(session.id);
  respond(id, {
    stopReason: result.stopReason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
}

function onPrompt(id, params) {
  const session = sessions.get(params.sessionId);
  if (!session) {
    respondError(id, -32602, `unknown session ${params.sessionId}`);
    return;
  }
  const controller = new AbortController();
  pendingPrompts.set(session.id, { id, controller });
  void runTurn(session, promptText(params), controller.signal).then((result) => {
    finishPrompt(session, id, result);
    if (result.exitAfterTurn && !controller.signal.aborted) setTimeout(() => process.exit(0), 25);
  }).catch((error) => {
    logged(session, { turnError: error instanceof Error ? error.message : String(error) });
    finishPrompt(session, id, { stopReason: 'refusal' });
  });
}

function onCancel(params) {
  const session = sessions.get(params.sessionId);
  if (!session) return;
  const prompt = pendingPrompts.get(session.id);
  if (!prompt) return;
  prompt.controller.abort();
  finishPrompt(session, prompt.id, { stopReason: 'cancelled' });
}

async function handleRequest(id, method, params) {
  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: 1,
        agentInfo: { name: 'fake-acp', title: 'Fake ACP Agent', version: '1.0.105' },
        agentCapabilities: {
          ...(resumable ? { loadSession: true } : {}),
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: true, sse: false },
          sessionCapabilities: resumable ? { resume: {}, close: {} } : { close: {} },
        },
      });
      return;
    case 'session/new': {
      const session = newSession(params);
      await openSession(session);
      respond(id, {
        sessionId: session.id,
        configOptions: configOptions(session),
        modes: {
          currentModeId: session.mode,
          availableModes: [{ id: 'default', name: 'Default' }, { id: 'allowAll', name: 'Allow all' }],
        },
      });
      return;
    }
    case 'session/load':
    case 'session/resume': {
      const session = typeof params.sessionId === 'string'
        ? { ...newSession(params), id: params.sessionId }
        : newSession(params);
      await openSession(session);
      respond(id, { configOptions: configOptions(session) });
      return;
    }
    case 'session/set_config_option': {
      const session = sessions.get(params.sessionId);
      if (!session) {
        respondError(id, -32602, `unknown session ${params.sessionId}`);
        return;
      }
      if (params.configId === 'model' && typeof params.value === 'string') session.model = params.value;
      else if (params.configId === 'mode' && typeof params.value === 'string') session.mode = params.value;
      else {
        respondError(id, -32602, `unknown config option ${params.configId}`);
        return;
      }
      respond(id, { configOptions: configOptions(session) });
      return;
    }
    case 'session/set_mode': {
      const session = sessions.get(params.sessionId);
      if (!session) {
        respondError(id, -32602, `unknown session ${params.sessionId}`);
        return;
      }
      if (typeof params.modeId === 'string') session.mode = params.modeId;
      respond(id, {});
      return;
    }
    case 'session/close': {
      sessions.delete(params.sessionId);
      respond(id, {});
      return;
    }
    case 'session/prompt':
      onPrompt(id, params);
      return;
    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(method, params) {
  if (method === 'session/cancel') onCancel(params);
}

function handleLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (typeof message !== 'object' || message === null) return;
  if (message.method === undefined) {
    const resolve = agentRequests.get(message.id);
    if (!resolve) return;
    agentRequests.delete(message.id);
    resolve(message.error ? { error: message.error } : (message.result ?? {}));
    return;
  }
  if (message.id !== undefined) {
    void handleRequest(message.id, message.method, message.params ?? {}).catch((error) => {
      respondError(message.id, -32603, error instanceof Error ? error.message : String(error));
    });
    return;
  }
  handleNotification(message.method, message.params ?? {});
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', handleLine);
input.on('close', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
