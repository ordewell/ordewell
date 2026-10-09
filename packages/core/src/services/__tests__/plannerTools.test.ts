import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer } from '../mcp';
import type { ConversationRequest } from '../AiService';
import type { SessionRuntimeSettings } from '../createSession';
import type { SessionMessage } from '../SessionMessage';
import type { SkillInfo, SkillsService } from '../SkillsService';
import { createTask, type DiscoveredModel, type Task } from '../../models/Task';
import { openTaskLog } from '../../utils/taskLogStore';
import { FakeTerminalSession, makeSession, saves } from './sessionTestKit';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import { buildConversationSystemPrompt, buildMergePrompt, buildSplitPrompt } from '../PlanPrompts';
import { runnerModesFrom } from '../ModeResolver';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { respondingSpawn, type FakeAgentProcess, type FakeSpawnResult } from './harnessTestKit';

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
  /** What the CLI's own `mcp_status` reports for the Ordewell server. */
  status?: 'connected' | 'failed';
  /** One user turn: what it does with the injected server (absent when none was injected), and the reply text. */
  turn?: (mcp: Client | null, message: string) => Promise<string>;
}

function fakeClaude({ status = 'connected', turn = async () => 'What should it do?' }: FakeClaude = {}): FakeSpawnResult {
  return respondingSpawn((written, proc, args) => {
    const msg = JSON.parse(written) as { type: string; request_id?: string; request?: { subtype?: string }; message?: { content: { text: string }[] } };
    if (msg.type === 'control_request' && msg.request?.subtype === 'mcp_status') {
      const mcpServers = injectedServer(args) ? [{ name: 'ordewell', status }] : [];
      proc.emitStdout(line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mcpServers } } }));
      return;
    }
    if (msg.type !== 'user') return;
    void (async () => {
      const mcp = injectedServer(args) && status === 'connected' ? await connectAs(args) : null;
      return turn(mcp, msg.message?.content[0]?.text ?? '');
    })().then(
      (text) => reply(proc, text),
      (err: unknown) => reply(proc, `The fake planner failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  });
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
      'mcp__ordewell__edit_plan', 'mcp__ordewell__task_query', 'mcp__ordewell__task_output',
      'mcp__ordewell__load_skill',
    ]);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
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
  it('is respawned with today\'s prompt and no server when the CLI reports the connection failed', async () => {
    const server = newServer();
    const withTools = fakeClaude({ status: 'failed' });
    const svc = service(withTools, server);
    await svc.startConversation(request());

    const without = fakeClaude();
    await service(without).startConversation(request());

    expect(withTools.processes).toHaveLength(2);
    expect(withTools.processes[0].killed).toBe(true);
    expect(withTools.lastArgs()).toEqual(without.lastArgs());
    expect(svc.plannerToolsAttached()).toBe(false);
  });

  it('is spawned exactly as before when the session has no server to offer', async () => {
    const spawned = fakeClaude();
    const svc = service(spawned);
    await svc.startConversation(request());

    expect(spawned.lastArgs()).not.toContain('--mcp-config');
    expect(spawned.lastArgs()).not.toContain('--allowedTools');
    expect(svc.plannerToolsAttached()).toBe(false);
  });
});

/** A planning session on a real harness planner, whose settings the test rewrites the way a settings write would. */
function plannerSession(claude: FakeSpawnResult, initial: Partial<SessionRuntimeSettings> = {}, { inject = true, runner, skills = [], skillsService }: { inject?: boolean; runner?: ITerminalRunner; skills?: SkillInfo[]; skillsService?: Pick<SkillsService, 'findSkill' | 'listSkills'> } = {}) {
  const server = newServer();
  let settings: SessionRuntimeSettings = { enabledRunners: ['claude-code'], ...initial };
  const ai = service(claude, inject ? server : undefined);
  const broadcast = vi.fn<(msg: SessionMessage) => void>();
  const session = makeSession({
    aiService: ai,
    mcpServer: server,
    runner,
    skillsService: skillsService ?? { findSkill: (name: string) => skills.find((sk) => sk.name === name) },
    modelResolver: {
      modelsForRunners: vi.fn(async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, CATALOG[r] ?? []]))),
    },
    settings: () => settings,
    broadcast,
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
  it.each([
    ['attached', true, 'connected', true],
    ['not offered', false, 'connected', false],
    ['connection failed', true, 'failed', false],
  ] as const)('advertises the catalog only when tools attach: %s', async (_label, inject, status, advertised) => {
    const files = new Map([['review-plan', plannerSkill('review-plan')]]);
    const claude = fakeClaude({ status });
    const { session } = plannerSession(claude, {}, { inject, skillsService: skillCatalog(files) });
    await session.startPlanning('goal', ['claude-code']);
    const args = claude.lastArgs();
    const prompt = args[args.indexOf('--append-system-prompt') + 1];
    expect(prompt.includes('ORDEWELL PLANNER SKILLS:')).toBe(advertised);
    expect(prompt.includes('- review-plan: Use review-plan to plan')).toBe(advertised);
    expect(prompt.includes('load_skill')).toBe(advertised);
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
    expect(request.priorHistory!.map((entry) => entry.content)).toContain('<skill name="review-plan">\nreview-plan BODY v1\n</skill>');
    expect(request.priorHistory!.map((entry) => entry.content)).toContain('<skill name="review-plan">\nreview-plan BODY v2\n</skill>');
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
        submitted = await call(mcp!, 'submit_plan', { tasks: [planTask('a', 1, 'claude-code', 'claude-sonnet-4'), planTask('b', 2, 'codex', 'gpt-5', { taskMode: 'auto' })] });
        return 'Submitted the plan.';
      },
    }));
    await session.startPlanning('add a cache', ['claude-code']);

    settings({ enabledRunners: ['claude-code', 'codex'] });
    await session.continueConversation('use codex too');

    expect(submitted).toEqual({ isError: false, body: expect.objectContaining({ ok: true, tasks: 2, coerced: [] }) });
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
      { taskId: 'a', field: 'assignedModel', from: 'claude-opus-4', to: 'claude-sonnet-4' },
      { taskId: 'a', field: 'thinkingEffort', from: 'high', to: null },
    ]);
    expect(session.planTasks[0].assignedModel?.modelId).toBe('claude-sonnet-4');
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

describe('the two routes to a plan', () => {
  it('commit the same plan for the same tasks: submit_plan, and the JSON envelope in the reply', async () => {
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
    const viaEnvelope = plannerSession(fakeClaude({ turn: async () => JSON.stringify({ tasks }) }), settings, { inject: false });

    await viaTool.session.startPlanning('add a cache', ['claude-code']);
    await viaEnvelope.session.startPlanning('add a cache', ['claude-code']);

    const committed = ({ session, broadcast }: ReturnType<typeof plannerSession>) => ({
      tasks: session.planTasks.map(({ completionMarker: _, ...rest }) => rest),
      runners: session.planState?.runners,
      last: session.planState?.conversationHistory?.at(-1)?.kind,
      planBroadcasts: broadcast.mock.calls.filter(([m]) => m.type === 'plan_generated').length,
    });
    expect(viaTool.session.planTasks).toHaveLength(2);
    expect(committed(viaTool)).toEqual(committed(viaEnvelope));
  });
});

describe('what the planner is told', () => {
  const systemPrompt = (spawned: FakeSpawnResult) => {
    const args = spawned.lastArgs();
    return args[args.indexOf('--append-system-prompt') + 1];
  };

  async function twoTurns(inject: boolean) {
    const messages: string[] = [];
    const claude = fakeClaude({ turn: async (_mcp, message) => { messages.push(message); return 'Which cache?'; } });
    const { session, ai } = plannerSession(claude, {}, { inject });
    await session.startPlanning('add a cache', ['claude-code']);
    await session.continueConversation('in-process');
    return { claude, messages, attached: ai.plannerToolsAttached() };
  }

  it('with the tools: to pull the catalog just before submitting through submit_plan, and no pasted catalog', async () => {
    const { claude, messages, attached } = await twoTurns(true);

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
    async function afterPlan(inject: boolean) {
      const messages: string[] = [];
      let planned = false;
      const claude = fakeClaude({
        turn: async (_mcp, message) => {
          messages.push(message);
          if (planned) return 'Ok.';
          planned = true;
          return JSON.stringify({ tasks: TWO_TASKS });
        },
      });
      const { session } = plannerSession(claude, {}, { inject });
      await session.startPlanning('add a cache', ['claude-code']);
      await session.continueConversation('rename the first task');
      return { prompt: systemPrompt(claude), perTurn: messages[1] };
    }

    it('with the tools: to read through task_query and task_output and edit through edit_plan, not the envelopes', async () => {
      const { prompt, perTurn } = await afterPlan(true);

      expect(prompt).toMatch(/task_query/);
      expect(prompt).toMatch(/task_output/);
      expect(prompt).not.toContain('"taskQuery"');
      expect(perTurn).toMatch(/call edit_plan/);
      expect(perTurn).toMatch(/call task_query or task_output/);
      expect(perTurn).not.toMatch(/"taskOps"|"taskQuery"|reply with ONLY/);
    });

    it('merge and split ask for an edit_plan call with the tools, and for the envelope without', () => {
      const tasks = TWO_TASKS as unknown as Task[];

      expect(buildMergePrompt(['a', 'b'], tasks, true)).toMatch(/Call edit_plan with a single "merge" op:\n {2}\{"ops":\[/);
      expect(buildSplitPrompt('a', tasks, true)).toMatch(/Call edit_plan with a single "split" op:\n {2}\{"ops":\[/);
      expect(buildMergePrompt(['a', 'b'], tasks)).toMatch(/Reply with ONLY a taskOps JSON object using a single "merge" op:\n {2}\{"taskOps":\[/);
      expect(buildSplitPrompt('a', tasks)).toMatch(/Reply with ONLY a taskOps JSON object using a single "split" op:\n {2}\{"taskOps":\[/);
    });

    it('without them: the envelopes, unchanged', async () => {
      const { prompt, perTurn } = await afterPlan(false);

      expect(prompt).toContain('{"taskQuery":{"tasks":');
      expect(perTurn).toContain('{"taskOps": [');
      expect(perTurn).toContain('{"taskQuery":{"tasks":["<id or #order>"],"catalog":true}}');
      expect(`${prompt}\n${perTurn}`).not.toMatch(/edit_plan|task_query|task_output/);
    });
  });

  it('without them: the task skills it may attach, but no planner skills, which load only through load_skill', async () => {
    const files = new Map([
      ['pr-style', { ...plannerSkill('pr-style', { appliesTo: 'task' }), description: 'House PR style' }],
      ['review-plan', plannerSkill('review-plan')],
    ]);
    const claude = fakeClaude({ turn: async () => 'Which cache?' });
    const { session } = plannerSession(claude, {}, { inject: false, skillsService: skillCatalog(files) });

    await session.startPlanning('add a cache', ['claude-code']);

    const prompt = systemPrompt(claude);
    expect(prompt).toContain('Task skills you may attach:\n- pr-style: House PR style');
    expect(prompt).not.toMatch(/review-plan|load_skill/);
  });

  it('without them: today\'s prompt and per-turn catalog, unchanged', async () => {
    const { claude, messages, attached } = await twoTurns(false);

    expect(attached).toBe(false);
    expect(systemPrompt(claude)).toBe(buildConversationSystemPrompt(
      'add a cache', '', { 'claude-code': CATALOG['claude-code'] }, ['claude-code'], runnerModesFrom(new RunnerRegistry(), ['claude-code']), true,
      { harness: true, isolatedExecution: undefined },
    ));
    expect(messages[1]).toContain('<available_models>\nclaude-code: claude-sonnet-4, claude-opus-4\n</available_models>');
    expect(messages[1]).not.toMatch(/list_runners|submit_plan/);
  });
});

const TWO_TASKS = [
  planTask('a', 1, 'claude-code', 'claude-sonnet-4'),
  planTask('b', 2, 'claude-code', 'claude-sonnet-4', { dependencies: ['a'] }),
];

/** A conversation with a committed two-task plan, whose every later reply is `second`. */
async function planThen(second: (mcp: Client | null, message: string) => Promise<string>, opts: { inject?: boolean; runner?: ITerminalRunner; skills?: SkillInfo[] } & Partial<SessionRuntimeSettings> = {}) {
  const { inject = true, runner, skills, ...settings } = opts;
  let planned = false;
  const planner = plannerSession(fakeClaude({
    turn: async (mcp, message) => {
      if (planned) return second(mcp, message);
      planned = true;
      return JSON.stringify({ tasks: TWO_TASKS });
    },
  }), settings, { inject, runner, skills });
  await planner.session.startPlanning('add a cache', ['claude-code']);
  return planner;
}

const landed = ({ session, broadcast }: ReturnType<typeof plannerSession>) => ({
  tasks: session.planTasks.map(({ id: _id, completionMarker: _marker, ...rest }) => rest),
  runners: session.planState?.runners,
  last: session.planState?.conversationHistory?.at(-1)?.content,
  planBroadcasts: broadcast.mock.calls.filter(([m]) => m.type === 'plan_generated').length,
});

/** A started run on a plan of two tasks: `a` running behind `sessions[0]`, `b` waiting on it. */
async function runningPlan(second: Parameters<typeof planThen>[0], opts: { inject?: boolean; sessions?: FakeTerminalSession[] } = {}) {
  const { sessions = [], ...rest } = opts;
  const runner = {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      const session = new FakeTerminalSession(`s-${taskId}`, taskId);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as ITerminalRunner;
  const planner = await planThen(second, { ...rest, runner });
  await planner.session.executePlan();
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

describe('edit_plan', () => {
  const ops = [
    { op: 'update', taskId: '#2', changes: { title: 'Wire it in', prompt: 'wire the cache in' } },
    { op: 'add', task: { title: 'Docs', dependencies: ['#2'], assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4' } } },
  ];

  it('commits the same edit as the same ops in a taskOps reply', async () => {
    const viaTool = await planThen(async (mcp) => {
      expect(await call(mcp!, 'edit_plan', { ops })).toEqual({ isError: false, body: expect.objectContaining({ ok: true }) });
      return 'Done.';
    });
    const viaEnvelope = await planThen(async () => JSON.stringify({ taskOps: ops }), { inject: false });

    await viaTool.session.continueConversation('EDIT NOW');
    await viaEnvelope.session.continueConversation('EDIT NOW');

    expect(viaTool.session.planTasks.map((t) => t.title)).toEqual(['Task a', 'Wire it in', 'Docs']);
    expect(landed(viaTool)).toEqual(landed(viaEnvelope));
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
        errors: [{ op: 2, kind: 'update', message: 'runner "codex" is not in this plan\'s runner set [claude-code]' }],
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

  it('joins the edits of one reply into a single batch, and the second call is checked with the first', async () => {
    let second: { isError: boolean; body: unknown } | undefined;
    const planner = await planThen(async (mcp) => {
      await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#1', changes: { title: 'First' } }] });
      second = await call(mcp!, 'edit_plan', { ops: [{ op: 'update', taskId: '#2', changes: { title: 'Second' } }] });
      return 'Renamed both.';
    });

    await planner.session.continueConversation('EDIT NOW');

    expect(second?.body).toEqual(expect.objectContaining({ ok: true, summary: ['Updated "Task a" (title)', 'Updated "Task b" (title)'] }));
    expect(planner.session.planTasks.map((t) => t.title)).toEqual(['First', 'Second']);
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
    it('queues an edit that reaches it, exactly as the envelope does, and says so', async () => {
      const edit = [{ op: 'update', taskId: '#1', changes: { title: 'Setup, renamed' } }];
      let answered: { isError: boolean; body: unknown } | undefined;
      const viaTool = await runningPlan(async (mcp) => {
        answered = await call(mcp!, 'edit_plan', { ops: edit });
        return 'Queued.';
      });
      const viaEnvelope = await runningPlan(async () => JSON.stringify({ taskOps: edit }), { inject: false });

      await viaTool.session.continueConversation('EDIT NOW');
      await viaEnvelope.session.continueConversation('EDIT NOW');

      expect(answered).toEqual({ isError: false, body: expect.objectContaining({ ok: true, queued: true }) });
      expect(viaTool.session.getQueuedMessages().map((m) => m.text)).toEqual(['EDIT NOW']);
      expect(landed(viaTool)).toEqual(landed(viaEnvelope));
      expect(viaTool.session.planTasks[0].title).toBe('Task a');
    });
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
        for (let n = 0; n < 6; n++) answers.push(await call(mcp!, n % 2 ? 'task_query' : 'task_output', n % 2 ? read(n) : { task: '#1', lines: n + 1 }));
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

  it('is shared with the taskQuery envelope: reads made either way are counted together', async () => {
    const envelope = (ref: string) => JSON.stringify({ taskQuery: { tasks: [ref], fields: ['description'] } });
    const answers: { isError: boolean; body: unknown }[] = [];
    const envelopeAnswers: string[] = [];
    let step = 0;
    const { session } = await planThen(async (mcp, message) => {
      step++;
      if (step > 1) envelopeAnswers.push(message);
      if (step === 1) return envelope('#1');
      if (step === 2) return envelope('#2');
      // Two envelope reads are spent: the third read, by tool, is the last that is not told to land.
      answers.push(await call(mcp!, 'task_query', { tasks: ['#1'], fields: ['prompt'] }));
      answers.push(await call(mcp!, 'task_query', { tasks: ['#2'], fields: ['prompt'] }));
      return 'Read.';
    });

    await session.continueConversation('EDIT NOW');

    expect(envelopeAnswers[0]).not.toMatch(/You have now read everything/);
    expect(answers.map(noteOf)).toEqual([undefined, expect.stringMatching(LAND)]);
  });

  it('is shared the other way: tool reads leave the envelope\'s answer told to land', async () => {
    const envelopeAnswers: string[] = [];
    let step = 0;
    const { session } = await planThen(async (mcp, message) => {
      step++;
      if (step === 1) {
        for (let n = 0; n < 3; n++) await call(mcp!, 'task_query', { tasks: [`#${n + 1}`] });
        return JSON.stringify({ taskQuery: { tasks: ['#1'], fields: ['description'] } });
      }
      envelopeAnswers.push(message);
      return 'Read.';
    });

    await session.continueConversation('EDIT NOW');

    expect(envelopeAnswers).toHaveLength(1);
    expect(envelopeAnswers[0]).toMatch(/You have now read everything you asked for\. Do not send another taskQuery/);
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
        if (!message.includes('READ NOW')) return JSON.stringify({ tasks: longPlan });
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
          { id: 'a', order: 1, title: 'Task a', status: 'approved', type: 'ai', prompt: 'create the cache module in src/cache.ts', userStoriesCovered: null },
          { id: 'b', order: 2, title: 'Task b', status: 'approved', type: 'ai', prompt: 'do b', userStoriesCovered: ['As a dev I want it fast'] },
          { ref: 'nope', error: 'no task matches this reference in the current plan.' },
        ],
      },
    });
  });

  it('with catalog: true, adds the live runners, models and modes', async () => {
    let answer: { body: unknown } | undefined;
    const { session, settings } = await planAndRead(async (mcp) => {
      answer = await call(mcp, 'task_query', { tasks: ['#1'], fields: ['description'], catalog: true });
    });

    settings({ enabledRunners: ['claude-code', 'codex'] });
    await session.continueConversation('READ NOW');

    const { catalog } = answer!.body as { catalog: { runners: { id: string; models: { modelId: string }[]; modes: { id: string }[] }[] } };
    expect(catalog.runners.map((r) => [r.id, r.models.map((m) => m.modelId)])).toEqual([
      ['claude-code', ['claude-sonnet-4', 'claude-opus-4']],
      ['codex', ['gpt-5']],
    ]);
    expect(catalog.runners[0].modes.length).toBeGreaterThan(0);
  });
});

describe('task_output', () => {
  it('reads the live tail of a running task, and pages on from the offset it reports', async () => {
    const sessions: FakeTerminalSession[] = [];
    const answers: unknown[] = [];
    const { session } = await runningPlan(async (mcp) => {
      answers.push((await call(mcp!, 'task_output', { task: '#1', lines: 2 })).body);
      sessions[0].emitOutput('line 4\nline 5\n');
      answers.push((await call(mcp!, 'task_output', { task: 'a', since: (answers[0] as { nextOffset: number }).nextOffset })).body);
      return 'It is progressing.';
    }, { sessions });
    sessions[0].emitOutput('line 1\nline 2\nline 3\n');

    await session.continueConversation('how is it going?');

    const task = { id: 'a', order: 1, title: 'Task a', status: 'in_progress' };
    expect(answers).toEqual([
      { task, running: true, output: 'line 2\nline 3', nextOffset: 21 },
      { task, running: true, output: 'line 4\nline 5', nextOffset: 35 },
    ]);
  });

  it('cuts a count above the cap to the cap, as the envelope does', async () => {
    const sessions: FakeTerminalSession[] = [];
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
          task: { id: 'a', order: 1, title: 'Setup', status: 'completed' },
          running: false,
          reason: expect.stringContaining('not running'),
          verdict: { outcome: 'pass', reason: 'Completion marker found', checks: [{ name: 'completion_marker', result: 'pass' }] },
          outputSummary: { reviewReason: 'It finished cleanly', logTail: 'added src/cache.ts' },
          lastAttempt: '- Bash {"command":"npm test"} → ok\n\nIts last message:\n  The cache is in place.',
        },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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
