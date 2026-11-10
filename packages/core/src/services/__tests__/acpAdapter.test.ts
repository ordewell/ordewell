import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { basename, dirname, join, sep } from 'path';
import { AcpAdapter } from '../harness/AcpAdapter';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { acpConnector, type AcpProfile } from '../harness/acpProfiles';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import type { AgentEvent, AgentProcessDeps, PlannerStartOptions, TaskStartOptions } from '../harness/AgentAdapter';
import { ACP_ERROR, type AcpToolCall } from '../harness/acpSchema';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { StructuredEvent } from '../../interfaces/IRunner';
import { StructuredRunner } from '../StructuredRunner';
import { OrdewellMcpServer, mcpClientConfig, type McpClientConfig } from '../mcp';
import type { TaskCompleteArgs } from '../mcp';
import { McpAttachTimeout, RunnerStartupExit, spawnAttached } from '../harness/ordewellBinding';
import { fakeAcpSpawn, type FakeAcpAgentOptions, type FakeAcpStep } from './fakeAcpAgent';
import { planJson, type FakeSpawnOptions } from './harnessTestKit';
import { fakeConfig } from '../../testing';
import { CURSOR_EXTENSION_REQUESTS } from '../harness/cursorRequests';
import { runnerEnv } from '../harness/runnerEnv';
import { clineCredentials } from '../harness/clineCredentials';
import { qwenCredentials } from '../harness/qwenCredentials';
import { stubNoOrdewellProvider } from './ordewellProviderEnv';
import { COPILOT_CLI_PROFILE } from '../harness/copilotProfile';
import { COPILOT_CLI_MANIFEST } from '../../plugins/builtin/copilot-cli.manifest';

/**
 * The ACP connector's task core (#73, slice S3/S4) against the scripted ACP
 * agent. The wire shapes are ACP v1's, as `acpSchema.ts` vendors them; the
 * words a person reads are the design's (#5, section 4).
 */

/**
 * Windows has no POSIX modes (every file stats 0o666), so there a private
 * file's privacy is the per-user temp directory it is made in, as
 * `privateFile.ts` has it, and only the mode check is POSIX-only.
 */
const POSIX_MODES = process.platform !== 'win32';

const MANIFEST: RunnerManifest = {
  name: 'fake-acp',
  displayName: 'Fake Agent',
  runner: { command: 'fake-agent' },
  features: { modeSettings: { approvals: { auto: 'auto' } } },
  modelDiscovery: { method: 'hardcoded', models: [] },
  modes: [
    { id: 'ask', label: 'Ask', description: 'Asks before it acts.', safe: true },
    { id: 'auto', label: 'Auto', description: 'Acts without asking.', autonomous: true },
  ],
  auth: { statusArgs: ['status'], loginArgs: ['login'] },
} as RunnerManifest;

/**
 * Names an Ordewell call by a title the test agent gives it, in its report or
 * else its request; a real profile records its agent's own.
 */
const PROFILE: AcpProfile = {
  manifest: MANIFEST,
  args: ['--acp'],
  ordewellTool: ({ request, report }) => {
    const title = (report ?? request).title;
    return title?.startsWith('ordewell/') ? title.slice('ordewell/'.length) : null;
  },
  instructions: { kind: 'prompt' },
};

const TOKEN = 'tok-secret-123';
const MCP: McpClientConfig = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: TOKEN });

const INITIALIZED = {
  protocolVersion: 1,
  agentCapabilities: { mcpCapabilities: { http: true } },
  agentInfo: { name: 'fake-agent', version: '1.4.0' },
  authMethods: [{ id: 'github', name: 'GitHub' }],
};

const handshake = (reply: Record<string, unknown> = INITIALIZED): FakeAcpStep[] => [
  { expect: 'initialize', reply },
  { expect: 'session/new', reply: { sessionId: 'sess-1' } },
];

function setup(steps: FakeAcpStep[], profile: AcpProfile = PROFILE, options: FakeSpawnOptions = {}, extra: Partial<AgentProcessDeps> = {}, agentOptions: FakeAcpAgentOptions = {}) {
  const spawned = fakeAcpSpawn(steps, options, agentOptions);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
    ...extra,
  };
  const adapter = new AcpAdapter(deps, profile);
  adapters.push(adapter);
  return { spawned, agent: spawned.agent, adapter };
}

function taskStart(mode = 'ask', overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return {
    kind: 'task',
    cwd: '/repo',
    mode,
    flags: resolveTaskRunnerFlags(MANIFEST, { mode }),
    mcp: MCP,
    ...overrides,
  };
}

/** An agent that claims both roles, with controls a real profile would have verified live. */
const ROLES_MANIFEST: RunnerManifest = {
  ...MANIFEST,
  modes: [...(MANIFEST.modes ?? []), { id: 'look', label: 'Read-only', description: 'Reads only.', readOnly: true }],
} as RunnerManifest;
const ROLES_PROFILE: AcpProfile = {
  ...PROFILE,
  manifest: ROLES_MANIFEST,
  mode: { kind: 'args', args: (flags) => (flags.modeSettings.approvals === 'auto' ? ['--allow-all-tools'] : []) },
  roles: { plans: true, readOnly: true },
  restricted: { args: ['--deny-tool=write', '--deny-tool=shell'], env: { FAKE_ALLOW_ALL: 'false' } },
};

function plannerStart(overrides: Partial<PlannerStartOptions> = {}): PlannerStartOptions {
  return { kind: 'planner', cwd: '/repo', systemPrompt: 'You are the planner.', mcp: MCP, ...overrides };
}

function readOnlyStart(overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return taskStart('look', { flags: resolveTaskRunnerFlags(ROLES_MANIFEST, { mode: 'look' }), ...overrides });
}

const update = (sessionUpdate: string, fields: Record<string, unknown>) => ({ sessionId: 'sess-1', update: { sessionUpdate, ...fields } });
const text = (value: string) => ({ type: 'text', text: value });

function permissionParams(title: string, toolCallId = 'call-1') {
  return {
    sessionId: 'sess-1',
    toolCall: { toolCallId, title, kind: 'edit', rawInput: { path: 'src/a.ts' } },
    // Ids an agent picks for itself; only the kinds say what each option does.
    options: [
      { optionId: 'opt-a', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'opt-b', name: 'Allow', kind: 'allow_once' },
      { optionId: 'opt-c', name: 'Reject', kind: 'reject_once' },
      { optionId: 'opt-d', name: 'Never', kind: 'reject_always' },
    ],
  };
}

async function turn(adapter: AcpAdapter, message: string, signal?: AbortSignal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await adapter.send(message, (e) => events.push(e), signal);
  return events;
}

const adapters: AcpAdapter[] = [];
const servers: OrdewellMcpServer[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

describe('AcpAdapter start', () => {
  it('initializes as a client that does no I/O for the agent, then opens a session with Ordewell as an http MCP server', async () => {
    const { agent, adapter, spawned } = setup(handshake());
    await adapter.start(taskStart());

    expect(spawned.lastCommand()).toBe('fake-agent');
    expect(spawned.lastArgs()).toEqual(['--acp']);
    const [init] = agent.requests('initialize');
    expect(init.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ordewell', title: 'Ordewell', version: expect.any(String) },
    });
    const [opened] = agent.requests('session/new');
    expect(opened.params).toEqual({
      cwd: '/repo',
      mcpServers: [{ type: 'http', name: 'ordewell', url: 'http://127.0.0.1:4555/mcp', headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }] }],
    });
    expect(adapter.nativeSessionId()).toBe('sess-1');
    expect(agent.invalid).toEqual([]);
    expect(agent.unexpected).toEqual([]);
  });

  it('never puts the token on the command line or in the environment', async () => {
    const { adapter, spawned } = setup(handshake());
    await adapter.start(taskStart());

    expect(spawned.lastArgs().join(' ')).not.toContain(TOKEN);
    expect(Object.values(spawned.lastEnv()).join('\n')).not.toContain(TOKEN);
  });

  it('refuses an agent that answers another protocol version, whatever version it was asked for', async () => {
    const { adapter } = setup([{ expect: 'initialize', reply: { ...INITIALIZED, protocolVersion: 2 } }]);
    await expect(adapter.start(taskStart())).rejects.toThrow('Fake Agent speaks ACP version 2; Ordewell speaks version 1.');
  });

  it('refuses an agent older than the profile needs', async () => {
    const { adapter } = setup([{ expect: 'initialize', reply: INITIALIZED }], { ...PROFILE, minVersion: '1.10.0' });
    await expect(adapter.start(taskStart())).rejects.toThrow('Fake Agent 1.4.0 is older than Ordewell needs (1.10.0 or later).');
  });

  it('takes an agent at or past the profile\'s version', async () => {
    const { adapter } = setup(handshake(), { ...PROFILE, minVersion: '1.4' });
    await expect(adapter.start(taskStart())).resolves.toBeUndefined();
  });

  it('refuses an agent that cannot take MCP servers over HTTP, in plain words', async () => {
    const { adapter, agent } = setup([{ expect: 'initialize', reply: { ...INITIALIZED, agentCapabilities: { mcpCapabilities: { sse: true } } } }]);
    await expect(adapter.start(taskStart())).rejects.toThrow('Fake Agent cannot take Ordewell\'s tools over HTTP, so it cannot run tasks or plan here.');
    expect(agent.requests('session/new')).toEqual([]);
  });

  it('reads the agent\'s sign-in methods but never calls authenticate, and names the login command when signed out', async () => {
    const { adapter, agent } = setup([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new', error: { code: ACP_ERROR.authRequired, message: 'Authentication required' } },
    ]);
    await expect(adapter.start(taskStart())).rejects.toThrow('Fake Agent is not signed in. Sign in with /login fake-acp, or run fake-agent login.');
    expect(agent.unexpected.map((m) => m.method)).not.toContain('authenticate');
  });

  it('says only that the agent is not signed in when its manifest has no login command', async () => {
    const signless: RunnerManifest = { ...MANIFEST, auth: undefined };
    const { adapter } = setup([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new', error: { code: ACP_ERROR.authRequired, message: 'Authentication required' } },
    ], { ...PROFILE, manifest: signless });
    await expect(adapter.start(taskStart())).rejects.toThrow(/^Fake Agent is not signed in\.$/);
  });

  it('offers the profile\'s other sign-in route after the login command, or alone where there is none', async () => {
    const signedOutSteps = (): FakeAcpStep[] => [
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new', error: { code: ACP_ERROR.authRequired, message: 'Authentication required' } },
    ];
    const signInRoute = { provider: 'openrouter' as const, others: 'any OpenAI-compatible provider' };
    const both = setup(signedOutSteps(), { ...PROFILE, signInRoute });
    const alone = setup(signedOutSteps(), { ...PROFILE, signInRoute, manifest: { ...MANIFEST, auth: undefined } });

    await expect(both.adapter.start(taskStart())).rejects.toThrow(/^Fake Agent is not signed in\. Sign in with \/login fake-acp, or run fake-agent login, or run \/key and choose OpenRouter \(or any OpenAI-compatible provider\) to hand it a key\.$/);
    await expect(alone.adapter.start(taskStart())).rejects.toThrow(/^Fake Agent is not signed in\. Run \/key and choose OpenRouter \(or any OpenAI-compatible provider\) to hand it a key\.$/);
  });

  it('reports the agent\'s own refusal of session/new', async () => {
    const { adapter } = setup([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new', error: { code: ACP_ERROR.internalError, message: 'no provider configured' } },
    ]);
    await expect(adapter.start(taskStart())).rejects.toThrow('Fake Agent could not open a session: no provider configured');
  });

  it('reports an agent that exits before it answers initialize with its last words', async () => {
    const { adapter } = setup([], PROFILE, { exitOnSpawn: { code: 3, output: 'fatal: no config\n' } });
    await expect(adapter.start(taskStart())).rejects.toThrow(/Fake Agent exited before it answered[\s\S]*fatal: no config/);
  });

  it('gives up on a silent initialize after the profile\'s timeout and swallows the late reply', async () => {
    const { adapter, agent } = setup([
      { expect: 'initialize' },
      { run: () => new Promise((resolve) => setTimeout(resolve, 60)) },
      { answer: INITIALIZED, to: 'initialize' },
    ], { ...PROFILE, initTimeoutMs: 20 });
    await expect(adapter.start(taskStart())).rejects.toThrow('Fake Agent did not answer initialize within 20 ms.');
    await agent.finished;
    expect(agent.problems).toEqual([]);
  });

  it('starts no session without the Ordewell server it must carry', async () => {
    const { adapter, agent } = setup(handshake());
    await expect(adapter.start(taskStart('ask', { mcp: undefined }))).rejects.toThrow(/Ordewell MCP server/);
    expect(agent.requests('session/new')).toEqual([]);
  });

  it('starts no planner and no read-only task for a profile that claims neither role, before it spawns anything', async () => {
    const planner = setup(handshake());
    await expect(planner.adapter.start(plannerStart())).rejects.toThrow('Fake Agent cannot plan in Ordewell: its profile claims no planner role.');
    expect(planner.agent.requests('initialize')).toEqual([]);
    const readOnly = setup(handshake());
    const flags = { ...resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }), readOnly: true as const };
    await expect(readOnly.adapter.start(taskStart('ask', { flags }))).rejects.toThrow('Fake Agent cannot run a read-only task in Ordewell: its profile claims no read-only role.');
    const byToken = setup(handshake());
    await expect(byToken.adapter.start(taskStart('ask', { mcp: { ...MCP, readOnly: true } }))).rejects.toThrow(/cannot run a read-only task/);
    expect(readOnly.agent.requests('initialize')).toEqual([]);
  });
});

describe('AcpAdapter turn', () => {
  it('streams a turn with thinking, text, a tool call and usage, and ends it on the prompt response', async () => {
    const { agent, adapter } = setup([
      ...withOptions([select('model', 'model', 'm-1', ['m-1'])]),
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-1', ['m-1'])] } },
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('agent_thought_chunk', { content: text('Reading the file.') }) },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('I will ') }) },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('fix it.') }) },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 't1', title: 'Read a.ts', kind: 'read', status: 'pending', rawInput: { path: 'a.ts' } }) },
      { notify: 'session/update', params: update('tool_call_update', { toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: text('file body') }] }) },
      { answer: { stopReason: 'end_turn', usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart('ask', { model: 'm-1' }));
    const events = await turn(adapter, 'Fix the bug');

    expect(events).toEqual([
      { type: 'thinking_delta', text: 'Reading the file.' },
      { type: 'assistant_text_delta', runId: 'acp-msg-2', text: 'I will ' },
      { type: 'assistant_text_delta', runId: 'acp-msg-2', text: 'fix it.' },
      { type: 'tool_call', id: 't1', name: 'Read a.ts', args: { path: 'a.ts' } },
      { type: 'tool_result', id: 't1', name: 'Read a.ts', output: 'file body', success: true },
      { type: 'thinking', text: 'Reading the file.' },
      { type: 'assistant_text', runId: 'acp-msg-2', text: 'I will fix it.' },
      { type: 'usage', record: { source: 'fake-acp', model: 'm-1', inputTokens: 20, outputTokens: 10 } },
      { type: 'turn_end' },
    ]);
    const [prompt] = agent.requests('session/prompt');
    expect((prompt.params as { sessionId: string }).sessionId).toBe('sess-1');
  });

  it('hands the completion contract over with the first prompt of a process only', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
      { expect: 'session/prompt' },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart('ask', { commits: true }));
    await turn(adapter, 'Do the task');
    await turn(adapter, 'And then this');

    const [first, second] = agent.requests('session/prompt').map((m) => (m.params as { prompt: Array<{ text: string }> }).prompt);
    expect(first).toHaveLength(1);
    expect(first[0].text).toContain('task_complete');
    expect(first[0].text).toContain('This task\'s work lands as a commit');
    expect(first[0].text.endsWith('Do the task')).toBe(true);
    expect(second).toEqual([{ type: 'text', text: 'And then this' }]);
  });

  it('can hand the instructions over in the session\'s _meta instead, leaving the prompt alone', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ], { ...PROFILE, instructions: { kind: 'meta', key: 'fake.dev/systemPrompt' } });
    await adapter.start(taskStart());
    await turn(adapter, 'Do the task');

    const [opened] = agent.requests('session/new');
    expect((opened.params as { _meta: Record<string, string> })._meta['fake.dev/systemPrompt']).toContain('task_complete');
    const [prompt] = agent.requests('session/prompt');
    expect((prompt.params as { prompt: unknown }).prompt).toEqual([{ type: 'text', text: 'Do the task' }]);
  });

  it('can hand the instructions over as a file outside the worktree, named by a flag, and removes it with the process', async () => {
    const { adapter, spawned } = setup(handshake(), { ...PROFILE, instructions: { kind: 'file', fileName: 'AGENTS.md', pass: { flag: '--instructions' } } });
    await adapter.start(taskStart());

    const args = spawned.lastArgs();
    const at = args.indexOf('--instructions');
    expect(at).toBeGreaterThan(-1);
    const file = args[at + 1];
    expect(file.startsWith('/repo')).toBe(false);
    const { readFileSync, existsSync, statSync } = await import('fs');
    expect(readFileSync(file, 'utf8')).toContain('task_complete');
    if (POSIX_MODES) expect(statSync(file).mode & 0o077).toBe(0);
    adapter.dispose();
    expect(existsSync(file)).toBe(false);
  });

  it('can name the instructions file in an environment variable instead', async () => {
    const { adapter, spawned } = setup(handshake(), { ...PROFILE, instructions: { kind: 'file', fileName: 'system.md', pass: { env: 'FAKE_SYSTEM_MD' } } });
    await adapter.start(taskStart());

    const file = spawned.lastEnv().FAKE_SYSTEM_MD;
    expect(file).toMatch(/system\.md$/);
    expect(spawned.lastArgs()).toEqual(['--acp']);
  });

  it('can name the directory the instructions file is in, for an agent that loads instruction files from the directories it is given', async () => {
    const { adapter, spawned } = setup(handshake(), { ...PROFILE, instructions: { kind: 'file', fileName: 'AGENTS.md', pass: { envDir: 'FAKE_INSTRUCTION_DIRS' } } });
    await adapter.start(taskStart());

    const dir = spawned.lastEnv().FAKE_INSTRUCTION_DIRS ?? '';
    expect(dir.startsWith('/repo')).toBe(false);
    const { readFileSync, existsSync, readdirSync } = await import('fs');
    expect(readdirSync(dir)).toEqual(['AGENTS.md']);
    expect(readFileSync(`${dir}/AGENTS.md`, 'utf8')).toContain('task_complete');
    expect(spawned.lastArgs()).toEqual(['--acp']);
    adapter.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it('names the plan\'s model on the command line when the profile says how, and nothing without one', async () => {
    const profile: AcpProfile = { ...PROFILE, modelArgs: (model) => ['--model', model] };
    const chosen = setup(handshake(), profile);
    await chosen.adapter.start(taskStart('ask', { model: 'fast-1' }));
    expect(chosen.spawned.lastArgs()).toEqual(['--acp', '--model', 'fast-1']);

    const unchosen = setup(handshake(), profile);
    await unchosen.adapter.start(taskStart());
    expect(unchosen.spawned.lastArgs()).toEqual(['--acp']);
  });

  it('turns the agent\'s refusal of a prompt into an error, and a signed-out refusal into the login words', async () => {
    const { adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { fail: { code: ACP_ERROR.internalError, message: 'model overloaded' }, to: 'session/prompt' },
      { expect: 'session/prompt' },
      { fail: { code: ACP_ERROR.authRequired, message: 'auth required' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());

    expect(await turn(adapter, 'one')).toEqual([{ type: 'error', message: 'Fake Agent could not run the turn: model overloaded' }]);
    expect(await turn(adapter, 'two')).toEqual([{ type: 'error', message: 'Fake Agent is not signed in. Sign in with /login fake-acp, or run fake-agent login.' }]);
  });

  it('gives the details an agent puts under a refusal\'s generic message, where the vendor\'s own reason is', async () => {
    // Qwen Code answers a vendor's 404 with "Internal error", and the vendor's
    // words, which say what to change, only in the error's data.
    const details = '404 No endpoints available matching your data policy. Configure at https://openrouter.ai/settings/privacy';
    const { adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { fail: { code: ACP_ERROR.internalError, message: 'Internal error', data: { details } }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());

    expect(await turn(adapter, 'one')).toEqual([{ type: 'error', message: `Fake Agent could not run the turn: Internal error: ${details}` }]);
  });

  it('ends a turn whose prompt answer names no stop reason as an error, keeping what the agent said, never as a normal end', async () => {
    const { adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('Half done.') }) },
      { answer: {}, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');

    expect(events.map((e) => e.type)).toEqual(['assistant_text_delta', 'assistant_text', 'error']);
    expect(events[2]).toEqual({ type: 'error', message: expect.stringMatching(/^The agent ended the turn with an answer Ordewell cannot read: .*stopReason/) });
  });

  it('ends a turn with the exit\'s last words when the agent dies mid-turn', async () => {
    const { adapter, spawned } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('Working') }) },
      { run: (agent) => { spawned.processes[0].emitStderr('panic: out of memory\n'); void agent.close(137); } },
    ]);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');

    expect(events[0]).toEqual({ type: 'assistant_text_delta', runId: 'acp-msg-1', text: 'Working' });
    const last = events[events.length - 1];
    expect(last.type).toBe('error');
    expect(last.type === 'error' && last.message).toMatch(/exited with code 137[\s\S]*panic: out of memory/);
    expect(adapter.exited).toBe(true);
  });

  it('keeps state from updates outside a turn but drops their text', async () => {
    const { adapter } = setup([
      ...handshake(),
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('stray words') }) },
      { expect: 'session/prompt' },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    const outOfTurn: AgentEvent[] = [];
    adapter.onOutOfTurn((e) => outOfTurn.push(e));
    await adapter.start(taskStart());
    expect(await turn(adapter, 'go')).toEqual([{ type: 'turn_end' }]);
    expect(outOfTurn).toEqual([]);
  });

  it('answers the agent\'s file-system and terminal requests "method not found"', async () => {
    const { adapter, agent } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { request: 'fs/read_text_file', params: { sessionId: 'sess-1', path: '/etc/passwd' } },
      { request: 'terminal/create', params: { sessionId: 'sess-1', command: 'rm' } },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    await turn(adapter, 'go');

    expect(agent.answers).toEqual([
      { method: 'fs/read_text_file', error: expect.objectContaining({ code: ACP_ERROR.methodNotFound }) },
      { method: 'terminal/create', error: expect.objectContaining({ code: ACP_ERROR.methodNotFound }) },
    ]);
  });

  it('has no mid-turn steer: a message waits for the turn\'s end (ADR-0023)', () => {
    const { adapter } = setup([]);
    expect('steer' in adapter).toBe(false);
  });
});

describe('AcpAdapter extension requests', () => {
  const CURSOR_LIKE: AcpProfile = { ...ROLES_PROFILE, extensionRequests: CURSOR_EXTENSION_REQUESTS };

  /** The agent asks `method` mid-turn, and the turn still ends on its own response. */
  const asking = (...requests: FakeAcpStep[]): FakeAcpStep[] => [
    ...handshake(),
    { expect: 'session/prompt' },
    ...requests,
    { notify: 'session/update', params: update('agent_message_chunk', { content: text('Done.') }) },
    { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
  ];

  it('answers cursor/ask_question skipped, pointing the agent at the checkpoint tool, and the turn goes on', async () => {
    const { agent, adapter } = setup(asking({ request: 'cursor/ask_question', params: { toolCallId: 'q1', questions: [{ id: 'a', prompt: 'Which one?' }] } }), CURSOR_LIKE);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');

    expect(agent.answers).toEqual([{
      method: 'cursor/ask_question',
      result: { outcome: { outcome: 'skipped', reason: 'No user is present; decide and continue, or use Ordewell\'s checkpoint tool.' } },
    }]);
    expect(events.at(-2)).toEqual({ type: 'assistant_text', runId: expect.any(String), text: 'Done.' });
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
  });

  it('accepts cursor/create_plan from a writable task', async () => {
    const { agent, adapter } = setup(asking({ request: 'cursor/create_plan', params: { toolCallId: 'p1', plan: '1. Fix it.' } }), CURSOR_LIKE);
    await adapter.start(taskStart());
    expect((await turn(adapter, 'go')).at(-1)).toEqual({ type: 'turn_end' });

    expect(agent.answers).toEqual([{ method: 'cursor/create_plan', result: { outcome: { outcome: 'accepted' } } }]);
  });

  it('rejects cursor/create_plan from a planner and from a read-only task', async () => {
    for (const start of [plannerStart(), readOnlyStart()]) {
      const { agent, adapter } = setup(asking({ request: 'cursor/create_plan', params: { toolCallId: 'p1', plan: '1. Fix it.' } }), CURSOR_LIKE);
      await adapter.start(start);
      expect((await turn(adapter, 'go')).at(-1)).toEqual({ type: 'turn_end' });

      expect(agent.answers).toEqual([{ method: 'cursor/create_plan', result: { outcome: { outcome: 'rejected', reason: 'Plan mode is not available in this role.' } } }]);
    }
  });

  it('still answers a method the profile has no handler for "method not found", and leaves a notification unanswered, and the turn goes on', async () => {
    const { agent, adapter } = setup(asking(
      { request: 'cursor/unknown_thing', params: { toolCallId: 'u1' } },
      { notify: 'cursor/ask_question', params: { toolCallId: 'q1' } },
      { request: 'fs/read_text_file', params: { sessionId: 'sess-1', path: '/etc/passwd' } },
    ), CURSOR_LIKE);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');

    expect(agent.answers).toEqual([
      { method: 'cursor/unknown_thing', error: { code: -32601, message: 'Method not found: cursor/unknown_thing' } },
      { method: 'fs/read_text_file', error: { code: -32601, message: 'Method not found: fs/read_text_file' } },
    ]);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
  });

  it('answers a request whose params it cannot read "method not found", and the turn goes on', async () => {
    const { agent, adapter } = setup(asking(
      { request: 'cursor/ask_question', params: ['not', 'an', 'object'] },
      { request: 'cursor/create_plan', params: 'a plan' },
    ), CURSOR_LIKE);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');

    expect(agent.answers).toEqual([
      { method: 'cursor/ask_question', error: { code: -32601, message: 'Method not found: cursor/ask_question' } },
      { method: 'cursor/create_plan', error: { code: -32601, message: 'Method not found: cursor/create_plan' } },
    ]);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
  });

  it('answers "method not found" when a profile\'s handler throws, and the turn goes on', async () => {
    const throwing: AcpProfile = { ...PROFILE, extensionRequests: { 'x/boom': () => { throw new Error('boom'); } } };
    const { agent, adapter } = setup(asking({ request: 'x/boom', params: {} }), throwing);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');

    expect(agent.answers).toEqual([{ method: 'x/boom', error: { code: -32601, message: 'Method not found: x/boom' } }]);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
  });

  it('keeps ACP\'s own methods its own: a profile handler of the same name is never asked', async () => {
    const handler = vi.fn(() => ({ outcome: { outcome: 'selected', optionId: 'opt-a' } }));
    const shadowing: AcpProfile = { ...PROFILE, extensionRequests: { 'session/request_permission': handler } };
    const { agent, adapter } = setup(asking({ request: 'session/request_permission', params: permissionParams('Edit src/a.ts') }), shadowing);
    await adapter.start(taskStart());
    await adapter.send('go', (e) => {
      if (e.type === 'permission_request' && !e.decided) adapter.answerPermission(e.id, { decision: 'deny' });
    });

    expect(handler).not.toHaveBeenCalled();
    expect(agent.answers).toEqual([{ method: 'session/request_permission', result: { outcome: { outcome: 'selected', optionId: 'opt-c' } } }]);
  });

  it('serves none of ACP\'s client methods from a profile: fs/* and terminal/* are still "method not found"', async () => {
    const handler = vi.fn(() => ({ content: 'served by profile' }));
    const shadowing: AcpProfile = {
      ...PROFILE,
      extensionRequests: { 'fs/read_text_file': handler, 'fs/write_text_file': handler, 'terminal/create': handler, 'session/other': handler },
    };
    const { agent, adapter } = setup(asking(
      { request: 'fs/read_text_file', params: { sessionId: 'sess-1', path: '/etc/passwd' } },
      { request: 'fs/write_text_file', params: { sessionId: 'sess-1', path: 'a.txt', content: 'x' } },
      { request: 'terminal/create', params: { sessionId: 'sess-1', command: 'ls' } },
      { request: 'session/other', params: { sessionId: 'sess-1' } },
    ), shadowing);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');

    expect(handler).not.toHaveBeenCalled();
    expect(agent.answers).toEqual([
      { method: 'fs/read_text_file', error: { code: -32601, message: 'Method not found: fs/read_text_file' } },
      { method: 'fs/write_text_file', error: { code: -32601, message: 'Method not found: fs/write_text_file' } },
      { method: 'terminal/create', error: { code: -32601, message: 'Method not found: terminal/create' } },
      { method: 'session/other', error: { code: -32601, message: 'Method not found: session/other' } },
    ]);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
  });
});

describe('AcpAdapter permissions', () => {
  it('holds an agent\'s request for a person and answers allow with the allow_once option, chosen by kind', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: permissionParams('Edit src/a.ts') },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => {
      events.push(e);
      if (e.type === 'permission_request' && !e.decided) expect(adapter.answerPermission(e.id, { decision: 'allow' })).toBe(true);
    });

    expect(events[0]).toEqual({ type: 'permission_request', id: expect.any(String), name: 'Edit src/a.ts', detail: expect.any(String), input: { path: 'src/a.ts' }, toolUseId: 'call-1', suggestions: [] });
    expect(agent.answers).toEqual([{ method: 'session/request_permission', result: { outcome: { outcome: 'selected', optionId: 'opt-b' } } }]);
  });

  it('answers deny with the reject_once option, and allow-for-the-task with allow_always', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: permissionParams('Edit src/a.ts', 'c1') },
      { request: 'session/request_permission', params: permissionParams('Edit src/b.ts', 'c2') },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const decisions = [{ decision: 'deny' as const }, { decision: 'allowForTask' as const }];
    await adapter.send('go', (e) => {
      if (e.type === 'permission_request' && !e.decided) adapter.answerPermission(e.id, decisions.shift()!);
    });

    expect(agent.answers.map((a) => a.result)).toEqual([
      { outcome: { outcome: 'selected', optionId: 'opt-c' } },
      { outcome: { outcome: 'selected', optionId: 'opt-a' } },
    ]);
  });

  it('falls back to the other option of the same sense, and cancels when the agent offers none', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: { ...permissionParams('Edit'), options: [{ optionId: 'x', name: 'Always', kind: 'allow_always' }, { optionId: 'y', name: 'No', kind: 'reject_always' }] } },
      { request: 'session/request_permission', params: { ...permissionParams('Edit', 'c2'), options: [{ optionId: 'z', name: 'Yes', kind: 'allow_once' }] } },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const decisions = [{ decision: 'allow' as const }, { decision: 'deny' as const }];
    await adapter.send('go', (e) => {
      if (e.type === 'permission_request' && !e.decided) adapter.answerPermission(e.id, decisions.shift()!);
    });

    expect(agent.answers.map((a) => a.result)).toEqual([
      { outcome: { outcome: 'selected', optionId: 'x' } },
      { outcome: { outcome: 'cancelled' } },
    ]);
  });

  it('pre-allows a call to an Ordewell tool by its exact name, and holds a near miss for a person (ADR-0022 S3)', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: permissionParams('ordewell/task_complete', 'c1') },
      { request: 'session/request_permission', params: permissionParams('ordewell/task_completed', 'c2') },
      { request: 'session/request_permission', params: permissionParams('ordewell_x/task_complete', 'c3') },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => {
      events.push(e);
      if (e.type === 'permission_request' && !e.decided) adapter.answerPermission(e.id, { decision: 'deny' });
    });

    const asked = events.filter((e) => e.type === 'permission_request');
    expect(asked.map((e) => e.type === 'permission_request' && [e.name, e.decided])).toEqual([
      ['ordewell/task_complete', { decision: 'allow' }],
      ['ordewell/task_completed', undefined],
      ['ordewell_x/task_complete', undefined],
    ]);
    expect(agent.answers.map((a) => a.result)).toEqual([
      { outcome: { outcome: 'selected', optionId: 'opt-b' } },
      { outcome: { outcome: 'selected', optionId: 'opt-c' } },
      { outcome: { outcome: 'selected', optionId: 'opt-c' } },
    ]);
  });

  it('reads an Ordewell call from the agent\'s report of it when its permission request names the tool more briefly', async () => {
    const report = (toolCallId: string, title: string) => update('tool_call', { toolCallId, title, kind: 'other', status: 'pending' });
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: report('c1', 'ordewell/task_complete') },
      { request: 'session/request_permission', params: permissionParams('task_complete', 'c1') },
      { notify: 'session/update', params: report('c2', 'other/task_complete') },
      { request: 'session/request_permission', params: permissionParams('ordewell/task_complete', 'c2') },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => {
      events.push(e);
      if (e.type === 'permission_request' && !e.decided) adapter.answerPermission(e.id, { decision: 'deny' });
    });

    const asked = events.filter((e) => e.type === 'permission_request');
    expect(asked.map((e) => e.type === 'permission_request' && e.decided)).toEqual([{ decision: 'allow' }, undefined]);
    expect(agent.answers.map((a) => a.result)).toEqual([
      { outcome: { outcome: 'selected', optionId: 'opt-b' } },
      { outcome: { outcome: 'selected', optionId: 'opt-c' } },
    ]);
  });

  it('forgets a turn\'s reports with the turn, so a later request is read by its own words', async () => {
    const { adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 'c1', title: 'ordewell/task_complete', kind: 'other' }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: permissionParams('task_complete', 'c1') },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    await turn(adapter, 'first');
    const events: AgentEvent[] = [];
    await adapter.send('second', (e) => {
      events.push(e);
      if (e.type === 'permission_request' && !e.decided) adapter.answerPermission(e.id, { decision: 'deny' });
    });

    expect(events.filter((e) => e.type === 'permission_request').map((e) => e.type === 'permission_request' && e.decided)).toEqual([undefined]);
  });

  it('answers every request itself, marked decided, when the task\'s mode approves all and the agent has no switch of its own (ADR-0001)', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: permissionParams('Edit src/a.ts') },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart('auto'));
    const events = await turn(adapter, 'go');

    expect(events[0]).toMatchObject({ type: 'permission_request', name: 'Edit src/a.ts', decided: { decision: 'allow' } });
    expect(agent.answers.map((a) => a.result)).toEqual([{ outcome: { outcome: 'selected', optionId: 'opt-b' } }]);
  });

  it('maps the task\'s mode to the agent\'s own flag when the profile has one, so the agent asks nothing', async () => {
    const { adapter, spawned } = setup(handshake(), {
      ...PROFILE,
      mode: { kind: 'args', args: (flags) => (flags.modeSettings.approvals === 'auto' ? ['--allow-all-tools'] : []) },
    });
    await adapter.start(taskStart('auto'));
    expect(spawned.lastArgs()).toEqual(['--acp', '--allow-all-tools']);
  });

  it('leaves a request the agent raises past its own switch to a person, mode or no mode', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: permissionParams('Edit src/a.ts') },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ], { ...PROFILE, mode: { kind: 'args', args: () => ['--allow-all-tools'] } });
    await adapter.start(taskStart('auto'));
    const events: AgentEvent[] = [];
    const sent = adapter.send('go', (e) => events.push(e));
    await expect.poll(() => events.some((e) => e.type === 'permission_request')).toBe(true);

    const asked = events.find((e) => e.type === 'permission_request');
    expect(asked).not.toHaveProperty('decided');
    expect(adapter.answerPermission(asked?.type === 'permission_request' ? asked.id : '', { decision: 'deny' })).toBe(true);
    await sent;
    expect(agent.answers.map((a) => a.result)).toEqual([{ outcome: { outcome: 'selected', optionId: 'opt-c' } }]);
  });

  it('maps the task\'s mode to the agent\'s session mode when the profile says so, and fails the start when the agent refuses it', async () => {
    const withMode = { ...MANIFEST, modes: [{ id: 'auto', label: 'Auto', description: 'x', cliValue: 'yolo', autonomous: true }] } as RunnerManifest;
    const profile: AcpProfile = { ...PROFILE, manifest: withMode, mode: { kind: 'session-mode' } };
    const flags = resolveTaskRunnerFlags(withMode, { mode: 'auto' });

    const ok = setup([...handshake(), { expect: 'session/set_mode', reply: {} }], profile);
    await ok.adapter.start(taskStart('auto', { flags }));
    expect(ok.agent.requests('session/set_mode').map((m) => m.params)).toEqual([{ sessionId: 'sess-1', modeId: flags.permissionMode }]);

    const refused = setup([...handshake(), { expect: 'session/set_mode', error: { code: ACP_ERROR.invalidParams, message: 'unknown mode' } }], profile);
    await expect(refused.adapter.start(taskStart('auto', { flags }))).rejects.toThrow(`Fake Agent refused the mode "${flags.permissionMode}": unknown mode`);
  });

  it('cancels a request still open when the turn ends, answering the agent "cancelled"', async () => {
    const { spawned, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      // Written raw so the agent is not left waiting on its own answer: the turn ends with the request still open.
      { run: () => spawned.processes[0].emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: permissionParams('Edit src/a.ts') })}\n`) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');

    expect(events).toEqual([
      expect.objectContaining({ type: 'permission_request', id: '99' }),
      { type: 'permission_cancelled', id: '99' },
      expect.objectContaining({ type: 'turn_end' }),
    ]);
    await expect.poll(() => spawned.processes[0].written.join('')).toContain('"id":99,"result":{"outcome":{"outcome":"cancelled"}}');
  });

  it('withdraws a request the agent cancels itself, answering it "cancelled"', async () => {
    const { spawned, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { run: () => spawned.processes[0].emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: permissionParams('Edit src/a.ts') })}\n`) },
      { run: () => spawned.processes[0].emitStdout(`${JSON.stringify({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 77 } })}\n`) },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('Never mind.') }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');

    // Withdrawn where the agent withdrew it, not swept up at the turn's end.
    expect(events.map((e) => e.type)).toEqual(['permission_request', 'permission_cancelled', 'assistant_text_delta', 'assistant_text', 'turn_end']);
    expect(events.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'permission_request', id: '77' }),
      { type: 'permission_cancelled', id: '77' },
    ]);
    expect(adapter.answerPermission('77', { decision: 'allow' })).toBe(false);
    await expect.poll(() => spawned.processes[0].written.join('')).toContain('"id":77,"result":{"outcome":{"outcome":"cancelled"}}');
  });

  it('cancels a request still open when the turn is stopped, answering the agent "cancelled" before its process goes', async () => {
    const { spawned, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: permissionParams('Edit src/a.ts') },
    ]);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    const stop = new AbortController();
    const sent = adapter.send('go', (e) => events.push(e), stop.signal);
    await expect.poll(() => events.some((e) => e.type === 'permission_request')).toBe(true);
    stop.abort();
    await sent;
    const asked = events.find((e) => e.type === 'permission_request');
    const id = asked?.type === 'permission_request' ? asked.id : '';
    expect(events).toContainEqual({ type: 'permission_cancelled', id });
    expect(spawned.processes[0].written.join('')).toContain(`"id":${id},"result":{"outcome":{"outcome":"cancelled"}}`);
  });
});

describe('AcpAdapter interrupt', () => {
  it('cancels the turn and every open request, and resolves true once the agent answers the prompt', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: permissionParams('Edit src/a.ts') },
      { expect: 'session/cancel' },
      { answer: { stopReason: 'cancelled' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    let interrupted: Promise<boolean> | undefined;
    const sent = adapter.send('go', (e) => {
      events.push(e);
      if (e.type === 'permission_request') interrupted = adapter.interrupt(1000);
    });
    await sent;

    expect(await interrupted).toBe(true);
    const asked = events[0];
    expect(asked.type).toBe('permission_request');
    expect(events.slice(1)).toEqual([
      { type: 'permission_cancelled', id: asked.type === 'permission_request' ? asked.id : '' },
      { type: 'turn_end', interrupted: true },
    ]);
    expect(agent.answers).toEqual([{ method: 'session/request_permission', result: { outcome: { outcome: 'cancelled' } } }]);
    expect(agent.requests('session/cancel').map((m) => m.params)).toEqual([{ sessionId: 'sess-1' }]);
  });

  it('counts a turn the agent ends normally after the cancel as interrupted', async () => {
    const { adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { expect: 'session/cancel' },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    const sent = adapter.send('go', (e) => events.push(e));
    expect(await adapter.interrupt(1000)).toBe(true);
    await sent;
    expect(events).toEqual([{ type: 'turn_end', interrupted: true }]);
  });

  it('counts a prompt the agent refuses after the cancel as interrupted, not as an error', async () => {
    const { adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { expect: 'session/cancel' },
      { fail: { code: ACP_ERROR.internalError, message: 'request cancelled' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    const sent = adapter.send('go', (e) => events.push(e));
    expect(await adapter.interrupt(1000)).toBe(true);
    await sent;
    expect(events).toEqual([{ type: 'turn_end', interrupted: true }]);
  });

  it('resolves false when the agent does not answer the prompt in time', async () => {
    const { adapter } = setup([...handshake(), { expect: 'session/prompt' }, { expect: 'session/cancel' }]);
    await adapter.start(taskStart());
    void adapter.send('go', () => {});
    expect(await adapter.interrupt(20)).toBe(false);
  });

  it('resolves false when the agent exits instead of answering the cancel, and the exit ends the turn', async () => {
    const { adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { expect: 'session/cancel' },
      { run: (agent) => { void agent.close(137); } },
    ]);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    const sent = adapter.send('go', (e) => events.push(e));
    expect(await adapter.interrupt(5000)).toBe(false);
    await sent;
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(adapter.exited).toBe(true);
  });

  it('resolves false with no turn running', async () => {
    const { adapter } = setup(handshake());
    await adapter.start(taskStart());
    expect(await adapter.interrupt(20)).toBe(false);
  });
});

describe('AcpAdapter attach', () => {
  async function issued(server: OrdewellMcpServer, taskComplete = async () => ({ ok: true as const })) {
    return mcpClientConfig(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, { taskComplete } as never));
  }

  it('reads connected once the agent has used its token, whichever side of the session/new reply that falls', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const mcp = await issued(server);
    const { adapter } = setup([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { callMcp: { tool: 'read', args: { task: 'x' } } },
      { answer: { sessionId: 'sess-1' }, to: 'session/new' },
    ]);
    await adapter.start(taskStart('ask', { mcp }));
    expect(await adapter.mcpAttached()).toBe('connected');
  });

  it('reads pending while the agent has not used its token', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const mcp = await issued(server);
    const { adapter } = setup(handshake(), { ...PROFILE, attachTimeoutMs: 30 });
    await adapter.start(taskStart('ask', { mcp }));
    expect(await adapter.mcpAttached()).toBe('pending');
  });

  it('reads connected when the first use comes while it waits', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const mcp = await issued(server);
    const { adapter, agent } = setup(handshake());
    await adapter.start(taskStart('ask', { mcp }));
    const attached = adapter.mcpAttached();
    await agent.callMcp('read', { task: 'x' }).catch(() => undefined);
    expect(await attached).toBe('connected');
  });

  it('reads failed when the process ends before the agent used its token', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const mcp = await issued(server);
    const { adapter, agent } = setup(handshake());
    await adapter.start(taskStart('ask', { mcp }));
    const attached = adapter.mcpAttached();
    await agent.close(1);
    expect(await attached).toBe('failed');
  });

  it('reads failed without a server record to read', async () => {
    const { adapter } = setup(handshake());
    await adapter.start(taskStart());
    expect(await adapter.mcpAttached()).toBe('failed');
  });

  it('respawns once, then gives up with McpAttachTimeout when the agent never uses its token (ADR-0025)', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    let spawns = 0;
    let attempt = 0;
    await expect(spawnAttached({
      runner: 'fake-acp',
      create: () => {
        spawns++;
        return setup(handshake(), { ...PROFILE, attachTimeoutMs: 20 }).adapter;
      },
      issueToken: () => server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: ++attempt }, { taskComplete: async () => ({ ok: true }) } as never),
      revoke: (token) => server.revoke(token),
      start: (adapter, credential) => adapter.start(taskStart('ask', { mcp: mcpClientConfig(credential) })),
      failed: (first, second) => `${first}; ${second}`,
    })).rejects.toBeInstanceOf(McpAttachTimeout);
    expect(spawns).toBe(2);
  });
});

describe('AcpAdapter MCP settings file', () => {
  /** Where the agent of this test reads its MCP servers, in a shape of its own that the fake reads back. */
  const SETTINGS_ENV = 'FAKE_AGENT_MCP_SETTINGS';
  const SETTINGS_PROFILE: AcpProfile = {
    ...PROFILE,
    mcpConfig: {
      kind: 'file',
      fileName: 'mcp_settings.json',
      render: ({ name, url, headers }) => JSON.stringify({ mcpServers: { [name]: { transport: 'streamableHttp', url, headers } } }),
      pass: { env: SETTINGS_ENV },
    },
  };
  const READS_SETTINGS: FakeAcpAgentOptions = {
    settings: {
      env: SETTINGS_ENV,
      servers: (contents) => {
        const parsed = JSON.parse(contents) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
        return Object.entries(parsed.mcpServers).map(([name, s]) => ({ name, url: s.url, headers: s.headers }));
      },
    },
  };
  /** An agent that advertises no MCP transport at all, the way one that only reads its own settings does. */
  const NO_HTTP = { ...INITIALIZED, agentCapabilities: {} };

  async function issued(server: OrdewellMcpServer, attempt = 1) {
    return mcpClientConfig(await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt }, { taskComplete: async () => ({ ok: true }) } as never));
  }

  /** A temp directory of this test's own, so what is written there, and swept from it, is only this test's. */
  let temp = '';
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'acp-settings-test-'));
    for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, temp);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(temp, { recursive: true, force: true });
  });

  it('writes the settings file owner-only, outside the worktree, for the process\'s life alone', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const mcp = await issued(server);
    const { adapter, agent, spawned } = setup(handshake(NO_HTTP), SETTINGS_PROFILE, {}, {}, READS_SETTINGS);
    expect(readdirSync(temp)).toEqual([]);

    await adapter.start(taskStart('ask', { mcp }));
    const path = spawned.lastEnv()[SETTINGS_ENV] ?? '';
    expect(path.startsWith(`${temp}${sep}`)).toBe(true);
    expect(path.startsWith('/repo')).toBe(false);
    expect(agent.settingsReads).toEqual([{ path, contents: readFileSync(path, 'utf8') }]);
    if (POSIX_MODES) {
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(statSync(dirname(path)).mode & 0o077).toBe(0);
    }

    await agent.close(0);
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    expect(readdirSync(temp)).toEqual([]);
  });

  it('sweeps at the next start what an Ordewell that died left behind, and nothing else', async () => {
    // A process that has exited, so its id is one no running Ordewell holds.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const leftover = join(temp, `ordewell-acp-${dead}-AbC123`);
    mkdirSync(leftover, { mode: 0o700 });
    writeFileSync(join(leftover, 'mcp_settings.json'), 'Bearer an-old-token', { mode: 0o600 });
    const running = join(temp, `ordewell-acp-${process.pid}-XyZ789`);
    mkdirSync(running, { mode: 0o700 });
    const unrelated = join(temp, `ordewell-acpx-${dead}-AbC123`);
    mkdirSync(unrelated);
    const target = join(temp, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'x');
    const link = join(temp, `ordewell-acp-${dead}-Lnk456`);
    symlinkSync(target, link);

    const { adapter } = setup(handshake(NO_HTTP), SETTINGS_PROFILE);
    await adapter.start(taskStart());

    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(running)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('x');
  });

  it('starts an agent that takes no MCP over HTTP, which reads the server from its own settings file and calls a tool', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const mcp = await issued(server);
    const { adapter, agent } = setup([
      { expect: 'initialize', reply: NO_HTTP },
      { expect: 'session/new', reply: { sessionId: 'sess-1' } },
      { callMcp: { tool: 'read', args: { task: 'x' } } },
    ], SETTINGS_PROFILE, {}, {}, READS_SETTINGS);
    await adapter.start(taskStart('ask', { mcp }));

    expect(await adapter.mcpAttached()).toBe('connected');
    await agent.finished;
    expect(agent.problems).toEqual([]);
    expect(agent.mcpCalls.map((c) => c.tool)).toEqual(['read']);
  });

  it('gives two attempts running at once a settings file each, holding only its own token', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const [first, second] = await Promise.all([issued(server, 1), issued(server, 2)]);
    const reads = () => setup([
      { expect: 'initialize', reply: NO_HTTP },
      { expect: 'session/new', reply: { sessionId: 'sess-1' } },
      { callMcp: { tool: 'read', args: { task: 'x' } } },
    ], SETTINGS_PROFILE, {}, {}, READS_SETTINGS);
    const a = reads();
    const b = reads();
    await Promise.all([a.adapter.start(taskStart('ask', { mcp: first })), b.adapter.start(taskStart('ask', { mcp: second }))]);

    const tokenA = first.headers.Authorization;
    const tokenB = second.headers.Authorization;
    expect(tokenA).not.toBe(tokenB);
    const [pathA, pathB] = [a.spawned.lastEnv()[SETTINGS_ENV], b.spawned.lastEnv()[SETTINGS_ENV]];
    expect(pathA).toBeTruthy();
    expect(pathB).toBeTruthy();
    expect(pathA).not.toBe(pathB);
    const [readA, readB] = [a.agent.settingsReads[0], b.agent.settingsReads[0]];
    expect(readA.path).toBe(pathA);
    expect(readB.path).toBe(pathB);
    expect(readA.contents).toContain(tokenA);
    expect(readA.contents).not.toContain(tokenB);
    expect(readB.contents).toContain(tokenB);
    expect(readB.contents).not.toContain(tokenA);
    expect(await Promise.all([a.adapter.mcpAttached(), b.adapter.mcpAttached()])).toEqual(['connected', 'connected']);
  });

  it('refuses, as it does an agent without the server, an agent that is handed the file and never uses it', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const agents: Array<ReturnType<typeof setup>['agent']> = [];
    let attempt = 0;
    const refused = spawnAttached({
      runner: 'fake-acp',
      create: () => {
        const made = setup(handshake(NO_HTTP), { ...SETTINGS_PROFILE, attachTimeoutMs: 20 }, {}, {}, READS_SETTINGS);
        agents.push(made.agent);
        return made.adapter;
      },
      issueToken: () => server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: ++attempt }, { taskComplete: async () => ({ ok: true }) } as never),
      revoke: (token) => server.revoke(token),
      start: (adapter, credential) => adapter.start(taskStart('ask', { mcp: mcpClientConfig(credential) })),
      failed: (first, second) => `${first}; ${second}`,
    });

    const wording = "fake-acp did not report Ordewell's MCP server connected";
    await expect(refused).rejects.toBeInstanceOf(McpAttachTimeout);
    await expect(refused).rejects.toHaveProperty('message', `${wording}; ${wording}`);
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.settingsReads.length)).toEqual([1, 1]);
    expect(agents.every((a) => a.settingsReads[0].contents !== null)).toBe(true);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('refuses to start in a container, where the path it would name is the host\'s and the file is not there, and writes nothing', async () => {
    const place = vi.fn();
    const { adapter, spawned } = setup(handshake(NO_HTTP), SETTINGS_PROFILE, {}, {}, READS_SETTINGS);
    const placed = setup(handshake(NO_HTTP), SETTINGS_PROFILE, {}, { placement: { cwd: '/work', place, reach: async (url) => url, blob: async () => undefined } }, READS_SETTINGS);

    await expect(placed.adapter.start(taskStart())).rejects.toThrow('Fake Agent cannot run in a container: it takes Ordewell\'s MCP server from a settings file on this machine, which the container does not see.');
    expect(place).not.toHaveBeenCalled();
    expect(placed.spawned.processes).toHaveLength(0);
    expect(readdirSync(temp)).toEqual([]);
    await adapter.start(taskStart());
    expect(spawned.processes).toHaveLength(1);
  });

  it('still hands the server in session/new to an agent that advertises HTTP, and none to one that does not, as ACP asks of a client', async () => {
    const plain = setup(handshake(NO_HTTP), SETTINGS_PROFILE);
    await plain.adapter.start(taskStart());
    expect((plain.agent.requests('session/new')[0].params as { mcpServers: unknown }).mcpServers).toEqual([]);
    expect(plain.agent.invalid).toEqual([]);

    const http = setup(handshake(), SETTINGS_PROFILE);
    await http.adapter.start(taskStart());
    expect((http.agent.requests('session/new')[0].params as { mcpServers: unknown }).mcpServers).toEqual([
      { type: 'http', name: 'ordewell', url: 'http://127.0.0.1:4555/mcp', headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }] },
    ]);
  });
});

describe('AcpAdapter provider credential', () => {
  const KEY = 'sk-or-v1-provider-key-never-shown';
  const withKey = (credentials: AcpProfile['credentials']): AcpProfile => ({ ...PROFILE, credentials });

  afterEach(() => vi.unstubAllEnvs());

  it('hands the hook the host\'s and the workspace\'s variables, and adds what it answers to that spawn\'s environment', async () => {
    vi.stubEnv('FAKE_HOST_VAR', 'from-host');
    const seen: Array<Record<string, string | undefined>> = [];
    const { adapter, spawned } = setup(handshake(), withKey(async ({ env }) => {
      seen.push({ host: env.FAKE_HOST_VAR, workspace: env.FAKE_STORE_PATH });
      return { FAKE_PROVIDER: 'openrouter', FAKE_API_KEY: KEY };
    }), {}, { workspaceEnv: async () => ({ FAKE_STORE_PATH: '/elsewhere/providers.json' }) });

    await adapter.start(taskStart());

    expect(seen).toEqual([{ host: 'from-host', workspace: '/elsewhere/providers.json' }]);
    expect(spawned.lastEnv()).toMatchObject({ FAKE_PROVIDER: 'openrouter', FAKE_API_KEY: KEY });
  });

  it('refuses the start in the hook\'s own words when it has no credential, and starts nothing', async () => {
    const { adapter, spawned } = setup(handshake(), withKey(async () => { throw new Error('Fake Agent has no provider key: sign in, or set FAKE_API_KEY.'); }));

    await expect(adapter.start(taskStart())).rejects.toThrow('Fake Agent has no provider key: sign in, or set FAKE_API_KEY.');
    expect(spawned.processes).toHaveLength(0);
  });

  it('spawns a profile without the hook exactly as before, and one whose hook needs nothing the same way', async () => {
    // A key configured in Ordewell reaches only a profile whose hook asks for it.
    stubNoOrdewellProvider();
    vi.stubEnv('OPENROUTER_API_KEY', KEY);
    const workspaceEnv = async () => ({ FAKE_WORKSPACE_VAR: 'w' });
    const plain = setup(handshake(), PROFILE, {}, { workspaceEnv });
    const none = setup(handshake(), withKey(async () => null), {}, { workspaceEnv });
    await plain.adapter.start(taskStart());
    await none.adapter.start(taskStart());

    // Today's launch: the host's variables, the workspace's, the resolved PATH, and nothing of the adapter's,
    // built for the Linux runner `setup` declares, whatever this host is.
    expect(plain.spawned.lastEnv()).toEqual(runnerEnv('/usr/bin', { FAKE_WORKSPACE_VAR: 'w' }, {}, undefined, 'linux'));
    expect(plain.spawned.lastArgs()).toEqual(['--acp']);
    expect(none.spawned.lastEnv()).toEqual(plain.spawned.lastEnv());
    expect(none.spawned.lastArgs()).toEqual(plain.spawned.lastArgs());
    for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLINE_API_KEY', 'CLINE_PROVIDER']) expect(plain.spawned.lastEnv()?.[name] || undefined).toBeUndefined();
  });

  describe('from the provider configured in Ordewell', () => {
    beforeEach(() => {
      // The developer's own agent variables and provider keys must not decide what these read.
      for (const name of ['CLINE_API_KEY', 'CLINE_PROVIDER', 'CLINE_MODEL', 'CLINE_PROVIDER_SETTINGS_PATH']) vi.stubEnv(name, '');
      stubNoOrdewellProvider();
    });

    it('starts each agent under the variables it reads, from the key `/key` wrote to the workspace', async () => {
      const workspaceEnv = async () => ({ OPENROUTER_API_KEY: KEY });
      const qwen = setup(handshake(), withKey(qwenCredentials), {}, { workspaceEnv });
      const cline = setup(handshake(), withKey(clineCredentials({ homedir: () => '/no-such-home' })), {}, { workspaceEnv });

      await qwen.adapter.start(taskStart());
      await cline.adapter.start(taskStart());

      // OpenRouter's OpenAI-compatible endpoint, and Cline's id for OpenRouter.
      expect(qwen.spawned.lastEnv()).toMatchObject({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' });
      expect(cline.spawned.lastEnv()).toMatchObject({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: KEY });
    });

    it('keeps the key out of the log, the agent\'s transcript, the arguments and the errors of a start the agent refuses', async () => {
      const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));
      vi.stubEnv('OPENROUTER_API_KEY', KEY);
      const signedOut = setup([{ expect: 'initialize', reply: INITIALIZED }, { expect: 'session/new', error: { code: ACP_ERROR.authRequired, message: 'Authentication required' } }], withKey(qwenCredentials));

      const refused = await signedOut.adapter.start(taskStart()).then(() => null, (e: unknown) => e as Error);

      expect(signedOut.spawned.lastEnv()?.OPENAI_API_KEY).toBe(KEY);
      expect(refused).toBeInstanceOf(Error);
      const seen = [
        JSON.stringify(signedOut.agent.received),
        JSON.stringify(signedOut.spawned.lastArgs()),
        String(refused?.message),
        String(refused?.stack),
        JSON.stringify(logged.flatMap((spy) => spy.mock.calls)),
      ];
      for (const place of seen) expect(place).not.toContain(KEY);
    });
  });

  it('gives two attempts each its own credential, read for each, and starts one while the other runs', async () => {
    let reads = 0;
    const credentials = vi.fn(async () => ({ FAKE_API_KEY: `${KEY}-${++reads}` }));
    const first = setup([...handshake(), { expect: 'session/prompt' }, { answer: { stopReason: 'end_turn' }, to: 'session/prompt' }], withKey(credentials));
    const second = setup(handshake(), withKey(credentials));

    await first.adapter.start(taskStart());
    const running = turn(first.adapter, 'go');
    await second.adapter.start(taskStart());
    await running;

    expect(credentials).toHaveBeenCalledTimes(2);
    expect(first.spawned.lastEnv()?.FAKE_API_KEY).toBe(`${KEY}-1`);
    expect(second.spawned.lastEnv()?.FAKE_API_KEY).toBe(`${KEY}-2`);

    const together = [setup(handshake(), withKey(credentials)), setup(handshake(), withKey(credentials))];
    await Promise.all(together.map((s) => s.adapter.start(taskStart())));
    expect(together.map((s) => s.spawned.lastEnv()?.FAKE_API_KEY).sort()).toEqual([`${KEY}-3`, `${KEY}-4`]);
  });

  it('hands a container none of the user\'s keys and never reads the store for one', async () => {
    const credentials = vi.fn(async () => ({ FAKE_API_KEY: KEY }));
    const launches: Array<{ env: Readonly<Record<string, string>> }> = [];
    const placement = {
      cwd: '/work',
      place: async (launch: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }) => {
        launches.push(launch);
        return { command: 'docker', args: [...launch.args], env: { FAKE_API_KEY: 'ordewell-lease-token' }, stop: () => {}, ended: vi.fn() };
      },
      reach: async (url: string) => url,
      blob: async () => undefined,
    };
    const { adapter, spawned } = setup(handshake(), withKey(credentials), {}, { placement });

    await adapter.start(taskStart());

    expect(credentials).not.toHaveBeenCalled();
    expect(launches).toHaveLength(1);
    expect(JSON.stringify(launches)).not.toContain(KEY);
    expect(JSON.stringify(spawned.lastEnv())).not.toContain(KEY);
  });

  it('keeps the key out of the log, the events, the agent\'s transcript, the arguments and the start\'s errors', async () => {
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));
    const credentials = async () => ({ FAKE_API_KEY: KEY });
    const { adapter, agent, spawned } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('Done.') }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ], withKey(credentials));

    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');
    const signedOut = setup([{ expect: 'initialize', reply: INITIALIZED }, { expect: 'session/new', error: { code: ACP_ERROR.authRequired, message: 'Authentication required' } }], withKey(credentials));
    const refused = await signedOut.adapter.start(taskStart()).then(() => null, (e: unknown) => e);

    expect(spawned.lastEnv()?.FAKE_API_KEY).toBe(KEY);
    expect(refused).toBeInstanceOf(Error);
    const seen = [
      JSON.stringify(events),
      JSON.stringify(agent.received),
      JSON.stringify(signedOut.agent.received),
      JSON.stringify(spawned.lastArgs()),
      String((refused as Error).message),
      String((refused as Error).stack),
      JSON.stringify(logged.flatMap((spy) => spy.mock.calls)),
    ];
    for (const place of seen) expect(place).not.toContain(KEY);
  });

  describe('with Cline\'s store', () => {
    let home: string;
    const providers = () => join(home, '.cline', 'data', 'settings', 'providers.json');
    const cline = () => withKey(clineCredentials({ homedir: () => home }));
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'ordewell-cline-acp-'));
      mkdirSync(dirname(providers()), { recursive: true });
      // The developer's own Cline variables and provider keys must not decide what these read.
      for (const name of ['CLINE_API_KEY', 'CLINE_PROVIDER', 'CLINE_MODEL', 'CLINE_PROVIDER_SETTINGS_PATH']) vi.stubEnv(name, '');
      stubNoOrdewellProvider();
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it('starts the agent under the last-used entry\'s key, which the agent never hears over ACP', async () => {
      writeFileSync(providers(), JSON.stringify({ version: 1, lastUsedProvider: 'openrouter', providers: { openrouter: { settings: { provider: 'openrouter', apiKey: KEY, model: 'openai/gpt-4.1-mini' } } } }), { mode: 0o600 });
      const { adapter, agent, spawned } = setup(handshake(), cline());

      await adapter.start(taskStart());

      expect(spawned.lastEnv()).toMatchObject({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: KEY, CLINE_MODEL: 'openai/gpt-4.1-mini' });
      expect(JSON.stringify(agent.received)).not.toContain(KEY);
      expect(JSON.stringify(spawned.lastArgs())).not.toContain(KEY);
    });

    it('refuses a signed-out store with both routes in place of today\'s "Run `login`", and starts nothing', async () => {
      writeFileSync(providers(), JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
      const { adapter, spawned } = setup(handshake(), cline());

      const refused = await adapter.start(taskStart()).then(() => null, (e: unknown) => e as Error);

      expect(refused?.message).toBe(`Cline has no provider key Ordewell can hand it: Ordewell holds none for a provider Cline offers, and \`${providers()}\` names no provider it last used. Set the key of a provider Cline offers, such as OpenRouter, in Ordewell with \`/key\`, or sign in with \`cline auth\` (a Cline or ClinePass account, or a provider's key), or set CLINE_PROVIDER and CLINE_API_KEY in Ordewell's environment.`);
      expect(refused?.message).not.toContain('fake-agent login');
      expect(spawned.processes).toHaveLength(0);
    });

    it('refuses an unreadable store the same way', async () => {
      writeFileSync(providers(), '{ not json', { mode: 0o600 });
      const { adapter } = setup(handshake(), cline());

      await expect(adapter.start(taskStart())).rejects.toThrow(`\`${providers()}\` could not be read. Set the key of a provider Cline offers, such as OpenRouter, in Ordewell with \`/key\`, or sign in with \`cline auth\``);
    });
  });
});

describe('AcpAdapter through StructuredRunner', () => {
  it('carries a real task_complete call to the attempt\'s verdict path', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const spawned = fakeAcpSpawn([
      // An eager agent: it reaches the server while opening the session, so the attach check passes at once.
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { callMcp: { tool: 'read', args: { task: 'x' } } },
      { answer: { sessionId: 'sess-1', configOptions: [select('model', 'model', 'm', ['m'])] }, to: 'session/new' },
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm', ['m'])] } },
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: permissionParams('ordewell/task_complete', 'tc') },
      { callMcp: { tool: 'task_complete', args: { status: 'done', summary: 'All done.' } } },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('Reported.') }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    const runner = new StructuredRunner({
      createAdapter: (_runner, deps) => new AcpAdapter(deps, PROFILE),
      process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
      interruptGraceMs: 20,
      mcp: server,
    });
    const reports: TaskCompleteArgs[] = [];
    const session = await runner.spawn({
      taskId: 'task-0001-abcdef',
      runner: 'fake-acp',
      prompt: 'Do the task',
      modelId: 'm',
      mode: 'ask',
      cwd: '/repo',
      registry: { get: () => ({ manifest: MANIFEST }) } as unknown as RunnerRegistry,
    });
    session.onTaskComplete((report) => reports.push(report));
    await spawned.agent.finished;
    await expect.poll(() => reports.length).toBe(1);

    expect(reports[0]).toMatchObject({ status: 'done', summary: 'All done.' });
    expect(spawned.agent.answers.map((a) => a.result)).toEqual([{ outcome: { outcome: 'selected', optionId: 'opt-b' } }]);
    expect(spawned.agent.problems).toEqual([]);
    expect(spawned.lastArgs().join(' ')).not.toMatch(/Bearer|tok/);
    session.kill?.();
  });
});

describe('AcpAdapter attached on the first turn (ADR-0060, R5)', () => {
  const FIRST_TURN: AcpProfile = { ...PROFILE, attach: 'firstTurn', attachTimeoutMs: 2_000 };

  /** A runner whose spawns are `agents` in order: the first spawn, then its respawn. */
  function runnerOver(server: OrdewellMcpServer, agents: Array<ReturnType<typeof fakeAcpSpawn>>, profile: AcpProfile = FIRST_TURN): StructuredRunner {
    let spawns = 0;
    return new StructuredRunner({
      createAdapter: (_runner, deps) => new AcpAdapter(deps, profile),
      process: {
        spawn: (...args: Parameters<AgentProcessDeps['spawn']>) => {
          const next = agents[spawns++];
          if (!next) throw new Error('spawned more often than the test has agents');
          return next.spawn(...args);
        },
        resolvePath: async () => '/usr/bin',
        platform: 'linux',
        isDirectory: () => true,
        exists: () => true,
      },
      interruptGraceMs: 20,
      mcp: server,
    });
  }

  function spawnTask(runner: StructuredRunner, notices: string[] = []) {
    return runner.spawn({
      taskId: 'task-0001-abcdef',
      runner: 'fake-acp',
      prompt: 'Do the task',
      mode: 'ask',
      cwd: '/repo',
      registry: { get: () => ({ manifest: MANIFEST }) } as unknown as RunnerRegistry,
      onNotice: (notice) => notices.push(notice),
    });
  }

  /** An agent that answers its first prompt without ever reaching the server. */
  const withoutTools = () => fakeAcpSpawn([
    ...handshake(),
    { expect: 'session/prompt' },
    { notify: 'session/update', params: update('agent_message_chunk', { content: text('Working without tools.\n') }) },
    { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
  ]);

  const promptText = (agent: ReturnType<typeof fakeAcpSpawn>['agent']) =>
    agent.requests('session/prompt').map((r) => JSON.stringify((r.params as { prompt: unknown }).prompt));

  it('sends the task to an agent that reaches the server only once a prompt starts it, and keeps that turn', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const spawned = fakeAcpSpawn([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('Connecting my tools.\n') }) },
      { callMcp: { tool: 'read', args: { task: 'x' } } },
      { request: 'session/request_permission', params: permissionParams('ordewell/task_complete', 'tc') },
      { callMcp: { tool: 'task_complete', args: { status: 'done', summary: 'All done.' } } },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    const session = await spawnTask(runnerOver(server, [spawned]));
    const events: StructuredEvent[] = [];
    const reports: TaskCompleteArgs[] = [];
    session.onEvent((event) => events.push(event));
    session.onTaskComplete((report) => reports.push(report));
    await spawned.agent.finished;
    await expect.poll(() => reports.length).toBe(1);

    expect(reports[0]).toMatchObject({ status: 'done', summary: 'All done.' });
    expect(promptText(spawned.agent)).toHaveLength(1);
    expect(promptText(spawned.agent)[0]).toContain('Do the task');
    // Sent while the attach was still being checked, and heard in full once it passed.
    expect(events[0]).toMatchObject({ type: 'turn_start', text: 'Do the task' });
    expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'completed' });
    expect(session.getOutput()).toContain('Connecting my tools.');
    expect(spawned.agent.problems).toEqual([]);
    session.kill?.();
  });

  it('fails as before when no first turn uses the token, discarding each turn with its process and token', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const agents = [withoutTools(), withoutTools()];
    const runner = runnerOver(server, agents);
    const notices: string[] = [];
    const began = Date.now();

    const failed = spawnTask(runner, notices);

    await expect(failed).rejects.toBeInstanceOf(McpAttachTimeout);
    await expect(failed).rejects.toHaveProperty('message', expect.stringMatching(/^Could not start fake-acp with Ordewell's tools, so the task was not sent to it\. /));
    // Each turn's end settled its check: neither waited out the attach timeout.
    expect(Date.now() - began).toBeLessThan(FIRST_TURN.attachTimeoutMs!);
    expect(agents.map(({ agent }) => promptText(agent).length)).toEqual([1, 1]);
    expect(agents.map(({ processes }) => processes[0].killed)).toEqual([true, true]);
    expect(server.heldTokens()).toEqual([]);
    expect(runner.activeCount).toBe(0);
    expect(notices).toEqual([expect.stringContaining('respawning once')]);
  });

  it('refuses a token first used after the turn ended, and hears only the respawn\'s turn', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const late = fakeAcpSpawn([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('Working without tools.\n') }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
      { callMcp: { tool: 'task_complete', args: { status: 'done', summary: 'Too late.' } } },
    ]);
    const prompt = fakeAcpSpawn([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('Connected this time.\n') }) },
      { request: 'session/request_permission', params: permissionParams('ordewell/task_complete', 'tc') },
      { callMcp: { tool: 'task_complete', args: { status: 'done', summary: 'All done.' } } },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);

    const session = await spawnTask(runnerOver(server, [late, prompt]));
    const events: StructuredEvent[] = [];
    const reports: TaskCompleteArgs[] = [];
    session.onEvent((event) => events.push(event));
    session.onTaskComplete((report) => reports.push(report));
    await Promise.all([late.agent.finished, prompt.agent.finished]);
    await expect.poll(() => reports.length).toBe(1);

    expect(late.agent.mcpCalls).toEqual([]);
    expect(late.agent.problems).toEqual([expect.stringMatching(/^callMcp task_complete: /)]);
    expect(late.processes[0].killed).toBe(true);
    expect(reports).toEqual([expect.objectContaining({ summary: 'All done.' })]);
    expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(1);
    expect(session.getOutput()).toContain('Connected this time.');
    expect(session.getOutput()).not.toContain('Working without tools.');
    session.kill?.();
  });

  it('discards a first turn still open when its check runs out, with the text and requests it left', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const stuck = fakeAcpSpawn([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('Still deciding') }) },
      { request: 'session/request_permission', params: permissionParams('Write src/a.ts', 'w1') },
    ]);
    const prompt = fakeAcpSpawn([
      ...handshake(),
      { expect: 'session/prompt' },
      { callMcp: { tool: 'task_complete', args: { status: 'done', summary: 'All done.' } } },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('Connected this time.') }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);

    const session = await spawnTask(runnerOver(server, [stuck, prompt], { ...FIRST_TURN, attachTimeoutMs: 150 }));
    const events: StructuredEvent[] = [];
    session.onEvent((event) => events.push(event));
    await prompt.agent.finished;
    await expect.poll(() => events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'completed' });
    session.kill?.();

    expect(stuck.processes[0].killed).toBe(true);
    expect(session.getOutput()).toBe('Connected this time.\n');
    expect(events.filter((e) => e.type.startsWith('permission_'))).toEqual([]);
  });

  it('fails as a start-up exit, with nothing left running, when the agent exits during its first turn without using the token', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const gone = fakeAcpSpawn([
      ...handshake(),
      { expect: 'session/prompt' },
      { run: (agent) => agent.close(1) },
    ]);
    const runner = runnerOver(server, [gone]);

    await expect(spawnTask(runner)).rejects.toBeInstanceOf(RunnerStartupExit);
    expect(server.heldTokens()).toEqual([]);
    expect(runner.activeCount).toBe(0);
  });

  it('sends the task only once the session is open when the agent used the token by then, as a sessionNew agent', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const early = fakeAcpSpawn([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { callMcp: { tool: 'read', args: { task: 'x' } } },
      { answer: { sessionId: 'sess-1' }, to: 'session/new' },
      { expect: 'session/prompt' },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);

    const session = await spawnTask(runnerOver(server, [early]));
    expect(early.agent.requests('session/prompt')).toEqual([]);
    const events: StructuredEvent[] = [];
    session.onEvent((event) => events.push(event));
    await early.agent.finished;
    await expect.poll(() => events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'completed' });
    expect(events[0]).toMatchObject({ type: 'turn_start', text: 'Do the task' });
    expect(early.agent.problems).toEqual([]);
    session.kill?.();
  });

  it('never sends the task to an agent of a sessionNew profile that has not used the token by then', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const agents = [withoutTools(), withoutTools()];

    const failed = spawnTask(runnerOver(server, agents, { ...PROFILE, attach: 'sessionNew', attachTimeoutMs: 20 }));

    await expect(failed).rejects.toBeInstanceOf(McpAttachTimeout);
    await expect(failed).rejects.toHaveProperty('message', expect.stringMatching(/^Could not start fake-acp with Ordewell's tools, so the task was not sent to it\. /));
    expect(agents.map(({ agent }) => agent.requests('session/prompt').length)).toEqual([0, 0]);
    expect(server.heldTokens()).toEqual([]);
  });
});

describe('acpConnector', () => {
  it('is the profile\'s adapter and binding, with no repository config of its own', () => {
    const connector = acpConnector({ ...PROFILE, promptCacheTtlMs: 1000 });
    expect(connector.create({} as AgentProcessDeps)).toBeInstanceOf(AcpAdapter);
    expect(connector.repoConfig.instructions('/repo')).toEqual([]);
    expect(connector.repoConfig.projectServers('/repo')).toEqual({ servers: [], unreadable: [] });
    expect(connector.promptCacheTtlMs).toBe(1000);
    expect(connector.ordewellTools.toolNames('task')).toContain('task_complete');
  });

  it('plans only when its profile claims the planner role', () => {
    expect(acpConnector(PROFILE).plans).toBe(false);
    expect(acpConnector(ROLES_PROFILE).plans).toBe(true);
    expect(acpConnector({ ...ROLES_PROFILE, roles: { plans: false, readOnly: true } }).plans).toBe(false);
  });

  it('refuses at load a profile whose roles its manifest or its controls cannot back', () => {
    expect(() => acpConnector({ ...PROFILE, roles: { plans: false, readOnly: true }, restricted: ROLES_PROFILE.restricted })).toThrow(
      'Fake Agent claims the read-only role, but its manifest has no mode tagged readOnly.',
    );
    expect(() => acpConnector({ ...ROLES_PROFILE, roles: undefined })).toThrow("Fake Agent's manifest tags a read-only mode its profile does not claim.");
    expect(() => acpConnector({ ...PROFILE, roles: { plans: true, readOnly: false } })).toThrow(
      'Fake Agent claims a planner or read-only role without the controls that take its own write and shell tools away.',
    );
    expect(() => acpConnector({ ...PROFILE, roles: { plans: true, readOnly: false }, restricted: { args: [] } })).toThrow(/without the controls/);
    expect(() => acpConnector({ ...ROLES_PROFILE, manifest: { ...MANIFEST, modes: undefined } })).toThrow(
      'Fake Agent claims the read-only role, but its manifest has no mode tagged readOnly.',
    );
  });

  it('lets a planner attach Ordewell\'s tools on its first turn, and tells the planner that turn is the check', () => {
    const firstTurn = acpConnector({ ...ROLES_PROFILE, attach: 'firstTurn' });
    expect(firstTurn.plans).toBe(true);
    expect(firstTurn.attachesOnFirstTurn).toBe(true);
    expect(acpConnector({ ...ROLES_PROFILE, roles: { plans: false, readOnly: true }, attach: 'firstTurn' }).plans).toBe(false);
    expect(acpConnector(ROLES_PROFILE)).not.toHaveProperty('attachesOnFirstTurn');
    expect(acpConnector({ ...ROLES_PROFILE, attach: 'sessionNew' })).not.toHaveProperty('attachesOnFirstTurn');
  });

  it('carries the profile\'s usage-limit reader and leaves out what the profile leaves out', () => {
    const reset = new Date('2026-01-01T00:00:00Z');
    const usageLimitReset = (tail: string): Date | null => (tail.includes('limit') ? reset : null);
    const repoConfig = { instructions: () => [], projectServers: () => ({ servers: [], unreadable: [] }) };
    const carried = acpConnector({ ...PROFILE, usageLimitReset, repoConfig });
    expect(carried.usageLimitReset?.('usage limit hit', new Date())).toBe(reset);
    expect(carried.repoConfig).toBe(repoConfig);

    const bare = acpConnector(PROFILE);
    expect('usageLimitReset' in bare).toBe(false);
    expect('promptCacheTtlMs' in bare).toBe(false);
  });
});

describe('acpOrdewellBinding', () => {
  const binding = acpOrdewellBinding(PROFILE);
  const call = (title: string): AcpToolCall => ({ toolCallId: 'c', title });

  it('tells Ordewell\'s own tools apart by exact name only', () => {
    expect(binding.isOrdewellAsk({ request: call('ordewell/task_complete') })).toBe(true);
    expect(binding.isOrdewellAsk({ request: call('ordewell/read') })).toBe(true);
    expect(binding.isOrdewellAsk({ request: call('ordewell/task_complete_now') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('ordewell/') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('task_complete') })).toBe(false);
  });

  it('reads the attach states', () => {
    expect(binding.attachState('connected')).toBe('connected');
    expect(binding.attachState('failed')).toBe('failed');
    expect(binding.attachState('pending')).toBe('pending');
    expect(binding.attachState(undefined)).toBe('pending');
  });

  it('names tools as the profile says the agent does, when it names them its own way', () => {
    const named = acpOrdewellBinding({ ...PROFILE, toolName: (tool) => `ordewell-${tool}` });
    expect(named.toolName('task_complete')).toBe('ordewell-task_complete');
    expect(named.toolNames('task')).toEqual(binding.toolNames('task').map((tool) => `ordewell-${tool}`));
  });

  it('names tools as the server serves them and hides none from the planner', () => {
    expect(binding.toolName('task_complete')).toBe('task_complete');
    expect(binding.plannerHidden({ kind: 'planner', cwd: '/repo', systemPrompt: '' })).toEqual([]);
  });
});

/** What an agent that can resume says of itself, past the MCP-over-HTTP every agent here needs. */
const initializedWith = (capabilities: Record<string, unknown>) => ({
  ...INITIALIZED,
  agentCapabilities: { mcpCapabilities: { http: true }, ...capabilities },
});

describe('AcpAdapter resume (K1)', () => {
  it('resumes the saved session with session/resume when the agent advertises it, passing Ordewell\'s server again', async () => {
    const { agent, adapter } = setup([
      { expect: 'initialize', reply: initializedWith({ sessionCapabilities: { resume: {} }, loadSession: true }) },
      { expect: 'session/resume', reply: {} },
    ]);
    await adapter.start(taskStart('ask', { resumeSessionId: 'sess-old' }));

    expect(agent.requests('session/new')).toEqual([]);
    expect(agent.requests('session/load')).toEqual([]);
    expect(agent.requests('session/resume').map((m) => m.params)).toEqual([{
      sessionId: 'sess-old',
      cwd: '/repo',
      mcpServers: [{ type: 'http', name: 'ordewell', url: 'http://127.0.0.1:4555/mcp', headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }] }],
    }]);
    expect(adapter.nativeSessionId()).toBe('sess-old');
    expect(agent.invalid).toEqual([]);
    expect(agent.unexpected).toEqual([]);
  });

  it('loads the session when only session/load is advertised, and shows none of the history the agent replays', async () => {
    const { agent, adapter } = setup([
      { expect: 'initialize', reply: initializedWith({ loadSession: true }) },
      { expect: 'session/load' },
      { notify: 'session/update', params: update('user_message_chunk', { content: text('old question') }) },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('old answer') }) },
      { answer: {} },
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('new answer') }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart('ask', { resumeSessionId: 'sess-1' }));
    expect(agent.requests('session/load').map((m) => m.params)).toEqual([{
      sessionId: 'sess-1', cwd: '/repo',
      mcpServers: [{ type: 'http', name: 'ordewell', url: 'http://127.0.0.1:4555/mcp', headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }] }],
    }]);
    const events = await turn(adapter, 'go on');
    expect(events.filter((e) => e.type === 'assistant_text').map((e) => e.type === 'assistant_text' && e.text)).toEqual(['new answer']);
    expect(agent.invalid).toEqual([]);
    expect(agent.unexpected).toEqual([]);
  });

  it('fails in plain words when the agent offers neither way to resume, without opening a new session', async () => {
    const { agent, adapter } = setup([{ expect: 'initialize', reply: INITIALIZED }]);
    await expect(adapter.start(taskStart('ask', { resumeSessionId: 'sess-old' }))).rejects.toThrow(
      'Fake Agent could not resume session sess-old: it offers neither session/resume nor session/load.',
    );
    expect(agent.requests('session/new')).toEqual([]);
  });

  it('fails when the agent refuses the resume, and never falls back to a new session', async () => {
    const { agent, adapter } = setup([
      { expect: 'initialize', reply: initializedWith({ sessionCapabilities: { resume: {} } }) },
      { expect: 'session/resume', error: { code: -32002, message: 'Session not found' } },
    ]);
    await expect(adapter.start(taskStart('ask', { resumeSessionId: 'sess-old' }))).rejects.toThrow(
      'Fake Agent could not resume session sess-old: Session not found',
    );
    expect(agent.requests('session/new')).toEqual([]);
    expect(await adapter.mcpAttached()).toBe('failed');
  });

  it('names the login command when the agent wants a sign-in to resume', async () => {
    const { adapter } = setup([
      { expect: 'initialize', reply: initializedWith({ sessionCapabilities: { resume: {} } }) },
      { expect: 'session/resume', error: { code: ACP_ERROR.authRequired, message: 'Authentication required' } },
    ]);
    await expect(adapter.start(taskStart('ask', { resumeSessionId: 'sess-old' }))).rejects.toThrow('Fake Agent is not signed in. Sign in with /login fake-acp, or run fake-agent login.');
  });

  it('fails in words when the agent answers a resume in a shape Ordewell cannot read', async () => {
    const { adapter } = setup([
      { expect: 'initialize', reply: initializedWith({ sessionCapabilities: { resume: {} } }) },
      { expect: 'session/resume', reply: { configOptions: 'none' } },
    ]);
    await expect(adapter.start(taskStart('ask', { resumeSessionId: 'sess-old' }))).rejects.toThrow(
      /Fake Agent resumed session sess-old in a shape Ordewell cannot read/,
    );
  });

  it('gives the contract to the resumed session too when the profile carries it in _meta', async () => {
    const { agent, adapter } = setup([
      { expect: 'initialize', reply: initializedWith({ sessionCapabilities: { resume: {} } }) },
      { expect: 'session/resume', reply: {} },
    ], { ...PROFILE, instructions: { kind: 'meta', key: 'systemPrompt' } });
    await adapter.start(taskStart('ask', { resumeSessionId: 'sess-old' }));
    const [resumed] = agent.requests('session/resume');
    expect((resumed.params as { _meta: Record<string, unknown> })._meta.systemPrompt).toEqual(expect.stringContaining('task_complete'));
  });

  it('sets the plan\'s model on a resumed session like on a new one', async () => {
    const { agent, adapter } = setup([
      { expect: 'initialize', reply: initializedWith({ sessionCapabilities: { resume: {} } }) },
      { expect: 'session/resume', reply: { configOptions: [select('model', 'model', 'm-0', ['m-0', 'm-1'])] } },
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-1', ['m-0', 'm-1'])] } },
    ]);
    await adapter.start(taskStart('ask', { resumeSessionId: 'sess-old', model: 'm-1' }));
    expect(agent.requests('session/set_config_option').map((m) => m.params)).toEqual([{ sessionId: 'sess-old', configId: 'model', value: 'm-1' }]);
  });
});

const COMMANDS = [
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'review', description: 'Review the changes', input: { hint: '<files>' } },
];

describe('AcpAdapter commands', () => {
  it('offers the commands the agent reports, announces them once for the process, and follows later lists', async () => {
    const { adapter } = setup([
      ...handshake(),
      { notify: 'session/update', params: update('available_commands_update', { availableCommands: COMMANDS }) },
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('available_commands_update', { availableCommands: [COMMANDS[0]] }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
      { expect: 'session/prompt', reply: { stopReason: 'end_turn' } },
    ]);
    await adapter.start(taskStart());
    expect(adapter.commands()).toEqual([
      { name: 'compact', description: 'Compact the conversation', kind: 'command' },
      { name: 'review', description: 'Review the changes', argumentHint: '<files>', kind: 'command' },
    ]);

    const first = await turn(adapter, 'hi');
    expect(first.filter((e) => e.type === 'runner_loaded')).toEqual([{
      type: 'runner_loaded',
      commands: [
        { name: 'compact', description: 'Compact the conversation', kind: 'command' },
        { name: 'review', description: 'Review the changes', argumentHint: '<files>', kind: 'command' },
      ],
      mcpServers: [],
    }]);
    expect(adapter.commands().map((c) => c.name)).toEqual(['compact']);

    const second = await turn(adapter, 'again');
    expect(second.filter((e) => e.type === 'runner_loaded')).toEqual([]);
  });

  it('runs a reported command as a prompt, and refuses one the agent did not report', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { notify: 'session/update', params: update('available_commands_update', { availableCommands: COMMANDS }) },
      { expect: 'session/prompt', reply: { stopReason: 'end_turn' } },
    ]);
    await adapter.start(taskStart());

    const unknown: AgentEvent[] = [];
    await adapter.invokeCommand('nope', '', (e) => unknown.push(e));
    expect(unknown).toEqual([{ type: 'error', message: 'Fake Agent did not report command /nope.' }]);
    expect(agent.requests('session/prompt')).toEqual([]);

    const events: AgentEvent[] = [];
    await adapter.invokeCommand('review', 'src/a.ts', (e) => events.push(e));
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    const [prompt] = agent.requests('session/prompt');
    expect(JSON.stringify(prompt.params)).toContain('/review src/a.ts');
  });
});

describe('AcpAdapter session updates', () => {
  it("ignores an update that names another session, however it would read in this turn", async () => {
    const { adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: { sessionId: 'sess-other', update: { sessionUpdate: 'agent_message_chunk', content: text('not mine') } } },
      { notify: 'session/update', params: { sessionId: 'sess-other', update: { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS } } },
      { notify: 'session/update', params: update('agent_message_chunk', { content: text('mine') }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'hi');
    expect(events.filter((e) => e.type === 'assistant_text')).toEqual([{ type: 'assistant_text', runId: 'acp-msg-1', text: 'mine' }]);
    expect(events.some((e) => e.type === 'runner_loaded')).toBe(false);
    expect(adapter.commands()).toEqual([]);
  });
});

const select = (id: string, category: string | null, currentValue: string, values: string[]) => ({
  id,
  name: id,
  ...(category ? { category } : {}),
  type: 'select',
  currentValue,
  options: values.map((value) => ({ value, name: `Name of ${value}` })),
});
const withOptions = (configOptions: unknown[]): FakeAcpStep[] => [
  { expect: 'initialize', reply: INITIALIZED },
  { expect: 'session/new', reply: { sessionId: 'sess-1', configOptions } },
];
const SESSION_MODE_PROFILE: AcpProfile = { ...PROFILE, mode: { kind: 'session-mode' } } as AcpProfile;

describe('AcpAdapter config options', () => {
  it('sets the plan\'s mode through the mode option, found by its category under any id', async () => {
    const { agent, adapter } = setup([
      ...withOptions([select('permission_level', 'mode', 'default', ['default', 'ask', 'auto'])]),
      { expect: 'session/set_config_option', reply: { configOptions: [select('permission_level', 'mode', 'ask', ['default', 'ask', 'auto'])] } },
    ], SESSION_MODE_PROFILE);
    await adapter.start(taskStart('ask'));
    expect(agent.requests('session/set_config_option').map((m) => m.params)).toEqual([{ sessionId: 'sess-1', configId: 'permission_level', value: 'ask' }]);
    expect(agent.requests('session/set_mode')).toEqual([]);
    expect(agent.invalid).toEqual([]);
    expect(agent.unexpected).toEqual([]);
  });

  it('finds the model and the effort by id when the agent names no category, and sets both', async () => {
    const { agent, adapter } = setup([
      ...withOptions([select('model', null, 'm-0', ['m-0', 'm-1']), select('reasoning_effort', null, 'low', ['low', 'high'])]),
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', null, 'm-1', ['m-0', 'm-1']), select('reasoning_effort', null, 'low', ['low', 'high'])] } },
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', null, 'm-1', ['m-0', 'm-1']), select('reasoning_effort', null, 'high', ['low', 'high'])] } },
    ]);
    await adapter.start(taskStart('ask', { model: 'm-1', flags: { ...resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }), effort: 'high' } }));
    expect(agent.requests('session/set_config_option').map((m) => m.params)).toEqual([
      { sessionId: 'sess-1', configId: 'model', value: 'm-1' },
      { sessionId: 'sess-1', configId: 'reasoning_effort', value: 'high' },
    ]);
    expect(agent.unexpected).toEqual([]);
  });

  it('keeps the list an update gave ahead of a session/new answer that carries none', async () => {
    const { agent, adapter } = setup([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { notify: 'session/update', params: update('config_option_update', { configOptions: [select('model', 'model', 'm-0', ['m-0', 'm-1'])] }) },
      { answer: { sessionId: 'sess-1' }, to: 'session/new' },
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-1', ['m-0', 'm-1'])] } },
    ]);
    await adapter.start(taskStart('ask', { model: 'm-1' }));
    expect(agent.requests('session/set_config_option').map((m) => m.params)).toEqual([{ sessionId: 'sess-1', configId: 'model', value: 'm-1' }]);
  });

  it('reads the complete list after every set, since a model can bring its own effort option', async () => {
    const { agent, adapter } = setup([
      ...withOptions([select('model', 'model', 'm-0', ['m-0', 'm-1'])]),
      // Only once on m-1 does the agent offer an effort, under an id it did not have before.
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-1', ['m-0', 'm-1']), select('thinking', 'thought_level', 'low', ['low', 'high'])] } },
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-1', ['m-0', 'm-1']), select('thinking', 'thought_level', 'high', ['low', 'high'])] } },
    ]);
    await adapter.start(taskStart('ask', { model: 'm-1', flags: { ...resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }), effort: 'high' } }));
    expect(agent.requests('session/set_config_option').map((m) => (m.params as { configId: string }).configId)).toEqual(['model', 'thinking']);
    expect(agent.unexpected).toEqual([]);
  });
});

const effortFlags = (effort: string) => ({ ...resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }), effort });

describe('AcpAdapter config options held to the plan (B2)', () => {
  it('says in plain words that the agent does not know a model, when it answers invalid params', async () => {
    const { adapter } = setup([
      ...withOptions([select('model', 'model', 'm-0', ['m-0'])]),
      { expect: 'session/set_config_option', error: { code: ACP_ERROR.invalidParams, message: 'Invalid value' } },
    ]);
    await expect(adapter.start(taskStart('ask', { model: 'gpt-9' }))).rejects.toThrow(
      'Fake Agent does not know the model "gpt-9" (or its setting "model"): Invalid value',
    );
  });

  it('fails with the agent\'s own refusal for any other error', async () => {
    const { adapter } = setup([
      ...withOptions([select('model', 'model', 'm-0', ['m-0'])]),
      { expect: 'session/set_config_option', error: { code: ACP_ERROR.internalError, message: 'busy' } },
    ]);
    await expect(adapter.start(taskStart('ask', { model: 'm-0' }))).rejects.toThrow('Fake Agent refused the model "m-0": busy');
  });

  it('fails when the agent answers a change in a shape Ordewell cannot read', async () => {
    const { adapter } = setup([
      ...withOptions([select('model', 'model', 'm-0', ['m-0'])]),
      { expect: 'session/set_config_option', reply: { configOptions: 'none' } },
    ]);
    await expect(adapter.start(taskStart('ask', { model: 'm-0' }))).rejects.toThrow(/Fake Agent answered a model change in a shape Ordewell cannot read/);
  });

  it('fails, naming the model, when the agent has no setting for it', async () => {
    const { agent, adapter } = setup(handshake());
    await expect(adapter.start(taskStart('ask', { model: 'm-1' }))).rejects.toThrow(
      'Fake Agent offers no model setting, so it cannot run this task on the model "m-1".',
    );
    expect(agent.requests('session/set_config_option')).toEqual([]);
  });

  it('fails the attempt when the agent stays on another mode than the plan\'s', async () => {
    const { adapter } = setup([
      ...withOptions([select('mode', 'mode', 'default', ['default', 'ask'])]),
      { expect: 'session/set_config_option', reply: { configOptions: [select('mode', 'mode', 'default', ['default', 'ask'])] } },
    ], SESSION_MODE_PROFILE);
    await expect(adapter.start(taskStart('ask'))).rejects.toThrow('Fake Agent did not take the mode "ask": it is on "default".');
  });

  it('starts on a model the agent put elsewhere, and reports the drift in the first turn', async () => {
    const { adapter } = setup([
      ...withOptions([select('model', 'model', 'm-0', ['m-0', 'm-1'])]),
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-0', ['m-0', 'm-1'])] } },
      { expect: 'session/prompt', reply: { stopReason: 'end_turn' } },
    ]);
    await adapter.start(taskStart('ask', { model: 'm-1' }));
    const events = await turn(adapter, 'go');
    expect(events[0]).toEqual({ type: 'model_drifted', from: { model: 'm-1' }, to: { model: 'm-0' } });
  });

  it('notes an effort the agent did not take, in the first turn, and runs on', async () => {
    const { adapter } = setup([
      ...withOptions([select('model', 'model', 'm-1', ['m-1']), select('effort', 'thought_level', 'low', ['low', 'high'])]),
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-1', ['m-1']), select('effort', 'thought_level', 'low', ['low', 'high'])] } },
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-1', ['m-1']), select('effort', 'thought_level', 'low', ['low', 'high'])] } },
      { expect: 'session/prompt', reply: { stopReason: 'end_turn' } },
    ]);
    await adapter.start(taskStart('ask', { model: 'm-1', flags: effortFlags('high') }));
    const events = await turn(adapter, 'go');
    expect(events[0]).toEqual({ type: 'command_output', text: 'Fake Agent did not take the effort "high": it is on "low".' });
  });

  describe('held by the list the agent ends on, since a later change can move one already set', () => {
    const moved = (): FakeAcpStep[] => [
      ...withOptions([select('model', 'model', 'm-0', ['m-0', 'm-1']), select('effort', 'thought_level', 'low', ['low', 'high'])]),
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-1', ['m-0', 'm-1']), select('effort', 'thought_level', 'low', ['low', 'high'])] } },
      // The effort is taken, and the model the agent took a moment ago goes back.
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-0', ['m-0', 'm-1']), select('effort', 'thought_level', 'high', ['low', 'high'])] } },
      { expect: 'session/prompt', reply: { stopReason: 'end_turn' } },
    ];

    it('reports a model an effort change moved, in the first turn, for a task that may run on', async () => {
      const { adapter } = setup(moved());
      await adapter.start(taskStart('ask', { model: 'm-1', flags: effortFlags('high') }));
      const events = await turn(adapter, 'go');
      expect(events[0]).toEqual({ type: 'model_drifted', from: { model: 'm-1' }, to: { model: 'm-0' } });
    });

    it('fails a read-only task whose model an effort change moved', async () => {
      const { adapter } = setup(moved(), ROLES_PROFILE);
      await expect(adapter.start(readOnlyStart({ model: 'm-1', flags: { ...resolveTaskRunnerFlags(ROLES_MANIFEST, { mode: 'look' }), effort: 'high' } })))
        .rejects.toThrow('Fake Agent did not take the model "m-1": it is on "m-0".');
    });

    it('fails a task whose mode a model change moved', async () => {
      const { adapter } = setup([
        ...withOptions([select('mode', 'mode', 'default', ['default', 'ask']), select('model', 'model', 'm-0', ['m-0', 'm-1'])]),
        { expect: 'session/set_config_option', reply: { configOptions: [select('mode', 'mode', 'ask', ['default', 'ask']), select('model', 'model', 'm-0', ['m-0', 'm-1'])] } },
        { expect: 'session/set_config_option', reply: { configOptions: [select('mode', 'mode', 'default', ['default', 'ask']), select('model', 'model', 'm-1', ['m-0', 'm-1'])] } },
      ], SESSION_MODE_PROFILE);
      await expect(adapter.start(taskStart('ask', { model: 'm-1' }))).rejects.toThrow('Fake Agent did not take the mode "ask": it is on "default".');
    });
  });

  describe('held to what the wire says last, when the update after an answer shares its chunk', () => {
    const answeredThenMoved = (answered: unknown[], moved: unknown[]): FakeAcpStep[] => [
      { expect: 'session/set_config_option' },
      { together: [
        { answer: { configOptions: answered }, to: 'session/set_config_option' },
        { notify: 'session/update', params: update('config_option_update', { configOptions: moved }) },
      ] },
    ];

    it('fails a task whose mode the update moves back', async () => {
      const modes = (current: string) => [select('mode', 'mode', current, ['default', 'ask'])];
      const { adapter } = setup([...withOptions(modes('default')), ...answeredThenMoved(modes('ask'), modes('default'))], SESSION_MODE_PROFILE);
      await expect(adapter.start(taskStart('ask'))).rejects.toThrow('Fake Agent did not take the mode "ask": it is on "default".');
    });

    const models = (current: string) => [select('model', 'model', current, ['m-0', 'm-1'])];

    it('reports the model the update moves back as drift, in the first turn, for a task that may run on', async () => {
      const { adapter } = setup([
        ...withOptions(models('m-0')),
        ...answeredThenMoved(models('m-1'), models('m-0')),
        { expect: 'session/prompt', reply: { stopReason: 'end_turn' } },
      ]);
      await adapter.start(taskStart('ask', { model: 'm-1' }));
      const events = await turn(adapter, 'go');
      expect(events[0]).toEqual({ type: 'model_drifted', from: { model: 'm-1' }, to: { model: 'm-0' } });
    });

    it('fails a task the agent puts back on another mode right after it answers session/set_mode', async () => {
      const modes = (current: string) => ({ currentModeId: current, availableModes: [{ id: 'default', name: 'Default' }, { id: 'ask', name: 'Ask' }] });
      const { adapter } = setup([
        { expect: 'initialize', reply: INITIALIZED },
        { expect: 'session/new', reply: { sessionId: 'sess-1', modes: modes('default') } },
        { expect: 'session/set_mode' },
        { together: [
          { answer: {}, to: 'session/set_mode' },
          { notify: 'session/update', params: update('current_mode_update', { currentModeId: 'default' }) },
        ] },
      ], SESSION_MODE_PROFILE);
      await expect(adapter.start(taskStart('ask'))).rejects.toThrow('Fake Agent did not take the mode "ask": it is on "default".');
    });

    it('fails a read-only task whose model the update moves back', async () => {
      const { adapter } = setup([...withOptions(models('m-0')), ...answeredThenMoved(models('m-1'), models('m-0'))], ROLES_PROFILE);
      await expect(adapter.start(readOnlyStart({ model: 'm-1' }))).rejects.toThrow('Fake Agent did not take the model "m-1": it is on "m-0".');
    });
  });

  it('fails when the agent has no effort setting for an effort the plan names', async () => {
    const { adapter } = setup([
      ...withOptions([select('model', 'model', 'm-1', ['m-1'])]),
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-1', ['m-1'])] } },
    ]);
    await expect(adapter.start(taskStart('ask', { model: 'm-1', flags: effortFlags('high') }))).rejects.toThrow(
      'Fake Agent offers no effort setting, so it cannot run this task on the effort "high".',
    );
  });

  it('still sets the mode through session/set_mode when the agent has no mode option, and fails on a refusal', async () => {
    const { agent, adapter } = setup([
      ...withOptions([select('model', 'model', 'm-0', ['m-0'])]),
      { expect: 'session/set_mode', error: { code: ACP_ERROR.invalidParams, message: 'Unknown mode' } },
    ], SESSION_MODE_PROFILE);
    await expect(adapter.start(taskStart('ask'))).rejects.toThrow('Fake Agent refused the mode "ask": Unknown mode');
    expect(agent.requests('session/set_config_option')).toEqual([]);
  });
});

describe('AcpAdapter config_option_update (#106)', () => {
  const list = (model: string, effort = 'low') => [select('model', 'model', model, ['m-0', 'm-1']), select('effort', 'thought_level', effort, ['low', 'high'])];
  const optionsUpdate = (configOptions: unknown[]) => ({ notify: 'session/update', params: update('config_option_update', { configOptions }) }) as const;
  const m0 = { model: 'm-0', label: 'Name of m-0' };
  const m1 = { model: 'm-1', label: 'Name of m-1' };

  it('reports a model change nobody asked for in the chat as drift', async () => {
    const { adapter } = setup([
      ...withOptions(list('m-0')),
      { expect: 'session/prompt' },
      optionsUpdate(list('m-1')),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');
    expect(events.filter((e) => e.type.startsWith('model_'))).toEqual([{ type: 'model_drifted', from: m0, to: m1 }]);
  });

  it('reports the change a model command in the chat made as a switch, with the effort the agent then reports', async () => {
    const { adapter } = setup([
      ...withOptions(list('m-0')),
      { expect: 'session/prompt' },
      optionsUpdate(list('m-1', 'high')),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
      { expect: 'session/prompt' },
      optionsUpdate(list('m-0', 'high')),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const first = await turn(adapter, '/model m-1');
    expect(first.filter((e) => e.type.startsWith('model_'))).toEqual([{ type: 'model_switched', from: m0, to: m1, effort: 'high' }]);
    // The command was spent with its turn: the same kind of update, unprompted, is drift again.
    const second = await turn(adapter, 'carry on');
    expect(second.filter((e) => e.type.startsWith('model_'))).toEqual([{ type: 'model_drifted', from: m1, to: m0 }]);
  });

  it('is silent for a list that keeps the model, and holds the new list for later changes', async () => {
    const { adapter } = setup([
      ...withOptions(list('m-0')),
      { expect: 'session/prompt' },
      optionsUpdate(list('m-0', 'high')),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');
    expect(events.filter((e) => e.type.startsWith('model_'))).toEqual([]);
  });

  it('recognises a model command by the name the agent reports for it', async () => {
    const { adapter } = setup([
      ...withOptions(list('m-0')),
      { notify: 'session/update', params: update('available_commands_update', { availableCommands: [{ name: 'model', description: 'Pick a model' }] }) },
      { expect: 'session/prompt' },
      optionsUpdate(list('m-1')),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    await adapter.invokeCommand('model', 'm-1', (e) => events.push(e));
    expect(events.filter((e) => e.type.startsWith('model_'))).toEqual([{ type: 'model_switched', from: m0, to: m1, effort: 'low' }]);
  });
});

describe('AcpAdapter model labels', () => {
  const optionsUpdate = (configOptions: unknown[]) => ({ notify: 'session/update', params: update('config_option_update', { configOptions }) }) as const;

  it('names a model by the label in a grouped list, and by its id when the list gives none or drops the option', async () => {
    const grouped = {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm-1',
      options: [{ group: 'g', name: 'Group', options: [{ value: 'm-0', name: 'Zero' }, { value: 'm-1', name: 'One' }] }, { name: 'nothing to pick here' }],
    };
    const bare = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm-2' };
    const { adapter } = setup([
      ...withOptions([select('model', 'model', 'm-0', ['m-0'])]),
      { expect: 'session/prompt' },
      optionsUpdate([grouped]),
      optionsUpdate([bare]),
      optionsUpdate([select('effort', 'thought_level', 'low', ['low'])]),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');
    expect(events.filter((e) => e.type.startsWith('model_'))).toEqual([
      { type: 'model_drifted', from: { model: 'm-0', label: 'Zero' }, to: { model: 'm-1', label: 'One' } },
      { type: 'model_drifted', from: { model: 'm-1' }, to: { model: 'm-2' } },
    ]);
  });

  it('reports no change when the agent never had a model option', async () => {
    const { adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      optionsUpdate([select('model', 'model', 'm-1', ['m-1'])]),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart());
    const events = await turn(adapter, 'go');
    expect(events.filter((e) => e.type.startsWith('model_'))).toEqual([]);
  });
});

describe('AcpAdapter close', () => {
  it('closes the session on dispose when the agent advertises session/close', async () => {
    const { agent, adapter } = setup([
      { expect: 'initialize', reply: initializedWith({ sessionCapabilities: { close: {} } }) },
      { expect: 'session/new', reply: { sessionId: 'sess-1' } },
      { expect: 'session/close', reply: {} },
    ]);
    await adapter.start(taskStart());
    adapter.dispose();
    await vi.waitFor(() => expect(agent.requests('session/close').map((m) => m.params)).toEqual([{ sessionId: 'sess-1' }]));
    expect(agent.invalid).toEqual([]);
  });

  it('sends nothing on dispose when the agent does not advertise it', async () => {
    const { agent, adapter } = setup(handshake());
    await adapter.start(taskStart());
    adapter.dispose();
    expect(agent.requests('session/close')).toEqual([]);
  });
});

/** A request for one call of `kind`, with the options `permissionParams` offers. */
function requestFor(kind: string | undefined, toolCallId: string, fields: Record<string, unknown> = {}) {
  const params = permissionParams(`${kind ?? 'unnamed'} ${toolCallId}`, toolCallId);
  return { ...params, toolCall: { toolCallId, title: params.toolCall.title, ...(kind ? { kind } : {}), ...fields } };
}
const ask = (kind: string | undefined, toolCallId: string, fields: Record<string, unknown> = {}): FakeAcpStep => (
  { request: 'session/request_permission', params: requestFor(kind, toolCallId, fields) }
);
const chosen = (agent: { answers: Array<{ result?: unknown }> }) => agent.answers.map((a) => (a.result as { outcome: { optionId?: string } }).outcome.optionId);
const promptText = (agent: ReturnType<typeof setup>['agent'], index = 0) => (agent.requests('session/prompt')[index].params as { prompt: Array<{ text: string }> }).prompt[0].text;
const WITH_MODES = { sessionId: 'sess-1', modes: { currentModeId: 'read', availableModes: [{ id: 'read', name: 'Read' }, { id: 'write', name: 'Write' }] } };

describe('AcpAdapter roles (ADR-0026, ADR-0046)', () => {
  it('starts a planner under the restricted controls and no mode, with its system prompt and its tools ahead of the first prompt', async () => {
    const { agent, adapter, spawned } = setup([...handshake(), { expect: 'session/prompt', reply: { stopReason: 'end_turn' } }], ROLES_PROFILE);
    await adapter.start(plannerStart());
    await turn(adapter, 'Plan the change');

    expect(spawned.lastArgs()).toEqual(['--acp', '--deny-tool=write', '--deny-tool=shell']);
    expect(spawned.lastEnv().FAKE_ALLOW_ALL).toBe('false');
    expect(spawned.lastArgs().join(' ')).not.toContain(TOKEN);
    const [opened] = agent.requests('session/new');
    expect((opened.params as { mcpServers: Array<{ name: string }> }).mcpServers.map((s) => s.name)).toEqual([MCP.name]);
    const first = promptText(agent);
    expect(first.startsWith('You are the planner.\n\n')).toBe(true);
    expect(first).toContain(`Your Ordewell tools come from the \`${MCP.name}\` MCP server: `);
    expect(first).toContain('run commands with `run_command`, read web pages with `fetch` and search the web with `web_search`.');
    expect(first).not.toContain('task_complete');
    expect(first.endsWith('Plan the change')).toBe(true);
  });

  it('names to a planner only the tools its token serves', async () => {
    const { agent, adapter } = setup([...handshake(), { expect: 'session/prompt', reply: { stopReason: 'end_turn' } }], ROLES_PROFILE);
    await adapter.start(plannerStart({ mcp: { ...MCP, hidden: ['fetch', 'web_search'] } }));
    await turn(adapter, 'Plan');

    const first = promptText(agent);
    expect(first).toContain('run commands with `run_command`.');
    expect(first).not.toMatch(/`fetch`|`web_search`/);
  });

  it('starts a read-only task under the restricted controls, telling it Ordewell\'s tools are its shell and its web', async () => {
    const { agent, adapter, spawned } = setup([...handshake(), { expect: 'session/prompt', reply: { stopReason: 'end_turn' } }], ROLES_PROFILE);
    await adapter.start(readOnlyStart());
    await turn(adapter, 'Review it');

    expect(spawned.lastArgs()).toEqual(['--acp', '--deny-tool=write', '--deny-tool=shell']);
    expect(spawned.lastEnv().FAKE_ALLOW_ALL).toBe('false');
    const first = promptText(agent);
    expect(first.startsWith('This task is read-only: your own file edits, shell and web tools are off.')).toBe(true);
    expect(first).toContain('task_complete');
  });

  it('starts a task its token holds read-only under the restricted controls alone, whatever mode the plan gave it', async () => {
    const { adapter, spawned } = setup(handshake(), ROLES_PROFILE);
    await adapter.start(taskStart('auto', { flags: resolveTaskRunnerFlags(ROLES_MANIFEST, { mode: 'auto' }), mcp: { ...MCP, readOnly: true } }));

    expect(spawned.lastArgs()).toEqual(['--acp', '--deny-tool=write', '--deny-tool=shell']);
  });

  it('starts a planner and a read-only task of a profile that loads its start directory\'s configuration in an empty private directory, and still judges their reads by the worktree', async () => {
    const outside: AcpProfile = { ...ROLES_PROFILE, restricted: { ...ROLES_PROFILE.restricted!, privateCwd: true } };
    const read = ask('read', 'c-read', { locations: [{ path: '/repo/src/a.ts' }] });
    for (const start of [plannerStart(), readOnlyStart()]) {
      const { agent, adapter, spawned } = setup([...handshake(), { expect: 'session/prompt' }, read, { answer: { stopReason: 'end_turn' }, to: 'session/prompt' }], outside);
      await adapter.start(start);
      const asks: unknown[] = [];
      await adapter.send('go', (e) => {
        if (e.type !== 'permission_request') return;
        // A planner's read is held for its envelope, which judges it by the
        // workspace; a read-only task's is answered here, by its worktree.
        asks.push(e.decided?.decision ?? e.ask);
        if (!e.decided) adapter.answerPermission(e.id, { decision: 'allow' });
      });

      const dir = spawned.lastCwd()!;
      expect(dir).not.toBe('/repo');
      if (POSIX_MODES) expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readdirSync(dir)).toEqual([]);
      expect((agent.requests('session/new')[0].params as { cwd: string }).cwd).toBe(dir);
      // Its relative paths now name the empty directory, so it is told where the files are.
      expect(promptText(agent)).toContain('The workspace is `/repo`, not the directory you start in: name its files by their full path there.');
      expect(asks).toEqual([start.kind === 'planner' ? { kind: 'path', path: '/repo/src/a.ts', directory: false } : 'allow']);
      expect(chosen(agent)).toEqual(['opt-b']);
      adapter.dispose();
      expect(existsSync(dir)).toBe(false);
    }
  });

  it('hands such a start its instructions as its private directory\'s own file, and makes that directory its temp directory', async () => {
    const outside: AcpProfile = {
      ...ROLES_PROFILE,
      instructions: { kind: 'file', fileName: 'AGENTS.md', pass: { envDir: 'FAKE_INSTRUCTION_DIRS' } },
      restricted: { ...ROLES_PROFILE.restricted!, privateCwd: true },
    };
    const { adapter, spawned } = setup(handshake(), outside);
    await adapter.start(plannerStart());

    const dir = spawned.lastCwd()!;
    const file = join(dir, 'AGENTS.md');
    expect(readdirSync(dir)).toEqual(['AGENTS.md']);
    if (POSIX_MODES) expect(statSync(file).mode & 0o077).toBe(0);
    expect(readFileSync(file, 'utf8')).toMatch(/^The workspace is `\/repo`, [^\n]*\n\nYou are the planner\./);
    expect(spawned.lastEnv().FAKE_INSTRUCTION_DIRS).toBeUndefined();
    expect([spawned.lastEnv().TMPDIR, spawned.lastEnv().TMP, spawned.lastEnv().TEMP]).toEqual([dir, dir, dir]);
    adapter.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a restricted start of such a profile where a placement would start it in the worktree', async () => {
    const outside: AcpProfile = { ...ROLES_PROFILE, restricted: { ...ROLES_PROFILE.restricted!, privateCwd: true } };
    const place = vi.fn();
    const { adapter, spawned } = setup(handshake(), outside, {}, { placement: { cwd: '/work', place, reach: async (url) => url, blob: async () => undefined } });

    await expect(adapter.start(readOnlyStart())).rejects.toThrow(/cannot run a read-only task in a container/);
    expect(place).not.toHaveBeenCalled();
    expect(spawned.processes).toHaveLength(0);
  });

  it('leaves a writable task on a role-claiming profile as it was: no restricted controls, its own mode', async () => {
    const { agent, adapter, spawned } = setup(handshake(), { ...ROLES_PROFILE, restricted: { ...ROLES_PROFILE.restricted!, privateCwd: true } });
    await adapter.start(taskStart('auto', { flags: resolveTaskRunnerFlags(ROLES_MANIFEST, { mode: 'auto' }) }));
    expect(spawned.lastArgs()).toEqual(['--acp', '--allow-all-tools']);
    expect(spawned.lastEnv().FAKE_ALLOW_ALL).toBeUndefined();
    expect(spawned.lastCwd()).toBe('/repo');
    expect((agent.requests('session/new')[0].params as { cwd: string }).cwd).toBe('/repo');
  });

  it('answers every request of a read-only task itself, by what the agent says the call does', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      ask('edit', 'c-edit', { locations: [{ path: '/repo/a.ts' }] }),
      ask('delete', 'c-delete'),
      ask('move', 'c-move'),
      ask('execute', 'c-exec', { rawInput: { command: 'rm -rf .' } }),
      ask('switch_mode', 'c-mode'),
      ask('think', 'c-think'),
      ask('read', 'c-read-in', { locations: [{ path: '/repo/src/a.ts' }] }),
      ask('read', 'c-read-ws', { locations: [{ path: '/ws/notes.md' }] }),
      ask('read', 'c-read-out', { locations: [{ path: '/etc/hosts' }] }),
      ask('search', 'c-search'),
      ask('fetch', 'c-fetch', { rawInput: { url: 'https://example.com' } }),
      ask('other', 'c-other'),
      ask(undefined, 'c-none'),
      { request: 'session/request_permission', params: { ...requestFor('other', 'c-ordewell'), toolCall: { toolCallId: 'c-ordewell', title: 'ordewell/task_complete', kind: 'other' } } },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ], ROLES_PROFILE);
    await adapter.start(readOnlyStart({ workspaceRoot: '/ws' }));
    const events = await turn(adapter, 'go');

    expect(chosen(agent)).toEqual(['opt-c', 'opt-c', 'opt-c', 'opt-c', 'opt-c', 'opt-b', 'opt-b', 'opt-b', 'opt-c', 'opt-c', 'opt-c', 'opt-c', 'opt-c', 'opt-b']);
    const asked = events.filter((e) => e.type === 'permission_request');
    expect(asked).toHaveLength(14);
    expect(asked.every((e) => e.type === 'permission_request' && e.decided)).toBe(true);
    const note = (toolUseId: string) => {
      const found = asked.find((e) => e.type === 'permission_request' && e.toolUseId === toolUseId);
      return found?.type === 'permission_request' ? found.decided : undefined;
    };
    expect(note('c-edit')).toEqual({ decision: 'deny', note: 'Nothing may be written here: this session is read-only.' });
    expect(note('c-exec')).toEqual({ decision: 'deny', note: 'Your own shell is off here. Run commands with Ordewell\'s run_command.' });
    expect(note('c-mode')).toEqual({ decision: 'deny', note: 'This session stays in the mode it was started in.' });
    expect(note('c-fetch')).toMatchObject({ decision: 'deny', note: expect.stringContaining('unavailable on a read-only task') });
  });

  it('allows Ordewell\'s own tools by name on a planner and a read-only start whatever kind the agent gives them, and refuses a near miss of the same kind', async () => {
    const calls = (): FakeAcpStep[] => [
      ...handshake(),
      { expect: 'session/prompt' },
      ask('execute', 'c-run', { title: 'ordewell/run_command' }),
      ask('edit', 'c-plan', { title: 'ordewell/run_plan' }),
      ask('read', 'c-list', { title: 'ordewell/list_runners' }),
      ask('execute', 'c-near', { title: 'ordewell/run_commands' }),
      ask('edit', 'c-other-server', { title: 'ordewellx/run_plan' }),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ];
    for (const start of [plannerStart(), readOnlyStart()]) {
      const { agent, adapter } = setup(calls(), ROLES_PROFILE);
      await adapter.start(start);
      const events = await turn(adapter, 'go');
      const decided = events.flatMap((e) => (e.type === 'permission_request' ? [[e.toolUseId, e.decided?.decision]] : []));
      expect(decided).toEqual([['c-run', 'allow'], ['c-plan', 'allow'], ['c-list', 'allow'], ['c-near', 'deny'], ['c-other-server', 'deny']]);
      expect(chosen(agent)).toEqual(['opt-b', 'opt-b', 'opt-b', 'opt-c', 'opt-c']);
    }
  });

  it('refuses a request for the agent\'s own subagent or delegation tool by name, whatever kind it arrives as, think included (ADR-0026)', async () => {
    const delegating: AcpProfile = {
      ...ROLES_PROFILE,
      delegation: { tools: ['spawn_agent', 'send_message'], toolOf: ({ request }) => request.title?.split(':')[0] ?? null },
    };
    const calls = (): FakeAcpStep[] => [
      ...handshake(),
      { expect: 'session/prompt' },
      ask('think', 'c-spawn', { title: 'spawn_agent: look around' }),
      ask('other', 'c-send', { title: 'send_message' }),
      ask('read', 'c-spawn-read', { title: 'spawn_agent', locations: [{ path: '/repo/src/a.ts' }] }),
      ask('think', 'c-think', { title: 'update_topic' }),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ];
    for (const start of [plannerStart(), readOnlyStart()]) {
      const { agent, adapter } = setup(calls(), delegating);
      await adapter.start(start);
      const held: string[] = [];
      const decided: Array<[string | undefined, unknown]> = [];
      await adapter.send('go', (e) => {
        if (e.type !== 'permission_request') return;
        if (e.decided) decided.push([e.toolUseId, e.decided]);
        else { held.push(e.toolUseId ?? ''); adapter.answerPermission(e.id, { decision: 'allow' }); }
      });
      const refusal = { decision: 'deny', note: expect.stringContaining('No other agent may be started here') };
      expect(decided.filter(([id]) => id !== 'c-think')).toEqual([['c-spawn', refusal], ['c-send', refusal], ['c-spawn-read', refusal]]);
      expect(held).toEqual([]);
      expect(chosen(agent)).toEqual(['opt-c', 'opt-c', 'opt-c', 'opt-b']);
    }
  });

  it('judges a request by the turn\'s report of its call where the request leaves the kind out', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 'c-1', title: 'Write a.ts', kind: 'edit', status: 'pending', locations: [{ path: '/repo/a.ts' }] }) },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 'c-2', title: 'Read b.ts', kind: 'read', status: 'pending', locations: [{ path: '/repo/b.ts' }] }) },
      ask(undefined, 'c-1'),
      ask(undefined, 'c-2'),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ], ROLES_PROFILE);
    await adapter.start(readOnlyStart());
    await turn(adapter, 'go');
    expect(chosen(agent)).toEqual(['opt-c', 'opt-b']);
  });

  it('refuses a request to reach a path for a call the turn reported as a write or a command, though the request calls it a read', async () => {
    // Copilot's own words for it, from the live planner recording: the report
    // is the create, the request only the path it needs.
    const calls = (): FakeAcpStep[] => [
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 'c-1', title: 'Creating /repo/a.txt', kind: 'edit', status: 'pending', locations: [{ path: '/repo/a.txt' }] }) },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 'c-2', title: 'touch b.txt', kind: 'execute', status: 'pending' }) },
      ask('read', 'c-1', { title: 'Access paths outside trusted directories', locations: [{ path: '/repo/a.txt' }] }),
      ask('read', 'c-2', { title: 'Access paths outside trusted directories', locations: [{ path: '/repo/b.txt' }] }),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ];
    for (const start of [plannerStart(), readOnlyStart()]) {
      const { agent, adapter } = setup(calls(), ROLES_PROFILE);
      await adapter.start(start);
      const held: string[] = [];
      await adapter.send('go', (e) => {
        if (e.type !== 'permission_request' || e.decided) return;
        held.push(e.toolUseId ?? '');
        adapter.answerPermission(e.id, { decision: 'allow' });
      });
      expect(held).toEqual([]);
      expect(chosen(agent)).toEqual(['opt-c', 'opt-c']);
    }
  });

  it('refuses a planner\'s writes, commands and mode switches at once and holds its reads and fetches for the envelope, with their ask', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      ask('edit', 'c-edit'),
      ask('execute', 'c-exec'),
      ask('switch_mode', 'c-mode'),
      ask('think', 'c-think'),
      ask('read', 'c-read', { locations: [{ path: '/repo/src/a.ts' }] }),
      ask('search', 'c-search', { locations: [{ path: '/repo/src' }] }),
      ask('fetch', 'c-fetch', { rawInput: { url: 'https://example.com/doc' } }),
      ask('read', 'c-many', { locations: [{ path: '/repo/a' }, { path: '/repo/b' }] }),
      ask('other', 'c-other'),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ], ROLES_PROFILE);
    await adapter.start(plannerStart());
    const pending: Array<{ toolUseId?: string; ask?: unknown }> = [];
    await adapter.send('go', (e) => {
      if (e.type !== 'permission_request' || e.decided) return;
      pending.push({ toolUseId: e.toolUseId, ask: e.ask });
      expect(e).not.toHaveProperty('suggestions');
      expect(adapter.answerPermission(e.id, { decision: e.ask?.kind === 'path' ? 'allow' : 'deny' })).toBe(true);
    });

    expect(pending).toEqual([
      { toolUseId: 'c-read', ask: { kind: 'path', path: '/repo/src/a.ts', directory: false } },
      { toolUseId: 'c-search', ask: { kind: 'path', path: '/repo/src', directory: true } },
      { toolUseId: 'c-fetch', ask: { kind: 'fetch', url: 'https://example.com/doc' } },
      { toolUseId: 'c-many', ask: { kind: 'other' } },
      { toolUseId: 'c-other', ask: { kind: 'other' } },
    ]);
    expect(chosen(agent)).toEqual(['opt-c', 'opt-c', 'opt-c', 'opt-b', 'opt-b', 'opt-b', 'opt-c', 'opt-c', 'opt-c']);
  });

  it('puts the path a profile reads from a call\'s arguments to the planner\'s envelope, resolved where the agent runs, only for a read or a search that names one', async () => {
    // The derived paths must be on disk to be put to the envelope at all.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'acp-asked-')));
    const repo = join(base, 'repo');
    for (const dir of ['repo/src', 'etc']) mkdirSync(join(base, dir), { recursive: true });
    for (const file of ['repo/src/a.ts', 'repo/a', 'repo/b', 'etc/hosts']) writeFileSync(join(base, file), '');
    const named = (call: AcpToolCall) => {
      const input = call.rawInput as { paths?: unknown } | undefined;
      return Array.isArray(input?.paths) ? input.paths.filter((p): p is string => typeof p === 'string') : [];
    };
    const calls = (): FakeAcpStep[] => [
      ...handshake(),
      { expect: 'session/prompt' },
      ask('read', 'c-rel', { rawInput: { paths: ['src/a.ts'] } }),
      ask('search', 'c-abs', { rawInput: { paths: [`${repo}/src`] } }),
      ask('read', 'c-out', { rawInput: { paths: ['../etc/hosts'] } }),
      ask('read', 'c-many', { rawInput: { paths: [`${repo}/a`, `${repo}/b`] } }),
      ask('read', 'c-both', { rawInput: { paths: [`${repo}/a`] }, locations: [{ path: `${repo}/a` }] }),
      ask('other', 'c-other', { rawInput: { paths: [`${repo}/a`] } }),
      ask('read', 'c-missing', { rawInput: { paths: ['src/missing.ts'] } }),
      ask('read', 'c-none', { rawInput: {} }),
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ];
    const asks = async (profile: AcpProfile) => {
      const { adapter } = setup(calls(), profile);
      await adapter.start(plannerStart({ cwd: repo }));
      const pending: Array<[string | undefined, unknown]> = [];
      await adapter.send('go', (e) => {
        if (e.type !== 'permission_request' || e.decided) return;
        pending.push([e.toolUseId, e.ask]);
        adapter.answerPermission(e.id, { decision: 'deny' });
      });
      return pending;
    };

    expect(await asks({ ...ROLES_PROFILE, askedPaths: named })).toEqual([
      ['c-rel', { kind: 'path', path: join(repo, 'src', 'a.ts'), directory: false }],
      ['c-abs', { kind: 'path', path: join(repo, 'src'), directory: true }],
      ['c-out', { kind: 'path', path: join(base, 'etc', 'hosts'), directory: false }],
      ['c-many', { kind: 'other' }],
      ['c-both', { kind: 'other' }],
      ['c-other', { kind: 'other' }],
      ['c-missing', { kind: 'other', note: expect.stringContaining('not on disk') }],
      ['c-none', { kind: 'other' }],
    ]);
    // Without the hook, only the location counts.
    expect(await asks(ROLES_PROFILE)).toEqual([
      ['c-rel', { kind: 'other' }],
      ['c-abs', { kind: 'other' }],
      ['c-out', { kind: 'other' }],
      ['c-many', { kind: 'other' }],
      ['c-both', { kind: 'path', path: `${repo}/a`, directory: false }],
      ['c-other', { kind: 'other' }],
      ['c-missing', { kind: 'other' }],
      ['c-none', { kind: 'other' }],
    ]);
    rmSync(base, { recursive: true, force: true });
  });

  it('fails a read-only task that leaves the mode it started in, mid-turn, and takes no further turn', async () => {
    const { agent, adapter, spawned } = setup([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new', reply: WITH_MODES },
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('current_mode_update', { currentModeId: 'write' }) },
    ], ROLES_PROFILE);
    await adapter.start(readOnlyStart());
    const failed = 'Fake Agent left the mode it was started in ("read" to "write"), so this read-only task cannot go on.';

    expect(await turn(adapter, 'go')).toContainEqual({ type: 'error', message: failed });
    expect(spawned.processes[0].killed).toBe(true);
    expect(await turn(adapter, 'again')).toEqual([{ type: 'error', message: failed }]);
    expect(agent.requests('session/prompt')).toHaveLength(1);
  });

  it('fails a planner whose mode option moves, between turns too', async () => {
    const modes = (current: string) => [select('mode', 'mode', current, ['plan', 'build'])];
    const { agent, adapter, spawned } = setup([
      ...withOptions(modes('plan')),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('config_option_update', { configOptions: modes('plan') }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
      { notify: 'session/update', params: update('config_option_update', { configOptions: modes('build') }) },
    ], ROLES_PROFILE);
    await adapter.start(plannerStart());

    expect((await turn(adapter, 'go')).some((e) => e.type === 'error')).toBe(false);
    await expect.poll(() => spawned.processes[0].killed).toBe(true);
    expect(await turn(adapter, 'again')).toEqual([{ type: 'error', message: 'Fake Agent left the mode it was started in ("plan" to "build"), so this planner session cannot go on.' }]);
    expect(agent.requests('session/prompt')).toHaveLength(1);
  });

  it('settles a planner in the mode an update moved it to in the chunk of the session/new answer, and holds that one', async () => {
    const modes = (current: string) => [select('mode', 'mode', current, ['plan', 'build'])];
    const { adapter } = setup([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { together: [
        { answer: { sessionId: 'sess-1', configOptions: modes('plan') }, to: 'session/new' },
        { notify: 'session/update', params: update('config_option_update', { configOptions: modes('build') }) },
      ] },
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('config_option_update', { configOptions: modes('build') }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('config_option_update', { configOptions: modes('plan') }) },
    ], ROLES_PROFILE);
    await adapter.start(plannerStart());

    expect((await turn(adapter, 'go')).some((e) => e.type === 'error')).toBe(false);
    expect(await turn(adapter, 'again')).toContainEqual({ type: 'error', message: 'Fake Agent left the mode it was started in ("build" to "plan"), so this planner session cannot go on.' });
  });

  it('settles a read-only task in the mode a current_mode_update moved it to in the chunk of the session/new answer', async () => {
    const { adapter } = setup([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { together: [
        { answer: WITH_MODES, to: 'session/new' },
        { notify: 'session/update', params: update('current_mode_update', { currentModeId: 'write' }) },
      ] },
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('current_mode_update', { currentModeId: 'write' }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('current_mode_update', { currentModeId: 'read' }) },
    ], ROLES_PROFILE);
    await adapter.start(readOnlyStart());

    expect((await turn(adapter, 'go')).some((e) => e.type === 'error')).toBe(false);
    expect(await turn(adapter, 'again')).toContainEqual({ type: 'error', message: 'Fake Agent left the mode it was started in ("write" to "read"), so this read-only task cannot go on.' });
  });

  it('lets a writable task change its mode, since only a restricted start holds one', async () => {
    const { adapter, spawned } = setup([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new', reply: WITH_MODES },
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('current_mode_update', { currentModeId: 'write' }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ], ROLES_PROFILE);
    await adapter.start(taskStart('ask', { flags: resolveTaskRunnerFlags(ROLES_MANIFEST, { mode: 'ask' }) }));
    expect((await turn(adapter, 'go')).some((e) => e.type === 'error')).toBe(false);
    expect(spawned.processes[0].killed).toBe(false);
  });

  // Qwen Code 0.27.1 names the call that started a subagent in each of its updates' `_meta.parentToolCallId`.
  const spawn = (status: string) => update('tool_call_update', { toolCallId: 'p-1', title: 'agent', status });
  const fromSubagent = (fields: Record<string, unknown>) => update('tool_call', { title: 'Read a.ts', status: 'in_progress', ...fields, _meta: { parentToolCallId: 'p-1' } });
  const BACKGROUND = (role: string) => `Fake Agent started a subagent that worked on after the call that started it was over, outside Ordewell's view, so this ${role} cannot go on.`;

  it('lets a planner\'s subagent work while the call that started it is open, its calls shown as its own', async () => {
    const { adapter, spawned } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 'p-1', title: 'agent', status: 'in_progress' }) },
      { notify: 'session/update', params: fromSubagent({ toolCallId: 'c-1' }) },
      { notify: 'session/update', params: update('tool_call_update', { toolCallId: 'c-1', status: 'completed' }) },
      { notify: 'session/update', params: spawn('completed') },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ], ROLES_PROFILE);
    await adapter.start(plannerStart());
    const events = await turn(adapter, 'go');
    expect(events).toContainEqual({ type: 'tool_call', id: 'c-1', name: 'Read a.ts', args: {}, subagentId: 'p-1' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(spawned.processes[0].killed).toBe(false);
  });

  it('fails a planner whose subagent works on after the call that started it, mid-turn, and takes no further turn', async () => {
    const { agent, adapter, spawned } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 'p-1', title: 'agent', status: 'in_progress' }) },
      { notify: 'session/update', params: spawn('completed') },
      { notify: 'session/update', params: fromSubagent({ toolCallId: 'c-1' }) },
    ], ROLES_PROFILE);
    await adapter.start(plannerStart());

    const events = await turn(adapter, 'go');
    expect(events).toContainEqual({ type: 'error', message: BACKGROUND('planner session') });
    expect(events.some((e) => e.type === 'tool_call' && e.id === 'c-1')).toBe(false);
    expect(spawned.processes[0].killed).toBe(true);
    expect(await turn(adapter, 'again')).toEqual([{ type: 'error', message: BACKGROUND('planner session') }]);
    expect(agent.requests('session/prompt')).toHaveLength(1);
  });

  it('fails a read-only task whose subagent is still working when its turn is answered, in place of the turn\'s end', async () => {
    const { adapter, spawned } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 'p-1', title: 'agent', status: 'in_progress' }) },
      { notify: 'session/update', params: fromSubagent({ toolCallId: 'c-1' }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ], ROLES_PROFILE);
    await adapter.start(readOnlyStart());

    const events = await turn(adapter, 'go');
    expect(events[events.length - 1]).toEqual({ type: 'error', message: BACKGROUND('read-only task') });
    expect(events.some((e) => e.type === 'turn_end')).toBe(false);
    expect(spawned.processes[0].killed).toBe(true);
  });

  it('fails a planner whose subagent reports after the turn, and takes no further turn', async () => {
    const { adapter, spawned } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 'p-1', title: 'agent', status: 'completed' }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
      { notify: 'session/update', params: fromSubagent({ toolCallId: 'c-1' }) },
    ], ROLES_PROFILE);
    await adapter.start(plannerStart());

    expect((await turn(adapter, 'go')).some((e) => e.type === 'error')).toBe(false);
    await expect.poll(() => spawned.processes[0].killed).toBe(true);
    expect(await turn(adapter, 'again')).toEqual([{ type: 'error', message: BACKGROUND('planner session') }]);
  });

  it('lets a writable task\'s subagent work on, since only a restricted start is held to its turn', async () => {
    const { adapter, spawned } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'session/update', params: update('tool_call', { toolCallId: 'p-1', title: 'agent', status: 'completed' }) },
      { notify: 'session/update', params: fromSubagent({ toolCallId: 'c-1' }) },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ], ROLES_PROFILE);
    await adapter.start(taskStart('ask', { flags: resolveTaskRunnerFlags(ROLES_MANIFEST, { mode: 'ask' }) }));
    expect((await turn(adapter, 'go')).some((e) => e.type === 'error')).toBe(false);
    expect(spawned.processes[0].killed).toBe(false);
  });

  it('fails a restricted start whose agent sends a notice its profile names as a subagent\'s, and leaves a writable start\'s alone', async () => {
    const noticing: AcpProfile = { ...ROLES_PROFILE, delegation: { tools: [], toolOf: () => null, notices: ['x/subagent_done'] } };
    const steps = (): FakeAcpStep[] => [
      ...handshake(),
      { expect: 'session/prompt' },
      { notify: 'x/subagent_done', params: { toolCallId: 's-1', subagentType: 'explore' } },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ];
    const NOTICED = (role: string) => `Fake Agent started a subagent, which this start withholds, so this ${role} cannot go on.`;
    for (const [start, role] of [[plannerStart(), 'planner session'], [readOnlyStart(), 'read-only task']] as const) {
      const { adapter, spawned } = setup(steps(), noticing);
      await adapter.start(start);
      expect(await turn(adapter, 'go')).toContainEqual({ type: 'error', message: NOTICED(role) });
      expect(spawned.processes[0].killed).toBe(true);
      expect(await turn(adapter, 'again')).toEqual([{ type: 'error', message: NOTICED(role) }]);
    }
    const { adapter, spawned } = setup(steps(), noticing);
    await adapter.start(taskStart('ask', { flags: resolveTaskRunnerFlags(ROLES_MANIFEST, { mode: 'ask' }) }));
    expect((await turn(adapter, 'go')).some((e) => e.type === 'error')).toBe(false);
    expect(spawned.processes[0].killed).toBe(false);
  });

  it('fails a read-only task the agent will not put on the plan\'s model, where a writable one is only told (#13)', async () => {
    const steps = (): FakeAcpStep[] => [
      ...withOptions([select('model', 'model', 'm-0', ['m-0', 'm-1'])]),
      { expect: 'session/set_config_option', reply: { configOptions: [select('model', 'model', 'm-0', ['m-0', 'm-1'])] } },
    ];
    const readOnly = setup(steps(), ROLES_PROFILE);
    await expect(readOnly.adapter.start(readOnlyStart({ model: 'm-1' }))).rejects.toThrow('Fake Agent did not take the model "m-1": it is on "m-0".');
    const planner = setup(steps(), ROLES_PROFILE);
    await expect(planner.adapter.start(plannerStart({ model: 'm-1' }))).resolves.toBeUndefined();
  });

  it('puts a planner on its own effort, and fails one the agent has no setting for', async () => {
    const efforts = (current: string) => [select('reasoning', 'thought_level', current, ['low', 'high'])];
    const set = setup([...withOptions(efforts('low')), { expect: 'session/set_config_option', reply: { configOptions: efforts('high') } }], ROLES_PROFILE);
    await set.adapter.start(plannerStart({ effort: 'high' }));
    expect(set.agent.requests('session/set_config_option').map((m) => m.params)).toEqual([{ sessionId: 'sess-1', configId: 'reasoning', value: 'high' }]);

    const none = setup(handshake(), ROLES_PROFILE);
    await expect(none.adapter.start(plannerStart({ effort: 'high' }))).rejects.toThrow('Fake Agent offers no effort setting, so it cannot plan on the effort "high".');
  });
});

describe('AcpAdapter restricted start\'s own files (ADR-0060, R3)', () => {
  /** Where the agent of this test reads its hook settings, the way Qwen Code reads a system settings file a variable names. */
  const HOOK_SETTINGS = 'FAKE_HOOK_SETTINGS';
  const DENY = 'printf \'{"decision":"deny"}\'\n';
  const HOOKED: AcpProfile = {
    ...ROLES_PROFILE,
    restricted: {
      ...ROLES_PROFILE.restricted!,
      privateCwd: true,
      files: [
        { fileName: 'deny.sh', render: () => DENY },
        { fileName: 'hooks.json', render: (dir) => hooksJson(dir), pass: { env: HOOK_SETTINGS } },
      ],
    },
  };
  /** The hook settings as JSON writes them, so a Windows path's backslashes are escaped there as they are in the file. */
  function hooksJson(dir: string): string {
    return JSON.stringify({ PreToolUse: [{ command: `sh ${join(dir, 'deny.sh')}` }] });
  }
  const LOADS: FakeAcpAgentOptions = { loads: [HOOK_SETTINGS] };

  /** A temp directory of this test's own, so what is written there, and swept from it, is only this test's. */
  let temp = '';
  beforeEach(() => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'acp-restricted-test-')));
    for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, temp);
    // A host that is itself an OpenCode runner's child carries its parent's
    // config, which the spawn rewrites to strip that parent's server (ADR-0022
    // A5). That rewrite is runnerEnv's test, not this one's: here the host
    // environment is held still so "what the spawn adds" means only that.
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(temp, { recursive: true, force: true });
  });

  it('starts a planner and a read-only task with the profile\'s files owner-only in its private directory, outside the worktree, where its variables name them', async () => {
    for (const start of [plannerStart(), readOnlyStart()]) {
      const { adapter, agent, spawned } = setup(handshake(), HOOKED, {}, {}, LOADS);
      await adapter.start(start);

      const dir = spawned.lastCwd()!;
      expect(dirname(dir)).toBe(temp);
      const settings = join(dir, 'hooks.json');
      expect(spawned.lastEnv()[HOOK_SETTINGS]).toBe(settings);
      expect(agent.loaded).toEqual([{ env: HOOK_SETTINGS, path: settings, found: hooksJson(dir) }]);
      expect(readFileSync(join(dir, 'deny.sh'), 'utf8')).toBe(DENY);
      expect(readdirSync(dir).sort()).toEqual(['deny.sh', 'hooks.json']);
      if (POSIX_MODES) {
        for (const name of ['deny.sh', 'hooks.json']) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
      adapter.dispose();
    }
  });

  it('names a file the profile passes by flag in the arguments, after the restriction\'s own', async () => {
    const flagged: AcpProfile = {
      ...ROLES_PROFILE,
      restricted: { ...ROLES_PROFILE.restricted!, files: [{ fileName: 'settings.json', render: () => '{"deny":["write"]}', pass: { flag: '--settings' } }] },
    };
    const { adapter, spawned } = setup(handshake(), flagged);
    await adapter.start(plannerStart());

    const args = spawned.lastArgs();
    const path = args[args.length - 1];
    expect(args).toEqual([...ROLES_PROFILE.args, ...ROLES_PROFILE.restricted!.args, '--settings', path]);
    expect(dirname(dirname(path))).toBe(temp);
    expect(readFileSync(path, 'utf8')).toBe('{"deny":["write"]}');
    if (POSIX_MODES) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('renders a file from the private directory\'s path alone, so neither the attempt\'s token nor its provider credential can reach one', async () => {
    const render = vi.fn((dir: string) => `hook in ${dir}`);
    const credentialed: AcpProfile = {
      ...HOOKED,
      credentials: async () => ({ FAKE_PROVIDER_KEY: 'sk-provider-secret' }),
      restricted: { ...HOOKED.restricted!, files: [{ fileName: 'hooks.json', render, pass: { env: HOOK_SETTINGS } }] },
    };
    const { adapter, spawned } = setup(handshake(), credentialed);
    await adapter.start(readOnlyStart());

    const dir = spawned.lastCwd()!;
    expect(render.mock.calls).toEqual([[dir]]);
    expect(spawned.lastEnv().FAKE_PROVIDER_KEY).toBe('sk-provider-secret');
    for (const name of readdirSync(dir)) {
      const contents = readFileSync(join(dir, name), 'utf8');
      expect(contents).not.toContain(TOKEN);
      expect(contents).not.toContain('sk-provider-secret');
    }
  });

  it('points each of the profile\'s config variables at an empty owner-only directory of the start\'s own, so the user\'s global configuration does not load', async () => {
    const homes: AcpProfile = { ...ROLES_PROFILE, restricted: { ...ROLES_PROFILE.restricted!, configDirs: ['FAKE_HOME', 'FAKE_HOOKS_DIR'] } };
    const { adapter, agent, spawned } = setup(handshake(), homes, {}, {}, { loads: ['FAKE_HOME', 'FAKE_HOOKS_DIR'] });
    await adapter.start(readOnlyStart());

    const [home, hooks] = [spawned.lastEnv().FAKE_HOME ?? '', spawned.lastEnv().FAKE_HOOKS_DIR ?? ''];
    expect(agent.loaded).toEqual([{ env: 'FAKE_HOME', path: home, found: [] }, { env: 'FAKE_HOOKS_DIR', path: hooks, found: [] }]);
    expect(home).not.toBe(hooks);
    expect(dirname(home)).toBe(dirname(hooks));
    expect(dirname(dirname(home))).toBe(temp);
    if (POSIX_MODES) for (const path of [home, hooks]) expect(statSync(path).mode & 0o777).toBe(0o700);
    // Without privateCwd the agent still starts in the worktree.
    expect(spawned.lastCwd()).toBe('/repo');
  });

  it('removes the files and the config directories with the process', async () => {
    const homes: AcpProfile = { ...HOOKED, restricted: { ...HOOKED.restricted!, configDirs: ['FAKE_HOME'] } };
    const { adapter, agent, spawned } = setup(handshake(), homes);
    await adapter.start(readOnlyStart());
    const dir = spawned.lastCwd()!;
    // What the agent keeps in its home of configuration goes too.
    writeFileSync(join(spawned.lastEnv().FAKE_HOME ?? '', 'state.json'), '{}');
    expect(readdirSync(temp)).toEqual([basename(dir)]);

    await agent.close(0);
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
    expect(readdirSync(temp)).toEqual([]);
  });

  it('sweeps at a restricted start what an Ordewell that died left of an earlier one', async () => {
    // A process that has exited, so its id is one no running Ordewell holds.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const leftover = join(temp, `ordewell-acp-${dead}-AbC123`);
    mkdirSync(join(leftover, 'FAKE_HOME', 'data'), { recursive: true, mode: 0o700 });
    writeFileSync(join(leftover, 'FAKE_HOME', 'data', 'state.json'), '{}', { mode: 0o600 });
    writeFileSync(join(leftover, 'hooks.json'), '{}', { mode: 0o600 });
    const running = join(temp, `ordewell-acp-${process.pid}-XyZ789`);
    mkdirSync(running, { mode: 0o700 });

    const { adapter, spawned } = setup(handshake(), HOOKED);
    await adapter.start(readOnlyStart());

    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(running)).toBe(true);
    expect(readdirSync(temp).sort()).toEqual([basename(running), basename(spawned.lastCwd()!)].sort());
  });

  it('gives two attempts running at once a private directory each, and ending one leaves the other\'s', async () => {
    const a = setup(handshake(), HOOKED, {}, {}, LOADS);
    const b = setup(handshake(), HOOKED, {}, {}, LOADS);
    await Promise.all([a.adapter.start(readOnlyStart()), b.adapter.start(plannerStart())]);

    const [dirA, dirB] = [a.spawned.lastCwd()!, b.spawned.lastCwd()!];
    expect(dirA).not.toBe(dirB);
    expect([a.agent.loaded[0].found, b.agent.loaded[0].found]).toEqual([hooksJson(dirA), hooksJson(dirB)]);
    expect([a.spawned.lastEnv()[HOOK_SETTINGS], b.spawned.lastEnv()[HOOK_SETTINGS]]).toEqual([join(dirA, 'hooks.json'), join(dirB, 'hooks.json')]);

    await a.agent.close(0);
    await vi.waitFor(() => expect(existsSync(dirA)).toBe(false));
    expect(readdirSync(dirB).sort()).toEqual(['deny.sh', 'hooks.json']);
  });

  it('leaves a writable task without them: the files are a restricted start\'s alone', async () => {
    const homes: AcpProfile = { ...HOOKED, restricted: { ...HOOKED.restricted!, configDirs: ['FAKE_HOME'] } };
    const { adapter, spawned } = setup(handshake(), homes);
    await adapter.start(taskStart('auto', { flags: resolveTaskRunnerFlags(ROLES_MANIFEST, { mode: 'auto' }) }));

    expect(spawned.lastEnv()[HOOK_SETTINGS]).toBeUndefined();
    expect(spawned.lastEnv().FAKE_HOME).toBeUndefined();
    expect(spawned.lastCwd()).toBe('/repo');
    expect(readdirSync(temp)).toEqual([]);
  });

  it('still refuses a write and a command by their kind, under the files: they are a layer under the adapter\'s refusal, not in place of it', async () => {
    for (const start of [plannerStart(), readOnlyStart()]) {
      const { agent, adapter } = setup([
        ...handshake(),
        { expect: 'session/prompt' },
        ask('edit', 'c-edit', { locations: [{ path: '/repo/a.ts' }] }),
        ask('execute', 'c-exec', { rawInput: { command: 'touch b.txt' } }),
        { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
      ], HOOKED);
      await adapter.start(start);
      const events = await turn(adapter, 'go');

      expect(chosen(agent)).toEqual(['opt-c', 'opt-c']);
      expect(events.flatMap((e) => (e.type === 'permission_request' ? [e.decided] : []))).toEqual([
        { decision: 'deny', note: 'Nothing may be written here: this session is read-only.' },
        { decision: 'deny', note: 'Your own shell is off here. Run commands with Ordewell\'s run_command.' },
      ]);
    }
  });

  it('refuses a restricted start that hands files or config directories where a placement would run it, since their paths are this machine\'s', async () => {
    const profiles: AcpProfile[] = [
      { ...ROLES_PROFILE, restricted: { ...ROLES_PROFILE.restricted!, files: [{ fileName: 'hooks.json', render: () => '{}', pass: { env: HOOK_SETTINGS } }] } },
      { ...ROLES_PROFILE, restricted: { ...ROLES_PROFILE.restricted!, configDirs: ['FAKE_HOME'] } },
    ];
    for (const profile of profiles) {
      for (const [start, refusal] of [[plannerStart(), /cannot plan in a container/], [readOnlyStart(), /cannot run a read-only task in a container/]] as const) {
        const place = vi.fn();
        const { adapter, spawned } = setup(handshake(), profile, {}, { placement: { cwd: '/work', place, reach: async (url) => url, blob: async () => undefined } });
        await expect(adapter.start(start)).rejects.toThrow(refusal);
        expect(place).not.toHaveBeenCalled();
        expect(spawned.processes).toHaveLength(0);
      }
    }
    expect(readdirSync(temp)).toEqual([]);
  });

  it('starts Copilot, whose profile hands no such files, as before: its flags, its instructions and its temp directory, nothing more', async () => {
    const copilotStarts = [
      plannerStart(),
      taskStart('plan', { flags: resolveTaskRunnerFlags(COPILOT_CLI_MANIFEST, { mode: 'plan' }) }),
    ];
    for (const start of copilotStarts) {
      const { adapter, spawned } = setup(handshake({ ...INITIALIZED, agentInfo: { name: 'Copilot', version: '1.0.105' } }), COPILOT_CLI_PROFILE);
      await adapter.start(start);

      const dir = spawned.lastCwd()!;
      expect(spawned.lastCommand()).toBe('copilot');
      expect(spawned.lastArgs()).toEqual(['--acp', '--stdio', '--deny-tool=write', '--deny-tool=shell', '--deny-tool=url', '--disable-builtin-mcps', '--excluded-tools', expect.stringContaining('task,')]);
      // What the spawn adds to, or changes in, the environment it inherits; PATH
      // is the host's, under the host's own spelling (Windows names it `Path`).
      const added = Object.entries(spawned.lastEnv()).filter(([name, value]) => name.toUpperCase() !== 'PATH' && process.env[name] !== value);
      expect(Object.fromEntries(added)).toEqual({ COPILOT_ALLOW_ALL: 'false', TMPDIR: dir, TMP: dir, TEMP: dir });
      expect(dirname(dir)).toBe(temp);
      expect(readdirSync(dir)).toEqual(['AGENTS.md']);
      adapter.dispose();
    }
  });
});

describe('AcpAdapter through CliAgentAiService', () => {
  // The service picks a runner's planner by its connector, and an ACP
  // connector plans only once its profile claims the role; one that does is
  // stood in for a planner the registry already knows.
  it('plans on Ordewell\'s tools: the envelope decides a read, the adapter refuses an edit, and submit_plan is the plan', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'acp-plan-')));
    writeFileSync(join(workspace, 'README.md'), '# App\n');
    const server = new OrdewellMcpServer();
    servers.push(server);
    const tasks = (JSON.parse(planJson('opencode')) as { tasks: unknown[] }).tasks;
    const read = { ...permissionParams('Read README.md', 'call-read'), toolCall: { toolCallId: 'call-read', title: 'Read README.md', kind: 'read', locations: [{ path: join(workspace, 'README.md') }] } };
    const spawned = fakeAcpSpawn([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { run: async (agent) => { await agent.listMcpTools(); } },
      { answer: { sessionId: 'sess-1' }, to: 'session/new' },
      { expect: 'session/prompt' },
      { request: 'session/request_permission', params: read },
      { request: 'session/request_permission', params: permissionParams('Write src/a.ts', 'call-edit') },
      { callMcp: { tool: 'submit_plan', args: { tasks } } },
      { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    ]);
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'opencode' }), {
      spawn: spawned.spawn,
      createAdapter: (_runner, deps) => new AcpAdapter(deps, ROLES_PROFILE),
      resolvePath: async () => '/usr/bin',
      platform: 'linux',
      isDirectory: () => true,
      exists: () => true,
      workspaceRoot: () => workspace,
      mcpServer: server,
    });
    try {
      // A one-shot plan ends its process itself.
      const planned = await svc.generatePlanDirect('Add the thing', ['opencode']);

      expect(planned.map((task) => task.title)).toEqual(['Add the thing']);
      expect(spawned.agent.answers.map((a) => a.result)).toEqual([
        { outcome: { outcome: 'selected', optionId: 'opt-b' } },
        { outcome: { outcome: 'selected', optionId: 'opt-c' } },
      ]);
      expect(spawned.lastArgs()).toEqual(['--acp', '--deny-tool=write', '--deny-tool=shell']);
      expect(spawned.lastEnv().FAKE_ALLOW_ALL).toBe('false');
      expect(spawned.agent.problems).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
