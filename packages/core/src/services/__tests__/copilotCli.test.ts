import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import { AcpAdapter } from '../harness/AcpAdapter';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import type { AcpProfile } from '../harness/acpProfiles';
import { COPILOT_CLI_PROFILE } from '../harness/copilotProfile';
import { decidePlannerPermission } from '../harness/plannerPermissions';
import type { AcpToolCall } from '../harness/acpSchema';
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

/** Where each test's start puts the task, which the recordings name `{{CWD}}`. */
const CWD = '/repo';

type Recorded =
  | { dir: 'in' | 'out'; ms: number; line: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } } }
  | {
    dir: 'note'; ms: number; event: string; args?: string[]; calls?: string[]; leftBehind?: string[];
    /** Where Copilot was started, `{{START_DIR}}` for the private directory, and what was in it then. */
    cwd?: string; tmpdir?: string; startDirAtSpawn?: string[]; instructionsDirs?: string | null; COPILOT_ALLOW_ALL?: string | null;
    /** The markers the recorded workspace's `.github/hooks/` hook wrote, one per hook event that ran it. */
    hooksRan?: string[];
  };

function recording(name: string): Recorded[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').replaceAll('{{CWD}}', CWD).trim().split('\n').map((line) => JSON.parse(line) as Recorded);
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

/** Where Copilot was recorded starting, and the hooks the workspace it served ran there. */
function recordedLaunch(name: string) {
  const spawn = note(name, 'spawn');
  return {
    cwd: spawn?.cwd, tmpdir: spawn?.tmpdir, startDirAtSpawn: spawn?.startDirAtSpawn,
    instructionsDirs: spawn?.instructionsDirs, allowAll: spawn?.COPILOT_ALLOW_ALL, hooksRan: note(name, 'summary')?.hooksRan,
  };
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

  it('takes a call for Ordewell\'s only when its request names the tool bare and its report names it on Ordewell\'s server, whatever kind either says', () => {
    const binding = acpOrdewellBinding(COPILOT_CLI_PROFILE);
    const call = (title: string, kind: AcpToolCall['kind']): AcpToolCall => ({ toolCallId: 'c', title, kind });
    // Copilot's kind for an MCP tool is its guess at what the tool does: the
    // planner recording reports run_plan as `execute` and list_runners as `read`.
    expect(binding.isOrdewellAsk({ request: call('task_complete', 'other'), report: call('ordewell-task_complete', 'other') })).toBe(true);
    expect(binding.isOrdewellAsk({ request: call('run_plan', 'other'), report: call('ordewell-run_plan', 'execute') })).toBe(true);
    expect(binding.isOrdewellAsk({ request: call('list_runners', 'read'), report: call('ordewell-list_runners', 'read') })).toBe(true);
    // The bare name alone; a model-written command title, which Copilot puts
    // on both; a lookalike server; two names that disagree; no such tool.
    expect(binding.isOrdewellAsk({ request: call('task_complete', 'other') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('ordewell-task_complete', 'execute'), report: call('ordewell-task_complete', 'execute') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('task_complete', 'other'), report: call('ordewell-evil-task_complete', 'other') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('run_plan', 'other'), report: call('ordewell-task_complete', 'other') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('rm', 'other'), report: call('ordewell-rm', 'other') })).toBe(false);
  });
});

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
  const models = vi.fn(async () => ({ text: '[]' }));
  const credential = await server.issuePlannerToken({ sessionId: 's1' }, { submitPlan: submitted, listRunners: listed, listModels: models } as never);
  return { mcp: mcpClientConfig(credential), submitted, listed, models };
}

/** Copilot's read-only mode, as the plan names it. */
const READ_ONLY_MODE = COPILOT_CLI_MANIFEST.modes?.find((mode) => mode.readOnly)?.id ?? 'none';

function readOnlyStart(mcp: McpClientConfig): TaskStartOptions {
  return taskStart(mcp, READ_ONLY_MODE);
}

function plannerStart(mcp: McpClientConfig): PlannerStartOptions {
  return { kind: 'planner', cwd: CWD, model: 'gpt-6-luna', systemPrompt: 'You are the planner.', mcp };
}

/** A planner's turn, every held request put to its envelope as `CliAgentAiService` puts it (ADR-0026). */
async function plannerTurn(adapter: TaskModeAgentAdapter): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await adapter.send('go', (event) => {
    events.push(event);
    if (event.type === 'permission_request' && !event.decided) {
      void decidePlannerPermission(event.ask, event.input ?? {}, { workspaceRoot: CWD })
        .then((decision) => adapter.answerPermission?.(event.id, decision));
    }
  });
  return events;
}

const failures = (events: AgentEvent[]) => JSON.stringify(events.filter((e) => e.type === 'tool_result'));

/** The recorded launch with its private directory put back as `dir`, the one this start made. */
function launchedAs(name: string, dir: string) {
  const at = (path: string | undefined) => (path === '{{START_DIR}}' ? dir : path);
  const launch = recordedLaunch(name);
  return { ...launch, cwd: at(launch.cwd), tmpdir: at(launch.tmpdir) };
}

describe('copilot-cli roles, replayed from Copilot CLI 1.0.105 (ADR-0026, ADR-0028, ADR-0046, ADR-0060)', () => {
  it('claims both roles: it plans, and offers a read-only mode', () => {
    expect(CONNECTORS['copilot-cli'].plans).toBe(true);
    expect(READ_ONLY_MODE).toBe('plan');
  });

  it.each([
    ['planner', async () => plannerStart((await plannerToken()).mcp)],
    ['read-only', async () => readOnlyStart((await readOnlyToken()).mcp)],
  ] as const)('starts a %s session in a directory of its own, as it was recorded running none of the workspace\'s hooks', async (name, start) => {
    const { spawned, agent, adapter } = copilot(replay(name, EAGER_CONTACT));
    await adapter.start(await start());

    const dir = spawned.lastCwd() ?? '';
    const env = spawned.lastEnv();
    expect(dir.startsWith(CWD)).toBe(false);
    expect(spawned.lastArgs()).toEqual(recordedArgs(name));
    const { hooksRan, ...launch } = launchedAs(name, dir);
    expect({
      cwd: dir, tmpdir: env.TMPDIR, startDirAtSpawn: readdirSync(dir), instructionsDirs: env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? null, allowAll: env.COPILOT_ALLOW_ALL,
    }).toEqual(launch);
    expect((agent.requests('session/new')[0].params as { cwd: string }).cwd).toBe(dir);
    // The workspace's marker hook wrote nothing on the recorded start.
    expect(hooksRan).toEqual([]);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain(`The workspace is \`${CWD}\`, not the directory you start in`);
  });

  it('starts a writable task in its worktree, where the same workspace\'s hooks were recorded running', async () => {
    const { mcp } = await taskToken();
    const { spawned, adapter } = copilot(replay('repo-hooks', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));

    const launch = recordedLaunch('repo-hooks');
    expect(spawned.lastArgs()).toEqual(recordedArgs('repo-hooks'));
    expect(spawned.lastCwd()).toBe(launch.cwd);
    expect(spawned.lastEnv().COPILOT_ALLOW_ALL).toBeUndefined();
    expect(launch.hooksRan).toEqual(['repohooks-preToolUse', 'repohooks-sessionEnd', 'repohooks-sessionStart', 'repohooks-userPromptSubmitted']);
  });

  it('plans with Ordewell\'s planner tools alone: a read goes to the envelope, its own shell is refused by Copilot and a write by Ordewell, and nothing is left behind', async () => {
    const { mcp, submitted, listed, models } = await plannerToken();
    const { agent, adapter } = copilot(replay('planner', {
      ...EAGER_CONTACT,
      'session/prompt': ['list_runners', 'list_models', 'submit_plan'].map((tool) => ({ callMcp: { tool, args: recordedMcpCall('planner', tool) } })),
    }));
    await adapter.start(plannerStart(mcp));
    const events = await plannerTurn(adapter);

    // Copilot asks to reach a workspace path as a read, even for a file it
    // would create: the turn's report of the call says which it is.
    const requests = asked(events);
    expect(requests.map((e) => [e.input?.path, e.decided?.decision])).toEqual([
      [`${CWD}/README.md`, undefined],
      [`${CWD}/probe-write.txt`, 'deny'],
    ]);
    expect(requests[0].ask).toEqual({ kind: 'path', path: `${CWD}/README.md`, directory: false });
    expect(permissionAnswers(agent)).toEqual([
      { outcome: 'selected', optionId: 'allow_once' },
      { outcome: 'selected', optionId: 'reject_once' },
    ]);
    expect(failures(events)).toContain('denied due to the following rules: `shell`');
    expect(failures(events)).toContain('The user rejected this tool call.');
    expect(listed).toHaveBeenCalled();
    expect(models).toHaveBeenCalled();
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ tasks: [expect.objectContaining({ assignedRunner: 'copilot-cli' })] }), expect.anything());
    expect(recordedOutcome('planner')).toEqual({ calls: ['list_runners', 'list_models', 'submit_plan'], leftBehind: [] });
    expect(agent.problems).toEqual([]);
    // The recording ends with the session closed, as disposing it closes it.
    adapter.dispose();
    await agent.finished;
  });

  it('allows a planner\'s call of an Ordewell tool by its two names, though Copilot reports run_plan as a command (ADR-0022, S3)', async () => {
    const { mcp } = await plannerToken();
    const { spawned, agent, adapter } = copilot(replay('planner-in-worktree', EAGER_CONTACT));
    await adapter.start(plannerStart(mcp));
    const events = await plannerTurn(adapter);

    const text = readFileSync(join(spawned.lastCwd() ?? '', 'AGENTS.md'), 'utf8');
    expect(text).toContain('You are the planner.');
    expect(text).toContain('Your Ordewell tools come from the `ordewell` MCP server');
    expect(failures(events)).toContain('denied due to the following rules: `shell`');
    expect(asked(events).map((e) => [e.name, e.decided])).toEqual([['run_plan', { decision: 'allow' }]]);
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'allow_once' }]);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('runs a read-only task in Copilot\'s read-only mode: its read of the workspace is allowed, and it completes through Ordewell', async () => {
    const { mcp, completed } = await readOnlyToken();
    const { agent, adapter } = copilot(replay('read-only', {
      ...EAGER_CONTACT,
      'session/prompt': [{ callMcp: { tool: 'task_complete', args: recordedMcpCall('read-only', 'task_complete') } }],
    }));
    await adapter.start(readOnlyStart(mcp));
    const events = await turn(adapter);

    expect(asked(events).map((e) => [e.name, e.input?.path, e.decided])).toEqual([
      ['Access paths outside trusted directories', `${CWD}/README.md`, { decision: 'allow' }],
      ['task_complete', undefined, { decision: 'allow' }],
    ]);
    expect(permissionAnswers(agent)).toEqual([
      { outcome: 'selected', optionId: 'allow_once' },
      { outcome: 'selected', optionId: 'allow_once' },
    ]);
    expect(recordedOutcome('read-only')).toEqual({ calls: ['task_complete'], leftBehind: [] });
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }), expect.anything());
    expect(agent.problems).toEqual([]);
    // The recording ends with the session closed, as disposing it closes it.
    adapter.dispose();
    await agent.finished;
  });

  it('runs a read-only task under the controls Copilot was recorded refusing a write and a command under, which left nothing behind', async () => {
    const { mcp, completed } = await readOnlyToken();
    const { agent, adapter } = copilot(replay('read-only-in-worktree', {
      ...EAGER_CONTACT,
      'session/request_permission': [{ callMcp: { tool: 'task_complete', args: recordedMcpCall('read-only-in-worktree', 'task_complete') } }],
    }));
    await adapter.start(readOnlyStart(mcp));
    const events = await turn(adapter);

    // Copilot refused both itself, by the denied tools, and asked nothing.
    expect(failures(events)).toContain('denied due to the following rules: `write`');
    expect(failures(events)).toContain('denied due to the following rules: `shell`');
    expect(asked(events).map((e) => e.decided)).toEqual([{ decision: 'allow' }]);
    expect(recordedOutcome('read-only-in-worktree')).toEqual({ calls: ['run_command', 'task_complete'], leftBehind: [] });
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }), expect.anything());
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('tells a read-only task its own tools are off, beside the contract, in its private directory\'s instructions', async () => {
    const { mcp } = await readOnlyToken();
    const { spawned, adapter } = copilot(replay('read-only', EAGER_CONTACT));
    await adapter.start(readOnlyStart(mcp));

    const text = readFileSync(join(spawned.lastCwd() ?? '', 'AGENTS.md'), 'utf8');
    expect(text).toContain('This task is read-only: your own file edits, shell and web tools are off.');
    expect(text).toContain('`ordewell-run_command`');
    expect(text).toContain('call the `task_complete` tool');
  });
});
