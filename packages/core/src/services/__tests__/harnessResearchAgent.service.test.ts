import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { AgentAdapter, AgentEvent, AgentStartOptions, PlannerStartOptions } from '../harness/AgentAdapter';
import { scriptedAdapter, fakeMcpServer } from './harnessTestKit';
import type { ResearchChat } from '../BaseAiService';
import type { ResearchProgress } from '../../models/Task';
import type { UsageRecord } from '../../models/Usage';
import type { OfferedResearchAgent } from '../harness/researchAgentSetting';
import { setEnv } from '../../testEnv';

/** A planner turn that calls spawn_research_agent through its token's handler, as an MCP client would mid-turn. */
const AGENT_ENV = { ORDEWELL_RESEARCH_AGENT_MODEL: 'openrouter:deepseek/deepseek-v4.1-flash', OPENROUTER_API_KEY: 'sk-agent' };

function service(runner: 'opencode' | 'claude-code', { research = true, env = AGENT_ENV, during }: { research?: boolean; env?: Record<string, string>; during?: (reply: { text: string; isError?: boolean }) => void } = {}) {
  const starts: AgentStartOptions[] = [];
  const turn: AgentEvent[] = [{ type: 'assistant_text', runId: 'r1', text: 'Mapped.' }, { type: 'turn_end' }];
  const scripted = scriptedAdapter([turn, turn]);
  const mcp = fakeMcpServer();
  const chats: ReadonlySet<string>[] = [];
  const svc = new CliAgentAiService(fakeConfig({ aiProvider: runner }), {
    createAdapter: (name, deps): AgentAdapter => {
      const adapter = scripted(name, deps)!;
      return {
        ...adapter,
        start: async (opts) => { starts.push(opts); },
        send: async (message, onEvent, signal, onLiveness) => {
          const handler = mcp.plannerHandlers.at(-1)!;
          if (during && handler.spawnResearchAgent) during(await handler.spawnResearchAgent({ prompt: 'map src' }, { signal: new AbortController().signal }));
          return adapter.send(message, onEvent, signal, onLiveness);
        },
      };
    },
    workspaceRoot: () => '/repo',
    // The workspace's own variables (ADR-0016), where `.ordewell/env` names the agent's model.
    workspaceEnv: async () => env,
    mcpServer: mcp,
    ...(research ? {
      researchAgent: (offer: OfferedResearchAgent) => ({
        model: offer.model,
        createChat: (_r: (d: string) => void, onUsage: (u: UsageRecord) => void, only: ReadonlySet<string>): ResearchChat => {
          chats.push(only);
          return {
            sendMessage: async () => { onUsage({ inputTokens: 50, outputTokens: 5 } as UsageRecord); return { text: '', hasToolCalls: true, toolCalls: [{ id: 'c1', name: 'list_dir', args: { path: '.' } }] }; },
            sendToolResults: async () => { onUsage({ inputTokens: 60, outputTokens: 6 } as UsageRecord); return { text: 'src holds a and b', toolCalls: [], hasToolCalls: false }; },
          };
        },
      }),
    } : {}),
  });
  return { svc, starts, mcp, chats };
}

const request = (onProgress: (p: ResearchProgress) => void = () => {}, noSubagents = false, notice?: (level: string, message: string) => void) => ({
  plannerTools: { sessionId: 's1', handler: {}, ...(noSubagents ? { noSubagents: true as const } : {}) },
  goal: 'Map the repo', runners: ['opencode' as const], modelsByRunner: {}, fs: fakeFileSystem(), onProgress,
  ...(notice ? { notice } : {}),
});

// The daemon's own environment must not name an agent for the tests that leave it out.
let restore: () => void = () => {};
beforeEach(() => { restore = setEnv({ ORDEWELL_RESEARCH_AGENT_MODEL: undefined, OPENROUTER_API_KEY: undefined }); });
afterEach(() => restore());

describe('CliAgentAiService serves Ordewell\'s research agent to an OpenCode planner (ADR-0066)', () => {
  it('lists it on the token and names it in the prompt, and its digest returns inside the turn', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const events: ResearchProgress[] = [];
    const { svc, starts, mcp, chats } = service('opencode', { during: (r) => replies.push(r) });
    const turn = await svc.startConversation(request((p) => events.push(p)));
    expect(mcp.plannerScopes.at(-1)).toMatchObject({ research: true });
    expect((starts.at(-1) as PlannerStartOptions).systemPrompt).toContain('Use spawn_research_agent');
    expect(replies).toEqual([{ text: 'src holds a and b' }]);
    expect([...chats[0]].sort()).toEqual(['find_symbol', 'glob', 'grep', 'list_dir', 'read_file', 'read_files']);
    const started = events.find((e) => e.type === 'subagent_started');
    expect(started).toMatchObject({ brief: 'map src', model: 'deepseek/deepseek-v4.1-flash' });
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage.map((u) => u.record?.subagentId)).toEqual([started!.subagentId, started!.subagentId]);
    expect(events.find((e) => e.type === 'subagent_finished')).toMatchObject({ usage: { inputTokens: 110, outputTokens: 11 } });
    // Its step persists with the turn, under its subagent.
    expect(turn.researchLog.some((s) => 'tool' in s && s.subagentId === started!.subagentId && s.tool === 'list_dir')).toBe(true);
  });

  it('refuses a call made between turns', async () => {
    const { svc, mcp } = service('opencode');
    await svc.startConversation(request());
    const reply = await mcp.plannerHandlers.at(-1)!.spawnResearchAgent!({ prompt: 'late' }, { signal: new AbortController().signal });
    expect(reply.isError).toBe(true);
  });

  it('changes nothing, by a byte, when the workspace names no model for it', async () => {
    const without = service('opencode', { research: false });
    const absent = service('opencode', { env: { OPENROUTER_API_KEY: 'sk-agent' } });
    const notices: string[] = [];
    await without.svc.startConversation(request());
    await absent.svc.startConversation(request(() => {}, false, (_l, m) => notices.push(m)));
    expect(absent.starts).toEqual(without.starts);
    expect(absent.mcp.plannerScopes).toEqual(without.mcp.plannerScopes);
    expect(Object.keys(absent.mcp.plannerHandlers.at(-1)!)).toEqual(Object.keys(without.mcp.plannerHandlers.at(-1)!));
    expect(notices).toEqual([]);
  });

  it.each([
    ['its provider has no key', { ORDEWELL_RESEARCH_AGENT_MODEL: 'openrouter:deepseek/deepseek-v4.1-flash' }, 'OPENROUTER_API_KEY'],
    ['it names Gemini', { ORDEWELL_RESEARCH_AGENT_MODEL: 'google:gemini-3-flash', GEMINI_API_KEY: 'k' }, 'Gemini'],
  ])('serves nothing, says why, and keeps research tasks when %s', async (_why, env, named) => {
    const { svc, starts, mcp } = service('opencode', { env });
    const notices: { level: string; message: string }[] = [];
    await svc.startConversation(request(() => {}, false, (level, message) => notices.push({ level, message })));
    expect(mcp.plannerHandlers.at(-1)!.spawnResearchAgent).toBeUndefined();
    const prompt = (starts.at(-1) as PlannerStartOptions).systemPrompt;
    expect(prompt).not.toContain('spawn_research_agent');
    expect(prompt).toContain('research tasks are how you delegate');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: 'warn' });
    expect(notices[0].message).toContain(named);
  });

  it.each([
    ['no API provider is configured for it', 'opencode', false, false],
    ['the session is refused agents (a subplanner without research)', 'opencode', true, true],
    ['the runner has agents of its own', 'claude-code', true, false],
  ] as const)('serves nothing when %s', async (_why, runner, research, noSubagents) => {
    const { svc, starts, mcp } = service(runner, { research });
    await svc.startConversation(request(() => {}, noSubagents));
    expect(mcp.plannerScopes.at(-1)!.research).toBeUndefined();
    expect(mcp.plannerHandlers.at(-1)!.spawnResearchAgent).toBeUndefined();
    expect((starts.at(-1) as PlannerStartOptions).systemPrompt).not.toContain('spawn_research_agent');
  });
});
