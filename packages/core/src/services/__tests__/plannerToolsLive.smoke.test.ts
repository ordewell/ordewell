import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer } from '../mcp';
import type { SessionRuntimeSettings } from '../createSession';
import type { DiscoveredModel } from '../../models/Task';
import type { SessionMessage } from '../SessionMessage';
import { createTask } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { FakeRunnerSession, fakeConfig, makeSession } from './sessionTestKit';

/**
 * The opt-in live check for the Claude Code planner's Ordewell tools
 * (ADR-0022): the real CLI in planner mode, the real server, a real Session.
 *
 *   ORDEWELL_LIVE_AGENTS=claude-code npx vitest run --root packages/core plannerToolsLive
 *   ORDEWELL_LIVE_AGENTS=codex       npx vitest run --root packages/core plannerToolsLive
 *
 * Codex's planner needs a working sandbox, which a host that restricts user
 * namespaces does not have. ORDEWELL_LIVE_CODEX_NO_SANDBOX=1 answers Codex's
 * sandbox probe as if it passed, so the tool calls — which the sandbox does
 * not touch — can still be checked there; the planner then cannot read the
 * workspace, which this case never asks of it.
 *
 * The planner runs on the cheapest model — Haiku for Claude Code,
 * `gpt-5.6-luna` for Codex — unless ORDEWELL_LIVE_MODEL says otherwise, which
 * applies to both, so set it only with one runner. The catalog offers the same
 * models, so a committed plan never names a dearer one.
 *
 * Not part of the suite: it costs real tokens and a minute or two.
 */

const liveAgents = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim());
const live = liveAgents.includes('claude-code');
const liveCodex = liveAgents.includes('codex');
// A full id, not the `haiku` alias: under `--permission-mode plan` the alias
// has run Sonnet, and a task may still spawn in that mode.
const claudeModel = process.env.ORDEWELL_LIVE_MODEL ?? 'claude-haiku-4-5-20251001';
const codexModel = process.env.ORDEWELL_LIVE_MODEL ?? 'gpt-5.6-luna';

const CATALOG: Record<string, DiscoveredModel[]> = {
  'claude-code': [{ modelId: claudeModel, modelLabel: 'Live model', variants: [] }],
  codex: [{ modelId: codexModel, modelLabel: 'Live model', variants: [{ id: 'low', label: 'Low' }] }],
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const undo of cleanup.splice(0).reverse()) await undo(); });

/** Codex's `sandbox` probe, answered as passing: see the header. */
const spawnWithoutSandboxProbe: typeof spawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => (
  args[0] === 'sandbox' ? spawn('/bin/true', [], options) : spawn(command, args, options)
)) as typeof spawn;

/** A runner enabled mid-conversation is on the plan `submit_plan` commits (#69), with the planner on `provider`. */
async function submitsThroughTools(provider: 'claude-code' | 'codex', model: string, spawnFn: typeof spawn): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'ordewell-planner-tools-'));
  cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
  const server = new OrdewellMcpServer();
  cleanup.push(() => server.dispose());
  const config = fakeConfig({ aiProvider: provider, orchestratorModel: model, plannerThinkingEffort: provider === 'codex' && !process.env.ORDEWELL_LIVE_MODEL ? 'low' : undefined });
  const ai = new CliAgentAiService(config, { spawn: spawnFn, workspaceRoot: () => workspace, mcpServer: server });
  cleanup.push(() => ai.reset());

  const other = provider === 'claude-code' ? 'codex' : 'claude-code';
  let settings: SessionRuntimeSettings = { enabledRunners: [provider] };
  const toolCalls: string[] = [];
  const broadcast = vi.fn((msg: SessionMessage) => {
    if (msg.type === 'research_step' && msg.toolLabel) toolCalls.push(msg.toolLabel);
  });
  const session = makeSession({
    config,
    aiService: ai,
    mcpServer: server,
    workspaceRoot: () => workspace,
    modelResolver: { modelsForRunners: vi.fn(async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, CATALOG[r] ?? []]))) },
    settings: () => settings,
    broadcast,
  });

  await session.startPlanning(
    'This is a test of the planning tools, in an empty directory: do not explore it. '
    + 'Goal: add a hello-world script and a test for it. Ask me which runners to use, and stop there.',
    [provider],
  );
  expect(ai.plannerToolsAttached()).toBe(true);
  expect(session.planTasks).toEqual([]);

  settings = { ...settings, enabledRunners: [provider, other] };
  await session.continueConversation(
    `I just enabled ${other}. Skip the outline: submit the plan now, exactly two AFK ai tasks — `
    + `the script on ${other}, and the test on ${provider}, depending on the script.`,
  );

  console.log('planner tool calls:', toolCalls.join(', '));
  console.log('committed:', JSON.stringify(session.planTasks.map((t) => [t.title, t.assignedRunner, t.assignedModel?.modelId, t.taskMode])));
  expect(toolCalls).toEqual(expect.arrayContaining(['mcp__ordewell__list_runners', 'mcp__ordewell__submit_plan']));
  expect(session.planTasks.map((t) => t.assignedRunner).sort()).toEqual([provider, other].sort());
  expect(session.planState?.runners?.slice().sort()).toEqual([provider, other].sort());
}

describe.runIf(live)('Claude Code planner tools — live', () => {
  it('reads a runner enabled mid-conversation and commits a plan on it through submit_plan (#69)', async () => {
    await submitsThroughTools('claude-code', claudeModel, spawn);
  }, 600_000);

  /** A real planner, a real Session and a plan of two tasks, `a` running behind `sessions[0]`. */
  async function plannedRun() {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-planner-tools-'));
    cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
    const server = new OrdewellMcpServer();
    cleanup.push(() => server.dispose());
    const config = fakeConfig({ aiProvider: 'claude-code', orchestratorModel: claudeModel });
    const ai = new CliAgentAiService(config, { spawn, workspaceRoot: () => workspace, mcpServer: server });
    cleanup.push(() => ai.reset());

    const toolCalls: string[] = [];
    const sessions: FakeRunnerSession[] = [];
    const runner = {
      spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
        const session = new FakeRunnerSession(`s-${taskId}`, taskId);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as IRunner;
    const session = makeSession({
      config,
      aiService: ai,
      mcpServer: server,
      runner,
      workspaceRoot: () => workspace,
      modelResolver: { modelsForRunners: vi.fn(async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, CATALOG[r] ?? []]))) },
      settings: () => ({ enabledRunners: ['claude-code'] }),
      broadcast: (msg: SessionMessage) => {
        if (msg.type === 'research_step' && msg.toolLabel) toolCalls.push(msg.toolLabel);
      },
    });
    const task = (id: string, order: number, title: string, dependencies: string[] = []) => createTask({
      id, order, title, prompt: `do ${title}`, dependencies, assignedRunner: 'claude-code', assignedModel: { modelId: claudeModel, modelLabel: 'Live model' },
    });
    session.loadPlan({
      tasks: [task('a', 1, 'Write the greeting script'), task('b', 2, 'Test the greeting script', ['a'])],
      generatedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      conversationHistory: [{ role: 'user', content: 'Greeting script and a test', timestamp: new Date().toISOString() }],
    }, 'Greeting script and a test', workspace, { persist: false });
    return { session, sessions, toolCalls };
  }

  const lastReply = (session: ReturnType<typeof makeSession>) => session.planState?.conversationHistory?.at(-1)?.content ?? '';

  it('edits a task that is not running through edit_plan, while another runs', async () => {
    const { session, sessions, toolCalls } = await plannedRun();
    await session.executePlan();
    expect(sessions).toHaveLength(1);

    await session.continueConversation(
      'Do not explore anything. Task 2 should be titled "Test the greeting script with bats". Make that edit now.',
    );

    console.log('planner tool calls:', toolCalls.join(', '));
    console.log('titles:', JSON.stringify(session.planTasks.map((t) => t.title)), 'reply:', lastReply(session));
    expect(toolCalls).toContain('mcp__ordewell__edit_plan');
    expect(session.planTasks.map((t) => t.title)).toEqual(['Write the greeting script', 'Test the greeting script with bats']);
  }, 600_000);

  it('reads the live output of a running task through task_output', async () => {
    const { session, sessions, toolCalls } = await plannedRun();
    await session.executePlan();
    sessions[0].emitOutput('$ bash greet.sh\nhello from the runner\nbuild marker: sentinel-7391\n');

    await session.continueConversation(
      'Do not explore anything and do not change the plan. Read the latest output of task 1 and tell me, quoting it, what its last line says.',
    );

    console.log('planner tool calls:', toolCalls.join(', '));
    console.log('reply:', lastReply(session));
    expect(toolCalls).toContain('mcp__ordewell__task_output');
    expect(lastReply(session)).toContain('sentinel-7391');
  }, 600_000);
});

describe.runIf(liveCodex)('Codex planner tools — live', () => {
  it('reads a runner enabled mid-conversation and commits a plan on it through submit_plan (#69)', async () => {
    await submitsThroughTools('codex', codexModel, process.env.ORDEWELL_LIVE_CODEX_NO_SANDBOX ? spawnWithoutSandboxProbe : spawn);
  }, 600_000);
});
