import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenCodeAdapter } from '../OpenCodeAdapter';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, SpawnFn, TaskStartOptions, TaskModeAgentAdapter } from '../AgentAdapter';
import { fakeSpawn, sseResponse, type FakeEventStream } from '../../__tests__/harnessTestKit';
import { OPENCODE_ORDEWELL, OPENCODE_PLANNER_PERMISSION, OPENCODE_SEARCH_OFF } from '../openCodeOrdewell';
import { PlannerShellSandbox, plannerShellProfile, sealedShellProfile, type SealedAvailability } from '../../sandbox/plannerSandbox';
import type { SandboxBackend, SandboxProfile } from '../../sandbox/SandboxBackend';
import { mapAgentTool } from '../agentTools';
import { mcpClientConfig, TASK_COMPLETION_CONTRACT, taskCompletionContract } from '../../mcp';
import type { ProjectMcpServer } from '../repoConfig';
import type { StructuredEvent } from '../../../interfaces/IRunner';
import { toTaskLogEvent } from '../../../models/TaskLog';
import { replayTaskLog } from '../../../conversation/taskLog';

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

async function start(server: ReturnType<typeof fakeServer>, opts: AgentStartOptions = taskStart(), sandbox?: () => PlannerShellSandbox) {
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
    ...(sandbox ? { nativeShellSandbox: sandbox } : {}),
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
  it('gives a read-only task restrictive session rules and exposes MCP outside code mode', async () => {
    const server = fakeServer();
    const mcp = mcpClientConfig({ token: 'read-only-test', url: 'http://127.0.0.1:4555/mcp', readOnly: true });
    const { adapter, env } = await start(server, taskStart({ mode: 'plan', workspaceRoot: '/workspace', flags: { readOnly: true, permissionMode: 'build', modeSettings: {} }, mcp }));
    try {
      expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
      const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session')?.body as { agent: string; model: unknown; permissions: Array<{ action: string; resource: string; effect: string }> };
      expect(created.agent).toBe('build');
      expect(created.model).toEqual({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
      for (const action of ['*', 'external_directory', 'edit', 'write', 'patch', 'apply_patch', 'multiedit', 'bash', 'shell', 'task', 'subagent', 'webfetch', 'websearch', 'execute']) expect(created.permissions).toContainEqual({ action, resource: '*', effect: 'deny' });
      for (const action of ['read', 'grep', 'glob', 'list', 'ordewell_run_command', 'ordewell_save_patch', 'ordewell_task_complete', 'ordewell_checkpoint', 'ordewell_fetch', 'ordewell_web_search']) expect(created.permissions).toContainEqual({ action, resource: '*', effect: 'allow' });
      expect(created.permissions).toContainEqual({ action: 'external_directory', resource: '/workspace/*', effect: 'allow' });
      expect(server.requests.find((r) => r.path === '/api/experimental/mcp/ordewell')?.body).toMatchObject({ config: { codemode: false } });
      const events: AgentEvent[] = [];
      const turn = adapter.send('Review', (e) => events.push(e));
      const stream = await server.stream();
      stream.push(started());
      stream.push(permissionAsk('ro-shell'));
      await until(() => server.requests.some((r) => r.path.endsWith('/permission/ro-shell/reply')));
      expect(server.requests.find((r) => r.path.endsWith('/permission/ro-shell/reply'))?.body).toMatchObject({ decision: 'reject' });
      expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ decided: { decision: 'deny' } });
      stream.push(succeeded());
      await turn;
    } finally { adapter.dispose(); }
  });

  it('refuses a read-only task when MCP is reachable only through unchecked code mode', async () => {
    const server = fakeServer({ 'PUT /api/experimental/mcp/ordewell': () => ({ status: 404 }) });
    const mcp = mcpClientConfig({ token: 'read-only-test', url: 'http://127.0.0.1:4555/mcp', readOnly: true });
    await expect(start(server, taskStart({ mode: 'plan', flags: { readOnly: true, permissionMode: 'build', modeSettings: {} }, mcp }))).rejects.toThrow(/code mode/);
    expect(server.requests.some((r) => r.path === '/api/session')).toBe(false);
  });

  it('takes a 2.x server by its /api/info, and secures a planner as it does a task', async () => {
    const server = fakeServer();
    const { adapter, env } = await start(server, plannerStart());

    const password = env.OPENCODE_SERVER_PASSWORD;
    expect(password).toBeTruthy();
    expect(server.requests.some((r) => r.path === '/session')).toBe(false);
    for (const request of server.requests) expect(request.authorization).toBe(basic(password!));
    expect(adapter.nativeSessionId()).toBe(SES);
    // The native-shell check reads it (ADR-0036 N2).
    expect(adapter.version()).toBe('2.0.22');
    adapter.dispose();
  });

  it('creates the planner session read-only: plan agent, model, and Ordewell\'s permission policy', async () => {
    const server = fakeServer({ 'GET /api/config': () => [document({ websearch: { provider: 'exa' } })] });
    const { adapter } = await start(server, plannerStart({ effort: 'high' }));

    const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session');
    expect(created?.body).toEqual({
      agent: 'plan',
      model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'high' },
      permissions: [...Object.entries(OPENCODE_PLANNER_PERMISSION).map(([action, effect]) => ({ action, resource: '*', effect })), ...codeModeOff],
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

  it('keeps a task\'s completion contract on the session as an instruction entry, fresh or resumed', async () => {
    const entry = `/api/experimental/session/${SES}/instructions/entries/ordewell-task`;
    const ORDEWELL_SERVER = { name: 'ordewell' as const, url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer tok-secret' } };

    for (const resumeSessionId of [undefined, SES]) {
      const server = fakeServer({ [`GET /api/session/${SES}`]: () => ({ data: { id: SES } }) });
      const { adapter } = await start(server, taskStart({ mcp: ORDEWELL_SERVER, ...(resumeSessionId ? { resumeSessionId } : {}) }));

      const value = (server.requests.find((r) => r.method === 'PUT' && r.path === entry)?.body as { value?: string } | undefined)?.value ?? '';
      expect(value).toContain('call the `task_complete` tool with status `done` and your handoff');
      expect(value).toContain('Its `summary` is this task\'s handoff to the next task');
      expect(value).not.toContain('tok-secret');
      adapter.dispose();
    }
  });

  it('asks a change task for its commit in that entry, and no other task (ADR-0047)', async () => {
    const entry = `/api/experimental/session/${SES}/instructions/entries/ordewell-task`;
    const mcp = { name: 'ordewell' as const, url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer tok' } };
    const values: unknown[] = [];
    for (const commits of [undefined, true] as const) {
      const server = fakeServer();
      const { adapter } = await start(server, taskStart({ mcp, ...(commits ? { commits } : {}) }));
      values.push((server.requests.find((r) => r.method === 'PUT' && r.path === entry)?.body as { value?: unknown }).value);
      adapter.dispose();
    }

    expect(values).toEqual([TASK_COMPLETION_CONTRACT, taskCompletionContract({ commits: true })]);
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

const codeModeOff = [{ action: 'execute', resource: '*', effect: 'deny' }];
const rules = (policy: Record<string, string>) => Object.entries(policy).map(([action, effect]) => ({ action, resource: '*', effect }));
/** Ordewell's tools, each allowed by its exact name: a pattern would cover a server named `ordewell_<anything>` too. */
const ordewellAllow = [
  'list_runners', 'list_models', 'submit_plan', 'edit_plan', 'task_query', 'task_output', 'task_diff', 'run_command', 'fetch', 'web_search', 'load_skill',
  'run_plan', 'run_task', 'stop_task', 'stop_run', 'retry_task', 'skip_task', 'message_task', 'answer_approval', 'answer_checkpoint', 'merge_all', 'run_script',
].map((tool) => ({ action: `ordewell_${tool}`, resource: '*', effect: 'allow' }));
const taskAllow = ['task_complete', 'checkpoint', 'read', 'apply_patch'].map((tool) => ({ action: `ordewell_${tool}`, resource: '*', effect: 'allow' }));
const document = (info: Record<string, unknown>) => ({ type: 'document', path: '/home/u/.config/opencode/opencode.jsonc', info });

// 2.0.26's `websearch` with no provider chosen asks the user to pick one through `question`, which a planner is denied.
describe('OpenCode 2.x — a planner\'s own search (ADR-0027)', () => {
  const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok' });

  async function planner(config: unknown, overrides: Record<string, unknown> = {}) {
    const server = fakeServer({ 'GET /api/config': () => config });
    const { adapter } = await start(server, plannerStart({ mcp, ...overrides }));
    const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session')?.body as { permissions: unknown[] } | undefined;
    const instructions = server.requests.find((r) => r.path.endsWith('/instructions/entries/ordewell-planner'))?.body as { value: string } | undefined;
    adapter.dispose();
    return { server, permissions: created?.permissions, system: instructions?.value ?? '' };
  }

  it('keeps websearch, asked through the policy, where OpenCode\'s config names a provider', async () => {
    const { permissions, system } = await planner([{ type: 'directory', path: '/x' }, document({ websearch: { provider: 'exa' } })]);

    expect(permissions).toEqual([...rules(OPENCODE_PLANNER_PERMISSION), ...codeModeOff, ...ordewellAllow]);
    expect(system).toBe(`PLAN\n\n${OPENCODE_ORDEWELL.plannerInstructions(true)}`);
  });

  it.each([
    ['no layer sets websearch', [document({ mcp: {} })]],
    ['websearch is disabled', [document({ websearch: false })]],
    ['the last layer that sets it disables it', [document({ websearch: { provider: 'exa' } }), document({ websearch: false })]],
    ['the config cannot be read', { status: 500 }],
  ])('denies websearch and codesearch, and points at Ordewell\'s web_search, where %s', async (_label, config) => {
    const { permissions, system } = await planner(config);

    expect(permissions).toEqual([...rules(OPENCODE_PLANNER_PERMISSION), ...rules(OPENCODE_SEARCH_OFF), ...codeModeOff, ...ordewellAllow]);
    expect(system).toBe(`PLAN\n\n${OPENCODE_ORDEWELL.plannerInstructions(false)}`);
  });

  it('takes the last layer that sets websearch, as OpenCode does', async () => {
    const { permissions } = await planner([document({ websearch: false }), document({ theme: 'x' }), document({ websearch: { provider: 'random' } })]);

    expect(permissions).not.toEqual(expect.arrayContaining([{ action: 'websearch', resource: '*', effect: 'deny' }]));
  });

  it.each([
    ['created with search off', [...rules(OPENCODE_PLANNER_PERMISSION), ...rules(OPENCODE_SEARCH_OFF), ...codeModeOff], false],
    ['created with search on', [...rules(OPENCODE_PLANNER_PERMISSION), ...codeModeOff], true],
  ])('tells a resumed session %s what its own rules allow', async (_label, permissions, ownSearch) => {
    const server = fakeServer({ [`GET /api/session/${SES}`]: () => ({ data: { id: SES, permissions } }), 'GET /api/config': () => [document({ websearch: { provider: 'exa' } })] });
    const { adapter } = await start(server, plannerStart({ mcp, resumeSessionId: SES }));

    const instructions = server.requests.find((r) => r.path.endsWith('/instructions/entries/ordewell-planner'))?.body as { value: string };
    expect(instructions.value).toBe(`PLAN\n\n${OPENCODE_ORDEWELL.plannerInstructions(ownSearch)}`);
    adapter.dispose();
  });

  it('says in every case where to search when websearch fails or is cancelled', () => {
    expect(OPENCODE_ORDEWELL.plannerInstructions(true)).toMatch(/If `websearch` fails, is cancelled or is unavailable for your provider, search with `ordewell_web_search`/);
    expect(OPENCODE_ORDEWELL.plannerInstructions(false)).toContain('Search the web with `ordewell_web_search`');
  });

  // Planner-only: a task, an ops task above all (ADR-0020), keeps OpenCode's own search as the user set it up.
  it.each([
    ['without the server', {}],
    ['with the server', { mcp }],
  ])('leaves a task session exactly as it was, %s, and never reads the search config', async (_label, overrides) => {
    const server = fakeServer({ 'GET /api/config': () => [document({ websearch: false })] });
    const { adapter, env } = await start(server, taskStart(overrides));

    const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session');
    expect(created?.body).toEqual({
      agent: 'build',
      model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' },
      permissions: [{ action: 'question', resource: '*', effect: 'deny' }, ...('mcp' in overrides ? taskAllow : [])],
    });
    expect(server.requests.some((r) => r.path === '/api/config')).toBe(false);
    expect(env.OPENCODE_CONFIG_CONTENT ?? '').not.toContain('websearch');
    adapter.dispose();
  });
});

/**
 * A start that builds the launcher: a `/bin/sh` script with its short temp
 * folder under `/tmp`. The native shell is offered on macOS only (ADR-0036 N5),
 * and a Windows host has neither.
 */
const launcherIt = it.skipIf(process.platform === 'win32');

describe('OpenCode 2.x — the native shell (ADR-0036 N2)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function workspace(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-native-opencode-')));
    dirs.push(dir);
    return dir;
  }

  /** The host's sandbox, with a backend that only records what it was asked to wrap. */
  function nativeSandbox(profiles: SandboxProfile[] = []): () => PlannerShellSandbox {
    const backend: SandboxBackend = {
      name: 'fake',
      probe: async () => ({ ok: true }),
      wrap: (invocation, profile) => {
        profiles.push(profile);
        return {
          file: '/usr/bin/sandbox-exec',
          args: ['-p', 'PROFILE', invocation.shell, ...invocation.shellArgs],
          env: { ...invocation.env, ...profile.env },
        };
      },
    };
    const sealed: SealedAvailability = {
      available: true,
      profile: (opts) => sealedShellProfile({ platform: 'darwin', reads: ['/usr'], masked: [], overlay: false }, opts),
    };
    return () => new PlannerShellSandbox(async () => ({
      available: true,
      backend,
      profile: (opts) => plannerShellProfile({ platform: 'darwin', services: [] }, opts),
      sealed,
    }));
  }

  launcherIt('names the launcher in SHELL and the config, asks for both shell spellings, and starts the server credential-free', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.stubEnv('OPENCODE_API_KEY', 'oc-login');
    vi.stubEnv('DEEPSEEK_API_KEY', 'provider-secret');
    const profiles: SandboxProfile[] = [];
    const server = fakeServer();
    const { adapter, env } = await start(server, plannerStart({ cwd: workspace(), nativeShell: true }), nativeSandbox(profiles));
    const launcher = env.SHELL;
    try {
      expect(launcher).toBeTruthy();
      expect(existsSync(launcher!)).toBe(true);
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null') as { shell?: string; permission: Record<string, string> };
      expect(config.shell).toBe(launcher);
      expect(config.permission).toMatchObject({ bash: 'ask', shell: 'ask', edit: 'deny', write: 'deny' });

      // N2.2: the server process has no user credential, and keeps OpenCode's own login (N3).
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.DEEPSEEK_API_KEY).toBeUndefined();
      expect(env.OPENCODE_API_KEY).toBe('oc-login');

      const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session')?.body as { permissions: Array<{ action: string; effect: string }> };
      expect(created.permissions).toContainEqual({ action: 'shell', resource: '*', effect: 'ask' });
      expect(created.permissions).toContainEqual({ action: 'bash', resource: '*', effect: 'ask' });

      // N2, N3: the sealed profile with the network, the keychain withheld, and
      // the launcher outside every writable directory.
      const profile = profiles[0];
      expect(profile.network).toBe(true);
      expect(profile.keychain).toBe(false);
      expect(profile.write.some((dir) => launcher!.startsWith(`${dir}/`))).toBe(false);
    } finally {
      adapter.dispose();
    }
    expect(existsSync(launcher!)).toBe(false);
  });

  it('leaves SHELL, the config and the policy alone with the flag off', async () => {
    const server = fakeServer();
    const { adapter, env } = await start(server, plannerStart({ cwd: workspace() }));
    try {
      expect(env.SHELL).toBe(process.env.SHELL);
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null') as { shell?: string; permission: Record<string, string> };
      expect(config.shell).toBeUndefined();
      expect(config.permission).toMatchObject({ bash: 'deny', shell: 'deny' });
      const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session')?.body as { permissions: Array<{ action: string; effect: string }> };
      expect(created.permissions).toContainEqual({ action: 'shell', resource: '*', effect: 'deny' });
      expect(created.permissions).toContainEqual({ action: 'bash', resource: '*', effect: 'deny' });
    } finally {
      adapter.dispose();
    }
  });

  launcherIt('routes a shell request to the native-shell kind the opt-in allows', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, plannerStart({ cwd: workspace(), nativeShell: true }), nativeSandbox());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(permissionAsk('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({
      ask: { kind: 'native-shell', tool: 'shell', command: 'echo hi' },
    });
    expect(await adapter.answerPermission('per_1', { decision: 'allow' })).toBe(true);
    stream.push(succeeded());
    await turn;
    adapter.dispose();
  });

  launcherIt('fails a call whose shell.created names another shell, and reports it on that call', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, plannerStart({ cwd: workspace(), nativeShell: true }), nativeSandbox());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    for (const f of call('call_1', { command: 'echo hi' }, 'shell')) stream.push(f);
    stream.push({ type: 'shell.created', data: { info: { id: 'sh_1', shell: '/bin/sh', command: 'echo hi', metadata: { sessionID: SES } } } });
    stream.push(frame('session.tool.success', { assistantMessageID: MSG, id: 'call_1', content: [{ type: 'text', text: 'hi' }] }));
    stream.push(succeeded());
    await turn;

    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      id: 'call_1',
      name: 'shell',
      success: false,
      output: expect.stringContaining('not Ordewell'),
    });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('not Ordewell') });
    adapter.dispose();
  });

  launcherIt('accepts a shell.created naming Ordewell\'s launcher, and reports each command as a bash step', async () => {
    const server = fakeServer();
    const { adapter, env } = await start(server, plannerStart({ cwd: workspace(), nativeShell: true }), nativeSandbox());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    for (const f of call('call_1', { command: 'echo hi' }, 'shell')) stream.push(f);
    stream.push({ type: 'shell.created', data: { info: { id: 'sh_1', shell: env.SHELL, command: 'echo hi', metadata: { sessionID: SES } } } });
    stream.push(frame('session.tool.success', { assistantMessageID: MSG, id: 'call_1', content: [{ type: 'text', text: 'hi' }] }));
    stream.push(succeeded());
    await turn;

    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ id: 'call_1', name: 'shell', output: 'hi', success: true });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(mapAgentTool('shell')).toEqual({ tool: 'bash', toolLabel: 'shell' });
    adapter.dispose();
  });

  it('fails the start rather than run the shell outside a sandbox', async () => {
    const server = fakeServer();
    const spawned = fakeSpawn([]);
    const adapter = new OpenCodeAdapter({
      spawn: spawned.spawn,
      fetch: server.fetch,
      resolvePath: async () => '/usr/bin',
      platform: 'linux',
      isDirectory: () => true,
      exists: () => true,
      workspaceEnv: async () => ({}),
      nativeShellSandbox: () => new PlannerShellSandbox(async () => ({ available: false, notice: 'no sandbox' })),
    });
    await expect(adapter.start(plannerStart({ cwd: workspace(), nativeShell: true })))
      .rejects.toThrow('could not put this planner\'s shell in its sandbox');
    expect(spawned.processes).toHaveLength(0);
    adapter.dispose();
  });

  launcherIt('resumes a planner session whose shell rules match the opt-in, and starts fresh when they do not', async () => {
    const shellAsk = rules(OPENCODE_PLANNER_PERMISSION).map((rule) => (rule.action === 'bash' || rule.action === 'shell' ? { ...rule, effect: 'ask' } : rule));
    const resumable = fakeServer({ [`GET /api/session/${SES}`]: () => ({ data: { id: SES, permissions: [...shellAsk, ...codeModeOff] } }) });
    const resumed = await start(resumable, plannerStart({ cwd: workspace(), nativeShell: true, resumeSessionId: SES }), nativeSandbox());
    expect(resumed.adapter.nativeSessionId()).toBe(SES);
    resumed.adapter.dispose();

    // Created without the opt-in: its saved shell deny would leave the new
    // process a shell it may ask nothing about (ADR-0036 N1).
    const stale = fakeServer({
      [`GET /api/session/${SES}`]: () => ({ data: { id: SES, permissions: [...rules(OPENCODE_PLANNER_PERMISSION), ...codeModeOff] } }),
      'POST /api/session': () => ({ data: { id: 'ses_new' } }),
    });
    const fresh = await start(stale, plannerStart({ cwd: workspace(), nativeShell: true, resumeSessionId: SES }), nativeSandbox());
    expect(fresh.adapter.nativeSessionId()).toBe('ses_new');
    fresh.adapter.dispose();
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

  it('reports each message\'s text as a run of its own, with no paragraph break before it', async () => {
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

    expect(events.filter((e) => e.type === 'assistant_text')).toEqual([
      { type: 'assistant_text', runId: 'msg_a:0', text: 'First.' },
      { type: 'assistant_text', runId: 'msg_b:0', text: 'Second.' },
    ]);
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

  // A text part's ordinal counts the message's text parts only (OpenCode
  // 2.0.32's runner), so the read-back names the run the stream named.
  it('reads back text whose end frame was dropped as the run it streamed as, where it streamed', async () => {
    const server = fakeServer({
      [`GET /api/session/${SES}/message`]: () => ({
        data: [
          { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
          { id: 'msg_b', type: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
          { id: MSG, type: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Checking the tree.' }, { type: 'tool', id: 'call_1' }] },
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
    stream.push(frame('session.reasoning.ended', { assistantMessageID: MSG, ordinal: 0, text: 'hmm' }));
    stream.push(frame('session.text.delta', { assistantMessageID: MSG, ordinal: 0, delta: 'Checking ' }));
    for (const f of call('call_1', { command: 'ls' }, 'bash')) stream.push(f);
    stream.push(frame('session.tool.success', { assistantMessageID: MSG, id: 'call_1', content: [{ type: 'text', text: 'src' }] }));
    stream.push(frame('session.text.ended', { assistantMessageID: 'msg_b', ordinal: 0, text: 'Done.' }));
    stream.push(succeeded());
    await turn;

    expect(events.filter((e) => e.type === 'assistant_text')).toEqual([
      { type: 'assistant_text', runId: 'msg_b:0', text: 'Done.' },
      { type: 'assistant_text', runId: 'msg_a:0', text: 'Checking the tree.' },
    ]);
    const log = replayTaskLog(events.flatMap((e) => (e.type === 'turn_end' ? [] : toTaskLogEvent(e as StructuredEvent) ?? [])));
    expect(log.blocks.map((b) => (b.type === 'message' ? b.text : b.type))).toEqual(['thinking', 'Checking the tree.', 'tool', 'Done.']);
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
    // Already decided, it offers no grant to choose.
    expect(events.find((e) => e.type === 'permission_request')).toEqual({
      type: 'permission_request', id: 'per_1', name: 'shell', detail: expect.any(String), input: expect.any(Object), toolUseId: 'call_1', decided: { decision: 'allow' },
    });
    adapter.dispose();
  });

  it('keeps a failed permission reply open on 2.x so it can be retried', async () => {
    let attempts = 0;
    const server = fakeServer({ [`POST /api/session/${SES}/permission/per_1/reply`]: () => {
      if (++attempts === 1) return { status: 502 };
      return {};
    } });
    const { adapter } = await start(server, taskStart({ flags: { permissionMode: 'plan', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (event) => events.push(event));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push(permissionAsk('per_1'));
    await until(() => events.some((e) => e.type === 'permission_request'));
    await expect(adapter.answerPermission('per_1', { decision: 'allow' })).rejects.toThrow('502');
    expect(events).toContainEqual(expect.objectContaining({ type: 'thinking', text: expect.stringContaining('The request is still open.') }));
    expect(await adapter.answerPermission('per_1', { decision: 'deny' })).toBe(true);
    stream.push(succeeded());
    await turn;
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
    expect(await adapter.answerPermission('per_1', { decision: 'allowForTask' })).toBe(true);
    await until(() => server.requests.some((r) => r.path.endsWith('/permission/per_1/reply')));
    expect(server.requests.find((r) => r.path.endsWith('/permission/per_1/reply'))?.body).toEqual({ decision: 'always' });
    expect(await adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
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
    expect(await adapter.answerPermission('per_1', { decision: 'deny', note: 'not that' })).toBe(true);
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

    expect(await adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
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
    expect(await adapter.answerPermission('per_1', { decision: 'deny' })).toBe(true);
    await until(() => server.requests.some((r) => r.path.endsWith('/permission/per_1/reply')));
    stream.push(succeeded());
    await turn;

    expect(server.requests.find((r) => r.path.endsWith('/permission/per_1/reply'))?.body).toEqual({ decision: 'reject' });
    expect(await adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
    adapter.dispose();
  });
});

const ORDEWELL = { name: 'ordewell' as const, url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer t' } };

/** Approved project servers (ADR-0028), as `opencode.json` declares them. */
const PROBE: ProjectMcpServer = {
  name: 'probe', source: 'opencode.json', transport: 'stdio', target: 'node serve.js', names: ['TOKEN'],
  definition: { type: 'local', command: ['node', 'serve.js'], environment: { TOKEN: 'x' }, timeout: 5000 },
};
const DOCS: ProjectMcpServer = {
  name: 'docs', source: 'opencode.json', transport: 'remote', target: 'https://docs.example/mcp', names: ['Authorization'],
  definition: { type: 'remote', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer d' } },
};

describe('OpenCode 2.x — MCP servers', () => {
  it('lists Ordewell\'s tools as tools of their own, not inside code mode\'s `execute`', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, taskStart({ mcp: { name: 'ordewell', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer t' } } }));

    const replaced = server.requests.find((r) => r.method === 'PUT' && r.path === '/api/experimental/mcp/ordewell');
    expect(replaced?.body).toEqual({ config: { type: 'remote', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer t' }, codemode: false } });
    expect(server.requests.indexOf(replaced!)).toBeLessThan(server.requests.findIndex((r) => r.path === '/api/session'));
    adapter.dispose();
  });

  it.each([
    ['planner', () => plannerStart({ mcp: ORDEWELL })],
    ['task', () => taskStart({ mcp: ORDEWELL })],
  ])('keeps a %s\'s Ordewell tools out of code mode on a turn after OpenCode rebuilt its services', async (_role, opts) => {
    // 2.x rebuilds an evicted or reloaded location from the configuration it
    // was launched with: a server replaced at runtime is back in code mode,
    // still connected, its tools offered to the model only inside `execute`
    // (checked against 2.1.4).
    let outsideCodeMode = false;
    const offered: boolean[] = [];
    const server = fakeServer({
      'PUT /api/experimental/mcp/ordewell': (body) => {
        outsideCodeMode = (body as { config: { codemode?: boolean } }).config.codemode === false;
        return { status: 204 };
      },
      [`POST /api/session/${SES}/prompt`]: () => {
        offered.push(outsideCodeMode);
        return { data: { id: 'msg_user', type: 'user' } };
      },
    });
    const { adapter } = await start(server, opts());
    const turn = async (n: number) => {
      const ended = adapter.send('go', () => {});
      const stream = await server.stream(n);
      await until(() => offered.length > n);
      stream.push(started());
      stream.push(succeeded());
      await ended;
    };

    await turn(0);
    outsideCodeMode = false;
    await turn(1);

    expect(offered).toEqual([true, true]);
    adapter.dispose();
  });

  it('reports Ordewell\'s server connected only once OpenCode offers the model its tools', async () => {
    // 2.x hands a server's tools to the model 100 ms after they change, debounced, and says
    // the server is connected before that: a prompt sent at once is offered none (checked against 2.1.4).
    let connectedAt: number | null = null;
    const offered: boolean[] = [];
    const server = fakeServer({
      'GET /api/mcp': () => {
        connectedAt ??= Date.now();
        return { data: [{ name: 'ordewell', status: { status: 'connected' } }] };
      },
      [`POST /api/session/${SES}/prompt`]: () => {
        offered.push(connectedAt !== null && Date.now() - connectedAt >= 100);
        return { data: { id: 'msg_user', type: 'user' } };
      },
    });
    const { adapter } = await start(server, plannerStart({ mcp: ORDEWELL }));
    expect(await adapter.mcpAttached()).toBe('connected');

    const ended = adapter.send('go', () => {});
    const stream = await server.stream();
    await until(() => offered.length > 0);
    stream.push(started());
    stream.push(succeeded());
    await ended;

    expect(offered).toEqual([true]);
    adapter.dispose();
  });

  it('fails a planner\'s turn, sending nothing, when OpenCode will not take Ordewell\'s tools out of code mode again', async () => {
    let refuse = false;
    const server = fakeServer({ 'PUT /api/experimental/mcp/ordewell': () => ({ status: refuse ? 500 : 204 }) });
    const { adapter } = await start(server, plannerStart({ mcp: ORDEWELL }));
    refuse = true;

    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => events.push(e));

    expect(events).toEqual([{
      type: 'error',
      message: 'OpenCode would not list Ordewell\'s tools as tools of their own again, and the planner may not reach them inside code mode: the message was not sent.',
    }]);
    expect(server.requests.some((r) => r.path.endsWith('/prompt'))).toBe(false);
    adapter.dispose();
  });

  it('denies a planner `execute`, which 2.x never asks about', async () => {
    const server = fakeServer();
    (await start(server, plannerStart({ mcp: ORDEWELL }))).adapter.dispose();

    const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session')?.body as { permissions: unknown[] };
    expect(created.permissions).toContainEqual({ action: 'execute', resource: '*', effect: 'deny' });
  });

  it('refuses to start a planner where Ordewell\'s tools would only be reachable through `execute`, and creates no session', async () => {
    const server = fakeServer({ 'PUT /api/experimental/mcp/ordewell': () => ({ status: 404 }), 'GET /api/info': () => ({ version: '2.0.9' }) });

    await expect(start(server, plannerStart({ mcp: ORDEWELL, projectServers: [PROBE] }))).rejects.toThrow(
      'OpenCode 2.0.9 cannot run the planner safely: it can only offer Ordewell\'s tools inside code mode, which runs code the model writes without asking. '
      + 'This planner needs an OpenCode version that can list MCP tools outside code mode. Update OpenCode, or choose another runner.',
    );
    expect(server.requests.some((r) => r.method === 'POST' && r.path === '/api/session')).toBe(false);
    expect(server.requests.some((r) => r.path === '/api/experimental/mcp/probe')).toBe(false);
  });

  it('starts a task the same way where Ordewell\'s tools are only reachable through `execute`', async () => {
    const server = fakeServer({ 'PUT /api/experimental/mcp/ordewell': () => ({ status: 404 }) });
    const { adapter } = await start(server, taskStart({ mcp: ORDEWELL }));

    const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session')?.body as { permissions: unknown[] };
    expect(created.permissions).toEqual([{ action: 'question', resource: '*', effect: 'deny' }, ...taskAllow]);
    adapter.dispose();
  });

  it.each([
    ['without any rules', undefined],
    ['without the `execute` deny', rules(OPENCODE_PLANNER_PERMISSION)],
    ['with `execute` allowed after its deny', [...rules(OPENCODE_PLANNER_PERMISSION), ...codeModeOff, { action: 'execute', resource: '*', effect: 'allow' }]],
  ])('starts a fresh planner session rather than resume one created %s', async (_label, permissions) => {
    const server = fakeServer({ [`GET /api/session/${SES}`]: () => ({ data: { id: SES, permissions } }), 'POST /api/session': () => ({ data: { id: 'ses_new' } }) });
    const { adapter } = await start(server, plannerStart({ mcp: ORDEWELL, resumeSessionId: SES }));

    expect(adapter.nativeSessionId()).toBe('ses_new');
    const created = server.requests.find((r) => r.method === 'POST' && r.path === '/api/session')?.body as { permissions: unknown[] };
    expect(created.permissions).toContainEqual({ action: 'execute', resource: '*', effect: 'deny' });
    expect(server.requests.some((r) => r.path === `/api/session/${SES}/agent`)).toBe(false);
    adapter.dispose();
  });

  it('resumes a planner session created with `execute` denied', async () => {
    const server = fakeServer({ [`GET /api/session/${SES}`]: () => ({ data: { id: SES, permissions: [...rules(OPENCODE_PLANNER_PERMISSION), ...codeModeOff] } }) });
    const { adapter } = await start(server, plannerStart({ mcp: ORDEWELL, resumeSessionId: SES }));

    expect(adapter.nativeSessionId()).toBe(SES);
    expect(server.requests.some((r) => r.method === 'POST' && r.path === '/api/session')).toBe(false);
    adapter.dispose();
  });

  it('lists a planner\'s approved project servers\' tools as tools of their own, each replaced once in its own shape', async () => {
    const server = fakeServer();
    const { adapter } = await start(server, plannerStart({ mcp: ORDEWELL, projectServers: [PROBE, DOCS] }));

    const replaced = server.requests.filter((r) => r.method === 'PUT' && r.path.startsWith('/api/experimental/mcp/'));
    expect(replaced.map((r) => [r.path, r.body])).toEqual([
      ['/api/experimental/mcp/ordewell', { config: { type: 'remote', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer t' }, codemode: false } }],
      // A 1.x `timeout` is a number, which 2.x's route refuses: only what reaches the server is handed over.
      ['/api/experimental/mcp/probe', { config: { type: 'local', command: ['node', 'serve.js'], environment: { TOKEN: 'x' }, codemode: false } }],
      ['/api/experimental/mcp/docs', { config: { type: 'remote', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer d' }, codemode: false } }],
    ]);
    expect(server.requests.indexOf(replaced[2])).toBeLessThan(server.requests.findIndex((r) => r.path === '/api/session'));
    adapter.dispose();
  });

  it('tells the planner, and reports, an approved server whose tools this OpenCode cannot list as tools of their own', async () => {
    const server = fakeServer({ 'PUT /api/experimental/mcp/probe': () => ({ status: 404 }) });
    const { adapter } = await start(server, plannerStart({ mcp: ORDEWELL, projectServers: [PROBE, DOCS] }));

    expect(adapter.unusableProjectServers()).toEqual([PROBE]);
    const instructions = server.requests.find((r) => r.path.endsWith('/instructions/entries/ordewell-planner'))?.body as { value: string };
    expect(instructions.value).toContain('- probe (opencode.json): not usable on this OpenCode version');
    expect(instructions.value).not.toContain('- docs');
    adapter.dispose();
  });

  it('never takes a request for an unusable server\'s tool for an MCP tool, though OpenCode lists the server', async () => {
    const server = fakeServer({
      'PUT /api/experimental/mcp/probe': () => ({ status: 404 }),
      'GET /api/mcp': () => ({ data: [{ name: 'ordewell', status: { status: 'connected' } }, { name: 'probe', status: { status: 'connected' } }] }),
    });
    const { adapter } = await start(server, plannerStart({ mcp: ORDEWELL, projectServers: [PROBE] }));
    await adapter.mcpAttached();

    const events: AgentEvent[] = [];
    void adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push({ type: 'permission.asked', data: { id: 'per_1', sessionID: SES, action: 'probe_echo', resources: ['*'] } });
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(events.flatMap((e) => (e.type === 'permission_request' ? [e.ask] : []))).toEqual([{ kind: 'other' }]);
    adapter.dispose();
  });

  it('takes a planner request for an approved project server\'s tool as that tool, before /api/mcp lists the server', async () => {
    const server = fakeServer({ 'GET /api/mcp': () => ({ data: [{ name: 'ordewell', status: { status: 'connected' } }] }) });
    const { adapter } = await start(server, plannerStart({ mcp: ORDEWELL, projectServers: [PROBE] }));
    expect(await adapter.mcpAttached()).toBe('connected');

    const events: AgentEvent[] = [];
    void adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    stream.push({ type: 'permission.asked', data: { id: 'per_1', sessionID: SES, action: 'probe_echo', resources: ['*'] } });
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(events.flatMap((e) => (e.type === 'permission_request' ? [e.ask] : []))).toEqual([{ kind: 'mcp', scope: 'probe_echo', tool: 'echo', server: 'probe' }]);
    adapter.dispose();
  });

  it('reads the attach state from /api/mcp, and takes a planner request for a listed server\'s tool as that tool', async () => {
    const server = fakeServer({
      'GET /api/mcp': () => ({ data: [{ name: 'ordewell', status: { status: 'connected' } }, { name: 'todoist', status: { status: 'connected' } }] }),
    });
    const { adapter } = await start(server, plannerStart({ mcp: { name: 'ordewell', url: 'http://127.0.0.1:1/mcp', headers: {} } }));
    expect(await adapter.mcpAttached()).toBe('connected');

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

describe('OpenCode 2.x — an interrupt that raced the turn\'s own end', () => {
  async function interruptedThen(end: unknown) {
    const server = fakeServer({ [`POST /api/session/${SES}/interrupt`]: () => ({ interrupted: true }) });
    const { adapter } = await start(server, taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const stream = await server.stream();
    await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
    stream.push(started());
    const interrupted = adapter.interrupt(5000);
    await until(() => server.requests.some((r) => r.path.endsWith('/interrupt')));
    stream.push(end);
    await interrupted;
    await turn;
    adapter.dispose();
    return events;
  }

  it('ends a turn OpenCode reports succeeded as completed, so its completion reminder is still owed', async () => {
    expect(await interruptedThen(succeeded())).toEqual([{ type: 'turn_end' }]);
  });

  it('ends a turn OpenCode reports failed as failed, with its error', async () => {
    const events = await interruptedThen(frame('session.execution.failed', { error: { type: 'provider.rate-limit', message: 'Usage limit reached' } }));
    expect(events).toEqual([{ type: 'error', message: 'Usage limit reached' }]);
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
    expect(await adapter.answerPermission('per_1', { decision: 'allow' })).toBe(false);
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

  it('reports an interrupt false when the server never answers the request within the time it was given', async () => {
    const server = fakeServer({ [`POST /api/session/${SES}/interrupt`]: () => new Promise<Reply>(() => {}) });
    const { adapter, turn, stream } = await turnOf(server);

    const answer = await Promise.race([adapter.interrupt(50), new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 1500))]);

    expect(answer).toBe(false);
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

    expect(events).toEqual([{ type: 'assistant_text', runId: 'msg_a:0', text: 'Split <<<MARKER>>>' }, { type: 'turn_end' }]);
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
      { type: 'usage', record: { source: 'opencode', inputTokens: 5, outputTokens: 2, contextTokens: 7 } },
      { type: 'usage', record: { source: 'opencode', inputTokens: 7, outputTokens: 3, reportedCost: { amount: 0.002, currency: 'USD', kind: 'estimate' }, subagentId: 'call_task' } },
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

describe('OpenCode 2.x — a planner\'s saved output (ADR-0032)', () => {
  it('lets the planner read back exactly the files its own results were saved to, never the shared folder', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ordewell-tool-output-'));
    const saved = join(folder, 'tool_mine');
    const unsaved = join(folder, 'tool_short');
    const other = join(folder, 'tool_another_session');
    for (const file of [saved, unsaved, other]) writeFileSync(file, 'row 1');
    try {
      const server = fakeServer();
      const { adapter } = await start(server, plannerStart());
      const events: AgentEvent[] = [];
      void adapter.send('go', (e) => events.push(e));
      const stream = await server.stream();
      await until(() => server.requests.some((r) => r.path.endsWith('/prompt')));
      stream.push(started());
      for (const [id, outputPath, truncated] of [['call_long', saved, true], ['call_short', unsaved, false]] as const) {
        for (const f of call(id, {}, 'probe_dump')) stream.push(f);
        stream.push(frame('session.tool.success', { id, content: [{ type: 'text', text: 'row 1' }], metadata: { truncated, outputPath } }));
      }
      for (const f of call('call_read', { path: saved, offset: 1 }, 'read')) stream.push(f);
      stream.push({ type: 'permission.asked', data: { id: 'per_1', sessionID: SES, action: 'external_directory', resources: [`${folder}/*`], source: { type: 'tool', messageID: MSG, id: 'call_read' } } });
      await until(() => events.some((e) => e.type === 'permission_request'));

      // The request names the folder; the call it came from names the file.
      expect(events.flatMap((e) => (e.type === 'permission_request' ? [e.ask] : []))).toEqual([{ kind: 'path', path: saved, directory: false }]);
      expect(adapter.savedOutput(realpathSync.native(saved))).toBe(true);
      expect(adapter.savedOutput(realpathSync.native(unsaved))).toBe(false);
      expect(adapter.savedOutput(realpathSync.native(other))).toBe(false);
      expect(adapter.savedOutput(realpathSync.native(folder))).toBe(false);
      adapter.dispose();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});


it('lists OpenCode 2.x native commands and skills, plus compaction, for a task', async () => {
  const server = fakeServer({
    'GET /api/command': () => ({ data: [{ name: 'hello', description: 'Say hello' }] }),
    'GET /api/skill': () => ({ data: [{ id: 'skill-greet', name: 'greet', description: 'Greet someone' }] }),
    'GET /api/mcp': () => ({ data: [{ name: 'ordewell', status: { status: 'connected' } }, { name: 'docs', status: { status: 'connected' } }] }),
  });
  const { adapter: native } = await start(server);
  const adapter: TaskModeAgentAdapter = native;
  expect(adapter.commands?.()).toEqual([
    { name: 'compact', description: 'Compact the conversation context', kind: 'builtin', aliases: ['summarize'] },
    { name: 'hello', description: 'Say hello', kind: 'command' },
    { name: 'greet', description: 'Greet someone', kind: 'skill' },
  ]);
  const events: AgentEvent[] = [];
  const turn = adapter.send('hi', (e) => events.push(e));
  const stream = await server.stream();
  stream.push(started()); stream.push(succeeded());
  await turn;
  expect(events.find((e) => e.type === 'runner_loaded')).toEqual({ type: 'runner_loaded', commands: adapter.commands?.(), mcpServers: [{ name: 'docs', status: 'connected' }] });
  adapter.dispose();
});


it('runs an OpenCode 2.x custom command through its native endpoint and waits for execution', async () => {
  const server = fakeServer({ 'GET /api/command': () => ({ data: [{ name: 'hello', description: 'Say hello' }] }), 'POST /api/session/ses_v2/command': () => ({ status: 204 }) });
  const { adapter: native } = await start(server);
  const adapter: TaskModeAgentAdapter = native;
  const events: AgentEvent[] = [];
  let ended = false;
  const turn = adapter.invokeCommand!('hello', 'Bob', (e) => events.push(e)).then(() => { ended = true; });
  const stream = await server.stream();
  await until(() => server.requests.some((r) => r.path === '/api/session/ses_v2/command'));
  expect(server.requests.find((r) => r.path === '/api/session/ses_v2/command')?.body).toEqual({ name: 'hello', text: 'Bob' });
  expect(ended).toBe(false);
  stream.push(started()); stream.push(frame('session.text.ended', { assistantMessageID: MSG, ordinal: 0, text: 'Hello Bob' })); stream.push(succeeded());
  await turn;
  expect(events.filter((e) => e.type === 'assistant_text' || e.type === 'turn_end')).toEqual([{ type: 'assistant_text', runId: 'msg_a:0', text: 'Hello Bob' }, { type: 'turn_end' }]);
  expect(server.requests.some((r) => r.path.endsWith('/prompt'))).toBe(false);
  adapter.dispose();
});


it('activates a listed OpenCode 2.x skill by its native id with user arguments', async () => {
  const server = fakeServer({ 'GET /api/skill': () => ({ data: [{ id: 'skill-greet', name: 'greet', description: 'Greet someone' }] }) });
  const { adapter: native } = await start(server);
  const adapter: TaskModeAgentAdapter = native;
  const turn = adapter.invokeCommand!('greet', 'Bob', () => {});
  const stream = await server.stream();
  await until(() => server.requests.some((r) => r.method === 'POST' && (r.path.endsWith('/prompt') || r.path.endsWith('/command'))));
  expect(server.requests.find((r) => r.path.endsWith('/prompt'))?.body).toEqual({ text: 'Bob', skills: [{ id: 'skill-greet' }] });
  stream.push(started()); stream.push(succeeded());
  await turn;
  adapter.dispose();
});


it('compacts OpenCode 2.x natively and logs the completed boundary without affecting other sessions', async () => {
  const server = fakeServer({ 'GET /api/command': () => ({ data: [] }), 'POST /api/session/ses_v2/compact': () => ({ data: { id: 'compact-input' } }) });
  const { adapter: native } = await start(server);
  const adapter: TaskModeAgentAdapter = native;
  const events: AgentEvent[] = [];
  const turn = adapter.invokeCommand!('summarize', '', (e) => events.push(e));
  const stream = await server.stream();
  await until(() => server.requests.some((r) => r.method === 'POST' && (r.path.endsWith('/compact') || r.path.endsWith('/command'))));
  expect(server.requests.find((r) => r.path.endsWith('/compact'))?.body).toEqual({});
  stream.push(frame('session.compaction.ended', { reason: 'manual' }, 'other-session'));
  stream.push(started()); stream.push(frame('session.compaction.ended', { reason: 'manual' })); stream.push(succeeded());
  await turn;
  expect(events.filter((e) => e.type === 'compaction')).toEqual([{ type: 'compaction', trigger: 'manual' }]);
  const next = adapter.send('continue', (e) => events.push(e));
  const nextStream = await server.stream(1);
  nextStream.push(started()); nextStream.push(frame('session.compaction.ended', { reason: 'auto' })); nextStream.push(succeeded());
  await next;
  expect(events.filter((e) => e.type === 'compaction')).toEqual([{ type: 'compaction', trigger: 'manual' }, { type: 'compaction', trigger: 'auto' }]);
  // OpenCode reports no size after one, so the meter knows none until the next call.
  expect(events.filter((e) => e.type === 'usage' && e.record.compacted)).toEqual([
    { type: 'usage', record: { source: 'opencode', compacted: true } },
    { type: 'usage', record: { source: 'opencode', compacted: true } },
  ]);
  adapter.dispose();
});


it('waits for OpenCode 2.x native plugin activation before discovering commands', async () => {
  let ready = false;
  const server = fakeServer({
    'GET /api/model': () => { ready = true; return { data: [] }; },
    'GET /api/command': () => ({ data: ready ? [{ name: 'hello', description: 'Say hello' }] : [] }),
  });
  const { adapter: native } = await start(server);
  const adapter: TaskModeAgentAdapter = native;
  expect(adapter.commands?.().map((c) => c.name)).toEqual(['compact', 'hello']);
  adapter.dispose();
});


it('reports OpenCode 2.x manual compaction failure even when execution ends normally', async () => {
  const server = fakeServer({ 'GET /api/command': () => ({ data: [] }) });
  const { adapter: native } = await start(server);
  const adapter: TaskModeAgentAdapter = native;
  const events: AgentEvent[] = [];
  const turn = adapter.invokeCommand!('compact', '', (e) => events.push(e));
  const stream = await server.stream();
  await until(() => server.requests.some((r) => r.path.endsWith('/compact')));
  stream.push(started()); stream.push(frame('session.compaction.failed', { reason: 'manual', error: { type: 'compaction.unavailable', message: 'Nothing to compact yet' } })); stream.push(succeeded());
  await turn;
  expect(events.filter((e) => e.type === 'error' || e.type === 'turn_end' || e.type === 'compaction')).toEqual([{ type: 'error', message: 'Nothing to compact yet' }]);
  adapter.dispose();
});
