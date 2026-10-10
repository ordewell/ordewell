import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from '../OpenCodeAdapter';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, SpawnFn, TaskStartOptions } from '../AgentAdapter';
import { fakeSpawn, sseResponse, type FakeEventStream } from '../../__tests__/harnessTestKit';
import { OPENCODE_PLANNER_PERMISSION } from '../openCodeOrdewell';

/**
 * OpenCode 2.x (`opencode serve`, the `/api` surface), recorded at v2.0.22: a
 * session carries its model, agent and rules, a prompt is queued and returns at
 * once, and a turn ends on `session.execution.*` — read from `/api/event`.
 */

const BASE = 'http://127.0.0.1:4096';
const SES = 'ses_v2';
const CHILD = 'ses_child';

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

type Reply = unknown | { status: number; body?: unknown };

function fakeServer(routes: Record<string, (body: unknown) => Reply | Promise<Reply>> = {}) {
  const requests: Recorded[] = [];
  const streams: FakeEventStream[] = [];

  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    const path = String(input).replace(BASE, '');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method, path, authorization: headers.get('authorization'), body });

    if (path === '/api/event') {
      const { response, stream } = sseResponse(init);
      streams.push(stream);
      return response;
    }

    const key = `${method} ${path}`;
    let reply: Reply;
    if (routes[key]) reply = await routes[key](body);
    else if (key === 'GET /api/info') reply = { version: '2.0.22' };
    else if (key === 'POST /api/session') reply = { data: { id: SES } };
    else if (key === 'GET /api/session/active') reply = { data: {} };
    else if (key.endsWith('/message') && method === 'GET') reply = { data: [] };
    else if (key.endsWith('/prompt')) reply = { data: { id: 'msg_user', type: 'user' } };
    else if (method === 'PUT') reply = { status: 204 };
    else reply = {};
    const shaped = typeof reply === 'object' && reply !== null && 'status' in reply && typeof (reply as { status: unknown }).status === 'number'
      ? reply as { status: number; body?: unknown }
      : { status: 200, body: reply };
    return {
      ok: shaped.status >= 200 && shaped.status < 300,
      status: shaped.status,
      statusText: String(shaped.status),
      json: async () => {
        if (shaped.body === undefined) throw new SyntaxError('no body');
        return shaped.body;
      },
    } as unknown as Response;
  };

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    requests,
    async stream(n = 0): Promise<FakeEventStream> {
      for (let i = 0; i < 200 && streams.length <= n; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (streams.length <= n) throw new Error(`event stream ${n} never opened`);
      return streams[n];
    },
  };
}

function taskStart(overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return {
    kind: 'task',
    cwd: '/repo/.ordewell/worktrees/run/1-task',
    mode: 'build',
    model: 'opencode-go/deepseek-v4.1-flash',
    flags: { permissionMode: 'build', modeSettings: { approvals: 'auto' } },
    ...overrides,
  };
}

function plannerStart(overrides: Record<string, unknown> = {}): AgentStartOptions {
  return { kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', model: 'opencode-go/deepseek-v4.1-flash', ...overrides } as AgentStartOptions;
}

async function start(server: ReturnType<typeof fakeServer>, opts: AgentStartOptions = taskStart()) {
  const spawned = fakeSpawn([]);
  const envs: NodeJS.ProcessEnv[] = [];
  const spawn: SpawnFn = (cmd, argv, options) => {
    envs.push(options.env);
    return spawned.spawn(cmd, argv, options);
  };
  const deps: AgentProcessDeps = {
    spawn,
    fetch: server.fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  const adapter = new OpenCodeAdapter(deps);
  const started = adapter.start(opts);
  for (let i = 0; i < 50 && spawned.processes.length === 0; i++) await Promise.resolve();
  spawned.processes[0].emitStdout(`server listening on ${BASE}\n`);
  await started;
  return { adapter, spawned, env: envs[0] };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  if (!condition()) throw new Error('condition never held');
}

function basic(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

const frame = (type: string, data: Record<string, unknown>, sessionID = SES) => ({ type, data: { sessionID, ...data } });
const started = (sessionID = SES) => frame('session.execution.started', {}, sessionID);
const succeeded = () => frame('session.execution.succeeded', {});
const MSG = 'msg_a';
const call = (id: string, input: Record<string, unknown>, name: string, sessionID = SES, message = MSG) => [
  frame('session.tool.input.started', { assistantMessageID: message, id, name }, sessionID),
  frame('session.tool.called', { assistantMessageID: message, id, input, executed: false }, sessionID),
];
const permissionAsk = (id: string, sessionID = SES) => ({
  type: 'permission.asked',
  data: { id, sessionID, action: 'shell', resources: ['echo hi'], save: ['echo *'], source: { type: 'tool', messageID: MSG, id: 'call_1' } },
});

describe('OpenCode 2.x — start', () => {
  it('takes a 2.x server by its /api/info, and secures a planner as it does a task', async () => {
    const server = fakeServer();
    const { adapter, env } = await start(server, plannerStart());

    const password = env.OPENCODE_SERVER_PASSWORD;
    expect(password).toBeTruthy();
    expect(server.requests.some((r) => r.path === '/session')).toBe(false);
    for (const request of server.requests) expect(request.authorization).toBe(basic(password!));
    expect(adapter.nativeSessionId()).toBe(SES);
    adapter.dispose();
  });

  it('creates the planner session read-only: plan agent, model, and Ordewell\'s permission policy', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, plannerStart({ effort: 'high' }));

    const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session');
    expect(created?.body).toEqual({
      agent: 'plan',
      model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'high' },
      permissions: Object.entries(OPENCODE_PLANNER_PERMISSION).map(([action, effect]) => ({ action, resource: '*', effect })),
    });
    const prompt = server.requests.find((r) => r.method === 'PUT');
    expect(prompt?.path).toBe(`/api/experimental/session/${SES}/instructions/entries/ordewell-planner`);
    expect(prompt?.body).toEqual({ value: 'PLAN' });
    adapter.dispose();
  });

  it('creates a task session in its mode, withholding only the question tool', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart({ flags: { permissionMode: 'build', effort: 'max', modeSettings: {} } }));

    const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session');
    expect(created?.body).toEqual({
      agent: 'build',
      model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'max' },
      permissions: [{ action: 'question', resource: '*', effect: 'deny' }],
    });
    expect(server.requests.some((r) => r.method === 'PUT')).toBe(false);
    adapter.dispose();
  });

  it('resumes a session the server knows, and re-applies the plan\'s model and agent', async () => {
    const server = fakeServer({ [`GET /api/session/${SES}`]: () => ({ data: { id: SES } }) });
    const { adapter } = await start(server, taskStart({ resumeSessionId: SES }));

    expect(server.requests.some((r) => r.method === 'POST' && r.path === '/api/session')).toBe(false);
    expect(server.requests.find((r) => r.path === `/api/session/${SES}/model`)?.body).toEqual({ model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' } });
    expect(server.requests.find((r) => r.path === `/api/session/${SES}/agent`)?.body).toEqual({ agent: 'build' });
    adapter.dispose();
  });

  it('degrades a stale planner session to a fresh one, and fails a task that cannot resume', async () => {
    const gone = () => ({ status: 404 });
    const planner = await start(fakeServer({ [`GET /api/session/${SES}`]: gone }), plannerStart({ resumeSessionId: SES }));
    expect(planner.adapter.nativeSessionId()).toBe(SES);
    planner.adapter.dispose();

    await expect(start(fakeServer({ [`GET /api/session/${SES}`]: gone }), taskStart({ resumeSessionId: SES })))
      .rejects.toThrow(/could not resume session/);
  });
});

describe('OpenCode 2.x — a turn', () => {
  it('queues the prompt and reads the reply, tools, reasoning and usage off the stream', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, plannerStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('the goal', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path === `/api/session/${SES}/prompt`));

    stream.push(started());
    stream.push(frame('session.step.started', { assistantMessageID: MSG, agent: 'plan', model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' } }));
    stream.push(frame('session.reasoning.delta', { assistantMessageID: MSG, ordinal: 0, delta: 'hmm' }));
    stream.push(frame('session.reasoning.ended', { assistantMessageID: MSG, ordinal: 0, text: 'hmm' }));
    for (const f of call('call_1', { path: 'README.md' }, 'read')) stream.push(f);
    stream.push(frame('session.tool.success', { assistantMessageID: MSG, id: 'call_1', content: [{ type: 'text', text: '1: # dummy' }] }));
    stream.push(frame('session.step.ended', { assistantMessageID: MSG, cost: 0.001, tokens: { input: 207, output: 17, reasoning: 3, cache: { read: 7040, write: 0 } } }));
    stream.push(frame('session.text.started', { assistantMessageID: 'msg_b', ordinal: 0 }));
    stream.push(frame('session.text.delta', { assistantMessageID: 'msg_b', ordinal: 0, delta: 'It is ' }));
    stream.push(frame('session.text.delta', { assistantMessageID: 'msg_b', ordinal: 0, delta: 'dummy.' }));
    stream.push(frame('session.text.ended', { assistantMessageID: 'msg_b', ordinal: 0, text: 'It is dummy.' }));
    stream.push(succeeded());
    await turn;

    expect(server.requests.find((r) => r.path === `/api/session/${SES}/prompt`)?.body).toEqual({ text: 'the goal' });
    expect(events.map((e) => e.type)).toEqual([
      'thinking_delta', 'thinking', 'tool_call', 'tool_result', 'usage',
      'assistant_text_delta', 'assistant_text_delta', 'assistant_text', 'turn_end',
    ]);
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ id: 'call_1', name: 'read', args: { path: 'README.md' } });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ id: 'call_1', name: 'read', output: '1: # dummy', success: true });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      record: { source: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', outputTokens: 20, reportedCost: { amount: 0.001, currency: 'USD' } },
    });
    expect(events.find((e) => e.type === 'assistant_text')).toMatchObject({ text: 'It is dummy.' });
    adapter.dispose();
  });

  it('opens a paragraph for text that follows a tool call in the same turn', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(frame('session.text.ended', { assistantMessageID: 'msg_a', ordinal: 0, text: 'First.' }));
    stream.push(frame('session.text.ended', { assistantMessageID: 'msg_b', ordinal: 0, text: 'Second.' }));
    stream.push(succeeded());
    await turn;

    expect(events.filter((e) => e.type === 'assistant_text').map((e) => (e as { text: string }).text)).toEqual(['First.', '\n\nSecond.']);
    adapter.dispose();
  });

  it('reports a failed execution in OpenCode\'s own words', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(frame('session.execution.failed', { error: { type: 'provider.no-route', message: 'Model unavailable: opencode-go/no-such-model' } }));
    await turn;

    expect(events).toEqual([{ type: 'error', message: 'Model unavailable: opencode-go/no-such-model' }]);
    adapter.dispose();
  });

  it('ends the turn from /api/session/active when the end frame never arrives', async () => {
    const server = fakeServer({
      [`GET /api/session/${SES}/message`]: () => ({ data: [{ id: 'msg_idle', type: 'idle', outcome: 'succeeded' }] }),
    });
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    await turn;

    expect(events).toEqual([{ type: 'turn_end' }]);
    adapter.dispose();
  });

  it('reads back reply text the stream dropped', async () => {
    const server = fakeServer({
      [`GET /api/session/${SES}/message`]: () => ({
        data: [
          { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
          { id: 'msg_b', type: 'assistant', content: [{ type: 'text', text: 'The reply.' }] },
          { id: 'msg_user', type: 'user', text: 'go' },
        ],
      }),
    });
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(succeeded());
    await turn;

    expect(events.map((e) => e.type)).toEqual(['assistant_text', 'turn_end']);
    expect(events[0]).toMatchObject({ text: 'The reply.' });
    adapter.dispose();
  });
});

describe('OpenCode 2.x — permission requests', () => {
  it('answers a task\'s request at once under auto approvals, and shows it decided', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(permissionAsk('per_1'));
    await until(() => server.requests.some((r) => r.path.endsWith('/permission/per_1/reply')));
    stream.push(succeeded());
    await turn;

    expect(server.requests.find((r) => r.path === `/api/session/${SES}/permission/per_1/reply`)?.body).toEqual({ decision: 'once' });
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({
      id: 'per_1', name: 'shell', suggestions: ['echo *'], toolUseId: 'call_1', decided: { decision: 'allow' },
    });
    adapter.dispose();
  });

  it('leaves a request open under any other mode until it is answered', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart({ flags: { permissionMode: 'plan', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(permissionAsk('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(events.find((e) => e.type === 'permission_request')).not.toHaveProperty('decided');
    expect(server.requests.some((r) => r.path.endsWith('/permission/per_1/reply'))).toBe(false);
    expect(adapter.answerPermission('per_1', { decision: 'allowForTask' })).toBe(true);
    await until(() => server.requests.some((r) => r.path.endsWith('/permission/per_1/reply')));
    expect(server.requests.find((r) => r.path.endsWith('/permission/per_1/reply'))?.body).toEqual({ decision: 'always' });
    expect(adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
    stream.push(succeeded());
    await turn;
    adapter.dispose();
  });

  it('carries a refusal\'s note to the agent as a correction', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart({ flags: { permissionMode: 'plan', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(permissionAsk('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(adapter.answerPermission('per_1', { decision: 'deny', note: 'not that' })).toBe(true);
    await until(() => server.requests.some((r) => r.path.endsWith('/permission/per_1/reply')));

    expect(server.requests.find((r) => r.path.endsWith('/permission/per_1/reply'))?.body).toEqual({ decision: 'reject', message: 'not that' });
    stream.push(succeeded());
    await turn;
    adapter.dispose();
  });

  it('withdraws an open request that OpenCode answered itself', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart({ flags: { permissionMode: 'plan', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(permissionAsk('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));
    stream.push({ type: 'permission.replied', data: { sessionID: SES, requestID: 'per_1', reply: 'reject' } });
    await until(() => events.some((e) => e.type === 'permission_cancelled'));

    expect(adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
    stream.push(succeeded());
    await turn;
    adapter.dispose();
  });

  it('holds a planner\'s request for its envelope, whatever its start carries, and replies with its answer', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, plannerStart({ mode: 'build', flags: { permissionMode: 'build', modeSettings: { approvals: 'auto' } } }));
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(permissionAsk('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(server.requests.some((r) => r.path.endsWith('/permission/per_1/reply'))).toBe(false);
    expect(events.find((e) => e.type === 'permission_request')).not.toHaveProperty('decided');
    expect(adapter.answerPermission('per_1', { decision: 'deny' })).toBe(true);
    await until(() => server.requests.some((r) => r.path.endsWith('/permission/per_1/reply')));
    stream.push(succeeded());
    await turn;

    expect(server.requests.find((r) => r.path.endsWith('/permission/per_1/reply'))?.body).toEqual({ decision: 'reject' });
    expect(adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
    adapter.dispose();
  });
});

describe('OpenCode 2.x — MCP servers', () => {
  it('lists Ordewell\'s tools as tools of their own, not inside code mode\'s `execute`', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart({ mcp: { name: 'ordewell', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer t' } } }));

    const replaced = server.requests.find((r) => r.method === 'PUT' && r.path === '/api/experimental/mcp/ordewell');
    expect(replaced?.body).toEqual({ config: { type: 'remote', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer t' }, codemode: false } });
    expect(server.requests.indexOf(replaced!)).toBeLessThan(server.requests.findIndex((r) => r.path === '/api/session'));
    adapter.dispose();
  });

  it('reads the attach state from /api/mcp, and takes a planner request for a listed server\'s tool as that tool', async () => {
    const server = fakeServer({
      'GET /api/mcp': () => ({ data: [{ name: 'ordewell', status: { status: 'connected' } }, { name: 'todoist', status: { status: 'connected' } }] }),
    });
    const { adapter } = await start(server, plannerStart({ mcp: { name: 'ordewell', url: 'http://127.0.0.1:1/mcp', headers: {} } }));
    expect(await adapter.mcpAttached()).toBe(true);

    const events: AgentEvent[] = [];
    void adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push({ type: 'permission.asked', data: { id: 'per_1', sessionID: SES, action: 'todoist_find-tasks', resources: ['*'] } });
    stream.push({ type: 'permission.asked', data: { id: 'per_2', sessionID: SES, action: 'shell', resources: ['ls'] } });
    await until(() => events.filter((e) => e.type === 'permission_request').length === 2);

    const asks = events.flatMap((e) => (e.type === 'permission_request' ? [e.ask] : []));
    expect(asks).toEqual([{ kind: 'mcp', scope: 'todoist_find-tasks', tool: 'find-tasks', server: 'todoist' }, { kind: 'other' }]);
    adapter.dispose();
  });
});

describe('OpenCode 2.x — mid-turn delivery', () => {
  it('has no verified mid-turn path yet, so every steer is refused and the turn-end queue stands', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());

    expect(await adapter.steer('m-1', 'use Postgres')).toBe(false);
    expect(server.requests.filter((r) => r.path.endsWith('/prompt'))).toHaveLength(1);

    stream.push(succeeded());
    await turn;
    adapter.dispose();
  });
});

describe('OpenCode 2.x — interrupt', () => {
  it('posts the interrupt and ends the turn as interrupted once OpenCode acknowledges', async () => {
    const server = fakeServer({ [`POST /api/session/${SES}/interrupt`]: () => ({ interrupted: true }) });
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());

    const interrupted = adapter.interrupt(5000);
    await until(() => server.requests.some((r) => r.path.endsWith('/interrupt')));
    stream.push(frame('session.execution.interrupted', { reason: 'user' }));

    expect(await interrupted).toBe(true);
    await turn;
    expect(events).toEqual([{ type: 'turn_end', interrupted: true }]);
    adapter.dispose();
  });
});

describe('OpenCode 2.x — subagents', () => {
  it('ties a child session to the call that spawned it, and keeps its report out of the reply', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, plannerStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));

    stream.push(started());
    for (const f of call('call_task', { agent: 'explore', description: 'Read README first line', prompt: 'read it' }, 'subagent')) stream.push(f);
    stream.push({ type: 'session.created', data: { sessionID: CHILD, parentID: SES } });
    // The child's work can arrive before the call names it.
    for (const f of call('call_child', { path: 'README.md' }, 'read', CHILD, 'msg_child')) stream.push(f);
    stream.push(frame('session.text.ended', { assistantMessageID: 'msg_child', ordinal: 0, text: 'its report' }, CHILD));
    stream.push(frame('session.tool.progress', { assistantMessageID: MSG, id: 'call_task', metadata: { sessionID: CHILD, status: 'running' } }));
    stream.push(frame('session.tool.success', { assistantMessageID: 'msg_child', id: 'call_child', content: [{ type: 'text', text: '1: # dummy' }] }, CHILD));
    stream.push(frame('session.execution.succeeded', {}, CHILD));
    stream.push(frame('session.tool.success', {
      assistantMessageID: MSG, id: 'call_task',
      content: [{ type: 'text', text: `<subagent sessionID="${CHILD}" state="completed">\nThe first line is # dummy\n</subagent>` }],
    }));
    stream.push(succeeded());
    await turn;

    expect(events.map((e) => e.type)).toEqual([
      'tool_call', 'subagent_started', 'tool_call', 'tool_result', 'tool_result', 'subagent_finished', 'turn_end',
    ]);
    expect(events.find((e) => e.type === 'subagent_started')).toMatchObject({ subagentId: 'call_task', brief: 'Read README first line' });
    expect(events.filter((e) => e.type === 'tool_call')[1]).toMatchObject({ id: 'call_child', subagentId: 'call_task' });
    expect(events.find((e) => e.type === 'subagent_finished')).toMatchObject({ subagentId: 'call_task', outcome: 'done', digest: 'The first line is # dummy' });
    expect(events.some((e) => e.type === 'assistant_text')).toBe(false);
    adapter.dispose();
  });

  it('ignores another client\'s session on the shared stream', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(frame('session.text.ended', { assistantMessageID: 'msg_x', ordinal: 0, text: 'someone else' }, 'ses_other'));
    stream.push(frame('session.execution.succeeded', {}, 'ses_other'));
    stream.push(succeeded());
    await turn;

    expect(events).toEqual([{ type: 'turn_end' }]);
    adapter.dispose();
  });
});

describe('OpenCode 2.x — shared protocol behaviour', () => {
  async function turnOf(server: ReturnType<typeof fakeServer>, opts: AgentStartOptions = taskStart()) {
    const { adapter, spawned } = await start(server, opts);
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    return { adapter, spawned, events, turn, stream };
  }

  it('cancels a request still open when the turn ends, and answers nothing for it', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnOf(server, taskStart({ flags: { permissionMode: 'plan', modeSettings: {} } }));
    stream.push(permissionAsk('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));
    stream.push(succeeded());
    await turn;

    expect(events.slice(-2)).toEqual([{ type: 'permission_cancelled', id: 'per_1' }, { type: 'turn_end' }]);
    expect(adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
    expect(server.requests.some((r) => r.path.endsWith('/permission/per_1/reply'))).toBe(false);
    adapter.dispose();
  });

  it('reports an interrupt false when OpenCode never acknowledges it', async () => {
    const server = fakeServer({ [`POST /api/session/${SES}/interrupt`]: () => ({ interrupted: true }) });
    const { adapter, turn, stream } = await turnOf(server);

    expect(await adapter.interrupt(50)).toBe(false);
    stream.push(succeeded());
    await turn;
    adapter.dispose();
  });

  it('reports an interrupt false when the server exits while it waits', async () => {
    const server = fakeServer({ [`POST /api/session/${SES}/interrupt`]: () => ({ interrupted: true }) });
    const { adapter, spawned, turn } = await turnOf(server);

    const acknowledged = adapter.interrupt(5000);
    await until(() => server.requests.some((r) => r.path.endsWith('/interrupt')));
    spawned.processes[0].exit(1);
    expect(await acknowledged).toBe(false);
    await turn;
    adapter.dispose();
  });

  it('acknowledges an interrupt between turns as soon as it is taken', async () => {
    const server = fakeServer({ [`POST /api/session/${SES}/interrupt`]: () => ({ interrupted: true }) });
    const { adapter } = await start(server);
    expect(await adapter.interrupt(5000)).toBe(true);
    adapter.dispose();
  });

  it('reads a frame split across reads, and skips lines that are no frame', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnOf(server);
    const reply = `data: ${JSON.stringify(frame('session.text.ended', { assistantMessageID: MSG, ordinal: 0, text: 'Split <<<MARKER>>>' }))}\n\n`;
    stream.pushRaw(': keepalive\n\n');
    stream.pushRaw('event: message\ndata: {not json\n\n');
    stream.pushRaw(reply.slice(0, 20));
    stream.pushRaw(reply.slice(20, 60));
    stream.pushRaw(`${reply.slice(60)}data: ${JSON.stringify(succeeded())}\n\n`);
    await turn;

    expect(events).toEqual([{ type: 'assistant_text', text: 'Split <<<MARKER>>>' }, { type: 'turn_end' }]);
    adapter.dispose();
  });

  it('reports no usage for a failed call, no cost for a free one, and a subagent\'s usage as its own', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnOf(server, plannerStart());
    stream.push(frame('session.step.failed', { assistantMessageID: 'msg_z', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
    stream.push(frame('session.step.ended', { assistantMessageID: MSG, cost: 0, tokens: { input: 5, output: 2 } }));
    for (const f of call('call_task', { description: 'Look around' }, 'subagent')) stream.push(f);
    stream.push({ type: 'session.created', data: { sessionID: CHILD, parentID: SES } });
    stream.push(frame('session.step.ended', { assistantMessageID: 'msg_child', cost: 0.002, tokens: { input: 7, output: 3 } }, CHILD));
    stream.push(frame('session.tool.progress', { assistantMessageID: MSG, id: 'call_task', metadata: { sessionID: CHILD, status: 'running' } }));
    stream.push(succeeded());
    await turn;

    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', record: { source: 'opencode', inputTokens: 5, outputTokens: 2 } },
      { type: 'usage', record: { source: 'opencode', inputTokens: 7, outputTokens: 3, reportedCost: { amount: 0.002, currency: 'USD' }, subagentId: 'call_task' } },
    ]);
    adapter.dispose();
  });
});

describe('OpenCode 2.x — file edits', () => {
  // The edit recorded in fixtures/harness/opencode/edit.events.jsonl, as 2.x reports it:
  // the result's `metadata.files` carries each file's patch beside the text the model reads.
  const patch = 'Index: sum.js\n===================================================================\n--- sum.js\n+++ sum.js\n@@ -1,3 +1,3 @@\n export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';

  it('reports an edit as its diff\'s hunks, as it does on 1.x, and a write with no diff as its text', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('fix sum', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    for (const f of call('call_edit', { path: 'sum.js', oldString: '  return a - b;', newString: '  return a + b;' }, 'edit')) stream.push(f);
    stream.push(frame('session.tool.success', {
      assistantMessageID: MSG, id: 'call_edit', executed: false,
      content: [{ type: 'text', text: 'Edited sum.js (1 replacement)' }],
      metadata: { files: [{ file: 'sum.js', patch, additions: 1, deletions: 1, status: 'modified' }] },
    }));
    for (const f of call('call_write', { path: 'hello.txt', content: 'hi\n' }, 'write')) stream.push(f);
    stream.push(frame('session.tool.success', { assistantMessageID: MSG, id: 'call_write', executed: false, content: [{ type: 'text', text: 'Created file successfully: hello.txt' }] }));
    stream.push(succeeded());
    await turn;

    const results = events.flatMap((e) => (e.type === 'tool_result' ? [[e.name, e.output]] : []));
    expect(results).toEqual([
      ['edit', '@@ -1,3 +1,3 @@\n export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n'],
      ['write', 'Created file successfully: hello.txt'],
    ]);
    adapter.dispose();
  });

  it('keeps a failed edit\'s error, whatever its metadata says', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('fix sum', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    for (const f of call('call_edit', { path: 'sum.js' }, 'edit')) stream.push(f);
    stream.push(frame('session.tool.failed', { assistantMessageID: MSG, id: 'call_edit', error: { type: 'unknown', message: 'Could not find oldString in sum.js.' }, metadata: { files: [{ patch }] } }));
    stream.push(succeeded());
    await turn;

    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ output: 'Could not find oldString in sum.js.', success: false });
    adapter.dispose();
  });
});
