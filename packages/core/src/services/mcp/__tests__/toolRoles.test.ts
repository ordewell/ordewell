import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OrdewellMcpServer, mcpClientConfig, type McpCredential } from '..';

/** Each role's tool set, as a token is served it (ADR-0057 R11, R12). */

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

const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

describe('a role\'s tool set (R11)', () => {
  it('reads the record with `read`, and keeps `read_task` as an alias at the call that no list names', async () => {
    const readTask = vi.fn(async () => ({ text: 'its handoff' }));
    const server = newServer();
    const task = await connect(await server.issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1 }, { readTask }));

    expect(await names(task)).toEqual(['task_complete', 'checkpoint', 'read', 'apply_patch']);
    expect(await task.callTool({ name: 'read', arguments: { task: '#1' } })).toMatchObject({ content: [{ text: 'its handoff' }] });
    expect(await task.callTool({ name: 'read_task', arguments: { task: '#1' } })).toMatchObject({ content: [{ text: 'its handoff' }] });
    expect(readTask).toHaveBeenCalledTimes(2);
  });

  it('does not vary by attempt: a role has one list, in one order, whichever attempt asks', async () => {
    const server = newServer();
    const first = await names(await connect(await server.issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1 })));
    const second = await names(await connect(await server.issueTaskToken({ sessionId: 's', taskId: 'u', attempt: 7 })));
    const readOnlyFirst = await names(await connect(await server.issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1, readOnly: true })));
    const readOnlySecond = await names(await connect(await server.issueTaskToken({ sessionId: 's', taskId: 'u', attempt: 7, readOnly: true })));
    expect(second).toEqual(first);
    expect(readOnlySecond).toEqual(readOnlyFirst);
    expect(readOnlyFirst).toEqual(['task_complete', 'checkpoint', 'read', 'run_command', 'save_patch', 'fetch', 'web_search']);
  });

  it('gives a planner holding delegated tasks `read`, and pre-allows it, and a flat planner neither', async () => {
    const server = newServer();
    const readTask = vi.fn(async () => ({ text: 'a subtree\'s handoff' }));
    const flat = await server.issuePlannerToken({ sessionId: 's' });
    const delegating = await server.issuePlannerToken({ sessionId: 's', delegates: true }, { readTask });

    expect(await names(await connect(flat))).not.toContain('read');
    expect(flat.extraTools).toBeUndefined();
    const client = await connect(delegating);
    expect(await names(client)).toContain('read');
    expect(delegating.extraTools).toEqual(['read', 'post']);
    expect(await client.callTool({ name: 'read', arguments: { task: '3:#4/F1' } })).toMatchObject({ content: [{ text: 'a subtree\'s handoff' }] });
  });

  it('holds a subplanner\'s list in one order, its own tools last', async () => {
    const server = newServer();
    const listed = await names(await connect(await server.issuePlannerToken({ sessionId: 's', delegates: true, subplanner: true })));
    expect(listed.slice(-4)).toEqual(['read', 'post', 'task_complete', 'checkpoint']);
  });
});

describe('what only a subplanner\'s report takes (R2)', () => {
  const report = { status: 'done', summary: 'It holds.', promote: ['#1/F1'], open: ['#2/F2'] };

  it('reaches its handler on a subplanner\'s token', async () => {
    const taskComplete = vi.fn(async () => ({ text: 'Recorded.' }));
    const client = await connect(await newServer().issuePlannerToken({ sessionId: 's', subplanner: true }, { taskComplete }));
    expect(await client.callTool({ name: 'task_complete', arguments: report })).toMatchObject({ content: [{ text: 'Recorded.' }] });
    expect(taskComplete).toHaveBeenCalledWith(expect.objectContaining({ promote: ['#1/F1'], open: ['#2/F2'] }), expect.anything());
  });

  it('is refused on a runner\'s token, and nothing is recorded', async () => {
    const taskComplete = vi.fn(async () => ({ text: 'Recorded.' }));
    const client = await connect(await newServer().issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1 }, { taskComplete }));
    const reply = await client.callTool({ name: 'task_complete', arguments: report });
    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply.content)).toContain('\'promote\' is a subplanner\'s');
    expect(taskComplete).not.toHaveBeenCalled();
  });

  it('holds promote to eight', async () => {
    const taskComplete = vi.fn(async () => ({ text: 'Recorded.' }));
    const client = await connect(await newServer().issuePlannerToken({ sessionId: 's', subplanner: true }, { taskComplete }));
    const reply = await client.callTool({ name: 'task_complete', arguments: { ...report, promote: Array.from({ length: 9 }, (_, i) => `#${i + 1}/F1`) } });
    expect(reply.isError).toBe(true);
    expect(taskComplete).not.toHaveBeenCalled();
  });
});

describe('plain tools/call (R12)', () => {
  it('offers tools and nothing else: no tasks, subscriptions or sampling', async () => {
    const client = await connect(await newServer().issuePlannerToken({ sessionId: 's' }));
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
  });
});
