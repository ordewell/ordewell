import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpAdapter } from '../harness/AcpAdapter';
import { acpConnector, type AcpProfile } from '../harness/acpProfiles';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import type { AgentEvent, AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { ACP_ERROR, type AcpToolCall } from '../harness/acpSchema';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { StructuredRunner } from '../StructuredRunner';
import { OrdewellMcpServer, mcpClientConfig, type McpClientConfig } from '../mcp';
import type { TaskCompleteArgs } from '../mcp';
import { McpAttachTimeout, spawnAttached } from '../harness/ordewellBinding';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';
import type { FakeSpawnOptions } from './harnessTestKit';

/**
 * The ACP connector's task core (#73, slice S3/S4) against the scripted ACP
 * agent. The wire shapes are ACP v1's, as `acpSchema.ts` vendors them; the
 * words a person reads are the design's (#5, section 4).
 */

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

/** Names an Ordewell call by a title the test agent gives it; a real profile records its agent's own. */
const PROFILE: AcpProfile = {
  manifest: MANIFEST,
  args: ['--acp'],
  ordewellTool: (call: AcpToolCall) => (call.title?.startsWith('ordewell/') ? call.title.slice('ordewell/'.length) : null),
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

function setup(steps: FakeAcpStep[], profile: AcpProfile = PROFILE, options: FakeSpawnOptions = {}) {
  const spawned = fakeAcpSpawn(steps, options);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
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
    await expect(adapter.start(taskStart())).rejects.toThrow('Fake Agent is not signed in. Run `fake-agent login`.');
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

  it('does not yet start as a planner or a read-only task', async () => {
    const planner = setup(handshake());
    await expect(planner.adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan', mcp: MCP })).rejects.toThrow(/Fake Agent cannot plan/);
    const readOnly = setup(handshake());
    const flags = { ...resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }), readOnly: true as const };
    await expect(readOnly.adapter.start(taskStart('ask', { flags }))).rejects.toThrow(/Fake Agent cannot run a read-only task/);
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
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
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
    expect(await turn(adapter, 'two')).toEqual([{ type: 'error', message: 'Fake Agent is not signed in. Run `fake-agent login`.' }]);
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
      { run: () => spawned.processes[0].emitStdout(`${JSON.stringify({ jsonrpc: '2.0', method: '$/cancel_request', params: { id: 77 } })}\n`) },
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

describe('acpConnector', () => {
  it('is the profile\'s adapter and binding, with no repository config of its own', () => {
    const connector = acpConnector({ ...PROFILE, promptCacheTtlMs: 1000 });
    expect(connector.create({} as AgentProcessDeps)).toBeInstanceOf(AcpAdapter);
    expect(connector.repoConfig.instructions('/repo')).toEqual([]);
    expect(connector.repoConfig.projectServers('/repo')).toEqual({ servers: [], unreadable: [] });
    expect(connector.promptCacheTtlMs).toBe(1000);
    expect(connector.ordewellTools.toolNames('task')).toContain('task_complete');
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
    expect(binding.isOrdewellAsk(call('ordewell/task_complete'))).toBe(true);
    expect(binding.isOrdewellAsk(call('ordewell/read'))).toBe(true);
    expect(binding.isOrdewellAsk(call('ordewell/task_complete_now'))).toBe(false);
    expect(binding.isOrdewellAsk(call('ordewell/'))).toBe(false);
    expect(binding.isOrdewellAsk(call('task_complete'))).toBe(false);
  });

  it('reads the attach states', () => {
    expect(binding.attachState('connected')).toBe('connected');
    expect(binding.attachState('failed')).toBe('failed');
    expect(binding.attachState('pending')).toBe('pending');
    expect(binding.attachState(undefined)).toBe('pending');
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
    await expect(adapter.start(taskStart('ask', { resumeSessionId: 'sess-old' }))).rejects.toThrow('Fake Agent is not signed in. Run `fake-agent login`.');
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
