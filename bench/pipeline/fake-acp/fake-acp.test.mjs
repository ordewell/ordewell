import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-acp.mjs');

/** A raw ACP client: the fake's JSON-RPC lines in, and requests/notifications out. */
function start(cwd) {
  const child = spawn(process.execPath, [script], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const messages = [];
  const waiters = [];
  const input = readline.createInterface({ input: child.stdout });
  input.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    messages.push(message);
    for (const waiter of [...waiters]) {
      const index = messages.findIndex(waiter.predicate);
      if (index < 0) continue;
      const [found] = messages.splice(index, 1);
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(found);
    }
  });
  const waitFor = (predicate, what) => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for ${what}; stderr: ${stderr}`));
        }, 10000),
      };
      waiters.push(waiter);
    });
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return { child, waitFor, send };
}

async function open(client, cwd, mcpServers = []) {
  client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
  });
  const init = await client.waitFor((message) => message.id === 1, 'initialize');
  client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers } });
  const session = await client.waitFor((message) => message.id === 2, 'session/new');
  return { init, sessionId: session.result.sessionId };
}

/** The smallest Streamable-HTTP MCP server that records tool calls. */
function mcpStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body || '{}');
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: [] };
      else if (message.method === 'tools/call') {
        calls.push({ name: message.params.name, args: message.params.arguments, authorization: req.headers.authorization });
        result = { content: [{ type: 'text', text: 'ok' }] };
      }
      res.writeHead(message.id === undefined ? 202 : 200, { 'content-type': 'application/json' });
      res.end(message.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/mcp` });
    });
  });
}

/**
 * A test's cleanups, run last-registered first and every one of them, however
 * an earlier one ends. node:test runs `t.after` hooks in the order they were
 * added and skips the rest once one throws. On Windows a directory that is a
 * live process's cwd cannot be removed, so removing the workspace before the
 * fake was stopped threw, the kill never ran, and the live fake held the test
 * file open until CI cancelled the job.
 */
const cleanups = new WeakMap();
function defer(t, cleanup) {
  let stack = cleanups.get(t);
  if (!stack) {
    stack = [];
    cleanups.set(t, stack);
    t.after(async () => {
      const errors = [];
      for (const run of stack.reverse()) {
        try { await run(); } catch (err) { errors.push(err); }
      }
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'cleanup failed');
    });
  }
  stack.push(cleanup);
}

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-acp-'));
  // Windows can hold a dead process's cwd a moment past its exit.
  defer(t, () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function client(t, cwd) {
  const running = start(cwd);
  defer(t, () => stop(running.child));
  return running;
}

/** Kill the fake and wait for its exit, so nothing it holds outlives the test. */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
}

test('answers initialize and session/new as an ACP v1 agent with HTTP MCP', async (t) => {
  const dir = workspace(t);
  const acp = client(t, dir);
  const { init, sessionId } = await open(acp, dir);

  assert.equal(init.result.protocolVersion, 1);
  assert.equal(init.result.agentCapabilities.mcpCapabilities.http, true);
  assert.match(sessionId, /^ses_/);
});

test('asks permission for an edit cue and writes only when allowed', async (t) => {
  const dir = workspace(t);
  const acp = client(t, dir);
  const { sessionId } = await open(acp, dir);

  acp.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'do it <fake-acp>{"edit":{"A.txt":"hello"}}</fake-acp>' }] },
  });
  const call = await acp.waitFor((message) => message.method === 'session/update'
    && message.params.update?.sessionUpdate === 'tool_call', 'the edit tool call');
  assert.equal(call.params.update.kind, 'edit');

  const request = await acp.waitFor((message) => message.method === 'session/request_permission', 'the permission request');
  assert.equal(request.params.toolCall.kind, 'edit');
  assert.equal(request.params.toolCall.title, 'Edit A.txt');

  acp.send({ jsonrpc: '2.0', id: request.id, result: { outcome: 'selected', optionId: 'allow_once' } });
  const answer = await acp.waitFor((message) => message.id === 3, 'the prompt response');

  assert.equal(answer.result.stopReason, 'end_turn');
  assert.equal(fs.readFileSync(path.join(dir, 'A.txt'), 'utf8'), 'hello');
});

test('a denied edit cue leaves the file unwritten', async (t) => {
  const dir = workspace(t);
  const acp = client(t, dir);
  const { sessionId } = await open(acp, dir);

  acp.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'do it <fake-acp>{"edit":{"B.txt":"no"}}</fake-acp>' }] },
  });
  const request = await acp.waitFor((message) => message.method === 'session/request_permission', 'the permission request');
  acp.send({ jsonrpc: '2.0', id: request.id, result: { outcome: 'selected', optionId: 'reject_once' } });
  const answer = await acp.waitFor((message) => message.id === 3, 'the prompt response');

  assert.equal(answer.result.stopReason, 'end_turn');
  assert.equal(fs.existsSync(path.join(dir, 'B.txt')), false);
});

test('a planner cue calls the planner tools with the session\'s Authorization header, and never task_complete', async (t) => {
  const dir = workspace(t);
  const acp = client(t, dir);
  const stub = await mcpStub();
  defer(t, () => { stub.server.closeAllConnections(); stub.server.close(); });
  const { sessionId } = await open(acp, dir, [{
    type: 'http',
    name: 'ordewell',
    url: stub.url,
    headers: [{ name: 'Authorization', value: 'Bearer fake-token' }],
  }]);

  acp.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'plan <fake-acp>{"role":"planner","calls":[["submit_plan",{"goal":"ship it"}]]}</fake-acp>' }] },
  });
  const answer = await acp.waitFor((message) => message.id === 3, 'the prompt response');

  assert.equal(answer.result.stopReason, 'end_turn');
  assert.deepEqual(stub.calls.map((call) => call.name), ['submit_plan']);
  assert.deepEqual(stub.calls[0].args, { goal: 'ship it' });
  assert.equal(stub.calls[0].authorization, 'Bearer fake-token');
});

test('answers a cancelled prompt with stopReason cancelled', async (t) => {
  const dir = workspace(t);
  const acp = client(t, dir);
  const { sessionId } = await open(acp, dir);

  acp.send({
    jsonrpc: '2.0',
    id: 4,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'wait <fake-acp>{"delayMs":5000}</fake-acp>' }] },
  });
  await acp.waitFor((message) => message.method === 'session/update'
    && message.params.update?.sessionUpdate === 'agent_message_chunk', 'the first update');

  acp.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  const answer = await acp.waitFor((message) => message.id === 4, 'the cancelled prompt response');
  assert.equal(answer.result.stopReason, 'cancelled');
});
