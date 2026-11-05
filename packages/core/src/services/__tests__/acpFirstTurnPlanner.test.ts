import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AcpAdapter } from '../harness/AcpAdapter';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { CONNECTORS } from '../harness/connectors';
import { acpConnector, type AcpProfile } from '../harness/acpProfiles';
import { McpAttachTimeout } from '../harness/ordewellBinding';
import type { ConversationRequest } from '../AiService';
import type { ResearchProgress } from '../../models/Task';
import type { RunnerManifest } from '../../plugins/types';
import { OrdewellMcpServer } from '../mcp';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';
import { planJson } from './harnessTestKit';
import { fakeConfig, fakeFileSystem } from '../../testing';

/**
 * A planner on an ACP agent that reaches Ordewell's server only once a prompt
 * runs (ADR-0060, R5): its first turn is the attach check, through the
 * service's own conversation and one-shot paths, against the scripted agent.
 */

const MANIFEST: RunnerManifest = {
  name: 'fake-acp',
  displayName: 'Fake Agent',
  runner: { command: 'fake-agent' },
  features: { modeSettings: { approvals: { auto: 'auto' } } },
  modelDiscovery: { method: 'hardcoded', models: [] },
  modes: [
    { id: 'ask', label: 'Ask', description: 'Asks before it acts.', safe: true },
    { id: 'look', label: 'Read-only', description: 'Reads only.', readOnly: true },
  ],
  auth: { statusArgs: ['status'], loginArgs: ['login'] },
} as RunnerManifest;

/** A planner whose agent reaches the server as `session/new` opens, as Copilot's does. */
const SESSION_NEW: AcpProfile = {
  manifest: MANIFEST,
  args: ['--acp'],
  ordewellTool: ({ request, report }) => {
    const title = (report ?? request).title;
    return title?.startsWith('ordewell/') ? title.slice('ordewell/'.length) : null;
  },
  instructions: { kind: 'prompt' },
  roles: { plans: true, readOnly: true },
  restricted: { args: ['--deny-tool=write', '--deny-tool=shell'] },
  attachTimeoutMs: 300,
};

/** The same planner on an agent that connects only once a prompt runs, as Cline's does. */
const FIRST_TURN: AcpProfile = { ...SESSION_NEW, attach: 'firstTurn', attachTimeoutMs: 2_000 };

const INITIALIZED = {
  protocolVersion: 1,
  agentCapabilities: { mcpCapabilities: { http: true }, loadSession: true },
  agentInfo: { name: 'fake-agent', version: '1.4.0' },
};

const handshake = (): FakeAcpStep[] => [
  { expect: 'initialize', reply: INITIALIZED },
  { expect: 'session/new', reply: { sessionId: 'sess-1' } },
];

const said = (value: string): FakeAcpStep => ({
  notify: 'session/update',
  params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } },
});

const endTurn: FakeAcpStep = { answer: { stopReason: 'end_turn' }, to: 'session/prompt' };

/** An agent that answers its first prompt without ever reaching the server. */
const withoutTools = () => fakeAcpSpawn([...handshake(), { expect: 'session/prompt' }, said('Planning without tools.'), endTurn]);

type Agent = ReturnType<typeof fakeAcpSpawn>;

const promptText = (agent: Agent['agent']) =>
  agent.requests('session/prompt').map((r) => JSON.stringify((r.params as { prompt: unknown }).prompt));

const OPENCODE = CONNECTORS.opencode;
const servers: OrdewellMcpServer[] = [];
const workspaces: string[] = [];
afterEach(async () => {
  Object.assign(CONNECTORS, { opencode: OPENCODE });
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The service on `profile`, whose spawns are `agents` in order. It reads how
 * its runner attaches from that runner's connector, so `opencode`'s stands in
 * for the profile's for the test.
 */
function plannerOver(profile: AcpProfile, agents: Agent[]) {
  Object.assign(CONNECTORS, { opencode: acpConnector(profile) });
  const server = new OrdewellMcpServer();
  servers.push(server);
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'acp-first-turn-')));
  workspaces.push(workspace);
  let spawns = 0;
  const spawn: Agent['spawn'] = (...args) => {
    const next = agents[spawns++];
    if (!next) throw new Error('spawned more often than the test has agents');
    return next.spawn(...args);
  };
  const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'opencode' }), {
    spawn,
    createAdapter: (_runner, deps) => new AcpAdapter(deps, profile),
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
    workspaceRoot: () => workspace,
    mcpServer: server,
  });
  return { svc, server, workspace, spawns: () => spawns };
}

function request(progress: ResearchProgress[], overrides: Partial<ConversationRequest> = {}): ConversationRequest {
  return {
    goal: 'Add a cache layer',
    runners: ['opencode'],
    modelsByRunner: { opencode: [] },
    fs: fakeFileSystem(),
    onProgress: (p) => progress.push(p),
    plannerTools: { sessionId: 's1', handler: {} },
    ...overrides,
  };
}

/** What a surface heard of the reply. */
const heard = (progress: ResearchProgress[]) =>
  progress.filter((p) => p.type === 'text_delta').map((p) => p.text ?? '').join('');

describe('a planner attached on its first turn (ADR-0060, R5)', () => {
  it('sends the goal as the first turn, and keeps that turn once it reached the server', async () => {
    const agent = fakeAcpSpawn([
      ...handshake(),
      { expect: 'session/prompt' },
      said('Connecting my tools. '),
      { run: async (a) => { await a.listMcpTools(); } },
      said('Here is how I would split it.'),
      endTurn,
      { expect: 'session/prompt' },
      said('And the tests go last.'),
      endTurn,
    ]);
    const { svc, spawns } = plannerOver(FIRST_TURN, [agent]);
    const progress: ResearchProgress[] = [];

    const turn = await svc.startConversation(request(progress));

    expect(turn).toMatchObject({ kind: 'message', text: 'Connecting my tools. Here is how I would split it.' });
    expect(turn).not.toHaveProperty('failed', true);
    // What it said before the server was reached is held until it was, then heard once.
    expect(heard(progress)).toBe('Connecting my tools. Here is how I would split it.');
    expect(promptText(agent.agent)).toHaveLength(1);
    expect(promptText(agent.agent)[0]).toContain('Add a cache layer');
    expect(svc.hasActiveConversation()).toBe(true);

    // The next message goes to the same process: it is attached now.
    const next = await svc.continueConversation('And the tests?', () => {});
    expect(next).toMatchObject({ kind: 'message', text: 'And the tests go last.' });
    expect(promptText(agent.agent)).toHaveLength(2);
    expect(spawns()).toBe(1);
    expect(agent.agent.problems).toEqual([]);
    svc.reset();
  });

  it('plans in a one-shot whose only turn reached the server', async () => {
    const tasks = (JSON.parse(planJson('opencode')) as { tasks: unknown[] }).tasks;
    const agent = fakeAcpSpawn([
      ...handshake(),
      { expect: 'session/prompt' },
      { callMcp: { tool: 'submit_plan', args: { tasks } } },
      endTurn,
    ]);
    const { svc, server } = plannerOver(FIRST_TURN, [agent]);

    const planned = await svc.generatePlanDirect('Add the thing', ['opencode']);

    expect(planned.map((task) => task.title)).toEqual(['Add the thing']);
    expect(promptText(agent.agent)).toHaveLength(1);
    expect(agent.agent.problems).toEqual([]);
    // A one-shot leaves nothing behind.
    expect(agent.processes[0].killed).toBe(true);
    expect(server.heldTokens()).toEqual([]);
  });

  it('discards a goal turn that never reached the server, and fails with the attach failure, leaving nothing running', async () => {
    const agents = [withoutTools(), withoutTools()];
    const { svc, server } = plannerOver(FIRST_TURN, agents);
    const progress: ResearchProgress[] = [];
    const began = Date.now();

    const failed = svc.startConversation(request(progress));

    await expect(failed).rejects.toBeInstanceOf(McpAttachTimeout);
    await expect(failed).rejects.toHaveProperty('message', expect.stringMatching(
      /^Could not start the opencode planner with Ordewell's tools\. First spawn: opencode did not report Ordewell's MCP server connected.*\. Respawn: /,
    ));
    // Each turn's end settled its check: neither waited out the attach timeout.
    expect(Date.now() - began).toBeLessThan(FIRST_TURN.attachTimeoutMs!);
    expect(agents.map(({ agent }) => promptText(agent).length)).toEqual([1, 1]);
    expect(agents.map(({ agent }) => promptText(agent)[0])).toEqual([expect.stringContaining('Add a cache layer'), expect.stringContaining('Add a cache layer')]);
    expect(agents.map(({ processes }) => processes[0].killed)).toEqual([true, true]);
    expect(server.heldTokens()).toEqual([]);
    // Nothing of a discarded turn is heard, and no conversation was started.
    expect(heard(progress)).toBe('');
    expect(svc.hasActiveConversation()).toBe(false);
  });

  it('ends a goal turn stopped during its check as stopped, without respawning to send the goal again', async () => {
    // The agent takes the prompt and is still thinking when the user stops it.
    const agents = [fakeAcpSpawn([...handshake(), { expect: 'session/prompt' }]), withoutTools()];
    const { svc, server, spawns } = plannerOver(FIRST_TURN, agents);
    const progress: ResearchProgress[] = [];
    const stop = new AbortController();

    const turn = svc.startConversation(request(progress, { signal: stop.signal }));
    await vi.waitFor(() => expect(promptText(agents[0].agent)).toHaveLength(1));
    stop.abort();

    await expect(turn).resolves.toMatchObject({ kind: 'message', aborted: true });
    expect(spawns()).toBe(1);
    expect(agents[0].processes[0].killed).toBe(true);
    expect(server.heldTokens()).toEqual([]);
    expect(heard(progress)).toBe('');
    svc.reset();
  });

  it('takes a saved session up on its first turn, saying only what that session has not heard', async () => {
    const agent = fakeAcpSpawn([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/load', reply: { sessionId: 'sess-1' } },
      { expect: 'session/prompt' },
      { run: async (a) => { await a.listMcpTools(); } },
      said('Picking up where we were.'),
      endTurn,
    ]);
    const { svc, workspace } = plannerOver(FIRST_TURN, [agent]);
    const progress: ResearchProgress[] = [];

    const turn = await svc.startConversation(request(progress, {
      initialMessage: 'Now add tests.',
      resume: { session: { runner: 'opencode', sessionId: 'sess-1', cwd: workspace }, since: [] },
    }));

    expect(turn).toMatchObject({ kind: 'message', text: 'Picking up where we were.' });
    expect(agent.agent.requests('session/load')).toHaveLength(1);
    expect(agent.agent.requests('session/new')).toHaveLength(0);
    expect(promptText(agent.agent)).toHaveLength(1);
    expect(promptText(agent.agent)[0]).toContain('Now add tests.');
    expect(agent.agent.problems).toEqual([]);
    svc.reset();
  });
});

describe('a planner attached as its session opens (ADR-0060, R5)', () => {
  it('never sends the goal to an agent that did not reach the server, as before', async () => {
    const agents = [fakeAcpSpawn(handshake()), fakeAcpSpawn(handshake())];
    const { svc, server } = plannerOver(SESSION_NEW, agents);
    const progress: ResearchProgress[] = [];

    const failed = svc.startConversation(request(progress));

    await expect(failed).rejects.toBeInstanceOf(McpAttachTimeout);
    await expect(failed).rejects.toHaveProperty('message', expect.stringMatching(/^Could not start the opencode planner with Ordewell's tools\. First spawn: /));
    expect(agents.map(({ agent }) => promptText(agent).length)).toEqual([0, 0]);
    expect(agents.map(({ processes }) => processes[0].killed)).toEqual([true, true]);
    expect(server.heldTokens()).toEqual([]);
    expect(svc.hasActiveConversation()).toBe(false);
  });

  it('sends the goal only once the server was reached as the session opened', async () => {
    const agent = fakeAcpSpawn([
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { run: async (a) => { await a.listMcpTools(); } },
      { answer: { sessionId: 'sess-1' }, to: 'session/new' },
      { expect: 'session/prompt' },
      said('A plan, then.'),
      endTurn,
    ]);
    const { svc } = plannerOver(SESSION_NEW, [agent]);
    const progress: ResearchProgress[] = [];

    const turn = await svc.startConversation(request(progress));

    expect(turn).toMatchObject({ kind: 'message', text: 'A plan, then.' });
    expect(promptText(agent.agent)).toHaveLength(1);
    expect(agent.agent.problems).toEqual([]);
    svc.reset();
  });
});
