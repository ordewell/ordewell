import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import { acpOrdewellBinding } from '../harness/acpOrdewell';
import { COPILOT_CLI_PROFILE } from '../harness/copilotProfile';
import type { AgentEvent, AgentProcessDeps, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
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
  | { dir: 'note'; ms: number; event: string; args?: string[] };

function recording(name: string): Recorded[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Recorded);
}

/** The arguments Copilot was recorded running under. */
function recordedArgs(name: string): string[] {
  const spawn = recording(name).find((entry) => entry.dir === 'note' && entry.event === 'spawn');
  return spawn && spawn.dir === 'note' ? spawn.args ?? [] : [];
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

function copilot(steps: FakeAcpStep[]) {
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
  const adapter = CONNECTORS['copilot-cli'].create(deps);
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
