import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { AgentAdapter, AgentEvent, AgentStartOptions } from '../harness/AgentAdapter';
import { planJson, scriptedAdapter, fakeMcpServer } from './harnessTestKit';
import type { SubmitPlanArgs } from '../mcp/tools';

/**
 * The planner's read-only boundary (ADR-0008/0009) survives the task-mode
 * start switch (ADR-0018, C1): every way `CliAgentAiService` starts an agent
 * asks for a planner, and the service has no way to spell anything else.
 */

const planTurn: AgentEvent[] = [{ type: 'assistant_text', text: planJson() }, { type: 'turn_end' }];

/** `submits`: every turn calls submit_plan with the plan first, as a one-shot must for its plan to count. */
function recordingService(turns: AgentEvent[][], { submits = false } = {}) {
  const starts: AgentStartOptions[] = [];
  const scripted = scriptedAdapter(turns);
  const mcp = fakeMcpServer();
  const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
    createAdapter: (runner, deps): AgentAdapter => {
      const adapter = scripted(runner, deps)!;
      return {
        ...adapter,
        start: async (opts) => { starts.push(opts); },
        send: async (message, onEvent, signal, onLiveness) => {
          if (submits) await mcp.plannerHandlers.at(-1)!.submitPlan!(JSON.parse(planJson()) as SubmitPlanArgs, { signal: new AbortController().signal });
          return adapter.send(message, onEvent, signal, onLiveness);
        },
      };
    },
    workspaceRoot: () => '/repo',
    mcpServer: mcp,
  });
  return { svc, starts };
}

describe('CliAgentAiService start boundary', () => {
  it('starts a planner for a conversation, and again when it resumes a dead one', async () => {
    const { svc, starts } = recordingService([
      [{ type: 'assistant_text', text: 'Which cache?' }, { type: 'turn_end' }],
      [{ type: 'error', message: 'claude exited' }],
      [{ type: 'assistant_text', text: 'Redis it is.' }, { type: 'turn_end' }],
    ]);
    await svc.startConversation({ plannerTools: { sessionId: 's1', handler: {} }, goal: 'Add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {} });
    await svc.continueConversation('Redis', () => {});
    await svc.continueConversation('Go on', () => {});
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.map((s) => s.kind)).toEqual(starts.map(() => 'planner'));
  });

  it('starts a planner for every one-shot path', async () => {
    const { svc, starts } = recordingService([planTurn, planTurn], { submits: true });
    await svc.researchAndPlan('Add a cache', ['claude-code'], {}, fakeFileSystem(), () => {});
    await svc.sendPlanningPrompt('Plan a cache', ['claude-code']);
    expect(starts).toHaveLength(2);
    expect(starts.map((s) => s.kind)).toEqual(['planner', 'planner']);
  });

  it('has no way to name a task start in its source', () => {
    const source = readFileSync(join(__dirname, '..', 'harness', 'CliAgentAiService.ts'), 'utf8');
    expect(source).not.toMatch(/kind:\s*['"]task['"]/);
    expect(source).not.toMatch(/TaskStartOptions|createTaskAdapter|TaskModeAgentAdapter/);
    expect(source).toMatch(/private async startAdapter\(opts: PlannerStartOptions[,)]/);
  });
});
