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
import { fakeConfig, makeSession } from './sessionTestKit';

/**
 * The opt-in live check for the OpenCode planner's Ordewell tools (ADR-0022):
 * the real `opencode serve` on its `plan` agent, the real server, a real
 * Session.
 *
 *   ORDEWELL_LIVE_AGENTS=opencode npx vitest run --root packages/core plannerToolsOpenCodeLive
 *
 * The planner runs on a cheap model at its lowest variant unless
 * ORDEWELL_LIVE_MODEL says otherwise, in which case the variant is the
 * model's own default.
 *
 * Not part of the suite: it costs real tokens and a minute or two.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('opencode');
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'opencode-go/deepseek-v4.1-flash';

const CATALOG: Record<string, DiscoveredModel[]> = {
  opencode: [{ modelId: model, modelLabel: 'Live model', variants: [] }],
  'claude-code': [{ modelId: 'claude-haiku-4-5-20251001', modelLabel: 'Haiku', variants: [] }],
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const undo of cleanup.splice(0).reverse()) await undo(); });

describe.runIf(live)('OpenCode planner tools — live', () => {
  it('reads a runner enabled mid-conversation and commits a plan on it through submit_plan (#69)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-planner-tools-oc-'));
    cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
    const server = new OrdewellMcpServer();
    cleanup.push(() => server.dispose());
    const config = fakeConfig({ aiProvider: 'opencode', orchestratorModel: model, plannerThinkingEffort: process.env.ORDEWELL_LIVE_MODEL ? undefined : 'low' });
    const ai = new CliAgentAiService(config, { spawn, workspaceRoot: () => workspace, mcpServer: server });
    cleanup.push(() => ai.reset());

    let settings: SessionRuntimeSettings = { enabledRunners: ['opencode'] };
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
      ['opencode'],
    );
    expect(ai.plannerToolsAttached()).toBe(true);
    expect(session.planTasks).toEqual([]);

    settings = { ...settings, enabledRunners: ['opencode', 'claude-code'] };
    await session.continueConversation(
      'I just enabled claude-code. Skip the outline: submit the plan now, exactly two AFK ai tasks — '
      + 'the script on claude-code, and the test on opencode, depending on the script.',
    );

    console.log('planner tool calls:', toolCalls.join(', '));
    console.log('committed:', JSON.stringify(session.planTasks.map((t) => [t.title, t.assignedRunner, t.assignedModel?.modelId, t.taskMode])));
    expect(toolCalls).toEqual(expect.arrayContaining([expect.stringContaining('list_runners'), expect.stringContaining('submit_plan')]));
    expect(session.planTasks.map((t) => t.assignedRunner).sort()).toEqual(['claude-code', 'opencode']);
    expect([...(session.planState?.runners ?? [])].sort()).toEqual(['claude-code', 'opencode']);
  }, 600_000);
});
