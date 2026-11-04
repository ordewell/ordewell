import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import { discoverAcpModels } from '../harness/acpModels';
import { GEMINI_CLI_PROFILE } from '../harness/geminiProfile';
import type { AcpToolCall } from '../harness/acpSchema';
import type { AgentEvent, AgentProcessDeps, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
import { VENDORS } from '../apiProviders';
import { BUILTIN_MANIFESTS } from '../../plugins/builtin';
import { GEMINI_ACP_ARGS, GEMINI_CLI_MANIFEST } from '../../plugins/builtin/gemini-cli.manifest';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { OrdewellMcpServer, mcpClientConfig, type McpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpAgent, type FakeAcpStep } from './fakeAcpAgent';

/**
 * The gemini-cli connector against Gemini CLI 0.66.0 as it was recorded over
 * ACP (`fixtures/acp/gemini-cli/`): each recording is replayed as the agent's
 * side of the conversation, with Ordewell's side live. Gemini's MCP traffic
 * went to the server, not over stdio, so the replay makes the contact the
 * recording's notes show at the point they show it.
 */

const FIXTURES = join(__dirname, 'fixtures/acp/gemini-cli');

/** Where each test's start puts the task, which the recordings name `{{CWD}}`. */
const CWD = '/repo';

type WireLine = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
interface Note {
  dir: 'note';
  ms: number;
  event: string;
  args?: string[];
  mode?: string;
  ok?: boolean;
  contacted?: boolean;
  completed?: Array<Record<string, unknown>>;
  permissions?: Array<{ toolCallId: string; title: string; kind: string; options: string[]; answer?: string }>;
  leftBehind?: string[];
}
type Recorded = { dir: 'in' | 'out'; ms: number; line: WireLine } | Note;

function recording(name: string): Recorded[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').replaceAll('{{CWD}}', CWD).trim().split('\n').map((line) => JSON.parse(line) as Recorded);
}

function note(name: string, event: string): Note | undefined {
  const found = recording(name).find((entry) => entry.dir === 'note' && entry.event === event);
  return found?.dir === 'note' ? found : undefined;
}

/** The arguments Gemini was recorded running under. */
const recordedArgs = (name: string): string[] => note(name, 'spawn')?.args ?? [];

/** What Ordewell sent, by method, as the recording shows it. */
const recordedOut = (name: string, method: string) =>
  recording(name).flatMap((entry) => (entry.dir === 'out' && entry.line.method === method ? [entry.line.params] : []));

/** What the recording's MCP handler was given, the evidence each scenario's verdict rests on. */
const recordedReports = (name: string) => note(name, 'summary')?.completed ?? [];

/** The answers the recording shows Ordewell giving Gemini's requests, in order. */
const recordedAnswers = (name: string) =>
  recording(name).flatMap((entry) => {
    if (entry.dir !== 'in' || entry.line.method !== 'session/request_permission') return [];
    const answer = recording(name).find((e) => e.dir === 'out' && e.line.method === undefined && e.line.id === entry.line.id);
    return answer?.dir === 'out' ? [(answer.line.result as { outcome: unknown }).outcome] : [];
  });

/** The model the recordings ran on, as `--model` took it. */
const MODEL = recordedArgs('ordewell-tool')[recordedArgs('ordewell-tool').indexOf('--model') + 1];

/**
 * The agent's side of a recording as a script: what Ordewell sent becomes what
 * the agent waits for, and what Gemini sent is sent again, each answer to the
 * request it answered. Ordewell's own answers are not replayed: the adapter
 * gives its own. A request of Gemini's waits for its answer unless the
 * recording shows Ordewell saying something else first, as a cancel does.
 * `after` adds steps the wire cannot show, keyed by the method they follow.
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

/** In a trusted folder Gemini connects to its MCP servers while it opens the session, before it answers. */
const CONTACT_ON: Partial<Record<string, FakeAcpStep[]>> = {
  'session/new': [{ run: async (agent) => { await agent.listMcpTools(); } }],
  'session/load': [{ run: async (agent) => { await agent.listMcpTools(); } }],
};

/** The recording's task_complete calls, made where Gemini made them: once its request to was allowed. */
const reporting = (name: string): Partial<Record<string, FakeAcpStep[]>> => {
  const reports = [...recordedReports(name)];
  return {
    ...CONTACT_ON,
    'session/request_permission': [{ run: async (agent) => {
      const args = reports.shift();
      if (args) await agent.callMcp('task_complete', args);
    } }],
  };
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

function gemini(steps: FakeAcpStep[]) {
  const spawned = fakeAcpSpawn(steps);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP for Gemini'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  const adapter = CONNECTORS['gemini-cli'].create(deps);
  adapters.push(adapter);
  return { spawned, agent: spawned.agent, adapter };
}

function taskStart(mcp: McpClientConfig, mode = 'default', extra: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return { kind: 'task', cwd: CWD, mode, model: MODEL, flags: resolveTaskRunnerFlags(GEMINI_CLI_MANIFEST, { mode, model: MODEL }), mcp, ...extra };
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

/** What a report's evidence was handed, call by call. */
const reports = (completed: ReturnType<typeof vi.fn>) => completed.mock.calls.map((call: unknown[]) => call[0]);

describe('gemini-cli, replayed from Gemini CLI 0.66.0', () => {
  it('launches Gemini over ACP, trusting the worktree, on the plan\'s model, as it was recorded', async () => {
    const { mcp } = await taskToken();
    const { spawned, agent, adapter } = gemini(replay('ordewell-tool', CONTACT_ON));
    await adapter.start(taskStart(mcp));

    expect(spawned.lastCommand()).toBe('gemini');
    expect(spawned.lastArgs()).toEqual(recordedArgs('ordewell-tool'));
    expect(spawned.lastArgs()).toEqual(['--acp', '--skip-trust', '--model', MODEL]);
    expect(agent.problems).toEqual([]);
  });

  it('hands Gemini the server in session/new, as Gemini advertises HTTP MCP and the recording shows', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = gemini(replay('ordewell-tool', CONTACT_ON));
    await adapter.start(taskStart(mcp));

    const init = recording('ordewell-tool').find((e) => e.dir === 'in' && e.line.id === 1);
    expect(init?.dir === 'in' && init.line.result).toMatchObject({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const recorded = JSON.stringify(recordedOut('ordewell-tool', 'session/new'))
      .replace('{{MCP_URL}}', mcp.url)
      .replace('Bearer [REDACTED]', mcp.headers.Authorization);
    expect(agent.requests('session/new').map((r) => r.params)).toEqual(JSON.parse(recorded));
  });

  it('sets the plan\'s mode with session/set_mode, as the recording shows Ordewell doing, and the model by --model alone', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = gemini(replay('ordewell-tool', CONTACT_ON));
    await adapter.start(taskStart(mcp));

    expect(agent.requests('session/set_mode').map((r) => r.params)).toEqual(recordedOut('ordewell-tool', 'session/set_mode'));
    expect(agent.requests('session/set_config_option')).toEqual([]);
    expect(agent.requests('session/set_model')).toEqual([]);
    expect(agent.problems).toEqual([]);
  });

  it('reads Gemini\'s contact with the server while it opens the session as attached', async () => {
    const { mcp } = await taskToken();
    const { adapter } = gemini(replay('ordewell-tool', CONTACT_ON));
    await adapter.start(taskStart(mcp));

    expect(note('ordewell-tool', 'contact-at-session-new')?.contacted).toBe(true);
    expect(await adapter.mcpAttached?.()).toBe('connected');
  });

  it('carries the contract in the first prompt, where Gemini has no other channel for it', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = gemini(replay('ordewell-tool', CONTACT_ON));
    await adapter.start(taskStart(mcp));
    void turn(adapter);
    await vi.waitFor(() => expect(agent.requests('session/prompt')).toHaveLength(1));

    expect(JSON.stringify(agent.requests('session/prompt')[0].params)).toContain('task_complete');
  });

  it('allows Gemini\'s request to call task_complete at once, by the tool its call id names, and the call reaches the server', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = gemini(replay('ordewell-tool', reporting('ordewell-tool')));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter);

    expect(asked(events).map((e) => e.decided)).toEqual([{ decision: 'allow' }]);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('ordewell-tool'));
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'proceed_once' }]);
    expect(recordedReports('ordewell-tool')).toEqual([{ status: 'done', summary: 'ok' }]);
    expect(reports(completed)).toEqual(recordedReports('ordewell-tool').map((r) => expect.objectContaining(r)));
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it.each([
    ['edit', 'edit', 'Writing to hello.txt'],
    ['execute', 'execute', 'touch ran.txt'],
  ])('holds Gemini\'s %s for a person, and passes the person\'s answer back', async (name, kind, title) => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = gemini(replay(name, CONTACT_ON));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter, 'allow');

    expect(note(name, 'summary')?.permissions?.map((p) => [p.kind, p.title])).toEqual([[kind, title]]);
    const held = asked(events);
    expect(held).toHaveLength(1);
    expect(held[0].decided).toBeUndefined();
    expect(JSON.stringify(held[0])).toContain(title);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers(name));
    expect(completed).not.toHaveBeenCalled();
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('answers a person\'s refusal of Gemini\'s edit with its reject option', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = gemini(replay('deny', CONTACT_ON));
    await adapter.start(taskStart(mcp));
    await turn(adapter, 'deny');

    expect(permissionAnswers(agent)).toEqual(recordedAnswers('deny'));
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'cancel' }]);
    expect(note('deny', 'summary')?.leftBehind).toEqual([]);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('shows a command Gemini judges safe and runs without asking, even in its default mode', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = gemini(replay('execute-safe', CONTACT_ON));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter, 'allow');

    expect(asked(events)).toEqual([]);
    expect(events.filter((e) => e.type === 'tool_call').length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain('run_shell_command__call_');
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('interrupts a turn Gemini is waiting on a person in: the held command is answered cancelled', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = gemini(replay('cancel', CONTACT_ON));
    await adapter.start(taskStart(mcp));
    let interrupted: Promise<boolean> | undefined;
    const events: AgentEvent[] = [];
    await adapter.send('go', (event) => {
      events.push(event);
      if (event.type === 'permission_request') interrupted = adapter.interrupt(1000);
    });

    expect(note('cancel', 'summary')?.permissions?.[0]).toMatchObject({ kind: 'execute', title: 'sleep 30' });
    expect(await interrupted).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(agent.requests('session/cancel')).toHaveLength(1);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('cancel'));
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'cancelled' }]);
    expect(completed).not.toHaveBeenCalled();
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('sets Gemini\'s yolo mode under the plan\'s autonomous mode, where it asks about nothing', async () => {
    const { mcp } = await taskToken();
    const { spawned, agent, adapter } = gemini(replay('allow-all', CONTACT_ON));
    await adapter.start(taskStart(mcp, 'yolo'));
    const events = await turn(adapter);

    expect(spawned.lastArgs()).toEqual(recordedArgs('allow-all'));
    expect(agent.requests('session/set_mode').map((r) => r.params)).toEqual(recordedOut('allow-all', 'session/set_mode'));
    expect(agent.requests('session/set_mode').map((r) => (r.params as { modeId: string }).modeId)).toEqual(['yolo']);
    expect(asked(events)).toEqual([]);
    expect(events.filter((e) => e.type === 'tool_call').length).toBeGreaterThan(0);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('resumes a session with session/load, handing it the server again, and shows none of the history Gemini replays', async () => {
    const { mcp, completed } = await taskToken();
    const [loaded] = recordedOut('load', 'session/load') as Array<{ sessionId: string; cwd: string; mcpServers: unknown }>;
    const answeredAt = recording('load').find((e) => e.dir === 'note' && e.event === 'contact-at-session-load')?.ms ?? 0;
    const history = recording('load').flatMap((e) => {
      if (e.dir !== 'in' || e.line.method !== 'session/update' || e.ms > answeredAt + 10) return [];
      const id = (e.line.params as { update: { toolCallId?: string } }).update.toolCallId;
      return id ? [id] : [];
    });
    const { agent, adapter } = gemini(replay('load', reporting('load')));
    await adapter.start(taskStart(mcp, 'default', { resumeSessionId: loaded.sessionId }));

    const recorded = JSON.stringify(loaded).replace('{{MCP_URL}}', mcp.url).replace('Bearer [REDACTED]', mcp.headers.Authorization);
    expect(agent.requests('session/load').map((r) => r.params)).toEqual([JSON.parse(recorded)]);
    expect(agent.requests('session/new')).toEqual([]);
    expect(adapter.nativeSessionId()).toBe(loaded.sessionId);
    expect(note('load', 'contact-at-session-load')?.contacted).toBe(true);
    expect(await adapter.mcpAttached?.()).toBe('connected');
    const events = await turn(adapter);

    expect(history).toEqual(['update_topic__call_356585', 'mcp_ordewell_task_complete__call_356588']);
    for (const id of history) expect(JSON.stringify(events)).not.toContain(id);
    expect(recordedReports('load')).toEqual([{ status: 'done', summary: 'PINEAPPLE' }]);
    expect(reports(completed)).toEqual(recordedReports('load').map((r) => expect.objectContaining(r)));
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('starts trusted because an untrusted Gemini never reached the server and refused yolo', async () => {
    expect(recordedArgs('untrusted')).not.toContain('--skip-trust');
    expect(recording('untrusted').filter((e) => e.dir === 'note' && e.contacted !== undefined).map((e) => e.dir === 'note' && e.contacted))
      .toEqual([false, false, false]);
    expect(recordedReports('untrusted')).toEqual([]);
    expect(GEMINI_CLI_PROFILE.args).toContain('--skip-trust');

    const { mcp } = await taskToken();
    const { adapter } = gemini(replay('untrusted-yolo'));
    await expect(adapter.start(taskStart(mcp, 'yolo'))).rejects.toThrow('Gemini CLI refused the mode "yolo": Internal error');
  });

  it('does not take an untrusted Gemini that never contacts the server as attached', async () => {
    const { mcp } = await taskToken();
    const { adapter } = gemini(replay('untrusted'));
    await adapter.start(taskStart(mcp));

    const waited = new Promise((resolve) => { setTimeout(() => resolve('still waiting'), 200); });
    expect(await Promise.race([adapter.mcpAttached?.(), waited])).toBe('still waiting');
  });

  it('reads Gemini\'s missing key as signed out, and names the command that signs it in', async () => {
    const { mcp } = await taskToken();
    const { adapter } = gemini(replay('signed-out'));

    await expect(adapter.start(taskStart(mcp))).rejects.toThrow('Gemini CLI is not signed in. Run `gemini`.');
    const refusal = recording('signed-out').find((e) => e.dir === 'in' && e.line.error);
    expect(refusal?.dir === 'in' && refusal.line.error?.message).toMatch(GEMINI_CLI_MANIFEST.auth?.signedOut ?? /^$/);
    expect('Gemini CLI is not signed in. Run `gemini`.').toMatch(GEMINI_CLI_MANIFEST.auth?.signedOut ?? /^$/);
  });

  it('claims no role: Gemini does not plan and offers no read-only mode, as no recording shows its plan mode refusing a write and a command', () => {
    expect(CONNECTORS['gemini-cli'].plans).toBe(false);
    expect(GEMINI_CLI_PROFILE.roles).toBeUndefined();
    expect(GEMINI_CLI_PROFILE.restricted).toBeUndefined();
    expect(GEMINI_CLI_MANIFEST.modes?.some((mode) => mode.readOnly)).toBe(false);
    expect(GEMINI_CLI_MANIFEST.modes?.map((mode) => mode.id)).toEqual(['default', 'autoEdit', 'yolo']);
  });

  it('takes a call for Ordewell\'s only when its call id names a tool under Ordewell\'s server prefix', () => {
    const binding = acpOrdewellBinding(GEMINI_CLI_PROFILE);
    const call = (toolCallId: string, title = 'task_complete(status: done)', kind: AcpToolCall['kind'] = 'other'): AcpToolCall => ({ toolCallId, title, kind });
    // As the recordings show them: the tool's name, `__`, then Gemini's call id.
    const recorded = ['ordewell-tool', 'edit', 'execute', 'cancel', 'load', 'untrusted'].flatMap((name) => note(name, 'summary')?.permissions ?? []);
    expect(recorded.length).toBeGreaterThan(0);
    for (const p of recorded) {
      expect(binding.isOrdewellAsk({ request: call(p.toolCallId, p.title, p.kind as AcpToolCall['kind']) })).toBe(p.toolCallId.startsWith('mcp_ordewell_task_complete__'));
    }
    expect(binding.isOrdewellAsk({ request: call('mcp_ordewell_submit_plan__call_1', '{}', 'execute') })).toBe(true);
    // A native tool is bare; another server's is prefixed by its own name; a
    // lookalike server shares only the start of the name; a tool Ordewell
    // does not have is not one of its calls.
    expect(binding.isOrdewellAsk({ request: call('task_complete__call_1') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('mcp_ordewell2_task_complete__call_1') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('mcp_evil_task_complete__call_1') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('mcp_ordewell_x_task_complete__call_1') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('mcp_ordewell_rm__call_1') })).toBe(false);
    expect(binding.isOrdewellAsk({ request: call('mcp_ordewell_task_complete') })).toBe(false);
    // The title is the model's: a native write whose title says it is Ordewell's.
    expect(binding.isOrdewellAsk({ request: call('write_file__call_1', 'mcp_ordewell_task_complete__call_1') })).toBe(false);
  });

  it('names an Ordewell tool the way Gemini shows it to the model, which its call ids carry', () => {
    const recorded = note('ordewell-tool', 'summary')?.permissions?.[0].toolCallId ?? '';
    expect(GEMINI_CLI_PROFILE.toolName?.('task_complete')).toBe(recorded.slice(0, recorded.indexOf('__')));
    expect(GEMINI_CLI_PROFILE.toolName?.('task_complete')).toBe('mcp_ordewell_task_complete');
  });
});

describe('gemini-cli model discovery', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-gemini-discovery-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A stand-in for `gemini --acp`: answers each request with what the recording has Gemini say next. */
  function geminiReplaying(name: string): string[] {
    const replies: Record<string, unknown[]> = {};
    let current = '';
    for (const entry of recording(name)) {
      if (entry.dir === 'out' && entry.line.method) { current = entry.line.method; replies[current] = []; }
      else if (entry.dir === 'in' && current) replies[current].push(entry.line);
    }
    const file = join(dir, 'gemini.cjs');
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

  it('asks Gemini untrusted, as it was recorded: discovery hands it no server, so it needs no trust', () => {
    expect(GEMINI_CLI_MANIFEST.modelDiscovery.method).toBe('acp');
    expect(GEMINI_CLI_MANIFEST.modelDiscovery.acp).toEqual({ args: recordedArgs('discovery') });
    expect(GEMINI_CLI_MANIFEST.modelDiscovery.acp?.args).toBe(GEMINI_ACP_ARGS);
    expect(GEMINI_CLI_PROFILE.args).toEqual([...GEMINI_ACP_ARGS, '--skip-trust']);
  });

  it('lists the models a signed-in Gemini CLI 0.66.0 offers in session/new, ids as --model takes them', async () => {
    const models = await discoverAcpModels(process.execPath, geminiReplaying('discovery'), { timeout: 5000 });

    expect(models?.map((m) => m.modelId)).toEqual([
      'auto',
      'gemini-3.1-pro-preview-customtools',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-3.8-flash',
      MODEL,
    ]);
  });

  it('reads a signed-out Gemini (-32000, "Gemini API key is missing") as no answer', async () => {
    expect(await discoverAcpModels(process.execPath, geminiReplaying('signed-out'), { timeout: 5000 })).toBeNull();
  });
});

describe('runner ids and API vendor ids', () => {
  it('gives Gemini CLI the id `gemini-cli`: `google` is the API vendor and no runner is `gemini`', () => {
    expect(GEMINI_CLI_MANIFEST.name).toBe('gemini-cli');
    expect(Object.keys(VENDORS)).toContain('google');
    expect(Object.keys(VENDORS)).not.toContain('gemini-cli');
    expect(BUILTIN_MANIFESTS.map((manifest) => manifest.name)).not.toContain('gemini');
    expect(BUILTIN_MANIFESTS.filter((manifest) => manifest.name === 'gemini-cli')).toEqual([GEMINI_CLI_MANIFEST]);
    expect(Object.keys(CONNECTORS).filter((id) => id === 'gemini-cli')).toEqual(['gemini-cli']);
  });

  it('has a connector for every built-in runner and a built-in runner for every connector', () => {
    expect(Object.keys(CONNECTORS).sort()).toEqual(BUILTIN_MANIFESTS.map((manifest) => manifest.name).sort());
  });
});
