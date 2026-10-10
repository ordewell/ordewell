import { describe, it, expect, afterEach } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import type { AgentEvent, AgentStartOptions } from '../harness/AgentAdapter';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer, PLANNER_TOOLS, TASK_TOOLS, mcpClientConfig } from '../mcp';
import { CLI_PROVIDERS, providerForRunner, runnerForProvider } from '../ProviderRegistry';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { modeIds, planJson } from './harnessTestKit';
import { FAKE_RUNNERS, type FakeRunnerScript } from './fakeRunners';

/**
 * What every connector that hands its runner the Ordewell MCP server owes it
 * (ADR-0022), checked the same way for each entry of the connector registry
 * against a fake of that runner's own protocol.
 */

/** The name each runner calls an Ordewell tool by, as each was checked live (ADR-0022, History). */
const RUNNER_NAME: Record<string, (tool: string) => string> = {
  'claude-code': (tool) => `mcp__ordewell__${tool}`,
  codex: (tool) => `mcp__ordewell__${tool}`,
  opencode: (tool) => `ordewell_${tool}`,
};

const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-secret' });
const manifests = new RunnerRegistry();
const runners = Object.keys(CONNECTORS).filter((runner) => CONNECTORS[runner].ordewellTools);

function taskStart(runner: string, mode = manifests.get(runner)!.manifest.modes![0].id): AgentStartOptions {
  const flags = resolveTaskRunnerFlags(manifests.get(runner)!.manifest, { mode });
  return { kind: 'task', cwd: '/repo', mode, flags, mcp };
}

const plannerStart: AgentStartOptions = { kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', mcp };

async function opened(runner: string, start: AgentStartOptions, script: FakeRunnerScript = { attach: 'connected' }) {
  const fake = FAKE_RUNNERS[runner](script);
  const adapter = CONNECTORS[runner].create(fake.deps);
  await adapter.start(start);
  const events: AgentEvent[] = [];
  void adapter.send('go', (event) => events.push(event));
  await fake.turnOpen();
  return { fake, adapter, events };
}

const servers: OrdewellMcpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
});

it('has a fake for every connector and a runner name for every connector that takes the tools', () => {
  expect(Object.keys(FAKE_RUNNERS).sort()).toEqual(Object.keys(CONNECTORS).sort());
  expect(Object.keys(RUNNER_NAME).sort()).toEqual([...runners].sort());
});

it('offers a harness planner for exactly the runners with a connector', () => {
  expect(CLI_PROVIDERS.map(runnerForProvider).sort()).toEqual(Object.keys(CONNECTORS).sort());
});

describe.each(runners)('the %s connector and the Ordewell tools', (runner) => {
  const name = RUNNER_NAME[runner];
  const roles = [
    ['task', () => taskStart(runner), TASK_TOOLS],
    ['planner', () => plannerStart, PLANNER_TOOLS],
  ] as const;

  it.each(roles)('hands a %s the server, the token never on the command line', async (_role, start) => {
    const { fake, adapter } = await opened(runner, start());

    expect(fake.injectedUrl()).toBe(mcp.url);
    expect(fake.commandLine()).not.toContain('tok-secret');
    adapter.dispose();
  });

  it.each(roles)('lets a %s run each of its tools unasked, under the runner\'s name for it', async (role, start, tools) => {
    const { fake, adapter } = await opened(runner, start());

    expect(CONNECTORS[runner].ordewellTools!.toolNames(role)).toEqual(tools.map((tool) => name(tool.name)));
    for (const tool of tools) expect(fake.preAllows(name(tool.name)), tool.name).toBe(true);
    expect(fake.preAllows('bash')).toBe(false);
    adapter.dispose();
  });

  it.each(roles)('shows a %s calling each of its tools under that name', async (_role, start, tools) => {
    const { fake, adapter, events } = await opened(runner, start());
    for (const tool of tools) fake.callOrdewellTool(tool.name);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.flatMap((e) => (e.type === 'tool_call' ? [e.name] : []))).toEqual(tools.map((tool) => name(tool.name)));
    adapter.dispose();
  });

  it.each(modeIds(manifests.get(runner)!.manifest))('allows a task\'s request for each Ordewell tool at once under %s', async (mode) => {
    const { fake, adapter } = await opened(runner, taskStart(runner, mode));

    for (const tool of TASK_TOOLS) expect(await fake.askOrdewellTool(tool.name), tool.name).toBe('allow');
    adapter.dispose();
  });

  it('never lets a planner write on its own: it denies the request, or holds it for the envelope to deny', async () => {
    const { fake, adapter, events } = await opened(runner, plannerStart);

    const answer = fake.askWrite();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const announced = events.filter((e) => e.type === 'permission_request');
    expect(announced).toHaveLength(1);
    const request = announced[0] as Extract<AgentEvent, { type: 'permission_request' }>;
    if (request.decided) expect(request.decided).toEqual({ decision: 'deny' });
    else expect(adapter.answerPermission?.(request.id, { decision: 'deny' })).toBe(true);
    expect(await answer).toBe('deny');
    adapter.dispose();
  });

  it.each(roles)('reports a %s whose server did not attach as not attached, and still delivers the marker', async (_role, start) => {
    const { fake, adapter, events } = await opened(runner, start(), { attach: 'failed' });

    expect(await adapter.mcpAttached!()).toBe(false);
    fake.say('Done. <<<ORDEWELL_DONE_mk-1>>>');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((e) => (e.type === 'assistant_text' || e.type === 'assistant_text_delta') && e.text.includes('<<<ORDEWELL_DONE_mk-1>>>'))).toBe(true);
    adapter.dispose();
  });

  it('reports a server that attached as attached', async () => {
    const { adapter } = await opened(runner, taskStart(runner));

    expect(await adapter.mcpAttached!()).toBe(true);
    adapter.dispose();
  });

  it('refuses a planner after one respawn still cannot attach tools', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const fake = FAKE_RUNNERS[runner]({ attach: 'failed', reply: planJson(runner) });
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: providerForRunner(runner)!, enabledRunners: [runner] }), { ...fake.deps, workspaceRoot: () => '/repo', mcpServer: server });

    await expect(svc.startConversation({
      goal: 'Add the thing',
      runners: [runner],
      modelsByRunner: { [runner]: [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }] },
      fs: fakeFileSystem(),
      onProgress: () => {},
      plannerTools: { sessionId: 's1', handler: {} },
    })).rejects.toThrow('MCP server connected');

    expect(fake.launches()).toBe(2);
    expect(fake.injectedUrl(0)).toBe(server.url);
    expect(fake.killed(0)).toBe(true);
    expect(fake.injectedUrl(1)).toBe(server.url);
    expect(fake.killed(1)).toBe(true);
    svc.reset();
  });
});
