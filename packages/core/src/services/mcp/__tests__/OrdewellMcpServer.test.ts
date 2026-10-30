import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { request } from 'http';
import {
  OrdewellMcpServer, mcpClientConfig,
  type McpCredential, type TaskCompleteArgs, type CheckpointArgs, type McpToolContext, type McpToolReply,
} from '..';

const servers: OrdewellMcpServer[] = [];
const clients: Client[] = [];

function newServer(): OrdewellMcpServer {
  const server = new OrdewellMcpServer();
  servers.push(server);
  return server;
}

async function connect(credential: McpCredential): Promise<Client> {
  const config = mcpClientConfig(credential);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

describe('OrdewellMcpServer', () => {
  it('starts one listener on first issue and shares it across sessions', async () => {
    const server = newServer();
    expect(server.url).toBeUndefined();

    const task = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 });
    const planner = await server.issuePlannerToken({ sessionId: 's2' });

    expect(task.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(planner.url).toBe(task.url);
    expect(server.url).toBe(task.url);
    expect(task.token).not.toBe(planner.token);

    await connect(task);
    await connect(planner);
  });

  it('lists only the task tools to a task token and only the planner tools to a planner token', async () => {
    const server = newServer();
    const task = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }));
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1' }));

    const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort();
    expect(await names(task)).toEqual(['apply_patch', 'checkpoint', 'read_task', 'task_complete']);
    expect(await names(planner)).toEqual([
      'answer_approval', 'answer_checkpoint', 'edit_plan', 'fetch', 'list_models', 'list_runners', 'load_skill', 'merge_all', 'message_task', 'retry_task', 'run_command',
      'run_plan', 'run_script', 'run_task', 'skip_task', 'stop_run', 'stop_task', 'submit_plan', 'task_diff', 'task_output', 'task_query', 'web_search',
    ]);
  });

  it("gives run_command to a read-only task's token alone, and routes its calls to that attempt's shell (ADR-0046)", async () => {
    const server = newServer();
    const runCommand = vi.fn(async ({ command }: { command: string }, _context: McpToolContext): Promise<McpToolReply> => ({ text: `ran ${command}` }));
    const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1, readOnly: true }, { runCommand });
    const writer = await server.issueTaskToken({ sessionId: 's1', taskId: 't2', attempt: 1 }, { runCommand });
    const readOnly = await connect(credential);
    const change = await connect(writer);

    expect(credential.readOnly).toBe(true);
    expect(mcpClientConfig(credential).readOnly).toBe(true);
    expect(writer.readOnly).toBeUndefined();
    expect(mcpClientConfig(writer).readOnly).toBeUndefined();
    const tools = (await readOnly.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['checkpoint', 'fetch', 'read_task', 'run_command', 'save_patch', 'task_complete', 'web_search']);
    // The hint names what lands, even when a command changes its disposable worktree.
    expect(tools.find((t) => t.name === 'run_command')?.annotations?.readOnlyHint).toBe(true);
    expect((await change.listTools()).tools.map((t) => t.name).sort()).toEqual(['apply_patch', 'checkpoint', 'read_task', 'task_complete']);

    expect(await readOnly.callTool({ name: 'run_command', arguments: { command: 'npm test' } })).toMatchObject({ content: [{ type: 'text', text: 'ran npm test' }], isError: false });
    await expect(change.callTool({ name: 'run_command', arguments: { command: 'npm test' } })).rejects.toThrow(/'run_command' is disabled on this token: read-only tasks only/);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("offers save_patch to a read-only task's token alone, and routes its call to that attempt with the call's signal (ADR-0050)", async () => {
    const server = newServer();
    const savePatch = vi.fn(async (_args: Record<string, never>, context: McpToolContext): Promise<McpToolReply> => ({ text: `saved, signal ${context.signal.aborted ? 'aborted' : 'live'}` }));
    const readOnly = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1, readOnly: true }, { savePatch }));
    const change = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't2', attempt: 1 }, { savePatch }));

    const offered = (await readOnly.listTools()).tools.find((t) => t.name === 'save_patch');
    expect(offered?.annotations?.readOnlyHint).toBe(true);
    expect(offered?.inputSchema).toMatchObject({ type: 'object', properties: {} });
    expect((await change.listTools()).tools.map((t) => t.name)).not.toContain('save_patch');

    expect(await readOnly.callTool({ name: 'save_patch', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'saved, signal live' }], isError: false });
    await expect(change.callTool({ name: 'save_patch', arguments: {} })).rejects.toThrow(/disabled on this token/);
    expect(savePatch).toHaveBeenCalledTimes(1);
  });

  it('answers save_patch as not available where the attempt has no handler for it', async () => {
    const server = newServer();
    const readOnly = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1, readOnly: true }, {}));
    expect(await readOnly.callTool({ name: 'save_patch', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'Invocation error: save_patch is not available in this session — no handler is wired, so the call ran nothing.' }], isError: true });
  });

  it("offers apply_patch to a change task's token alone, and routes its call to that attempt (ADR-0050)", async () => {
    const server = newServer();
    const applyPatch = vi.fn(async (args: { task: string | number; attempt?: number }, _context: McpToolContext): Promise<McpToolReply> => ({ text: `applied ${args.task} attempt ${args.attempt ?? 'latest'}` }));
    const change = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, { applyPatch }));
    const readOnly = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't2', attempt: 1, readOnly: true }, { applyPatch }));

    expect((await change.listTools()).tools.find((t) => t.name === 'apply_patch')?.inputSchema).toMatchObject({ type: 'object', required: ['task'] });
    expect((await readOnly.listTools()).tools.map((t) => t.name)).not.toContain('apply_patch');

    expect(await change.callTool({ name: 'apply_patch', arguments: { task: '#2', attempt: 2 } })).toMatchObject({ content: [{ type: 'text', text: 'applied #2 attempt 2' }], isError: false });
    await expect(readOnly.callTool({ name: 'apply_patch', arguments: { task: '#2' } })).rejects.toThrow(/disabled on this token/);
    expect(applyPatch).toHaveBeenCalledTimes(1);
  });

  it('answers apply_patch as not available where the attempt has no handler for it', async () => {
    const server = newServer();
    const change = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, {}));
    expect(await change.callTool({ name: 'apply_patch', arguments: { task: '#1' } })).toMatchObject({ content: [{ type: 'text', text: 'Invocation error: apply_patch is not available in this session — no handler is wired, so the call ran nothing.' }], isError: true });
  });

  // Claude Code in plan mode refuses any MCP tool not marked read-only, even
  // one pre-allowed with --allowedTools (verified against 2.1.289). The
  // execution tools change what runs, and say so (ADR-0029).
  it('marks every planner read and plan write read-only, the execution tools not, and of the task tools only read_task', async () => {
    const server = newServer();
    const task = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }));
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1' }));

    const hints = Object.fromEntries((await planner.listTools()).tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    const executing = ['run_plan', 'run_task', 'stop_task', 'stop_run', 'retry_task', 'skip_task', 'message_task', 'answer_approval', 'answer_checkpoint', 'merge_all', 'run_script'];
    for (const [name, hint] of Object.entries(hints)) expect(hint, name).toBe(!executing.includes(name));
    expect(Object.keys(hints)).toHaveLength(22);
    expect((await task.listTools()).tools.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([['task_complete', undefined], ['checkpoint', undefined], ['read_task', true], ['apply_patch', undefined]]);
  });

  it('answers an unknown or revoked token with 401, and the SDK client cannot connect with it', async () => {
    const server = newServer();
    const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 });
    const unknown = { url: credential.url, token: 'not-a-token' };

    expect((await rawRequest(unknown, {})).status).toBe(401);
    await expect(connect(unknown)).rejects.toThrow();

    expect((await rawRequest(credential, {})).status).toBe(200);
    server.revoke(credential.token);
    expect((await rawRequest(credential, {})).status).toBe(401);
  });

  it('tells an unknown token, a revoked token and a wrong path apart in its refusal count, never printing the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const server = newServer();
      const revoked = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 });
      const unknown = { url: revoked.url, token: 'not-a-token' };
      const live = await server.issueTaskToken({ sessionId: 's1', taskId: 't2', attempt: 1 });

      expect((await rawRequest(unknown, {})).status).toBe(401);
      server.revoke(revoked.token);
      expect((await rawRequest(revoked, {})).status).toBe(401);
      expect((await rawRequest({ url: live.url.replace(/\/mcp$/, '/other'), token: live.token }, {})).status).toBe(404);

      expect(server.refusals()).toEqual({ unknownToken: 1, revokedToken: 1, wrongPath: 1 });
      const said = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(said).toContain('unknown token');
      expect(said).toContain('revoked token');
      expect(said).toContain('wrong path');
      expect(said).not.toContain(revoked.token);
      expect(said).not.toContain(live.token);
      expect(said).not.toContain(unknown.token);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a call to a tool outside the token\'s role', async () => {
    const server = newServer();
    const submitPlan = vi.fn(async () => ({ text: 'ok' }));
    const task = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }));
    await server.issuePlannerToken({ sessionId: 's1' }, { submitPlan });
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1' }));

    await expect(task.callTool({ name: 'submit_plan', arguments: { tasks: [{ title: 'x' }] } })).rejects.toThrow(/'submit_plan' is disabled on this token: planner tokens only/);
    await expect(planner.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 's' } })).rejects.toThrow(/'task_complete' is disabled on this token: task tokens only/);
    expect(submitPlan).not.toHaveBeenCalled();
  });

  it('keeps the tools a planner token hides out of its list, and refuses a call to one', async () => {
    const server = newServer();
    const fetch = vi.fn(async () => ({ text: 'page' }));
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1', hidden: ['fetch', 'web_search'] }, { fetch }));

    expect((await planner.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'answer_approval', 'answer_checkpoint', 'edit_plan', 'list_models', 'list_runners', 'load_skill', 'merge_all', 'message_task', 'retry_task', 'run_command',
      'run_plan', 'run_script', 'run_task', 'skip_task', 'stop_run', 'stop_task', 'submit_plan', 'task_diff', 'task_output', 'task_query',
    ]);
    await expect(planner.callTool({ name: 'fetch', arguments: { url: 'https://example.com' } })).rejects.toThrow(/'fetch' is disabled on this token: your runner carries its own/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers a call for a tool the token does not serve with the enabled and disabled lists, and un-prefixes a runner's name", async () => {
    const server = newServer();
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1', hidden: ['fetch'] }));

    // Enabled first, then every disabled tool with its reason, then the mended name.
    await expect(planner.callTool({ name: 'ordewell_list_runners', arguments: {} })).rejects.toThrow(
      /unknown tool 'ordewell_list_runners'.\nEnabled: [^\n]*list_runners[^\n]*\nDisabled: [^\n]*fetch \(your runner carries its own\)[^\n]*\nThis server names its tools without a runner's prefix: call 'list_runners'/,
    );
  });

  it("routes each token's calls to the handler it was issued with", async () => {
    const server = newServer();
    const calls: string[] = [];
    const handlerFor = (who: string) => ({
      taskComplete: async (args: TaskCompleteArgs) => {
        calls.push(`${who}:${args.status}:${args.summary}`);
        return { text: `recorded for ${who}` };
      },
    });
    const one = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, handlerFor('s1/t1')));
    const two = await connect(await server.issueTaskToken({ sessionId: 's2', taskId: 't1', attempt: 1 }, handlerFor('s2/t1')));

    const result = await two.callTool({ name: 'task_complete', arguments: { status: 'blocked', summary: 'no key', reason: 'missing API key' } });
    await one.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'built it' } });

    expect(result.content).toEqual([{ type: 'text', text: 'recorded for s2/t1' }]);
    expect(result.isError).toBe(false);
    expect(calls).toEqual(['s2/t1:blocked:no key', 's1/t1:done:built it']);
  });

  it('answers a tool with no handler wired as an invocation error that says nothing ran', async () => {
    const server = newServer();
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1' }));

    const result = await planner.callTool({ name: 'list_runners', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Invocation error: list_runners is not available in this session — no handler is wired, so the call ran nothing.' }]);
  });

  it('rejects arguments that do not match the tool schema without reaching the handler', async () => {
    const server = newServer();
    const taskComplete = vi.fn(async () => ({ text: 'ok' }));
    const task = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, { taskComplete }));

    const result = await task.callTool({ name: 'task_complete', arguments: { status: 'finished', summary: 'x' } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Invocation error: task_complete rejected the call before it ran/);
    expect(JSON.stringify(result.content)).toMatch(/invalid parameter: 'status' — expected one of: done, blocked, failed/);
    expect(taskComplete).not.toHaveBeenCalled();
  });

  it('names the kind of rejection and the slot for every rejected parameter', async () => {
    const server = newServer();
    const editPlan = vi.fn(async () => ({ text: 'ok' }));
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1' }, { editPlan }));

    const missing = await planner.callTool({ name: 'edit_plan', arguments: {} });
    expect(JSON.stringify(missing.content)).toMatch(/wrong number of parameters: 'ops' is required and missing/);

    const wrongType = await planner.callTool({ name: 'edit_plan', arguments: { ops: 'x' } });
    expect(JSON.stringify(wrongType.content)).toMatch(/parameter parsing failed: 'ops' expected array, the call sent string/);

    const emptyOps = await planner.callTool({ name: 'edit_plan', arguments: { ops: [] } });
    expect(JSON.stringify(emptyOps.content)).toMatch(/wrong number of parameters: 'ops' Too small/);

    const badSlot = await planner.callTool({ name: 'edit_plan', arguments: { ops: [{ op: 'update', taskId: '#1' }] } });
    expect(JSON.stringify(badSlot.content)).toMatch(/wrong number of parameters: 'ops\[0\].changes' is required and missing/);

    const badValue = await planner.callTool({ name: 'edit_plan', arguments: { ops: [{ op: 'renumber', taskId: '#1', changes: {} }] } });
    expect(JSON.stringify(badValue.content)).toMatch(/invalid parameter: 'ops\[0\].op' matches none of the accepted values/);
    expect(editPlan).not.toHaveBeenCalled();
  });

  it('refuses oversized reference strings by field and leaves the token open for a corrected completion', async () => {
    const server = newServer();
    const taskComplete = vi.fn(async () => ({ text: 'ok' }));
    const task = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, { taskComplete }));
    const long = 'x'.repeat(200_000);
    for (const ref of [{ kind: 'file', path: long }, { kind: 'commit', sha: 'abcd', repo: long }, { kind: 'url', url: `https://example.com/${long}` }, { kind: 'task', task: long }, { kind: 'task', task: 't1', finding: `F1${'0'.repeat(200_000)}` }]) {
      for (const extra of [{ artifacts: [ref] }, { findings: [{ severity: 'major', title: 'Check', evidence: [ref] }] }]) {
        const result = await task.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Short', ...extra } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('2000');
      }
    }
    expect(taskComplete).not.toHaveBeenCalled();
    expect((await task.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Short', artifacts: [{ kind: 'file', path: 'src/a.ts' }] } })).isError).toBeFalsy();
    expect(taskComplete).toHaveBeenCalledTimes(1);
  });

  it('aborts a waiting call when its token is revoked', async () => {
    const server = newServer();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const checkpoint = async (_args: CheckpointArgs, { signal }: McpToolContext) => {
      entered();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      return { text: 'The attempt ended before the checkpoint was answered.', isError: true };
    };
    const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, { checkpoint });
    const task = await connect(credential);

    const call = task.callTool({ name: 'checkpoint', arguments: { question: 'Which port?' } });
    await waiting;
    server.revoke(credential.token);

    expect((await call).content).toEqual([{ type: 'text', text: 'The attempt ended before the checkpoint was answered.' }]);
  });

  // Stateless: the cancellation is a request of its own, which reaches the call only through its token.
  it('aborts a call its caller cancels, and no call of another token', async () => {
    const server = newServer();
    const aborted: string[] = [];
    const entered: string[] = [];
    const fetch = async ({ url }: { url: string }, { signal }: McpToolContext): Promise<McpToolReply> => {
      entered.push(url);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      aborted.push(url);
      return { text: 'cancelled', isError: true };
    };
    const mine = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1, readOnly: true }, { fetch }));
    const other = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't2', attempt: 1, readOnly: true }, { fetch }));

    const cancel = new AbortController();
    const call = mine.callTool({ name: 'fetch', arguments: { url: 'https://a.example/' } }, undefined, { signal: cancel.signal });
    void other.callTool({ name: 'fetch', arguments: { url: 'https://b.example/' } }).catch(() => undefined);
    await vi.waitFor(() => expect(entered).toHaveLength(2));
    cancel.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(aborted).toEqual(['https://a.example/']));
  });

  // Claude Code aborts an HTTP tool call that goes silent for its idle timeout;
  // a progress notification is what resets that clock.
  it('sends progress notifications while a call is still waiting', async () => {
    const server = new OrdewellMcpServer({ heartbeatMs: 10 });
    servers.push(server);
    let answer!: (reply: McpToolReply) => void;
    const checkpoint = () => new Promise<McpToolReply>((resolve) => { answer = resolve; });
    const task = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, { checkpoint }));
    const beats: number[] = [];

    const call = task.callTool({ name: 'checkpoint', arguments: { question: 'Which port?' } }, undefined, {
      onprogress: ({ progress }) => beats.push(progress),
    });
    await vi.waitFor(() => expect(beats.length).toBeGreaterThanOrEqual(3));
    answer({ text: 'continue' });

    expect((await call).content).toEqual([{ type: 'text', text: 'continue' }]);
    expect(beats).toEqual([...beats].sort((a, b) => a - b));
    expect(new Set(beats).size).toBe(beats.length);
    const settled = beats.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(beats).toHaveLength(settled);
  });

  it('refuses a request whose Host is not the bound loopback address, or that carries an Origin', async () => {
    const server = newServer();
    const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 });
    const { port } = new URL(credential.url);

    expect((await rawRequest(credential, { host: `localhost:${port}` })).status).toBe(403);
    expect((await rawRequest(credential, { host: `evil.example:${port}` })).status).toBe(403);
    expect((await rawRequest(credential, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await rawRequest(credential, {})).status).toBe(200);
  });

  it('closes the port on dispose', async () => {
    const server = new OrdewellMcpServer();
    const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 });

    await server.dispose();

    expect(server.url).toBeUndefined();
    await expect(fetch(credential.url, { method: 'POST' })).rejects.toThrow();
  });

  it('disposes while a call is still open', async () => {
    const server = new OrdewellMcpServer();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const checkpoint = () => {
      entered();
      return new Promise<McpToolReply>(() => {});
    };
    const task = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, { checkpoint }));
    const call = task.callTool({ name: 'checkpoint', arguments: { question: 'Which port?' } });
    await waiting;

    await server.dispose();

    await expect(call).rejects.toThrow();
  });
});

/** A bare initialize over node:http, which unlike fetch lets a test set Host. */
function rawRequest(credential: McpCredential, headers: Record<string, string>): Promise<{ status: number }> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
  });
  return new Promise((resolve, reject) => {
    const req = request(credential.url, {
      method: 'POST',
      headers: {
        ...mcpClientConfig(credential).headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
    }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('task read schemas', () => {
  it('validates attempt and event kinds before routing a read, and exposes diff paging', async () => {
    const server = newServer();
    const taskOutput = vi.fn(async () => ({ text: 'log' }));
    const taskDiff = vi.fn(async () => ({ text: 'diff' }));
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1' }, { taskOutput, taskDiff }));
    for (const args of [{ task: '#1', attempt: 0 }, { task: '#1', attempt: 1.5 }, { task: '#1', kinds: ['invalid'] }, { task: '#1', since: -1 }]) {
      expect((await planner.callTool({ name: 'task_output', arguments: args })).isError).toBe(true);
    }
    expect(taskOutput).not.toHaveBeenCalled();
    await planner.callTool({ name: 'task_output', arguments: { task: '#1', attempt: 2, kinds: ['tool_call', 'error', 'usage'], since: 10 } });
    expect(taskOutput).toHaveBeenCalledWith({ task: '#1', attempt: 2, kinds: ['tool_call', 'error', 'usage'], since: 10 }, expect.anything());
    await planner.callTool({ name: 'task_diff', arguments: { task: '#1', repo: 'api', path: 'file.ts', lines: 20, since: 3 } });
    expect(taskDiff).toHaveBeenCalledWith({ task: '#1', repo: 'api', path: 'file.ts', lines: 20, since: 3 }, expect.anything());
    expect((await planner.callTool({ name: 'task_diff', arguments: { task: '#1', since: -1 } })).isError).toBe(true);
  });
});
