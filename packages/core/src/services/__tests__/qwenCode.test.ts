import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import { QWEN_CODE_PROFILE } from '../harness/qwenProfile';
import { decidePlannerPermission } from '../harness/plannerPermissions';
import type { AcpToolCall } from '../harness/acpSchema';
import type { AgentEvent, AgentProcessDeps, PlannerStartOptions, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
import { QWEN_CODE_MANIFEST } from '../../plugins/builtin/qwen.manifest';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { OrdewellMcpServer, mcpClientConfig, type McpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpAgent, type FakeAcpStep } from './fakeAcpAgent';
import { stubNoOrdewellProvider } from './ordewellProviderEnv';

/**
 * The qwen-code connector against Qwen Code 0.26.6 as it was recorded over ACP
 * (`fixtures/acp/qwen-code/`): each recording is replayed as the agent's side
 * of the conversation, with Ordewell's side live.
 */

const FIXTURES = join(__dirname, 'fixtures/acp/qwen-code');

/** Where each test's start puts the task, which the recordings name `{{CWD}}`. */
const CWD = '/repo';

type Recorded =
  | { dir: 'in' | 'out'; ms: number; line: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } } }
  | {
    dir: 'note'; ms: number; event: string; args?: string[]; completed?: string[]; calls?: string[]; leftBehind?: string[]; hooksRan?: string[];
    cwd?: string; tmpdir?: string; startDirAtSpawn?: string[]; permissions?: RecordedPermission[];
  };

/** A permission request as the recording's summary lists it, with the option Ordewell answered of the kind it was. */
interface RecordedPermission { title: string; kind: string; toolName: string; answered: string }

function recording(name: string): Recorded[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').replaceAll('{{CWD}}', CWD).trim().split('\n').map((line) => JSON.parse(line) as Recorded);
}

function note(name: string, event: string): Extract<Recorded, { dir: 'note' }> | undefined {
  const found = recording(name).find((entry) => entry.dir === 'note' && entry.event === event);
  return found?.dir === 'note' ? found : undefined;
}

/** The arguments Qwen was recorded running under. */
const recordedArgs = (name: string): string[] => note(name, 'spawn')?.args ?? [];

/** What Ordewell sent Qwen to set, as the recording shows it, in order. */
function settingsOf(params: unknown): { configId: string; value: string } {
  const { configId, value } = params as { configId: string; value: string };
  return { configId, value };
}

function recordedSettings(name: string) {
  return recording(name).flatMap((entry) => (entry.dir === 'out' && entry.line.method === 'session/set_config_option' ? [settingsOf(entry.line.params)] : []));
}

/** What the recorded run called of Ordewell's, what it was asked and how each was answered, and what it left in the workspace and the start directory. */
function recordedOutcome(name: string) {
  const summary = note(name, 'summary');
  return { calls: summary?.calls ?? [], permissions: summary?.permissions ?? [], leftBehind: summary?.leftBehind ?? [] };
}

/** The arguments the agent called an Ordewell tool with, as its permission request showed them. */
function recordedMcpCall(name: string, tool: string): Record<string, unknown> {
  for (const entry of recording(name)) {
    const call = entry.dir === 'in' && entry.line.method === 'session/request_permission'
      ? (entry.line.params as { toolCall: { rawInput?: Record<string, unknown>; _meta?: { toolName?: string } } }).toolCall
      : undefined;
    if (call?._meta?.toolName === `mcp__ordewell__${tool}`) return call.rawInput ?? {};
  }
  throw new Error(`${name} has no call of ${tool}`);
}

/** The text of the first prompt Ordewell was recorded sending. */
function recordedPrompt(name: string): string {
  const sent = recording(name).find((entry) => entry.dir === 'out' && entry.line.method === 'session/prompt');
  const prompt = sent?.dir === 'out' ? (sent.line.params as { prompt: { text?: string }[] }).prompt : [];
  return prompt.map((block) => block.text ?? '').join('');
}

/** Where Qwen was recorded starting, and the hooks the workspace it served ran there. */
function recordedLaunch(name: string) {
  const spawn = note(name, 'spawn');
  return { cwd: spawn?.cwd, tmpdir: spawn?.tmpdir, startDirAtSpawn: spawn?.startDirAtSpawn, hooksRan: note(name, 'summary')?.hooksRan };
}

/** The model the recordings ran on, as `session/new` named it and `--model` took it. */
const MODEL = recordedArgs('ordewell-tool')[2];

/**
 * The agent's side of a recording as a script: what Ordewell sent becomes what
 * the agent waits for, and what Qwen sent is sent again, each answer to the
 * request it answered. Ordewell's own answers are not replayed: the adapter
 * gives its own. A request of Qwen's waits for its answer unless the recording
 * shows Ordewell saying something else first, as a cancel does. `after` adds
 * steps the wire cannot show, keyed by the method they follow: Qwen's MCP
 * traffic goes to the server, not over stdio.
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

/** Qwen contacts the server while it opens the session, before it answers `session/new`'s caller again. */
const EAGER_CONTACT: Partial<Record<string, FakeAcpStep[]>> = {
  'session/new': [{ run: async (agent) => { await agent.listMcpTools(); } }],
};

const adapters: TaskModeAgentAdapter[] = [];
const servers: OrdewellMcpServer[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
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

function qwen(steps: FakeAcpStep[], workspace: Record<string, string> = {}) {
  const spawned = fakeAcpSpawn(steps);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP for Qwen'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => workspace,
  };
  const adapter = CONNECTORS['qwen-code'].create(deps);
  adapters.push(adapter);
  return { spawned, agent: spawned.agent, adapter };
}

function taskStart(mcp: McpClientConfig, mode = 'default'): TaskStartOptions {
  return { kind: 'task', cwd: CWD, mode, model: MODEL, flags: resolveTaskRunnerFlags(QWEN_CODE_MANIFEST, { mode, model: MODEL }), mcp };
}

/** One turn, with every request held for a person answered as `answer` would. */
async function turn(adapter: TaskModeAgentAdapter, answer?: 'allow' | 'deny'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await adapter.send('go', (event) => {
    events.push(event);
    if (event.type === 'permission_request' && !event.decided && answer) {
      queueMicrotask(() => { void adapter.answerPermission?.(event.id, { decision: answer }); });
    }
  });
  return events;
}

const permissionAnswers = (agent: FakeAcpAgent) =>
  agent.answers.filter((a) => a.method === 'session/request_permission').map((a) => (a.result as { outcome: unknown }).outcome);

const asked = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'permission_request' ? [e] : []));

describe('qwen-code, replayed from Qwen Code 0.26.6', () => {
  it('launches Qwen over ACP on the plan\'s model, as it was recorded', async () => {
    const { mcp } = await taskToken();
    const { spawned, agent, adapter } = qwen(replay('ordewell-tool', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));

    expect(spawned.lastCommand()).toBe('qwen');
    expect(spawned.lastArgs()).toEqual(recordedArgs('ordewell-tool'));
    expect(agent.problems).toEqual([]);
  });

  it('sets the plan\'s mode and then its model as config options, as the recording shows Ordewell doing', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = qwen(replay('ordewell-tool', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));

    expect(recordedSettings('ordewell-tool').map((s) => s.configId)).toEqual(['mode', 'model']);
    expect(agent.requests('session/set_config_option').map((r) => settingsOf(r.params))).toEqual(recordedSettings('ordewell-tool'));
    expect(agent.requests('session/set_mode')).toEqual([]);
    expect(agent.problems).toEqual([]);
  });

  it('reads Qwen\'s contact with the server while it opens the session as attached', async () => {
    const { mcp } = await taskToken();
    const { adapter } = qwen(replay('ordewell-tool', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));

    expect(await adapter.mcpAttached?.()).toBe('connected');
  });

  it('carries the contract in the first prompt, where Qwen has no other channel for it', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = qwen(replay('ordewell-tool', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));
    void turn(adapter);
    await vi.waitFor(() => expect(agent.requests('session/prompt')).toHaveLength(1));

    const sent = JSON.stringify(agent.requests('session/prompt')[0].params);
    expect(sent).toContain('task_complete');
  });

  it('allows Qwen\'s request to call task_complete at once, by the name in its _meta, and the call reaches the server', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = qwen(replay('ordewell-tool', {
      ...EAGER_CONTACT,
      'session/request_permission': [{ callMcp: { tool: 'task_complete', args: { status: 'done', summary: 'ok' } } }],
    }));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter);

    expect(asked(events).map((e) => e.decided)).toEqual([{ decision: 'allow' }]);
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'proceed_once' }]);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', summary: 'ok' }), expect.anything());
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('completes nothing when the model calls task_complete without finding it first: Qwen refuses a deferred tool itself', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = qwen(replay('deferred-refused', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter);

    expect(asked(events)).toEqual([]);
    expect(JSON.stringify(events.filter((e) => e.type === 'tool_result'))).toContain('Deferred tool');
    expect(completed).not.toHaveBeenCalled();
    expect(note('deferred-refused', 'summary')?.completed).toEqual([]);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it.each([
    ['edit', 'Writing to hello.txt'],
    ['execute', 'touch made.txt && echo hi once'],
  ])('holds Qwen\'s %s for a person, and passes the person\'s answer back', async (name, title) => {
    const { mcp } = await taskToken();
    const { agent, adapter } = qwen(replay(name, EAGER_CONTACT));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter, 'allow');

    const requests = asked(events);
    expect(requests).toHaveLength(1);
    expect(requests[0].decided).toBeUndefined();
    expect(JSON.stringify(requests[0])).toContain(title);
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'proceed_once' }]);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('answers a person\'s refusal of Qwen\'s edit with its reject option', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = qwen(replay('edit', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));
    await turn(adapter, 'deny');

    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'cancel' }]);
  });

  it('interrupts a turn Qwen is waiting on a person in: the held request is answered cancelled', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = qwen(replay('cancel', EAGER_CONTACT));
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

  it('sets Qwen\'s yolo mode under the plan\'s autonomous mode, where it asks about nothing', async () => {
    const { mcp } = await taskToken();
    const { spawned, agent, adapter } = qwen(replay('allow-all', EAGER_CONTACT));
    await adapter.start(taskStart(mcp, 'yolo'));
    const events = await turn(adapter);

    expect(spawned.lastArgs()).toEqual(recordedArgs('allow-all'));
    expect(agent.requests('session/set_config_option').map((r) => (r.params as { value: string }).value)[0]).toBe('yolo');
    expect(asked(events)).toEqual([]);
    expect(events.filter((e) => e.type === 'tool_call').length).toBeGreaterThan(0);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('takes a call for Ordewell\'s only when its request carries the tool in _meta.toolName under Ordewell\'s server prefix', () => {
    const binding = acpOrdewellBinding(QWEN_CODE_PROFILE);
    const call = (toolName: unknown, title = '{}', kind: AcpToolCall['kind'] = 'other'): AcpToolCall => ({ toolCallId: 'c', title, kind, _meta: { toolName } });
    expect(binding.isOrdewellAsk({ request: call('mcp__ordewell__task_complete') })).toBe(true);
    expect(binding.isOrdewellAsk({ request: call('mcp__ordewell__submit_plan', '{}', 'execute') })).toBe(true);
    // A native tool is bare; another server's is prefixed by its own name; a
    // lookalike server shares only the start of the name; a tool Ordewell
    // does not have is not one of its calls.
    expect(binding.isOrdewellAsk({ request: call('task_complete') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('mcp__ordewell2__task_complete') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('mcp__evil__task_complete') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('mcp__ordewell__rm') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call(undefined) })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call(7) })).toBe(false);
    // The title is the model's: a native write that says it is Ordewell's.
    expect(binding.isOrdewellAsk({ request: call('write_file', 'mcp__ordewell__task_complete') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: { toolCallId: 'c', title: 'mcp__ordewell__task_complete', kind: 'other' } })).toBe(false);
  });

  it('names an Ordewell tool the way Qwen shows it to the model', () => {
    expect(QWEN_CODE_PROFILE.toolName?.('task_complete')).toBe('mcp__ordewell__task_complete');
  });

  it('hands Qwen the OpenRouter key configured in Ordewell through the variables its openai auth reads, in the spawn alone', async () => {
    stubNoOrdewellProvider();
    const key = 'sk-or-v1-qwen-ordewell-0000';
    const { mcp } = await taskToken();
    const { spawned, agent, adapter } = qwen(replay('ordewell-tool', EAGER_CONTACT), { OPENROUTER_API_KEY: key });
    await adapter.start(taskStart(mcp));

    // OpenRouter's documented OpenAI-compatible endpoint.
    expect(spawned.lastEnv()).toMatchObject({ OPENAI_API_KEY: key, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' });
    expect(spawned.lastArgs()).toEqual(recordedArgs('ordewell-tool'));
    expect(JSON.stringify(agent.received)).not.toContain(key);
  });

  it('refuses a start Qwen answers signed out with both routes: its own sign-in, and a key set in Ordewell', async () => {
    stubNoOrdewellProvider();
    const { mcp } = await taskToken();
    const { spawned, adapter } = qwen(replay('signed-out'));

    await expect(adapter.start(taskStart(mcp))).rejects.toThrow('Qwen Code is not signed in. Run /key and choose OpenRouter (or any OpenAI-compatible provider) to hand it a key, or run qwen and sign in there.');
    expect(spawned.lastEnv()?.OPENAI_API_KEY || undefined).toBeUndefined();
  });

  it('asks Qwen\'s model list with the same hook its tasks use', () => {
    expect(QWEN_CODE_PROFILE.credentials).toBeDefined();
    expect(QWEN_CODE_PROFILE.credentials).toBe(QWEN_CODE_MANIFEST.modelDiscovery.acp?.credentials);
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
  const ran = vi.fn(async () => ({ text: 'The plan is running.' }));
  const credential = await server.issuePlannerToken({ sessionId: 's1' }, { submitPlan: submitted, listRunners: listed, listModels: models, runPlan: ran } as never);
  return { mcp: mcpClientConfig(credential), submitted, listed, models, ran };
}

/** Qwen's read-only mode, as the plan names it. */
const READ_ONLY_MODE = QWEN_CODE_MANIFEST.modes?.find((mode) => mode.readOnly)?.id ?? 'none';

function readOnlyStart(mcp: McpClientConfig): TaskStartOptions {
  return taskStart(mcp, READ_ONLY_MODE);
}

function plannerStart(mcp: McpClientConfig): PlannerStartOptions {
  return { kind: 'planner', cwd: CWD, model: MODEL, systemPrompt: 'You are the planner.', mcp };
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

describe('qwen-code roles, replayed from Qwen Code 0.26.6 (ADR-0026, ADR-0028, ADR-0046, ADR-0060)', () => {
  it('claims both roles: it plans, and offers a read-only mode that Qwen runs in its own default mode, never its plan, auto or yolo', () => {
    expect(CONNECTORS['qwen-code'].plans).toBe(true);
    expect(READ_ONLY_MODE).toBe('plan');
    expect(resolveTaskRunnerFlags(QWEN_CODE_MANIFEST, { mode: READ_ONLY_MODE, model: MODEL }).permissionMode).toBe('default');
    expect(QWEN_CODE_MANIFEST.modes?.map((mode) => mode.id)).not.toContain('auto');
  });

  it.each([
    ['planner', async () => plannerStart((await plannerToken()).mcp)],
    ['read-only', async () => readOnlyStart((await readOnlyToken()).mcp)],
    ['planted-hook', async () => readOnlyStart((await readOnlyToken()).mcp)],
  ] as const)('starts a %s session asking before every action, in a directory of its own, as it was recorded running none of the workspace\'s hooks', async (name, start) => {
    const { spawned, agent, adapter } = qwen(replay(name, EAGER_CONTACT));
    await adapter.start(await start());

    const dir = spawned.lastCwd() ?? '';
    expect(dir.startsWith(CWD)).toBe(false);
    expect(spawned.lastArgs()).toEqual(recordedArgs(name));
    const { hooksRan, ...launch } = launchedAs(name, dir);
    expect({ cwd: dir, tmpdir: spawned.lastEnv().TMPDIR, startDirAtSpawn: readdirSync(dir) }).toEqual(launch);
    expect((agent.requests('session/new')[0].params as { cwd: string }).cwd).toBe(dir);
    // The workspace's planted `.qwen/settings.json` hook wrote nothing on the recorded start.
    expect(hooksRan).toEqual([]);
    expect(agent.requests('session/set_config_option').map((r) => settingsOf(r.params))).toEqual(recordedSettings(name));
    expect(agent.problems).toEqual([]);
  });

  it('plans with Ordewell\'s planner tools alone, each allowed by its name in _meta: it lists, submits a plan and starts it, leaving nothing behind', async () => {
    const tools = ['list_runners', 'list_models', 'submit_plan', 'run_plan'];
    const { mcp, submitted, listed, models, ran } = await plannerToken();
    const { agent, adapter } = qwen(replay('planner', {
      ...EAGER_CONTACT,
      'session/prompt': tools.map((tool) => ({ callMcp: { tool, args: recordedMcpCall('planner', tool) } })),
    }));
    await adapter.start(plannerStart(mcp));
    const events = await plannerTurn(adapter);

    const requests = asked(events);
    expect(requests.map((e) => e.decided)).toEqual(tools.map(() => ({ decision: 'allow' })));
    expect(requests.map((e) => e.input)).toEqual(tools.map((tool) => recordedMcpCall('planner', tool)));
    expect(permissionAnswers(agent)).toEqual(tools.map(() => ({ outcome: 'selected', optionId: 'proceed_once' })));
    expect(listed).toHaveBeenCalled();
    expect(models).toHaveBeenCalledWith(expect.objectContaining({ runner: 'qwen-code' }), expect.anything());
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ assignedRunner: 'qwen-code', readOnly: true, autonomy: 'AFK' })],
    }), expect.anything());
    expect(ran).toHaveBeenCalled();
    expect(recordedOutcome('planner')).toEqual({
      calls: tools,
      permissions: tools.map((tool) => expect.objectContaining({ toolName: `mcp__ordewell__${tool}`, answered: 'allow_once' })),
      leftBehind: [],
    });
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it.each([
    ['planner', async () => plannerStart((await plannerToken()).mcp)],
    ['read-only', async () => readOnlyStart((await readOnlyToken()).mcp)],
  ] as const)('tells a %s start its Ordewell tools are deferred, and to load each with tool_search, in the first prompt, as the recording shows it working', async (name, start) => {
    const { agent, adapter } = qwen(replay(name, EAGER_CONTACT));
    await adapter.start(await start());
    void turn(adapter);
    await vi.waitFor(() => expect(agent.requests('session/prompt')).toHaveLength(1));

    const line = /Your Ordewell tools are deferred: [^\n]*/.exec(recordedPrompt(name))?.[0] ?? 'none recorded';
    expect(JSON.stringify(agent.requests('session/prompt')[0].params)).toContain(JSON.stringify(line).slice(1, -1));
  });

  it('leaves a writable task\'s first prompt without the deferred-tool line', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = qwen(replay('ordewell-tool', EAGER_CONTACT));
    await adapter.start(taskStart(mcp));
    void turn(adapter);
    await vi.waitFor(() => expect(agent.requests('session/prompt')).toHaveLength(1));

    const sent = JSON.stringify(agent.requests('session/prompt')[0].params);
    expect(sent).toContain('task_complete');
    expect(sent).not.toContain('tool_search');
  });

  it.each([
    ['restricted-write', 'write_file', `Writing to ${CWD}/probe.txt`],
    ['restricted-shell', 'run_shell_command', 'touch probe-shell.txt'],
  ])('refuses a read-only task\'s %s by its kind with no person asked, which Qwen was recorded failing, leaving nothing behind', async (name, tool, title) => {
    const { mcp, completed } = await readOnlyToken();
    const { agent, adapter } = qwen(replay(name, EAGER_CONTACT));
    await adapter.start(readOnlyStart(mcp));
    const events = await turn(adapter);

    const requests = asked(events);
    expect(requests.map((e) => e.decided?.decision)).toEqual(['deny']);
    expect(JSON.stringify(requests[0])).toContain(title);
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'cancel' }]);
    expect(failures(events)).toContain(`Tool \\"${tool}\\" was canceled by the user.`);
    expect(completed).not.toHaveBeenCalled();
    expect(recordedOutcome(name)).toEqual({
      calls: [],
      permissions: [expect.objectContaining({ toolName: tool, answered: 'reject_once' })],
      leftBehind: [],
    });
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it.each([
    ['read-only', `${CWD}/README.md`],
    ['planted-hook', `${CWD}/README.md (lines 1-40)`],
  ] as const)('runs a %s task in Qwen\'s default mode: its read of the workspace is allowed, and it completes through Ordewell once it has loaded the deferred tool', async (name, read) => {
    const { mcp, completed } = await readOnlyToken();
    const { agent, adapter } = qwen(replay(name, {
      ...EAGER_CONTACT,
      'session/prompt': [{ callMcp: { tool: 'task_complete', args: recordedMcpCall(name, 'task_complete') } }],
    }));
    await adapter.start(readOnlyStart(mcp));
    const events = await turn(adapter);

    // Qwen titles an Ordewell call with its arguments, so the input says which call it was.
    const requests = asked(events);
    expect(requests.map((e) => e.decided)).toEqual([{ decision: 'allow' }, { decision: 'allow' }]);
    expect(requests[0].input).toMatchObject({ file_path: `${CWD}/README.md` });
    expect(requests[1].input).toEqual(recordedMcpCall(name, 'task_complete'));
    expect(permissionAnswers(agent)).toEqual([
      { outcome: 'selected', optionId: 'proceed_once' },
      { outcome: 'selected', optionId: 'proceed_once' },
    ]);
    // Qwen refused the model's first call of the tool it had not yet loaded.
    expect(failures(events)).toContain('[tool_call bridge refused] Deferred tool');
    expect(recordedOutcome(name)).toEqual({
      calls: ['task_complete'],
      permissions: [
        expect.objectContaining({ title: read, kind: 'read', answered: 'allow_once' }),
        expect.objectContaining({ toolName: 'mcp__ordewell__task_complete', answered: 'allow_once' }),
      ],
      leftBehind: [],
    });
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', summary: expect.stringContaining('HERON') }), expect.anything());
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });
});
