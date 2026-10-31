import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer, PLANNER_TOOLS } from '../mcp';
import type { ConversationRequest } from '../AiService';
import type { SessionRuntimeSettings } from '../createSession';
import { surfacePlan, type SessionMessage, type SessionNotice } from '../SessionMessage';
import type { SkillInfo, SkillsService } from '../SkillsService';
import type { SkillLookup } from '../taskSkills';
import { PlanChangeCheck, requestScope } from '../PlanChangeCheck';
import { createTask, flattenTasks, type DiscoveredModel, type Task } from '../../models/Task';
import { storedHandoff } from '../../models/Handoff';
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import { openTaskLog } from '../../utils/taskLogStore';
import { FakeRunnerSession, makeSession, saves } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CODEX_SANDBOX_MODE_REASON } from '../harness/codexSandbox';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { respondingSpawn, planJson, type FakeAgentProcess, type FakeSpawnResult } from './harnessTestKit';
import { plannerToolHandler, PLANNER_TURN_ENDED, type PlannerToolsHost } from '../plannerTools';
import { EMPTY_CONVERSATION, fromTranscript, reduceConversation, type ConversationView } from '../../conversation';
import type { SubmitPlanArgs } from '../mcp/tools';
import { TASK_READ_TOOLS_PROTOCOL } from '../TaskQuery';

/**
 * The Ordewell MCP server reaching the Claude Code planner (ADR-0022): the
 * fake `claude` reads the `--mcp-config` file it was spawned with and calls
 * the real server over HTTP, the way the CLI does.
 */

const servers: OrdewellMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

function newServer(): OrdewellMcpServer {
  const server = new OrdewellMcpServer();
  servers.push(server);
  return server;
}

interface InjectedServer {
  url: string;
  headers: Record<string, string>;
}

function injectedServer(args: string[]): InjectedServer | null {
  const at = args.indexOf('--mcp-config');
  if (at < 0) return null;
  const config = JSON.parse(readFileSync(args[at + 1], 'utf8')) as { mcpServers: Record<string, InjectedServer> };
  return config.mcpServers.ordewell;
}

async function connectAs(args: string[]): Promise<Client> {
  const injected = injectedServer(args);
  if (!injected) throw new Error('spawned without the Ordewell server');
  const client = new Client({ name: 'fake-claude', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(injected.url), { requestInit: { headers: injected.headers } }));
  clients.push(client);
  return client;
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function reply(proc: FakeAgentProcess, text: string): void {
  proc.emitStdout(line({ type: 'system', subtype: 'init', session_id: 'sess-1', permissionMode: 'plan' }));
  proc.emitStdout(line({ type: 'assistant', session_id: 'sess-1', message: { id: 'm1', content: [{ type: 'text', text }] } }));
  proc.emitStdout(line({ type: 'result', subtype: 'success', session_id: 'sess-1', is_error: false, result: text }));
}

interface FakeClaude {
  /** What the CLI's own `mcp_status` reports for the Ordewell server; a list says it per spawn, in order. */
  status?: 'connected' | 'failed' | Array<'connected' | 'failed'>;
  /** One user turn: what it does with the injected server (absent when none was injected), and the reply text. `emit` writes a stream-json line ahead of the reply. */
  turn?: (mcp: Client | null, message: string, emit: (event: unknown) => void) => Promise<string>;
}

function fakeClaude({ status: reported = 'connected', turn = async () => 'What should it do?' }: FakeClaude = {}): FakeSpawnResult {
  const spawned: FakeSpawnResult = respondingSpawn((written, proc, args) => {
    const n = spawned.processes.indexOf(proc);
    const status = Array.isArray(reported) ? reported[n] ?? 'failed' : reported;
    const msg = JSON.parse(written) as { type: string; request_id?: string; request?: { subtype?: string }; message?: { content: { text: string }[] } };
    if (msg.type === 'control_request' && msg.request?.subtype === 'mcp_status') {
      const mcpServers = injectedServer(args) ? [{ name: 'ordewell', status }] : [];
      proc.emitStdout(line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mcpServers } } }));
      return;
    }
    if (msg.type !== 'user') return;
    void (async () => {
      const mcp = injectedServer(args) && status === 'connected' ? await connectAs(args) : null;
      return turn(mcp, msg.message?.content[0]?.text ?? '', (event) => proc.emitStdout(line(event)));
    })().then(
      (text) => reply(proc, text),
      (err: unknown) => reply(proc, `The fake planner failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  });
  return spawned;
}

function service(spawned: FakeSpawnResult, mcpServer?: OrdewellMcpServer) {
  return new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
    spawn: spawned.spawn,
    resolvePath: async () => '/usr/bin',
    workspaceRoot: () => '/repo',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    mcpServer,
  });
}

function request(overrides: Partial<ConversationRequest> = {}): ConversationRequest {
  return {
    goal: 'Add a cache layer',
    runners: ['claude-code'],
    modelsByRunner: { 'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }] },
    fs: fakeFileSystem(),
    onProgress: () => {},
    plannerTools: { sessionId: 's1', handler: {} },
    ...overrides,
  };
}

function bearer(server: InjectedServer): string {
  return server.headers.Authorization.replace(/^Bearer /, '');
}

describe('the Claude Code planner with the Ordewell server injected', () => {
  it('reaches it through an owner-only config file, its tools pre-allowed by name, the token never on the command line', async () => {
    const server = newServer();
    const spawned = fakeClaude();
    await service(spawned, server).startConversation(request());

    const args = spawned.lastArgs();
    const configPath = args[args.indexOf('--mcp-config') + 1];
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const injected = injectedServer(args)!;
    expect(injected.url).toBe(server.url);
    expect(args.join(' ')).not.toContain(bearer(injected));
    expect(args[args.indexOf('--allowedTools') + 1].split(',')).toEqual([
      'mcp__ordewell__list_runners', 'mcp__ordewell__list_models', 'mcp__ordewell__submit_plan',
      'mcp__ordewell__edit_plan', 'mcp__ordewell__task_query', 'mcp__ordewell__task_output', 'mcp__ordewell__task_diff',
      'mcp__ordewell__run_command', 'mcp__ordewell__load_skill',
      'mcp__ordewell__run_plan', 'mcp__ordewell__run_task', 'mcp__ordewell__stop_task', 'mcp__ordewell__stop_run',
      'mcp__ordewell__retry_task', 'mcp__ordewell__skip_task', 'mcp__ordewell__message_task', 'mcp__ordewell__answer_approval', 'mcp__ordewell__answer_checkpoint', 'mcp__ordewell__merge_all',
      'mcp__ordewell__run_script',
    ]);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
  });
});

describe('the planner token, in what the planner is told', () => {
  it('appears in no message sent to the planner, its system prompt included', async () => {
    const server = newServer();
    const spawned = fakeClaude();
    await service(spawned, server).startConversation(request());

    const token = bearer(injectedServer(spawned.lastArgs())!);
    expect(token.length).toBeGreaterThan(20);
    expect(spawned.processes[0].written.length).toBeGreaterThan(0);
    expect(spawned.processes[0].written.join('')).not.toContain(token);
    expect(spawned.lastArgs().join(' ')).not.toContain(token);
  });
});

describe('the planner token', () => {
  it('is refused, and its config file gone, once the session resets', async () => {
    const server = newServer();
    const spawned = fakeClaude();
    const svc = service(spawned, server);
    await svc.startConversation(request());
    const args = spawned.lastArgs();
    const configPath = args[args.indexOf('--mcp-config') + 1];
    const client = await connectAs(args);

    svc.reset();

    expect(existsSync(configPath)).toBe(false);
    await expect(client.listTools()).rejects.toThrow(/Unauthorized/);
  });
});

describe('a planner the server did not reach', () => {
  it('is killed and respawned once, on a fresh token, and plans with its tools', async () => {
    const server = newServer();
    const claude = fakeClaude({ status: ['failed', 'connected'] });
    const svc = service(claude, server);

    const turn = await svc.startConversation(request());

    expect(claude.processes).toHaveLength(2);
    expect(claude.processes[0].killed).toBe(true);
    expect(claude.processes[0].written.some((line) => line.includes('"type":"user"'))).toBe(false);
    expect(injectedServer(claude.lastArgs())).not.toBeNull();
    expect(turn.text).toBe('What should it do?');
    expect(svc.plannerToolsAttached()).toBe(true);
  });

  it('fails the turn with a clear error when the respawn does not connect either, sending it nothing', async () => {
    const server = newServer();
    const claude = fakeClaude({ status: 'failed' });

    await expect(service(claude, server).startConversation(request())).rejects.toThrow(
      'Could not start the claude-code planner with Ordewell\'s tools. First spawn: claude-code did not report Ordewell\'s MCP server connected. Respawn: claude-code did not report Ordewell\'s MCP server connected.',
    );

    expect(claude.processes).toHaveLength(2);
    expect(claude.processes.every((p) => p.killed)).toBe(true);
    expect(claude.processes.some((p) => p.written.some((line) => line.includes('"type":"user"')))).toBe(false);
  });

  it('is never spawned when the session has no planner tool handler', async () => {
    const claude = fakeClaude();

    await expect(service(claude).startConversation(request({ plannerTools: undefined }))).rejects.toThrow('this session has no server to hand it');

    expect(claude.processes).toHaveLength(0);
  });
});
/** A planning session on a real harness planner, whose settings the test rewrites the way a settings write would. */
function plannerSession(claude: FakeSpawnResult, initial: Partial<SessionRuntimeSettings> = {}, { runner, registry, isolation, skills = [], skillsService, onNotice }: { runner?: IRunner; registry?: RunnerRegistry; isolation?: IWorktreeIsolation; skills?: SkillInfo[]; skillsService?: Pick<SkillsService, 'findSkill' | 'listSkills'>; onNotice?: (notice: SessionNotice) => void } = {}) {
  const server = newServer();
  let settings: SessionRuntimeSettings = { enabledRunners: ['claude-code'], ...initial };
  const ai = service(claude, server);
  const broadcast = vi.fn<(msg: SessionMessage) => void>();
  const session = makeSession({
    aiService: ai,
    mcpServer: server,
    runner,
    registry,
    isolation,
    skillsService: skillsService ?? { findSkill: (name: string) => skills.find((sk) => sk.name === name) },
    modelResolver: {
      modelsForRunners: vi.fn(async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, CATALOG[r] ?? []]))),
    },
    settings: () => settings,
    broadcast,
    onNotice,
  });
  return {
    session,
    ai,
    broadcast,
    settings: (change: Partial<SessionRuntimeSettings>) => { settings = { ...settings, ...change }; },
  };
}

const CATALOG: Record<string, DiscoveredModel[]> = {
  'claude-code': [
    { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4', variants: [] },
    { modelId: 'claude-opus-4', modelLabel: 'Claude Opus 4', variants: [{ id: 'high', label: 'High' }] },
  ],
  codex: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] }],
};

async function call(mcp: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: unknown }> {
  const result = await mcp.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, body: JSON.parse(first.text) };
}

function plannerSkill(name: string, extra: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name, description: `Use ${name} to plan`, metadata: { name, description: `Use ${name} to plan` },
    source: 'global', path: `/outside/workspace/skills/${name}/SKILL.md`, content: `${name} BODY v1`,
    appliesTo: 'planner', modelInvocable: true, userInvocable: false, ...extra,
  };
}

function skillCatalog(files: Map<string, SkillInfo>): Pick<SkillsService, 'findSkill' | 'listSkills'> {
  return { findSkill: (name) => files.get(name), listSkills: () => [...files.values()] };
}

async function loadSkill(mcp: Client, name: string) {
  const result = await mcp.callTool({ name: 'load_skill', arguments: { name } });
  return { isError: result.isError === true, text: (result.content as { text: string }[])[0].text };
}

describe('load_skill', () => {
  it('advertises the planner skills catalog, never a body', async () => {
    const files = new Map([['review-plan', plannerSkill('review-plan')]]);
    const claude = fakeClaude();
    const { session } = plannerSession(claude, {}, { skillsService: skillCatalog(files) });
    await session.startPlanning('goal', ['claude-code']);
    const args = claude.lastArgs();
    const prompt = args[args.indexOf('--append-system-prompt') + 1];
    expect(prompt).toContain('ORDEWELL PLANNER SKILLS:');
    expect(prompt).toContain('- review-plan: Use review-plan to plan');
    expect(prompt).toContain('load_skill');
    expect(prompt).not.toContain('review-plan BODY v1');
  });

  it('refuses a load after the planner turn settled, without changing the transcript', async () => {
    const files = new Map([['review-plan', plannerSkill('review-plan')]]);
    let client: Client | null = null;
    const { session } = plannerSession(fakeClaude({ turn: async (mcp) => { client = mcp; return 'Done.'; } }), {}, { skillsService: skillCatalog(files) });
    await session.startPlanning('goal', ['claude-code']);
    const before = structuredClone(session.planState!.conversationHistory);
    expect(await loadSkill(client!, 'review-plan')).toEqual({ isError: true, text: 'No planning turn is open to load a skill.' });
    expect(session.planState!.conversationHistory).toEqual(before);
  });

  it('loads a model-only planner skill and persists its snapshot with a live notice', async () => {
    const skill = plannerSkill('review-plan');
    const files = new Map([[skill.name, skill]]);
    let loaded: Awaited<ReturnType<typeof loadSkill>> | undefined;
    const { session, broadcast } = plannerSession(fakeClaude({ turn: async (mcp) => {
      loaded = await loadSkill(mcp!, skill.name);
      return 'I reviewed the plan.';
    } }), {}, { skillsService: skillCatalog(files) });

    await session.startPlanning('goal', ['claude-code']);

    expect(loaded).toEqual({ isError: false, text: skill.content });
    const history = session.planState!.conversationHistory!;
    expect(history.map((entry) => entry.kind)).toEqual([undefined, 'skill_load', undefined]);
    expect(history[1]).toMatchObject({
      role: 'assistant', content: 'review-plan skill loaded by planner',
      skill: { invokedBy: 'planner', name: skill.name, content: skill.content, source: 'global', path: skill.path },
    });
    expect(saves(session).mock.calls.at(-1)![0].conversationHistory).toEqual(history);
    expect(broadcast.mock.calls.map(([msg]) => msg).filter((msg) => msg.type === 'planner_skill_loaded')).toEqual([
      { type: 'planner_skill_loaded', turnId: expect.any(String), skill: { invokedBy: 'planner', name: skill.name, source: 'global', path: skill.path } },
    ]);
  });

  it('opens on a user-invoked skill with the goal verbatim in the system prompt and the body only in the first message', async () => {
    const skill = plannerSkill('review-plan', { userInvocable: true });
    const messages: string[] = [];
    const claude = fakeClaude({ turn: async (_mcp, message) => { messages.push(message); return 'Reviewed.'; } });
    const { session } = plannerSession(claude, {}, { skillsService: skillCatalog(new Map([[skill.name, skill]])) });

    await session.startPlanning('/review-plan the cache', ['claude-code']);

    const args = claude.lastArgs();
    const prompt = args[args.indexOf('--append-system-prompt') + 1];
    expect(prompt).toContain('USER GOAL: /review-plan the cache');
    expect(prompt).not.toContain(skill.content);
    expect(messages).toHaveLength(1);
    expect(messages[0].split(skill.content)).toHaveLength(2);
    expect(messages[0].endsWith('/review-plan the cache')).toBe(true);
  });

  it('keeps the loaded body off the step a surface is sent, live and in the plan, while the snapshot holds it', async () => {
    const skill = plannerSkill('review-plan');
    const files = new Map([[skill.name, skill]]);
    const { session, broadcast } = plannerSession(fakeClaude({ turn: async (mcp, _message, emit) => {
      const { text } = await loadSkill(mcp!, skill.name);
      emit({ type: 'assistant', session_id: 'sess-1', message: { id: 'm0', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__ordewell__load_skill', input: { name: skill.name } }] } });
      emit({ type: 'user', session_id: 'sess-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text }] }] } });
      return 'I reviewed the plan.';
    } }), {}, { skillsService: skillCatalog(files) });

    await session.startPlanning('goal', ['claude-code']);

    const done = broadcast.mock.calls.map(([msg]) => msg).filter((msg) => msg.type === 'research_step_done');
    expect(done).toEqual([expect.objectContaining({ step: expect.objectContaining({ toolLabel: 'mcp__ordewell__load_skill', result: 'Loaded skill review-plan.' }) })]);
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain(skill.content);
    expect(JSON.stringify(surfacePlan(session.planState!))).not.toContain(skill.content);
    expect(JSON.stringify(session.currentPlanState)).not.toContain(skill.content);
    const saved = saves(session).mock.calls.at(-1)![0];
    expect(saved.researchLog).toContainEqual(expect.objectContaining({ toolLabel: 'mcp__ordewell__load_skill', result: 'Loaded skill review-plan.' }));
    expect(saved.conversationHistory!.find((entry) => entry.kind === 'skill_load')!.skill!.content).toBe(skill.content);
  });

  it.each(['missing', 'task-only', 'user-only', '../outside', '/absolute/path'])('refuses %s and lists only currently loadable names', async (name) => {
    const skills = [plannerSkill('review-plan'), plannerSkill('task-only', { appliesTo: 'task' }), plannerSkill('user-only', { modelInvocable: false })];
    const files = new Map(skills.map((skill) => [skill.name, skill]));
    let loaded: Awaited<ReturnType<typeof loadSkill>> | undefined;
    const { session, broadcast } = plannerSession(fakeClaude({ turn: async (mcp) => {
      files.set('new-skill', plannerSkill('new-skill'));
      loaded = await loadSkill(mcp!, name);
      return 'Could not load it.';
    } }), {}, { skillsService: skillCatalog(files) });

    await session.startPlanning('goal', ['claude-code']);

    expect(loaded).toEqual({ isError: true, text: `Skill "${name}" cannot be loaded by the planner. Loadable skills: review-plan, new-skill.` });
    expect(session.planState!.conversationHistory!.some((entry) => entry.kind === 'skill_load')).toBe(false);
    expect(broadcast.mock.calls.some(([msg]) => msg.type === 'planner_skill_loaded')).toBe(false);
  });

  it('re-resolves added and edited skills at call time, and reports an empty catalog after deletion', async () => {
    const files = new Map<string, SkillInfo>();
    const answers: Awaited<ReturnType<typeof loadSkill>>[] = [];
    const { session } = plannerSession(fakeClaude({ turn: async (mcp) => {
      files.set('new-skill', plannerSkill('new-skill'));
      answers.push(await loadSkill(mcp!, 'new-skill'));
      files.set('new-skill', plannerSkill('new-skill', { content: 'EDITED BODY' }));
      answers.push(await loadSkill(mcp!, 'new-skill'));
      files.delete('new-skill');
      answers.push(await loadSkill(mcp!, 'new-skill'));
      return 'Loaded it twice.';
    } }), {}, { skillsService: skillCatalog(files) });

    await session.startPlanning('goal', ['claude-code']);

    expect(answers).toEqual([
      { isError: false, text: 'new-skill BODY v1' }, { isError: false, text: 'EDITED BODY' },
      { isError: true, text: 'Skill "new-skill" cannot be loaded by the planner. Loadable skills: (none).' },
    ]);
    expect(session.planState!.conversationHistory!.filter((entry) => entry.kind === 'skill_load').map((entry) => entry.skill!.content)).toEqual(['new-skill BODY v1', 'EDITED BODY']);
  });

  it('replays snapshotted loads on resume and fork, and keeps only loads before a rewind target', async () => {
    const skill = plannerSkill('review-plan');
    const files = new Map([[skill.name, skill]]);
    const { session } = plannerSession(fakeClaude({ turn: async (mcp) => {
      await loadSkill(mcp!, skill.name);
      return 'Reviewed.';
    } }), {}, { skillsService: skillCatalog(files) });
    await session.startPlanning('goal', ['claude-code']);
    files.set(skill.name, { ...skill, content: 'review-plan BODY v2' });
    await session.continueConversation('second message');
    const saved = structuredClone(session.planState!);
    session.forkConversation();
    const fork = saves(session).mock.calls.at(-1)![0];
    session.rewindConversation(session.rewindTargets()[0].index);
    const rewind = saves(session).mock.calls.at(-1)![0];
    expect(fork.conversationHistory).toEqual(saved.conversationHistory);
    expect(rewind.conversationHistory!.filter((entry) => entry.kind === 'skill_load').map((entry) => entry.skill!.content)).toEqual(['review-plan BODY v1']);

    files.clear();
    const ai = { startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'Resumed.', researchLog: [] }), hasActiveConversation: () => false, reset: vi.fn() };
    const resumed = makeSession({ aiService: ai, skillsService: skillCatalog(files) });
    resumed.loadPlan(fork, 'goal', process.cwd(), { persist: false });
    await resumed.continueConversation('next');
    const request = ai.startConversation.mock.calls[0][0] as ConversationRequest;
    const context = (body: string) => `(skill loaded via load_skill)\n\n<skill name="review-plan">\n${body}\n</skill>`;
    const replayed = request.priorHistory!.map((entry) => [entry.role, entry.content]);
    expect(replayed).toContainEqual(['user', context('review-plan BODY v1')]);
    expect(replayed).toContainEqual(['user', context('review-plan BODY v2')]);
    expect(request.goal).toBe('goal');
    expect(request.priorHistory!.some((entry) => entry.content.includes('The user invoked'))).toBe(false);
  });
});

describe('list_runners and list_models', () => {
  it('answer from the settings in force at each call', async () => {
    const answers: unknown[] = [];
    const { session, settings } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        answers.push((await call(mcp!, 'list_runners')).body);
        settings({ enabledRunners: ['claude-code', 'codex'], modelAllowlist: { 'claude-code': ['claude-opus-4'] } });
        answers.push((await call(mcp!, 'list_runners')).body);
        answers.push((await call(mcp!, 'list_models', { runner: 'claude-code' })).body);
        answers.push((await call(mcp!, 'list_models', { runner: 'codex' })).body);
        return 'What should it do?';
      },
    }));

    await session.startPlanning('add a cache', ['claude-code']);

    const runnerIds = (answer: unknown) => (answer as { runners: { id: string }[] }).runners.map((r) => r.id);
    expect(runnerIds(answers[0])).toEqual(['claude-code']);
    expect(runnerIds(answers[1])).toEqual(['claude-code', 'codex']);
    expect(answers[2]).toEqual({
      runner: 'claude-code',
      models: [{ modelId: 'claude-opus-4', modelLabel: 'Claude Opus 4', variants: [{ id: 'high', label: 'High' }] }],
    });
    expect(answers[3]).toEqual({
      runner: 'codex',
      models: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] }],
    });
  });

  it('say which runners take a read-only task, and name no mode (ADR-0031)', async () => {
    let answer: unknown;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        answer = (await call(mcp!, 'list_runners')).body;
        return 'What should it do?';
      },
    }), { enabledRunners: ['claude-code', 'codex'] });

    await session.startPlanning('add a cache', ['claude-code', 'codex']);

    expect(answer).toEqual({ autonomy: 'Full', runners: [{ id: 'claude-code', readOnly: true }, { id: 'codex', readOnly: true }] });
  });
});

/** Guarded needs Codex's sandbox; Ordewell's read-only profile does not (ADR-0046). */
function codexWithoutSandbox(): RunnerRegistry {
  const registry = new RunnerRegistry();
  registry.setUnavailableModes('codex', { agent: CODEX_SANDBOX_MODE_REASON });
  return registry;
}

describe('a Codex whose sandbox cannot start', () => {
  const bothRunners = { enabledRunners: ['claude-code', 'codex'] };

  it('keeps read-only support in list_runners when its native sandbox is unavailable', async () => {
    let answer: unknown;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        answer = (await call(mcp!, 'list_runners')).body;
        return 'What should it do?';
      },
    }), bothRunners, { registry: codexWithoutSandbox() });

    await session.startPlanning('add a cache', ['claude-code', 'codex']);

    expect(answer).toEqual({ autonomy: 'Full', runners: [{ id: 'claude-code', readOnly: true }, { id: 'codex', readOnly: true }] });
  });

  it('accepts a read-only task on Codex without its native sandbox', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        submitted = await call(mcp!, 'submit_plan', { tasks: [planTask('a', 1, 'codex', 'gpt-5', { readOnly: true })] });
        return 'Submitted.';
      },
    }), bothRunners, { registry: codexWithoutSandbox() });

    await session.startPlanning('add a cache', ['claude-code', 'codex']);

    expect(submitted?.isError).toBe(false);
    expect(session.planTasks[0]).toMatchObject({ assignedRunner: 'codex', taskMode: 'plan' });
  });

  it('keeps a task read-only when an edit moves it to Codex without its native sandbox', async () => {
    let edited: { isError: boolean; body: unknown } | undefined;
    let planned = false;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        if (planned) {
          edited = await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: 'a', changes: { assignedRunner: 'codex' } }] });
          return 'Done.';
        }
        planned = true;
        return submitted(mcp, [planTask('a', 1, 'claude-code', 'claude-sonnet-4', { readOnly: true })]);
      },
    }), bothRunners, { registry: codexWithoutSandbox() });
    await session.startPlanning('review it', ['claude-code', 'codex']);

    await session.continueConversation('EDIT NOW');

    expect(edited?.isError).toBe(false);
    expect(session.planTasks[0]).toMatchObject({ assignedRunner: 'codex', taskMode: 'plan' });
  });
});

function planTask(id: string, order: number, runner: string, modelId: string, extra: Record<string, unknown> = {}) {
  return {
    id, order, title: `Task ${id}`, description: `Does ${id}`, type: 'ai', prompt: `do ${id}`, dependencies: [], subtasks: [],
    sliceType: 'AFK', autonomy: 'AFK', assignedRunner: runner, assignedModel: { modelId, modelLabel: modelId }, ...extra,
  };
}

describe('submit_plan', () => {
  it('refuses a runner switched off since planning started, by name, and commits nothing', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const { session, settings } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        settings({ enabledRunners: ['claude-code'] });
        submitted = await call(mcp!, 'submit_plan', { tasks: [planTask('a', 1, 'claude-code', 'claude-sonnet-4'), planTask('b', 2, 'codex', 'gpt-5')] });
        return 'Submitted.';
      },
    }), { enabledRunners: ['claude-code', 'codex'] });

    await session.startPlanning('add a cache', ['claude-code', 'codex']);

    expect(submitted?.isError).toBe(true);
    expect(submitted?.body).toEqual({
      ok: false,
      enabledRunners: ['claude-code'],
      errors: [{ taskId: 'b', field: 'assignedRunner', message: 'Task "Task b" has invalid assignedRunner "codex". Expected one of: claude-code' }],
    });
    expect(session.planTasks).toEqual([]);
  });

  it('commits a plan on a runner enabled mid-conversation (#69)', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const { session, settings } = plannerSession(fakeClaude({
      turn: async (mcp, message) => {
        if (!message.includes('use codex too')) return 'Which runners should I use?';
        await call(mcp!, 'list_runners');
        await call(mcp!, 'list_models', { runner: 'codex' });
        submitted = await call(mcp!, 'submit_plan', { tasks: [planTask('a', 1, 'claude-code', 'claude-sonnet-4'), planTask('b', 2, 'codex', 'gpt-5')] });
        return 'Submitted the plan.';
      },
    }));
    await session.startPlanning('add a cache', ['claude-code']);

    settings({ enabledRunners: ['claude-code', 'codex'] });
    await session.continueConversation('use codex too');

    expect(submitted).toEqual({ isError: false, body: expect.objectContaining({ ok: true, tasks: [{ id: 'a', ref: '#1', title: 'Task a' }, { id: 'b', ref: '#2', title: 'Task b' }], coerced: [] }) });
    expect(session.planTasks.map((t) => [t.id, t.assignedRunner, t.assignedModel?.modelId])).toEqual([
      ['a', 'claude-code', 'claude-sonnet-4'],
      ['b', 'codex', 'gpt-5'],
    ]);
    expect(session.planState?.runners).toEqual(['claude-code', 'codex']);
  });

  it('names the model the allowlist moved a task off', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        submitted = await call(mcp!, 'submit_plan', {
          tasks: [planTask('a', 1, 'claude-code', 'claude-opus-4', { assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus', thinkingEffort: 'high' } })],
        });
        return 'Submitted.';
      },
    }), { modelAllowlist: { 'claude-code': ['claude-sonnet-4'] } });

    await session.startPlanning('add a cache', ['claude-code']);

    expect((submitted?.body as { coerced: unknown }).coerced).toEqual([
      { taskId: 'a', title: 'Task a', field: 'assignedModel', from: 'claude-opus-4', to: 'claude-sonnet-4' },
      { taskId: 'a', title: 'Task a', field: 'thinkingEffort', from: 'high', to: null },
    ]);
    expect(session.planTasks[0].assignedModel?.modelId).toBe('claude-sonnet-4');
  });

  it('gives a read-only task its runner\'s read-only mode and every other its mode for the level', async () => {
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        await call(mcp!, 'submit_plan', { tasks: [planTask('a', 1, 'claude-code', 'claude-sonnet-4', { readOnly: true }), planTask('b', 2, 'claude-code', 'claude-sonnet-4')] });
        return 'Submitted.';
      },
    }));

    await session.startPlanning('review the cache', ['claude-code']);

    expect(session.planTasks.map((t) => t.taskMode)).toEqual(['plan', 'bypassPermissions']);
  });

  it('ignores a mode the planner names, and says so', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        submitted = await call(mcp!, 'submit_plan', { tasks: [planTask('a', 1, 'claude-code', 'claude-sonnet-4', { taskMode: 'default' })] });
        return 'Submitted.';
      },
    }));

    await session.startPlanning('add a cache', ['claude-code']);

    expect(submitted?.isError).toBe(false);
    expect((submitted?.body as { warnings?: string[] }).warnings?.join(' ')).toContain('"taskMode" is not yours to set');
    expect(session.planTasks[0].taskMode).toBe('bypassPermissions');
  });
});

function skill(name: string, appliesTo: SkillInfo['appliesTo']): SkillInfo {
  const path = `/home/u/.ordewell/skills/${name}/SKILL.md`;
  return { name, description: name, metadata: { name, description: name }, content: `${name} body`, path, source: 'global', appliesTo, modelInvocable: false, userInvocable: true };
}

const SKILLS = [skill('tdd', 'task'), skill('grilling', 'planner')];

describe('submit_plan with task skills', () => {
  it('commits skills it knows and ones not created yet, warning about the latter', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        submitted = await call(mcp!, 'submit_plan', {
          tasks: [
            planTask('a', 1, 'claude-code', 'claude-sonnet-4', {
              skills: ['tdd'],
              subtasks: [planTask('a1', 1, 'claude-code', 'claude-sonnet-4', { skills: ['deploy-checklist'] })],
            }),
            planTask('b', 2, 'claude-code', 'claude-sonnet-4'),
          ],
        });
        return 'Submitted.';
      },
    }), {}, { skills: SKILLS });

    await session.startPlanning('add a cache', ['claude-code']);

    expect(submitted?.isError).toBe(false);
    expect((submitted?.body as { warnings: string[] }).warnings).toEqual([
      'Task "Task a1": skill "deploy-checklist" not found; it must exist in the task\'s worktree (.ordewell/skills/deploy-checklist/SKILL.md) or in ~/.ordewell/skills/ when the task starts, or the task fails.',
    ]);
    expect(session.planTasks[0].skills).toEqual(['tdd']);
    expect(session.planTasks[0].subtasks[0].skills).toEqual(['deploy-checklist']);
    expect(session.planTasks[1].skills).toBeUndefined();
  });

  it('refuses a planner skill on a task, and commits nothing', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        submitted = await call(mcp!, 'submit_plan', { tasks: [planTask('a', 1, 'claude-code', 'claude-sonnet-4', { skills: ['tdd', 'grilling'] })] });
        return 'Submitted.';
      },
    }), {}, { skills: SKILLS });

    await session.startPlanning('add a cache', ['claude-code']);

    expect(submitted).toEqual({
      isError: true,
      body: {
        ok: false,
        errors: [{
          taskId: 'a',
          field: 'skills',
          message: 'Task "Task a": "grilling" is a planner skill (applies-to: planner, /home/u/.ordewell/skills/grilling/SKILL.md). Only skills with applies-to: task can be attached to a task.',
        }],
      },
    });
    expect(session.planTasks).toEqual([]);
  });
});

describe('submit_plan with names it cannot attach', () => {
  const withSubtaskSkills = (skills: unknown[]) => [
    planTask('a', 1, 'claude-code', 'claude-sonnet-4', { subtasks: [planTask('a1', 1, 'claude-code', 'claude-sonnet-4', { skills })] }),
  ];

  it('warns about a nested name no skill could have, as written, in its answer, the transcript and a notice', async () => {
    let submitted: { isError: boolean; body: unknown } | undefined;
    const onNotice = vi.fn<(notice: SessionNotice) => void>();
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        submitted = await call(mcp!, 'submit_plan', { tasks: withSubtaskSkills(['Bad Name!', ' TDD ', 'tdd', 'later']) });
        return 'Submitted.';
      },
    }), {}, { skills: SKILLS, onNotice });

    await session.startPlanning('add a cache', ['claude-code']);

    const warnings = [
      expect.stringMatching(/^Task "Task a1": "Bad Name!" is not a valid skill name .*so it was not attached\.$/),
      expect.stringMatching(/^Task "Task a1": skill "later" not found/),
    ];
    expect((submitted?.body as { warnings: string[] }).warnings).toEqual(warnings);
    expect(session.planTasks[0].subtasks[0].skills).toEqual(['tdd', 'later']);
    const note = session.planState?.conversationHistory?.find((m) => m.kind === 'system' && m.content.startsWith('Skill check:'));
    expect(note?.content).toContain('\n- Task "Task a1": "Bad Name!" is not a valid skill name');
    expect(note?.content).toContain('\n- Task "Task a1": skill "later" not found');
    expect(onNotice.mock.calls.map(([n]) => n.message)).toEqual(warnings);
  });

  it('refuses a planner skill on a subtask, and changes nothing of a plan already there', async () => {
    let refused: { isError: boolean; body: unknown } | undefined;
    const planner = await planThen(async (mcp) => {
      refused = await call(mcp!, 'submit_plan', { tasks: withSubtaskSkills(['grilling']) });
      return 'Submitted.';
    }, { skills: SKILLS });
    const before = landed(planner);

    await planner.session.continueConversation('REPLAN NOW');

    expect(refused).toEqual({
      isError: true,
      body: { ok: false, errors: [expect.objectContaining({ taskId: 'a1', field: 'skills', message: expect.stringContaining('Task "Task a1": "grilling" is a planner skill') })] },
    });
    expect(landed(planner)).toEqual({ ...before, last: 'Submitted.' });
  });

  it('commits nothing when a refused call is followed by the plan written out as JSON', async () => {
    let refused: { isError: boolean; body: unknown } | undefined;
    const echoed = JSON.stringify({ tasks: withSubtaskSkills(['tdd']) });
    const planner = await planThen(async (mcp) => {
      refused = await call(mcp!, 'submit_plan', { tasks: withSubtaskSkills(['grilling']) });
      return `The tool refused it, so here it is:\n${echoed}`;
    }, { skills: SKILLS });
    const before = landed(planner);

    await planner.session.continueConversation('REPLAN NOW');

    expect(refused?.isError).toBe(true);
    expect(landed(planner)).toEqual({ ...before, last: `The tool refused it, so here it is:\n${echoed}` });
  });

  it('lands the accepted plan when the reply after the call is prose with JSON in it', async () => {
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        await call(mcp!, 'submit_plan', { tasks: TWO_TASKS });
        return `Submitted. For reference the first task is ${JSON.stringify({ tasks: [planTask('z', 1, 'claude-code', 'claude-sonnet-4')] })}`;
      },
    }));

    await session.startPlanning('add a cache', ['claude-code']);

    expect(session.planTasks.map((t) => t.id)).toEqual(['a', 'b']);
    // Committed as the call answered, ahead of the reply that followed it.
    expect(session.planState?.conversationHistory?.at(-2)?.kind).toBe('plan_generated');
    expect(session.planState?.conversationHistory?.at(-1)?.content).toMatch(/^Submitted\. For reference/);
  });
});

describe('the one route to a plan', () => {
  it('is submit_plan: the same tasks written as JSON in the reply are shown as prose and commit nothing', async () => {
    const tasks = [
      planTask('a', 1, 'claude-code', 'claude-sonnet-4'),
      planTask('b', 2, 'claude-code', 'claude-opus-4', { dependencies: ['a'], taskMode: 'default', assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus', thinkingEffort: 'xhigh' } }),
    ];
    const settings = { modelAllowlist: { 'claude-code': ['claude-sonnet-4', 'claude-opus-4'] } };
    const viaTool = plannerSession(fakeClaude({
      turn: async (mcp) => {
        await call(mcp!, 'submit_plan', { tasks });
        return 'Submitted the plan.';
      },
    }), settings);
    const asText = JSON.stringify({ tasks });
    const textClaude = fakeClaude({ turn: async () => asText });
    const viaText = plannerSession(textClaude, settings);

    await viaTool.session.startPlanning('add a cache', ['claude-code']);
    await viaText.session.startPlanning('add a cache', ['claude-code']);

    expect(viaTool.session.planTasks).toHaveLength(2);
    expect(viaTool.session.planState?.conversationHistory?.at(-2)?.kind).toBe('plan_generated');
    expect(viaText.session.planTasks).toEqual([]);
    expect(viaText.session.planState?.conversationHistory?.at(-1)).toEqual(expect.objectContaining({ role: 'assistant', content: asText }));
    expect(viaText.broadcast.mock.calls.filter(([m]) => m.type === 'plan_generated')).toHaveLength(0);
    expect(viaText.broadcast.mock.calls.map(([m]) => m)).toContainEqual(expect.objectContaining({ type: 'planner_message', content: asText }));
    // Nothing was sent back to be re-emitted: the reply is prose, not a botched envelope.
    expect(textClaude.processes[0].written.filter((w) => w.includes('"type":"user"'))).toHaveLength(1);
  });
});

describe('what the planner is told', () => {
  it('that task_query reads a task\'s attached skills too', () => {
    expect(PLANNER_TOOLS.find((t) => t.name === 'task_query')?.description).toMatch(/\bskills\b/);
  });

  it('that task_query reads a task\'s handoff, and task_output an ended task\'s whole handoff with its report (ADR-0047)', () => {
    const described = (name: string) => PLANNER_TOOLS.find((t) => t.name === name)?.description;
    expect(described('task_query')).toMatch(/\bhandoff\b/);
    expect(described('task_output')).toMatch(/whole handoff, its findings and report/);
    expect(TASK_READ_TOOLS_PROTOCOL.join('\n')).toMatch(/outputSummary, handoff, userStoriesCovered/);
    expect(TASK_READ_TOOLS_PROTOCOL.join('\n')).toMatch(/whole handoff, its findings and report/);
  });

  const systemPrompt = (spawned: FakeSpawnResult) => {
    const args = spawned.lastArgs();
    return args[args.indexOf('--append-system-prompt') + 1];
  };

  async function twoTurns() {
    const messages: string[] = [];
    const claude = fakeClaude({ turn: async (_mcp, message) => { messages.push(message); return 'Which cache?'; } });
    const { session, ai } = plannerSession(claude);
    await session.startPlanning('add a cache', ['claude-code']);
    await session.continueConversation('in-process');
    return { claude, messages, attached: ai.plannerToolsAttached() };
  }

  it('with the tools: to pull the catalog just before submitting through submit_plan, and no pasted catalog', async () => {
    const { claude, messages, attached } = await twoTurns();

    expect(attached).toBe(true);
    const prompt = systemPrompt(claude);
    expect(prompt).toMatch(/list_runners/);
    expect(prompt).toMatch(/list_models/);
    expect(prompt).toMatch(/submit_plan/);
    expect(prompt).not.toContain('claude-sonnet-4');
    expect(prompt).not.toContain('Output ONLY the JSON object');
    expect(messages[1]).not.toContain('<available_models>');
    expect(messages[1]).toMatch(/list_runners/);
  });

  describe('about reading and editing the plan', () => {
    /** The system prompt, and the message of the first turn after the plan exists. */
    async function afterPlan() {
      const messages: string[] = [];
      let planned = false;
      const claude = fakeClaude({
        turn: async (_mcp, message) => {
          messages.push(message);
          if (planned) return 'Ok.';
          planned = true;
          return submitted(_mcp, TWO_TASKS);
        },
      });
      const { session } = plannerSession(claude);
      await session.startPlanning('add a cache', ['claude-code']);
      await session.continueConversation('rename the first task');
      return { prompt: systemPrompt(claude), perTurn: messages[1] };
    }

    it('with the tools: to read through task_query and task_output and edit through edit_plan, not the envelopes', async () => {
      const { prompt, perTurn } = await afterPlan();

      expect(prompt).toMatch(/task_query/);
      expect(prompt).toMatch(/task_output/);
      expect(prompt).not.toContain('"taskQuery"');
      expect(perTurn).toMatch(/call edit_plan/);
      expect(perTurn).toMatch(/call task_query, task_output or task_diff/);
      expect(perTurn).not.toMatch(/"taskOps"|"taskQuery"|reply with ONLY/);
    });

  });

});

/** Submit `tasks` through the tool, as a coding-agent planner must, and say so in prose. */
async function submitted(mcp: Client | null, tasks: unknown[]): Promise<string> {
  const answer = await call(mcp!, 'submit_plan', { tasks });
  if (answer.isError) throw new Error(`submit_plan refused: ${JSON.stringify(answer.body)}`);
  return 'Submitted the plan.';
}

const TWO_TASKS = [
  planTask('a', 1, 'claude-code', 'claude-sonnet-4'),
  planTask('b', 2, 'claude-code', 'claude-sonnet-4', { dependencies: ['a'] }),
];

/** A conversation with a committed two-task plan, whose every later reply is `second`. */
async function planThen(second: (mcp: Client | null, message: string) => Promise<string>, opts: { runner?: IRunner; skills?: SkillInfo[] } & Partial<SessionRuntimeSettings> = {}) {
  const { runner, skills, ...settings } = opts;
  let planned = false;
  const planner = plannerSession(fakeClaude({
    turn: async (mcp, message) => {
      if (planned) return second(mcp, message);
      planned = true;
      return submitted(mcp, TWO_TASKS);
    },
  }), settings, { runner, skills });
  await planner.session.startPlanning('add a cache', ['claude-code']);
  return planner;
}

const landed = ({ session, broadcast }: ReturnType<typeof plannerSession>) => ({
  tasks: session.planTasks.map(({ id: _id, ...rest }) => rest),
  runners: session.planState?.runners,
  last: session.planState?.conversationHistory?.at(-1)?.content,
  planBroadcasts: broadcast.mock.calls.filter(([m]) => m.type === 'plan_generated').length,
});

/** A started run on a plan of two tasks: `a` running behind `sessions[0]`, `b` waiting on it. */
async function runningPlan(second: Parameters<typeof planThen>[0], opts: { sessions?: FakeRunnerSession[] } = {}) {
  const { sessions = [], ...rest } = opts;
  const runner = {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      const session = new FakeRunnerSession(`s-${taskId}`, taskId);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as IRunner;
  const planner = await planThen(second, { ...rest, runner });
  await planner.session.execute({ command: 'run_plan' }, { kind: 'user' });
  return planner;
}

describe('edit_plan with task skills', () => {
  it('attaches a skill not created yet with a warning, and refuses a planner skill', async () => {
    const answers: { isError: boolean; body: unknown }[] = [];
    const planner = await planThen(async (mcp) => {
      answers.push(await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#2', changes: { skills: ['grilling'] } }] }));
      answers.push(await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#2', changes: { skills: ['tdd', 'smoke-test'] } }] }));
      return 'Done.';
    }, { skills: SKILLS });

    await planner.session.continueConversation('EDIT NOW');

    expect(answers[0]).toEqual({
      isError: true,
      body: {
        ok: false,
        errors: [{ op: 1, kind: 'update', message: '"grilling" is a planner skill (applies-to: planner, /home/u/.ordewell/skills/grilling/SKILL.md). Only skills with applies-to: task can be attached to a task.' }],
      },
    });
    expect(answers[1].isError).toBe(false);
    expect((answers[1].body as { warnings: string[] }).warnings).toEqual([
      expect.stringContaining('op 1 (update): skill "smoke-test" not found'),
    ]);
    expect(planner.session.planTasks[1].skills).toEqual(['tdd', 'smoke-test']);
  });
});

describe('edit_plan adding a task with subtasks', () => {
  const sub = (title: string, skills: unknown[], subtasks: unknown[] = []) => ({ title, subtasks, skills });

  it('refuses a whole batch when a descendant carries a planner skill, naming it, then lands nested names with their warnings', async () => {
    const answers: { isError: boolean; body: unknown }[] = [];
    let between: string[] = [];
    const planner = await planThen(async (mcp) => {
      answers.push(await call(mcp!, 'edit_plan', {
        ops: [
          { op: 'update', taskId: '#1', changes: { title: 'Renamed' } },
          { op: 'add', task: { title: 'Docs', subtasks: [sub('Child', ['tdd'], [sub('Deep', ['grilling'])])] } },
        ],
      }));
      between = planner.session.planTasks.map((t) => t.title);
      answers.push(await call(mcp!, 'edit_plan', {
        ops: [{ op: 'add', task: { title: 'Docs', subtasks: [sub('Child', ['tdd', 'Bad Name!'], [sub('Deep', ['later'])])] } }],
      }));
      return 'Done.';
    }, { skills: SKILLS });

    await planner.session.continueConversation('EDIT NOW');

    expect(answers[0]).toEqual({
      isError: true,
      body: {
        ok: false,
        errors: [{ op: 2, kind: 'add', message: expect.stringMatching(/^subtask "Child" > "Deep": "grilling" is a planner skill/) }],
      },
    });
    expect(between).toEqual(['Task a', 'Task b']);
    expect(answers[1].isError).toBe(false);
    expect((answers[1].body as { warnings: string[] }).warnings).toEqual([
      expect.stringMatching(/^op 1 \(add\): subtask "Child": "Bad Name!" is not a valid skill name/),
      expect.stringMatching(/^op 1 \(add\): subtask "Child" > "Deep": skill "later" not found/),
    ]);
    expect(planner.session.planTasks.map((t) => t.title)).toEqual(['Task a', 'Task b', 'Docs']);
    const docs = planner.session.planTasks[2];
    expect(docs.skills).toBeUndefined();
    expect(docs.subtasks[0].skills).toEqual(['tdd']);
    expect(docs.subtasks[0].subtasks[0].skills).toEqual(['later']);
  });
});

describe('task_query with task skills', () => {
  it('reads a task\'s skills, null when it has none', async () => {
    let read: { isError: boolean; body: unknown } | undefined;
    const planner = await planThen(async (mcp, message) => {
      if (message.includes('FIRST')) await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#2', changes: { skills: ['tdd'] } }] });
      else read = await call(mcp!, 'task_query', { tasks: ['#1', '#2'], fields: ['skills'] });
      return 'Done.';
    }, { skills: SKILLS });

    await planner.session.continueConversation('FIRST');
    await planner.session.continueConversation('SECOND');

    expect((read?.body as { tasks: { skills: unknown }[] }).tasks.map((t) => t.skills)).toEqual([null, ['tdd']]);
  });
});

describe('task_query with a task report', () => {
  it('reads an ended task\'s report whole, ahead of its log tail', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-task-report-'));
    let read: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        read = await call(mcp!, 'task_query', { tasks: ['#1'], fields: ['outputSummary'] });
        return 'I see.';
      },
    }));
    const report = Array.from({ length: 50 }, (_, i) => `${i + 1}. src/cache.ts:${i + 1} never evicts`).join('\n');
    try {
      session.loadPlan({
        tasks: [createTask({
          id: 'a', order: 1, title: 'Review', prompt: 'p', assignedRunner: 'claude-code', status: 'completed',
          outputSummary: { reviewReason: 'Verified', report, logTail: '', capturedAt: '2026-10-05T10:00:00Z' },
        })],
        generatedAt: '2026-10-05T09:00:00Z', lastUpdated: '2026-10-05T09:00:00Z', status: 'approved', runners: ['claude-code'],
        conversationHistory: [{ role: 'user', content: 'review it', timestamp: '2026-10-05T09:00:00Z' }],
      }, 'review it', workspace, { persist: false });

      await session.continueConversation('what did it find?');

      const [task] = (read?.body as { tasks: { outputSummary: unknown }[] }).tasks;
      expect(task.outputSummary).toEqual({ reviewReason: 'Verified', report });
      expect(Object.keys(task.outputSummary as object)).toEqual(['reviewReason', 'report']);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('task_query with a loop (ADR-0045)', () => {
  it('says where a check stands and which check a body task runs for, as the text read does', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-task-loop-'));
    let read: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        read = await call(mcp!, 'task_query', { tasks: ['#1', '#2', '#3'], fields: ['description'] });
        return 'I see.';
      },
    }));
    try {
      session.loadPlan({
        tasks: [
          createTask({ id: 'review', order: 1, title: 'Review', prompt: 'p', assignedRunner: 'claude-code', status: 'in_progress', loop: { body: ['fix'], maxRounds: 3 }, loopRound: 2 }),
          createTask({ id: 'fix', order: 2, title: 'Fix', prompt: 'p', assignedRunner: 'claude-code' }),
          createTask({ id: 'plain', order: 3, title: 'Plain', prompt: 'p', assignedRunner: 'claude-code' }),
        ],
        generatedAt: '2026-10-05T09:00:00Z', lastUpdated: '2026-10-05T09:00:00Z', status: 'approved', runners: ['claude-code'],
        conversationHistory: [{ role: 'user', content: 'loop it', timestamp: '2026-10-05T09:00:00Z' }],
      }, 'loop it', workspace, { persist: false });

      await session.continueConversation('where is the loop?');

      const tasks = (read?.body as { tasks: { loop?: unknown }[] }).tasks;
      expect(tasks.map((t) => t.loop)).toEqual([
        { body: ['#2'], maxRounds: 3, round: 2, betweenRounds: false },
        { check: '#1' },
        undefined,
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('task_query with a handoff (ADR-0047)', () => {
  const handoff = {
    summary: 'Reviewed the cache; two blockers.',
    findings: [{ id: 'F1', severity: 'blocker' as const, title: 'Entries never expire', detail: 'get() ignores the TTL.', evidence: [{ kind: 'task' as const, task: 'a', finding: 'F2' }, { kind: 'file' as const, path: 'src/cache.ts', line: 12 }] }],
    findingCount: 30,
    artifacts: [{ kind: 'commit' as const, sha: 'a1b2c3d' }],
  };

  async function readBoth(args: Record<string, unknown>) {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-task-handoff-'));
    let read: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        read = await call(mcp!, 'task_query', args);
        return 'I see.';
      },
    }));
    try {
      session.loadPlan({
        tasks: [
          createTask({
            id: 'a', order: 1, title: 'Build', prompt: 'p', assignedRunner: 'claude-code', status: 'completed',
            outputSummary: { reviewReason: 'Verified', report: 'Built it.', logTail: '', capturedAt: '2026-10-05T10:00:00Z' },
          }),
          createTask({
            id: 'b', order: 2, title: 'Review', prompt: 'p', assignedRunner: 'claude-code', status: 'completed', dependencies: ['a'], handoff,
            outputSummary: { reviewReason: 'Verified', report: 'Reviewed the cache; two blockers. (the whole handoff as text)', logTail: '', capturedAt: '2026-10-05T10:00:00Z' },
          }),
        ],
        generatedAt: '2026-10-05T09:00:00Z', lastUpdated: '2026-10-05T09:00:00Z', status: 'approved', runners: ['claude-code'],
        conversationHistory: [{ role: 'user', content: 'review it', timestamp: '2026-10-05T09:00:00Z' }],
      }, 'review it', workspace, { persist: false });
      await session.continueConversation('what did it find?');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
    return (read?.body as { tasks: Record<string, unknown>[] }).tasks;
  }

  it('reads the digest by default, tasks named as the plan names them, and points to the log for the rest; a task saved before handoffs keeps its report', async () => {
    const [legacy, reviewed] = await readBoth({ tasks: ['#1', '#2'] });

    expect(reviewed.handoff).toEqual({
      summary: 'Reviewed the cache; two blockers.',
      findings: [{ id: 'F1', severity: 'blocker', title: 'Entries never expire', detail: 'get() ignores the TTL.', evidence: [{ kind: 'task', task: '#1', finding: 'F2' }, { kind: 'file', path: 'src/cache.ts', line: 12 }] }],
      findingCount: 30,
      artifacts: [{ kind: 'commit', sha: 'a1b2c3d' }],
      rest: 'Findings F2 to F30 and the report are in the attempt\'s log: read them with task_output.',
    });
    // The handoff carries what the report said; the summary keeps only how it ended.
    expect(reviewed.outputSummary).toEqual({ reviewReason: 'Verified' });
    expect(legacy.handoff).toBeNull();
    expect(legacy.outputSummary).toEqual({ reviewReason: 'Verified', report: 'Built it.' });
  });
});

describe('edit_plan', () => {
  const ops = [
    { op: 'update', taskId: '#2', changes: { title: 'Wire it in', prompt: 'wire the cache in' } },
    { op: 'add', task: { title: 'Docs', dependencies: ['#2'], assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4' } } },
  ];

  it('commits an edit made through it; the same ops as a taskOps reply are shown as prose and change nothing', async () => {
    const viaTool = await planThen(async (mcp) => {
      expect(await call(mcp!, 'edit_plan', { ops })).toEqual({ isError: false, body: expect.objectContaining({ ok: true }) });
      return 'Done.';
    });
    const asText = JSON.stringify({ taskOps: ops });
    const viaText = await planThen(async () => asText);
    const before = landed(viaText);

    await viaTool.session.continueConversation('EDIT NOW');
    await viaText.session.continueConversation('EDIT NOW');

    expect(viaTool.session.planTasks.map((t) => t.title)).toEqual(['Task a', 'Wire it in', 'Docs']);
    expect(landed(viaText)).toEqual({ ...before, last: asText });
  });

  it('lands an accepted edit when the reply after it is prose', async () => {
    const planner = await planThen(async (mcp) => {
      await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#2', changes: { title: 'Renamed' } }] });
      return 'I renamed the second task. Here is roughly what changed: {"title": "Renamed"}';
    });

    await planner.session.continueConversation('EDIT NOW');

    expect(planner.session.planTasks.map((t) => t.title)).toEqual(['Task a', 'Renamed']);
    const history = planner.session.planState?.conversationHistory ?? [];
    expect(history.at(-2)?.content).toBe('Tasks updated:\n- Updated "Task b" (title)');
    expect(history.at(-1)?.content).toMatch(/^I renamed the second task/);
  });

  it('names what is wrong with each op and changes nothing', async () => {
    let refused: { isError: boolean; body: unknown } | undefined;
    const planner = await planThen(async (mcp) => {
      refused = await call(mcp!, 'edit_plan', {
        ops: [
          { op: 'update', taskId: '#2', changes: { title: 'Fine' } },
          { op: 'update', taskId: '#2', changes: { assignedRunner: 'codex' } },
        ],
      });
      return 'That did not work.';
    });
    const before = landed(planner);

    await planner.session.continueConversation('EDIT NOW');

    expect(refused).toEqual({
      isError: true,
      body: {
        ok: false,
        errors: [{ op: 2, kind: 'update', message: 'Task "Fine" has invalid assignedRunner "codex". Expected one of: claude-code' }],
      },
    });
    expect(planner.session.planTasks.map((t) => t.title)).toEqual(['Task a', 'Task b']);
    expect({ ...landed(planner), last: undefined }).toEqual({ ...before, last: undefined });
    expect(landed(planner).planBroadcasts).toBe(before.planBroadcasts);
  });

  it('takes a task onto a runner enabled since planning started (#69)', async () => {
    const planner = await planThen(async (mcp) => {
      await call(mcp!, 'edit_plan', {
        ops: [{ op: 'update', taskId: '#2', changes: { assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' } } }],
      });
      return 'Moved it to codex.';
    });

    planner.settings({ enabledRunners: ['claude-code', 'codex'] });
    await planner.session.continueConversation('EDIT NOW');

    expect(planner.session.planTasks.map((t) => t.assignedRunner)).toEqual(['claude-code', 'codex']);
    expect(planner.session.planState?.runners).toEqual(['claude-code', 'codex']);
  });

  it('commits each call of one reply as a batch of its own, the second against the plan the first left', async () => {
    let second: { isError: boolean; body: unknown } | undefined;
    const planner = await planThen(async (mcp) => {
      await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#1', changes: { title: 'First' } }] });
      second = await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#2', changes: { title: 'Second' } }] });
      return 'Renamed both.';
    });

    await planner.session.continueConversation('EDIT NOW');

    expect(second?.body).toEqual(expect.objectContaining({ ok: true, summary: ['Updated "Task b" (title)'] }));
    expect(planner.session.planTasks.map((t) => t.title)).toEqual(['First', 'Second']);
    expect((planner.session.planState?.conversationHistory ?? []).filter((m) => m.content.startsWith('Tasks updated:')).map((m) => m.content)).toEqual([
      'Tasks updated:\n- Updated "Task a" (title)',
      'Tasks updated:\n- Updated "Task b" (title)',
    ]);
  });

  it('refuses before a plan exists, pointing at submit_plan', async () => {
    let refused: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        refused = await call(mcp!, 'edit_plan', { ops: [{ op: 'add', task: { title: 'Too early' } }] });
        return 'Hm.';
      },
    }));

    await session.startPlanning('add a cache', ['claude-code']);

    expect(refused).toEqual({ isError: true, body: { ok: false, errors: [{ message: expect.stringContaining('submit_plan') }] } });
    expect(session.planTasks).toEqual([]);
  });

  describe('while a task of the plan is running', () => {
    it('refuses an edit that reaches it, saying what would be accepted, and lands none of it', async () => {
      const edit = [{ op: 'update', taskId: '#1', changes: { title: 'Setup, renamed' } }];
      let answered: { isError: boolean; body: unknown } | undefined;
      const planner = await runningPlan(async (mcp) => {
        answered = await call(mcp!, 'edit_plan', { ops: edit });
        return 'Task 1 is running: stop it first, or I can rename it once it finishes.';
      });

      await planner.session.continueConversation('EDIT NOW');

      expect(answered).toEqual({
        isError: true,
        body: { ok: false, errors: [{ op: 1, kind: 'update', message: expect.stringMatching(/is running and cannot be modified now: the user can stop it first, or change it after it finishes/) }] },
      });
      expect(planner.session.planTasks[0].title).toBe('Task a');
      expect(landed(planner).last).toBe('Task 1 is running: stop it first, or I can rename it once it finishes.');
    });
  });
});

/** A plan whose first task is on Codex, then Codex switched off: it stays in the plan's runners, and out of the enabled list. */
async function codexSwitchedOff(second: (mcp: Client | null, message: string) => Promise<string>) {
  let planned = false;
  const planner = plannerSession(fakeClaude({
    turn: async (mcp, message) => {
      if (planned) return second(mcp, message);
      planned = true;
      return submitted(mcp, [planTask('a', 1, 'codex', 'gpt-5'), planTask('b', 2, 'claude-code', 'claude-sonnet-4')]);
    },
  }), { enabledRunners: ['claude-code', 'codex', 'opencode'] });
  await planner.session.startPlanning('add a cache', ['codex', 'claude-code']);
  planner.settings({ enabledRunners: ['claude-code', 'opencode'] });
  return planner;
}

describe('edit_plan after a runner is switched off that the plan once used', () => {
  const OFF = /invalid assignedRunner "codex"\. Expected one of: claude-code, opencode/;
  const stale: [string, Record<string, unknown>[]][] = [
    ['an added task naming it', [{ op: 'add', task: { title: 'New', assignedRunner: 'codex' } }]],
    ['a task moved onto it', [{ op: 'update', taskId: '#2', changes: { assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' } } }]],
    ['a split part that inherits it', [{ op: 'split', taskId: '#1', parts: [{ title: 'One' }, { title: 'Two' }] }]],
  ];

  it.each(stale)('refuses %s, though list_runners shows the planner only the enabled runners', async (_name, ops) => {
    let listed: unknown;
    let refused: { isError: boolean; body: unknown } | undefined;
    const planner = await codexSwitchedOff(async (mcp) => {
      listed = (await call(mcp!, 'list_runners')).body;
      refused = await call(mcp!, 'edit_plan', { ops });
      return 'That did not work.';
    });
    const before = landed(planner);

    await planner.session.continueConversation('EDIT NOW');

    expect((listed as { runners: { id: string }[] }).runners.map((r) => r.id)).toEqual(['claude-code', 'opencode']);
    expect(refused?.isError).toBe(true);
    expect((refused?.body as { errors: { message: string }[] }).errors[0].message).toMatch(OFF);
    expect(planner.session.planTasks.map((t) => [t.title, t.assignedRunner])).toEqual([['Task a', 'codex'], ['Task b', 'claude-code']]);
    expect(landed(planner).planBroadcasts).toBe(before.planBroadcasts);
  });

  it('puts an added task that names no runner on an enabled one', async () => {
    const planner = await codexSwitchedOff(async (mcp) => {
      await call(mcp!, 'edit_plan', { ops: [{ op: 'add', task: { title: 'Docs' } }] });
      return 'Added docs.';
    });

    await planner.session.continueConversation('EDIT NOW');

    expect(planner.session.planTasks.find((t) => t.title === 'Docs')?.assignedRunner).toBe('claude-code');
  });

  it('keeps an edit committed while the runner was on, which switching it off later in the reply does not undo', async () => {
    let accepted: { isError: boolean; body: unknown } | undefined;
    const planner = await codexSwitchedOff(async (mcp) => {
      accepted = await call(mcp!, 'edit_plan', { ops: [{ op: 'add', task: { title: 'Docs', assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' } } }] });
      planner.settings({ enabledRunners: ['claude-code', 'opencode'] });
      return 'Added docs on codex.';
    });
    planner.settings({ enabledRunners: ['claude-code', 'codex', 'opencode'] });

    await planner.session.continueConversation('EDIT NOW');

    expect(accepted?.isError).toBe(false);
    expect(planner.session.planTasks.map((t) => [t.title, t.assignedRunner])).toEqual([['Task a', 'codex'], ['Task b', 'claude-code'], ['Docs', 'codex']]);
  });

  it('still lands an edit that leaves the task on it alone, or moves it off', async () => {
    const answers: { isError: boolean; body: unknown }[] = [];
    const planner = await codexSwitchedOff(async (mcp) => {
      answers.push(await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#1', changes: { title: 'Renamed' } }] }));
      answers.push(await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#2', changes: { title: 'Second' } }] }));
      return 'Renamed both.';
    });

    await planner.session.continueConversation('EDIT NOW');

    expect(answers.map((a) => a.isError)).toEqual([false, false]);
    expect(planner.session.planTasks.map((t) => [t.title, t.assignedRunner])).toEqual([['Renamed', 'codex'], ['Second', 'claude-code']]);

    const moved = await codexSwitchedOff(async (mcp) => {
      await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#1', changes: { assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4' } } }] });
      return 'Moved it.';
    });
    await moved.session.continueConversation('EDIT NOW');
    expect(moved.session.planTasks.map((t) => t.assignedRunner)).toEqual(['claude-code', 'claude-code']);
  });
});

/**
 * Every rule a planned task is held to, met the same way whether the task
 * arrives in a whole plan or in an edit, subtasks included.
 */
describe('one intake for submit_plan and edit_plan', () => {
  type Answer = { isError: boolean; body: unknown };

  async function viaSubmit(tasks: unknown[], settings: Partial<SessionRuntimeSettings> = {}) {
    let answer: Answer | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        answer = await call(mcp!, 'submit_plan', { tasks });
        return 'Submitted.';
      },
    }), settings);
    await session.startPlanning('add a cache', ['claude-code']);
    return { answer: answer!, tasks: session.planTasks };
  }

  async function viaEdit(ops: unknown[], settings: Partial<SessionRuntimeSettings> = {}) {
    let answer: Answer | undefined;
    const planner = await planThen(async (mcp) => {
      answer = await call(mcp!, 'edit_plan', { ops });
      return 'Done.';
    }, settings);
    await planner.session.continueConversation('EDIT NOW');
    return { answer: answer!, tasks: planner.session.planTasks };
  }

  const errorsOf = (answer: Answer) => (answer.body as { errors?: { op?: number; message: string }[] }).errors ?? [];
  const sub = (title: string, extra: Record<string, unknown> = {}) => ({ title, type: 'ai', sliceType: 'AFK', autonomy: 'AFK', ...extra });

  it('refuses a task or subtask on a runner that is not enabled, never moving it to another', async () => {
    const submit = await viaSubmit([planTask('a', 1, 'claude-code', 'claude-sonnet-4', { subtasks: [sub('Child', { assignedRunner: 'nope' })] })]);
    const editSub = await viaEdit([{ op: 'add', task: { title: 'Docs', subtasks: [sub('Child', { assignedRunner: 'nope' })] } }]);
    const editTop = await viaEdit([{ op: 'add', task: { title: 'Docs', assignedRunner: 'nope' } }]);

    expect(submit.answer.isError).toBe(true);
    expect(errorsOf(submit.answer).map((e) => e.message)).toEqual(['subtask "Child" of "Task a" has invalid assignedRunner "nope". Expected one of: claude-code']);
    expect(submit.tasks).toEqual([]);
    expect(errorsOf(editSub.answer)).toEqual([{ op: 1, kind: 'add', message: 'subtask "Child" of "Docs" has invalid assignedRunner "nope". Expected one of: claude-code' }]);
    expect(errorsOf(editTop.answer)).toEqual([{ op: 1, kind: 'add', message: 'Task "Docs" has invalid assignedRunner "nope". Expected one of: claude-code' }]);
    expect(editSub.tasks.map((t) => t.title)).toEqual(['Task a', 'Task b']);
    expect(editTop.tasks.map((t) => t.title)).toEqual(['Task a', 'Task b']);
  });

  it('gives every task an id of its own: a plan may not repeat one, an omitted one is made up, an edit\'s are Ordewell\'s', async () => {
    const repeated = await viaSubmit([planTask('a', 1, 'claude-code', 'claude-sonnet-4', { subtasks: [sub('Child', { id: 'a' })] })]);
    const omitted = await viaSubmit([1, 2].map((order) => ({ ...planTask('x', order, 'claude-code', 'claude-sonnet-4'), id: undefined })));
    const edit = await viaEdit([{ op: 'add', task: { id: 'a', title: 'Docs', subtasks: [sub('Child', { id: 'b' })] } }]);

    expect(errorsOf(repeated.answer).map((e) => e.message)).toEqual([
      'subtask "Child" of "Task a" has id "a", which another task in the plan has too: every task, subtasks included, needs an id of its own',
    ]);
    expect(omitted.answer.isError).toBe(false);
    expect(new Set(omitted.tasks.map((t) => t.id)).size).toBe(2);
    expect(edit.answer.isError).toBe(false);
    expect(new Set(flattenTasks(edit.tasks).map((t) => t.id)).size).toBe(4);
  });

  it('holds every dependency, subtasks\' included, to a task in the plan, resolving an added subtask\'s refs', async () => {
    const submit = await viaSubmit([planTask('a', 1, 'claude-code', 'claude-sonnet-4', { subtasks: [sub('Child', { id: 'c', dependencies: ['zzz'] })] })]);
    const unknown = await viaEdit([{ op: 'add', task: { title: 'Docs', subtasks: [sub('Child', { dependencies: ['zzz'] })] } }]);
    const byRef = await viaEdit([{ op: 'add', task: { title: 'Docs', subtasks: [sub('Child', { dependencies: ['#1'] })] } }]);

    expect(errorsOf(submit.answer).map((e) => e.message)).toEqual(['subtask "Child" of "Task a": Unknown dependency "zzz"']);
    expect(errorsOf(unknown.answer)).toEqual([{ op: 1, kind: 'add', message: 'unknown dependencies of subtask "Child" of "Docs": zzz (task "zzz" not found)' }]);
    expect(byRef.answer.isError).toBe(false);
    expect(byRef.tasks[2].subtasks[0].dependencies).toEqual([byRef.tasks[0].id]);
  });

  it('refuses a dependency cycle, naming the op that closed it', async () => {
    const submit = await viaSubmit([
      planTask('a', 1, 'claude-code', 'claude-sonnet-4', { dependencies: ['b'] }),
      planTask('b', 2, 'claude-code', 'claude-sonnet-4', { dependencies: ['a'] }),
    ]);
    const edit = await viaEdit([
      { op: 'add', task: { title: 'Docs', dependencies: ['#2'] }, handle: 'docs' },
      { op: 'update', taskId: '#1', changes: { dependencies: ['docs'] } },
    ]);

    expect(errorsOf(submit.answer).map((e) => e.message)).toEqual(['Dependency cycle detected: "Task a" → "Task b" → "Task a"']);
    expect(errorsOf(edit.answer)).toEqual([{ op: 2, kind: 'update', message: 'Dependency cycle detected: "Task a" → "Docs" → "Task b" → "Task a"' }]);
    expect(edit.tasks.map((t) => t.title)).toEqual(['Task a', 'Task b']);
  });

  it('holds every task, subtasks included, to its slice: an AFK task has no user steps, a manual one is HITL', async () => {
    const steps = [{ order: 1, instruction: 'Sign it off' }];
    const submit = await viaSubmit([planTask('a', 1, 'claude-code', 'claude-sonnet-4', { subtasks: [sub('Child', { userSteps: steps })] })]);
    const afk = await viaEdit([{ op: 'add', task: { title: 'Docs', autonomy: 'AFK', subtasks: [sub('Child', { userSteps: steps })] } }]);
    const manual = await viaEdit([{ op: 'update', taskId: '#2', changes: { type: 'user', userSteps: steps } }]);
    const manualSub = await viaEdit([{ op: 'add', task: { title: 'Docs', subtasks: [{ title: 'Sign', type: 'user', sliceType: 'AFK', userSteps: steps }] } }]);

    expect(errorsOf(submit.answer).map((e) => e.message)).toEqual(['subtask "Child" of "Task a" has autonomy "AFK" but contains userSteps. AFK tasks must not have user touchpoints.']);
    expect(errorsOf(afk.answer)).toEqual([{ op: 1, kind: 'add', message: 'subtask "Child" of "Docs" has autonomy "AFK" but contains userSteps. AFK tasks must not have user touchpoints.' }]);
    expect(manual.answer.isError).toBe(false);
    expect(manual.tasks[1]).toMatchObject({ type: 'user', sliceType: 'HITL' });
    expect(errorsOf(manualSub.answer)).toEqual([{ op: 1, kind: 'add', message: 'User subtask "Sign" of "Docs" has sliceType "AFK". User tasks must have sliceType "HITL".' }]);
  });

  it('lets only a top-level AI task be an ops task', async () => {
    const manual = { title: 'Sign', type: 'user', sliceType: 'HITL', userSteps: [{ order: 1, instruction: 'Sign it off' }], ops: true };
    const submitSub = await viaSubmit([planTask('a', 1, 'claude-code', 'claude-sonnet-4', { subtasks: [sub('Child', { ops: true })] })]);
    const submitManual = await viaSubmit([planTask('a', 1, 'claude-code', 'claude-sonnet-4'), { ...manual, id: 'b', order: 2 }]);
    const editSub = await viaEdit([{ op: 'add', task: { title: 'Docs', subtasks: [sub('Child', { ops: true })] } }]);
    const editManual = await viaEdit([{ op: 'add', task: manual }]);

    expect(errorsOf(submitSub.answer).map((e) => e.message)).toEqual(['subtask "Child" of "Task a" is a subtask, which runs with its parent: only a top-level task can be an ops task']);
    expect(errorsOf(submitManual.answer).map((e) => e.message)).toEqual(['Task "Sign" is a manual task: only an AI task can be an ops task']);
    expect(errorsOf(editSub.answer)).toEqual([{ op: 1, kind: 'add', message: 'subtask "Child" of "Docs" is a subtask, which runs with its parent: only a top-level task can be an ops task' }]);
    expect(errorsOf(editManual.answer)).toEqual([{ op: 1, kind: 'add', message: 'Task "Sign" is a manual task: only an AI task can be an ops task' }]);
  });

  it('clamps a subtask\'s thinking effort to its model\'s variants, and says so', async () => {
    const opus = { modelId: 'claude-opus-4', modelLabel: 'Opus', thinkingEffort: 'xhigh' };
    const submit = await viaSubmit([planTask('a', 1, 'claude-code', 'claude-sonnet-4', { subtasks: [sub('Child', { id: 'c', assignedModel: opus })] })]);
    const edit = await viaEdit([{ op: 'add', task: { title: 'Docs', subtasks: [sub('Child', { assignedModel: opus })] } }]);

    expect((submit.answer.body as { coerced: unknown }).coerced).toEqual([{ taskId: 'c', title: 'Child', field: 'thinkingEffort', from: 'xhigh', to: 'high' }]);
    expect(submit.tasks[0].subtasks[0].assignedModel?.thinkingEffort).toBe('high');
    // Committed as it answers, so an added task's adjustment names the id it got.
    expect((edit.answer.body as { coerced: unknown }).coerced).toContainEqual({ taskId: edit.tasks[2].subtasks[0].id, title: 'Child', field: 'thinkingEffort', from: 'xhigh', to: 'high' });
    expect(edit.tasks[2].subtasks[0].assignedModel?.thinkingEffort).toBe('high');
  });

  it('holds a subtask\'s model to the allowlist: a plan\'s is moved and named, an edit\'s refused', async () => {
    const settings = { modelAllowlist: { 'claude-code': ['claude-sonnet-4'] } };
    const opus = { modelId: 'claude-opus-4', modelLabel: 'Opus' };
    const submit = await viaSubmit([planTask('a', 1, 'claude-code', 'claude-sonnet-4', { subtasks: [sub('Child', { id: 'c', assignedModel: opus })] })], settings);
    const edit = await viaEdit([{ op: 'add', task: { title: 'Docs', subtasks: [sub('Child', { assignedModel: opus })] } }], settings);

    expect((submit.answer.body as { coerced: unknown }).coerced).toEqual([{ taskId: 'c', title: 'Child', field: 'assignedModel', from: 'claude-opus-4', to: 'claude-sonnet-4' }]);
    expect(submit.tasks[0].subtasks[0].assignedModel?.modelId).toBe('claude-sonnet-4');
    expect(errorsOf(edit.answer)).toEqual([{ op: 1, kind: 'add', message: 'subtask "Child" of "Docs": Model "claude-opus-4" is excluded by the allowlist for runner "claude-code"' }]);
  });

  it('keeps a task\'s thinking effort in one place, its model\'s, which an edit\'s "thinkingEffort" changes', async () => {
    const opus = { modelId: 'claude-opus-4', modelLabel: 'Opus' };
    const submit = await viaSubmit([planTask('a', 1, 'claude-code', 'claude-opus-4', { assignedModel: opus, thinkingEffort: 'high' })]);
    const edit = await viaEdit([
      { op: 'update', taskId: '#2', changes: { assignedModel: opus } },
      { op: 'update', taskId: '#2', changes: { thinkingEffort: 'high' } },
    ]);

    expect(submit.tasks[0].assignedModel?.thinkingEffort).toBe('high');
    expect(edit.answer.isError).toBe(false);
    expect(edit.tasks[1].assignedModel).toMatchObject({ modelId: 'claude-opus-4', thinkingEffort: 'high' });
    expect(edit.tasks[1]).not.toHaveProperty('thinkingEffort');
  });

  it('numbers an edit\'s errors by the call that made them, not by an earlier call\'s ops', async () => {
    let second: Answer | undefined;
    const planner = await planThen(async (mcp) => {
      await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#1', changes: { title: 'First' } }] });
      second = await call(mcp!, 'edit_plan', { ops: [{ op: 'add', task: { title: 'Docs', assignedRunner: 'nope' } }] });
      return 'Done.';
    });
    await planner.session.continueConversation('EDIT NOW');

    expect(errorsOf(second!)).toEqual([{ op: 1, kind: 'add', message: 'Task "Docs" has invalid assignedRunner "nope". Expected one of: claude-code' }]);
    expect(planner.session.planTasks.map((t) => t.title)).toEqual(['First', 'Task b']);
  });

  // Bug: a move kept the old runner's model, and the planner was told nothing.
  it('refills the model of a task moved to another runner from that runner, and says so', async () => {
    const both = { enabledRunners: ['claude-code', 'codex'] };
    const edit = await viaEdit([{ op: 'update', taskId: '#1', changes: { assignedRunner: 'codex' } }], both);

    expect(edit.answer.isError).toBe(false);
    expect(edit.tasks[0]).toMatchObject({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5' } });
    expect((edit.answer.body as { coerced: unknown }).coerced).toContainEqual({ taskId: 'a', title: 'Task a', field: 'assignedModel', from: 'claude-sonnet-4', to: 'gpt-5' });
  });

  it('refills a split part or a merged task that names only another runner, and says so', async () => {
    const both = { enabledRunners: ['claude-code', 'codex'] };
    const split = await viaEdit([{ op: 'split', taskId: '#2', parts: [{ title: 'Half one' }, { title: 'Half two', assignedRunner: 'codex' }] }], both);
    const merge = await viaEdit([{ op: 'merge', taskIds: ['#1', '#2'], merged: { title: 'Both', assignedRunner: 'codex' } }], both);

    expect(split.tasks.map((t) => [t.title, t.assignedRunner, t.assignedModel?.modelId])).toEqual([
      ['Task a', 'claude-code', 'claude-sonnet-4'], ['Half one', 'claude-code', 'claude-sonnet-4'], ['Half two', 'codex', 'gpt-5'],
    ]);
    expect((split.answer.body as { coerced: unknown }).coerced).toEqual([{ taskId: split.tasks[2].id, title: 'Half two', field: 'assignedModel', from: 'claude-sonnet-4', to: 'gpt-5' }]);
    expect(merge.tasks[0]).toMatchObject({ title: 'Both', assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5' } });
    expect((merge.answer.body as { coerced: unknown }).coerced).toEqual([{ taskId: merge.tasks[0].id, title: 'Both', field: 'assignedModel', from: 'claude-sonnet-4', to: 'gpt-5' }]);
  });

  it('refills a submitted task whose model only another runner lists, and says so', async () => {
    const submit = await viaSubmit([planTask('a', 1, 'codex', 'claude-sonnet-4')], { enabledRunners: ['claude-code', 'codex'] });

    expect(submit.tasks[0]).toMatchObject({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5' } });
    expect((submit.answer.body as { coerced: unknown }).coerced).toEqual([{ taskId: 'a', title: 'Task a', field: 'assignedModel', from: 'claude-sonnet-4', to: 'gpt-5' }]);
  });
});

describe('what the planner says around a plan or edit it submits', () => {
  /** A turn as Claude streams it: prose, the tool call, its result, then the reply that ends the turn. */
  async function aroundCall(mcp: Client, emit: (event: unknown) => void, name: string, args: Record<string, unknown>): Promise<void> {
    emit({ type: 'assistant', session_id: 'sess-1', message: { id: 'm0', content: [{ type: 'text', text: 'Updating the plan now.' }] } });
    emit({ type: 'assistant', session_id: 'sess-1', message: { id: 'm0', content: [{ type: 'tool_use', id: 'tu1', name: `mcp__ordewell__${name}`, input: args }] } });
    const answer = await call(mcp, name, args);
    if (answer.isError) throw new Error(`${name} refused: ${JSON.stringify(answer.body)}`);
    emit({ type: 'user', session_id: 'sess-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: JSON.stringify(answer.body) }] }] } });
  }

  const chat = (broadcast: ReturnType<typeof plannerSession>['broadcast']): ConversationView =>
    broadcast.mock.calls.reduce<ConversationView>((view, [msg]) => reduceConversation(view, msg), EMPTY_CONVERSATION);
  // Each broadcast moves the clock on, so a reload orders what the turns said
  // and did as a real session, never two of them in one millisecond, would.
  const ticking = (planner: ReturnType<typeof plannerSession>) => {
    planner.broadcast.mockImplementation(() => { vi.advanceTimersByTime(1000); });
    return planner;
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-18T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());
  // ADR-0017 A1: what the planner said before the call stays ahead of the call's row.
  const timeline = (view: ConversationView) => view.blocks.flatMap((b) => (
    b.type === 'message' ? [`${b.role}: ${b.text}`] : b.type === 'tool' ? [`tool: ${b.headline.name}`] : b.type === 'plan' ? [`plan: ${b.status}`] : []));

  it('stays in the chat where it was said, live and on reload, around an edit_plan call that lands', async () => {
    const planner = ticking(plannerSession(fakeClaude({
      turn: async (mcp, message, emit) => {
        if (!message.includes('EDIT NOW')) return submitted(mcp, TWO_TASKS);
        await aroundCall(mcp!, emit, 'edit_plan', { ops: [{ op: 'update', taskId: '#2', changes: { title: 'Wire it in' } }] });
        return 'Renamed the second task to "Wire it in".';
      },
    })));
    await planner.session.startPlanning('add a cache', ['claude-code']);

    await planner.session.continueConversation('EDIT NOW');

    expect(planner.session.planTasks.map((t) => t.title)).toEqual(['Task a', 'Wire it in']);
    const live = timeline(chat(planner.broadcast));
    expect(live.slice(-5)).toEqual([
      'user: EDIT NOW',
      'planner: Updating the plan now.',
      'tool: mcp__ordewell__edit_plan',
      // Committed as the call answered, so it lands ahead of the reply that followed it.
      'planner: Tasks updated:\n- Updated "Task b" (title)',
      'planner: Renamed the second task to "Wire it in".',
    ]);
    const plan = planner.session.planState!;
    expect(timeline(fromTranscript(plan.conversationHistory, plan.researchLog)).slice(-5)).toEqual(live.slice(-5));
  });

  it('stays in the chat where it was said, live and on reload, around a submit_plan call that lands', async () => {
    const planner = ticking(plannerSession(fakeClaude({
      turn: async (mcp, _message, emit) => {
        await aroundCall(mcp!, emit, 'submit_plan', { tasks: TWO_TASKS });
        return 'Two tasks: the cache, then wiring it in.';
      },
    })));

    await planner.session.startPlanning('add a cache', ['claude-code']);

    expect(planner.session.planTasks).toHaveLength(2);
    const view = chat(planner.broadcast);
    expect(timeline(view)).toEqual([
      'user: add a cache',
      'planner: Updating the plan now.',
      'tool: mcp__ordewell__submit_plan',
      'plan: generated',
      'planner: Two tasks: the cache, then wiring it in.',
    ]);
    const generated = expect.objectContaining({ type: 'plan', status: 'generated', taskCount: 2 });
    expect(view.blocks.find((b) => b.type === 'plan')).toEqual(generated);
    const plan = planner.session.planState!;
    const reloaded = fromTranscript(plan.conversationHistory, plan.researchLog);
    expect(timeline(reloaded)).toEqual(timeline(view));
    expect(reloaded.blocks.find((b) => b.type === 'plan')).toEqual(generated);
  });
});

describe('the read budget of a user message', () => {
  const read = (n: number) => ({ tasks: [`#${(n % 2) + 1}`], fields: ['description'], catalog: n > 1 });
  const LAND = /Do not read again this turn/;
  const noteOf = (r: { body: unknown }) => (r.body as { note?: string }).note;

  it('is shared by the tools: told to land after three reads, refused after six, and fresh for the next message', async () => {
    const answers: { isError: boolean; body: unknown }[] = [];
    const { session } = await planThen(async (mcp, message) => {
      if (message.includes('SECOND')) answers.push(await call(mcp!, 'task_query', { tasks: ['#1'] }));
      else {
        for (let n = 0; n < 6; n++) answers.push(await call(mcp!, ['task_query', 'task_output', 'task_diff'][n % 3], n % 3 === 0 ? read(n) : { task: '#1', lines: n + 1, ...(n === 4 ? { kinds: ['error'] } : {}) }));
        answers.push(await call(mcp!, 'task_query', { tasks: ['#2'] }));
      }
      return 'Read.';
    });

    await session.continueConversation('EDIT NOW');
    await session.continueConversation('EDIT NOW, SECOND');

    expect(answers.slice(0, 3).map(noteOf)).toEqual([undefined, undefined, undefined]);
    expect(answers.slice(3, 6).map(noteOf)).toEqual([expect.stringMatching(LAND), expect.stringMatching(LAND), expect.stringMatching(LAND)]);
    expect(answers[6]).toEqual({ isError: true, body: { ok: false, error: expect.stringContaining('every read this message allows') } });
    expect(noteOf(answers[7])).toBeUndefined();
  });

  it('is not spent by a taskQuery written in the reply, which is shown as prose and answered by nothing', async () => {
    const asText = JSON.stringify({ taskQuery: { tasks: ['#1'], fields: ['description'] } });
    const messages: string[] = [];
    const planner = await planThen(async (_mcp, message) => {
      messages.push(message);
      return asText;
    });

    await planner.session.continueConversation('EDIT NOW');

    expect(messages).toHaveLength(1);
    expect(landed(planner).last).toBe(asText);
  });
});

describe('task_query', () => {
  const longPlan = [
    planTask('a', 1, 'claude-code', 'claude-sonnet-4', { prompt: 'create the cache module in src/cache.ts', description: 'The cache' }),
    planTask('b', 2, 'claude-code', 'claude-sonnet-4', { dependencies: ['a'], userStoriesCovered: ['As a dev I want it fast'] }),
  ];

  async function planAndRead(read: (mcp: Client) => Promise<void>) {
    const planner = plannerSession(fakeClaude({
      turn: async (mcp, message) => {
        if (!message.includes('READ NOW')) return submitted(mcp, longPlan);
        await read(mcp!);
        return 'Read it.';
      },
    }));
    await planner.session.startPlanning('add a cache', ['claude-code']);
    return planner;
  }

  it('answers with the long fields of the tasks it is asked for, and nothing it was not', async () => {
    let answer: { isError: boolean; body: unknown } | undefined;
    const { session } = await planAndRead(async (mcp) => {
      answer = await call(mcp, 'task_query', { tasks: ['#1', 'b', 'nope'], fields: ['prompt', 'userStoriesCovered'] });
    });

    await session.continueConversation('READ NOW');

    expect(answer).toEqual({
      isError: false,
      body: {
        tasks: [
          { id: 'a', ref: '#1', title: 'Task a', status: 'approved', type: 'ai', prompt: 'create the cache module in src/cache.ts', userStoriesCovered: null },
          { id: 'b', ref: '#2', title: 'Task b', status: 'approved', type: 'ai', prompt: 'do b', userStoriesCovered: ['As a dev I want it fast'] },
          { ref: 'nope', error: 'no task matches this reference in the current plan.' },
        ],
      },
    });
  });

  it('with catalog: true, adds the live runners, their models, and whether each takes a read-only task', async () => {
    let answer: { body: unknown } | undefined;
    const { session, settings } = await planAndRead(async (mcp) => {
      answer = await call(mcp, 'task_query', { tasks: ['#1'], fields: ['description'], catalog: true });
    });

    settings({ enabledRunners: ['claude-code', 'codex'] });
    await session.continueConversation('READ NOW');

    const { catalog } = answer!.body as { catalog: { runners: { id: string; models: { modelId: string }[]; readOnly: boolean; modes?: unknown }[] } };
    expect(catalog.runners.map((r) => [r.id, r.models.map((m) => m.modelId)])).toEqual([
      ['claude-code', ['claude-sonnet-4', 'claude-opus-4']],
      ['codex', ['gpt-5']],
    ]);
    expect(catalog.runners.map((r) => [r.readOnly, r.modes])).toEqual([[true, undefined], [true, undefined]]);
  });
});

describe('task_output', () => {
  it('reads the live tail of a running task, and pages on from the offset it reports', async () => {
    const sessions: FakeRunnerSession[] = [];
    const answers: unknown[] = [];
    const { session } = await runningPlan(async (mcp) => {
      answers.push((await call(mcp!, 'task_output', { task: '#1', lines: 2 })).body);
      sessions[0].emitOutput('line 4\nline 5\n');
      answers.push((await call(mcp!, 'task_output', { task: 'a', since: (answers[0] as { nextOffset: number }).nextOffset })).body);
      return 'It is progressing.';
    }, { sessions });
    sessions[0].emitOutput('line 1\nline 2\nline 3\n');

    await session.continueConversation('how is it going?');

    const task = { id: 'a', ref: '#1', title: 'Task a', status: 'in_progress' };
    expect(answers).toEqual([
      { task, running: true, output: 'line 2\nline 3', nextOffset: 21 },
      { task, running: true, output: 'line 4\nline 5', nextOffset: 35 },
    ]);
  });

  it('cuts a count above the cap to the cap, as the envelope does', async () => {
    const sessions: FakeRunnerSession[] = [];
    let answer: { output: string } | undefined;
    const { session } = await runningPlan(async (mcp) => {
      answer = (await call(mcp!, 'task_output', { task: '#1', lines: 5000 })).body as { output: string };
      return 'Read it.';
    }, { sessions });
    sessions[0].emitOutput(Array.from({ length: 450 }, (_, i) => `row ${i + 1}`).join('\n') + '\n');

    await session.continueConversation('how is it going?');

    const rows = answer!.output.trimEnd().split('\n');
    expect(rows).toHaveLength(400);
    expect(rows[0]).toBe('row 51');
  });

  it('answers a task that is not running with its verdict, output summary and last attempt', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-task-output-'));
    let answer: { isError: boolean; body: unknown } | undefined;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp) => {
        answer = await call(mcp!, 'task_output', { task: 'Setup' });
        return 'I see.';
      },
    }));
    try {
      const failed = createTask({
        id: 'a', order: 1, title: 'Setup', prompt: 'p', assignedRunner: 'claude-code', status: 'completed',
        verdict: { outcome: 'pass', reason: 'Completion marker found', decidedAt: '2026-10-05T10:00:00Z', checks: [{ name: 'completion_marker', passed: true, skipped: false, detail: '' }] },
        outputSummary: { reviewReason: 'It finished cleanly', logTail: 'added src/cache.ts', capturedAt: '2026-10-05T10:00:00Z' },
      });
      session.loadPlan({
        tasks: [failed], generatedAt: '2026-10-05T09:00:00Z', lastUpdated: '2026-10-05T09:00:00Z', status: 'approved', runners: ['claude-code'],
        conversationHistory: [{ role: 'user', content: 'set it up', timestamp: '2026-10-05T09:00:00Z' }],
      }, 'set it up', workspace, { persist: false });
      openTaskLog({ baseDir: workspace, sessionId: session.sessionId }, 'a').append([
        { type: 'tool_call', id: 't1', name: 'Bash', args: '{"command":"npm test"}' },
        { type: 'tool_result', id: 't1', output: 'ok', success: true },
        { type: 'text', text: 'The cache is in place.' },
      ]);

      await session.continueConversation('what did it do?');

      expect(answer).toEqual({
        isError: false,
        body: {
          task: { id: 'a', ref: '#1', title: 'Setup', status: 'completed' },
          running: false,
          reason: expect.stringContaining('not running'),
          verdict: { outcome: 'pass', reason: 'Completion marker found', checks: [{ name: 'completion_marker', result: 'pass' }] },
          outputSummary: { reviewReason: 'It finished cleanly', logTail: 'added src/cache.ts' },
          handoff: null,
          lastAttempt: '- Bash {"command":"npm test"} → ok\n\nIts last message:\n  The cache is in place.',
        },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  describe('of a task that ended with a handoff (ADR-0047)', () => {
    const findings = [
      { id: 'F1', severity: 'blocker' as const, title: 'Entries never expire', evidence: [{ kind: 'task' as const, task: 'a' }] },
      { id: 'F2', severity: 'minor' as const, title: 'A stale comment', detail: 'cache.ts:3' },
    ];
    const saved = { summary: 'Reviewed the cache.', findings, findingCount: 2, report: 'The long form.' };

    async function readOutput(args: Record<string, unknown>) {
      const workspace = mkdtempSync(join(tmpdir(), 'ordewell-task-output-handoff-'));
      let answer: { isError: boolean; body: unknown } | undefined;
      const { session } = plannerSession(fakeClaude({
        turn: async (mcp) => {
          answer = await call(mcp!, 'task_output', args);
          return 'I see.';
        },
      }));
      try {
        session.loadPlan({
          tasks: [
            createTask({ id: 'a', order: 1, title: 'Build', prompt: 'p', assignedRunner: 'claude-code', status: 'completed' }),
            createTask({
              id: 'b', order: 2, title: 'Review', prompt: 'p', assignedRunner: 'claude-code', status: 'completed', dependencies: ['a'],
              handoff: { summary: saved.summary, findings: [findings[0]], findingCount: 2 },
              outputSummary: { reviewReason: 'Verified', report: 'The handoff, as one text.', logTail: '', capturedAt: '2026-10-05T10:00:00Z' },
            }),
          ],
          generatedAt: '2026-10-05T09:00:00Z', lastUpdated: '2026-10-05T09:00:00Z', status: 'approved', runners: ['claude-code'],
          conversationHistory: [{ role: 'user', content: 'review it', timestamp: '2026-10-05T09:00:00Z' }],
        }, 'review it', workspace, { persist: false });
        openTaskLog({ baseDir: workspace, sessionId: session.sessionId }, 'b').append([
          { type: 'text', text: 'Reviewed.' },
          { type: 'handoff', handoff: saved },
        ]);
        await session.continueConversation('what did it find?');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
      return answer!.body as Record<string, unknown>;
    }

    it('answers with every finding and the report, read from its attempt\'s log, the tasks it cites named by reference', async () => {
      const body = await readOutput({ task: '#2' });

      expect(body.handoff).toEqual({
        summary: 'Reviewed the cache.',
        findings: [{ ...findings[0], evidence: [{ kind: 'task', task: '#1' }] }, findings[1]],
        findingCount: 2,
        report: 'The long form.',
      });
      expect(body.outputSummary).toEqual({ reviewReason: 'Verified' });
    });

    it('takes a pinned reference as a run update shows it, and reads the attempt it names (ADR-0057 R1)', async () => {
      const body = await readOutput({ task: '#2@1/F1', kinds: ['handoff'] });

      expect(body.attempt).toBe(1);
      expect(body.output).toContain('Reviewed the cache.');
    });

    it('renders the handoff event whole in a read of the saved log', async () => {
      const body = await readOutput({ task: '#2', kinds: ['handoff'] });

      expect(body.output).toBe([
        '[2 handoff] Reviewed the cache.',
        '',
        'Findings:',
        '- F1 [blocker] Entries never expire',
        '  Evidence: a',
        '- F2 [minor] A stale comment',
        '  cache.ts:3',
        '',
        'Report:',
        'The long form.',
        '',
      ].join('\n'));
    });
  });

  it('names a task that is not in the plan', async () => {
    let answer: { isError: boolean; body: unknown } | undefined;
    const { session } = await planThen(async (mcp) => {
      answer = await call(mcp!, 'task_output', { task: '#9' });
      return 'Hm.';
    });

    await session.continueConversation('look at #9');

    expect(answer).toEqual({ isError: true, body: { ok: false, error: 'No task matches "#9" in the current plan.' } });
  });
});

describe('a submission whose planner turn ends while its skill check runs', () => {
  const context = { signal: new AbortController().signal };

  /** A host whose git check the test releases, with the open turn swapped while it waits. */
  function heldHost() {
    const state = { turn: 'turn-1' as string | undefined, release: () => {} };
    const asked = vi.fn();
    const tdd: SkillInfo = {
      name: 'tdd', description: 'tdd', metadata: { name: 'tdd', description: 'tdd' }, content: '', path: '/g/tdd/SKILL.md', source: 'global', appliesTo: 'task', modelInvocable: false, userInvocable: true,
    };
    const lookup: SkillLookup = {
      findSkill: (name) => (name === 'tdd' ? tdd : undefined),
      searchedDirs: () => [],
      uncommitted: () => new Promise((resolve) => {
        asked();
        state.release = () => resolve(new Map());
      }),
    };
    const host: PlannerToolsHost = {
      skills: () => [],
      turnId: () => state.turn,
      recordSkillLoad: () => false,
      liveCatalog: async () => ({ runners: ['claude-code'], models: { 'claude-code': [{ modelId: 'claude-sonnet-4', modelLabel: 'Sonnet', variants: [] }] }, modes: {}, autonomousDefault: true }),
      checkPlan: (tasks) => new PlanChangeCheck({ ...requestScope({ runners: ['claude-code'] }), skills: () => lookup }).check({ kind: 'plan', tasks }, 'submit'),
      submitPlan: vi.fn(async () => ({ ok: true as const, summary: [], tasks: [] })),
      editPlan: vi.fn(async () => ({ ok: true as const, summary: [], tasks: [] })),
      tasks: () => [],
      read: async (_signature, answerRead) => ({ status: 'answered', value: await answerRead(), landNow: false }),
      liveOutput: () => null,
      lastAttempt: () => null,
      taskLogAttempts: () => [],
      taskLog: () => [],
      taskDiff: async () => ({ available: false, reason: 'not available' }),
      runCommand: async () => ({ success: true, output: '', truncated: false }),
      fetchUrl: async () => ({ success: true, output: '', truncated: false }),
      webSearch: async () => undefined,
      execute: vi.fn(),
      editsRefused: () => undefined,
    };
    return { host, state, asked, handler: plannerToolHandler(host) };
  }

  it('hands submit_plan\'s plan to no turn, rather than to the one opened since', async () => {
    const { host, state, asked, handler } = heldHost();

    const call = handler.submitPlan!({ tasks: [planTask('a', 1, 'claude-code', 'claude-sonnet-4', { skills: ['tdd'] })] } as SubmitPlanArgs, context);
    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    state.turn = 'turn-2';
    state.release();

    expect(await call).toEqual({ isError: true, text: expect.stringContaining(PLANNER_TURN_ENDED) });
    expect(host.submitPlan).not.toHaveBeenCalled();
  });

});

describe('task references in the read tools', () => {
  const context = { signal: new AbortController().signal };
  const plan = [
    createTask({
      id: 'a', order: 1, title: 'Setup',
      subtasks: [createTask({ id: 'a1', order: 1, title: 'Config' }), createTask({ id: 'a2', order: 2, title: 'Seed' })],
    }),
    createTask({ id: 'b', order: 2, title: 'Build' }),
  ];
  const handler = plannerToolHandler({
    skills: () => [],
    turnId: () => 'turn-1',
    recordSkillLoad: () => false,
    liveCatalog: async () => ({ runners: ['claude-code'], models: {}, modes: {}, autonomousDefault: true }),
    checkPlan: async () => { throw new Error('not used here'); },
    submitPlan: async () => ({ ok: true as const, summary: [], tasks: [] }),
    editPlan: async () => ({ ok: true as const, summary: [], tasks: [] }),
    tasks: () => plan,
    read: async (_signature, answerRead) => ({ status: 'answered', value: await answerRead(), landNow: false }),
    liveOutput: () => null,
    lastAttempt: () => null,
    taskLogAttempts: (taskId) => (taskId === 'gone' ? [1, 2] : []),
    taskLog: (taskId, attempt) => (taskId === 'gone' && attempt === 2 ? [{ type: 'text', text: 'the race' }] : []),
    taskDiff: async () => ({ available: false, reason: 'not available' }),
    runCommand: async () => ({ success: true, output: '', truncated: false }),
    fetchUrl: async () => ({ success: true, output: '', truncated: false }),
    webSearch: async () => undefined,
    execute: async () => ({ ok: true, message: '' }),
    editsRefused: () => undefined,
  });

  it('reads #2 as top-level task 2 once task 1 has subtasks, and a subtask by its dotted label', async () => {
    const reply = await handler.taskQuery!({ tasks: ['#2', '#1.2'], fields: ['description'] }, context);
    const body = JSON.parse(reply.text) as { tasks: { id: string }[] };
    expect(body.tasks.map((t) => t.id)).toEqual(['b', 'a2']);

    const output = await handler.taskOutput!({ task: '#2' }, context);
    expect(JSON.parse(output.text).task.id).toBe('b');
  });

  it('names a subtask by its dotted reference, never by its order under the parent', async () => {
    const reply = await handler.taskQuery!({ tasks: ['#1.2'], fields: ['description'] }, context);
    expect(JSON.parse(reply.text).tasks[0]).toMatchObject({ id: 'a2', ref: '#1.2' });
    expect(JSON.parse(reply.text).tasks[0]).not.toHaveProperty('order');

    const output = await handler.taskOutput!({ task: '#1.2' }, context);
    expect(JSON.parse(output.text).task).toEqual({ id: 'a2', ref: '#1.2', title: 'Seed', status: 'pending' });
  });

  it('reads a pinned attempt of a task removed from the plan from its log (ADR-0057 R1)', async () => {
    const output = await handler.taskOutput!({ task: 'gone@2/F1' }, context);

    expect(output.isError).toBeUndefined();
    expect(JSON.parse(output.text)).toMatchObject({ task: { id: 'gone', removed: true }, attempt: 2, attempts: [1, 2] });
    expect(output.text).toContain('the race');
    expect((await handler.taskOutput!({ task: 'gone', attempt: 2 }, context)).isError).toBeUndefined();
  });

  it('reads the latest of a removed task with no attempt pinned, and refuses one its log does not hold', async () => {
    expect((await handler.taskOutput!({ task: 'gone' }, context)).isError).toBeUndefined();
    expect((await handler.taskOutput!({ task: 'gone@3' }, context)).isError).toBe(true);
    expect((await handler.taskOutput!({ task: 'never-there' }, context)).isError).toBe(true);
  });
});

describe('a one-shot coding-agent planner', () => {
  it('requires attached tools, accepts submit_plan, and revokes its token when done', async () => {
    const server = newServer();
    let config: InjectedServer | null = null;
    const spawned = fakeClaude({ turn: async (client) => {
      if (!client) throw new Error('expected attached tools');
      config = injectedServer(spawned.lastArgs());
      const reply = await client.callTool({ name: 'submit_plan', arguments: JSON.parse(planJson()) });
      expect(reply.isError).not.toBe(true);
      return 'Plan submitted.';
    } });
    const tasks = await service(spawned, server).generatePlanDirect('Add a cache', ['claude-code']);

    expect(tasks).toHaveLength(1);
    expect(spawned.processes[0].killed).toBe(true);
    expect(config).not.toBeNull();
    const client = new Client({ name: 'stale-planner', version: '0' });
    clients.push(client);
    await expect(client.connect(new StreamableHTTPClientTransport(new URL(config!.url), { requestInit: { headers: config!.headers } }))).rejects.toThrow();
  });

  it('fails after one respawn without sending the planning request', async () => {
    const spawned = fakeClaude({ status: 'failed' });
    await expect(service(spawned, newServer()).generatePlanDirect('Add a cache', ['claude-code'])).rejects.toThrow('MCP server connected');
    expect(spawned.processes).toHaveLength(2);
    expect(spawned.processes.every((process) => process.killed)).toBe(true);
    expect(spawned.processes.flatMap((process) => process.written).some((line) => JSON.parse(line).type === 'user')).toBe(false);
  });
});

describe('saved attempt reads through MCP', () => {
  interface Page { output: string; nextOffset: number; hasMore: boolean; attempt: number; attempts: number[] }

  async function withLogs(turn: (client: Client) => Promise<void>, over: Partial<Task> = {}) {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-attempt-read-'));
    const { session } = plannerSession(fakeClaude({ turn: async (mcp) => { await turn(mcp!); return 'Read it.'; } }));
    session.loadPlan({
      tasks: [createTask({ id: 'a', order: 1, title: 'Setup', assignedRunner: 'claude-code', status: 'failed', ...over })],
      generatedAt: '2026-10-05T09:00:00Z', lastUpdated: '2026-10-05T09:00:00Z', status: 'approved', runners: ['claude-code'],
      conversationHistory: [{ role: 'user', content: 'set it up', timestamp: '2026-10-05T09:00:00Z' }],
    }, 'set it up', workspace, { persist: false });
    const location = { baseDir: workspace, sessionId: session.sessionId };
    openTaskLog(location, 'a').append([
      { type: 'tool_call', id: 'call1', name: 'Bash', args: '{"command":"npm test"}' },
      { type: 'tool_result', id: 'call1', output: 'failed', success: false },
      { type: 'error', message: 'first attempt error' },
      { type: 'text', text: 'first message' },
      { type: 'approval_requested', approvalId: 'approval1', tool: 'Bash', args: '{}', allowForTask: false },
      { type: 'usage', record: { source: 'codex', inputTokens: 100, outputTokens: 20 } },
    ]);
    openTaskLog(location, 'a').append([
      { type: 'error', message: 'latest attempt error' },
      { type: 'text', text: 'start-' + 'x'.repeat(24000) + '-end' },
    ]);
    try { await session.continueConversation('read the attempts'); }
    finally { rmSync(workspace, { recursive: true, force: true }); }
  }

  it('selects an earlier attempt and filters by event kinds; omitting attempt selects the latest', async () => {
    const pages: Page[] = [];
    await withLogs(async (mcp) => {
      pages.push((await call(mcp, 'task_output', { task: '#1', attempt: 1, kinds: ['tool_call', 'approval_requested', 'usage'] })).body as Page);
      pages.push((await call(mcp, 'task_output', { task: 'Setup', kinds: ['error'] })).body as Page);
    });
    expect(pages[0]).toMatchObject({ attempt: 1, attempts: [1, 2], hasMore: false });
    expect(pages[0].output).toContain('Bash {"command":"npm test"}');
    expect(pages[0].output).toContain('approval_requested');
    expect(pages[0].output).toContain('inputTokens=100');
    expect(pages[0].output).not.toContain('first message');
    expect(pages[0].output).not.toContain('tool_result');
    expect(pages[1]).toMatchObject({ attempt: 2, output: '[1 error] latest attempt error\n' });
  });

  it('pages the remainder of a long entry instead of permanently discarding it', async () => {
    const pages: Page[] = [];
    await withLogs(async (mcp) => {
      let since = 0;
      do {
        const page = (await call(mcp, 'task_output', { task: 'a', attempt: 2, kinds: ['text'], since })).body as Page;
        pages.push(page);
        since = page.nextOffset;
      } while (pages.at(-1)!.hasMore);
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].output).toContain(`[truncated; continue with since: ${pages[0].nextOffset}]`);
    expect(pages.map((p) => p.output.replace(/\n\[truncated; continue with since: \d+\]$/, '')).join('')).toBe('[2 text] start-' + 'x'.repeat(24000) + '-end\n');
  });

  it('reads the plan\'s digest for a pinned attempt no saved log holds', async () => {
    const digest = storedHandoff({ summary: 'Found it.', findings: [{ severity: 'major', title: 'The race' }] })!;
    let answer: { isError: boolean; body: unknown } | undefined;
    await withLogs(async (mcp) => {
      answer = await call(mcp, 'task_output', { task: '#1@7/F1' });
    }, { handoff: { ...digest, attempt: 7 } });

    expect(answer).toMatchObject({ isError: false, body: { attempt: 7, attempts: [1, 2], handoff: { summary: 'Found it.' } } });
  });

  it('reports missing attempts and shared-run diffs clearly, with no filesystem paths disclosed', async () => {
    const answers: { isError: boolean; body: unknown }[] = [];
    await withLogs(async (mcp) => {
      answers.push(await call(mcp, 'task_output', { task: '#1', attempt: 9 }));
      answers.push(await call(mcp, 'task_diff', { task: '#1' }));
      answers.push(await call(mcp, 'task_diff', { task: '#9' }));
    });
    expect(answers[0]).toEqual({ isError: true, body: { ok: false, error: 'No saved log for attempt 9.', attempts: [1, 2] } });
    expect(answers[1]).toMatchObject({ isError: true, body: { error: expect.stringContaining('not available for this run') } });
    expect(answers[2]).toMatchObject({ isError: true, body: { error: expect.stringContaining('No task matches') } });
    expect(JSON.stringify(answers)).not.toContain('.ordewell/sessions');
  });
});

describe('task_diff through the planner handler', () => {
  it('pages a kept isolated task file list and single-file patch through MCP', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-task-diff-handler-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
    const iso = createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' });
    const answers: Array<{ output: string; nextOffset: number; hasMore: boolean }> = [];
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.com');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(workspace, 'a.txt'), 'before\n');
      git('add', '.');
      git('commit', '-q', '-m', 'initial');
      const run = await iso.startRun(workspace);
      const task = createTask({ id: 'a', order: 1, title: 'Change files', assignedRunner: 'claude-code', status: 'failed' });
      const { cwd } = await iso.prepare(task, run);
      writeFileSync(join(cwd, 'a.txt'), 'after\n');
      writeFileSync(join(cwd, 'b.txt'), 'new\n');
      await iso.release(run, task.id, { keep: true });
      const { session } = plannerSession(fakeClaude({ turn: async (mcp) => {
        answers.push((await call(mcp!, 'task_diff', { task: '#1', lines: 1 })).body as typeof answers[number]);
        answers.push((await call(mcp!, 'task_diff', { task: '#1', lines: 1, since: answers[0].nextOffset })).body as typeof answers[number]);
        answers.push((await call(mcp!, 'task_diff', { task: '#1', repo: '.', path: 'a.txt', lines: 3 })).body as typeof answers[number]);
        answers.push((await call(mcp!, 'task_diff', { task: '#1', repo: '.', path: 'a.txt', lines: 400, since: answers[2].nextOffset })).body as typeof answers[number]);
        return 'Read it.';
      } }), {}, { isolation: iso });
      session.loadPlan({ tasks: [task], generatedAt: '2026-10-05T09:00:00Z', lastUpdated: '2026-10-05T09:00:00Z', status: 'approved', runners: ['claude-code'], isolation: { run, resolvers: {} },
        conversationHistory: [{ role: 'user', content: 'change files', timestamp: '2026-10-05T09:00:00Z' }],
      }, 'change files', workspace, { persist: false });
      await session.continueConversation('inspect the work');
      expect(answers[0]).toMatchObject({ output: expect.stringContaining('[repo .] a.txt: +1 -1'), hasMore: true });
      expect(answers[1]).toMatchObject({ output: '[repo .] b.txt: +1 -0\n', hasMore: false });
      expect(answers[2].hasMore).toBe(true);
      expect(answers[3]).toMatchObject({ output: expect.stringContaining('+after'), hasMore: false });
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});

describe('a task without saved logs', () => {
  it('answers a structured log request with an explicit refusal', async () => {
    let answer: { isError: boolean; body: unknown } | undefined;
    const { session } = await planThen(async (mcp) => {
      answer = await call(mcp!, 'task_output', { task: '#1', kinds: ['error'] });
      return 'There is no log yet.';
    });
    await session.continueConversation('read errors');
    expect(answer).toEqual({ isError: true, body: { ok: false, error: 'No saved task log is available for this task.', attempts: [] } });
  });
});

describe('run_command, sealed (ADR-0036)', () => {
  const context = { signal: new AbortController().signal };
  const runCommand = vi.fn(async () => ({ success: true, output: '[Ran sealed as asked: …]\n3', truncated: false }));
  const handler = plannerToolHandler({
    skills: () => [],
    turnId: () => 'turn-1',
    recordSkillLoad: () => false,
    liveCatalog: async () => ({ runners: ['claude-code'], models: {}, modes: {}, autonomousDefault: true }),
    checkPlan: async () => { throw new Error('not used here'); },
    submitPlan: async () => ({ ok: true as const, summary: [], tasks: [] }),
    editPlan: async () => ({ ok: true as const, summary: [], tasks: [] }),
    tasks: () => [],
    read: async (_signature, answerRead) => ({ status: 'answered', value: await answerRead(), landNow: false }),
    liveOutput: () => null,
    lastAttempt: () => null,
    taskLogAttempts: () => [],
    taskLog: () => [],
    taskDiff: async () => ({ available: false, reason: 'not available' }),
    runCommand,
    fetchUrl: async () => ({ success: true, output: '', truncated: false }),
    webSearch: async () => undefined,
    execute: async () => ({ ok: true, message: '' }),
    editsRefused: () => undefined,
  });

  it('hands a sealed run to the session only when the planner asks for one, and returns what it said', async () => {
    expect(await handler.runCommand!({ command: 'for f in *; do :; done', sealed: true }, context)).toEqual({ text: '[Ran sealed as asked: …]\n3' });
    await handler.runCommand!({ command: 'git status' }, context);
    expect(runCommand.mock.calls.map((call: unknown[]) => call.slice(2))).toEqual([[{ sealed: true }], []]);
  });

  it('offers `sealed` and says what a sealed run is, for every harness planner', () => {
    const tool = PLANNER_TOOLS.find((t) => t.name === 'run_command')!;
    expect(tool.description).toContain('runs sealed instead: no network, no home directory or credentials');
    expect(Object.keys(tool.inputSchema.properties as Record<string, unknown>)).toEqual(['command', 'sealed']);
    expect(tool.inputSchema.required).toEqual(['command']);
  });
});

// ADR-0012 T10 end to end, on a harness planner: its session keeps every turn,
// so the plan goes whole once, then as what changed, and whole again after the
// agent compacts its context.
describe('the plan block a harness planner is sent', () => {
  const WHOLE = /^<current_plan>$/m;

  it('goes whole once, then as what changed, and whole again after Claude Code compacts its context', async () => {
    const messages: string[] = [];
    let planned = false;
    let compactThisTurn = false;
    const { session } = plannerSession(fakeClaude({
      turn: async (mcp, message, emit) => {
        messages.push(message);
        if (!planned) {
          planned = true;
          return submitted(mcp, TWO_TASKS);
        }
        if (compactThisTurn) emit({ type: 'system', subtype: 'compact_boundary', session_id: 'sess-1', compact_metadata: { trigger: 'auto', pre_tokens: 150_000, post_tokens: 9_000 } });
        return 'Ok.';
      },
    }));
    await session.startPlanning('add a cache', ['claude-code']);

    await session.continueConversation('what is there?');
    await session.continueConversation('anything new?');
    compactThisTurn = true;
    await session.continueConversation('and now?');
    compactThisTurn = false;
    await session.continueConversation('still there?');

    expect(messages).toHaveLength(5);
    expect(messages[1]).toMatch(WHOLE);
    expect(messages[2]).not.toMatch(WHOLE);
    expect(messages[2]).toMatch(/<plan_changes>[^\n]*unchanged/);
    expect(messages[3]).not.toMatch(WHOLE);
    expect(messages[4]).toMatch(WHOLE);
  });
});
