import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import { AcpAdapter } from '../harness/AcpAdapter';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import type { AcpProfile } from '../harness/acpProfiles';
import { COPILOT_CLI_PROFILE } from '../harness/copilotProfile';
import { decidePlannerPermission } from '../harness/plannerPermissions';
import type { AgentEvent, AgentProcessDeps, PlannerStartOptions, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
import { COPILOT_CLI_MANIFEST } from '../../plugins/builtin/copilot-cli.manifest';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { OrdewellMcpServer, mcpClientConfig, type McpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpAgent, type FakeAcpStep } from './fakeAcpAgent';

/**
 * The copilot-cli connector against Copilot CLI 1.0.105 as it was recorded
 * over ACP (`fixtures/acp/copilot-cli/`): each recording is replayed as the
 * agent's side of the conversation, with Ordewell's side live.
 */

const FIXTURES = join(__dirname, 'fixtures/acp/copilot-cli');

type Recorded =
  | { dir: 'in' | 'out'; ms: number; line: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } } }
  | { dir: 'note'; ms: number; event: string; args?: string[]; calls?: string[]; leftBehind?: string[] };

function recording(name: string): Recorded[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Recorded);
}

function note(name: string, event: string): Extract<Recorded, { dir: 'note' }> | undefined {
  const found = recording(name).find((entry) => entry.dir === 'note' && entry.event === event);
  return found?.dir === 'note' ? found : undefined;
}

/** The arguments Copilot was recorded running under. */
function recordedArgs(name: string): string[] {
  return note(name, 'spawn')?.args ?? [];
}

/** What the recorder saw live: the Ordewell tools called, and the files left in the session's real directory. */
function recordedOutcome(name: string): { calls: string[]; leftBehind: string[] } {
  const summary = note(name, 'summary');
  return { calls: summary?.calls ?? [], leftBehind: summary?.leftBehind ?? [] };
}

/** The arguments the agent called an Ordewell tool with, as its own tool-call report showed them. */
function recordedMcpCall(name: string, tool: string): Record<string, unknown> {
  for (const entry of recording(name)) {
    const update = entry.dir === 'in' ? (entry.line.params as { update?: { sessionUpdate?: string; title?: string; rawInput?: Record<string, unknown> } } | undefined)?.update : undefined;
    if (update?.sessionUpdate === 'tool_call' && update.title === `ordewell-${tool}`) return update.rawInput ?? {};
  }
  throw new Error(`${name} has no call of ${tool}`);
}

/**
 * The agent's side of a recording as a script: what Ordewell sent becomes what
 * the agent waits for, and what Copilot sent is sent again, each answer to the
 * request it answered. Ordewell's own answers are not replayed: the adapter
 * gives its own. A request of Copilot's waits for its answer unless the
 * recording shows Ordewell saying something else first, as a cancel does.
 * `after` adds steps the wire cannot show, keyed by the method they follow:
 * Copilot's MCP traffic goes to the server, not over stdio.
 */
function replay(name: string, after: Partial<Record<string, FakeAcpStep[]>> = {}): FakeAcpStep[] {
  const steps: FakeAcpStep[] = [];
  const sent = new Map<number, string>();
  const wire = recording(name).flatMap((entry) => (entry.dir === 'note' ? [] : [entry]));
  const answeredNext = (index: number, id: number) => {
    const next = wire.slice(index + 1).find((entry) => entry.dir === 'out');
    return next?.line.method === undefined && next?.line.id === id;
  };
  for (const [index, entry] of wire.entries()) {
    const { line } = entry;
    if (entry.dir === 'out') {
      if (line.method === undefined) continue;
      if (line.id !== undefined) sent.set(line.id, line.method);
      steps.push({ expect: line.method }, ...(after[line.method] ?? []));
    } else if (line.method !== undefined) {
      const { method, params, id } = line;
      if (id === undefined) steps.push({ notify: method, params });
      else if (answeredNext(index, id)) steps.push({ request: method, params });
      else steps.push({ run: (agent) => { void agent.ask(method, params); } });
      if (id !== undefined) steps.push(...(after[method] ?? []));
    } else if (line.id !== undefined) {
      const to = sent.get(line.id);
      steps.push(line.error ? { fail: line.error, ...(to ? { to } : {}) } : { answer: line.result, ...(to ? { to } : {}) });
    }
  }
  return steps;
}

/** Copilot lists the server's tools while it opens the session, before it answers `session/new`. */
const EAGER_CONTACT: Partial<Record<string, FakeAcpStep[]>> = {
  'session/new': [{ run: async (agent) => { await agent.listMcpTools(); } }],
};

const adapters: TaskModeAgentAdapter[] = [];
const servers: OrdewellMcpServer[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
});

async function taskToken(): Promise<{ mcp: McpClientConfig; completed: ReturnType<typeof vi.fn> }> {
  const server = new OrdewellMcpServer();
  servers.push(server);
  const completed = vi.fn(async () => ({ text: 'Recorded.' }));
  const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1 }, { taskComplete: completed } as never);
  return { mcp: mcpClientConfig(credential), completed };
}

function copilot(steps: FakeAcpStep[], profile?: AcpProfile) {
  const spawned = fakeAcpSpawn(steps);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP for Copilot'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  const adapter = profile ? new AcpAdapter(deps, profile) : CONNECTORS['copilot-cli'].create(deps);
  adapters.push(adapter);
  return { spawned, agent: spawned.agent, adapter };
}

function taskStart(mcp: McpClientConfig, mode = 'default'): TaskStartOptions {
  const model = 'gpt-6-luna';
  return { kind: 'task', cwd: '/repo', mode, model, flags: resolveTaskRunnerFlags(COPILOT_CLI_MANIFEST, { mode, model }), mcp };
}

/** One turn, with every request held for a person answered as `answer` would. */
async function turn(adapter: TaskModeAgentAdapter, answer?: 'allow' | 'deny', signal?: AbortSignal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await adapter.send('go', (event) => {
    events.push(event);
    if (event.type === 'permission_request' && !event.decided && answer) {
      queueMicrotask(() => { void adapter.answerPermission?.(event.id, { decision: answer }); });
    }
  }, signal);
  return events;
}

const permissionAnswers = (agent: FakeAcpAgent) =>
  agent.answers.filter((a) => a.method === 'session/request_permission').map((a) => (a.result as { outcome: unknown }).outcome);

const asked = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'permission_request' ? [e] : []));

describe('copilot-cli, replayed from Copilot CLI 1.0.105', () => {
  it('launches Copilot over ACP on the plan\'s model, as it was recorded', async () => {
    const { mcp } = await taskToken();
    const { spawned, agent, adapter } = copilot(replay('ordewell-tool', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));

    expect(spawned.lastCommand()).toBe('copilot');
    expect(spawned.lastArgs()).toEqual(recordedArgs('ordewell-tool'));
    expect(agent.problems).toEqual([]);
  });

  it('hands Copilot its instructions in a private directory named by COPILOT_CUSTOM_INSTRUCTIONS_DIRS, never the worktree', async () => {
    const { mcp } = await taskToken();
    const { spawned, adapter } = copilot(replay('ordewell-tool', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));

    const dir = spawned.lastEnv().COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? '';
    expect(dir).not.toBe('');
    expect(dir.startsWith('/repo')).toBe(false);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('call the `task_complete` tool');
  });

  it('reads Copilot\'s eager MCP contact as attached', async () => {
    const { mcp } = await taskToken();
    const { adapter } = copilot(replay('ordewell-tool', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));

    expect(await adapter.mcpAttached?.()).toBe('connected');
  });

  it('allows Copilot\'s request to call task_complete at once, by its exact name, and the call reaches the server', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = copilot(replay('ordewell-tool', {
      ...EAGER_CONTACT,
      'session/request_permission': [{ callMcp: { tool: 'task_complete', args: { status: 'done', summary: 'ok' } } }],
    }));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter);

    expect(asked(events).map((e) => e.decided)).toEqual([{ decision: 'allow' }]);
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'allow_once' }]);
    expect(events.some((e) => e.type === 'tool_call' && e.name === 'ordewell-task_complete')).toBe(true);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', summary: 'ok' }), expect.anything());
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it.each([
    ['edit', 'Create file'],
    ['execute', 'Run the requested shell command once and capture its output'],
  ])('holds Copilot\'s %s for a person, and passes the person\'s answer back', async (name, title) => {
    const { mcp } = await taskToken();
    const { agent, adapter } = copilot(replay(name, EAGER_CONTACT));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter, 'allow');

    const requests = asked(events);
    expect(requests).toHaveLength(1);
    expect(requests[0].decided).toBeUndefined();
    expect(JSON.stringify(requests[0])).toContain(title);
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'allow_once' }]);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('interrupts a turn Copilot is waiting on a person in: the held request is answered cancelled', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = copilot(replay('cancel', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));
    let interrupted: Promise<boolean> | undefined;
    const events: AgentEvent[] = [];
    await adapter.send('go', (event) => {
      events.push(event);
      if (event.type === 'permission_request') interrupted = adapter.interrupt(1000);
    });

    expect(await interrupted).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(agent.requests('session/cancel')).toHaveLength(1);
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'cancelled' }]);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('runs Copilot with --allow-all under allowAll, where it asks about nothing', async () => {
    const { mcp } = await taskToken();
    const { spawned, agent, adapter } = copilot(replay('allow-all', EAGER_CONTACT));
    await adapter.start(taskStart(mcp, 'allowAll'));
    const events = await turn(adapter);

    expect([...spawned.lastArgs()].sort()).toEqual([...recordedArgs('allow-all')].sort());
    expect(asked(events)).toEqual([]);
    expect(events.filter((e) => e.type === 'tool_call').length).toBe(2);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('does not take a call Copilot reports in other words for one of Ordewell\'s', async () => {
    const binding = acpOrdewellBinding(COPILOT_CLI_PROFILE);
    // The permission request's bare name, a model-written command title, and a lookalike server.
    expect(binding.isOrdewellAsk({ toolCallId: 'a', title: 'task_complete', kind: 'other' })).toBe(false);
    expect(binding.isOrdewellAsk({ toolCallId: 'b', title: 'ordewell-task_complete', kind: 'execute' })).toBe(false);
    expect(binding.isOrdewellAsk({ toolCallId: 'c', title: 'ordewell-evil-task_complete', kind: 'other' })).toBe(false);
    expect(binding.isOrdewellAsk({ toolCallId: 'd', title: 'ordewell-task_complete', kind: 'other' })).toBe(true);
  });
});

/**
 * Copilot as it would be with both roles claimed, to replay what the controls
 * were recorded doing. Its own profile withholds both all the same: Copilot
 * runs the repository's hooks under ACP (ADR-0028).
 */
const COPILOT_WITH_ROLES: AcpProfile = {
  ...COPILOT_CLI_PROFILE,
  manifest: {
    ...COPILOT_CLI_MANIFEST,
    modes: [...(COPILOT_CLI_MANIFEST.modes ?? []), { id: 'readOnly', label: 'Read-only', description: 'Reads only', readOnly: true }],
  },
  roles: { plans: true, readOnly: true },
};

async function readOnlyToken() {
  const server = new OrdewellMcpServer();
  servers.push(server);
  const completed = vi.fn(async () => ({ text: 'Recorded.' }));
  const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1, readOnly: true }, { taskComplete: completed } as never);
  return { mcp: mcpClientConfig(credential), completed };
}

async function plannerToken() {
  const server = new OrdewellMcpServer();
  servers.push(server);
  const submitted = vi.fn(async () => ({ text: 'Plan received.' }));
  const listed = vi.fn(async () => ({ text: '[]' }));
  const credential = await server.issuePlannerToken({ sessionId: 's1' }, { submitPlan: submitted, listRunners: listed } as never);
  return { mcp: mcpClientConfig(credential), submitted, listed };
}

function readOnlyStart(mcp: McpClientConfig): TaskStartOptions {
  const model = 'gpt-6-luna';
  return { kind: 'task', cwd: '/repo', mode: 'readOnly', model, flags: resolveTaskRunnerFlags(COPILOT_WITH_ROLES.manifest, { mode: 'readOnly', model }), mcp };
}

function plannerStart(mcp: McpClientConfig): PlannerStartOptions {
  return { kind: 'planner', cwd: '/repo', model: 'gpt-6-luna', systemPrompt: 'You are the planner.', mcp };
}

/** A planner's turn, every held request put to its envelope as `CliAgentAiService` puts it (ADR-0026). */
async function plannerTurn(adapter: TaskModeAgentAdapter): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await adapter.send('go', (event) => {
    events.push(event);
    if (event.type === 'permission_request' && !event.decided) {
      void decidePlannerPermission(event.ask, event.input ?? {}, { workspaceRoot: '/repo' })
        .then((decision) => adapter.answerPermission?.(event.id, decision));
    }
  });
  return events;
}

const failures = (events: AgentEvent[]) => JSON.stringify(events.filter((e) => e.type === 'tool_result'));

describe('copilot-cli roles, replayed from Copilot CLI 1.0.105 (ADR-0026, ADR-0028, ADR-0046)', () => {
  it('claims neither role, so it plans nothing and offers no read-only mode', async () => {
    expect(CONNECTORS['copilot-cli'].plans).toBe(false);
    expect(COPILOT_CLI_MANIFEST.modes?.some((mode) => mode.readOnly)).toBe(false);
    const { mcp } = await plannerToken();
    const { spawned, adapter } = copilot([]);

    await expect(adapter.start(plannerStart(mcp))).rejects.toThrow('GitHub Copilot CLI cannot plan in Ordewell: its profile claims no planner role.');
    expect(spawned.processes).toHaveLength(0);
  });

  it('runs a read-only task under the controls Copilot was recorded refusing a write and a command under, which left nothing behind', async () => {
    const { mcp, completed } = await readOnlyToken();
    const { spawned, agent, adapter } = copilot(replay('read-only', {
      ...EAGER_CONTACT,
      'session/request_permission': [{ callMcp: { tool: 'task_complete', args: recordedMcpCall('read-only', 'task_complete') } }],
    }), COPILOT_WITH_ROLES);
    await adapter.start(readOnlyStart(mcp));
    const events = await turn(adapter);

    expect(spawned.lastArgs()).toEqual(recordedArgs('read-only'));
    expect(spawned.lastEnv().COPILOT_ALLOW_ALL).toBe('false');
    // Copilot refused both itself, by the denied tools, and asked nothing.
    expect(failures(events)).toContain('denied due to the following rules: `write`');
    expect(failures(events)).toContain('denied due to the following rules: `shell`');
    expect(asked(events).map((e) => e.decided)).toEqual([{ decision: 'allow' }]);
    expect(recordedOutcome('read-only')).toEqual({ calls: ['run_command', 'task_complete'], leftBehind: [] });
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }), expect.anything());
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('tells a read-only task its own tools are off, beside the contract, from its private directory', async () => {
    const { mcp } = await readOnlyToken();
    const { spawned, adapter } = copilot(replay('read-only', EAGER_CONTACT), COPILOT_WITH_ROLES);
    await adapter.start(readOnlyStart(mcp));

    const text = readFileSync(join(spawned.lastEnv().COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? '', 'AGENTS.md'), 'utf8');
    // The recording was made without this note: told its tools were off, the model would not try them.
    expect(text).toContain('This task is read-only: your own file edits, shell and web tools are off.');
    expect(text).toContain('`ordewell-run_command`');
    expect(text).toContain('call the `task_complete` tool');
  });

  it('plans with Ordewell\'s planner tools alone: its own shell is refused, and a tool it reports as a command goes to the envelope', async () => {
    const { mcp, submitted, listed } = await plannerToken();
    const { spawned, agent, adapter } = copilot(replay('planner', {
      ...EAGER_CONTACT,
      'session/prompt': [
        { callMcp: { tool: 'list_runners', args: recordedMcpCall('planner', 'list_runners') } },
        { callMcp: { tool: 'submit_plan', args: recordedMcpCall('planner', 'submit_plan') } },
      ],
    }), COPILOT_WITH_ROLES);
    await adapter.start(plannerStart(mcp));
    const events = await plannerTurn(adapter);

    expect(spawned.lastArgs()).toEqual(recordedArgs('planner'));
    const text = readFileSync(join(spawned.lastEnv().COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? '', 'AGENTS.md'), 'utf8');
    expect(text).toContain('You are the planner.');
    expect(text).toContain('Your Ordewell tools come from the `ordewell` MCP server');
    expect(recordedOutcome('planner')).toEqual({ calls: ['list_runners', 'submit_plan'], leftBehind: [] });
    expect(listed).toHaveBeenCalled();
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ tasks: [expect.objectContaining({ assignedRunner: 'copilot-cli' })] }), expect.anything());
    expect(failures(events)).toContain('denied due to the following rules: `shell`');
    // run_plan's report says `execute`, which a model-written command title
    // could say too, so it is not taken for Ordewell's and its envelope has no rule for it.
    expect(asked(events).map((e) => [e.name, e.ask, e.decided])).toEqual([['run_plan', { kind: 'other' }, undefined]]);
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'reject_once' }]);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });
});
