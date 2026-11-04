import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import { acpRoles } from '../harness/acpRoles';
import { discoverAcpModels } from '../harness/acpModels';
import { ModelDiscovery, type AcpClientImpl, type ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CLINE_PROFILE } from '../harness/clineProfile';
import type { AcpToolCall } from '../harness/acpSchema';
import type { AgentEvent, AgentProcessDeps, PlannerStartOptions, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
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
  cwd?: string;
  settings?: unknown;
  method?: string;
  tool?: string;
  contacted?: boolean;
  completed?: Array<Record<string, unknown>>;
  permissions?: Array<{ title: string; kind: string; options: string[]; answer: unknown }>;
  /** The marker each of the workspace's planted hooks writes when it runs, as the recording found them. */
  hooksRan?: string[];
  /** The worktree and the private directory as the recording found them once the process was gone. */
  worktree?: { entries: string[]; gitStatus: string };
  privateDir?: { entries: string[]; removed: boolean };
  /** Whether the home `CLINE_DIR` named was empty when the recording started Cline. */
  clineDir?: { emptyAtStart: boolean };
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
    // A writable task starts in its worktree, its temp directory left as it was.
    expect(spawned.lastCwd()).toBe(CWD);
    expect(spawned.lastEnv().TMPDIR).toBe(temp);
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

  it('claims the read-only role and not the planner\'s, which a first-turn attach cannot hold (ADR-0060, R5)', () => {
    expect(CONNECTORS.cline.plans).toBe(false);
    expect(CLINE_PROFILE.roles).toEqual({ plans: false, readOnly: true });
    expect(CLINE_PROFILE.attach).toBe('firstTurn');
    expect(CLINE_MANIFEST.modes?.filter((mode) => mode.readOnly).map((mode) => mode.id)).toEqual(['plan']);
    expect(CLINE_MANIFEST.modes?.map((mode) => mode.id)).toEqual(['default', 'plan', 'autoApprove']);
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

/** A read-only task's token, which lists `run_command` beside `task_complete` (ADR-0046). */
async function readOnlyToken() {
  const server = new OrdewellMcpServer();
  servers.push(server);
  const completed = vi.fn(async () => ({ text: 'Recorded.' }));
  const commands = vi.fn(async () => ({ text: '# scratch\n' }));
  const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1, readOnly: true }, { taskComplete: completed, runCommand: commands } as never);
  return { mcp: mcpClientConfig(credential), completed, commands };
}

/** Cline's read-only mode, as the plan names it. */
const READ_ONLY_MODE = CLINE_MANIFEST.modes?.find((mode) => mode.readOnly)?.id ?? 'none';

/** The text of each prompt Ordewell sent, in order. */
const prompts = (agent: FakeAcpAgent) => agent.requests('session/prompt').map((r) => (r.params as { prompt: Array<{ text: string }> }).prompt[0].text);

/** The recorded spawn's value with its private directory put back as `dir`, the one this start made. */
const at = (value: string | undefined, dir: string) => value?.replaceAll('{{PRIVATE_DIR}}', dir);

/** What the recording found once the process was gone: the worktree as it was, and the private directory, which held only the settings file, removed. */
const UNTOUCHED = { worktree: { gitStatus: '' }, privateDir: { entries: ['cline_mcp_settings.json'], removed: true }, leftBehind: { privateDirs: [], clineProcesses: [] } };

describe('cline read-only tasks, replayed from Cline 3.0.74 (ADR-0028, ADR-0046, ADR-0060)', () => {
  it.each(['read-only', 'read-only-write', 'read-only-shell', 'read-only-hooks'])('starts %s in a directory of its own with --auto-approve false once, as it was recorded', async (name) => {
    const { mcp } = await readOnlyToken();
    const { spawned, agent, adapter } = cline(replay(name));
    await adapter.start(taskStart(mcp, READ_ONLY_MODE));

    const dir = spawned.lastCwd() ?? '';
    const env = spawned.lastEnv();
    const recorded = note(name, 'spawn');
    expect(spawned.lastArgs()).toEqual(recordedArgs(name));
    expect(spawned.lastArgs()).toEqual(['--acp', '--auto-approve', 'false']);
    expect(dir.startsWith(CWD)).toBe(false);
    expect(dir.startsWith(`${temp}/`)).toBe(true);
    expect(dir).toBe(at(recorded?.cwd, dir));
    expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([recorded?.env?.TMPDIR, recorded?.env?.TMP, recorded?.env?.TEMP].map((v) => at(v, dir)));
    expect(env.CLINE_MCP_SETTINGS_PATH).toBe(at(recorded?.env?.CLINE_MCP_SETTINGS_PATH, dir));
    expect(readdirSync(dir)).toEqual(['cline_mcp_settings.json']);
    expect(agent.requests('session/new').map((r) => (r.params as { cwd: string }).cwd)).toEqual([dir]);
  });

  it('starts a read-only task with --auto-approve false whatever mode the plan gave it, so an autonomous mode cannot put Cline\'s approvals back', async () => {
    const { mcp } = await readOnlyToken();
    const { spawned, adapter } = cline(replay('read-only'));
    await adapter.start(taskStart(mcp, 'autoApprove'));

    expect(spawned.lastArgs()).toEqual(['--acp', '--auto-approve', 'false']);
    expect(spawned.lastCwd()?.startsWith(CWD)).toBe(false);
  });

  it('runs none of the workspace\'s hooks on a read-only start, where a writable start in the same workspace was recorded running them all', async () => {
    const { mcp } = await taskToken();
    const { spawned, adapter } = cline(replay('repo-hooks'));
    await adapter.start(taskStart(mcp));

    // The hooks Cline reads from `.cline/hooks/` and `.clinerules/hooks/` of
    // the directory it starts in: a writable task starts in the worktree.
    expect(spawned.lastCwd()).toBe(CWD);
    expect(note('repo-hooks', 'spawn')?.cwd).toBe(CWD);
    expect(spawned.lastArgs()).toEqual(recordedArgs('repo-hooks'));
    expect(note('repo-hooks', 'summary')?.worktree?.entries).toEqual(['.cline', '.clinerules', '.git', 'README.md']);
    const everyHook = [
      '_cline_hooks-PostToolUse', '_cline_hooks-PreToolUse', '_cline_hooks-TaskComplete', '_cline_hooks-TaskStart',
      '_clinerules_hooks-PostToolUse', '_clinerules_hooks-PreToolUse', '_clinerules_hooks-TaskComplete', '_clinerules_hooks-TaskStart',
    ];
    expect(note('repo-hooks', 'summary')?.hooksRan).toEqual(everyHook);
    // Cline's home moved to an empty directory keeps none of them out, so
    // CLINE_DIR is no control for them and the start directory is.
    expect(note('repo-hooks-cline-dir', 'spawn')).toMatchObject({ cwd: CWD, env: { CLINE_DIR: '{{CLINE_DIR}}' } });
    expect(note('repo-hooks-cline-dir', 'summary')).toMatchObject({ clineDir: { emptyAtStart: true }, hooksRan: everyHook });
    // The same hooks, planted the same way, under a read-only start.
    expect(note('read-only-hooks', 'summary')?.worktree?.entries).toEqual(['.cline', '.clinerules', '.git', 'README.md']);
    expect(note('read-only-hooks', 'summary')?.hooksRan).toEqual([]);
    expect(note('read-only-hooks', 'summary')).toMatchObject(UNTOUCHED);
  });

  it('tells a read-only task its own tools are off, and where the workspace is, in the first prompt, as it was recorded', async () => {
    const { mcp } = await readOnlyToken();
    const { agent, adapter } = cline(replay('read-only'));
    await adapter.start(taskStart(mcp, READ_ONLY_MODE));
    void turn(adapter);
    await vi.waitFor(() => expect(agent.requests('session/prompt')).toHaveLength(1));

    const recorded = recording('read-only').find((e) => e.dir === 'out' && e.line.method === 'session/prompt');
    const textOf = (params: unknown) => (params as { prompt: Array<{ text: string }> }).prompt[0].text;
    const contract = (text: string) => text.slice(0, text.lastIndexOf('\n\n'));
    const [sent] = prompts(agent);
    expect(sent).toContain('This task is read-only: your own file edits, shell and web tools are off.');
    expect(sent).toContain('`ordewell__run_command`');
    expect(sent).toContain(`The workspace is \`${CWD}\`, not the directory you start in`);
    expect(sent).toContain('task_complete');
    expect(contract(sent)).toBe(contract(recorded?.dir === 'out' ? textOf(recorded.line.params) : ''));
  });

  it('refuses Cline\'s apply_patch on a read-only start, though Cline names it `other`, and its report of the refusal reaches the server', async () => {
    const { mcp, completed } = await readOnlyToken();
    const { agent, adapter } = cline(replay('read-only-write'));
    await adapter.start(taskStart(mcp, READ_ONLY_MODE));
    const first = await turn(adapter);
    // Cline ended its turn on the refusal; Ordewell's completion reminder is the next.
    const second = await turn(adapter);

    expect(note('read-only-write', 'summary')?.permissions?.[0]).toMatchObject({ kind: 'other', title: expect.stringMatching(/^apply_patch: /) });
    expect(asked(first).map((e) => [e.name, e.decided?.decision])).toEqual([[expect.stringContaining('apply_patch'), 'deny']]);
    expect(asked(second).map((e) => e.decided)).toEqual([{ decision: 'allow' }]);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('read-only-write'));
    expect(permissionAnswers(agent)).toEqual([
      { outcome: 'selected', optionId: 'reject_once' },
      { outcome: 'selected', optionId: 'allow_once' },
    ]);
    expect(reports(completed)).toEqual(recordedReports('read-only-write').map((r) => expect.objectContaining(r)));
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }), expect.anything());
    expect(note('read-only-write', 'summary')).toMatchObject({ ...UNTOUCHED, worktree: { entries: ['.git', 'README.md'], gitStatus: '' } });
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('refuses Cline\'s own shell on a read-only start by the kind it names, and its report of the refusal reaches the server', async () => {
    // Recorded with a token that lists no run_command, so Cline's own shell
    // was all it had to reach for; the start is read-only by its mode.
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = cline(replay('read-only-shell'));
    await adapter.start(taskStart(mcp, READ_ONLY_MODE));
    const events = await turn(adapter);

    expect(note('read-only-shell', 'summary')?.permissions?.[0]).toMatchObject({ kind: 'execute', title: `run_commands: touch ${CWD}/probe-shell.txt` });
    expect(asked(events).map((e) => e.decided?.decision)).toEqual(['deny', 'allow']);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('read-only-shell'));
    expect(permissionAnswers(agent)[0]).toEqual({ outcome: 'selected', optionId: 'reject_once' });
    expect(reports(completed)).toEqual(recordedReports('read-only-shell').map((r) => expect.objectContaining(r)));
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), expect.anything());
    expect(note('read-only-shell', 'summary')).toMatchObject({ ...UNTOUCHED, worktree: { entries: ['.git', 'README.md'], gitStatus: '' } });
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('lets a read-only task read through run_command and complete through Ordewell, as it was recorded', async () => {
    const { mcp, completed, commands } = await readOnlyToken();
    const { agent, adapter } = cline(replay('read-only'));
    await adapter.start(taskStart(mcp, READ_ONLY_MODE));
    await turn(adapter);
    const second = await turn(adapter);

    // Recorded when Cline's own read was still refused, which is why it turned
    // to run_command: that read is now allowed, so only the turn after it is
    // checked against the recording.
    expect(recordedAnswers('read-only')[0]).toEqual({ outcome: 'selected', optionId: 'reject_once' });
    expect(asked(second).map((e) => e.decided?.decision)).toEqual(['allow', 'allow']);
    expect(permissionAnswers(agent).slice(1)).toEqual(recordedAnswers('read-only').slice(1));
    expect(commands).toHaveBeenCalledWith(expect.objectContaining({ command: `head -40 ${CWD}/README.md` }), expect.anything());
    expect(reports(completed)).toEqual(recordedReports('read-only').map((r) => expect.objectContaining(r)));
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }), expect.anything());
    expect(note('read-only', 'summary')).toMatchObject({ ...UNTOUCHED, worktree: { entries: ['.git', 'README.md'], gitStatus: '' } });
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  /**
   * The read-only recording with its read_files request asking for `rawInput`
   * instead. Only the first turn is driven: what Cline did after its read was
   * answered is the recording's, made on a refusal.
   */
  async function firstRead(rawInput: unknown) {
    const { mcp } = await readOnlyToken();
    let swapped = false;
    const steps = replay('read-only').map((step): FakeAcpStep => {
      if (swapped || !('request' in step) || step.request !== 'session/request_permission') return step;
      swapped = true;
      const params = step.params as { toolCall: Record<string, unknown> };
      return { request: step.request, params: { ...params, toolCall: { ...params.toolCall, title: `read_files: ${JSON.stringify(rawInput)}`, rawInput } } };
    });
    const { agent, adapter } = cline(steps);
    await adapter.start(taskStart(mcp, READ_ONLY_MODE));
    const events = await turn(adapter);
    return { decided: asked(events).map((e) => e.decided?.decision), answer: permissionAnswers(agent)[0] };
  }

  it('allows Cline\'s own read of a workspace file on a read-only start, by the path its arguments name', async () => {
    const [read] = note('read-only', 'summary')?.permissions ?? [];
    expect(read).toMatchObject({ kind: 'read', title: expect.stringMatching(/^read_files: /) });
    // Cline's request carries the path only in the model's arguments, never as a location.
    const recorded = recording('read-only').find((e) => e.dir === 'in' && e.line.method === 'session/request_permission');
    const { rawInput, locations } = recorded?.dir === 'in' ? (recorded.line.params as { toolCall: { rawInput: Record<string, unknown>; locations?: unknown[] } }).toolCall : { rawInput: {}, locations: ['?'] };
    expect(locations ?? []).toEqual([]);
    expect(rawInput).toEqual({ files: [{ path: `${CWD}/README.md`, start_line: 1, end_line: 20 }] });

    expect(await firstRead(rawInput)).toEqual({ decided: ['allow'], answer: { outcome: 'selected', optionId: 'allow_once' } });
    expect(await firstRead({ path: `${CWD}/src` })).toEqual({ decided: ['allow'], answer: { outcome: 'selected', optionId: 'allow_once' } });
  });

  it('refuses Cline\'s own read of a file outside the workspace, of several files, and of no path it names', async () => {
    const refused = { decided: ['deny'], answer: { outcome: 'selected', optionId: 'reject_once' } };
    expect(await firstRead({ files: [{ path: '/etc/hosts' }] })).toEqual(refused);
    expect(await firstRead({ files: [{ path: `${CWD}/../etc/hosts` }] })).toEqual(refused);
    expect(await firstRead({ files: [{ path: `${CWD}/README.md` }, { path: `${CWD}/a.ts` }] })).toEqual(refused);
    expect(await firstRead({ queries: ['where is the README'] })).toEqual(refused);
    expect(await firstRead({ files: [{ path: `${CWD}/README.md` }, { start_line: 1 }] })).toEqual(refused);
    // A shape the hook does not read names nothing, even where a path shows through.
    expect(await firstRead({ files: `${CWD}/README.md` })).toEqual(refused);
    expect(await firstRead({ files: [`${CWD}/README.md`] })).toEqual(refused);
    expect(await firstRead(`${CWD}/README.md`)).toEqual(refused);
    // Cline starts in a directory of its own, so that is where it would read a relative path from.
    expect(await firstRead({ files: [{ path: 'README.md' }] })).toEqual(refused);
  });

  it('leaves no private directory behind once a read-only task\'s process is gone', async () => {
    const { mcp } = await readOnlyToken();
    const { agent, adapter } = cline(replay('read-only-shell'));
    await adapter.start(taskStart(mcp, READ_ONLY_MODE));
    await turn(adapter);
    await agent.finished;
    await agent.close(0);

    await vi.waitFor(() => expect(readdirSync(temp)).toEqual([]));
  });

  it('refuses to plan, since its profile claims no planner role (ADR-0060, R3)', async () => {
    const { mcp } = await readOnlyToken();
    const { spawned, adapter } = cline(replay('read-only'));
    const planner: PlannerStartOptions = { kind: 'planner', cwd: CWD, model: MODEL, systemPrompt: 'You are the planner.', mcp };

    await expect(adapter.start(planner)).rejects.toThrow('Cline cannot plan in Ordewell: its profile claims no planner role.');
    expect(spawned.processes).toHaveLength(0);
    // Not for how it attaches: a planner's goal can be its attach check too (R5).
    expect(acpRoles({ ...CLINE_PROFILE, roles: { plans: true, readOnly: true } })).toEqual({ plans: true, readOnly: true });
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
