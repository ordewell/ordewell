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
    expect(await names(task)).toEqual(['checkpoint', 'task_complete']);
    expect(await names(planner)).toEqual(['edit_plan', 'list_models', 'list_runners', 'load_skill', 'submit_plan', 'task_output', 'task_query']);
  });

  // Claude Code in plan mode refuses any MCP tool not marked read-only, even
  // one pre-allowed with --allowedTools (verified against 2.1.289).
  it('marks every planner tool read-only, and no task tool', async () => {
    const server = newServer();
    const task = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }));
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1' }));

    expect((await planner.listTools()).tools.map((t) => t.annotations?.readOnlyHint)).toEqual([true, true, true, true, true, true, true]);
    expect((await task.listTools()).tools.map((t) => t.annotations?.readOnlyHint)).toEqual([undefined, undefined]);
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

  it('refuses a call to a tool outside the token\'s role', async () => {
    const server = newServer();
    const submitPlan = vi.fn(async () => ({ text: 'ok' }));
    const task = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }));
    await server.issuePlannerToken({ sessionId: 's1' }, { submitPlan });
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1' }));

    await expect(task.callTool({ name: 'submit_plan', arguments: { tasks: [{ title: 'x' }] } })).rejects.toThrow(/Unknown tool/);
    await expect(planner.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 's' } })).rejects.toThrow(/Unknown tool/);
    expect(submitPlan).not.toHaveBeenCalled();
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

  it('answers a tool with no handler wired as not available', async () => {
    const server = newServer();
    const planner = await connect(await server.issuePlannerToken({ sessionId: 's1' }));

    const result = await planner.callTool({ name: 'list_runners', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'list_runners is not available in this session.' }]);
  });

  it('rejects arguments that do not match the tool schema without reaching the handler', async () => {
    const server = newServer();
    const taskComplete = vi.fn(async () => ({ text: 'ok' }));
    const task = await connect(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, { taskComplete }));

    const result = await task.callTool({ name: 'task_complete', arguments: { status: 'finished', summary: 'x' } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Invalid task_complete arguments/);
    expect(taskComplete).not.toHaveBeenCalled();
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
