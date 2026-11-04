import { existsSync } from 'fs';
import type { ChildProcess } from 'child_process';
import { describe, it, expect, afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CONNECTORS } from '../harness/connectors';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions } from '../harness/AgentAdapter';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer, PLANNER_EXECUTION_TOOLS, PLANNER_TOOLS, TASK_TOOLS, mcpClientConfig } from '../mcp';
import { CLI_PROVIDERS, providerForRunner, runnerForProvider } from '../ProviderRegistry';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { modeIds, planJson, type FakeAgentProcess } from './harnessTestKit';
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
  'copilot-cli': (tool) => `ordewell-${tool}`,
  'qwen-code': (tool) => `mcp__ordewell__${tool}`,
  cline: (tool) => `ordewell__${tool}`,
  'gemini-cli': (tool) => `mcp_ordewell_${tool}`,
};

/**
 * What a runner's transcript calls an Ordewell tool call, where that is not
 * the name it runs it by: Qwen Code reports an MCP call first under the
 * placeholder title "ToolCall" and an event keeps the name its call was first
 * seen under (acpEvents.ts), while its requests carry the real name. Cline's
 * title is the name and then a summary of the model's arguments. Gemini's is
 * the call as the model wrote it, and with no arguments the tool's display
 * name; its call id carries the real name.
 */
const REPORTED_AS: Record<string, (tool: string) => string> = {
  'qwen-code': () => 'ToolCall',
  cline: (tool) => `ordewell__${tool}: {}`,
  'gemini-cli': (tool) => `${tool} (ordewell MCP Server)`,
};

/**
 * The planner tools each runner carries natively instead of Ordewell's, as
 * ADR-0027's table assigns them: Claude Code searches and fetches natively.
 */
const NATIVE_INSTEAD: Record<string, string[]> = {
  'claude-code': ['fetch', 'web_search'],
  codex: [],
  opencode: [],
  'copilot-cli': [],
  'qwen-code': [],
  cline: [],
  'gemini-cli': [],
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
  await adapter.start(fake.withServer?.(start) ?? start);
  const events: AgentEvent[] = [];
  void adapter.send('go', (event) => events.push(event));
  await fake.turnOpen();
  return { fake, adapter, events };
}

/**
 * `work`, run with the clock moved on until it settles: a runner that reports
 * no MCP status (ACP) shows a server it never used only by the attach wait
 * running out (ADR-0060, R5).
 */
async function onFakeClock<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const running = work();
    let settled = false;
    running.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) await vi.advanceTimersByTimeAsync(1_000);
    return await running;
  } finally {
    vi.useRealTimers();
  }
}

const servers: OrdewellMcpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
});

it('has a fake for every connector and a runner name for every connector that takes the tools', () => {
  expect(Object.keys(FAKE_RUNNERS).sort()).toEqual(Object.keys(CONNECTORS).sort());
  expect(Object.keys(RUNNER_NAME).sort()).toEqual([...runners].sort());
  expect(Object.keys(NATIVE_INSTEAD).sort()).toEqual([...runners].sort());
});

it('offers a harness planner for exactly the connectors that plan', () => {
  expect(CLI_PROVIDERS.map(runnerForProvider).sort()).toEqual(Object.keys(CONNECTORS).filter((runner) => CONNECTORS[runner].plans).sort());
});

describe.each(runners)('the %s connector and the Ordewell tools', (runner) => {
  const name = RUNNER_NAME[runner];
  const hidden = NATIVE_INSTEAD[runner];
  const plannerTools = PLANNER_TOOLS.filter((tool) => !hidden.includes(tool.name));
  const hiddenPlannerStart: AgentStartOptions = { ...plannerStart, mcp: { ...mcp, hidden } };
  // A connector can run tasks before it can plan; what a planner is owed waits for that.
  const plans = CONNECTORS[runner].plans;
  const planner = it.runIf(plans);
  const roles = [
    ['task', () => taskStart(runner), TASK_TOOLS] as const,
    ...(plans ? [['planner', () => hiddenPlannerStart, plannerTools] as const] : []),
  ];

  it.each(roles)('hands a %s the server, the token never on the command line', async (_role, start) => {
    const { fake, adapter } = await opened(runner, start());

    expect(fake.injectedUrl()).toBe(mcp.url);
    expect(fake.commandLine()).not.toContain('tok-secret');
    adapter.dispose();
  });

  it.each(roles)('lets a %s run each of its tools unasked, under the runner\'s name for it', async (role, start, tools) => {
    const { fake, adapter } = await opened(runner, start());

    expect(CONNECTORS[runner].ordewellTools!.toolNames(role, role === 'planner' ? hidden : [])).toEqual(tools.map((tool) => name(tool.name)));
    for (const tool of tools) expect(await fake.preAllows(name(tool.name)), tool.name).toBe(true);
    expect(await fake.preAllows('bash')).toBe(false);
    adapter.dispose();
  });

  // A runner compacts its own context, and the first message is what it
  // summarises; the instructions channel is the one it re-applies whole.
  it('gives a task the completion contract in its instructions, not only in the first message', async () => {
    const { fake, adapter } = await opened(runner, taskStart(runner));

    expect(fake.instructions()).toContain('call the `task_complete` tool with status `done` and your handoff');
    expect(fake.instructions()).toContain('`blocked` or `failed` and the reason');
    expect(fake.instructions()).toContain('Its `summary` is this task\'s handoff to the next task');
    expect(fake.commandLine()).not.toContain('tok-secret');
    adapter.dispose();
  });

  planner('does not give a planner the task\'s completion contract', async () => {
    const { fake, adapter } = await opened(runner, hiddenPlannerStart);

    expect(fake.instructions()).not.toContain('When you have fully completed this task');
    adapter.dispose();
  });

  planner('gives a planner the execution tools, run unasked, and allows its request for one at once (ADR-0029)', async () => {
    const { fake, adapter } = await opened(runner, hiddenPlannerStart);

    expect(CONNECTORS[runner].ordewellTools!.toolNames('planner', hidden)).toEqual(expect.arrayContaining(PLANNER_EXECUTION_TOOLS.map((tool) => name(tool.name))));
    for (const tool of PLANNER_EXECUTION_TOOLS) {
      expect(await fake.preAllows(name(tool.name)), tool.name).toBe(true);
      expect(await fake.askOrdewellTool(tool.name), tool.name).toBe('allow');
    }
    adapter.dispose();
  });

  planner('neither pre-allows nor mentions a planner tool the runner carries natively', async () => {
    const { fake, adapter } = await opened(runner, hiddenPlannerStart);

    for (const tool of hidden) {
      expect(await fake.preAllows(name(tool)), tool).toBe(false);
      expect(fake.instructions(), tool).not.toContain(name(tool));
    }
    adapter.dispose();
  });

  planner('starts a planner on a token that serves exactly the tools the runner is given', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const issued = vi.spyOn(server, 'issuePlannerToken');
    const fake = FAKE_RUNNERS[runner]({ attach: 'connected' });
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: providerForRunner(runner)!, enabledRunners: [runner] }), { ...fake.deps, workspaceRoot: () => '/repo', mcpServer: server });

    // Checked in the planner's open first turn: a runner that asks about each
    // call (ACP) asks only in a turn, and is answered by what the turn reported.
    const conversation = svc.startConversation({
      goal: 'Add the thing',
      runners: [runner],
      modelsByRunner: { [runner]: [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }] },
      fs: fakeFileSystem(),
      onProgress: () => {},
      plannerTools: { sessionId: 's1', handler: {} },
    }).catch(() => undefined);
    await vi.waitFor(() => expect(fake.launches()).toBe(1));
    await fake.turnOpen();
    const credential = await issued.mock.results[0].value;
    const config = mcpClientConfig(credential);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(plannerTools.map((tool) => tool.name));
    for (const tool of plannerTools) expect(await fake.preAllows(name(tool.name)), tool.name).toBe(true);
    for (const tool of hidden) expect(await fake.preAllows(name(tool)), tool).toBe(false);
    await client.close();
    svc.reset();
    await conversation;
  });

  it.each(roles)('shows a %s calling each of its tools under that name', async (_role, start, tools) => {
    const { fake, adapter, events } = await opened(runner, start());
    for (const tool of tools) fake.callOrdewellTool(tool.name);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.flatMap((e) => (e.type === 'tool_call' ? [e.name] : []))).toEqual(tools.map((tool) => (REPORTED_AS[runner] ?? name)(tool.name)));
    adapter.dispose();
  });

  it.each(modeIds(manifests.get(runner)!.manifest))('allows a task\'s request for each Ordewell tool at once under %s', async (mode) => {
    const { fake, adapter } = await opened(runner, taskStart(runner, mode));

    for (const tool of TASK_TOOLS) expect(await fake.askOrdewellTool(tool.name), tool.name).toBe('allow');
    adapter.dispose();
  });

  planner('never lets a planner write on its own: it denies the request, or holds it for the envelope to deny', async () => {
    const { fake, adapter, events } = await opened(runner, plannerStart);

    const answer = fake.askWrite();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const announced = events.filter((e) => e.type === 'permission_request');
    expect(announced).toHaveLength(1);
    const request = announced[0] as Extract<AgentEvent, { type: 'permission_request' }>;
    if (request.decided) expect(request.decided.decision).toBe('deny');
    else expect(await adapter.answerPermission?.(request.id, { decision: 'deny' })).toBe(true);
    expect(await answer).toBe('deny');
    adapter.dispose();
  });

  it.each(roles)('reports a %s whose server did not attach as not attached, and still delivers the marker', async (_role, start) => {
    const { fake, adapter, events } = await opened(runner, start(), { attach: 'failed' });

    expect(await adapter.mcpAttached!()).toBe('failed');
    fake.say('Done. <<<ORDEWELL_DONE_mk-1>>>');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((e) => (e.type === 'assistant_text' || e.type === 'assistant_text_delta') && e.text.includes('<<<ORDEWELL_DONE_mk-1>>>'))).toBe(true);
    adapter.dispose();
  });

  it('reports a server that attached as attached', async () => {
    const { adapter } = await opened(runner, taskStart(runner));

    expect(await adapter.mcpAttached!()).toBe('connected');
    adapter.dispose();
  });

  planner('refuses a planner after one respawn still cannot attach tools', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const fake = FAKE_RUNNERS[runner]({ attach: 'failed', reply: planJson(runner) });
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: providerForRunner(runner)!, enabledRunners: [runner] }), { ...fake.deps, workspaceRoot: () => '/repo', mcpServer: server });

    await expect(onFakeClock(() => svc.startConversation({
      goal: 'Add the thing',
      runners: [runner],
      modelsByRunner: { [runner]: [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }] },
      fs: fakeFileSystem(),
      onProgress: () => {},
      plannerTools: { sessionId: 's1', handler: {} },
    }))).rejects.toThrow('MCP server connected');

    expect(fake.launches()).toBe(2);
    expect(fake.injectedUrl(0)).toBe(server.url);
    expect(fake.killed(0)).toBe(true);
    expect(fake.injectedUrl(1)).toBe(server.url);
    expect(fake.killed(1)).toBe(true);
    svc.reset();
  });
});

/**
 * What a runner's process owns goes with it (ADR-0018 L1): the one registry
 * every adapter's resources are claimed in is freed by a dispose, by a turn's
 * abort and by the process ending on its own, and the process group is killed
 * rather than only the CLI at its head.
 */
describe.each(runners)('the %s connector and what its process owns', (runner) => {
  let nextPid = 3_800_000;
  const launched: FakeAgentProcess[] = [];
  let kill: MockInstance<typeof process.kill>;

  /** `deps`, with every runner it launches given a pid, so it leads a process group the way a real one does. */
  function tracked(deps: AgentProcessDeps): AgentProcessDeps {
    return {
      ...deps,
      spawn: (command, args, options) => {
        const proc = deps.spawn(command, args, options);
        // Codex's sandbox probe is a side process that ends itself, not the runner.
        if (args[0] !== 'sandbox') {
          Object.defineProperty(proc, 'pid', { value: nextPid++ });
          launched.push(proc as unknown as FakeAgentProcess);
        }
        return proc;
      },
    };
  }

  const groupSignals = (proc: ChildProcess) => kill.mock.calls.filter(([pid]) => pid === -(proc.pid ?? 0)).map(([, signal]) => String(signal));

  beforeEach(() => {
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    for (const proc of launched.splice(0)) proc.exit(0);
    kill.mockRestore();
    vi.useRealTimers();
  });

  /** A turn open under `signal`, with a probe resource claimed the way an adapter claims its own. */
  async function inTurn(signal?: AbortSignal) {
    const fake = FAKE_RUNNERS[runner]({ attach: 'connected' });
    const adapter = CONNECTORS[runner].create(tracked(fake.deps));
    const start = CONNECTORS[runner].plans ? plannerStart : taskStart(runner);
    await adapter.start(fake.withServer?.(start) ?? start);
    const released = vi.fn();
    (adapter as unknown as { own(name: string, release: () => void): void }).own('probe', released);
    const turn = adapter.send('go', () => {}, signal);
    await fake.turnOpen();
    const config = fake.commandLine().match(/--mcp-config (\S+)/)?.[1];
    // After the turn is open, which waits on timers of its own: the forced
    // follow-up kill is a timer, and faked it fires under the spy rather than
    // against a real group after the test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    return { adapter, turn, released, config };
  }

  const stops = [
    ['disposed', (adapter: { dispose(): void }) => adapter.dispose(), false],
    ['aborted mid-turn', () => undefined, true],
  ] as const;

  it.each(stops)('frees every resource it owns and kills the process group when %s', async (_how, stop, aborts) => {
    const controller = new AbortController();
    const { adapter, turn, released, config } = await inTurn(controller.signal);
    if (config) expect(existsSync(config)).toBe(true);
    expect(released).not.toHaveBeenCalled();
    expect(groupSignals(launched[0])).toEqual([]);

    stop(adapter);
    // A disposed adapter's open turn is abandoned, not settled; an aborted one ends.
    if (aborts) {
      controller.abort();
      await turn.catch(() => undefined);
    }

    expect(released).toHaveBeenCalledTimes(1);
    if (config) expect(existsSync(config)).toBe(false);
    expect(groupSignals(launched[0])).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(5_000);
    expect(groupSignals(launched[0])).toEqual(['SIGTERM', 'SIGKILL']);
    adapter.dispose();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('frees what the process owns when it ends on its own, before anything disposes it', async () => {
    const { adapter, turn, released, config } = await inTurn();

    launched[0].exit(1);
    await turn;

    expect(released).toHaveBeenCalledTimes(1);
    if (config) expect(existsSync(config)).toBe(false);
    adapter.dispose();
    expect(released).toHaveBeenCalledTimes(1);
  });
});
