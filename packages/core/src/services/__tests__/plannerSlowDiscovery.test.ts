import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer } from '../mcp';
import type { DiscoveredModel, RunnerId } from '../../models/Task';
import type { SessionRuntimeSettings } from '../createSession';
import { fakeConfig } from '../../testing';
import { codexPastToolDeadline, fakeSpawn, fixture, type FakeMcpServer, type ScriptedReply } from './harnessTestKit';
import { makeSession } from './sessionTestKit';
import { plannerToolHandler, type PlannerToolsHost } from '../plannerTools';
import type { TaskQueryCatalog } from '../TaskQuery';

/**
 * A Codex planner whose Ordewell tools waited on another runner's model
 * discovery: one enabled CLI that hangs while listing its models (OpenCode
 * here, as reproduced with codex-cli 0.171.0) held every list_runners and
 * list_models call until Codex's tool deadline, and the plan was never
 * submitted. The calls go to a real server over HTTP, as Codex makes them.
 */

const CATALOG: Record<string, DiscoveredModel[]> = {
  codex: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [{ id: 'high', label: 'High' }] }],
};

const never = new Promise<never>(() => {});

let mcp: OrdewellMcpServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await mcp?.dispose();
  mcp = undefined;
});

/**
 * A planning session on a fake Codex planner whose one turn is `turn`, on a
 * model resolver whose OpenCode discovery answers nothing once (as a cold
 * real one does) and never answers again.
 */
function codexSession(turn: (env: () => NodeJS.ProcessEnv) => ScriptedReply) {
  mcp = new OrdewellMcpServer();
  const config = fakeConfig({ aiProvider: 'codex' });
  let env = (): NodeJS.ProcessEnv => ({});
  const spawned = fakeSpawn([fixture('codex', 'handshake'), fixture('codex', 'new-conversation'), turn(() => env())]);
  env = () => spawned.lastEnv();
  const ai = new CliAgentAiService(config, {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    workspaceRoot: () => '/repo',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    mcpServer: mcp as FakeMcpServer,
  });
  let opencodeAsked = 0;
  const modelsForRunners = vi.fn(async (runners: RunnerId[]) => {
    if (runners.includes('opencode') && opencodeAsked++ > 0) await never;
    return Object.fromEntries(runners.map((r) => [r, CATALOG[r] ?? []]));
  });
  const settings: SessionRuntimeSettings = { enabledRunners: ['codex', 'opencode'] };
  const session = makeSession({ config, aiService: ai, mcpServer: mcp, modelResolver: { modelsForRunners }, settings: () => settings });
  return { session, modelsForRunners };
}

function plannerLog(): string[] {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  return lines;
}

describe('a Codex planner while another runner\'s model discovery hangs', () => {
  it('has list_runners and list_models for its own runner answered, not held for the hung one', async () => {
    const lines = plannerLog();
    const { session } = codexSession((env) => codexPastToolDeadline(env, {
      tools: { list_runners: {}, list_models: { runner: 'codex' } },
      deadlineMs: 2000,
      reply: 'Which runner should run the tests?',
    }));

    await session.startPlanning('Add a --shout option to hello.py', ['codex', 'opencode']);

    const logged = lines.filter((l) => l.startsWith('[ordewell-mcp]'));
    expect(logged).toContainEqual(expect.stringMatching(/planner call list_runners ok after/));
    expect(logged).toContainEqual(expect.stringMatching(/planner call list_models ok after/));
  });

  it('is told a runner\'s models are still being listed, not that it offers none', async () => {
    const catalog: TaskQueryCatalog = { runners: ['codex', 'opencode'], models: { codex: CATALOG.codex }, modes: {}, autonomousDefault: true, discovering: ['opencode'] };
    const asked: (readonly RunnerId[] | undefined)[] = [];
    const host = { liveCatalog: async (runners?: readonly RunnerId[]) => { asked.push(runners); return catalog; } };
    const handler = plannerToolHandler(host as unknown as PlannerToolsHost);
    const context = { signal: new AbortController().signal };

    const listed = await handler.listModels!({ runner: 'opencode' }, context);
    const known = await handler.listModels!({ runner: 'codex' }, context);

    expect(asked).toEqual([['opencode'], ['codex']]);
    expect(JSON.parse(listed.text)).toEqual({ runner: 'opencode', models: [], discovering: expect.stringMatching(/still listing.*call list_models again/i) });
    expect(JSON.parse(known.text)).not.toHaveProperty('discovering');
  });
});
