import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { CodexAdapter } from '../harness/CodexAdapter';
import { OpenCodeAdapter } from '../harness/OpenCodeAdapter';
import { AcpAdapter } from '../harness/AcpAdapter';
import { OrdewellAdapter } from '../harness/ordewell/OrdewellAdapter';
import { SUMMARY_HEADINGS } from '../harness/ordewell/compaction';
import { MemoryTranscriptStore, call, scriptedClient, STOP } from '../harness/ordewell/__tests__/loopKit';
import type { AcpProfile } from '../harness/acpProfiles';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, PlannerStartOptions, SpawnFn, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
import { CODEX_MANIFEST } from '../../plugins/builtin/codex.manifest';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import type { CompactionPoint } from '../../models/Usage';
import { mcpClientConfig } from '../mcp/clientConfig';
import type { ModelClient } from '../model';
import { codexAnswer, fakeSpawn, fixture, sseResponse, type FakeEventStream } from './harnessTestKit';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';
import { expectCompactionChain, type Flagged } from './compactionChainKit';

/**
 * One decision, one setting, every harness (ADR-0018 C4): what Ordewell passes
 * to a harness when it launches a task under `taskCompactAt`, and what a
 * compaction on that harness sets going afterwards. Each kind is driven through
 * what its adapter already exposes, so this file pins the table in
 * docs/planners-and-runners.md and none of an adapter's own details; those are
 * in the adapter's test file.
 */

/** A number every harness honours as it stands: Claude Code's window is 32,000 above it, a 200,000-token OpenCode model keeps the rest, the built-in runner's assumed 128,000 guards from 108,800. */
const N = 100_000;
/**
 * A start whose window (the start plus the 32,000 every harness is read as
 * keeping above it) is past running long's routine bound of 200,000: the same
 * number must make the same compaction news on every harness.
 */
const LARGE = 170_000;
const SETTINGS = { auto: 'auto', number: String(N), large: String(LARGE), off: 'off' } as const;
type Setting = keyof typeof SETTINGS;

/** What one task launch shows of the setting, and what Ordewell kept of it for the runner's session. */
interface Launch {
  /** The harness's own knob, as the harness is given it: undefined where Ordewell sets nothing. */
  passed: unknown;
  window: number | undefined;
  start: number | undefined;
  /** What the user is told about the setting at launch: a warning, or a line in the task's log. */
  said: string[];
}

interface Kind {
  name: string;
  launch(at: string): Promise<Launch & { adapter: TaskModeAgentAdapter }>;
  /** A launch as a planner: whatever it shows must not move with the setting. None where the runner has no planner. */
  planner?(at: string): Promise<unknown>;
  /** One automatic compaction of the task's context, as the harness reports it. */
  compaction(at: string): Promise<{ events: AgentEvent[]; adapter: TaskModeAgentAdapter }>;
  expected: Record<Setting, Omit<Launch, 'said'> & { said?: RegExp[]; meter?: CompactionPoint; flagged: Flagged }>;
}

/** The compaction running long first flags, and the compaction window it names: the start plus 32,000, whatever the harness. */
const NEWS: Flagged = { at: 1 };
const routine = (start: number): Flagged => ({ at: 3, window: start + 32_000 });
const news = (start: number): Flagged => ({ at: 1, window: start + 32_000 });

const processDeps = (spawn: SpawnFn, extra: Partial<AgentProcessDeps> = {}): AgentProcessDeps => ({
  spawn,
  fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
  resolvePath: async () => '/usr/bin',
  platform: 'linux',
  isDirectory: () => true,
  exists: () => true,
  workspaceEnv: async () => ({}),
  ...extra,
});

const task = (overrides: Partial<TaskStartOptions> = {}): TaskStartOptions => ({
  kind: 'task', cwd: '/repo', mode: 'agent', flags: { permissionMode: 'acceptEdits', modeSettings: {} }, ...overrides,
});
const planner: PlannerStartOptions = { kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' };

const nextTurn = async (adapter: TaskModeAgentAdapter, text = 'go on'): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  await adapter.send(text, (e) => events.push(e));
  return events;
};

/** Claude Code reports the compaction as a `compact_boundary` system line, then ends the turn. */
const claudeTurn = [
  { type: 'system', subtype: 'compact_boundary', session_id: 's', compact_metadata: { trigger: 'auto', pre_tokens: 160_000, post_tokens: 9_000 } },
  { type: 'result', session_id: 's', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.01 },
].map((line) => JSON.stringify(line)).join('\n') + '\n';

function claude(model: string): Kind['launch'] {
  return async () => {
    const spawned = fakeSpawn([claudeTurn]);
    const adapter: TaskModeAgentAdapter = new ClaudeCodeAdapter(processDeps(spawned.spawn));
    await adapter.start(task({ model, mode: 'acceptEdits' }));
    return { adapter, passed: spawned.lastEnv().CLAUDE_CODE_AUTO_COMPACT_WINDOW, window: adapter.compactWindowTokens, start: adapter.compactStartTokens, said: [] };
  };
}

const claudeKind = (model: string): Pick<Kind, 'launch' | 'planner' | 'compaction'> => ({
  launch: claude(model),
  planner: async () => {
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter(processDeps(spawned.spawn));
    await adapter.start(planner);
    adapter.dispose();
    return { args: spawned.lastArgs().map((arg) => arg.replace(/ordewell-claude-[^/\\]+/, 'ordewell-claude-X')), env: spawned.lastEnv().CLAUDE_CODE_AUTO_COMPACT_WINDOW, window: adapter.compactWindowTokens };
  },
  compaction: async () => {
    const { adapter } = await claude(model)('');
    return { adapter, events: await nextTurn(adapter) };
  },
});

const line = (msg: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`;
const codexTask = (): TaskStartOptions => task({ model: 'gpt-5.5', flags: resolveTaskRunnerFlags(CODEX_MANIFEST, { mode: 'agent', model: 'gpt-5.5', thinkingEffort: 'high' }) });
const threadStart = (written: string[]): Record<string, unknown> | undefined => {
  const sent = written.flatMap((chunk) => chunk.split('\n')).filter(Boolean).map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> });
  return sent.find((m) => m.method === 'thread/start')?.params;
};

const codexKind: Kind = {
  name: 'Codex',
  async launch() {
    const spawned = fakeSpawn([fixture('codex', 'handshake'), codexAnswer('task-thread')]);
    const adapter = new CodexAdapter(processDeps(spawned.spawn));
    await adapter.start(codexTask());
    const params = threadStart(spawned.processes[0].written);
    return { adapter, passed: params?.config, window: adapter.compactWindowTokens, start: adapter.compactStartTokens, said: [] };
  },
  async planner() {
    const spawned = fakeSpawn([fixture('codex', 'handshake'), fixture('codex', 'new-conversation')]);
    const adapter = new CodexAdapter(processDeps(spawned.spawn));
    await adapter.start(planner as AgentStartOptions);
    adapter.dispose();
    return { thread: threadStart(spawned.processes[0].written), window: adapter.compactWindowTokens };
  },
  async compaction() {
    const spawned = fakeSpawn([fixture('codex', 'handshake'), codexAnswer('task-thread')]);
    const adapter = new CodexAdapter(processDeps(spawned.spawn));
    await adapter.start(codexTask());
    const events: AgentEvent[] = [];
    const turn = adapter.send('go on', (e) => events.push(e));
    spawned.processes[0].emitStdout(
      line({ method: 'turn/started', params: { threadId: 'thr-task-1', turn: { id: 't', status: 'inProgress', items: [] } } })
      + line({ method: 'item/completed', params: { threadId: 'thr-task-1', item: { id: 'c', type: 'contextCompaction' } } })
      + line({ method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id: 't', status: 'completed', items: [] } } }),
    );
    await turn;
    return { adapter, events };
  },
  expected: {
    auto: { passed: undefined, window: undefined, start: undefined, flagged: NEWS },
    number: { passed: { model_auto_compact_token_limit: N, model_auto_compact_token_limit_scope: 'total' }, window: N, start: N, meter: { windowTokens: N, startsAtTokens: N }, flagged: routine(N) },
    large: { passed: { model_auto_compact_token_limit: LARGE, model_auto_compact_token_limit_scope: 'total' }, window: LARGE, start: LARGE, meter: { windowTokens: LARGE, startsAtTokens: LARGE }, flagged: news(LARGE) },
    off: { passed: undefined, window: undefined, start: undefined, flagged: NEWS },
  },
};

const OPENCODE_BASE = 'http://127.0.0.1:4096';
/**
 * A scripted `opencode serve` answering what a task's start and one turn ask
 * of it, and nothing else: 1.x's routes, or 2.x's under `/api`, which 1.x
 * does not answer with a version.
 */
function openCodeServer(major: 1 | 2) {
  const streams: FakeEventStream[] = [];
  const reply = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;
  const empty = { ok: true, status: 204, statusText: '204', json: async () => { throw new SyntaxError('no body'); } } as unknown as Response;
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const route = `${init?.method ?? 'GET'} ${String(input).replace(OPENCODE_BASE, '')}`;
    if (route.endsWith(' /event') || route.endsWith(' /api/event')) {
      const { response, stream } = sseResponse(init);
      streams.push(stream);
      return response;
    }
    if (major === 2) {
      if (route === 'GET /api/info') return reply({ version: '2.0.22' });
      if (route === 'POST /api/session') return reply({ data: { id: 'ses_task' } });
      if (route === 'GET /api/session/active') return reply({ data: {} });
      if (route === 'GET /api/command') return reply({ data: [] });
      if (route.endsWith('/message') && route.startsWith('GET')) return reply({ data: [] });
      if (route.endsWith('/prompt')) return reply({ data: { id: 'msg_user', type: 'user' } });
      if (route.startsWith('PUT')) return empty;
      return reply({});
    }
    if (route === 'GET /session/status') return reply({});
    if (route === 'POST /session') return reply({ id: 'ses_task' });
    if (route.endsWith('/prompt_async')) return empty;
    if (route.endsWith('/message') && route.startsWith('GET')) return reply([]);
    return reply(true);
  };
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    async stream(): Promise<FakeEventStream> {
      for (let i = 0; i < 200 && streams.length === 0; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return streams[0];
    },
  };
}

async function openCodeStart(major: 1 | 2, opts: AgentStartOptions) {
  const server = openCodeServer(major);
  const spawned = fakeSpawn([]);
  const envs: NodeJS.ProcessEnv[] = [];
  const spawn: SpawnFn = (cmd, argv, options) => { envs.push(options.env); return spawned.spawn(cmd, argv, options); };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const adapter = new OpenCodeAdapter(processDeps(spawn, { fetch: server.fetch }));
  const started = adapter.start(opts);
  for (let i = 0; i < 50 && spawned.processes.length === 0; i += 1) await Promise.resolve();
  spawned.processes[0].emitStdout(`opencode server listening on ${OPENCODE_BASE}\n`);
  await started;
  const said = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('taskCompactAt'));
  warn.mockRestore();
  return { adapter, server, env: envs[0], said };
}

// claude-sonnet-4-5 has a 200,000-token window in the bundled models.dev snapshot, and no input limit.
const OPENCODE_MODEL = 'anthropic/claude-sonnet-4-5';
const openCodeTask = (): TaskStartOptions => task({ model: OPENCODE_MODEL, mode: 'build', flags: { permissionMode: 'build', modeSettings: { approvals: 'auto' } } });

function openCodeKind(major: 1 | 2): Omit<Kind, 'expected'> {
  return {
    name: `OpenCode ${major}.x`,
    async launch() {
      const { adapter, env, said } = await openCodeStart(major, openCodeTask());
      const config = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { compaction?: unknown } : undefined;
      return { adapter, passed: config?.compaction, window: adapter.compactWindowTokens, start: adapter.compactStartTokens, said };
    },
    async planner() {
      const { adapter, env } = await openCodeStart(major, { ...planner, model: OPENCODE_MODEL } as AgentStartOptions);
      adapter.dispose();
      return { config: env.OPENCODE_CONFIG_CONTENT, window: adapter.compactWindowTokens };
    },
    async compaction() {
      const { adapter, server } = await openCodeStart(major, openCodeTask());
      const events: AgentEvent[] = [];
      const turn = adapter.send('do the task', (e) => events.push(e));
      const stream = await server.stream();
      if (major === 2) {
        const frame = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: 'ses_task', ...data } });
        stream.push(frame('session.execution.started'));
        stream.push(frame('session.compaction.ended', { reason: 'auto' }));
        stream.push(frame('session.execution.succeeded'));
      } else {
        stream.push({ type: 'session.status', properties: { sessionID: 'ses_task', status: { type: 'busy' } } });
        stream.push({ type: 'session.compacted', properties: { sessionID: 'ses_task' } });
        stream.push({ type: 'session.status', properties: { sessionID: 'ses_task', status: { type: 'idle' } } });
      }
      await turn;
      return { adapter, events };
    },
  };
}

const openCode1Kind: Kind = {
  ...openCodeKind(1),
  expected: {
    auto: { passed: undefined, window: undefined, start: undefined, flagged: NEWS },
    // 1.x keeps its own start for a model with no input limit, whatever `reserved` says, and the server says it is 1.x only once it runs: the room is written, then dropped from what Ordewell reads, with a line.
    number: { passed: { reserved: 200_000 - N }, window: undefined, start: undefined, said: [/OpenCode 1\.x.*taskCompactAt 100000 is not applied/], flagged: NEWS },
    large: { passed: { reserved: 200_000 - LARGE }, window: undefined, start: undefined, said: [/OpenCode 1\.x.*taskCompactAt 170000 is not applied/], flagged: NEWS },
    off: { passed: undefined, window: undefined, start: undefined, flagged: NEWS },
  },
};

const openCode2Kind: Kind = {
  ...openCodeKind(2),
  expected: {
    auto: { passed: undefined, window: undefined, start: undefined, flagged: NEWS },
    // The rest of the 200,000-token window is what OpenCode keeps back, so compaction starts at the number.
    number: { passed: { reserved: 200_000 - N }, window: N, start: N, meter: { windowTokens: N, startsAtTokens: N }, flagged: routine(N) },
    large: { passed: { reserved: 200_000 - LARGE }, window: LARGE, start: LARGE, meter: { windowTokens: LARGE, startsAtTokens: LARGE }, flagged: news(LARGE) },
    off: { passed: undefined, window: undefined, start: undefined, flagged: NEWS },
  },
};

const ACP_MANIFEST = {
  name: 'fake-acp',
  displayName: 'Fake Agent',
  runner: { command: 'fake-agent' },
  features: { modeSettings: { approvals: { auto: 'auto' } } },
  modelDiscovery: { method: 'hardcoded', models: [] },
  modes: [{ id: 'ask', label: 'Ask', description: 'Asks before it acts.', safe: true }],
  auth: { statusArgs: ['status'], loginArgs: ['login'] },
} as RunnerManifest;
const ACP_PROFILE: AcpProfile = { manifest: ACP_MANIFEST, args: ['--acp'], ordewellTool: () => null, instructions: { kind: 'prompt' }, roles: { plans: true, readOnly: false }, restricted: { args: ['--deny-tool=write'], env: {} } };
const acpHandshake: FakeAcpStep[] = [
  { expect: 'initialize', reply: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, agentInfo: { name: 'fake-agent', version: '1.4.0' }, authMethods: [] } },
  { expect: 'session/new', reply: { sessionId: 'sess-1' } },
];
const acpUsage = (used: number): FakeAcpStep => ({ notify: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'usage_update', used, size: 200_000 } } });
const acpPrompt = (...within: FakeAcpStep[]): FakeAcpStep[] => [{ expect: 'session/prompt' }, ...within, { answer: { stopReason: 'end_turn' }, to: 'session/prompt' }];
const MCP = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-pinning' });
const acpTask = (): TaskStartOptions => task({ mode: 'ask', mcp: MCP, flags: resolveTaskRunnerFlags(ACP_MANIFEST, { mode: 'ask' }) });

async function acpStart(steps: FakeAcpStep[], opts: AgentStartOptions) {
  const spawned = fakeAcpSpawn(steps);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const adapter: TaskModeAgentAdapter = new AcpAdapter(processDeps(spawned.spawn), ACP_PROFILE);
  await adapter.start(opts);
  const said = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('taskCompactAt'));
  warn.mockRestore();
  return { adapter, spawned, said };
}

const acpKind: Kind = {
  name: 'ACP runners',
  async launch() {
    const { adapter, spawned, said } = await acpStart(acpHandshake, acpTask());
    // Nothing of the setting reaches the agent: its command line and environment are the same under all three.
    return { adapter, passed: { args: spawned.lastArgs() }, window: adapter.compactWindowTokens, start: adapter.compactStartTokens, said };
  },
  async planner() {
    const { adapter, spawned, said } = await acpStart(acpHandshake, { ...planner, mcp: MCP });
    adapter.dispose();
    return { args: spawned.lastArgs(), said, window: adapter.compactWindowTokens };
  },
  async compaction() {
    const { adapter } = await acpStart([...acpHandshake, ...acpPrompt(acpUsage(150_000)), ...acpPrompt(acpUsage(160_000), acpUsage(31_000))], acpTask());
    await nextTurn(adapter, 'go');
    return { adapter, events: await nextTurn(adapter) };
  },
  expected: {
    auto: { passed: { args: ['--acp'] }, window: undefined, start: undefined, flagged: NEWS },
    number: { passed: { args: ['--acp'] }, window: undefined, start: undefined, said: [/Fake Agent: taskCompactAt 100000 cannot be honoured/], flagged: NEWS },
    large: { passed: { args: ['--acp'] }, window: undefined, start: undefined, said: [/Fake Agent: taskCompactAt 170000 cannot be honoured/], flagged: NEWS },
    off: { passed: { args: ['--acp'] }, window: undefined, start: undefined, flagged: NEWS },
  },
};

const BUILT_IN_KEY = 'sk-or-v1-pinning-test-key-0123456789';
const FULL_SUMMARY = SUMMARY_HEADINGS.map((heading) => `${'#'.repeat(heading.level)} ${heading.name}\nbody of ${heading.name}`).join('\n\n');
const builtInDirs: string[] = [];

/** The built-in runner on a model nothing describes: it assumes a 128,000-token window and guards from 108,800. */
function builtIn(steps: Parameters<typeof scriptedClient>[0] = []) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ordewell-pinning-')));
  builtInDirs.push(dir);
  // Results big enough that the newest step alone does not fit what a compaction keeps word for word, so there is a middle to summarize.
  writeFileSync(path.join(dir, 'a.txt'), `${'a line of about sixty characters, repeated for the size of it\n'.repeat(900)}`);
  const client = scriptedClient(steps);
  const adapter = new OrdewellAdapter('openrouter', {
    ...processDeps(() => { throw new Error('The in-process runner spawned a process.'); }),
    workspaceEnv: async () => ({ OPENROUTER_API_KEY: BUILT_IN_KEY }),
  }, {
    modelInfoTimeoutMs: 50,
    openStore: () => new MemoryTranscriptStore('the-session', dir),
    createClient: (): ModelClient => client,
  });
  const start = task({ cwd: dir, model: 'openrouter:acme/unknown', mode: 'full', flags: { permissionMode: 'full', modeSettings: {} } });
  return { adapter, start };
}

const builtInKind: Kind = {
  name: 'the built-in runner',
  async launch() {
    const { adapter, start } = builtIn([[{ type: 'text-delta', text: 'One.' }, STOP]]);
    await adapter.start(start);
    const events = await nextTurn(adapter, 'Go.');
    const said = events.flatMap((e) => (e.type === 'command_output' && e.text.includes('taskCompactAt') ? [e.text] : []));
    // No harness takes a setting here: Ordewell's own loop reads it, so what it passes is the start it keeps.
    return { adapter, passed: undefined, window: adapter.compactWindowTokens, start: adapter.compactStartTokens, said };
  },
  async compaction() {
    // The third step's measured prompt is past the start under every setting, so the fourth request compacts the middle first.
    const { adapter, start } = builtIn([
      [call('c1', 'read', { path: 'a.txt' }), { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 10 } }, STOP],
      [call('c2', 'read', { path: 'a.txt' }), { type: 'usage', usage: { inputTokens: 30_000, outputTokens: 10 } }, STOP],
      [call('c3', 'read', { path: 'a.txt' }), { type: 'usage', usage: { inputTokens: 110_000, outputTokens: 10 } }, STOP],
      [{ type: 'text-delta', text: FULL_SUMMARY }, { type: 'usage', usage: { inputTokens: 2_000, outputTokens: 300 } }, STOP],
      [{ type: 'text-delta', text: 'All done.' }, { type: 'usage', usage: { inputTokens: 20_000, outputTokens: 10 } }, STOP],
    ]);
    await adapter.start(start);
    return { adapter, events: await nextTurn(adapter, 'Go.') };
  },
  expected: {
    auto: { passed: undefined, window: undefined, start: undefined, flagged: NEWS },
    number: { passed: undefined, window: N, start: N, meter: { windowTokens: N, startsAtTokens: N }, flagged: routine(N) },
    // Past what its guard allows: held to the guard, with a line, so the start in force is routine.
    large: { passed: undefined, window: 108_800, start: 108_800, meter: { windowTokens: 108_800, startsAtTokens: 108_800 }, said: [/taskCompactAt 170000 .*using 108800/], flagged: routine(108_800) },
    // `off` is not honoured here: the runner compacts as auto does, and says so once.
    off: { passed: undefined, window: undefined, start: undefined, said: [/taskCompactAt off is not honoured.*from 108800 tokens/], flagged: NEWS },
  },
};

const claudeExpected = (model: 'opus' | 'haiku'): Kind['expected'] => ({
  // Haiku's `auto` window is where it starts compacting, 93,000, plus the CLI's 32,000-token buffer.
  auto: model === 'haiku'
    ? { passed: '125000', window: 125_000, start: undefined, meter: { windowTokens: 125_000, startsAtTokens: 93_000 }, flagged: routine(93_000) }
    : { passed: undefined, window: undefined, start: undefined, flagged: NEWS },
  // A number is where compaction starts: the window handed the CLI is that plus its buffer.
  number: { passed: String(N + 32_000), window: N + 32_000, start: undefined, meter: { windowTokens: N + 32_000, startsAtTokens: N }, flagged: routine(N) },
  large: { passed: String(LARGE + 32_000), window: LARGE + 32_000, start: undefined, meter: { windowTokens: LARGE + 32_000, startsAtTokens: LARGE }, flagged: news(LARGE) },
  off: { passed: undefined, window: undefined, start: undefined, flagged: NEWS },
});

const KINDS: Kind[] = [
  { name: 'Claude Code (Opus)', ...claudeKind('opus'), expected: claudeExpected('opus') },
  { name: 'Claude Code (Haiku)', ...claudeKind('haiku'), expected: claudeExpected('haiku') },
  codexKind,
  openCode1Kind,
  openCode2Kind,
  acpKind,
  builtInKind,
];

beforeEach(() => {
  // What the user's own shell set is not what Ordewell passes.
  vi.stubEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined);
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each(KINDS)('$name', (kind) => {
  describe.each(Object.keys(SETTINGS) as Setting[])('under taskCompactAt %s', (setting) => {
    const want = kind.expected[setting];

    it('passes the harness what the table says at a task\'s launch', async () => {
      vi.stubEnv('ORDEWELL_TASK_COMPACT_AT', SETTINGS[setting]);
      const launched = await kind.launch(SETTINGS[setting]);
      launched.adapter.dispose();
      expect({ passed: launched.passed, window: launched.window, start: launched.start }).toEqual({ passed: want.passed, window: want.window, start: want.start });
      expect(launched.said.length).toBe(want.said?.length ?? 0);
      want.said?.forEach((pattern, i) => expect(launched.said[i]).toMatch(pattern));
    });

    it('passes the same when the host\'s own environment carries a compaction setting, as a nested Ordewell inherits its parent\'s', async () => {
      vi.stubEnv('ORDEWELL_TASK_COMPACT_AT', SETTINGS[setting]);
      vi.stubEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW', '150000');
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ compaction: { reserved: 25_000 } }));
      const launched = await kind.launch(SETTINGS[setting]);
      launched.adapter.dispose();
      expect({ passed: launched.passed, window: launched.window, start: launched.start }).toEqual({ passed: want.passed, window: want.window, start: want.start });
    });

    it('turns an automatic compaction into the brief\'s reminder, a running-long count and a reset meter, read against the start in force', async () => {
      vi.stubEnv('ORDEWELL_TASK_COMPACT_AT', SETTINGS[setting]);
      const { adapter, events } = await kind.compaction(SETTINGS[setting]);
      adapter.dispose();

      // The meter falls: the first reading of the task's own context after the compaction is the reset one, or a smaller one (the summary call is billed apart).
      const after = events.slice(events.findIndex((e) => e.type === 'compaction')).flatMap((e) => (e.type === 'usage' && e.record.purpose !== 'compaction' ? [e.record] : []));
      const pre = events.flatMap((e) => (e.type === 'compaction' && e.preTokens ? [e.preTokens] : []))[0] ?? 160_000;
      expect(after[0]?.compacted === true || (after[0]?.contextTokens ?? Infinity) < pre).toBe(true);

      const meter = await expectCompactionChain(events, adapter.compactWindowTokens, adapter.compactStartTokens, want.flagged);
      expect(meter).toEqual(want.meter);
    });
  });

  if (kind.planner) {
    it('launches a planner as it does with the setting at auto, whatever the setting says', async () => {
      vi.stubEnv('ORDEWELL_TASK_COMPACT_AT', 'auto');
      const unset = await kind.planner!('auto');
      for (const at of [SETTINGS.number, SETTINGS.large, SETTINGS.off]) {
        vi.stubEnv('ORDEWELL_TASK_COMPACT_AT', at);
        expect(await kind.planner!(at)).toEqual(unset);
      }
    });
  }
});

describe('a runner with no planner', () => {
  it('gives the setting nothing to act on for a planner: the built-in runner has none', async () => {
    const { CONNECTORS } = await import('../harness/connectors');
    expect(CONNECTORS.openrouter?.plans).toBe(false);
  });
});
