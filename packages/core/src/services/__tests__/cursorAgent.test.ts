import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import { discoverAcpModels } from '../harness/acpModels';
import { CURSOR_AGENT_PROFILE } from '../harness/cursorProfile';
import { CURSOR_EXTENSION_REQUESTS } from '../harness/cursorRequests';
import { decideRestricted } from '../harness/acpRoles';
import { decidePlannerPermission } from '../harness/plannerPermissions';
import type { AcpToolCall } from '../harness/acpSchema';
import type { AgentEvent, AgentProcessDeps, PlannerStartOptions, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
import { VENDORS } from '../apiProviders';
import { classifyRunnerStop } from '../runnerExit';
import { BUILTIN_MANIFESTS } from '../../plugins/builtin';
import { CURSOR_ACP_ARGS, CURSOR_AGENT_MANIFEST } from '../../plugins/builtin/cursor-agent.manifest';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { OrdewellMcpServer, mcpClientConfig, type McpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpAgent, type FakeAcpStep } from './fakeAcpAgent';

/**
 * The cursor-agent connector against Cursor CLI 2026.10.22-27dcf5f, signed in
 * to an account without a paid plan, as it was recorded over ACP
 * (`fixtures/acp/cursor-agent/`): each recording is replayed as the agent's
 * side of the conversation, with Ordewell's side live. Cursor's MCP traffic
 * went to the server, not over stdio, so the replay makes the contact the
 * recording's notes show at the point they show it. Of the writable
 * recordings only `model` and `model-persists` set a model; the rest ran on
 * the account's default, which is a task with no model
 * (`TaskStartOptions.model`). The planner's and read-only task's recordings
 * (`ROLES`) each set Auto, `default[]`, as the plan names it.
 */

const FIXTURES = join(__dirname, 'fixtures/acp/cursor-agent');

/** Where each test's start puts the task, which the recordings name `{{CWD}}`. */
const CWD = '/repo';

type WireLine = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
interface Note {
  dir: 'note';
  ms: number;
  event: string;
  args?: string[];
  contacted?: boolean;
  completed?: Array<Record<string, unknown>>;
  permissions?: Array<{ toolCallId: string; title: string; kind: string; options: string[]; answer?: string }>;
  extensionRequests?: unknown[];
  leftBehind?: string[];
  current?: Array<[string, string]>;
  cwd?: string;
  tmpdir?: string;
  startDirAtSpawn?: string[];
}

/** What a restricted start's recording noted at its end, from the server's side and the workspace's. */
interface RolesOutcome {
  /** The Ordewell tools the server saw called, in order. */
  calls: string[];
  permissions: Array<{ title: string; kind: string; answered: string }>;
  /** Cursor's own client-bound requests (`cursor/*`) the turn sent. */
  extensions: unknown[];
  leftBehind: string[];
  /** What the workspace's planted `.cursor/hooks.json` hooks and `.cursor/mcp.json` server marked, had any run. */
  hooksRan: string[];
  /** Whether the word only the workspace's planted `.cursor/rules` rule, or its `AGENTS.md`, asks for reached the transcript. */
  ruleLoaded: boolean;
  agentsLoaded: boolean;
}
type Recorded = { dir: 'in' | 'out'; ms: number; line: WireLine } | Note;

const NAMES = ['cancel', 'deny', 'discovery', 'edit', 'execute', 'force', 'load', 'model', 'model-flag', 'model-persists', 'ordewell-tool', 'plan', 'signed-out'];

/** The restricted starts' recordings: a planner's, and the rest read-only tasks'. */
const ROLES = ['planner', 'read-only', 'planted-hook', 'extension-requests', 'restricted-write', 'restricted-shell', 'restricted-delete', 'restricted-fetch', 'restricted-search'] as const;

function recording(name: string): Recorded[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').replaceAll('{{CWD}}', CWD).trim().split('\n').map((line) => JSON.parse(line) as Recorded);
}

function note(name: string, event: string): Note | undefined {
  const found = recording(name).find((entry) => entry.dir === 'note' && entry.event === event);
  return found?.dir === 'note' ? found : undefined;
}

/** The arguments Cursor was recorded running under. */
const recordedArgs = (name: string): string[] => note(name, 'spawn')?.args ?? [];

/** What Ordewell sent, by method, as the recording shows it. */
const recordedOut = (name: string, method: string) =>
  recording(name).flatMap((entry) => (entry.dir === 'out' && entry.line.method === method ? [entry.line.params] : []));

/** What Cursor answered, by the method it answered. */
function recordedAnswer(name: string, method: string): unknown {
  const asked = recording(name).find((e) => e.dir === 'out' && e.line.method === method);
  const id = asked?.dir === 'out' ? asked.line.id : undefined;
  const answer = recording(name).find((e) => e.dir === 'in' && e.line.method === undefined && e.line.id === id);
  return answer?.dir === 'in' ? answer.line.result : undefined;
}

/** What the recording's MCP handler was given, the evidence each scenario's verdict rests on. */
const recordedReports = (name: string) => note(name, 'summary')?.completed ?? [];

/** The answers the recording shows Ordewell giving Cursor's requests, in order. */
const recordedAnswers = (name: string) =>
  recording(name).flatMap((entry) => {
    if (entry.dir !== 'in' || entry.line.method !== 'session/request_permission') return [];
    const answer = recording(name).find((e) => e.dir === 'out' && e.line.method === undefined && e.line.id === entry.line.id);
    return answer?.dir === 'out' ? [(answer.line.result as { outcome: unknown }).outcome] : [];
  });

/** The turn's first report of each call, which is what the adapter pairs a permission request with. */
function firstReports(name: string): Map<string, AcpToolCall> {
  const found = new Map<string, AcpToolCall>();
  for (const entry of recording(name)) {
    if (entry.dir !== 'in' || entry.line.method !== 'session/update') continue;
    const update = (entry.line.params as { update: AcpToolCall & { sessionUpdate: string } }).update;
    if (update.sessionUpdate === 'tool_call' && !found.has(update.toolCallId)) found.set(update.toolCallId, update);
  }
  return found;
}

const recordedOutcome = (name: string) => note(name, 'summary') as unknown as RolesOutcome;

/** The recorded launch with its private directory put back as `dir`, the one this start made. */
function launchedAs(name: string, dir: string) {
  const at = (path: string | undefined) => (path === '{{START_DIR}}' ? dir : path);
  const spawn = note(name, 'spawn');
  return { cwd: at(spawn?.cwd), tmpdir: at(spawn?.tmpdir), startDirAtSpawn: spawn?.startDirAtSpawn };
}

/**
 * The Ordewell call each of Cursor's permission requests was for, in order, as
 * its report of the call carries it, or null for a request for a tool of its
 * own. Cursor's MCP traffic went to the server, so the wire has only this.
 */
function recordedCalls(name: string): Array<{ tool: string; args: Record<string, unknown> } | null> {
  const ordewell = new Map<string, { tool: string; args: Record<string, unknown> }>();
  const calls: Array<{ tool: string; args: Record<string, unknown> } | null> = [];
  for (const entry of recording(name)) {
    if (entry.dir !== 'in') continue;
    if (entry.line.method === 'session/update') {
      const update = (entry.line.params as { update: { toolCallId?: string; rawInput?: { providerIdentifier?: string; toolName?: string; args?: Record<string, unknown> } } }).update;
      const input = update.rawInput;
      if (update.toolCallId && input?.providerIdentifier === 'ordewell' && input.toolName) ordewell.set(update.toolCallId, { tool: input.toolName, args: input.args ?? {} });
    } else if (entry.line.method === 'session/request_permission') {
      calls.push(ordewell.get((entry.line.params as { toolCall: { toolCallId: string } }).toolCall.toolCallId) ?? null);
    }
  }
  return calls;
}

/** The arguments of the recording's one call of `tool`. */
function recordedCall(name: string, tool: string): Record<string, unknown> {
  const found = recordedCalls(name).find((call) => call?.tool === tool);
  if (!found) throw new Error(`${name} has no call of ${tool}`);
  return found.args;
}

/** The value of a session's `model` option, as Cursor answered `session/new`. */
function sessionModel(name: string): string | undefined {
  const answer = recordedAnswer(name, 'session/new') as { configOptions?: Array<{ id: string; currentValue?: string }> } | undefined;
  return answer?.configOptions?.find((o) => o.id === 'model')?.currentValue;
}

/** The model the `model` recording set, as `session/set_config_option` took it. */
const MODEL = (recordedOut('model', 'session/set_config_option')[0] as { value: string }).value;

/**
 * The agent's side of a recording as a script: what Ordewell sent becomes what
 * the agent waits for, and what Cursor sent is sent again, each answer to the
 * request it answered. Ordewell's own answers are not replayed: the adapter
 * gives its own. A request of Cursor's waits for its answer unless the
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

/** Cursor connects to the MCP servers it is handed while it opens the session, before it answers. */
const CONTACT_ON: Partial<Record<string, FakeAcpStep[]>> = {
  'session/new': [{ run: async (agent) => { await agent.listMcpTools(); } }],
  'session/load': [{ run: async (agent) => { await agent.listMcpTools(); } }],
};

/** The recording's task_complete calls, made where Cursor made them: once its request to was allowed. */
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

/**
 * The recording's Ordewell calls, each made where Cursor made it: once its
 * request was answered. A request for a tool of Cursor's own is followed by
 * none: the recordings show it refused.
 */
const calling = (name: string): Partial<Record<string, FakeAcpStep[]>> => {
  const calls = recordedCalls(name);
  return {
    ...CONTACT_ON,
    'session/request_permission': [{ run: async (agent) => {
      const call = calls.shift();
      if (call) await agent.callMcp(call.tool, call.args);
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

function cursor(steps: FakeAcpStep[]) {
  const spawned = fakeAcpSpawn(steps);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP for Cursor'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  const adapter = CONNECTORS['cursor-agent'].create(deps);
  adapters.push(adapter);
  return { spawned, agent: spawned.agent, adapter };
}

function taskStart(mcp: McpClientConfig, mode = 'default', extra: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return { kind: 'task', cwd: CWD, mode, flags: resolveTaskRunnerFlags(CURSOR_AGENT_MANIFEST, { mode, model: extra.model }), mcp, ...extra };
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

describe('cursor-agent, replayed from Cursor CLI 2026.10.22', () => {
  it('launches Cursor over ACP with no other argument in its default mode, as it was recorded', async () => {
    const { mcp } = await taskToken();
    const { spawned, agent, adapter } = cursor(replay('ordewell-tool', CONTACT_ON));
    await adapter.start(taskStart(mcp));

    expect(spawned.lastCommand()).toBe('cursor-agent');
    expect(spawned.lastArgs()).toEqual(recordedArgs('ordewell-tool'));
    expect(spawned.lastArgs()).toEqual(['acp']);
    expect(agent.problems).toEqual([]);
  });

  it('hands Cursor the server in session/new, as Cursor advertises HTTP MCP and the recording shows', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = cursor(replay('ordewell-tool', CONTACT_ON));
    await adapter.start(taskStart(mcp));

    expect(recordedAnswer('ordewell-tool', 'initialize')).toMatchObject({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const recorded = JSON.stringify(recordedOut('ordewell-tool', 'session/new'))
      .replace('{{MCP_URL}}', mcp.url)
      .replace('Bearer [REDACTED]', mcp.headers.Authorization);
    expect(agent.requests('session/new').map((r) => r.params)).toEqual(JSON.parse(recorded));
    expect(agent.requests('session/set_mode')).toEqual([]);
    expect(agent.requests('session/set_config_option')).toEqual([]);
  });

  it('reads Cursor\'s contact with the server while it opens the session as attached', async () => {
    const { mcp } = await taskToken();
    const { adapter } = cursor(replay('ordewell-tool', CONTACT_ON));
    await adapter.start(taskStart(mcp));

    expect(note('ordewell-tool', 'contact-at-session-new')?.contacted).toBe(true);
    expect(await adapter.mcpAttached?.()).toBe('connected');
  });

  it('carries the contract in the first prompt, where Cursor has no other channel for it', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = cursor(replay('ordewell-tool', CONTACT_ON));
    await adapter.start(taskStart(mcp));
    void turn(adapter);
    await vi.waitFor(() => expect(agent.requests('session/prompt')).toHaveLength(1));

    expect(JSON.stringify(agent.requests('session/prompt')[0].params)).toContain('task_complete');
  });

  it('allows Cursor\'s request to call task_complete at once, by the title it gives an MCP call, and the call reaches the server', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = cursor(replay('ordewell-tool', reporting('ordewell-tool')));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter);

    expect(note('ordewell-tool', 'summary')?.permissions?.map((p) => [p.kind, p.title])).toEqual([['other', 'ordewell-task_complete: task_complete']]);
    expect(asked(events).map((e) => e.decided)).toEqual([{ decision: 'allow' }]);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('ordewell-tool'));
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'allow-once' }]);
    expect(recordedReports('ordewell-tool')).toEqual([{ status: 'done', summary: 'ok' }]);
    expect(reports(completed)).toEqual(recordedReports('ordewell-tool').map((r) => expect.objectContaining(r)));
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('holds Cursor\'s command for a person, and passes the person\'s answer back', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = cursor(replay('execute', CONTACT_ON));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter, 'allow');

    expect(note('execute', 'summary')?.permissions?.map((p) => [p.kind, p.title])).toEqual([['execute', '`touch ran.txt`']]);
    const held = asked(events);
    expect(held).toHaveLength(1);
    expect(held[0].decided).toBeUndefined();
    expect(JSON.stringify(held[0])).toContain('touch ran.txt');
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('execute'));
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'allow-once' }]);
    expect(note('execute', 'summary')?.leftBehind).toEqual(['ran.txt']);
    expect(completed).not.toHaveBeenCalled();
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('answers a person\'s refusal of Cursor\'s command with its reject option, and nothing is left behind', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = cursor(replay('deny', CONTACT_ON));
    await adapter.start(taskStart(mcp));
    await turn(adapter, 'deny');

    expect(permissionAnswers(agent)).toEqual(recordedAnswers('deny'));
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'reject-once' }]);
    expect(note('deny', 'summary')?.leftBehind).toEqual([]);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('shows an edit Cursor writes without asking, even in its default mode', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = cursor(replay('edit', CONTACT_ON));
    await adapter.start(taskStart(mcp));
    const events = await turn(adapter, 'allow');

    expect(note('edit', 'summary')?.permissions).toEqual([]);
    expect(note('edit', 'summary')?.leftBehind).toEqual(['hello.txt']);
    expect(asked(events)).toEqual([]);
    expect(events.filter((e) => e.type === 'tool_call').length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain('hello.txt');
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('interrupts a turn Cursor is waiting on a person in: the held command is answered cancelled', async () => {
    const { mcp, completed } = await taskToken();
    const { agent, adapter } = cursor(replay('cancel', CONTACT_ON));
    await adapter.start(taskStart(mcp));
    let interrupted: Promise<boolean> | undefined;
    const events: AgentEvent[] = [];
    await adapter.send('go', (event) => {
      events.push(event);
      if (event.type === 'permission_request') interrupted = adapter.interrupt(1000);
    });

    expect(note('cancel', 'summary')?.permissions?.[0]).toMatchObject({ kind: 'execute', title: '`sleep 20 && touch late.txt`' });
    expect(await interrupted).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(agent.requests('session/cancel')).toHaveLength(1);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('cancel'));
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'cancelled' }]);
    expect(note('cancel', 'summary')?.leftBehind).toEqual([]);
    expect(completed).not.toHaveBeenCalled();
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('starts Cursor with --force under the plan\'s autonomous mode, where it asks about nothing and its report still reaches the server', async () => {
    const { mcp, completed } = await taskToken();
    const reported = recordedReports('force');
    const { spawned, agent, adapter } = cursor(replay('force', {
      ...CONTACT_ON,
      'session/prompt': [{ run: async (a) => { for (const args of reported) await a.callMcp('task_complete', args); } }],
    }));
    await adapter.start(taskStart(mcp, 'force'));
    const events = await turn(adapter);

    expect(spawned.lastArgs()).toEqual(recordedArgs('force'));
    expect(spawned.lastArgs()).toEqual(['acp', '--force']);
    expect(agent.requests('session/set_mode')).toEqual([]);
    expect(note('force', 'summary')?.permissions).toEqual([]);
    expect(asked(events)).toEqual([]);
    expect(note('force', 'summary')?.leftBehind).toEqual(['ran.txt']);
    expect(reported).toEqual([{ status: 'done', summary: 'ok' }]);
    expect(reports(completed)).toEqual(reported.map((r) => expect.objectContaining(r)));
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('resumes a session with session/load, handing it the server again, which Cursor contacts before it answers', async () => {
    const { mcp } = await taskToken();
    const [loaded] = recordedOut('load', 'session/load') as Array<{ sessionId: string; cwd: string; mcpServers: unknown }>;
    const { agent, adapter } = cursor(replay('load', CONTACT_ON));
    await adapter.start(taskStart(mcp, 'default', { resumeSessionId: loaded.sessionId }));

    const recorded = JSON.stringify(loaded).replace('{{MCP_URL}}', mcp.url).replace('Bearer [REDACTED]', mcp.headers.Authorization);
    expect(agent.requests('session/load').map((r) => r.params)).toEqual([JSON.parse(recorded)]);
    expect(agent.requests('session/new')).toEqual([]);
    expect(loaded.sessionId).toBe((recordedAnswer('ordewell-tool', 'session/new') as { sessionId: string }).sessionId);
    expect(adapter.nativeSessionId()).toBe(loaded.sessionId);
    expect(note('load', 'loaded')?.contacted).toBe(true);
    expect(await adapter.mcpAttached?.()).toBe('connected');
    expect(agent.problems).toEqual([]);
  });

  it('reads Cursor\'s refusal of a signed-out session as signed out, and names the command that signs it in', async () => {
    const { mcp } = await taskToken();
    const { adapter } = cursor(replay('signed-out'));

    await expect(adapter.start(taskStart(mcp))).rejects.toThrow('Cursor is not signed in. Run `cursor-agent login`.');
    const refusal = recording('signed-out').find((e) => e.dir === 'in' && e.line.error);
    expect(refusal?.dir === 'in' && refusal.line.error).toMatchObject({ code: -32000 });
    expect(refusal?.dir === 'in' && refusal.line.error?.message).toMatch(CURSOR_AGENT_MANIFEST.auth?.signedOut ?? /^$/);
    expect('Cursor is not signed in. Run `cursor-agent login`.').toMatch(CURSOR_AGENT_MANIFEST.auth?.signedOut ?? /^$/);
    expect(note('signed-out', 'summary')?.contacted).toBe(false);
  });

  it('answers Cursor\'s own blocking requests with the cursorRequests handlers, which no recorded turn sent', () => {
    expect(CURSOR_AGENT_PROFILE.extensionRequests).toBe(CURSOR_EXTENSION_REQUESTS);
    for (const name of NAMES) expect(note(name, 'summary')?.extensionRequests).toEqual([]);
    for (const name of ROLES) expect(recordedOutcome(name).extensions).toEqual([]);
    for (const name of [...NAMES, ...ROLES]) {
      expect(recording(name).filter((e) => e.dir === 'in' && e.line.method?.startsWith('cursor/'))).toEqual([]);
    }
  });

  it('takes a call for Ordewell\'s only when its request names a tool on Ordewell\'s server and its report is an MCP call', () => {
    const binding = acpOrdewellBinding(CURSOR_AGENT_PROFILE);
    const recorded = ['ordewell-tool', 'execute', 'deny', 'cancel'].flatMap((name) => {
      const first = firstReports(name);
      return (note(name, 'summary')?.permissions ?? []).map((p) => ({ name, p, report: first.get(p.toolCallId) }));
    });
    expect(recorded).toHaveLength(4);
    for (const { name, p, report } of recorded) {
      const request: AcpToolCall = { toolCallId: p.toolCallId, title: p.title, kind: p.kind as AcpToolCall['kind'] };
      expect(binding.isOrdewellAsk({ request, ...(report ? { report } : {}) })).toBe(name === 'ordewell-tool');
    }
    expect(firstReports('ordewell-tool').values().next().value?.title).toBe('MCP: tool');

    const mcpReport: AcpToolCall = { toolCallId: 'c1', title: 'MCP: tool', kind: 'other' };
    const ask = (title: string, report: AcpToolCall | null = mcpReport) =>
      binding.isOrdewellAsk({ request: { toolCallId: 'c1', title, kind: 'other' }, ...(report ? { report } : {}) });
    expect(ask('ordewell-submit_plan: submit_plan')).toBe(true);
    // The request alone: a native call's report never says MCP, so the pair is required.
    expect(ask('ordewell-task_complete: task_complete', null)).toBe(false);
    expect(ask('ordewell-task_complete: task_complete', { toolCallId: 'c1', title: '`touch ran.txt`', kind: 'execute' })).toBe(false);
    // Another server, a lookalike one, a mismatched pair, a tool Ordewell does
    // not have, a title naming no tool after the server's.
    expect(ask('evil-task_complete: task_complete')).toBe(false);
    expect(ask('ordewell2-task_complete: task_complete')).toBe(false);
    expect(ask('ordewell-x-task_complete: task_complete')).toBe(false);
    expect(ask('ordewell-task_complete: submit_plan')).toBe(false);
    expect(ask('ordewell-rm: rm')).toBe(false);
    expect(ask('ordewell: task_complete')).toBe(false);
    expect(ask('ordewell-task_complete')).toBe(false);
    expect(ask('ordewell-task_complete: task_complete ')).toBe(false);
  });

  it('names an Ordewell tool by the server\'s own name, which Cursor\'s report of the call carries', () => {
    expect(CURSOR_AGENT_PROFILE.toolName).toBeUndefined();
    const named = recording('ordewell-tool').flatMap((e) => {
      if (e.dir !== 'in' || e.line.method !== 'session/update') return [];
      const input = (e.line.params as { update: { rawInput?: { providerIdentifier?: string; toolName?: string } } }).update.rawInput;
      return input?.toolName ? [[input.providerIdentifier, input.toolName]] : [];
    });
    expect(named).toEqual([['ordewell', 'task_complete']]);
  });
});

async function readOnlyToken() {
  const server = new OrdewellMcpServer();
  servers.push(server);
  const completed = vi.fn(async () => ({ text: 'Recorded.' }));
  const ran = vi.fn(async () => ({ text: '# Notes\n\nThe secret word is HERON.\n' }));
  const credential = await server.issueTaskToken({ sessionId: 's1', taskId: 't1', attempt: 1, readOnly: true }, { taskComplete: completed, runCommand: ran } as never);
  return { mcp: mcpClientConfig(credential), completed, ran };
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

/** Cursor's read-only mode, as the plan names it. */
const READ_ONLY_MODE = CURSOR_AGENT_MANIFEST.modes?.find((mode) => mode.readOnly)?.id ?? 'none';

/** Auto, the model every restricted recording ran on: an account with no paid plan offered nothing else. */
const AUTO = 'default[]';

function readOnlyStart(mcp: McpClientConfig): TaskStartOptions {
  return taskStart(mcp, READ_ONLY_MODE, { model: AUTO });
}

function plannerStart(mcp: McpClientConfig): PlannerStartOptions {
  return { kind: 'planner', cwd: CWD, model: AUTO, systemPrompt: 'You are the planner.', mcp };
}

const startOf = async (name: string) => (name === 'planner' ? plannerStart((await plannerToken()).mcp) : readOnlyStart((await readOnlyToken()).mcp));

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

/** The settings a restricted start hands Cursor: every tool of its own that reads, writes or runs, denied. */
const DENY_ALL = {
  version: 1,
  permissions: { allow: [], deny: ['Read(**)', 'Write(**)', 'Shell(*)'] },
  approvalMode: 'allowlist',
  sandbox: { mode: 'disabled' },
};

const ALLOWED_ONCE = { outcome: 'selected', optionId: 'allow-once' };

describe('cursor-agent roles, replayed from Cursor CLI 2026.10.22 (ADR-0026, ADR-0028, ADR-0046, ADR-0060)', () => {
  it('claims both roles: it plans, and offers a read-only mode that never reaches Cursor\'s own plan or ask mode', () => {
    expect(CONNECTORS['cursor-agent'].plans).toBe(true);
    expect(CURSOR_AGENT_PROFILE.roles).toEqual({ plans: true, readOnly: true });
    expect(READ_ONLY_MODE).toBe('plan');
    expect(CURSOR_AGENT_MANIFEST.modes?.map((mode) => mode.id)).toEqual(['default', 'force', 'plan']);
    // Cursor's own plan mode, the one recorded turn that reached it, was refused for the account's plan.
    expect(recordedOut('plan', 'session/set_config_option')).toEqual([expect.objectContaining({ configId: 'mode', value: 'plan' })]);
    expect(JSON.stringify(recording('plan'))).toContain('Upgrade your plan to continue');
    for (const name of ROLES) {
      expect(recordedOut(name, 'session/set_mode')).toEqual([]);
      expect(recordedOut(name, 'session/set_config_option')).toEqual([expect.objectContaining({ configId: 'model', value: AUTO })]);
    }
  });

  it.each(ROLES)('starts %s in a directory of its own with Cursor\'s own read, write and shell tools denied, as it was recorded running none of the workspace\'s hooks or rules', async (name) => {
    const { spawned, agent, adapter } = cursor(replay(name, CONTACT_ON));
    await adapter.start(await startOf(name));

    const dir = spawned.lastCwd() ?? '';
    expect(dir.startsWith(CWD)).toBe(false);
    expect(spawned.lastArgs()).toEqual(recordedArgs(name));
    expect(spawned.lastArgs()).toEqual(['acp', '--sandbox', 'disabled']);
    expect({ cwd: dir, tmpdir: spawned.lastEnv().TMPDIR, startDirAtSpawn: readdirSync(dir) }).toEqual(launchedAs(name, dir));
    // Cursor's home of configuration is this start's own, holding the deny list and nothing of the user's.
    const home = join(dir, 'CURSOR_CONFIG_DIR');
    expect(spawned.lastEnv().CURSOR_CONFIG_DIR).toBe(home);
    expect(readdirSync(home)).toEqual(['cli-config.json']);
    expect(JSON.parse(readFileSync(join(home, 'cli-config.json'), 'utf8'))).toEqual(DENY_ALL);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'cli-config.json')).mode & 0o777).toBe(0o600);
    expect((agent.requests('session/new')[0].params as { cwd: string }).cwd).toBe(dir);
    expect(agent.requests('session/set_mode')).toEqual([]);
    expect(agent.requests('session/set_config_option').map((r) => r.params)).toEqual(recordedOut(name, 'session/set_config_option'));
    expect(recordedOutcome(name)).toMatchObject({ hooksRan: [], ruleLoaded: false, agentsLoaded: false, leftBehind: [] });
    expect(agent.problems).toEqual([]);
  });

  it('leaves a writable start as it was: in the worktree, on the user\'s own configuration, with only its mode\'s arguments', async () => {
    for (const [mode, args] of [['default', ['acp']], ['force', ['acp', '--force']]] as const) {
      const { mcp } = await taskToken();
      const { spawned, adapter } = cursor(replay(mode === 'force' ? 'force' : 'ordewell-tool', CONTACT_ON));
      await adapter.start(taskStart(mcp, mode));

      expect(spawned.lastArgs()).toEqual(args);
      expect(spawned.lastCwd()).toBe(CWD);
      expect(spawned.lastEnv().CURSOR_CONFIG_DIR).toBeUndefined();
    }
  });

  it('plans with Ordewell\'s planner tools alone, each allowed by its title: it lists, submits a plan with a read-only Cursor task and starts it, leaving nothing behind', async () => {
    const tools = ['list_runners', 'list_models', 'submit_plan', 'run_plan'];
    const { mcp, submitted, listed, models, ran } = await plannerToken();
    const { agent, adapter } = cursor(replay('planner', calling('planner')));
    await adapter.start(plannerStart(mcp));
    const events = await plannerTurn(adapter);

    expect(asked(events).map((e) => e.decided)).toEqual(tools.map(() => ({ decision: 'allow' })));
    expect(permissionAnswers(agent)).toEqual(recordedAnswers('planner'));
    expect(permissionAnswers(agent)).toEqual(tools.map(() => ALLOWED_ONCE));
    expect(listed).toHaveBeenCalled();
    expect(models).toHaveBeenCalledWith(expect.objectContaining({ runner: 'cursor-agent' }), expect.anything());
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ assignedRunner: 'cursor-agent', readOnly: true })],
    }), expect.anything());
    expect(ran).toHaveBeenCalled();
    expect(recordedOutcome('planner')).toMatchObject({
      calls: tools,
      permissions: tools.map((tool) => ({ title: `ordewell-${tool}: ${tool}`, kind: 'other', answered: 'allow_once' })),
      leftBehind: [],
    });
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it.each([
    ['restricted-write', 'edit', `Edit \`${CWD}/probe.txt\``, '`Read permission denied`'],
    ['restricted-shell', 'execute', '`touch probe-shell.txt`', 'was refused by permissions'],
    ['restricted-delete', 'delete', `Delete \`${CWD}/README.md\``, '`Permission denied`'],
  ] as const)('shows %s refused by Cursor\'s own deny list without asking, which the model reports blocked, leaving nothing behind', async (name, kind, title, refusal) => {
    const { mcp, completed } = await readOnlyToken();
    const { agent, adapter } = cursor(replay(name, calling(name)));
    await adapter.start(readOnlyStart(mcp));
    const events = await turn(adapter);

    // The call is reported, and never asked about: the deny list refused it inside Cursor.
    expect([...firstReports(name).values()].map((report) => report.kind)).toEqual([kind, 'other']);
    expect(JSON.stringify(recording(name))).toContain(JSON.stringify(title).slice(1, -1));
    expect(JSON.stringify(events)).toContain(JSON.stringify(refusal).slice(1, -1));
    expect(asked(events).map((e) => e.decided)).toEqual([{ decision: 'allow' }]);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers(name));
    expect(permissionAnswers(agent)).toEqual([ALLOWED_ONCE]);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }), expect.anything());
    expect(recordedOutcome(name)).toMatchObject({
      calls: ['task_complete'],
      permissions: [{ title: 'ordewell-task_complete: task_complete', kind: 'other', answered: 'allow_once' }],
      leftBehind: [],
    });
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it.each([
    ['restricted-write', 'edit'],
    ['restricted-shell', 'execute'],
    ['restricted-delete', 'delete'],
  ] as const)('would refuse %s by its kind with no person asked, had Cursor asked for it', async (name, kind) => {
    const [report] = firstReports(name).values();
    const request: AcpToolCall = { toolCallId: report.toolCallId, title: report.title, kind };
    const { mcp } = await readOnlyToken();

    expect(decideRestricted({ request, report }, { kind: 'other' }, readOnlyStart(mcp))).toMatchObject({ decision: 'deny' });
    expect(decideRestricted({ request, report }, { kind: 'other' }, { kind: 'planner' })).toMatchObject({ decision: 'deny' });
  });

  it.each([
    ['restricted-fetch', 'Fetch https://httpbin.org/uuid', 'fetch'],
    ['restricted-search', 'Web search: httpbin uuid', 'search'],
  ] as const)('refuses %s, the one tool of Cursor\'s own that asks, with its reject option and no person asked', async (name, title, kind) => {
    const { mcp, completed } = await readOnlyToken();
    const { agent, adapter } = cursor(replay(name, calling(name)));
    await adapter.start(readOnlyStart(mcp));
    const events = await turn(adapter);

    const requests = asked(events);
    expect(requests.map((e) => e.decided?.decision)).toEqual(['deny', 'allow']);
    expect(JSON.stringify(requests[0])).toContain(title);
    expect(permissionAnswers(agent)).toEqual(recordedAnswers(name));
    expect(permissionAnswers(agent)).toEqual([{ outcome: 'selected', optionId: 'reject-once' }, ALLOWED_ONCE]);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }), expect.anything());
    expect(recordedOutcome(name)).toMatchObject({
      calls: ['task_complete'],
      permissions: [{ title, kind, answered: 'reject_once' }, { title: 'ordewell-task_complete: task_complete', kind: 'other', answered: 'allow_once' }],
      leftBehind: [],
    });
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it.each([
    ['read-only', ['run_command', 'task_complete']],
    ['planted-hook', ['read', 'run_command', 'task_complete']],
  ] as const)('runs a %s task that reads the workspace through Ordewell\'s run_command and completes with the attempt\'s token', async (name, tools) => {
    const { mcp, completed, ran } = await readOnlyToken();
    const { agent, adapter } = cursor(replay(name, calling(name)));
    await adapter.start(readOnlyStart(mcp));
    const events = await turn(adapter);

    expect(asked(events).map((e) => e.decided)).toEqual(tools.map(() => ({ decision: 'allow' })));
    expect(permissionAnswers(agent)).toEqual(recordedAnswers(name));
    expect(permissionAnswers(agent)).toEqual(tools.map(() => ALLOWED_ONCE));
    expect(recordedCall(name, 'run_command')).toEqual({ command: `cat ${CWD}/README.md` });
    expect(ran).toHaveBeenCalledWith(expect.objectContaining({ command: `cat ${CWD}/README.md` }), expect.anything());
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', summary: 'HERON' }), expect.anything());
    expect(recordedOutcome(name)).toMatchObject({
      calls: tools,
      permissions: tools.map((tool) => ({ title: `ordewell-${tool}: ${tool}`, kind: 'other', answered: 'allow_once' })),
      leftBehind: [],
    });
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('answers Cursor\'s question skipped and its plan rejected in a read-only start, which Cursor was recorded not offering the model at all', async () => {
    const { mcp, completed } = await readOnlyToken();
    const { agent, adapter } = cursor(replay('extension-requests', {
      ...calling('extension-requests'),
      'session/prompt': [
        { request: 'cursor/ask_question', params: { toolCallId: 'q1', questions: [{ id: 'a', prompt: 'Which one?' }] } },
        { request: 'cursor/create_plan', params: { toolCallId: 'p1', plan: '1. Fix it.' } },
      ],
    }));
    await adapter.start(readOnlyStart(mcp));
    await turn(adapter);

    expect(agent.answers.filter((a) => a.method.startsWith('cursor/'))).toEqual([
      { method: 'cursor/ask_question', result: { outcome: { outcome: 'skipped', reason: 'No user is present; decide and continue, or use Ordewell\'s checkpoint tool.' } } },
      { method: 'cursor/create_plan', result: { outcome: { outcome: 'rejected', reason: 'Plan mode is not available in this role.' } } },
    ]);
    expect(recordedCall('extension-requests', 'task_complete')).toMatchObject({ status: 'done', summary: 'AskQuestion: no such tool. CreatePlan: no such tool.' });
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }), expect.anything());
    expect(recordedOutcome('extension-requests').extensions).toEqual([]);
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });
});

describe('cursor-agent models', () => {
  it('puts the plan\'s model on the session with session/set_config_option, as the recording shows Cursor taking it', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = cursor(replay('model', CONTACT_ON));
    await adapter.start(taskStart(mcp, 'default', { model: MODEL }));

    expect(MODEL).toBe('composer-2.5[fast=true]');
    expect(agent.requests('session/set_config_option').map((r) => r.params)).toEqual(recordedOut('model', 'session/set_config_option'));
    expect(note('model', 'set-config')?.current).toEqual([['mode', 'agent'], ['model', MODEL]]);
    expect(agent.problems).toEqual([]);
  });

  it('ends a turn Cursor refuses for the account\'s plan as an ordinary turn, which is not a usage limit', async () => {
    const { mcp } = await taskToken();
    const { agent, adapter } = cursor(replay('model', CONTACT_ON));
    await adapter.start(taskStart(mcp, 'default', { model: MODEL }));
    const events = await turn(adapter);

    expect(note('model', 'prompt-answered')).toMatchObject({ stopReason: 'end_turn', error: null });
    expect(JSON.stringify(events)).toContain('Upgrade your plan to continue');
    expect(events.at(-1)).toMatchObject({ type: 'turn_end' });
    expect(events.at(-1)).not.toMatchObject({ interrupted: true });
    expect(classifyRunnerStop('Upgrade your plan to continue')).toBe('stopped');
    expect(agent.problems).toEqual([]);
    await agent.finished;
  });

  it('sets the plan\'s model even where Cursor opens on another, as a new process opened on the last model set', async () => {
    expect(sessionModel('ordewell-tool')).toBe('default[]');
    expect(sessionModel('model-persists')).toBe(MODEL);
    expect(note('model-persists', 'set-config')?.current).toEqual([['mode', 'agent'], ['model', 'default[]']]);

    const { mcp } = await taskToken();
    const { agent, adapter } = cursor(replay('model-persists', CONTACT_ON));
    await adapter.start(taskStart(mcp, 'default', { model: 'default[]' }));

    expect(agent.requests('session/set_config_option').map((r) => r.params)).toEqual(recordedOut('model-persists', 'session/set_config_option'));
    expect(agent.problems).toEqual([]);
  });

  it('passes no model at spawn: Cursor opened on its default with --model given after acp', () => {
    expect(recordedArgs('model-flag')).toEqual(['acp', '--model', MODEL]);
    expect(sessionModel('model-flag')).toBe('default[]');
    expect(CURSOR_AGENT_PROFILE.modelArgs).toBeUndefined();
  });
});

describe('cursor-agent model discovery', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-cursor-discovery-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A stand-in for `cursor-agent acp`: answers each request with what the recording has Cursor say next. */
  function cursorReplaying(name: string): string[] {
    const replies: Record<string, unknown[]> = {};
    let current = '';
    for (const entry of recording(name)) {
      if (entry.dir === 'out' && entry.line.method) { current = entry.line.method; replies[current] = []; }
      else if (entry.dir === 'in' && current) replies[current].push(entry.line);
    }
    const file = join(dir, 'cursor-agent.cjs');
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

  it('asks Cursor with the words a task starts it with', () => {
    expect(CURSOR_AGENT_MANIFEST.modelDiscovery.method).toBe('acp');
    expect(CURSOR_AGENT_MANIFEST.modelDiscovery.acp).toEqual({ args: recordedArgs('discovery') });
    expect(CURSOR_AGENT_MANIFEST.modelDiscovery.acp?.args).toBe(CURSOR_ACP_ARGS);
    expect(CURSOR_AGENT_PROFILE.args).toBe(CURSOR_ACP_ARGS);
  });

  it('lists the models a signed-in Cursor offers in session/new, ids as session/set_config_option takes them', async () => {
    const models = await discoverAcpModels(process.execPath, cursorReplaying('discovery'), { timeout: 5000 });

    expect(models).toHaveLength(47);
    expect(models?.[0]).toEqual({ modelId: 'default[]', modelLabel: 'Auto', variants: [] });
    expect(models?.map((m) => m.modelId)).toContain(MODEL);
  });

  it('reads a signed-out Cursor (-32000, "Authentication required") as no answer', async () => {
    expect(await discoverAcpModels(process.execPath, cursorReplaying('signed-out'), { timeout: 5000 })).toBeNull();
  });
});

describe('runner ids and API vendor ids', () => {
  it('gives Cursor the id `cursor-agent`, its command\'s name, which no API vendor and no other runner has', () => {
    expect(CURSOR_AGENT_MANIFEST.name).toBe('cursor-agent');
    expect(CURSOR_AGENT_MANIFEST.runner.command).toBe('cursor-agent');
    expect(Object.keys(VENDORS)).not.toContain('cursor-agent');
    expect(Object.keys(VENDORS)).not.toContain('cursor');
    expect(BUILTIN_MANIFESTS.map((manifest) => manifest.name)).not.toContain('cursor');
    expect(BUILTIN_MANIFESTS.filter((manifest) => manifest.name === 'cursor-agent')).toEqual([CURSOR_AGENT_MANIFEST]);
    expect(Object.keys(CONNECTORS).filter((id) => id === 'cursor-agent')).toEqual(['cursor-agent']);
  });

  it('has a connector for every built-in runner and a built-in runner for every connector', () => {
    expect(Object.keys(CONNECTORS).sort()).toEqual(BUILTIN_MANIFESTS.map((manifest) => manifest.name).sort());
  });
});
