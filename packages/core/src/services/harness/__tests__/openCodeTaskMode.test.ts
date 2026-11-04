import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { OpenCodeAdapter } from '../OpenCodeAdapter';
import { REQUEST_TIMEOUT_MS } from '../openCodeTransport';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, SpawnFn, TaskStartOptions, TaskModeAgentAdapter } from '../AgentAdapter';
import { mcpClientConfig, TASK_COMPLETION_CONTRACT, taskCompletionContract } from '../../mcp';
import type { RunnerPlacement } from '../../executionLease';
import { OPENCODE_PLANNER_PERMISSION } from '../openCodeOrdewell';
import { OPENCODE_MANIFEST } from '../../../plugins/builtin/opencode.manifest';
import { modeIds, fakeSpawn, sseResponse, type FakeEventStream } from '../../__tests__/harnessTestKit';
import type { StructuredEvent } from '../../../interfaces/IRunner';
import { toTaskLogEvent } from '../../../models/TaskLog';
import { replayTaskLog } from '../../../conversation/taskLog';
import { patient } from '../../../testing';

/**
 * OpenCode's task mode (ADR-0018, #55): `opencode serve` driven over HTTP
 * and its `/event` stream, recorded at the shape sst/opencode 0112a92
 * (v1.18.34) produces. A turn is posted with `prompt_async` and settles on
 * the session going idle — never on the POST, which returns at once.
 */

const BASE = 'http://127.0.0.1:4096';

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

type Reply = unknown | { status: number; body?: unknown };

/**
 * A scripted `opencode serve`. Routes answer by `METHOD /path`; `/event`
 * connections stay open until the adapter aborts them, so frames arrive
 * exactly when a test pushes them.
 */
function fakeServer(routes: Record<string, (body: unknown) => Reply | Promise<Reply>> = {}) {
  const requests: Recorded[] = [];
  const streams: FakeEventStream[] = [];
  const status: Record<string, { type: string }> = {};

  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    const path = String(input).replace(BASE, '');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method, path, authorization: headers.get('authorization'), body });

    if (path === '/event') {
      const { response, stream } = sseResponse(init);
      streams.push(stream);
      return response;
    }

    const key = `${method} ${path}`;
    let reply: Reply;
    if (routes[key]) {
      const answering = Promise.resolve(routes[key](body));
      // A request that is aborted stops waiting on its route, as a real socket does.
      reply = await (init?.signal
        ? Promise.race([answering, new Promise<never>((_resolve, reject) => {
          const abort = () => reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('The operation was aborted.'));
          if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
        })])
        : answering);
    }
    else if (key === 'GET /session/status') reply = status;
    else if (key === 'POST /session') reply = { id: 'ses_task' };
    else if (key.endsWith('/prompt_async')) reply = { status: 204 };
    else if (key.endsWith('/message') && method === 'GET') reply = [];
    else reply = true;
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
    status,
    /** The `n`th `/event` connection — one per turn — once the adapter has opened it. */
    async stream(n = 0): Promise<FakeEventStream> {
      for (let i = 0; i < 200 && streams.length <= n; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (streams.length <= n) throw new Error(`event stream ${n} never opened`);
      return streams[n];
    },
    streams,
  };
}

function taskStart(overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return {
    kind: 'task',
    cwd: '/repo/.ordewell/worktrees/run/1-task',
    mode: 'build',
    model: 'anthropic/claude-sonnet-4',
    flags: { permissionMode: 'build', modeSettings: { approvals: 'auto' } },
    ...overrides,
  };
}

/** The adapter's start, announced up and not yet awaited — for a test that holds the start itself. */
async function beginTask(server: ReturnType<typeof fakeServer>, opts: AgentStartOptions = taskStart(), workspaceEnv: Record<string, string> = {}, overrides: Partial<AgentProcessDeps> = {}) {
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
    workspaceEnv: async () => workspaceEnv,
    ...overrides,
  };
  const adapter = new OpenCodeAdapter(deps);
  const started = adapter.start(opts);
  for (let i = 0; i < 50 && spawned.processes.length === 0; i++) await Promise.resolve();
  spawned.processes[0].emitStdout(`opencode server listening on ${BASE}\n`);
  return { adapter, spawned, env: envs[0], started };
}

async function startTask(server: ReturnType<typeof fakeServer>, opts: AgentStartOptions = taskStart(), workspaceEnv: Record<string, string> = {}, overrides: Partial<AgentProcessDeps> = {}) {
  const { started, ...running } = await beginTask(server, opts, workspaceEnv, overrides);
  await started;
  return running;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  if (!condition()) throw new Error('condition never held');
}

function basic(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

describe('OpenCodeAdapter task mode — start', () => {
  it('uses Ordewell permissions for a read-only task, with project config off and its task tools allowed', async () => {
    const server = fakeServer();
    const mcp = mcpClientConfig({ token: 'read-only-test', url: 'http://127.0.0.1:4555/mcp', readOnly: true });
    const { adapter, env } = await startTask(server, taskStart({ mode: 'plan', workspaceRoot: '/workspace', flags: { readOnly: true, permissionMode: 'build', modeSettings: {} }, mcp }), {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'allow', shell: 'allow' } }),
    });
    try {
      expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as { lsp: boolean; permission: Record<string, unknown> };
      expect(config.lsp).toBe(false);
      for (const tool of ['*', 'edit', 'write', 'patch', 'apply_patch', 'multiedit', 'bash', 'shell', 'task', 'subagent', 'webfetch', 'websearch', 'codesearch', 'execute']) expect(config.permission[tool]).toBe('deny');
      for (const tool of ['read', 'grep', 'glob', 'list', 'ordewell_run_command', 'ordewell_save_patch', 'ordewell_checkpoint', 'ordewell_task_complete', 'ordewell_fetch', 'ordewell_web_search']) expect(config.permission[tool]).toBe('allow');
      expect(config.permission.external_directory).toMatchObject({ '*': 'deny', '/workspace/*': 'allow' });
      const events: AgentEvent[] = [];
      const turn = adapter.send('Review', (e) => events.push(e));
      const stream = await server.stream();
      stream.push({ type: 'permission.asked', properties: { id: 'ro-outside', sessionID: 'ses_task', permission: 'external_directory', patterns: ['/outside/*'] } });
      await until(() => server.requests.some((r) => r.path === '/permission/ro-outside/reply'));
      expect(server.requests.find((r) => r.path === '/permission/ro-outside/reply')?.body).toMatchObject({ reply: 'reject' });
      expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ decided: { decision: 'deny' } });
      stream.push(status('busy'));
      stream.push(status('idle'));
      await turn;
      const prompt = server.requests.find((r) => r.path.endsWith('/prompt_async'));
      expect(prompt?.body).toMatchObject({ agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' }, tools: { bash: false, edit: false } });
    } finally { adapter.dispose(); }
  });

  it('serves the worktree behind a per-task password, sent on every request', async () => {
    const server = fakeServer();
    const { adapter, spawned, env } = await startTask(server);

    expect(spawned.lastArgs()).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '0']);
    const password = env.OPENCODE_SERVER_PASSWORD;
    expect(password).toMatch(/^.{16,}$/);

    const second = await startTask(fakeServer());
    expect(second.env.OPENCODE_SERVER_PASSWORD).not.toBe(password);
    second.adapter.dispose();

    const events: AgentEvent[] = [];
    const turn = adapter.send('do the task', (e) => events.push(e));
    const stream = await server.stream();
    stream.push({ type: 'session.status', properties: { sessionID: 'ses_task', status: { type: 'busy' } } });
    stream.push({ type: 'session.status', properties: { sessionID: 'ses_task', status: { type: 'idle' } } });
    await turn;

    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining([
      'POST /session', 'GET /event', 'POST /session/ses_task/prompt_async', 'GET /session/status',
    ]));
    for (const request of server.requests) expect(request.authorization).toBe(basic(password!));
    adapter.dispose();
  });

  it("points OpenCode's Anthropic provider at the lease's gateway, so a broker key never reaches the model API", async () => {
    const server = fakeServer();
    const placement: RunnerPlacement = {
      cwd: '/task/work',
      place: async (launch) => ({ command: 'docker', args: ['exec', 'box', launch.command, ...launch.args], env: { ...launch.env }, stop: () => undefined, ended: () => undefined }),
      reach: async (url) => url,
      reachIn: async (url) => url,
      blob: async () => undefined,
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:7777', ANTHROPIC_API_KEY: 'ordewell-lease-token' },
    };
    const mcp = mcpClientConfig({ token: 'gateway-test', url: 'http://127.0.0.1:4555/mcp' });

    const { adapter, env } = await startTask(server, taskStart({ mcp }), {}, { placement });

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as { provider?: { anthropic?: { options?: Record<string, unknown> } }; mcp?: Record<string, unknown> };
    expect(config.provider?.anthropic?.options).toEqual({ baseURL: 'http://127.0.0.1:7777/v1', apiKey: 'ordewell-lease-token' });
    expect(config.mcp?.ordewell).toBeDefined();
    adapter.dispose();
  });

  it("does not carry this host's inline config into a container", async () => {
    const server = fakeServer();
    const placement: RunnerPlacement = {
      cwd: '/task/work',
      place: async (launch) => ({ command: 'docker', args: ['exec', 'box', launch.command, ...launch.args], env: { ...launch.env }, stop: () => undefined, ended: () => undefined }),
      reach: async (url) => url,
      reachIn: async (url) => url,
      blob: async () => undefined,
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:7777', ANTHROPIC_API_KEY: 'ordewell-lease-token' },
    };
    const mcp = mcpClientConfig({ token: 'isolation-test', url: 'http://127.0.0.1:4555/mcp' });

    const { adapter, env } = await startTask(server, taskStart({ mcp }), { OPENCODE_CONFIG_CONTENT: JSON.stringify({ hostOnly: true, provider: { anthropic: { options: { apiKey: 'host-secret' } } } }) }, { placement });

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown> & { provider?: { anthropic?: { options?: Record<string, unknown> } } };
    expect(config.hostOnly).toBeUndefined();
    expect(config.provider?.anthropic?.options).toEqual({ baseURL: 'http://127.0.0.1:7777/v1', apiKey: 'ordewell-lease-token' });
    expect(config.mcp).toBeDefined();
    adapter.dispose();
  });

  it("reaches a server in the container through the lease's relay, not its own loopback address", async () => {
    const server = fakeServer();
    const asked: string[] = [];
    const fetchImpl = (input: unknown, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      return server.fetch(url.replace('http://127.0.0.1:5555', BASE), init);
    };
    const placement: RunnerPlacement = {
      cwd: '/task/work',
      place: async (launch) => ({ command: 'docker', args: ['exec', 'box', launch.command, ...launch.args], env: { ...launch.env }, stop: () => undefined, ended: () => undefined }),
      reach: async (url) => url,
      reachIn: async (url) => { asked.push(`reachIn ${url}`); return 'http://127.0.0.1:5555'; },
      blob: async () => undefined,
    };

    const { adapter } = await startTask(server, taskStart(), {}, { placement, fetch: fetchImpl as unknown as typeof fetch });

    expect(asked).toContain(`reachIn ${BASE}`);
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toContain('GET /api/info');
    adapter.dispose();
  });
});

const SES = 'ses_task';
const status = (type: string, sessionID = SES) => ({ type: 'session.status', properties: { sessionID, status: { type } } });
const assistant = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'message.updated',
  properties: { sessionID: SES, info: { id, role: 'assistant', sessionID: SES, ...extra } },
});
const textPart = (id: string, messageID: string, text: string) => ({
  type: 'message.part.updated',
  properties: { sessionID: SES, part: { id, messageID, sessionID: SES, type: 'text', text, time: { start: 1, end: 2 } } },
});

describe('OpenCodeAdapter task mode — the message', () => {
  it('runs the mode as the agent, with the task model and effort, and withholds only `question`', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server, taskStart({ flags: { permissionMode: 'build', effort: 'high', modeSettings: {} } }));
    const turn = adapter.send('do the task', () => {});
    const stream = await server.stream();
    stream.push(status('busy'));
    stream.push(status('idle'));
    await turn;

    const prompt = server.requests.find((r) => r.path === `/session/${SES}/prompt_async`);
    expect(prompt?.body).toEqual({
      parts: [{ type: 'text', text: 'do the task' }],
      agent: 'build',
      tools: { question: false },
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      variant: 'high',
    });
    expect(server.requests.some((r) => r.path.endsWith('/message') && r.method === 'POST')).toBe(false);
    adapter.dispose();
  });

  it('carries the completion contract as its system, asking a change task for its commit (ADR-0047)', async () => {
    const mcp = { name: 'ordewell' as const, url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer tok' } };
    const systems: unknown[] = [];
    for (const commits of [undefined, true] as const) {
      const server = fakeServer();
      const { adapter } = await startTask(server, taskStart({ mcp, ...(commits ? { commits } : {}) }));
      const turn = adapter.send('do the task', () => {});
      const stream = await server.stream();
      stream.push(status('busy'));
      stream.push(status('idle'));
      await turn;
      systems.push((server.requests.find((r) => r.path === `/session/${SES}/prompt_async`)?.body as { system?: unknown }).system);
      adapter.dispose();
    }

    expect(systems).toEqual([TASK_COMPLETION_CONTRACT, taskCompletionContract({ commits: true })]);
  });
});

describe('OpenCodeAdapter task mode — when a turn ends', () => {
  it('ends on an idle the server confirms, with the streamed reply and its usage', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    const events: AgentEvent[] = [];
    let settled = false;
    const turn = adapter.send('do the task', (e) => events.push(e)).then(() => { settled = true; });
    const stream = await server.stream();

    stream.push(status('busy'));
    stream.push(assistant('msg_a'));
    stream.push(textPart('prt_1', 'msg_a', 'Done. <<<MARKER>>>'));
    // The frame says idle while the server still reports the session busy.
    server.status[SES] = { type: 'busy' };
    stream.push(status('idle'));
    await until(() => server.requests.filter((r) => r.path === '/session/status').length >= 1);
    await tick();
    expect(settled).toBe(false);

    delete server.status[SES];
    stream.push(assistant('msg_a', { time: { created: 1, completed: 2 }, providerID: 'anthropic', modelID: 'claude-sonnet-4', cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }));
    stream.push(status('idle'));
    await turn;

    expect(events).toContainEqual({ type: 'assistant_text', runId: 'prt_1', text: 'Done. <<<MARKER>>>' });
    expect(events).toContainEqual({ type: 'usage', record: expect.objectContaining({ source: 'opencode', model: 'anthropic/claude-sonnet-4', outputTokens: 5 }) });
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('ignores an idle that arrives before any of the turn\'s own work', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    const events: AgentEvent[] = [];
    let settled = false;
    const turn = adapter.send('second message', (e) => events.push(e)).then(() => { settled = true; });
    const stream = await server.stream();

    // The previous turn's idle, delivered late: nothing of this turn yet.
    stream.push(status('idle'));
    await until(() => server.requests.some((r) => r.path === `/session/${SES}/prompt_async`));
    for (let i = 0; i < 5; i++) await tick();
    expect(settled).toBe(false);

    stream.push(status('busy'));
    stream.push(status('idle'));
    await turn;
    expect(events).toEqual([{ type: 'turn_end' }]);
    adapter.dispose();
  });

  it('does not take the session\'s bookkeeping for the turn\'s work, whatever the status poll says', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    const events: AgentEvent[] = [];
    let settled = false;
    const turn = adapter.send('do the task', (e) => events.push(e)).then(() => { settled = true; });
    const stream = await server.stream();

    // `prompt_async` retitles the session and stores the user's message before
    // the model is scheduled, so the session is still not busy when the status
    // poll first looks.
    stream.push({ type: 'session.updated', properties: { sessionID: SES, info: { id: SES } } });
    stream.push({ type: 'session.diff', properties: { sessionID: SES, diff: [] } });
    stream.push({ type: 'message.updated', properties: { sessionID: SES, info: { id: 'msg_u', role: 'user', sessionID: SES } } });
    stream.push({ type: 'message.part.updated', properties: { sessionID: SES, part: { id: 'prt_u', messageID: 'msg_u', sessionID: SES, type: 'text', text: 'do the task' } } });
    await new Promise<void>((resolve) => setTimeout(resolve, 1300));
    expect(settled).toBe(false);

    server.status[SES] = { type: 'busy' };
    stream.push(status('busy'));
    stream.push(assistant('msg_a'));
    stream.push(textPart('prt_1', 'msg_a', 'ok'));
    delete server.status[SES];
    stream.push(status('idle'));
    await turn;
    expect(events).toContainEqual({ type: 'assistant_text', runId: 'prt_1', text: 'ok' });
    adapter.dispose();
  });

  it('ends on its own status poll when the stream drops the idle', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    const events: AgentEvent[] = [];
    const turn = adapter.send('do the task', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(status('busy'));
    await turn;
    expect(events).toEqual([{ type: 'turn_end' }]);
    adapter.dispose();
  }, patient(5000));

  it('reads back a reply part the stream never delivered', async () => {
    const server = fakeServer({
      [`GET /session/${SES}/message`]: () => [
        { info: { id: 'msg_u', role: 'user' }, parts: [{ id: 'prt_u', messageID: 'msg_u', type: 'text', text: 'do the task' }] },
        { info: { id: 'msg_a', role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ id: 'prt_1', messageID: 'msg_a', type: 'text', text: 'All done <<<MARKER>>>' }] },
      ],
    });
    const { adapter } = await startTask(server);
    const events: AgentEvent[] = [];
    const turn = adapter.send('do the task', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(status('busy'));
    stream.push(status('idle'));
    await turn;
    expect(events).toEqual([{ type: 'assistant_text', runId: 'prt_1', text: 'All done <<<MARKER>>>' }, { type: 'turn_end' }]);
    adapter.dispose();
  });

  // The stream delivered the first part's deltas and lost the frame that
  // completed it; the read-back completes it as the run it streamed as.
  it('reads back a part whose completion the stream lost where its deltas streamed, above the call after it', async () => {
    const bash = { id: 'prt_2', messageID: 'msg_a', sessionID: SES, type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'ls' }, output: 'src' } };
    const server = fakeServer({
      [`GET /session/${SES}/message`]: () => [
        { info: { id: 'msg_u', role: 'user' }, parts: [{ id: 'prt_u', messageID: 'msg_u', type: 'text', text: 'do the task' }] },
        { info: { id: 'msg_a', role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ id: 'prt_1', messageID: 'msg_a', type: 'text', text: 'Checking the tree.' }, bash] },
        { info: { id: 'msg_b', role: 'assistant', time: { created: 3, completed: 4 } }, parts: [{ id: 'prt_3', messageID: 'msg_b', type: 'text', text: 'Done.' }] },
      ],
    });
    const { adapter } = await startTask(server);
    const events: AgentEvent[] = [];
    const turn = adapter.send('do the task', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(status('busy'));
    stream.push(assistant('msg_a'));
    stream.push({ type: 'message.part.updated', properties: { sessionID: SES, part: { id: 'prt_1', messageID: 'msg_a', sessionID: SES, type: 'text', text: '', time: { start: 1 } } } });
    stream.push({ type: 'message.part.delta', properties: { sessionID: SES, messageID: 'msg_a', partID: 'prt_1', field: 'text', delta: 'Checking ' } });
    stream.push({ type: 'message.part.updated', properties: { sessionID: SES, part: bash } });
    stream.push(assistant('msg_b'));
    stream.push(textPart('prt_3', 'msg_b', 'Done.'));
    stream.push(status('idle'));
    await turn;

    const log = events.flatMap((e) => (e.type === 'turn_end' ? [] : toTaskLogEvent(e as StructuredEvent) ?? []));
    expect(replayTaskLog(log).blocks.map((b) => (b.type === 'message' ? b.text : b.type))).toEqual(['Checking the tree.', 'tool', 'Done.']);
    adapter.dispose();
  });

  it('fails the turn with OpenCode\'s own words on a session error', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    const events: AgentEvent[] = [];
    const turn = adapter.send('do the task', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(status('busy'));
    stream.push({ type: 'session.error', properties: { sessionID: SES, error: { name: 'ProviderAuthError', data: { message: 'No API key for anthropic' } } } });
    stream.push(status('idle'));
    await turn;
    expect(events).toEqual([{ type: 'error', message: 'No API key for anthropic' }]);
    adapter.dispose();
  });

  // The consumer is Ordewell, not the runner. A throw takes down the event
  // stream that permission requests arrive on, and a server left blocked on
  // one nobody sees would hang the turn; it fails instead, as the stdio
  // adapters' turns do.
  it('fails the turn when the consumer throws, rather than waiting on a server it can no longer hear', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    server.status[SES] = { type: 'busy' };
    const turn = adapter.send('do the task', (e) => { if (e.type === 'assistant_text') throw new Error('consumer blew up'); });
    const settled = expect(turn).rejects.toThrow('consumer blew up');
    const stream = await server.stream();
    stream.push(status('busy'));
    stream.push(assistant('msg_a'));
    stream.push(textPart('prt_1', 'msg_a', 'working'));

    await settled;
    adapter.dispose();
  });

  it('fails the turn when its last assistant message carries an error', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    const events: AgentEvent[] = [];
    const turn = adapter.send('do the task', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(assistant('msg_a', { error: { name: 'APIError', data: { message: 'overloaded' } } }));
    stream.push(status('idle'));
    await turn;
    expect(events).toEqual([{ type: 'error', message: 'overloaded' }]);
    adapter.dispose();
  });

  it('fails the turn when the server exits mid-turn, and reports the exit once', async () => {
    const server = fakeServer();
    const { adapter, spawned } = await startTask(server);
    const exits: number[] = [];
    adapter.onProcessExit((code) => exits.push(code));
    const events: AgentEvent[] = [];
    const turn = adapter.send('do the task', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(status('busy'));
    await until(() => server.requests.some((r) => r.path === `/session/${SES}/prompt_async`));
    spawned.processes[0].exit(3);
    await turn;
    expect(events).toEqual([{ type: 'error', message: 'The OpenCode task server exited.' }]);
    expect(exits).toEqual([3]);
    adapter.dispose();
  });
});

describe('OpenCodeAdapter task mode — messages into the running turn (ADR-0023)', () => {
  const userMessage = (id: string) => ({ type: 'message.updated', properties: { sessionID: SES, info: { id, role: 'user' } } });
  const assistantWithParent = (id: string, parentID: string) => ({
    type: 'message.updated',
    properties: { sessionID: SES, info: { id, role: 'assistant', parentID } },
  });

  /** The body of the `n`th `prompt_async` the adapter posted for this session. */
  const promptBodies = (server: ReturnType<typeof fakeServer>) =>
    server.requests.filter((r) => r.path === `/session/${SES}/prompt_async`).map((r) => r.body as { parts: unknown; agent: string; tools: unknown; messageID?: string });

  it('hands a busy turn a named message at once, and logs the delivery when an assistant message is parented to it', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, taskStart());
    await until(() => promptBodies(server).length === 1);

    expect(await adapter.steer('m-1', 'use Postgres')).toBe(true);
    const bodies = promptBodies(server);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({
      parts: [{ type: 'text', text: 'use Postgres' }],
      agent: 'build',
      tools: { question: false },
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      messageID: expect.stringMatching(/^msg/),
    });
    // The first prompt is stored without a message id, so the two are told apart.
    expect(bodies[0].messageID).toBeUndefined();

    stream.push(userMessage(bodies[1].messageID!));
    // Storage is not delivery: no event until the model's answer names it.
    await stream.drained;
    expect(events.some((e) => e.type === 'message_delivered')).toBe(false);
    stream.push(assistantWithParent('msg_a', bodies[1].messageID!));
    stream.push(assistantWithParent('msg_b', bodies[1].messageID!));
    await until(() => events.some((e) => e.type === 'message_delivered'));
    expect(events.filter((e) => e.type === 'message_delivered')).toEqual([{ type: 'message_delivered', id: 'm-1' }]);

    stream.push(status('idle'));
    await turn;
    expect(events.some((e) => e.type === 'message_dropped')).toBe(false);
    adapter.dispose();
  });

  it('refuses a message when no turn is running, so the caller keeps it for the turn end', async () => {
    const server = fakeServer();
    const { adapter, turn, stream } = await turnWith(server, taskStart());
    await until(() => promptBodies(server).length === 1);

    stream.push(status('idle'));
    await turn;
    // The turn is over: the caller keeps the message for the turn-end queue.
    expect(await adapter.steer('m-1', 'too late')).toBe(false);
    expect(promptBodies(server)).toHaveLength(1);
    adapter.dispose();
  });

  it('falls back when the server refuses the steer request', async () => {
    let posts = 0;
    const server = fakeServer({ [`POST /session/${SES}/prompt_async`]: () => (++posts === 1 ? { status: 204 } : { status: 500 }) });
    const { adapter, events, turn, stream } = await turnWith(server, taskStart());
    await until(() => posts === 1);

    expect(await adapter.steer('m-1', 'use Postgres')).toBe(false);
    stream.push(status('idle'));
    await turn;
    expect(events.filter((e) => e.type === 'message_delivered' || e.type === 'message_dropped')).toEqual([]);
    adapter.dispose();
  });

  it('drops a message the turn ended before the model read, and deletes the stored copy so the re-send does not duplicate it', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, taskStart());
    await until(() => promptBodies(server).length === 1);
    expect(await adapter.steer('m-1', 'use Postgres')).toBe(true);
    const messageID = promptBodies(server)[1].messageID!;

    stream.push(status('idle'));
    await turn;
    await until(() => server.requests.some((r) => r.method === 'DELETE' && r.path === `/session/${SES}/message/${messageID}`));
    expect(events).toContainEqual({ type: 'message_dropped', id: 'm-1' });
    adapter.dispose();
  });

  it('lets go of a message still unread when an abort ends the turn, deleting the stored copy, so the force send that follows sends it once (ADR-0023, F1)', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, taskStart());
    await until(() => promptBodies(server).length === 1);
    expect(await adapter.steer('m-1', 'use Postgres')).toBe(true);
    const messageID = promptBodies(server)[1].messageID!;
    stream.push(userMessage(messageID));

    const acknowledged = adapter.interrupt(2000);
    await until(() => server.requests.some((r) => r.method === 'POST' && r.path === `/session/${SES}/abort`));
    stream.push(status('idle'));
    expect(await acknowledged).toBe(true);
    await turn;

    await until(() => server.requests.some((r) => r.method === 'DELETE' && r.path === `/session/${SES}/message/${messageID}`));
    expect(events.filter((e) => e.type === 'message_dropped' || e.type === 'message_delivered')).toEqual([{ type: 'message_dropped', id: 'm-1' }]);
    expect(events).toContainEqual({ type: 'turn_end', interrupted: true });
    adapter.dispose();
  });
});

describe('OpenCodeAdapter task mode — interrupt', () => {
  it('aborts the session and ends the turn as interrupted once it goes idle', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    const events: AgentEvent[] = [];
    const turn = adapter.send('do the task', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(status('busy'));
    await until(() => server.requests.some((r) => r.path === `/session/${SES}/prompt_async`));

    server.status[SES] = { type: 'busy' };
    const acknowledged = adapter.interrupt(2000);
    await until(() => server.requests.some((r) => r.method === 'POST' && r.path === `/session/${SES}/abort`));
    delete server.status[SES];
    stream.push(assistant('msg_a', { error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }));
    stream.push(status('idle'));

    expect(await acknowledged).toBe(true);
    await turn;
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    adapter.dispose();
  });

  it('reports a turn that failed for its own reason after an interrupt as failed, and only the abort itself as interrupted', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    const events: AgentEvent[] = [];
    const turn = adapter.send('do the task', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(status('busy'));
    await until(() => server.requests.some((r) => r.path === `/session/${SES}/prompt_async`));

    server.status[SES] = { type: 'busy' };
    const acknowledged = adapter.interrupt(2000);
    await until(() => server.requests.some((r) => r.method === 'POST' && r.path === `/session/${SES}/abort`));
    delete server.status[SES];
    stream.push(assistant('msg_a', { error: { name: 'APIError', data: { message: 'Usage limit reached' } } }));
    stream.push(status('idle'));

    expect(await acknowledged).toBe(true);
    await turn;
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Usage limit reached' });
    adapter.dispose();
  });

  it('reports false when the session never goes idle, so the caller can kill it', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    const turn = adapter.send('do the task', () => {});
    const stream = await server.stream();
    stream.push(status('busy'));
    server.status[SES] = { type: 'busy' };
    await until(() => server.requests.some((r) => r.path === `/session/${SES}/prompt_async`));
    expect(await adapter.interrupt(50)).toBe(false);
    adapter.dispose();
    void turn;
  });
});

const ask = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'permission.asked',
  properties: {
    id,
    sessionID: SES,
    permission: 'bash',
    patterns: ['rm -rf dist'],
    always: ['rm *'],
    metadata: { command: 'rm -rf dist' },
    tool: { messageID: 'msg_a', callID: 'call_1' },
    ...extra,
  },
});

async function turnWith(server: ReturnType<typeof fakeServer>, opts: TaskStartOptions) {
  const { adapter, env } = await startTask(server, opts);
  const events: AgentEvent[] = [];
  const turn = adapter.send('do the task', (e) => events.push(e));
  const stream = await server.stream();
  stream.push(status('busy'));
  return { adapter, events, turn, stream, env };
}

const planMode = taskStart({ mode: 'plan', flags: { permissionMode: 'plan', modeSettings: {} } });

describe('OpenCodeAdapter task mode — permissions', () => {
  it('answers every request under build at once, and still shows it decided', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, taskStart());
    stream.push(ask('per_1'));
    await until(() => server.requests.some((r) => r.path === '/permission/per_1/reply'));
    stream.push(status('idle'));
    await turn;

    expect(server.requests.find((r) => r.path === '/permission/per_1/reply')?.body).toEqual({ reply: 'once' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'permission_request', id: 'per_1', name: 'bash', decided: { decision: 'allow' } }));
    expect(await adapter.answerPermission('per_1', { decision: 'deny' })).toBe(false);
    adapter.dispose();
  });

  it('waits for an automatic permission answer too, and leaves a failed one available for retry', async () => {
    let reply: (value: Reply) => void = () => {};
    const server = fakeServer({ 'POST /permission/per_1/reply': () => new Promise<Reply>((resolve) => { reply = resolve; }) });
    const { adapter, events, turn, stream } = await turnWith(server, taskStart());
    stream.push(ask('per_1'));
    await until(() => server.requests.some((r) => r.path === '/permission/per_1/reply'));
    expect(events.some((e) => e.type === 'permission_request' && e.decided)).toBe(false);
    reply({ status: 503 });
    await until(() => events.some((e) => e.type === 'thinking' && e.text.includes('still open')));
    expect(events).toContainEqual(expect.objectContaining({ type: 'permission_request', id: 'per_1' }));
    expect(events.some((e) => e.type === 'permission_request' && e.decided)).toBe(false);
    const answer = adapter.answerPermission('per_1', { decision: 'deny' });
    await until(() => server.requests.filter((r) => r.path === '/permission/per_1/reply').length === 2);
    reply(true);
    expect(await answer).toBe(true);
    stream.push(status('idle'));
    await turn;
    adapter.dispose();
  });

  it('fails the turn and withdraws its requests when the event stream is lost twice', async () => {
    const server = fakeServer();
    const fetchImpl = server.fetch;
    let connections = 0;
    server.fetch = (async (input: unknown, init?: RequestInit) => {
      if (!String(input).endsWith('/event')) return fetchImpl(String(input), init);
      connections++;
      let read = false;
      return new Response(new ReadableStream({ pull(controller) {
        if (!read && connections === 1) {
          read = true;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ask('per_1'))}\n\n`));
        } else controller.error(new Error('socket closed'));
      } }));
    }) as typeof fetch;
    const { adapter } = await startTask(server, planMode);
    const events: AgentEvent[] = [];
    await expect(adapter.send('go', (event) => events.push(event))).rejects.toThrow('event stream was lost');
    expect(connections).toBe(2);
    expect(events).toContainEqual({ type: 'permission_cancelled', id: 'per_1' });
    adapter.dispose();
  });

  it('does not withdraw an answer when OpenCode echoes permission.replied before its HTTP response', async () => {
    let reply: (value: Reply) => void = () => {};
    const server = fakeServer({ 'POST /permission/per_1/reply': () => new Promise<Reply>((resolve) => { reply = resolve; }) });
    const { adapter, events, turn, stream } = await turnWith(server, planMode);
    stream.push(ask('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));
    const answer = adapter.answerPermission('per_1', { decision: 'allow' });
    await until(() => server.requests.some((r) => r.path === '/permission/per_1/reply'));
    stream.push({ type: 'permission.replied', properties: { sessionID: SES, requestID: 'per_1' } });
    await tick();
    expect(events.some((e) => e.type === 'permission_cancelled')).toBe(false);
    reply(true);
    expect(await answer).toBe(true);
    stream.push(status('idle'));
    await turn;
    adapter.dispose();
  });

  it('keeps a permission request open when posting its answer fails, and logs the failure', async () => {
    let attempts = 0;
    const server = fakeServer({ 'POST /permission/per_1/reply': () => ({ status: ++attempts === 1 ? 503 : 200 }) });
    const { adapter, events, turn, stream } = await turnWith(server, planMode);
    stream.push(ask('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));

    await expect(adapter.answerPermission('per_1', { decision: 'allow' })).rejects.toThrow('503');
    expect(events).toContainEqual({ type: 'thinking', text: 'Could not deliver the permission answer: OpenCode permission reply failed: 503 503. The request is still open.' });
    expect(await adapter.answerPermission('per_1', { decision: 'deny' })).toBe(true);
    stream.push(status('idle'));
    await turn;
    adapter.dispose();
  });

  it('forwards a request for a card under any other mode, and answers with the card\'s decision', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, planMode);
    stream.push(ask('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));

    const request = events.find((e) => e.type === 'permission_request');
    expect(request).toEqual({
      type: 'permission_request',
      id: 'per_1',
      name: 'bash',
      detail: JSON.stringify({ scope: 'rm -rf dist', command: 'rm -rf dist' }),
      input: { command: 'rm -rf dist' },
      suggestions: ['rm *'],
      toolUseId: 'call_1',
    });
    expect(server.requests.some((r) => r.path.startsWith('/permission/'))).toBe(false);

    expect(await adapter.answerPermission('per_1', { decision: 'allowForTask' })).toBe(true);
    expect(await adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
    await until(() => server.requests.some((r) => r.path === '/permission/per_1/reply'));
    expect(server.requests.find((r) => r.path === '/permission/per_1/reply')?.body).toEqual({ reply: 'always' });
    stream.push(status('idle'));
    await turn;
    adapter.dispose();
  });

  it.each([
    [{ decision: 'allow' } as const, { reply: 'once' }],
    [{ decision: 'deny', note: 'use the test fixture instead' } as const, { reply: 'reject', message: 'use the test fixture instead' }],
    [{ decision: 'deny' } as const, { reply: 'reject' }],
  ])('answers %o as %o', async (decision, reply) => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, planMode);
    stream.push(ask('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));
    adapter.answerPermission('per_1', decision);
    await until(() => server.requests.some((r) => r.path === '/permission/per_1/reply'));
    expect(server.requests.find((r) => r.path === '/permission/per_1/reply')?.body).toEqual(reply);
    stream.push(status('idle'));
    await turn;
    adapter.dispose();
  });

  it('handles a subagent\'s request the same way', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, planMode);
    stream.push({ type: 'session.created', properties: { info: { id: 'ses_child', parentID: SES } } });
    stream.push(ask('per_2', { sessionID: 'ses_child' }));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ id: 'per_2', name: 'bash' });
    expect(await adapter.answerPermission('per_2', { decision: 'allow' })).toBe(true);
    stream.push(status('idle'));
    await turn;
    adapter.dispose();
  });

  it('withdraws a request OpenCode settled itself', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, planMode);
    stream.push(ask('per_1'));
    stream.push({ type: 'permission.replied', properties: { sessionID: SES, requestID: 'per_1', reply: 'reject' } });
    await until(() => events.some((e) => e.type === 'permission_cancelled'));
    expect(events).toContainEqual({ type: 'permission_cancelled', id: 'per_1' });
    expect(await adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
    stream.push(status('idle'));
    await turn;
    adapter.dispose();
  });

  it('falls back to the deprecated reply path on a server that 404s the new one', async () => {
    const server = fakeServer({ 'POST /permission/per_1/reply': () => ({ status: 404 }) });
    const { adapter, events, turn, stream } = await turnWith(server, planMode);
    stream.push(ask('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));
    adapter.answerPermission('per_1', { decision: 'deny' });
    await until(() => server.requests.some((r) => r.path === `/session/${SES}/permissions/per_1`));
    expect(server.requests.find((r) => r.path === `/session/${SES}/permissions/per_1`)?.body).toEqual({ response: 'reject' });
    stream.push(status('idle'));
    await turn;
    adapter.dispose();
  });
});

describe('OpenCodeAdapter task mode — shared protocol behaviour', () => {
  it('cancels a request still open when the turn ends, and answers nothing for it', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, planMode);
    stream.push(ask('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));
    stream.push(status('idle'));
    await turn;

    expect(events.slice(-2)).toEqual([{ type: 'permission_cancelled', id: 'per_1' }, { type: 'turn_end' }]);
    expect(await adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
    expect(server.requests.some((r) => r.path.startsWith('/permission/'))).toBe(false);
    adapter.dispose();
  });

  it('reports an interrupt false when the server exits while it waits', async () => {
    const server = fakeServer();
    const { adapter, spawned } = await startTask(server);
    const turn = adapter.send('do the task', () => {});
    const stream = await server.stream();
    stream.push(status('busy'));
    server.status[SES] = { type: 'busy' };
    await until(() => server.requests.some((r) => r.path === `/session/${SES}/prompt_async`));

    const acknowledged = adapter.interrupt(5000);
    await until(() => server.requests.some((r) => r.path === `/session/${SES}/abort`));
    spawned.processes[0].exit(1);
    expect(await acknowledged).toBe(false);
    await turn;
    adapter.dispose();
  });

  it('acknowledges an interrupt between turns as soon as the abort is taken', async () => {
    const server = fakeServer();
    const { adapter } = await startTask(server);
    expect(await adapter.interrupt(5000)).toBe(true);
    expect(server.requests.some((r) => r.method === 'POST' && r.path === `/session/${SES}/abort`)).toBe(true);
    adapter.dispose();
  });

  it('reads a frame split across reads, and skips lines that are no frame', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, taskStart());
    const reply = `data: ${JSON.stringify(textPart('prt_1', 'msg_a', 'Split <<<MARKER>>>'))}\n\n`;
    stream.pushRaw(': keepalive\n\n');
    stream.pushRaw('event: message\ndata: {not json\n\n');
    stream.pushRaw(`data: ${JSON.stringify(assistant('msg_a'))}\n\n${reply.slice(0, 20)}`);
    stream.pushRaw(reply.slice(20, 60));
    stream.pushRaw(`${reply.slice(60)}data: ${JSON.stringify(status('idle'))}\n\n`);
    await turn;

    expect(events).toEqual([{ type: 'assistant_text', runId: 'prt_1', text: 'Split <<<MARKER>>>' }, { type: 'turn_end' }]);
    adapter.dispose();
  });

  it('reports no usage for a call that failed before the provider answered', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, taskStart());
    stream.push(assistant('msg_a', { time: { created: 1, completed: 2 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
    stream.push(status('idle'));
    await turn;

    expect(events).toEqual([{ type: 'turn_end' }]);
    adapter.dispose();
  });

  it('holds a child session\'s frames until the task call names it, then replays them as the subagent\'s', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, taskStart());
    const CHILD = 'ses_child';
    const taskCall = (state: Record<string, unknown>) => ({
      type: 'message.part.updated',
      properties: { sessionID: SES, part: { id: 'prt_t', messageID: 'msg_a', type: 'tool', tool: 'task', callID: 'call_t', state } },
    });
    const metadata = { sessionId: CHILD, model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' } };
    stream.push({ type: 'session.created', properties: { info: { id: CHILD, parentID: SES } } });
    stream.push({ type: 'message.updated', properties: { sessionID: CHILD, info: { id: 'msg_c', role: 'assistant', time: { created: 1, completed: 2 }, tokens: { input: 7, output: 3 } } } });
    stream.push({
      type: 'message.part.updated',
      properties: { sessionID: CHILD, part: { id: 'prt_c', messageID: 'msg_c', type: 'tool', tool: 'read', callID: 'call_c', state: { status: 'completed', input: { filePath: 'a.ts' }, output: 'x' } } },
    });
    stream.push(taskCall({ status: 'running', input: { description: 'Look around' }, metadata }));
    stream.push(taskCall({ status: 'completed', input: { description: 'Look around' }, output: '<task_result>\nfound it\n</task_result>', metadata }));
    stream.push(status('idle'));
    await turn;

    expect(events.map((e) => [e.type, 'subagentId' in e ? e.subagentId : undefined])).toEqual([
      ['tool_call', undefined],
      ['subagent_started', 'call_t'],
      ['usage', undefined],
      ['tool_call', 'call_t'],
      ['tool_result', 'call_t'],
      ['subagent_finished', 'call_t'],
      ['tool_result', undefined],
      ['turn_end', undefined],
    ]);
    expect(events.find((e) => e.type === 'subagent_started')).toEqual({ type: 'subagent_started', subagentId: 'call_t', brief: 'Look around', model: 'opencode-go/deepseek-v4-flash' });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ record: { subagentId: 'call_t', inputTokens: 7, outputTokens: 3 } });
    expect(events.find((e) => e.type === 'subagent_finished')).toMatchObject({ outcome: 'done', digest: 'found it' });
    adapter.dispose();
  });
});

describe('OpenCodeAdapter planner — still read-only', () => {
  // A host running inside OpenCode carries its own configuration, which a child rightly keeps.
  beforeEach(() => { vi.stubEnv('OPENCODE_CONFIG_CONTENT', undefined); });
  afterEach(() => { vi.unstubAllEnvs(); });

  /** A planner turn whose message POST stays open until `release`, as the real one does. */
  function plannerServer(routes: Record<string, (body: unknown) => Reply | Promise<Reply>> = {}) {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const server = fakeServer({
      [`POST /session/${SES}/message`]: async () => { await held; return { info: { id: 'msg_a', role: 'assistant' }, parts: [] }; },
      ...routes,
    });
    return { server, release };
  }

  it.each([
    ['nothing else', {}],
    // Task fields smuggled onto a planner start: nothing on the planner path reads them.
    ['a task\'s mode and auto approvals', { mode: 'build', flags: { permissionMode: 'build', effort: 'max', modeSettings: { approvals: 'auto' } } }],
  ])('plans with the read-only agent, no shell and no subagents, and holds every request for the envelope whatever its start carries: %s', async (_label, extra) => {
    const { server, release } = plannerServer();
    const { adapter, env } = await startTask(server, { kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', ...extra } as unknown as AgentStartOptions);
    const events: AgentEvent[] = [];
    const turn = adapter.send('the goal', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(ask('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(server.requests.some((r) => r.path === '/permission/per_1/reply')).toBe(false);
    expect(await adapter.answerPermission('per_1', { decision: 'deny' })).toBe(true);
    await until(() => server.requests.some((r) => r.path === '/permission/per_1/reply'));
    release();
    await turn;

    const message = server.requests.find((r) => r.path === `/session/${SES}/message` && r.method === 'POST');
    expect(message?.body).toMatchObject({
      agent: 'plan',
      tools: { question: false, edit: false, write: false, apply_patch: false, todowrite: false, bash: false, task: false },
      system: 'PLAN',
    });
    // Its server's whole permission policy is Ordewell's (ADR-0026), with no language server and none of the project's config (ADR-0028).
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual({ lsp: false, permission: OPENCODE_PLANNER_PERMISSION });
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(server.requests.find((r) => r.path === '/permission/per_1/reply')?.body).toEqual({ reply: 'reject' });
    expect(server.requests.some((r) => r.path.endsWith('/prompt_async'))).toBe(false);
    // 2.x refuses every /api request without credentials, so a planner's server is secured like a task's.
    const password = env.OPENCODE_SERVER_PASSWORD;
    expect(password).toBeTruthy();
    for (const request of server.requests) expect(request.authorization).toBe(basic(password!));
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ id: 'per_1', name: 'bash', ask: { kind: 'other' } });
    expect(events.find((e) => e.type === 'permission_request')).not.toHaveProperty('decided');
    expect(await adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
    adapter.dispose();
  });

  it('denies on the deprecated path only when the new reply endpoint 404s', async () => {
    const { server, release } = plannerServer({ 'POST /permission/per_1/reply': () => ({ status: 404 }) });
    const { adapter } = await startTask(server, { kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const turn = adapter.send('the goal', (e) => {
      if (e.type === 'permission_request') adapter.answerPermission(e.id, { decision: 'deny' });
    });
    const stream = await server.stream();
    stream.push(ask('per_1'));
    stream.push(ask('per_2'));
    await until(() => server.requests.some((r) => r.path === `/session/${SES}/permissions/per_1`));
    await until(() => server.requests.some((r) => r.path === '/permission/per_2/reply'));
    release();
    await turn;

    expect(server.requests.find((r) => r.path === `/session/${SES}/permissions/per_1`)?.body).toEqual({ response: 'reject' });
    expect(server.requests.some((r) => r.path === `/session/${SES}/permissions/per_2`)).toBe(false);
    adapter.dispose();
  });
});

describe('OpenCodeAdapter task mode — resume', () => {
  it('continues the saved session rather than creating one', async () => {
    const server = fakeServer({ 'GET /session/ses_saved': () => ({ id: 'ses_saved' }) });
    const { adapter } = await startTask(server, taskStart({ resumeSessionId: 'ses_saved' }));
    expect(adapter.nativeSessionId()).toBe('ses_saved');
    expect(server.requests.some((r) => r.method === 'POST' && r.path === '/session')).toBe(false);
    adapter.dispose();
  });

  it('fails a resume the server refuses instead of starting a fresh session', async () => {
    const server = fakeServer({ 'GET /session/ses_gone': () => ({ status: 404 }) });
    await expect(startTask(server, taskStart({ resumeSessionId: 'ses_gone' }))).rejects.toThrow(/could not resume session ses_gone/);
    expect(server.requests.some((r) => r.method === 'POST' && r.path === '/session')).toBe(false);
  });
});

describe('OpenCodeAdapter with the Ordewell MCP server (ADR-0022)', () => {
  const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-secret' });
  const ordewell = { type: 'remote', url: 'http://127.0.0.1:4555/mcp', headers: { Authorization: 'Bearer tok-secret' }, enabled: true };
  /** What a process given the server is launched with so OpenCode 2.x never rebuilds the services holding it. */
  const unevicted = { experimental: { location_idle_timeout: false } };
  const configOf = (env: NodeJS.ProcessEnv) => JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null') as unknown;
  // One rule per tool by its exact name: a pattern would cover a repository server named `ordewell_<anything>` too.
  const taskAllow = { ordewell_task_complete: 'allow', ordewell_checkpoint: 'allow', ordewell_read: 'allow', ordewell_apply_patch: 'allow' };
  const plannerAllow = Object.fromEntries([
    'list_runners', 'list_models', 'submit_plan', 'edit_plan', 'task_query', 'task_output', 'task_diff', 'run_command', 'fetch', 'web_search', 'load_skill',
    'run_plan', 'run_task', 'stop_task', 'stop_run', 'retry_task', 'skip_task', 'message_task', 'answer_approval', 'answer_checkpoint', 'merge_all', 'run_script',
  ].map((tool) => [`ordewell_${tool}`, 'allow']));

  // A host running inside OpenCode carries its own configuration, which a child rightly keeps.
  beforeEach(() => { vi.stubEnv('OPENCODE_CONFIG_CONTENT', undefined); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('hands a task the server and an allow rule for its tools through the environment, never the command line', async () => {
    const { adapter, spawned, env } = await startTask(fakeServer(), taskStart({ mcp }));

    expect(configOf(env)).toEqual({ mcp: { ordewell }, ...unevicted, permission: taskAllow });
    expect(spawned.lastArgs().join(' ')).not.toContain('tok-secret');
    adapter.dispose();
  });

  it.each(modeIds(OPENCODE_MANIFEST))('allows the Ordewell tools by rule and by answer under %s', async (mode) => {
    const server = fakeServer();
    const opts = taskStart({ mode, flags: { permissionMode: mode, modeSettings: {} }, mcp });
    const { adapter, events, turn, stream, env } = await turnWith(server, opts);
    stream.push(ask('per_t', { permission: 'ordewell_checkpoint', patterns: ['*'], metadata: {} }));
    await until(() => server.requests.some((r) => r.path === '/permission/per_t/reply'));
    stream.push(status('idle'));
    await turn;

    expect((configOf(env) as { permission: Record<string, string> }).permission.ordewell_checkpoint).toBe('allow');
    expect(events).toContainEqual(expect.objectContaining({ type: 'permission_request', id: 'per_t', decided: { decision: 'allow' } }));
    adapter.dispose();
  });

  it('hands the planner the same, beside the read-only agent', async () => {
    const { adapter, env } = await startTask(fakeServer(), { kind: 'planner', cwd: '/repo', systemPrompt: 'plan read-only', mcp });

    expect(configOf(env)).toEqual({ mcp: { ordewell }, lsp: false, ...unevicted, permission: { ...OPENCODE_PLANNER_PERMISSION, ...plannerAllow } });
    adapter.dispose();
  });

  it('keeps the services holding the server from being evicted, over the workspace\'s own idle timeout', async () => {
    // 2.x evicts a location idle past this timeout (an hour unless set) and rebuilds it from the launch configuration,
    // without the runtime replacement that lists Ordewell's tools as tools of their own (checked against 2.1.4).
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ experimental: { location_idle_timeout: '5 minutes', batch_tool: true } }));
    const { adapter, env } = await startTask(fakeServer(), taskStart({ mcp }));

    expect((configOf(env) as { experimental: unknown }).experimental).toEqual({ location_idle_timeout: false, batch_tool: true });
    adapter.dispose();
  });

  it('adds nothing when no server is given', async () => {
    const { adapter, env } = await startTask(fakeServer());

    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    adapter.dispose();
  });

  describe('under a host that is itself an Ordewell runner\'s child', () => {
    const parentEntry = {
      type: 'remote',
      url: 'http://127.0.0.1:4999/mcp',
      headers: { Authorization: 'Bearer parent-synthetic', 'X-Parent-Session': 'parent-synthetic-session' },
      oauth: { clientId: 'parent-synthetic-client' },
      timeout: 1,
      enabled: true,
    };
    const unrelated = {
      model: 'anthropic/claude-sonnet-4',
      mcp: { other: { type: 'local', command: ['x'] } },
      permission: { bash: { '*': 'allow' } },
      agent: { build: { permission: { edit: 'ask' } } },
    };
    const parentConfig = (own: typeof unrelated | Record<string, never> = unrelated) => JSON.stringify({
      ...own,
      mcp: { ...('mcp' in own ? own.mcp : {}), ordewell: parentEntry },
      // `ordewell_*` is what an Ordewell before exact rules wrote.
      permission: { ...('permission' in own ? own.permission : {}), 'ordewell_*': 'allow', ...taskAllow },
    });
    const carriesParent = (env: NodeJS.ProcessEnv) => Object.values(env).some((value) => value?.includes('parent-synthetic'));

    it('keeps the parent\'s other settings but not its server when given none', async () => {
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', parentConfig());
      const { adapter, env } = await startTask(fakeServer());

      expect(configOf(env)).toEqual(unrelated);
      expect(carriesParent(env)).toBe(false);
      adapter.dispose();
    });

    it('leaves an empty configuration when the parent\'s held only its server', async () => {
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', parentConfig({}));
      const { adapter, env } = await startTask(fakeServer());

      expect(configOf(env)).toEqual({});
      adapter.dispose();
    });

    it('keeps a workspace\'s emptied configuration in place of the host\'s', async () => {
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ model: 'host/model' }));
      const { adapter, env } = await startTask(fakeServer(), taskStart(), { OPENCODE_CONFIG_CONTENT: parentConfig({}) });

      expect(configOf(env)).toEqual({});
      expect(carriesParent(env)).toBe(false);
      adapter.dispose();
    });

    it('passes an unrelated configuration on untouched', async () => {
      const own = '{ "model": "anthropic/claude-sonnet-4" }';
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', own);
      const { adapter, env } = await startTask(fakeServer());

      expect(env.OPENCODE_CONFIG_CONTENT).toBe(own);
      adapter.dispose();
    });

    it('installs the fresh server whole, with none of the parent entry\'s headers or options', async () => {
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', parentConfig());
      const { adapter, env } = await startTask(fakeServer({ 'GET /mcp': () => ({ ordewell: { status: 'connected' } }) }), taskStart({ mcp }));

      expect(configOf(env)).toEqual({
        ...unrelated,
        mcp: { ...unrelated.mcp, ordewell },
        ...unevicted,
        permission: { ...unrelated.permission, ...taskAllow },
      });
      expect(carriesParent(env)).toBe(false);
      expect(await adapter.mcpAttached()).toBe('connected');
      adapter.dispose();
    });

    it('takes the workspace\'s configuration over the parent\'s, stripped the same way', async () => {
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', parentConfig());
      const workspace = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'workspace/model', mcp: { ordewell: parentEntry } }) };

      const bare = await startTask(fakeServer(), taskStart(), workspace);
      expect(configOf(bare.env)).toEqual({ model: 'workspace/model' });
      expect(carriesParent(bare.env)).toBe(false);
      bare.adapter.dispose();

      const tooled = await startTask(fakeServer(), taskStart({ mcp }), workspace);
      expect(configOf(tooled.env)).toEqual({ model: 'workspace/model', mcp: { ordewell }, ...unevicted, permission: taskAllow });
      expect(carriesParent(tooled.env)).toBe(false);
      tooled.adapter.dispose();
    });

    it('strips a workspace\'s configuration under any spelling', async () => {
      const { adapter, env } = await startTask(fakeServer(), taskStart(), { opencode_config_content: parentConfig() });

      expect(JSON.parse(env.opencode_config_content ?? 'null')).toEqual(unrelated);
      expect(carriesParent(env)).toBe(false);
      adapter.dispose();
    });
  });

  it('merges into the configuration the workspace already sets, keeping what it carries', async () => {
    const existing = JSON.stringify({
      model: 'anthropic/claude-sonnet-4',
      mcp: { other: { type: 'local', command: ['x'] } },
      permission: { bash: { '*': 'allow' } },
      agent: { build: { permission: { edit: 'ask' } } },
    });
    const { adapter, env } = await startTask(fakeServer(), taskStart({ mcp }), { OPENCODE_CONFIG_CONTENT: existing });

    expect(configOf(env)).toEqual({
      model: 'anthropic/claude-sonnet-4',
      mcp: { other: { type: 'local', command: ['x'] }, ordewell },
      ...unevicted,
      permission: { bash: { '*': 'allow' }, ...taskAllow },
      agent: { build: { permission: { edit: 'ask' } } },
    });
    adapter.dispose();
  });

  it('keeps a blanket permission policy as the rule the allow comes after', async () => {
    const { adapter, env } = await startTask(fakeServer(), taskStart({ mcp }), { OPENCODE_CONFIG_CONTENT: '{"permission":"ask"}' });

    const config = configOf(env) as { permission: Record<string, string> };
    expect(Object.entries(config.permission)).toEqual([['*', 'ask'], ['ordewell_task_complete', 'allow'], ['ordewell_checkpoint', 'allow'], ['ordewell_read', 'allow'], ['ordewell_apply_patch', 'allow']]);
    adapter.dispose();
  });

  it('runs without the server rather than overwrite a configuration it cannot read', async () => {
    const { adapter, env } = await startTask(fakeServer(), taskStart({ mcp }), { OPENCODE_CONFIG_CONTENT: '// mine\n{}' });

    expect(env.OPENCODE_CONFIG_CONTENT).toBe('// mine\n{}');
    expect(await adapter.mcpAttached()).toBe('failed');
    adapter.dispose();
  });

  it('allows an Ordewell tool under any mode, shows it decided, and still asks about the rest', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, taskStart({ ...planMode, mcp }));
    stream.push(ask('per_t', { permission: 'ordewell_task_complete', patterns: ['*'], metadata: {} }));
    await until(() => server.requests.some((r) => r.path === '/permission/per_t/reply'));
    stream.push(ask('per_b'));
    await until(() => events.some((e) => e.type === 'permission_request' && e.id === 'per_b'));
    stream.push(status('idle'));
    await turn;

    expect(server.requests.find((r) => r.path === '/permission/per_t/reply')?.body).toEqual({ reply: 'once' });
    expect(events.find((e) => e.type === 'permission_request' && e.id === 'per_t')).toEqual({
      type: 'permission_request',
      id: 'per_t',
      name: 'ordewell_task_complete',
      detail: JSON.stringify({ scope: '*' }),
      input: {},
      toolUseId: 'call_1',
      decided: { decision: 'allow' },
    });
    expect(events.find((e) => e.type === 'permission_request' && e.id === 'per_b')).not.toHaveProperty('decided');
    expect(server.requests.some((r) => r.path === '/permission/per_b/reply')).toBe(false);
    adapter.dispose();
  });

  // OpenCode names a tool `<server>_<tool>`, so a server named `ordewell_x` puts its tools under Ordewell's prefix.
  it.each(['ordewell_x_task_complete', 'ordewell_evil'])('asks about %s though it was given the server: only Ordewell\'s own tool names are its', async (permission) => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, taskStart({ ...planMode, mcp }));
    stream.push(ask('per_x', { permission }));
    await until(() => events.some((e) => e.type === 'permission_request'));
    stream.push(status('idle'));
    await turn;

    expect(events.find((e) => e.type === 'permission_request')).not.toHaveProperty('decided');
    expect(server.requests.some((r) => r.path === '/permission/per_x/reply')).toBe(false);
    adapter.dispose();
  });

  it('does not take a tool of another server named alike for its own when it was never given the server', async () => {
    const server = fakeServer();
    const { adapter, events, turn, stream } = await turnWith(server, planMode);
    stream.push(ask('per_t', { permission: 'ordewell_task_complete' }));
    await until(() => events.some((e) => e.type === 'permission_request'));
    stream.push(status('idle'));
    await turn;

    expect(events.find((e) => e.type === 'permission_request')).not.toHaveProperty('decided');
    adapter.dispose();
  });

  it('answers the planner\'s Ordewell tool with an allow at once and holds everything else for the envelope', async () => {
    let settle: (reply: unknown) => void = () => {};
    const server = fakeServer({ 'POST /session/ses_task/message': () => new Promise((resolve) => { settle = resolve; }) });
    const { adapter } = await startTask(server, { kind: 'planner', cwd: '/repo', systemPrompt: 'plan read-only', mcp });
    const events: AgentEvent[] = [];
    const turn = adapter.send('the goal', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(ask('per_s', { permission: 'ordewell_submit_plan', patterns: ['*'], metadata: {} }));
    stream.push(ask('per_w', { permission: 'edit' }));
    await until(() => events.some((e) => e.type === 'permission_request' && e.id === 'per_w'));
    adapter.answerPermission('per_w', { decision: 'deny' });
    await until(() => server.requests.some((r) => r.path === '/permission/per_w/reply'));
    settle({ info: { id: 'msg_a', role: 'assistant' }, parts: [] });
    await turn;

    expect(server.requests.find((r) => r.path === '/permission/per_s/reply')?.body).toEqual({ reply: 'once' });
    expect(server.requests.find((r) => r.path === '/permission/per_w/reply')?.body).toEqual({ reply: 'reject' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'permission_request', id: 'per_s', decided: { decision: 'allow' } }));
    expect(events.find((e) => e.type === 'permission_request' && e.id === 'per_w')).toMatchObject({ ask: { kind: 'other' } });
    adapter.dispose();
  });

  it('reports the server attached once OpenCode lists it as connected, and not when it failed', async () => {
    const connected = await startTask(fakeServer({ 'GET /mcp': () => ({ ordewell: { status: 'connected' } }) }), taskStart({ mcp }));
    expect(await connected.adapter.mcpAttached()).toBe('connected');
    connected.adapter.dispose();

    const failed = await startTask(fakeServer({ 'GET /mcp': () => ({ ordewell: { status: 'failed', error: 'refused' } }) }), taskStart({ mcp }));
    expect(await failed.adapter.mcpAttached()).toBe('failed');
    failed.adapter.dispose();
  });
});


it('runs an OpenCode 1.x listed command through the command endpoint with the task model and agent', async () => {
  const server = fakeServer({
    'GET /command': () => [{ name: 'hello', description: 'Say hello' }, { name: 'greet', description: 'Greet someone', source: 'skill' }],
    'POST /session/ses_task/command': () => ({ info: { id: 'msg_command', role: 'assistant' }, parts: [{ id: 'text-command', type: 'text', messageID: 'msg_command', text: 'Hello Bob' }] }),
  });
  const { adapter: native } = await startTask(server);
  const adapter: TaskModeAgentAdapter = native;
  expect(adapter.commands?.().map((c) => [c.name, c.kind])).toEqual([['compact', 'builtin'], ['hello', 'command'], ['greet', 'skill']]);
  const events: AgentEvent[] = [];
  await adapter.invokeCommand!('hello', 'Bob', (e) => events.push(e));
  expect(server.requests.find((r) => r.path === '/session/ses_task/command')?.body).toEqual({ command: 'hello', arguments: 'Bob', agent: 'build', model: 'anthropic/claude-sonnet-4' });
  expect(events.filter((e) => e.type === 'assistant_text' || e.type === 'turn_end')).toEqual([{ type: 'assistant_text', runId: 'text-command', text: 'Hello Bob' }, { type: 'turn_end' }]);
  adapter.dispose();
});


it('compacts OpenCode 1.x through summarize using the assigned model and the runner boundary', async () => {
  const server: ReturnType<typeof fakeServer> = fakeServer({
    'GET /command': () => [],
    'POST /session/ses_task/summarize': async () => {
      const stream = await server.stream();
      stream.push({ type: 'session.compacted', properties: { sessionID: 'other' } });
      stream.push({ type: 'session.compacted', properties: { sessionID: 'ses_task' } });
      return true;
    },
  });
  const { adapter: native } = await startTask(server);
  const adapter: TaskModeAgentAdapter = native;
  const events: AgentEvent[] = [];
  await adapter.invokeCommand!('compact', '', (e) => events.push(e));
  expect(server.requests.find((r) => r.path.endsWith('/summarize'))?.body).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4', auto: false });
  expect(events.filter((e) => e.type === 'compaction' || e.type === 'turn_end')).toEqual([{ type: 'compaction', trigger: 'manual' }, { type: 'turn_end' }]);
  expect(events.filter((e) => e.type === 'usage' && e.record.compacted)).toEqual([{ type: 'usage', record: { source: 'opencode', compacted: true } }]);
  adapter.dispose();
});


it('reports a refused OpenCode 1.x summarize instead of a successful compaction turn', async () => {
  const server = fakeServer({ 'GET /command': () => [], 'POST /session/ses_task/summarize': () => false });
  const { adapter: native } = await startTask(server);
  const adapter: TaskModeAgentAdapter = native;
  const events: AgentEvent[] = [];
  await adapter.invokeCommand!('compact', '', (e) => events.push(e));
  expect(events.filter((e) => e.type === 'error' || e.type === 'turn_end' || e.type === 'compaction')).toEqual([{ type: 'error', message: 'OpenCode did not compact the session.' }]);
  adapter.dispose();
});


describe('OpenCodeAdapter task mode — request deadlines', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('gives an ordinary request a deadline, so a server that never answers cannot stall the start', async () => {
    const server = fakeServer({ 'GET /api/info': () => new Promise<Reply>(() => {}) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { adapter, started } = await beginTask(server);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await started;

    expect(adapter.version()).toBeNull();
    expect(adapter.nativeSessionId()).toBe('ses_task');
    adapter.dispose();
  });

  it('bounds an interrupt request by the time it was given, and says it was not acknowledged', async () => {
    const server = fakeServer({ 'POST /session/ses_task/abort': () => new Promise<Reply>(() => {}) });
    const { adapter, events, turn, stream } = await turnWith(server, taskStart());
    stream.push(status('busy'));
    await tick();

    const acknowledged = await Promise.race([adapter.interrupt(50), new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 1500))]);

    expect(acknowledged).toBe(false);
    adapter.dispose();
    await turn;
    void events;
  });
});

describe('OpenCodeAdapter task mode — a command turn whose POST is held open', () => {
  const commandRoutes = (post: () => Promise<Reply>) => ({
    'GET /command': () => [{ name: 'hello', description: 'Say hello' }],
    'POST /session/ses_task/command': post,
  });
  const headersTimeout = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });

  it('keeps the turn when the POST dies under it, and ends it on the idle, withdrawing what is still open', async () => {
    let failPost: (err: Error) => void = () => {};
    const server = fakeServer(commandRoutes(() => new Promise<Reply>((_resolve, reject) => { failPost = reject; })));
    const { adapter } = await startTask(server, planMode);
    const events: AgentEvent[] = [];
    const turn = adapter.invokeCommand!('hello', 'Bob', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(status('busy'));
    stream.push(ask('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));

    failPost(headersTimeout());
    await tick();
    expect(events.some((e) => e.type === 'error')).toBe(false);
    stream.push(status('idle'));
    await turn;

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'permission_cancelled', id: 'per_1' });
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('ends an interrupted command as interrupted, not as the abort error it comes back with, and withdraws what is open', async () => {
    let answer: (value: Reply) => void = () => {};
    const server = fakeServer(commandRoutes(() => new Promise<Reply>((resolve) => { answer = resolve; })));
    const { adapter } = await startTask(server, planMode);
    const events: AgentEvent[] = [];
    const turn = adapter.invokeCommand!('hello', 'Bob', (e) => events.push(e));
    const stream = await server.stream();
    server.status[SES] = { type: 'busy' };
    stream.push(status('busy'));
    stream.push(ask('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));

    const acknowledged = adapter.interrupt(1000);
    await until(() => server.requests.some((r) => r.path === '/session/ses_task/abort'));
    answer({ info: { id: 'msg_cmd', role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } }, parts: [] });
    await tick();
    delete server.status[SES];
    stream.push(status('idle'));

    expect(await acknowledged).toBe(true);
    await turn;
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events).toContainEqual({ type: 'permission_cancelled', id: 'per_1' });
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    adapter.dispose();
  });

  it('withdraws what is open when the command ends with its reply', async () => {
    const reply = { info: { id: 'msg_cmd', role: 'assistant' }, parts: [{ id: 'txt', type: 'text', messageID: 'msg_cmd', text: 'done' }] };
    let answer: (value: Reply) => void = () => {};
    const server = fakeServer(commandRoutes(() => new Promise<Reply>((resolve) => { answer = resolve; })));
    const { adapter } = await startTask(server, planMode);
    const events: AgentEvent[] = [];
    const turn = adapter.invokeCommand!('hello', 'Bob', (e) => events.push(e));
    const stream = await server.stream();
    stream.push(status('busy'));
    stream.push(ask('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));

    answer(reply);
    await turn;

    expect(events).toContainEqual({ type: 'permission_cancelled', id: 'per_1' });
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });
});
