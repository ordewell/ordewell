import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import type { RunnerId } from '../../models/Task';
import type { AgentAdapter, AgentEvent, AgentProcessDeps } from '../harness/AgentAdapter';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { CodexAdapter } from '../harness/CodexAdapter';
import { OpenCodeAdapter } from '../harness/OpenCodeAdapter';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import type { StructuredEvent } from '../../interfaces/IRunner';
import { coalesceTaskLog, toTaskLogEvent, type TaskLogEvent } from '../../models/TaskLog';
import { EMPTY_CONVERSATION, reduceConversation, type ConversationView } from '../../conversation/reduce';
import { fromTranscript } from '../../conversation/transcript';
import { replayTaskLog, type TaskLogView } from '../../conversation/taskLog';
import type { SessionMessage } from '../SessionMessage';
import { fakeConfig } from '../../testing';
import { fakeMcpServer, fakeSpawn, fixture, openCodeFixture, sseResponse, type ScriptedReply } from './harnessTestKit';
import { makeSession } from './sessionTestKit';

/**
 * Every recorded stream in `fixtures/harness`, replayed through the real
 * adapter path, second round: a planner turn's (and a task turn's) words must
 * stay between the tool calls where the runner said them, live, coalesced as
 * a batch, and from the reloaded record.
 */

function processDeps(replies: ScriptedReply[], fetch?: typeof globalThis.fetch): AgentProcessDeps {
  const spawned = fakeSpawn(replies);
  return {
    spawn: spawned.spawn,
    fetch: fetch ?? (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof globalThis.fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
}

async function turnOf(adapter: AgentAdapter, started: (start: Promise<void>) => Promise<void> = (start) => start): Promise<AgentEvent[]> {
  await started(adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'Plan read-only.' }));
  const events: AgentEvent[] = [];
  await adapter.send('the goal', (event) => events.push(event));
  adapter.dispose();
  return events;
}

function claudeTurn(name: string): Promise<AgentEvent[]> {
  return turnOf(new ClaudeCodeAdapter(processDeps([fixture('claude-code', name)])));
}

function codexTurn(name: string): Promise<AgentEvent[]> {
  return turnOf(new CodexAdapter(processDeps([fixture('codex', 'handshake'), fixture('codex', 'new-conversation'), fixture('codex', name)])));
}

function openCodeTurn(name: string): Promise<AgentEvent[]> {
  const { sessionId, frames, response } = openCodeFixture(name);
  let delivered: () => void = () => {};
  const allDelivered = new Promise<void>((resolve) => { delivered = resolve; });
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace('http://127.0.0.1:4096', '');
    const method = init?.method ?? 'GET';
    if (path === '/event') {
      const { response: events, stream } = sseResponse(init, frames);
      void stream.drained.then(delivered);
      return events;
    }
    const json = method === 'POST' && path === '/session'
      ? { id: sessionId }
      : method === 'POST' && path === `/session/${sessionId}/message` ? await allDelivered.then(() => response) : true;
    return { ok: true, status: 200, statusText: 'OK', json: async () => json } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const spawned = fakeSpawn([], undefined);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  return turnOf(new OpenCodeAdapter(deps), async (start) => {
    for (let i = 0; i < 50 && spawned.processes.length === 0; i++) await Promise.resolve();
    spawned.processes[0].emitStdout('opencode server listening on http://127.0.0.1:4096\n');
    await start;
  });
}

const TURNS: Record<string, (name: string) => Promise<AgentEvent[]>> = { 'claude-code': claudeTurn, codex: codexTurn, opencode: openCodeTurn };

function logOf(events: AgentEvent[]): TaskLogEvent[] {
  const forwarded = events.filter((e): e is Extract<AgentEvent, StructuredEvent> =>
    e.type !== 'turn_end' && e.type !== 'permission_cancelled' && e.type !== 'message_delivered' && e.type !== 'message_dropped');
  return forwarded.flatMap((e) => toTaskLogEvent(e) ?? []);
}

/** The task log's blocks in order: `role:text`, `tool:name`, or the block's type. */
function shown(view: TaskLogView): string[] {
  return view.blocks.flatMap((b) => {
    if (b.type === 'usage') return [];
    if (b.type === 'message') return [`${b.role}:${b.text}`];
    if (b.type === 'tool') return [`tool:${b.headline.name}`];
    return [b.type];
  });
}

const claude = (name: string): [string, string, string[]] => ['claude-code', name, EXPECTED_CLAUDE[name]];
const codex = (name: string): [string, string, string[]] => ['codex', name, EXPECTED_CODEX[name]];
const opencode = (name: string): [string, string, string[]] => ['opencode', name, EXPECTED_OPENCODE[name]];

/** What each recorded turn, read as a task's log, draws: text and steps in the order the runner produced them. */
const EXPECTED_CLAUDE: Record<string, string[]> = {
  prose: ['agent:Before I plan this: should the cache be in-process or Redis?'],
  tools: ['thinking', 'tool:Read', 'tool:Grep', 'tool:WebFetch', 'agent:The service factory lives in src/services/AiService.ts. Shall I plan around it?'],
  plan: ['agent:Committing the plan.\n\n{{PLAN}}'],
  subagent: ["agent:I'll explore the cache layer in parallel.", 'subagent', 'agent:That agent returned the answer: should the cache be in-process or Redis?'],
  'stream-reasoning': ['agent:No, 391 is not prime, because 17 × 23 = 391.'],
  'stream-reasoning-followup': ['agent:Yes, 397 is prime, since none of the primes up to 19 (2, 3, 5, 7, 11, 13, 17, 19) divide it evenly.'],
  'stream-resumed': ['agent:ok'],
  'stream-subagent': ['subagent', 'agent:The first line of README.md is `hello`.'],
  'stream-tool-rounds': ["agent:I'll read README.md now.", 'tool:Read', 'agent:The first line of README.md is "hello".'],
  'async-agent': ["agent:I'll explore the dashboard and the data layer.", 'subagent', "agent:I'll report back once they land."],
  'async-agent-report': ['agent:The exploration agent landed: the KPI helpers live in lib/kpis.py, and nothing there segments lost RFQs by item.'],
  'late-tools': ['agent:Should the cache be in-process or Redis?'],
  'broken-plan': ['agent:Here is the plan:\n\n{"tasks": [{"id": "task-1", "title": "Add the thing", "description": "Adds it", "type": "ai", "prompt": "do it",'],
  'task-steer': ['tool:Bash', 'agent:The command completed successfully, much like a perfectly ripe PINEAPPLE.'],
  'task-no-marker': ['agent:Hi! Ready to help you with your project.'],
  'task-marker': ['tool:Bash', 'agent:<<<ORDEWELL_DONE_test-1234>>>'],
  'task-compact': ['compaction', 'system:Compacted'],
  'task-background': [
    "agent:I'll start that background command and wait for it to complete.", 'tool:Bash',
    "agent:Now I'll read the output file to check if the command has completed:", 'tool:Read',
    'agent:The output file is still empty because the 20-second sleep is still running. Let me wait a moment and check again:', 'tool:Read',
    "agent:I'll schedule a wakeup after the background command should complete (20 seconds), then read the output and print FINISHED:", 'tool:ScheduleWakeup',
    'agent:Wakeup scheduled. Waiting for the background command to complete...',
  ],
};

const EXPECTED_CODEX: Record<string, string[]> = {
  deltas: ['thinking', 'agent:Which store?'],
  'two-messages': ['agent:I am reading the pricing module.', 'agent:applyDiscount has no tests. Shall I plan them?'],
  tools: ['thinking', 'tool:shell', 'agent:The factory is in src/services/AiService.ts. Which surface should I start from?'],
  subagent: [
    "agent:I'll delegate the file-reading task to a subagent, then wait for its report.", 'tool:spawnAgent', 'subagent', 'tool:wait',
    'agent:The subagent read the file and found the number 42.',
  ],
  usage: ['agent:I will read the file.', 'tool:shell', 'agent:The answer is 42.'],
  'error-retry': ['agent:Recovered. Which module should I plan for?'],
  plan: ['agent:{{PLAN}}'],
};

const EXPECTED_OPENCODE: Record<string, string[]> = {
  prose: ['thinking', 'tool:glob', 'tool:read', 'agent:math.ts exports a single `add` function (`(a, b) => a + b`).'],
  edit: ['thinking', 'tool:read', 'tool:edit', 'tool:write', 'agent:done'],
  subagent: ['thinking', 'subagent', 'agent:`math.ts` exports a single function `add(a: number, b: number): number`.'],
  'free-model': ['thinking', 'agent:Hello there friend'],
  'cache-write': ['agent:No, 91 is not prime because \\(91 = 7 \\times 13\\).'],
};

describe('every recorded task turn, folded live and reloaded', () => {
  it.each([
    ...Object.keys(EXPECTED_CLAUDE).map(claude),
    ...Object.keys(EXPECTED_CODEX).map(codex),
    ...Object.keys(EXPECTED_OPENCODE).map(opencode),
  ])('%s %s', async (runner, name, expected) => {
    const events = await TURNS[runner](name);
    const log = logOf(events);
    expect(shown(replayTaskLog(log))).toEqual(expected);
    // What the wire carries: coalesced deltas, through JSON as the file saves it.
    expect(shown(replayTaskLog(JSON.parse(JSON.stringify(coalesceTaskLog(log))) as TaskLogEvent[]))).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// The planner path: a recorded stream through CliAgentAiService and a real
// Session, live against the transcript it saves.
// ---------------------------------------------------------------------------

const deps = { resolvePath: async () => '/usr/bin', workspaceRoot: () => '/repo', isDirectory: () => true, exists: () => true, mcpServer: fakeMcpServer() };

function harness(provider: IConfig['aiProvider'], replies: ScriptedReply[]): CliAgentAiService {
  return new CliAgentAiService(fakeConfig({ aiProvider: provider }), {
    ...deps,
    spawn: fakeSpawn(replies).spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    platform: 'linux',
  });
}

function openCodePlanner(name: string): CliAgentAiService {
  const { sessionId, frames, response } = openCodeFixture(name);
  const spawned = fakeSpawn([]);
  const spawn: typeof spawned.spawn = (cmd, argv, opts) => {
    const proc = spawned.spawn(cmd, argv, opts);
    queueMicrotask(() => spawned.processes.at(-1)!.emitStdout('opencode server listening on http://127.0.0.1:44100\n'));
    return proc;
  };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;
    if (url.endsWith('/api/info')) return json({});
    if (url.endsWith('/mcp')) return json({ ordewell: { status: 'connected' } });
    if (url.endsWith('/event')) return sseResponse(init, frames).response;
    if (url.endsWith('/session')) return json({ id: sessionId });
    return new Promise((resolve) => setTimeout(() => resolve(json(response)), 0));
  }) as unknown as typeof fetch;
  return new CliAgentAiService(fakeConfig({ aiProvider: 'opencode', enabledRunners: ['opencode'] }), { ...deps, spawn, fetch: fetchImpl });
}

function timeline(view: ConversationView): string[] {
  return view.blocks.flatMap((b) => {
    if (b.type === 'message') return [`${b.role}: ${b.text}`];
    if (b.type === 'tool') return [`tool: ${b.headline.name}`];
    if (b.type === 'subagent') return ['subagent'];
    return [];
  });
}

async function planWith(planner: CliAgentAiService, goal: string, runner: RunnerId) {
  const sent: SessionMessage[] = [];
  const session = makeSession({
    broadcast: (msg) => { sent.push(msg); vi.advanceTimersByTime(1000); },
    aiService: planner,
    config: fakeConfig({ enabledRunners: [runner] }),
  });
  await session.startPlanning(goal, [runner]);
  const plan = session.planState!;
  return {
    live: timeline(sent.reduce(reduceConversation, EMPTY_CONVERSATION)),
    reloaded: timeline(fromTranscript(plan.conversationHistory, plan.researchLog)),
  };
}

describe('every recorded planner turn, live against its reload', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-18T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['claude-code', 'prose', ['planner: Before I plan this: should the cache be in-process or Redis?']],
    ['claude-code', 'subagent', ["planner: I'll explore the cache layer in parallel.", 'subagent', 'planner: That agent returned the answer: should the cache be in-process or Redis?']],
    ['claude-code', 'stream-subagent', ['subagent', 'planner: The first line of README.md is `hello`.']],
  ] as const)('claude-code %s', async (_runner, name, expected) => {
    const planner = harness('claude-code', [fixture('claude-code', name)]);
    const { live, reloaded } = await planWith(planner, 'look around', 'claude-code');
    expect(reloaded).toEqual(live);
    expect(live.slice(1)).toEqual(expected);
  });

  it('claude-code tools: parallel calls keep their announced order after a reload', async () => {
    const { live, reloaded } = await planWith(harness('claude-code', [fixture('claude-code', 'tools')]), 'look around', 'claude-code');
    expect(live.slice(1, 4)).toEqual(['tool: Read', 'tool: Grep', 'tool: WebFetch']);
    expect(reloaded).toEqual(live);
  });

  it('Codex: words around the command it ran, live and reloaded', async () => {
    const { live, reloaded } = await planWith(harness('codex', [fixture('codex', 'handshake'), fixture('codex', 'new-conversation'), fixture('codex', 'usage')]), 'What is the answer?', 'codex');
    expect(live).toEqual(['user: What is the answer?', 'planner: I will read the file.', expect.stringMatching(/^tool: /), 'planner: The answer is 42.']);
    expect(reloaded).toEqual(live);
  });

  it('OpenCode: words around the tools it ran, live and reloaded', async () => {
    const { live, reloaded } = await planWith(openCodePlanner('prose'), 'What does math.ts export?', 'opencode');
    expect(live).toEqual([
      'user: What does math.ts export?',
      expect.stringMatching(/^tool: /),
      expect.stringMatching(/^tool: /),
      'planner: math.ts exports a single `add` function (`(a, b) => a + b`).',
    ]);
    expect(reloaded).toEqual(live);
  });
});
