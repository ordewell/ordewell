import { describe, it, expect } from 'vitest';
import { EMPTY_TASK_LOG, reduceTaskLog, replayTaskLog } from '../taskLog';
import type { TaskLogEvent } from '../../models/TaskLog';
import type { StoredHandoff } from '../../models/Handoff';
import type { SubagentBlock, ToolBlock } from '../blocks';
import { unkeyed } from './helpers';

const start: TaskLogEvent = { type: 'turn_start', message: 'Do the task' };

describe('reduceTaskLog', () => {
  it('stops an unfinished runner command on exit without inventing a turn result', () => {
    const view = replayTaskLog([
      { type: 'command', name: 'compact' },
      { type: 'runner_ended' },
    ]);
    expect(view.working).toBe(false);
    expect(view.lastTurnEnd).toBeUndefined();
    expect(view.blocks).toMatchObject([{ type: 'command', status: 'stopped' }]);
  });

  it('opens a turn with the message it delivers', () => {
    const view = replayTaskLog([start]);
    expect(view.working).toBe(true);
    expect(unkeyed(view.blocks)).toEqual([{ type: 'message', role: 'user', text: 'Do the task', streaming: false }]);
  });

  it('knows when its open turn began, and forgets it once the turn is over (#81)', () => {
    const at = '2026-10-30T10:00:00.000Z';
    const open = replayTaskLog([{ ...start, startedAt: at }, { type: 'text_delta', text: 'Hel' }]);
    expect(open.turnStartedAt).toBe(at);
    expect(replayTaskLog([{ ...start, startedAt: at }, { type: 'turn_end', reason: 'completed' }]).turnStartedAt).toBeUndefined();
    expect(replayTaskLog([{ ...start, startedAt: at }, { type: 'runner_ended' }]).turnStartedAt).toBeUndefined();
  });

  it('dates a turn a runner command opened the same way (#81)', () => {
    const at = '2026-10-30T10:00:00.000Z';
    expect(replayTaskLog([{ type: 'command', name: 'compact', startedAt: at }]).turnStartedAt).toBe(at);
  });

  it('has no start time for a turn saved before they were kept, nor for the next one after it (#81)', () => {
    const at = '2026-10-30T10:00:00.000Z';
    expect(replayTaskLog([start]).turnStartedAt).toBeUndefined();
    const second = replayTaskLog([{ ...start, startedAt: at }, { type: 'turn_end', reason: 'completed' }, start]);
    expect(second.working).toBe(true);
    expect(second.turnStartedAt).toBeUndefined();
  });

  it('shows a message Ordewell sent as Ordewell\'s, not the user\'s, wherever the runner read it', () => {
    const opened = replayTaskLog([start, { type: 'turn_end', reason: 'completed' }, { type: 'turn_start', message: 'Call task_complete.', from: 'ordewell' }]);
    expect(unkeyed(opened.blocks).at(-1)).toEqual({ type: 'message', role: 'system', text: 'Ordewell: Call task_complete.', streaming: false });

    const read = replayTaskLog([
      start,
      { type: 'message_queued', messageId: 'msg-1', text: 'Call task_complete.', from: 'ordewell' },
      { type: 'message_delivered', messageId: 'msg-1', text: 'Call task_complete.', from: 'ordewell' },
    ]);
    expect(unkeyed(read.blocks).at(-1)).toEqual({ type: 'message', role: 'system', text: 'Ordewell: Call task_complete.', streaming: false });
  });

  it('opens a turn the runner started itself without inventing a user message', () => {
    const view = replayTaskLog([{ type: 'turn_start', message: '' }, { type: 'text', text: 'FINISHED' }]);
    expect(view.working).toBe(true);
    expect(unkeyed(view.blocks)).toEqual([{ type: 'message', role: 'agent', text: 'FINISHED', streaming: false }]);
  });

  it('streams the agent’s text and lets the whole block replace it', () => {
    const streaming = replayTaskLog([start, { type: 'text_delta', text: 'Look' }, { type: 'text_delta', text: 'ing' }]);
    expect(unkeyed(streaming.blocks).at(-1)).toEqual({ type: 'message', role: 'agent', text: 'Looking', streaming: true });

    const settled = replayTaskLog([{ type: 'text', text: 'Looking around.' }], streaming);
    expect(unkeyed(settled.blocks)).toEqual([
      { type: 'message', role: 'user', text: 'Do the task', streaming: false },
      { type: 'message', role: 'agent', text: 'Looking around.', streaming: false },
    ]);
  });

  it('replaces a run whose block was already sealed by a later call, rather than repeating it', () => {
    const view = replayTaskLog([
      start,
      { type: 'text_delta', text: 'Checking' },
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' },
      { type: 'text', text: 'Checking the tree.' },
    ]);
    expect(view.blocks.filter((b) => b.type === 'message' && b.role === 'agent')).toHaveLength(1);
    expect(view.blocks[1]).toMatchObject({ type: 'message', text: 'Checking the tree.', streaming: false });
  });

  describe('runs of text by their id', () => {
    const agentTexts = (view: ReturnType<typeof replayTaskLog>) => view.blocks.flatMap((b) => (b.type === 'message' && b.role === 'agent' ? [b.text] : []));

    // The note a followed model switch writes lands whenever its plan
    // write-back settles, which can be in the middle of a run.
    it('keeps a run in one block when a note lands in the middle of it, and settles it there', () => {
      const view = replayTaskLog([
        start,
        { type: 'text_delta', runId: 'r1', text: 'Looking' },
        { type: 'model_switched', from: { model: 'haiku' }, to: { model: 'sonnet' }, plan: { model: { model: 'sonnet' } } },
        { type: 'text_delta', runId: 'r1', text: ' around' },
        { type: 'text', runId: 'r1', text: 'Looking around.' },
      ]);
      expect(view.blocks.map((b) => (b.type === 'message' ? `${b.role}:${b.text}${b.streaming ? '…' : ''}` : b.type))).toEqual([
        'user:Do the task', 'agent:Looking around.', 'system:Model changed in the runner: haiku → sonnet; the plan now says sonnet',
      ]);
    });

    // Codex reports a setup problem as thinking, whenever it notices one.
    it('keeps a run in one block across a runner warning shown as thinking', () => {
      const view = replayTaskLog([
        start,
        { type: 'text_delta', runId: 'item_m1', text: 'Checking' },
        { type: 'thinking', text: 'Codex configuration warning: unknown key' },
        { type: 'text_delta', runId: 'item_m1', text: ' the tree' },
        { type: 'text', runId: 'item_m1', text: 'Checking the tree.' },
      ]);
      expect(agentTexts(view)).toEqual(['Checking the tree.']);
      expect(view.blocks.map((b) => b.type)).toEqual(['message', 'message', 'thinking']);
    });

    it('never crosses two runs that stream before the first completes', () => {
      const view = replayTaskLog([
        start,
        { type: 'text_delta', runId: 'a', text: 'First ' },
        { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' },
        { type: 'text_delta', runId: 'b', text: 'Second ' },
        { type: 'text_delta', runId: 'a', text: 'run.' },
        { type: 'text', runId: 'a', text: 'First run.' },
        { type: 'text_delta', runId: 'b', text: 'run.' },
        { type: 'text', runId: 'b', text: 'Second run.' },
      ]);
      expect(view.blocks.map((b) => (b.type === 'message' ? b.text : b.type))).toEqual(['Do the task', 'First run.', 'tool', 'Second run.']);
    });

    it('shows a run that never streamed whole, where its copy arrives', () => {
      const view = replayTaskLog([start, { type: 'text', runId: 'a', text: 'First.' }, { type: 'text', runId: 'b', text: 'Second.' }]);
      expect(agentTexts(view)).toEqual(['First.', 'Second.']);
    });
  });

  // Saved before runs carried an id: one stream for every run, and each run
  // after the first opening with the paragraph break that joined it.
  it('replays a log saved before runs carried an id: a later text block of the turn is its own block, without its paragraph break', () => {
    const view = replayTaskLog([
      start,
      { type: 'text', text: 'First.' },
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' },
      { type: 'text_delta', text: '\n\n' },
      { type: 'text_delta', text: 'Second.' },
      { type: 'text', text: '\n\nSecond.' },
    ]);
    const agent = view.blocks.filter((b) => b.type === 'message' && b.role === 'agent');
    expect(agent.map((b) => b.type === 'message' && b.text)).toEqual(['First.', 'Second.']);
  });

  it('folds thinking deltas into one block that the whole thought replaces', () => {
    const view = replayTaskLog([
      start,
      { type: 'thinking_delta', text: 'Hmm, ' },
      { type: 'thinking_delta', text: 'the tests.' },
      { type: 'thinking', text: 'Hmm, the tests.' },
      { type: 'text', text: 'Running them.' },
    ]);
    expect(unkeyed(view.blocks).slice(1)).toEqual([
      { type: 'thinking', text: 'Hmm, the tests.', streaming: false },
      { type: 'message', role: 'agent', text: 'Running them.', streaming: false },
    ]);
  });

  it('shows a tool call with its arguments and settles it with its output', () => {
    const view = replayTaskLog([
      start,
      { type: 'tool_call', id: 'c1', name: 'Read', args: '{"file_path":"src/a.ts"}' },
      { type: 'tool_call', id: 'c2', name: 'Bash', args: '{"command":"npm test"}' },
      { type: 'tool_result', id: 'c2', output: 'FAIL\n1 failed', success: false },
      { type: 'tool_result', id: 'c1', output: 'export const a = 1;', success: true },
    ]);
    const tools = view.blocks.filter((b): b is ToolBlock => b.type === 'tool');
    expect(tools.map((t) => [t.headline.name, t.headline.keyArg, t.status, t.output, t.outputLineCount])).toEqual([
      ['Read', 'src/a.ts', 'ok', 'export const a = 1;', 1],
      ['Bash', 'npm test', 'error', 'FAIL\n1 failed', 2],
    ]);
    expect(tools[0].args).toBe('{"file_path":"src/a.ts"}');
  });

  it('counts the lines a file edit added and removed, whichever runner named the edit', () => {
    const hunk = '@@ -1,3 +1,3 @@\n export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n';
    const view = replayTaskLog([
      start,
      { type: 'tool_call', id: 'c1', name: 'Update', args: '{"path":"src/sum.ts"}' },
      { type: 'tool_result', id: 'c1', output: hunk, success: true },
      { type: 'tool_call', id: 'c2', name: 'Write', args: '{"file_path":"/repo/hello.txt"}' },
      { type: 'tool_result', id: 'c2', output: '+hi\n+there\n', success: true },
      { type: 'tool_call', id: 'c3', name: 'edit', args: '{"filePath":"/repo/b.ts"}' },
      { type: 'tool_result', id: 'c3', output: '-gone\n', success: true },
    ]);
    const tools = view.blocks.filter((b): b is ToolBlock => b.type === 'tool');
    expect(tools.map((t) => t.diff)).toEqual([{ added: 1, removed: 1 }, { added: 2, removed: 0 }, { added: 0, removed: 1 }]);
  });

  it('counts nothing for an edit that reported prose, failed, or a command that printed a diff', () => {
    const view = replayTaskLog([
      start,
      { type: 'tool_call', id: 'c1', name: 'Edit', args: '{"file_path":"/repo/a.ts"}' },
      { type: 'tool_result', id: 'c1', output: 'The file /repo/a.ts has been updated successfully.', success: true },
      { type: 'tool_call', id: 'c2', name: 'Update', args: '{"path":"a.ts"}' },
      { type: 'tool_result', id: 'c2', output: '-a\n+b\n', success: false },
      { type: 'tool_call', id: 'c3', name: 'Bash', args: '{"command":"git diff"}' },
      { type: 'tool_result', id: 'c3', output: '-a\n+b\n', success: true },
    ]);
    const tools = view.blocks.filter((b): b is ToolBlock => b.type === 'tool');
    expect(tools.map((t) => t.diff)).toEqual([undefined, undefined, undefined]);
  });

  it('nests a subagent’s calls and thinking under the call that started it', () => {
    const view = replayTaskLog([
      start,
      { type: 'tool_call', id: 'agent-1', name: 'Agent', args: '{"description":"Read the README","prompt":"…"}' },
      { type: 'subagent_started', subagentId: 'agent-1', brief: 'Read the README', model: 'haiku' },
      { type: 'thinking', text: 'Opening it.', subagentId: 'agent-1' },
      { type: 'tool_call', id: 'r1', name: 'Read', args: '{"file_path":"README.md"}', subagentId: 'agent-1' },
      { type: 'tool_result', id: 'r1', output: 'hello', success: true, subagentId: 'agent-1' },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 100, subagentId: 'agent-1' } },
      { type: 'subagent_finished', subagentId: 'agent-1', outcome: 'done', digest: 'It says hello.' },
      { type: 'tool_result', id: 'agent-1', output: 'It says hello.', success: true },
    ]);
    const subagents = view.blocks.filter((b): b is SubagentBlock => b.type === 'subagent');
    expect(subagents).toHaveLength(1);
    const [agent] = subagents;
    expect(agent).toMatchObject({ subagentId: 'agent-1', toolCallId: 'agent-1', brief: 'Read the README', model: 'haiku', status: 'done', digest: 'It says hello.', usage: { inputTokens: 100 } });
    expect(agent.children.map((c) => c.type)).toEqual(['thinking', 'tool']);
    expect(agent.children[1]).toMatchObject({ type: 'tool', headline: { name: 'Read', keyArg: 'README.md' }, status: 'ok', output: 'hello' });
    expect(view.blocks.some((b) => b.type === 'tool')).toBe(false);
  });

  it('keeps one usage line, last, over everything the runner reported', () => {
    const view = replayTaskLog([
      start,
      { type: 'usage', record: { source: 'claude-code', inputTokens: 1000, outputTokens: 50, contextWindow: 200_000 } },
      { type: 'text', text: 'Done.' },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 1200, outputTokens: 20, reportedCost: { amount: 0.01, currency: 'USD' } } },
    ]);
    const last = view.blocks.at(-1);
    expect(view.blocks.filter((b) => b.type === 'usage')).toHaveLength(1);
    expect(last).toMatchObject({
      type: 'usage',
      totals: { inputTokens: 2200, outputTokens: 70, reportedCost: { USD: 0.01 } },
      contextFill: { usedTokens: 1200, windowTokens: 200_000 },
    });
  });

  it('meters what a compaction left, or nothing until the next call, and counts the compaction in no total', () => {
    const before = [start, { type: 'usage' as const, record: { source: 'claude-code', model: 'opus', inputTokens: 24_000, outputTokens: 939, contextTokens: 24_939, contextWindow: 200_000, reportedCost: { amount: 0.5, currency: 'USD' } } }];
    const reported = replayTaskLog([...before, { type: 'usage', record: { source: 'claude-code', compacted: true, contextTokens: 3615 } }]);
    expect(reported.blocks.at(-1)).toMatchObject({ type: 'usage', totals: { inputTokens: 24_000, outputTokens: 939, reportedCost: { USD: 0.5 } }, contextFill: { usedTokens: 3615, windowTokens: 200_000 } });

    const unreported = replayTaskLog([...before, { type: 'usage', record: { source: 'claude-code', compacted: true } }]);
    expect(unreported.blocks.at(-1)).toMatchObject({ type: 'usage', totals: { inputTokens: 24_000 } });
    expect(unreported.blocks.at(-1)).not.toHaveProperty('contextFill');
  });

  it('carries the used tokens without a window while the runner reports none', () => {
    const view = replayTaskLog([start, { type: 'usage', record: { source: 'codex', inputTokens: 1000 } }]);
    expect(view.blocks.at(-1)).toMatchObject({ type: 'usage', contextFill: { usedTokens: 1000 } });
    expect(view.blocks.at(-1)).not.toHaveProperty('contextFill.windowTokens');
  });

  it('draws no usage line for a report of nothing', () => {
    const view = replayTaskLog([start, { type: 'usage', record: { source: 'claude-code' } }]);
    expect(view.blocks.some((b) => b.type === 'usage')).toBe(false);
  });

  it('closes an interrupted turn: calls left unanswered and running subagents say they were cut short', () => {
    const view = replayTaskLog([
      start,
      { type: 'text_delta', text: 'Working' },
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"sleep 100"}' },
      { type: 'subagent_started', subagentId: 'sa', brief: 'Look around' },
      { type: 'turn_end', reason: 'interrupted' },
    ]);
    expect(view.working).toBe(false);
    expect(view.lastTurnEnd).toBe('interrupted');
    expect(view.blocks.find((b) => b.type === 'tool')).toMatchObject({ status: 'interrupted' });
    expect(view.blocks.find((b) => b.type === 'subagent')).toMatchObject({ status: 'stopped' });
    expect(view.blocks.some((b) => (b.type === 'message' || b.type === 'thinking') && b.streaming)).toBe(false);
    expect(view.blocks.at(-1)).toMatchObject({ type: 'message', role: 'system', text: 'Interrupted.' });
  });

  it('ends a normal turn with nothing streaming and nothing marked as cut', () => {
    const view = replayTaskLog([start, { type: 'text_delta', text: 'Done' }, { type: 'turn_end', reason: 'completed' }]);
    expect(view.lastTurnEnd).toBe('completed');
    expect(view.blocks.at(-1)).toMatchObject({ role: 'agent', text: 'Done', streaming: false });
  });

  it('shows a failed turn’s own words', () => {
    const view = replayTaskLog([start, { type: 'error', message: 'Claude Code ended the turn: error_max_turns' }, { type: 'turn_end', reason: 'failed' }]);
    expect(view.blocks.at(-1)).toMatchObject({ type: 'message', role: 'error', text: 'Claude Code ended the turn: error_max_turns' });
  });

  describe('a usage limit the runner says twice (#79)', () => {
    const limit = "You've hit your session limit · resets 8:10pm (Europe/Rome)";
    const agentTexts = (view: ReturnType<typeof replayTaskLog>) => view.blocks.filter((b) => b.type === 'message' && b.role === 'agent');
    const failure = { type: 'message', role: 'error', text: `${limit}.`, streaming: false };

    it('shows the limit once, as the error', () => {
      const view = replayTaskLog([start, { type: 'text', text: limit }, { type: 'error', message: `${limit}.` }, { type: 'turn_end', reason: 'failed' }]);
      expect(unkeyed(view.blocks)).toEqual([{ type: 'message', role: 'user', text: 'Do the task', streaming: false }, failure]);
    });

    it('takes back a streamed copy of it too', () => {
      const view = replayTaskLog([
        start,
        { type: 'text_delta', text: limit.slice(0, 20) },
        { type: 'text_delta', text: limit.slice(20) },
        { type: 'text', text: limit },
        { type: 'error', message: `${limit}.` },
      ]);
      expect(agentTexts(view)).toHaveLength(0);
      expect(unkeyed(view.blocks).at(-1)).toEqual(failure);
      expect(view.streams).toEqual({});
    });

    it('takes back a streamed copy that never got its whole block', () => {
      const view = replayTaskLog([start, { type: 'text_delta', text: limit }, { type: 'error', message: `${limit}.` }]);
      expect(agentTexts(view)).toHaveLength(0);
      expect(unkeyed(view.blocks).at(-1)).toEqual(failure);
    });

    it('keeps a real reply that came before it, beside the error', () => {
      const view = replayTaskLog([
        start,
        { type: 'text', text: 'The cache belongs in src/cache.ts.' },
        { type: 'text', text: `\n\n${limit}` },
        { type: 'error', message: `${limit}.` },
      ]);
      expect(unkeyed(view.blocks).slice(1)).toEqual([
        { type: 'message', role: 'agent', text: 'The cache belongs in src/cache.ts.', streaming: false },
        failure,
      ]);
    });

    it('keeps text that only mentions the error', () => {
      const view = replayTaskLog([start, { type: 'text', text: `I stopped early: ${limit}` }, { type: 'error', message: limit }]);
      expect(unkeyed(view.blocks).slice(1)).toEqual([
        { type: 'message', role: 'agent', text: `I stopped early: ${limit}`, streaming: false },
        { type: 'message', role: 'error', text: limit, streaming: false },
      ]);
    });

    it('only looks at the latest text block of the turn', () => {
      const view = replayTaskLog([
        start,
        { type: 'text', text: limit },
        { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' },
        { type: 'text', text: 'Listing done.' },
        { type: 'error', message: limit },
      ]);
      expect(agentTexts(view).map((b) => b.type === 'message' && b.text)).toEqual([limit, 'Listing done.']);
    });

    it('leaves an earlier turn’s text alone', () => {
      const view = replayTaskLog([
        start,
        { type: 'text', text: limit },
        { type: 'turn_end', reason: 'completed' },
        { type: 'turn_start', message: 'Go on' },
        { type: 'error', message: limit },
      ]);
      expect(agentTexts(view).map((b) => b.type === 'message' && b.text)).toEqual([limit]);
    });

    it('gives a stored log the same view, whole or resumed part way', () => {
      const events: TaskLogEvent[] = [start, { type: 'text', text: limit }, { type: 'error', message: `${limit}.` }, { type: 'turn_end', reason: 'failed' }];
      const stored = JSON.parse(JSON.stringify(events)) as TaskLogEvent[];
      const expected = unkeyed(replayTaskLog(events).blocks);
      expect(unkeyed(replayTaskLog(stored).blocks)).toEqual(expected);
      expect(unkeyed(replayTaskLog(stored.slice(2), replayTaskLog(stored.slice(0, 2))).blocks)).toEqual(expected);
      expect(expected.filter((b) => b.type === 'message' && b.role !== 'user')).toEqual([failure]);
    });
  });

  it('holds queued messages beside the blocks until a turn delivers them, and lets one be taken back', () => {
    const queued = replayTaskLog([
      start,
      { type: 'message_queued', messageId: 'msg-1', text: 'also add tests' },
      { type: 'message_queued', messageId: 'msg-2', text: 'and docs' },
    ]);
    expect(queued.queued).toEqual([{ id: 'msg-1', text: 'also add tests' }, { id: 'msg-2', text: 'and docs' }]);

    const removed = reduceTaskLog(queued, { type: 'message_removed', messageId: 'msg-2' });
    expect(removed.queued).toEqual([{ id: 'msg-1', text: 'also add tests' }]);

    const delivered = replayTaskLog([
      { type: 'turn_end', reason: 'completed' },
      { type: 'turn_start', message: 'also add tests', messageId: 'msg-1' },
    ], removed);
    expect(delivered.queued).toEqual([]);
    expect(delivered.working).toBe(true);
    expect(delivered.blocks.at(-1)).toMatchObject({ type: 'message', role: 'user', text: 'also add tests' });
  });

  it('puts a runner\'s tool request after the call it is for, and settles it with the answer', () => {
    const call: TaskLogEvent = { type: 'tool_call', id: 'toolu_1', name: 'Bash', args: '{"command":"npm test"}' };
    const asked = replayTaskLog([
      start, call,
      { type: 'approval_requested', approvalId: 'ap-1', tool: 'Bash', args: '{"command":"npm test"}', allowForTask: true, toolCallId: 'toolu_1' },
    ]);
    expect(unkeyed(asked.blocks).slice(1)).toEqual([
      expect.objectContaining({ type: 'tool', toolCallId: 'toolu_1', status: 'pending' }),
      { type: 'approval', approvalId: 'ap-1', kind: 'runner_tool', subject: 'Bash(npm test)', scope: 'Bash', status: 'pending', allowForTask: true, toolCallId: 'toolu_1' },
    ]);

    const allowed = replayTaskLog([{ type: 'approval_decided', approvalId: 'ap-1', decision: 'allowForTask' }], asked);
    expect(allowed.blocks.find((b) => b.type === 'approval')).toMatchObject({ status: 'granted', decidedBy: 'asked', forTask: true });
    expect(allowed.blocks[1]).toBe(asked.blocks[1]);
  });

  it('settles a denial with its note, and a withdrawn request as withdrawn', () => {
    const ask = (approvalId: string): TaskLogEvent => ({ type: 'approval_requested', approvalId, tool: 'Write', args: '{"file_path":"/repo/a.txt"}', allowForTask: false });
    const view = replayTaskLog([
      start, ask('ap-1'), ask('ap-2'),
      { type: 'approval_decided', approvalId: 'ap-1', decision: 'deny', note: 'use notes/' },
      { type: 'approval_withdrawn', approvalId: 'ap-2' },
    ]);
    const approvals = view.blocks.filter((b) => b.type === 'approval');
    expect(approvals).toEqual([
      expect.objectContaining({ approvalId: 'ap-1', subject: 'Write(/repo/a.txt)', status: 'denied', note: 'use notes/' }),
      expect.objectContaining({ approvalId: 'ap-2', status: 'withdrawn' }),
    ]);
    expect(approvals[0]).not.toHaveProperty('forTask');
  });

  it('shows a request that was never left open as settled, not waiting', () => {
    const view = replayTaskLog([
      start,
      { type: 'approval_requested', approvalId: 'ap-1', tool: 'mcp__ordewell__task_complete', args: '{}', allowForTask: false, decided: 'allow' },
    ]);
    expect(view.blocks.find((b) => b.type === 'approval')).toMatchObject({ status: 'granted', decidedBy: 'asked' });
  });

  it('takes the first answer to a request and ignores a repeated request', () => {
    const asked = replayTaskLog([start, { type: 'approval_requested', approvalId: 'ap-1', tool: 'Bash', args: '{}', allowForTask: false }]);
    const decided = replayTaskLog([{ type: 'approval_decided', approvalId: 'ap-1', decision: 'allow' }], asked);
    expect(reduceTaskLog(decided, { type: 'approval_withdrawn', approvalId: 'ap-1' })).toBe(decided);
    expect(reduceTaskLog(decided, { type: 'approval_requested', approvalId: 'ap-1', tool: 'Bash', args: '{}', allowForTask: false })).toBe(decided);
  });

  it('returns the view itself for an event that changes nothing, including one it does not know', () => {
    const view = replayTaskLog([start]);
    expect(reduceTaskLog(view, { type: 'message_removed', messageId: 'nope' })).toBe(view);
    const later = JSON.parse('{"type":"runner_approval","id":"x"}') as TaskLogEvent;
    expect(reduceTaskLog(view, later)).toBe(view);
  });

  it('keeps the identity of blocks an event does not touch', () => {
    const view = replayTaskLog([start, { type: 'text_delta', text: 'a' }]);
    const next = reduceTaskLog(view, { type: 'text_delta', text: 'b' });
    expect(next.blocks[0]).toBe(view.blocks[0]);
  });

  it('starts from nothing', () => {
    expect(EMPTY_TASK_LOG).toMatchObject({ blocks: [], queued: [], working: false });
  });

  describe('the handoff an attempt ended with (ADR-0047)', () => {
    const handoff: StoredHandoff = {
      summary: 'Added the route.',
      findings: [
        {
          id: 'F1', severity: 'blocker', title: 'Missing auth', detail: 'Add a guard.',
          evidence: [{ kind: 'file', path: 'src/route.ts', line: 12 }, { kind: 'commit', sha: 'abc123' }],
        },
        {
          id: 'F2', severity: 'minor', title: 'Rename x',
          evidence: [{ kind: 'task', task: 't2', finding: 'F1' }, { kind: 'url', url: 'https://example.com/pr/1' }],
        },
      ],
      findingCount: 2,
      artifacts: [{ kind: 'file', path: 'src/route.ts' }],
      report: 'The full story.',
    };

    it('shows the whole handoff, before the usage line and after the turn', () => {
      const view = replayTaskLog([
        start,
        { type: 'turn_end', reason: 'completed' },
        { type: 'usage', record: { source: 'claude-code', inputTokens: 10 } },
        { type: 'handoff', handoff },
      ]);

      expect(view.blocks.map((b) => b.type)).toEqual(['message', 'handoff', 'usage']);
      expect(unkeyed(view.blocks)[1]).toEqual({ type: 'handoff', handoff });
    });

    it('draws a user task\'s log, which is its handoff alone', () => {
      const view = replayTaskLog([{ type: 'handoff', handoff }]);
      expect(unkeyed(view.blocks)).toEqual([{ type: 'handoff', handoff }]);
      expect(view.working).toBe(false);
    });

    it('folds the same handoff once when the live stream repeats what the reload already held', () => {
      const view = replayTaskLog([start, { type: 'handoff', handoff }]);
      const copy = JSON.parse(JSON.stringify({ type: 'handoff', handoff })) as TaskLogEvent;

      expect(reduceTaskLog(view, copy)).toBe(view);
      expect(replayTaskLog([start, { type: 'handoff', handoff }, start, { type: 'handoff', handoff }]).blocks
        .filter((b) => b.type === 'handoff')).toHaveLength(1);
    });

    it('replaces a restated handoff in place rather than adding a second block', () => {
      const view = replayTaskLog([start, { type: 'handoff', handoff }]);
      const restated = { ...handoff, summary: 'Added the route and the guard.' };

      const next = reduceTaskLog(view, { type: 'handoff', handoff: restated });

      expect(next.blocks.filter((b) => b.type === 'handoff')).toHaveLength(1);
      expect(next.blocks.find((b) => b.type === 'handoff')).toMatchObject({ handoff: restated });
    });
  });
});

describe('reduceTaskLog with messages read mid-turn (ADR-0023)', () => {
  const handedOver = replayTaskLog([
    start,
    { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"sleep 20"}' },
    { type: 'message_queued', messageId: 'msg-1', text: 'use Postgres' },
    { type: 'message_queued', messageId: 'msg-2', text: 'and docs' },
    { type: 'message_handed_over', messageId: 'msg-1' },
  ]);

  it('marks the message the runner has, leaving the rest queued', () => {
    expect(handedOver.queued).toEqual([{ id: 'msg-1', text: 'use Postgres', handedOver: true }, { id: 'msg-2', text: 'and docs' }]);
    expect(reduceTaskLog(handedOver, { type: 'message_handed_over', messageId: 'msg-1' })).toBe(handedOver);
    expect(reduceTaskLog(handedOver, { type: 'message_handed_over', messageId: 'nope' })).toBe(handedOver);
  });

  it('shows the message in the transcript where the runner read it, between the steps around it, and drops it from the queue', () => {
    const view = replayTaskLog([
      { type: 'text_delta', text: 'Waiting on the sleep' },
      { type: 'tool_result', id: 'c1', output: '', success: true },
      { type: 'message_delivered', messageId: 'msg-1', text: 'use Postgres' },
      { type: 'text_delta', text: 'Switching.' },
    ], handedOver);

    expect(view.queued).toEqual([{ id: 'msg-2', text: 'and docs' }]);
    expect(view.working).toBe(true);
    const shown = view.blocks.map((b) => (b.type === 'message' ? `${b.role}:${b.text}${b.streaming ? '…' : ''}` : b.type));
    expect(shown).toEqual(['user:Do the task', 'tool', 'agent:Waiting on the sleep', 'user:use Postgres', 'agent:Switching.…']);
  });

  it('puts a message the runner let go of back in the queue, removable again', () => {
    const requeued = reduceTaskLog(handedOver, { type: 'message_queued', messageId: 'msg-1', text: 'use Postgres' });
    expect(requeued.queued).toEqual([{ id: 'msg-1', text: 'use Postgres' }, { id: 'msg-2', text: 'and docs' }]);
    expect(reduceTaskLog(requeued, { type: 'message_queued', messageId: 'msg-1', text: 'use Postgres' })).toBe(requeued);
  });
});

describe('reduceTaskLog with force send (ADR-0023, F1–F2)', () => {
  it('keeps the sent-now mark on a delivered forced message when the log is replayed', () => {
    const view = replayTaskLog([
      start,
      { type: 'turn_end', reason: 'interrupted' },
      { type: 'turn_start', message: 'Stop waiting', messageId: 'forced-1', forced: true },
    ]);

    expect(view.blocks).toContainEqual(expect.objectContaining({
      type: 'message', role: 'user', text: 'Stop waiting', forced: true,
    }));
  });

  const queued = replayTaskLog([
    start,
    { type: 'message_queued', messageId: 'msg-1', text: 'use Postgres' },
    { type: 'message_queued', messageId: 'msg-2', text: 'and docs' },
    { type: 'message_handed_over', messageId: 'msg-1' },
  ]);

  it('lists a forced message ahead of the rest, behind an earlier forced one', () => {
    const view = replayTaskLog([
      { type: 'message_queued', messageId: 'msg-3', text: 'stop now', forced: true },
      { type: 'message_queued', messageId: 'msg-4', text: 'and now', forced: true },
    ], queued);
    expect(view.queued.map((m) => m.id)).toEqual(['msg-3', 'msg-4', 'msg-1', 'msg-2']);
    expect(view.queued[0]).toEqual({ id: 'msg-3', text: 'stop now', forced: true });
  });

  it('moves a handed-over message forward when it is force sent, still handed over, and keeps it forced if the runner lets go of it', () => {
    const promoted = replayTaskLog([
      { type: 'message_queued', messageId: 'msg-3', text: 'stop now', forced: true },
      { type: 'message_queued', messageId: 'msg-1', text: 'use Postgres', forced: true },
    ], queued);
    expect(promoted.queued).toEqual([
      { id: 'msg-3', text: 'stop now', forced: true },
      { id: 'msg-1', text: 'use Postgres', forced: true, handedOver: true },
      { id: 'msg-2', text: 'and docs' },
    ]);

    const requeued = reduceTaskLog(promoted, { type: 'message_queued', messageId: 'msg-1', text: 'use Postgres' });
    expect(requeued.queued.map((m) => m.id)).toEqual(['msg-3', 'msg-1', 'msg-2']);
    expect(requeued.queued[1]).toEqual({ id: 'msg-1', text: 'use Postgres', forced: true });
  });

  it('moves a queued message forward when it is force sent, and the turn it opens takes it off the queue', () => {
    const promoted = reduceTaskLog(queued, { type: 'message_queued', messageId: 'msg-2', text: 'and docs', forced: true });
    expect(promoted.queued).toEqual([{ id: 'msg-2', text: 'and docs', forced: true }, { id: 'msg-1', text: 'use Postgres', handedOver: true }]);

    const view = replayTaskLog([
      { type: 'turn_end', reason: 'interrupted' },
      { type: 'turn_start', message: 'and docs', messageId: 'msg-2', forced: true },
    ], promoted);
    expect(view.queued).toEqual([{ id: 'msg-1', text: 'use Postgres', handedOver: true }]);
    expect(view.working).toBe(true);
    const shown = view.blocks.map((b) => (b.type === 'message' ? `${b.role}:${b.text}` : b.type));
    expect(shown.slice(-2)).toEqual(['system:Interrupted.', 'user:and docs']);
  });
});

describe('reduceTaskLog with the runner\'s own commands (#66)', () => {
  it('opens a turn with the command it runs, settled by how the turn ends, with what it printed', () => {
    const view = replayTaskLog([
      start, { type: 'turn_end', reason: 'completed' },
      { type: 'message_queued', messageId: 'msg-2', text: '/compact keep the API notes' },
      { type: 'command', name: 'compact', args: 'keep the API notes', messageId: 'msg-2' },
    ]);
    expect(view.working).toBe(true);
    expect(view.queued).toEqual([]);
    expect(unkeyed(view.blocks).at(-1)).toEqual({ type: 'command', name: 'compact', args: 'keep the API notes', status: 'running', output: '' });

    const settled = replayTaskLog([
      { type: 'compaction', trigger: 'manual', preTokens: 24939, postTokens: 3615 },
      { type: 'command_output', text: 'Compacted' },
      { type: 'turn_end', reason: 'completed' },
    ], view);
    expect(unkeyed(settled.blocks).slice(-2)).toEqual([
      { type: 'command', name: 'compact', args: 'keep the API notes', status: 'done', output: 'Compacted' },
      { type: 'compaction', trigger: 'manual', preTokens: 24939, postTokens: 3615 },
    ]);
  });

  it('marks a command whose turn failed or was interrupted', () => {
    const failed = replayTaskLog([{ type: 'command', name: 'pingskill' }, { type: 'turn_end', reason: 'failed' }]);
    expect(unkeyed(failed.blocks)[0]).toMatchObject({ type: 'command', status: 'failed' });
    const stopped = replayTaskLog([{ type: 'command', name: 'pingskill' }, { type: 'turn_end', reason: 'interrupted' }]);
    expect(unkeyed(stopped.blocks)[0]).toMatchObject({ type: 'command', status: 'stopped' });
  });

  it('marks a compaction the runner did on its own mid-turn, among the turn\'s steps', () => {
    const view = replayTaskLog([start, { type: 'text', text: 'Reading.' }, { type: 'compaction', trigger: 'auto' }]);
    expect(unkeyed(view.blocks).at(-1)).toEqual({ type: 'compaction', trigger: 'auto' });
  });

  it('says where a model switch made in the runner leaves the plan (#106)', () => {
    const haiku = { model: 'haiku', label: 'Haiku 5.5' };
    const sonnet = { model: 'sonnet', label: 'Sonnet 5.5' };
    const view = replayTaskLog([start, { type: 'model_switched', from: haiku, to: sonnet, plan: { model: { model: 'sonnet', label: 'Claude Sonnet 5.5' }, effort: 'high' } }]);
    expect(unkeyed(view.blocks).at(-1)).toEqual({
      type: 'message', role: 'system', text: 'Model changed in the runner: Haiku 5.5 → Sonnet 5.5; the plan now says Claude Sonnet 5.5, high', streaming: false,
    });
    const unlabelled = replayTaskLog([start, { type: 'model_switched', from: { model: 'haiku' }, to: { model: 'claude-opus-4-7' }, plan: { model: { model: 'claude-opus-4-7' } } }]);
    expect(unkeyed(unlabelled.blocks).at(-1)).toMatchObject({ text: 'Model changed in the runner: haiku → claude-opus-4-7; the plan now says claude-opus-4-7' });
  });

  it('says the plan kept its model when it did not follow, and why', () => {
    const kept = replayTaskLog([start, {
      type: 'model_switched', from: { model: 'haiku', label: 'Haiku 5.5' }, to: { model: 'sonnet', label: 'Sonnet 5.5' },
      plan: { model: { model: 'haiku', label: 'Claude Haiku 5.5' } }, kept: 'no model command in the chat asked for it',
    }]);
    expect(unkeyed(kept.blocks).at(-1)).toMatchObject({
      text: 'The runner now answers on Sonnet 5.5; the plan still says Claude Haiku 5.5 (no model command in the chat asked for it)',
    });
    const unplanned = replayTaskLog([start, { type: 'model_switched', from: { model: 'haiku' }, to: { model: 'sonnet' }, plan: {}, kept: 'its attempt had already ended' }]);
    expect(unkeyed(unplanned.blocks).at(-1)).toMatchObject({
      text: 'The runner now answers on sonnet; the plan names no model (its attempt had already ended)',
    });
  });

  it('replays a model switch saved before the plan\'s side was recorded, claiming nothing of the plan', () => {
    const saved = JSON.parse('{"type":"model_switched","from":{"model":"sonnet"},"to":{"model":"opus"},"effort":"high"}') as TaskLogEvent;
    const view = replayTaskLog([start, saved]);
    expect(unkeyed(view.blocks).at(-1)).toMatchObject({ text: 'Model changed in the runner: sonnet → opus' });
  });

  it('shows what the runner loaded as one block', () => {
    const commands = [{ name: 'pingskill', description: 'Reply', kind: 'skill' as const }];
    const view = replayTaskLog([start, { type: 'runner_loaded', commands, mcpServers: [{ name: 'docs-server', status: 'pending' }] }]);
    expect(unkeyed(view.blocks).at(-1)).toEqual({ type: 'runner_loaded', commands, mcpServers: [{ name: 'docs-server', status: 'pending' }] });
  });
});
