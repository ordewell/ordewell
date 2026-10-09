import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createTask, type ResearchProgress, type ResearchStep } from '../../models/Task';
import type { ConversationRequest, ConversationTurn } from '../../services/AiService';
import type { SessionMessage } from '../../services/SessionMessage';
import { makeSession } from '../../services/__tests__/sessionTestKit';
import { fromTranscript } from '../transcript';
import type { DisplayBlock } from '../blocks';
import { play, unkeyed } from './helpers';

/**
 * Reload parity (#51): a session reopened from disk shows what its live view
 * showed, for everything the session saves. The live side is the real Session's
 * broadcast, recorded while a backend faked at the `IAiService` seam runs two
 * turns; the reload side is the plan that same Session saved.
 */

/** What a session saves: no reasoning, no text that never settled, no approvals, and no turn ids. */
function savedSubset(blocks: readonly DisplayBlock[]): unknown[] {
  const kept = blocks.flatMap((block): DisplayBlock[] => {
    if (block.type === 'thinking' || block.type === 'approval') return [];
    if (block.type === 'message' && block.segmentId !== undefined) return [];
    if (block.type === 'subagent') return [{ ...block, children: block.children.filter((c) => c.type === 'tool') }];
    return [block];
  });
  const turnless = <T extends object>({ turnId: _turnId, ...rest }: T & { turnId?: string }) => rest;
  return unkeyed(kept).map((block) => (block.type === 'subagent' ? { ...turnless(block), children: block.children.map(turnless) } : turnless(block)));
}

let clock = Date.parse('2026-09-27T10:00:00.000Z');
const tick = () => { clock += 1000; vi.setSystemTime(clock); };
const at = () => new Date().toISOString();

function researchStep(fields: Omit<ResearchStep, 'id' | 'timestamp' | 'success'>): ResearchStep {
  return { id: `rs-${fields.toolCallId}`, success: fields.outcome === 'success', timestamp: at(), ...fields };
}

function firstTurn(p: (progress: ResearchProgress) => void): ConversationTurn {
  tick(); p({ type: 'thinking', text: 'Reading the layout' });
  tick(); p({ type: 'text_delta', segmentId: 's1', text: 'Let me look ' });
  p({ type: 'text_delta', segmentId: 's1', text: 'around.' });
  tick(); p({ type: 'tool_call', tool: 'read_file', toolArgs: '{"path":"package.json"}', toolCallId: 'c1' });
  tick(); const read = researchStep({ tool: 'read_file', args: '{"path":"package.json"}', result: '{\n  "name": "app"\n}\n', outcome: 'success', toolCallId: 'c1' });
  p({ type: 'tool_result', toolResult: read.result, step: read, toolCallId: 'c1' });
  tick(); p({ type: 'tool_call', tool: 'spawn_research_agent', toolArgs: '{"prompt":"Survey storage\\n"}', subagentId: 'sa-1', toolCallId: 'c2' });
  p({ type: 'subagent_started', subagentId: 'sa-1', brief: 'Survey storage', model: 'gpt-5-mini' });
  tick(); p({ type: 'thinking', text: 'Scanning for a database', subagentId: 'sa-1' });
  tick(); p({ type: 'tool_call', tool: 'grep', toolArgs: '{"pattern":"sqlite|pg"}', subagentId: 'sa-1', toolCallId: 'c3' });
  tick(); const grep = researchStep({ tool: 'grep', args: '{"pattern":"sqlite|pg"}', result: 'No matches', outcome: 'success', toolCallId: 'c3', subagentId: 'sa-1' });
  p({ type: 'tool_result', toolResult: grep.result, step: grep, toolCallId: 'c3', subagentId: 'sa-1' });
  tick(); p({ type: 'usage', subagentId: 'sa-1', record: { source: 'openai', model: 'gpt-5-mini', inputTokens: 400, outputTokens: 40, subagentId: 'sa-1' } });
  tick(); p({ type: 'subagent_finished', subagentId: 'sa-1', outcome: 'done', digest: 'Storage: none yet', usage: { inputTokens: 400, outputTokens: 40 } });
  tick(); const spawn = researchStep({ tool: 'spawn_research_agent', args: '{"prompt":"Survey storage\\n"}', result: 'Storage: none yet', outcome: 'success', toolCallId: 'c2' });
  p({ type: 'tool_result', toolResult: spawn.result, step: spawn, toolCallId: 'c2', subagentId: 'sa-1' });
  tick(); p({ type: 'usage', record: { source: 'openai', model: 'gpt-5', inputTokens: 3000, outputTokens: 200, contextWindow: 128000 } });
  tick(); p({ type: 'text_delta', segmentId: 's2', text: 'Which store: ' });
  p({ type: 'text_delta', segmentId: 's2', text: 'SQLite or Postgres?' });
  tick();
  return { kind: 'message', text: 'Which store: SQLite or Postgres?', researchLog: [read, spawn] };
}

function secondTurn(p: (progress: ResearchProgress) => void): ConversationTurn {
  tick(); p({ type: 'tool_call', tool: 'bash', toolArgs: '{"command":"rm -rf data"}', toolCallId: 'c4' });
  tick(); const refused = researchStep({ tool: 'bash', args: '{"command":"rm -rf data"}', result: 'Command refused: rm deletes files', outcome: 'refused', toolCallId: 'c4' });
  p({ type: 'tool_result', toolResult: refused.result, step: refused, toolCallId: 'c4' });
  const json = '{"tasks": [{"title": "Add the SQLite store"}, {"title": "Migrate"}]}';
  tick(); p({ type: 'text_delta', segmentId: 's3', text: json.slice(0, 20) });
  p({ type: 'text_delta', segmentId: 's3', text: json.slice(20) });
  tick(); p({ type: 'usage', record: { source: 'openai', model: 'gpt-5', inputTokens: 5000, outputTokens: 300, contextWindow: 128000 } });
  tick();
  return { kind: 'plan', tasks: [createTask({ title: 'Add the SQLite store' }), createTask({ title: 'Migrate' })], text: json, researchLog: [refused] };
}

/** A harness planner's turn (ADR-0009): its subagent is its `Agent` call, and its log holds every step. */
function harnessTurn(p: (progress: ResearchProgress) => void): ConversationTurn {
  const agentArgs = '{"description":"Map the TUI","prompt":"Read tui/ and report"}';
  tick(); p({ type: 'tool_call', tool: 'agent_tool', toolLabel: 'Agent', toolArgs: agentArgs, toolCallId: 'toolu_1' });
  p({ type: 'subagent_started', subagentId: 'toolu_1', brief: 'Map the TUI' });
  tick(); p({ type: 'tool_call', tool: 'glob', toolLabel: 'Glob', toolArgs: '{"pattern":"tui/*.ts"}', toolCallId: 'toolu_2', subagentId: 'toolu_1' });
  tick(); p({ type: 'tool_call', tool: 'read_file', toolLabel: 'Read', toolArgs: '{"path":"README.md"}', toolCallId: 'toolu_3' });
  tick(); const readme = researchStep({ tool: 'read_file', toolLabel: 'Read', args: '{"path":"README.md"}', result: '# App', outcome: 'success', toolCallId: 'toolu_3' });
  p({ type: 'tool_result', toolResult: readme.result, step: readme, toolCallId: 'toolu_3' });
  tick(); const glob = researchStep({ tool: 'glob', toolLabel: 'Glob', args: '{"pattern":"tui/*.ts"}', result: 'tui/state.ts\ntui/render.ts', outcome: 'success', toolCallId: 'toolu_2', subagentId: 'toolu_1' });
  p({ type: 'tool_result', toolResult: glob.result, step: glob, toolCallId: 'toolu_2', subagentId: 'toolu_1' });
  tick(); p({ type: 'subagent_finished', subagentId: 'toolu_1', outcome: 'done', digest: 'Two files: state and render' });
  const agent = researchStep({ tool: 'agent_tool', toolLabel: 'Agent', args: agentArgs, result: 'Two files: state and render', outcome: 'success', toolCallId: 'toolu_1' });
  p({ type: 'tool_result', toolResult: agent.result, step: agent, toolCallId: 'toolu_1' });
  tick(); p({ type: 'text_delta', segmentId: 's1', text: 'The TUI is two files.' });
  tick();
  return { kind: 'message', text: 'The TUI is two files.', researchLog: [readme, glob, agent] };
}

describe('fromTranscript after a live session', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
  });
  afterEach(() => vi.useRealTimers());

  it('rebuilds the same blocks the live view showed, for everything the session saved', async () => {
    const sent: SessionMessage[] = [];
    const session = makeSession({
      broadcast: (msg) => sent.push(msg),
      aiService: {
        startConversation: vi.fn(async (req: ConversationRequest) => firstTurn(req.onProgress)),
        continueConversation: vi.fn(async (_message: string, onProgress: (progress: ResearchProgress) => void) => secondTurn(onProgress)),
        hasActiveConversation: () => true,
      },
    });

    await session.startPlanning('add persistence', ['claude-code']);
    tick();
    const plan = await session.continueConversation('use SQLite');

    const live = play(sent);
    const reloaded = fromTranscript(plan.conversationHistory, plan.researchLog, plan.plannerUsage);

    expect(unkeyed(reloaded.blocks).map((b) => (b.type === 'message' ? `${b.type}:${b.role}` : b.type))).toEqual([
      'message:user', 'tool', 'subagent', 'message:planner', 'message:user', 'tool', 'plan', 'usage',
    ]);
    expect(unkeyed(reloaded.blocks)).toEqual(savedSubset(live.blocks));
  });

  it('does the same for a harness planner\'s subagent, whose steps its own log also carries', async () => {
    const sent: SessionMessage[] = [];
    const session = makeSession({
      broadcast: (msg) => sent.push(msg),
      aiService: {
        startConversation: vi.fn(async (req: ConversationRequest) => harnessTurn(req.onProgress)),
        hasActiveConversation: () => true,
      },
    });

    const plan = await session.startPlanning('map the tui', ['claude-code']);

    const reloaded = fromTranscript(plan.conversationHistory, plan.researchLog, plan.plannerUsage);
    expect(unkeyed(reloaded.blocks).map((b) => (b.type === 'subagent' ? `subagent:${b.children.length}` : b.type))).toEqual([
      'message', 'subagent:1', 'tool', 'message',
    ]);
    expect(unkeyed(reloaded.blocks)).toEqual(savedSubset(play(sent).blocks));
  });

  it('shows a message that loaded skills as typed, each load right under it, live and reloaded alike', async () => {
    const sent: SessionMessage[] = [];
    const bodies: Record<string, string> = { grilling: 'GRILL', 'to-spec': 'SPEC' };
    const session = makeSession({
      broadcast: (msg) => sent.push(msg),
      skillsService: {
        findSkill: (name) => (bodies[name]
          ? { name, description: '', metadata: { name, description: '' }, content: bodies[name], path: `/skills/${name}/SKILL.md`, source: 'global', appliesTo: 'planner', modelInvocable: true, userInvocable: true }
          : undefined),
      },
      aiService: {
        startConversation: vi.fn(async (req: ConversationRequest) => firstTurn(req.onProgress)),
        continueConversation: vi.fn(async (_message: string, onProgress: (progress: ResearchProgress) => void) => secondTurn(onProgress)),
        hasActiveConversation: () => true,
      },
    });

    await session.startPlanning('/grilling add persistence', ['claude-code']);
    tick();
    const plan = await session.continueConversation('use SQLite, /to-spec and /grilling');

    const live = play(sent);
    const reloaded = fromTranscript(plan.conversationHistory, plan.researchLog, plan.plannerUsage);
    const shape = (b: DisplayBlock) => (b.type === 'message' ? `${b.role}:${b.text}:${(b.skills ?? []).join(',')}` : b.type === 'skill_load' ? `load:${b.name}` : b.type);
    expect(reloaded.blocks.map(shape)).toEqual([
      'user:/grilling add persistence:grilling', 'load:grilling', 'tool', 'subagent', 'planner:Which store: SQLite or Postgres?:',
      'user:use SQLite, /to-spec and /grilling:to-spec,grilling', 'load:to-spec', 'load:grilling', 'tool', 'plan', 'usage',
    ]);
    expect(unkeyed(reloaded.blocks)).toEqual(savedSubset(live.blocks));
  });
});
