import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import { discoverAcpModels } from '../harness/acpModels';
import { ModelDiscovery, type AcpClientImpl, type ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CLINE_PROFILE } from '../harness/clineProfile';
import type { AcpToolCall } from '../harness/acpSchema';
import type { AgentEvent, AgentProcessDeps, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
import { VENDORS } from '../apiProviders';
import { BUILTIN_MANIFESTS } from '../../plugins/builtin';
import { CLINE_ACP_ARGS, CLINE_MANIFEST } from '../../plugins/builtin/cline.manifest';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { OrdewellMcpServer, mcpClientConfig, type McpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpAgent, type FakeAcpAgentOptions, type FakeAcpStep } from './fakeAcpAgent';

/**
 * The cline connector against Cline 3.0.74 as it was recorded over ACP
 * (`fixtures/acp/cline/`): each recording is replayed as the agent's side of
 * the conversation, with Ordewell's side live. Cline's MCP traffic went to the
 * server, not over stdio, so the recording keeps it as `mcp` notes, and the
 * replay makes the same contact at the same point of the conversation.
 */

const FIXTURES = join(__dirname, 'fixtures/acp/cline');

/** Where each test's start puts the task, which the recordings name `{{CWD}}`. */
const CWD = '/repo';

type WireLine = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
interface Note {
  dir: 'note';
  ms: number;
  event: string;
  args?: string[];
  env?: Record<string, string>;
  settings?: unknown;
  method?: string;
  tool?: string;
  contacted?: boolean;
  completed?: Array<Record<string, unknown>>;
  permissions?: Array<{ title: string; kind: string; options: string[]; answer: unknown }>;
}
type Recorded = { dir: 'in' | 'out'; ms: number; line: WireLine } | Note;

function recording(name: string): Recorded[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').replaceAll('{{CWD}}', CWD).trim().split('\n').map((line) => JSON.parse(line) as Recorded);
}

function note(name: string, event: string): Note | undefined {
  const found = recording(name).find((entry) => entry.dir === 'note' && entry.event === event);
  return found?.dir === 'note' ? found : undefined;
}

const recordedArgs = (name: string): string[] => note(name, 'spawn')?.args ?? [];

function settingsOf(params: unknown): { configId: string; value: string } {
  const { configId, value } = params as { configId: string; value: string };
  return { configId, value };
}

/** What Ordewell sent Cline to set, as the recording shows it, in order. */
function recordedSettings(name: string) {
  return recording(name).flatMap((entry) => (entry.dir === 'out' && entry.line.method === 'session/set_config_option' ? [settingsOf(entry.line.params)] : []));
}

/** What the recording's MCP handler was given, the evidence each scenario's verdict rests on. */
const recordedReports = (name: string) => note(name, 'summary')?.completed ?? [];

/** The model the recordings ran on, which Ordewell set as Cline's `model` config option. */
const MODEL = recordedSettings('ordewell-tool')[0].value;

/** The arguments the model gave a tool, as Cline's tool call carries them. */
function rawInput(line: WireLine): { title: string; input: Record<string, unknown> } | undefined {
  const params = line.params as { update?: AcpToolCall & { rawInput?: unknown }; toolCall?: AcpToolCall & { rawInput?: unknown } } | undefined;
  const call = params?.update ?? params?.toolCall;
  return typeof call?.title === 'string' && call.rawInput && typeof call.rawInput === 'object'
    ? { title: call.title, input: call.rawInput as Record<string, unknown> }
    : undefined;
}

/**
 * The agent's side of a recording as a script: what Ordewell sent becomes what
 * the agent waits for, and what Cline sent is sent again, each answer to the
 * request it answered. A request of Cline's waits for its answer unless the
 * recording shows Ordewell saying something else first, as a cancel does.
 * Cline's first contact with the server becomes a tool listing at that point,
 * and each `tools/call` a call with the arguments its tool call carried; with
 * `mcp: false` the agent never reaches the server at all.
 */
function replay(name: string, { mcp = true } = {}): FakeAcpStep[] {
  const steps: FakeAcpStep[] = [];
  const sent = new Map<number, string>();
  const entries = recording(name);
  const answeredNext = (index: number, id: number) => {
    const next = entries.slice(index + 1).find((entry) => entry.dir === 'out');
    return next?.dir === 'out' && next.line.method === undefined && next.line.id === id;
  };
  const inputs = new Map<string, Record<string, unknown>>();
  for (const [index, entry] of entries.entries()) {
    if (entry.dir === 'note') {
      if (!mcp || entry.event !== 'mcp') continue;
      if (entry.method === 'initialize') steps.push({ run: async (agent) => { await agent.listMcpTools(); } });
      if (entry.method === 'tools/call' && entry.tool) {
        const args = inputs.get(entry.tool);
        if (!args) throw new Error(`${name}: no tool call carries the arguments of its ${entry.tool} call`);
        steps.push({ callMcp: { tool: entry.tool, args } });
      }
      continue;
    }
    const { line } = entry;
    if (entry.dir === 'out') {
      if (line.method === undefined) continue;
      if (line.id !== undefined) sent.set(line.id, line.method);
      steps.push({ expect: line.method });
    } else if (line.method !== undefined) {
      const { method, params, id } = line;
      const call = rawInput(line);
      const tool = call?.title.split(':')[0].replace(/^ordewell__/, '');
      if (call && tool && call.title.startsWith('ordewell__')) inputs.set(tool, call.input);
      if (id === undefined) steps.push({ notify: method, params });
      else if (answeredNext(index, id)) steps.push({ request: method, params });
      else steps.push({ run: (agent) => { void agent.ask(method, params); } });
    } else if (line.id !== undefined) {
      const to = sent.get(line.id);
      steps.push(line.error ? { fail: line.error, ...(to ? { to } : {}) } : { answer: line.result, ...(to ? { to } : {}) });
    }
  }
  return steps;
}

/** Cline reads its MCP servers from the file `CLINE_MCP_SETTINGS_PATH` names, once, as it starts. */
const READS_SETTINGS: FakeAcpAgentOptions = {
  settings: {
    env: 'CLINE_MCP_SETTINGS_PATH',
    servers: (contents) => {
      const parsed = JSON.parse(contents) as { mcpServers: Record<string, { type?: string; url: string; headers: Record<string, string> }> };
      return Object.entries(parsed.mcpServers).map(([name, s]) => ({ name, type: s.type, url: s.url, headers: s.headers }));
    },
  },
};

const adapters: TaskModeAgentAdapter[] = [];
const servers: OrdewellMcpServer[] = [];

/** A temp directory of this test's own, so the settings files written there, and swept from it, are only this test's. */
let temp = '';
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'cline-test-'));
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, temp);
});
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  vi.unstubAllEnvs();
  rmSync(temp, { recursive: true, force: true });
});

/** Task tokens on one server, each with a task_complete handler of its own. */
async function taskTokens(count: number): Promise<Array<{ mcp: McpClientConfig; completed: ReturnType<typeof vi.fn> }>> {
  const server = new OrdewellMcpServer();
  servers.push(server);
  const tokens = [];
  for (let attempt = 1; attempt <= count; attempt++) {
    const completed = vi.fn(async () => ({ text: 'Recorded.' }));
    const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt }, { taskComplete: completed } as never);
    tokens.push({ mcp: mcpClientConfig(credential), completed });
  }
  return tokens;
}

const taskToken = async () => (await taskTokens(1))[0];

/** The key is handed in as Ordewell's environment would hold it, so no test reads Cline's own store. */
const API_KEY = 'sk-test-not-a-key';

function cline(steps: FakeAcpStep[]) {
  const spawned = fakeAcpSpawn(steps, {}, READS_SETTINGS);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP for Cline'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({ CLINE_API_KEY: API_KEY }),
  };
  const adapter = CONNECTORS.cline.create(deps);
  adapters.push(adapter);
  return { spawned, agent: spawned.agent, adapter };
}

function taskStart(mcp: McpClientConfig, mode = 'default', extra: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return { kind: 'task', cwd: CWD, mode, model: MODEL, flags: resolveTaskRunnerFlags(CLINE_MANIFEST, { mode, model: MODEL }), mcp, ...extra };
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

/** The answers the recording shows Ordewell giving Cline's requests, in order. */
const recordedAnswers = (name: string) => (note(name, 'summary')?.permissions ?? []).map((p) => p.answer);

const asked = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'permission_request' ? [e] : []));

/** What a report's evidence was handed, call by call. */
const reports = (completed: ReturnType<typeof vi.fn>) => completed.mock.calls.map((call: unknown[]) => call[0]);

describe('cline, replayed from Cline 3.0.74', () => {
  it('launches Cline over ACP with its permission switch spelt out, as it was recorded', async () => {
    const { mcp } = await taskToken();
    const { spawned, agent, adapter } = cline(replay('ordewell-tool'));
    await adapter.start(taskStart(mcp));

    expect(spawned.lastCommand()).toBe('cline');
    expect(spawned.lastArgs()).toEqual(recordedArgs('ordewell-tool'));
    expect(spawned.lastArgs()).toEqual(['--acp', '--auto-approve', 'false']);
    expect(agent.problems).toEqual([]);
  });

  it('keeps Cline\'s session in the process it starts, and hands it the server in an owner-only file that the command line never names', async () => {
    const { mcp } = await taskToken();
    const { spawned, agent, adapter } = cline(replay('ordewell-tool'));
    await adapter.start(taskStart(mcp));

    const recorded = note('ordewell-tool', 'spawn');
    const env = spawned.lastEnv();
    expect(env.CLINE_SESSION_BACKEND_MODE).toBe(recorded?.env?.CLINE_SESSION_BACKEND_MODE);
    expect(env.CLINE_SESSION_BACKEND_MODE).toBe('local');
    const path = env.CLINE_MCP_SETTINGS_PATH ?? '';
    expect(basename(path)).toBe(basename(recorded?.env?.CLINE_MCP_SETTINGS_PATH ?? '-'));
    expect(path.startsWith(`${temp}/`)).toBe(true);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(dirname(path)).mode & 0o077).toBe(0);

    // The file Cline read is the recorded one, with this attempt's server and token.
    const token = mcp.headers.Authorization;
    const expected = JSON.stringify(recorded?.settings).replace('{{MCP_URL}}', mcp.url).replace('Bearer [REDACTED]', token);
    expect(agent.settingsReads).toHaveLength(1);
    expect(JSON.parse(agent.settingsReads[0].contents ?? '')).toEqual(JSON.parse(expected));
    expect(spawned.lastArgs().join(' ')).not.toContain(token.replace('Bearer ', ''));
    expect(Object.values(env).join('\n')).not.toContain(token.replace('Bearer ', ''));
    expect(agent.requests('session/new').map((r) => (r.params as { mcpServers: unknown }).mcpServers)).toEqual([[]]);
  });

  it('passes the provider key Ordewell was given and reads no store of Cline\'s for it', async () => {
    const { mcp } = await taskToken();
    vi.stubEnv('CLINE_PROVIDER_SETTINGS_PATH', join(temp, 'no-such-store.json'));
    const { spawned, adapter } = cline(replay('ordewell-tool'));
    await adapter.start(taskStart(mcp));

    expect(spawned.lastEnv().CLINE_API_KEY).toBe(API_KEY);
  });

  it('sets the plan\'s model as Cline\'s model config option, as the recording shows Ordewell doing, and no mode', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = cline(replay('ordewell-tool'));
    await adapter.start(taskStart(mcp));

    expect(recordedSettings('ordewell-tool')).toEqual([{ configId: 'model', value: MODEL }]);
    expect(agent.requests('session/set_config_option').map((r) => settingsOf(r.params))).toEqual(recordedSettings('ordewell-tool'));
    expect(agent.requests('session/set_mode')).toEqual([]);
    expect(agent.problems).toEqual([]);
  });

  it('judges the attach by the first turn, since Cline reaches the server only once a prompt runs', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = cline(replay('ordewell-tool'));
    await adapter.start(taskStart(mcp));

    expect(note('ordewell-tool', 'contact-before-prompt')?.contacted).toBe(false);
    expect(note('ordewell-tool', 'prompt-answered')?.contacted).toBe(true);
    let first: Promise<AgentEvent[]> | undefined;
    expect(await adapter.mcpAttached?.(() => (first = turn(adapter)))).toBe('connected');
    await first;
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('does not take a first turn that never reaches the server as attached', async () => {
    const { mcp } = await taskToken();
    const { adapter } = cline(replay('ordewell-tool', { mcp: false }));
    await adapter.start(taskStart(mcp));

    expect(await adapter.mcpAttached?.(() => turn(adapter))).toBe('pending');
  });

  it('carries the contract in the first prompt, where Cline has no other channel for it', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = cline(replay('ordewell-tool'));
    await adapter.start(taskStart(mcp));
    void turn(adapter);
    await vi.waitFor(() => expect(agent.requests('session/prompt')).toHaveLength(1));

    // The recorded prompt's text, the contract and then the task's own words.
    const recorded = recording('ordewell-tool').find((e) => e.dir === 'out' && e.line.method === 'session/prompt');
    const textOf = (params: unknown) => (params as { prompt: Array<{ text: string }> }).prompt[0].text;
    const contract = (text: string) => text.slice(0, text.lastIndexOf('\n\n'));
    const sent = textOf(agent.requests('session/prompt')[0].params);
    expect(sent).toContain('task_complete');
    expect(contract(sent)).toBe(contract(recorded?.dir === 'out' ? textOf(recorded.line.params) : ''));
  });

  it('allows Cline\'s request to call task_complete at once, by the tool in its title, and the call reaches the server', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = cline(replay('ordewell-tool'));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter);

    expect(asked(events).map((e) => e.decided)).toEqual([{ decision: 'allow' }]);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('ordewell-tool'));
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'allow_once' }]);
    expect(reports(completed)).toEqual(recordedReports('ordewell-tool').map((r) => expect.objectContaining(r)));
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('holds Cline\'s apply_patch for a person, passes the person\'s answer back, and lets its report through', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = cline(replay('edit'));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter, 'allow');

    const held = asked(events).filter((e) => !e.decided);
    expect(held).toHaveLength(1);
    expect(note('edit', 'summary')?.permissions?.[0]).toMatchObject({ kind: 'other', title: expect.stringMatching(/^apply_patch: /) });
    expect(held[0].name).toContain('apply_patch');
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('edit'));
    expect(reports(completed)).toEqual(recordedReports('edit').map((r) => expect.objectContaining(r)));
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('answers a person\'s refusal of Cline\'s apply_patch with its reject option', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = cline(replay('deny'));
    await adapter.start(taskStart(mcp));
    await turn(adapter, 'deny');

    expect(permissionAnswers(agent)).toEqual(recordedAnswers('deny'));
    expect(permissionAnswers(agent)[0]).toEqual({ outcome: 'selected', optionId: 'reject_once' });
    expect(reports(completed)).toEqual(recordedReports('deny').map((r) => expect.objectContaining(r)));
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('interrupts a turn Cline is waiting on a person in: its held command is answered cancelled', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = cline(replay('cancel'));
    await adapter.start(taskStart(mcp));
    let interrupted: Promise<boolean> | undefined;
    const events: AgentEvent[] = [];
    await adapter.send('go', (event) => {
      events.push(event);
      if (event.type === 'permission_request') interrupted = adapter.interrupt(1000);
    });

    expect(note('cancel', 'summary')?.permissions?.[0]).toMatchObject({ kind: 'execute', answer: { outcome: 'cancelled' } });
    expect(await interrupted).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(agent.requests('session/cancel')).toHaveLength(1);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('cancel'));
    expect(completed).not.toHaveBeenCalled();
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('starts Cline with --auto-approve true under the plan\'s autonomous mode, where it asks about nothing', async () => {
    const { mcp, completed } = await taskToken();
    const { spawned, agent, adapter } = cline(replay('allow-all'));
    await adapter.start(taskStart(mcp, 'autoApprove'));
    const events = await turn(adapter);

    expect(spawned.lastArgs()).toEqual(recordedArgs('allow-all'));
    expect(spawned.lastArgs()).toEqual(['--acp', '--auto-approve', 'true']);
    expect(asked(events)).toEqual([]);
    expect(events.filter((e) => e.type === 'tool_call').length).toBeGreaterThan(0);
    expect(reports(completed)).toEqual(recordedReports('allow-all').map((r) => expect.objectContaining(r)));
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('resumes a session with session/load, handing it no server there, and shows none of the history Cline replays', async () => {
    const { mcp, completed } = await taskToken();
    const loaded = recording('load').find((e) => e.dir === 'out' && e.line.method === 'session/load');
    const params = loaded?.dir === 'out' ? (loaded.line.params as { sessionId: string }) : { sessionId: '' };
    const history = recording('load').flatMap((e) => {
      if (e.dir !== 'in' || e.line.method !== 'session/update' || e.ms > (loaded?.ms ?? 0) + 100) return [];
      const id = (e.line.params as { update: { toolCallId?: string } }).update.toolCallId;
      return id ? [id] : [];
    });
    const { agent, adapter } = cline(replay('load'));
    await adapter.start(taskStart(mcp, 'default', { resumeSessionId: params.sessionId }));

    expect(agent.requests('session/load').map((r) => r.params)).toEqual([params]);
    expect(agent.requests('session/new')).toEqual([]);
    expect(adapter.nativeSessionId()).toBe(params.sessionId);
    // Cline reached the server while it loaded the session, before any turn.
    expect(note('load', 'contact-before-prompt')?.contacted).toBe(true);
    expect(await adapter.mcpAttached?.()).toBe('connected');
    const events = await turn(adapter);

    expect(history.length).toBeGreaterThan(0);
    for (const id of history) expect(JSON.stringify(events)).not.toContain(id);
    expect(reports(completed)).toEqual(recordedReports('load').map((r) => expect.objectContaining(r)));
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('gives two attempts running at once a settings file each, and each report reaches its own attempt alone', async () => {
    const [a, b] = await taskTokens(2);
    const first = cline(replay('concurrent-a'));
    const second = cline(replay('concurrent-b'));
    await Promise.all([first.adapter.start(taskStart(a.mcp)), second.adapter.start(taskStart(b.mcp))]);
    expect(first.agent.settingsReads[0].contents).toContain(a.mcp.headers.Authorization);
    expect(first.agent.settingsReads[0].contents).not.toContain(b.mcp.headers.Authorization);
    expect(second.agent.settingsReads[0].contents).toContain(b.mcp.headers.Authorization);
    await Promise.all([turn(first.adapter), turn(second.adapter)]);

    expect(reports(a.completed)).toEqual(recordedReports('concurrent-a').map((r) => expect.objectContaining(r)));
    expect(reports(b.completed)).toEqual(recordedReports('concurrent-b').map((r) => expect.objectContaining(r)));
    expect([first.agent.problems, second.agent.problems]).toEqual([[], []]);
    await Promise.all([first.agent.finished, second.agent.finished]);
  });

  it('leaves no settings file behind once the process is gone', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = cline(replay('ordewell-tool'));
    await adapter.start(taskStart(mcp));
    await turn(adapter);
    await agent.finished;
    await agent.close(0);

    expect(note('ordewell-tool', 'summary')).toMatchObject({ leftBehind: { privateDirs: [], clineProcesses: [] } });
    await vi.waitFor(() => expect(readdirSync(temp)).toEqual([]));
  });

  it('claims no role: Cline does not plan and offers no read-only mode, as it has no shell allow or deny list', () => {
    expect(CONNECTORS.cline.plans).toBe(false);
    expect(CLINE_PROFILE.roles).toBeUndefined();
    expect(CLINE_PROFILE.restricted).toBeUndefined();
    expect(CLINE_MANIFEST.modes?.some((mode) => mode.readOnly)).toBe(false);
    expect(CLINE_MANIFEST.modes?.map((mode) => mode.id)).toEqual(['default', 'autoApprove']);
  });

  it('takes a call for Ordewell\'s only when the tool its title names is under Ordewell\'s server prefix', () => {
    const binding = acpOrdewellBinding(CLINE_PROFILE);
    const call = (title: unknown, kind: AcpToolCall['kind'] = 'other'): AcpToolCall => ({ toolCallId: 'c', title, kind } as AcpToolCall);
    // As the recordings show them: the tool, then the model's arguments.
    for (const p of note('edit', 'summary')?.permissions ?? []) {
      expect(binding.isOrdewellAsk({ request: call(p.title, p.kind as AcpToolCall['kind']) })).toBe(p.title.startsWith('ordewell__task_complete:'));
    }
    expect(binding.isOrdewellAsk({ request: call('ordewell__task_complete') })).toBe(true);
    expect(binding.isOrdewellAsk({ request: call('ordewell__submit_plan: {}', 'execute') })).toBe(true);
    // A native tool is bare; another server's is prefixed by its own name; a
    // lookalike server shares only the start of the name; a tool Ordewell
    // does not have is not one of its calls.
    expect(binding.isOrdewellAsk({ request: call('apply_patch: {"input":"x"}') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('run_commands: ls', 'execute') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('ordewell2__task_complete: {}') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('evil__task_complete: {}') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('ordewell__rm: {}') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call(undefined) })).toBe(false);
    // The summary is the model's: a native write that says it is Ordewell's.
    expect(binding.isOrdewellAsk({ request: call('apply_patch: ordewell__task_complete') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('run_commands: ordewell__task_complete: {}', 'execute') })).toBe(false);
  });

  it('names an Ordewell tool the way Cline shows it to the model', () => {
    expect(CLINE_PROFILE.toolName?.('task_complete')).toBe('ordewell__task_complete');
  });
});

describe('cline model discovery', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-cline-discovery-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A stand-in for `cline --acp`: answers each request with what the recording has Cline say next. */
  function clineReplaying(name: string): string[] {
    const replies: Record<string, unknown[]> = {};
    let current = '';
    for (const entry of recording(name)) {
      if (entry.dir === 'out' && entry.line.method) { current = entry.line.method; replies[current] = []; }
      else if (entry.dir === 'in' && current) replies[current].push(entry.line);
    }
    const file = join(dir, 'cline.cjs');
    writeFileSync(file, `
const replies = ${JSON.stringify(replies)};
require('readline').createInterface({ input: process.stdin }).on('line', (text) => {
  const msg = JSON.parse(text);
  for (const reply of replies[msg.method] ?? []) {
    const out = reply.id !== undefined ? { ...reply, id: msg.id } : reply;
    process.stdout.write(JSON.stringify(out) + '\\n');
  }
});
`);
    return [file];
  }

  it('starts Cline as an ACP agent with the same arguments, environment and key the task runner uses', () => {
    expect(CLINE_MANIFEST.modelDiscovery.method).toBe('acp');
    expect(CLINE_MANIFEST.modelDiscovery.acp?.args).toEqual(['--acp']);
    expect(CLINE_MANIFEST.modelDiscovery.acp?.env).toEqual({ CLINE_SESSION_BACKEND_MODE: 'local' });
    expect(CLINE_PROFILE.args).toBe(CLINE_ACP_ARGS);
    expect(CLINE_PROFILE.env).toBe(CLINE_MANIFEST.modelDiscovery.acp?.env);
    expect(CLINE_PROFILE.credentials).toBe(CLINE_MANIFEST.modelDiscovery.acp?.credentials);
  });

  /**
   * Cline 3.0.74 as a user signed in with `cline auth` meets it: the key is in
   * its own store only, and without it in the environment `session/new` is
   * refused with -32000 (ADR-0060, R9). With it, the recording's answer.
   */
  function clineNeedingItsKey(key: string): string[] {
    const [file] = clineReplaying('ordewell-tool');
    const replay = readFileSync(file, 'utf8');
    writeFileSync(file, `
const signedIn = process.env.CLINE_API_KEY === ${JSON.stringify(key)} && process.env.CLINE_PROVIDER === 'openrouter' && process.env.CLINE_SESSION_BACKEND_MODE === 'local';
if (!signedIn) {
  require('readline').createInterface({ input: process.stdin }).on('line', (text) => {
    const msg = JSON.parse(text);
    const reply = msg.method === 'session/new'
      ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required: Call authenticate before starting a session' } }
      : { jsonrpc: '2.0', id: msg.id, result: ${JSON.stringify((recording('ordewell-tool').find((e) => e.dir === 'in') as { line: WireLine }).line.result)} };
    process.stdout.write(JSON.stringify(reply) + '\\n');
  });
} else {
${replay}
}
`);
    return [file];
  }

  it('lists the provider\'s models for a user whose key lives only in Cline\'s own store', async () => {
    const key = 'sk-or-v1-discovery-key-never-shown';
    const store = join(dir, 'providers.json');
    writeFileSync(store, JSON.stringify({
      version: 1,
      lastUsedProvider: 'openrouter',
      providers: { openrouter: { settings: { provider: 'openrouter', apiKey: key, model: MODEL } } },
    }), { mode: 0o600 });
    const fake = clineNeedingItsKey(key);
    const asked: string[][] = [];
    const client: AcpClientImpl = (_command, args, options) => {
      asked.push(args);
      return discoverAcpModels(process.execPath, fake, { ...options, timeout: 5000 });
    };
    const registry = { getManifest: (id: string) => (id === 'cline' ? CLINE_MANIFEST : undefined) } as unknown as RunnerRegistry;
    const env = { PATH: process.env.PATH, CLINE_PROVIDER_SETTINGS_PATH: store };
    const exec: ExecImpl = async () => { throw new Error('cline has no model listing command'); };

    const models = await new ModelDiscovery(registry, exec, undefined, undefined, undefined, undefined, async () => env, client).discover('cline');

    expect(asked).toEqual([['--acp']]);
    expect(models.map((m) => m.modelId)).toEqual(['moonshotai/kimi-k3.1-pro', 'recursive/flint-v1.0:free', MODEL]);
  });

  it('lists the models Cline 3.0.74 offers in session/new, as the recording kept them', async () => {
    const models = await discoverAcpModels(process.execPath, clineReplaying('ordewell-tool'), { timeout: 5000 });

    expect(note('ordewell-tool', 'trimmed')).toBeDefined();
    expect(models?.map((m) => m.modelId)).toEqual(['moonshotai/kimi-k3.1-pro', 'recursive/flint-v1.0:free', MODEL]);
  });
});

describe('runner ids and API vendor ids', () => {
  it('gives Cline the id `cline`, which no vendor and no other runner has', () => {
    expect(CLINE_MANIFEST.name).toBe('cline');
    expect(Object.keys(VENDORS)).not.toContain('cline');
    expect(BUILTIN_MANIFESTS.filter((manifest) => manifest.name === 'cline')).toEqual([CLINE_MANIFEST]);
    expect(Object.keys(CONNECTORS).filter((id) => id === 'cline')).toEqual(['cline']);
  });

  it('has a connector for every built-in runner and a built-in runner for every connector', () => {
    expect(Object.keys(CONNECTORS).sort()).toEqual(BUILTIN_MANIFESTS.map((manifest) => manifest.name).sort());
  });
});
