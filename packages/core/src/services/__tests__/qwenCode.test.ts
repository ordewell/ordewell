import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import { QWEN_CODE_PROFILE } from '../harness/qwenProfile';
import type { AcpToolCall } from '../harness/acpSchema';
import type { AgentEvent, AgentProcessDeps, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
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
  | { dir: 'note'; ms: number; event: string; args?: string[]; completed?: string[]; leftBehind?: string[] };

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

  it('claims no role: Qwen does not plan and offers no read-only mode, as no recording shows its plan mode refusing a write and a command', () => {
    expect(CONNECTORS['qwen-code'].plans).toBe(false);
    expect(QWEN_CODE_MANIFEST.modes?.some((mode) => mode.readOnly)).toBe(false);
    expect(QWEN_CODE_MANIFEST.modes?.map((mode) => mode.id)).not.toContain('auto');
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

    await expect(adapter.start(taskStart(mcp))).rejects.toThrow(/^Qwen Code is not signed in\. Run `qwen`, or set the key of an OpenAI-compatible provider, such as OpenRouter, in Ordewell with `\/key`\.$/);
    expect(spawned.lastEnv()?.OPENAI_API_KEY || undefined).toBeUndefined();
  });

  it('asks Qwen\'s model list with the same hook its tasks use', () => {
    expect(QWEN_CODE_PROFILE.credentials).toBeDefined();
    expect(QWEN_CODE_PROFILE.credentials).toBe(QWEN_CODE_MANIFEST.modelDiscovery.acp?.credentials);
  });
});
