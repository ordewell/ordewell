import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OrdewellMcpServer, mcpClientConfig, READ_ONLY_TASK_TOOLS, TASK_TOOLS, PLANNER_TOOLS, plannerToolSet, taskToolSet, toolListing, type McpCredential } from '..';
import { ORDEWELL_TOOL_NAMES } from '../../harness/ordewellBinding';
import { CODEX_ORDEWELL } from '../../harness/codexOrdewell';

/** Who has `post` (ADR-0057 R11): whoever has a board, so a flat role's list grows by nothing. */

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

describe('a task\'s token', () => {
  it('lists `post` beside the rest only where it has a board, and says so to its runner', async () => {
    const server = newServer();
    const post = vi.fn(async () => ({ text: 'Posted.' }));
    const flat = await server.issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1 });
    const flatReadOnly = await server.issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1, readOnly: true });
    const onBoard = await server.issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1, board: true }, { post });
    const readOnlyOnBoard = await server.issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1, readOnly: true, board: true }, { post });

    expect(flat.extraTools).toBeUndefined();
    expect(flatReadOnly.extraTools).toBeUndefined();
    expect(onBoard.extraTools).toEqual(['post']);
    expect(await names(await connect(flat))).toEqual(['task_complete', 'checkpoint', 'read', 'apply_patch']);
    expect(await names(await connect(onBoard))).toEqual(['task_complete', 'checkpoint', 'read', 'post', 'apply_patch']);
    expect(await names(await connect(readOnlyOnBoard))).toEqual(['task_complete', 'checkpoint', 'read', 'post', 'run_command', 'save_patch', 'fetch', 'web_search']);
    await (await connect(onBoard)).callTool({ name: 'post', arguments: { type: 'claim', title: 'It holds' } });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'claim', title: 'It holds' }), expect.anything());
  });

  it('declares `post` read-only, since a harness plan mode refuses a tool that does not', async () => {
    const server = newServer();
    const client = await connect(await server.issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1, readOnly: true, board: true }));
    expect((await client.listTools()).tools.find((t) => t.name === 'post')?.annotations?.readOnlyHint).toBe(true);
  });

  it('refuses a planner\'s entry from a runner, at the call', async () => {
    const server = newServer();
    const post = vi.fn(async () => ({ text: 'Posted.' }));
    const client = await connect(await server.issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1, board: true }, { post }));
    for (const type of ['pin', 'decision']) expect(await client.callTool({ name: 'post', arguments: { type, title: 'Do this' } })).toMatchObject({ isError: true });
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a title of two lines, so a map stays one line an entry', async () => {
    const server = newServer();
    const post = vi.fn(async () => ({ text: 'Posted.' }));
    const client = await connect(await server.issueTaskToken({ sessionId: 's', taskId: 't', attempt: 1, board: true }, { post }));
    expect(await client.callTool({ name: 'post', arguments: { type: 'claim', title: 'One\nTwo' } })).toMatchObject({ isError: true });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('a planner\'s token', () => {
  it('lists `post` and `read` where it may hold delegated tasks, or sits under one, and a flat planner neither', async () => {
    const server = newServer();
    const flat = await server.issuePlannerToken({ sessionId: 's' });
    const delegating = await server.issuePlannerToken({ sessionId: 's', delegates: true });
    const subplanner = await server.issuePlannerToken({ sessionId: 's', subplanner: true });
    expect(flat.extraTools).toBeUndefined();
    expect(delegating.extraTools).toEqual(['read', 'post']);
    expect(subplanner.extraTools).toEqual(['read', 'post', 'task_complete', 'checkpoint']);
    expect(await names(await connect(flat))).toEqual(PLANNER_TOOLS.map((t) => t.name));
  });

  it('takes a planner\'s entries', async () => {
    const server = newServer();
    const post = vi.fn(async () => ({ text: 'Posted.' }));
    const client = await connect(await server.issuePlannerToken({ sessionId: 's', delegates: true }, { post }));
    await client.callTool({ name: 'post', arguments: { type: 'pin', title: 'Keep the v1 routes' } });
    expect(post).toHaveBeenCalledOnce();
  });
});

describe('the flat lists', () => {
  it('hold no `post`, and a set with no board is the flat list itself', () => {
    for (const tools of [TASK_TOOLS, READ_ONLY_TASK_TOOLS, PLANNER_TOOLS]) expect(tools.map((t) => t.name)).not.toContain('post');
    expect(taskToolSet({})).toBe(TASK_TOOLS);
    expect(taskToolSet({ readOnly: true })).toBe(READ_ONLY_TASK_TOOLS);
    expect(plannerToolSet()).toBe(PLANNER_TOOLS);
  });

  it('keep `read` as it is, so a board costs a runner only `post`', () => {
    const read = (tools: typeof TASK_TOOLS) => toolListing(tools).find((t) => t.name === 'read');
    expect(read(taskToolSet({ board: true }))).toEqual(read(TASK_TOOLS));
  });

  it('name the tool a harness must recognise as Ordewell\'s', () => {
    expect(ORDEWELL_TOOL_NAMES).toContain('post');
  });
});

describe('a Codex task', () => {
  it('is told of `post` where it has one, and otherwise as before', () => {
    expect(CODEX_ORDEWELL.taskInstructions({})).not.toContain('post');
    expect(CODEX_ORDEWELL.taskInstructions({ extra: ['post'] })).toContain('`mcp__ordewell__post`');
  });
});
