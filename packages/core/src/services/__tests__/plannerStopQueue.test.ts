import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer } from '../mcp';
import { PlannerTurnStoppedError } from '../PlannerConversation';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, flushMicrotasks } from '../../testing';
import { FakeRunnerSession, makeSession } from './sessionTestKit';
import { fixture, respondingSpawn, type FakeAgentProcess } from './harnessTestKit';

/**
 * The user's Stop of planner work, at the process and MCP boundaries: the
 * fake `claude` connects to the real Ordewell server over HTTP and calls
 * submit_plan from any turn it is sent, so a queued follow-up the Stop left
 * behind would show up as a second turn on stdin and a spawned task.
 */

const servers: OrdewellMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

async function connectAs(args: string[]): Promise<Client> {
  const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
  const injected = config.mcpServers.ordewell;
  const client = new Client({ name: 'fake-claude', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(injected.url), { requestInit: { headers: injected.headers } }));
  clients.push(client);
  return client;
}

function reply(proc: FakeAgentProcess, text: string): void {
  proc.emitStdout(line({ type: 'system', subtype: 'init', session_id: 'sess-1', permissionMode: 'plan' }));
  proc.emitStdout(line({ type: 'assistant', session_id: 'sess-1', message: { id: `m-${text.length}`, content: [{ type: 'text', text }] } }));
  proc.emitStdout(line({ type: 'result', subtype: 'success', session_id: 'sess-1', is_error: false, result: text }));
}

const task = {
  id: 'db', order: 1, title: 'Set up the database', description: 'Postgres schema', type: 'ai', prompt: 'set up postgres',
  dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code',
  assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4' },
};

/**
 * A Claude Code planner that holds every user turn whose text matches `hold`
 * until it is interrupted, acknowledging the interrupt as the CLI does. It
 * asks a question back to the goal, and answers the first message after it by
 * submitting a one-task plan — which autorun starts — and the rest in prose.
 */
function fakeClaude(hold: RegExp) {
  const turns: string[] = [];
  let live: { proc: FakeAgentProcess } | null = null;
  let submitted = false;
  const spawned = respondingSpawn((written, proc, args) => {
    const msg = JSON.parse(written) as { type: string; request_id?: string; request?: { subtype?: string }; message?: { content: { text: string }[] } };
    if (msg.type === 'control_request' && msg.request?.subtype === 'mcp_status') {
      proc.emitStdout(line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mcpServers: [{ name: 'ordewell', status: 'connected' }] } } }));
      return;
    }
    if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
      if (live?.proc === proc) live = null;
      proc.emitStdout(fixture('claude-code', 'task-interrupt-ack', { REQUEST_ID: msg.request_id ?? '' }));
      return;
    }
    if (msg.type !== 'user') return;
    const text = msg.message?.content.map((c) => c.text).join('\n') ?? '';
    turns.push(text);
    if (hold.test(text)) {
      live = { proc };
      return;
    }
    if (turns.length === 1) {
      reply(proc, 'Which database?');
      return;
    }
    void (async () => {
      if (!submitted) {
        submitted = true;
        await (await connectAs(args)).callTool({ name: 'submit_plan', arguments: { tasks: [task] } });
      }
      reply(proc, text.includes('Use Postgres') ? 'Continued after Stop.' : 'Planned it.');
    })();
  });
  return { spawned, turns, isLive: () => live !== null };
}

/** Detected Claude Code, autorun on, supervisor off: a submitted plan starts at once. */
function stopSession(hold: RegExp) {
  const claude = fakeClaude(hold);
  const server = new OrdewellMcpServer();
  servers.push(server);
  const ai = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
    spawn: claude.spawned.spawn,
    resolvePath: async () => '/usr/bin',
    workspaceRoot: () => '/repo',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    mcpServer: server,
  });
  const runner = {
    spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => new FakeRunnerSession('s1', taskId)),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const session = makeSession({
    config: fakeConfig({ aiProvider: 'claude-code' }),
    aiService: ai,
    mcpServer: server,
    runner,
    modelResolver: { modelsForRunners: vi.fn(async () => ({ 'claude-code': [{ modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4', variants: [] }] })) },
    settings: () => ({ enabledRunners: ['claude-code'], run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', autorun: true } }),
  });
  return { session, claude, runner };
}

const transcript = (env: ReturnType<typeof stopSession>) => (env.session.planState?.conversationHistory ?? []).map((m) => m.content).join('\n');

async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => { if (!check()) throw new Error('not yet'); });
}

describe('the user\'s Stop of planner work', () => {
  it('cancels a follow-up queued behind a live opening: no second turn, no task, nothing continued in the transcript', async () => {
    const env = stopSession(/Build inventory/);
    const opening = env.session.startPlanning('Build inventory', ['claude-code']);
    void opening.catch(() => {});
    await until(env.claude.isLive);

    const followUp = env.session.continueConversation('Use Postgres');
    await flushMicrotasks();
    // The goal waits too, saved as it was sent, until its opening lands it.
    expect(env.session.planState?.pendingTurns?.map((t) => t.text)).toEqual(['Build inventory', 'Use Postgres']);

    expect(env.session.abortPlannerTurn()).toBe(true);
    await expect(followUp).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    await Promise.allSettled([opening]);
    await flushMicrotasks(100);

    expect(env.claude.turns).toHaveLength(1);
    expect(env.runner.spawn).not.toHaveBeenCalled();
    expect(env.session.planState?.pendingTurns ?? []).toEqual([]);
    expect(transcript(env)).not.toContain('Use Postgres');
    expect(transcript(env)).not.toContain('Continued after Stop');
  });

  it('cancels a follow-up queued behind a later live reply, the same way', async () => {
    const env = stopSession(/Use MySQL/);
    await env.session.startPlanning('Build inventory', ['claude-code']);
    const live = env.session.continueConversation('Use MySQL');
    void live.catch(() => {});
    await until(env.claude.isLive);

    const followUp = env.session.continueConversation('Use Postgres');
    await flushMicrotasks();
    expect(env.session.planState?.pendingTurns?.map((t) => t.text)).toContain('Use Postgres');

    expect(env.session.abortPlannerTurn()).toBe(true);
    await expect(followUp).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    await Promise.allSettled([live]);
    await flushMicrotasks(100);

    expect(env.claude.turns.filter((t) => t.includes('Use Postgres'))).toEqual([]);
    expect(env.claude.turns).toHaveLength(2);
    expect(env.runner.spawn).not.toHaveBeenCalled();
    expect(env.session.planState?.pendingTurns ?? []).toEqual([]);
    expect(transcript(env)).not.toContain('Use Postgres');
    expect(transcript(env)).not.toContain('Continued after Stop');
  });

  it('is not a force send: that stops the live turn and keeps what waits, which goes after the forced message', async () => {
    const env = stopSession(/Use MySQL/);
    await env.session.startPlanning('Build inventory', ['claude-code']);
    const live = env.session.continueConversation('Use MySQL');
    void live.catch(() => {});
    await until(env.claude.isLive);
    const queued = env.session.continueConversation('Use Postgres');
    await flushMicrotasks();

    await env.session.forceSendPrompt('Use SQLite now');
    await queued;

    const after = env.claude.turns.slice(2);
    expect(after).toHaveLength(2);
    expect(after[0]).toContain('Use SQLite now');
    expect(after[1]).toContain('Use Postgres');
    expect(transcript(env)).toContain('Continued after Stop');
  });

  it('answers a message sent after the Stop, once, without what the Stop cancelled', async () => {
    const env = stopSession(/Build inventory/);
    const opening = env.session.startPlanning('Build inventory', ['claude-code']);
    void opening.catch(() => {});
    await until(env.claude.isLive);
    const followUp = env.session.continueConversation('Use Postgres');
    void followUp.catch(() => {});
    await flushMicrotasks();
    env.session.abortPlannerTurn();
    await Promise.allSettled([opening, followUp]);

    await env.session.continueConversation('Use SQLite');
    await flushMicrotasks(100);

    expect(env.claude.turns).toHaveLength(2);
    expect(env.claude.turns[1]).toContain('Use SQLite');
    expect(env.claude.turns[1]).not.toContain('Use Postgres');
    expect(env.runner.spawn).toHaveBeenCalledTimes(1);
  });
});
