import { describe, it, expect, afterEach, vi } from 'vitest';
import { OrdewellMcpServer, mcpClientConfig, type TaskCompleteArgs } from '../mcp';
import { ACP_ERROR } from '../harness/acpSchema';
import type { FakeAgentProcess } from './harnessTestKit';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';

/** A client, as far as these tests need one: lines out, lines in. */
function launch(steps: FakeAcpStep[]) {
  const kit = fakeAcpSpawn(steps);
  const proc = kit.spawn('fake-acp', [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'], cwd: '/work' }) as unknown as FakeAgentProcess;
  const inbound: Array<Record<string, unknown>> = [];
  let pending = '';
  proc.stdout!.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    for (let nl = pending.indexOf('\n'); nl >= 0; nl = pending.indexOf('\n')) {
      inbound.push(JSON.parse(pending.slice(0, nl)) as Record<string, unknown>);
      pending = pending.slice(nl + 1);
    }
  });
  const send = (message: object) => { proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };
  // Writes reach the agent on a microtask, and the agent's own steps may be async.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { agent: kit.agent, proc, inbound, send, settle };
}

const INIT = { protocolVersion: 1 };
const NEW_SESSION = { cwd: '/work', mcpServers: [] };

describe('FakeAcpAgent', () => {
  describe('expect', () => {
    it('answers a request with the reply, under the request id', async () => {
      const { inbound, send, settle } = launch([{ expect: 'initialize', reply: { protocolVersion: 1 } }]);
      send({ id: 7, method: 'initialize', params: INIT });
      await settle();
      expect(inbound).toEqual([{ jsonrpc: '2.0', id: 7, result: { protocolVersion: 1 } }]);
    });

    it('answers with an error when the step has one', async () => {
      const { inbound, send, settle } = launch([{ expect: 'session/new', error: { code: ACP_ERROR.authRequired, message: 'Sign in' } }]);
      send({ id: 1, method: 'session/new', params: NEW_SESSION });
      await settle();
      expect(inbound).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Sign in' } }]);
    });

    it('lets a reply be built from the params it answers', async () => {
      const { inbound, send, settle } = launch([{ expect: 'session/new', reply: (params: unknown) => ({ sessionId: `s-${(params as { cwd: string }).cwd}` }) }]);
      send({ id: 1, method: 'session/new', params: NEW_SESSION });
      await settle();
      expect(inbound[0]).toMatchObject({ result: { sessionId: 's-/work' } });
    });

    it('takes a notification without answering it', async () => {
      const { agent, inbound, send, settle } = launch([{ expect: 'session/cancel' }]);
      send({ method: 'session/cancel', params: { sessionId: 's1' } });
      await settle();
      expect(inbound).toEqual([]);
      expect(agent.done).toBe(true);
    });

    it('holds messages that arrive before their step, and takes them in order', async () => {
      const { agent, inbound, send, settle } = launch([
        { expect: 'initialize', reply: { protocolVersion: 1 } },
        { expect: 'session/new', reply: { sessionId: 's1' } },
      ]);
      send({ id: 1, method: 'initialize', params: INIT });
      send({ id: 2, method: 'session/new', params: NEW_SESSION });
      await settle();
      expect(inbound.map((m) => m.id)).toEqual([1, 2]);
      expect(agent.received.map((m) => m.method)).toEqual(['initialize', 'session/new']);
    });
  });

  describe('a response sent after other steps', () => {
    it('sends notifications between a request and its answer', async () => {
      const update = { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } };
      const { inbound, send, settle } = launch([
        { expect: 'session/prompt' },
        { notify: 'session/update', params: update },
        { answer: { stopReason: 'end_turn' } },
      ]);
      send({ id: 3, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'go' }] } });
      await settle();
      expect(inbound).toEqual([
        { jsonrpc: '2.0', method: 'session/update', params: update },
        { jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } },
      ]);
    });

    it('fails an open request with an error', async () => {
      const { inbound, send, settle } = launch([{ expect: 'session/prompt' }, { fail: { code: ACP_ERROR.internalError, message: 'boom' } }]);
      send({ id: 3, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
      await settle();
      expect(inbound).toEqual([{ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'boom' } }]);
    });

    it('answers the open request of the method named by `to`', async () => {
      const { inbound, send, settle } = launch([
        { expect: 'session/prompt' },
        { expect: 'session/set_mode' },
        { answer: {}, to: 'session/prompt' },
        { answer: {}, to: 'session/set_mode' },
      ]);
      send({ id: 1, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
      send({ id: 2, method: 'session/set_mode', params: { sessionId: 's1', modeId: 'code' } });
      await settle();
      expect(inbound.map((m) => m.id)).toEqual([1, 2]);
    });

    it('records a step that answers nothing, rather than hanging', async () => {
      const { agent, settle } = launch([{ answer: {} }]);
      await settle();
      expect(agent.problems).toEqual(['no open request to answer']);
    });
  });

  describe('request', () => {
    it('sends a request, holds the script until the client answers, and records the answer', async () => {
      const permission = { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] };
      const { agent, inbound, send, settle } = launch([
        { request: 'session/request_permission', params: permission },
        { notify: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'plan', entries: [] } } },
      ]);
      await settle();
      expect(inbound.map((m) => m.method)).toContain('session/request_permission');
      expect(inbound.some((m) => m.method === 'session/update')).toBe(false);

      send({ id: inbound.find((m) => m.method === 'session/request_permission')!.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
      await settle();
      expect(agent.answers).toEqual([{ method: 'session/request_permission', result: { outcome: { outcome: 'selected', optionId: 'allow' } } }]);
      expect(inbound.some((m) => m.method === 'session/update')).toBe(true);
    });

    it('records an error answer', async () => {
      const { agent, inbound, send, settle } = launch([{ expect: 'initialize', reply: INIT }, { request: 'fs/read_text_file', params: { sessionId: 's1', path: '/x' } }]);
      send({ id: 1, method: 'initialize', params: INIT });
      await settle();
      send({ id: inbound.find((m) => m.method === 'fs/read_text_file')!.id, error: { code: ACP_ERROR.methodNotFound, message: 'no' } });
      await settle();
      expect(agent.answers).toEqual([{ method: 'fs/read_text_file', error: { code: -32601, message: 'no' } }]);
      expect(agent.done).toBe(true);
    });
  });

  describe('going off script', () => {
    it('answers an unexpected request "method not found" and keeps waiting for the expected one', async () => {
      const { agent, inbound, send, settle } = launch([{ expect: 'initialize', reply: INIT }]);
      send({ id: 1, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
      await settle();
      expect(inbound).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: session/prompt' } }]);
      expect(agent.unexpected.map((m) => m.method)).toEqual(['session/prompt']);

      send({ id: 2, method: 'initialize', params: INIT });
      await settle();
      expect(agent.done).toBe(true);
    });

    it('records an unexpected notification without answering it', async () => {
      const { agent, inbound, send, settle } = launch([{ expect: 'initialize', reply: INIT }]);
      send({ method: 'session/cancel', params: { sessionId: 's1' } });
      await settle();
      expect(inbound).toEqual([]);
      expect(agent.unexpected).toHaveLength(1);
    });

    it('answers params that do not fit the schema "invalid params", and does not take them', async () => {
      const { agent, inbound, send, settle } = launch([{ expect: 'session/new', reply: { sessionId: 's1' } }]);
      send({ id: 1, method: 'session/new', params: { cwd: '/work' } });
      await settle();
      expect(inbound[0]).toMatchObject({ id: 1, error: { code: ACP_ERROR.invalidParams } });
      expect(agent.invalid).toHaveLength(1);
      expect(agent.invalid[0].error).toContain('mcpServers');
      expect(agent.received).toEqual([]);
      expect(agent.done).toBe(false);
    });

    it('ignores a response to a request it never sent, and a line that is not JSON', async () => {
      const { agent, proc, send, settle } = launch([{ expect: 'initialize', reply: INIT }]);
      send({ id: 99, result: {} });
      proc.stdin!.write('not json\n');
      await settle();
      expect(agent.answers).toEqual([]);
      expect(agent.done).toBe(false);
    });
  });

  describe('records', () => {
    it('keeps every request and notification it took, with params and id', async () => {
      const { agent, send, settle } = launch([
        { expect: 'initialize', reply: INIT },
        { expect: 'session/new', reply: { sessionId: 's1' } },
        { expect: 'session/cancel' },
      ]);
      send({ id: 1, method: 'initialize', params: INIT });
      send({ id: 2, method: 'session/new', params: NEW_SESSION });
      send({ method: 'session/cancel', params: { sessionId: 's1' } });
      await settle();
      expect(agent.received).toEqual([
        { method: 'initialize', params: INIT, id: 1 },
        { method: 'session/new', params: NEW_SESSION, id: 2 },
        { method: 'session/cancel', params: { sessionId: 's1' } },
      ]);
      expect(agent.requests('session/new')).toHaveLength(1);
      expect(agent.lastParams).toEqual({ sessionId: 's1' });
    });

    it('resolves `finished` once the script has run to its end', async () => {
      const { send, agent } = launch([{ expect: 'initialize', reply: INIT }]);
      send({ id: 1, method: 'initialize', params: INIT });
      await agent.finished;
      expect(agent.done).toBe(true);
    });

    it('is finished at once with an empty script', async () => {
      await launch([]).agent.finished;
    });
  });

  describe('run', () => {
    it('runs a function at its place in the script, with the agent', async () => {
      const seen: string[] = [];
      const { agent, send, settle } = launch([
        { expect: 'initialize', reply: INIT },
        { run: (a) => { seen.push(...a.received.map((m) => m.method)); } },
      ]);
      send({ id: 1, method: 'initialize', params: INIT });
      await settle();
      expect(seen).toEqual(['initialize']);
      expect(agent.done).toBe(true);
    });

    it('records a function that throws and carries on', async () => {
      const { agent, settle } = launch([{ run: () => { throw new Error('nope'); } }]);
      await settle();
      expect(agent.problems).toEqual(['run: nope']);
      expect(agent.done).toBe(true);
    });
  });

  describe('the process', () => {
    it('ends with the code it is given', async () => {
      const { agent, proc } = launch([]);
      const exited = new Promise<number | null>((resolve) => proc.once('exit', resolve));
      await agent.close(3);
      expect(await exited).toBe(3);
    });
  });
});

describe('FakeAcpAgent calling the MCP server it was given', () => {
  const servers: OrdewellMcpServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.dispose()));
  });

  async function issue(taskComplete: (args: TaskCompleteArgs) => Promise<{ text: string }>) {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, { taskComplete });
    const config = mcpClientConfig(credential);
    return {
      mcpServers: [{ type: 'http', name: config.name, url: config.url, headers: Object.entries(config.headers).map(([name, value]) => ({ name, value })) }],
    };
  }

  it('makes a real task_complete call with the Authorization header from session/new', async () => {
    const taskComplete = vi.fn(async (_args: TaskCompleteArgs) => ({ text: 'recorded' }));
    const { mcpServers } = await issue(taskComplete);
    const { agent, send, settle } = launch([
      { expect: 'session/new', reply: { sessionId: 's1' } },
      { callMcp: { tool: 'task_complete', args: { status: 'done', summary: 'built it' } } },
    ]);
    send({ id: 1, method: 'session/new', params: { cwd: '/work', mcpServers } });
    await vi.waitFor(() => expect(agent.done).toBe(true));
    await settle();

    expect(taskComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', summary: 'built it' }), expect.anything());
    expect(agent.mcpCalls).toHaveLength(1);
    expect(agent.mcpCalls[0].result).toMatchObject({ content: [{ type: 'text', text: 'recorded' }] });
    expect(agent.problems).toEqual([]);
    await agent.close();
  });

  it('exposes the servers it was given, with their headers by name', async () => {
    const { mcpServers } = await issue(async () => ({ text: 'ok' }));
    const { agent, send, settle } = launch([{ expect: 'session/new', reply: { sessionId: 's1' } }]);
    send({ id: 1, method: 'session/new', params: { cwd: '/work', mcpServers } });
    await settle();
    expect(agent.mcpServers).toEqual([{ type: 'http', name: 'ordewell', url: mcpServers[0].url, headers: { Authorization: expect.stringMatching(/^Bearer /) } }]);
  });

  it('records, rather than throws, a call when the client gave no such server', async () => {
    const { agent, send, settle } = launch([
      { expect: 'session/new', reply: { sessionId: 's1' } },
      { callMcp: { tool: 'task_complete' } },
    ]);
    send({ id: 1, method: 'session/new', params: NEW_SESSION });
    await settle();
    expect(agent.problems).toEqual(['callMcp task_complete: session/new gave no http MCP server named "ordewell"']);
  });

  it('is refused by the server when the header it was given is wrong', async () => {
    const { mcpServers } = await issue(async () => ({ text: 'ok' }));
    const bad = mcpServers.map((s) => ({ ...s, headers: [{ name: 'Authorization', value: 'Bearer not-it' }] }));
    const { agent, send, settle } = launch([
      { expect: 'session/new', reply: { sessionId: 's1' } },
      { callMcp: { tool: 'task_complete', args: { status: 'done', summary: 'x' } } },
    ]);
    send({ id: 1, method: 'session/new', params: { cwd: '/work', mcpServers: bad } });
    await settle();
    await vi.waitFor(() => expect(agent.problems).toHaveLength(1));
    expect(agent.mcpCalls).toEqual([]);
  });
});
