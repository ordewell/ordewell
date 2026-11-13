import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '../harness/AgentAdapter';
import { endTurn, newTurn, reduceUpdate, type AcpTurn } from '../harness/acpEvents';
import { parseSessionUpdate } from '../harness/acpSchema';
import { TurnOutcome } from '../harness/turnOutcome';

/** A turn whose `session/cancel` went out. */
function cancelSent(): TurnOutcome {
  const outcome = new TurnOutcome();
  outcome.request();
  return outcome;
}

/** Feed raw `update` objects the way a connector would: parsed, then reduced. */
function feed(raws: unknown[], turn: AcpTurn = newTurn({ source: 'acp-agent' })): { turn: AcpTurn; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  for (const raw of raws) {
    const step = reduceUpdate(turn, parseSessionUpdate(raw));
    turn = step.turn;
    events.push(...step.events);
  }
  return { turn, events };
}

const text = (t: string, extra: Record<string, unknown> = {}) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: t },
  ...extra,
});
const thought = (t: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } });

describe('reduceUpdate', () => {
  describe('message and thought chunks', () => {
    it('streams each agent message chunk as a delta under one run id', () => {
      const { events } = feed([text('Hel'), text('lo')]);
      const [a, b] = events;
      expect(a).toMatchObject({ type: 'assistant_text_delta', text: 'Hel' });
      expect(b).toMatchObject({ type: 'assistant_text_delta', text: 'lo' });
      expect((a as { runId: string }).runId).toBe((b as { runId: string }).runId);
    });

    it('streams thought chunks as thinking deltas', () => {
      expect(feed([thought('hm'), thought('m')]).events).toEqual([
        { type: 'thinking_delta', text: 'hm' },
        { type: 'thinking_delta', text: 'm' },
      ]);
    });

    it('shows nothing for a user message chunk, which only a session replay sends', () => {
      expect(feed([{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier' } }]).events).toEqual([]);
    });

    it('streams nothing for a chunk that is not text', () => {
      const image = { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } };
      expect(feed([image]).events).toEqual([]);
    });

    it('starts a new run when the agent names another message', () => {
      const { events } = feed([text('one', { messageId: 'm1' }), text('two', { messageId: 'm2' })]);
      const ids = events.map((e) => (e as { runId: string }).runId);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('keeps one run when the same message id continues', () => {
      const { events } = feed([text('one ', { messageId: 'm1' }), text('two', { messageId: 'm1' })]);
      const ids = events.map((e) => (e as { runId: string }).runId);
      expect(ids[0]).toBe(ids[1]);
    });

    it('starts a new run after a tool call, so the words around it stay apart', () => {
      const { events } = feed([text('before'), { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file' }, text('after')]);
      const runs = events.filter((e) => e.type === 'assistant_text_delta').map((e) => (e as { runId: string }).runId);
      expect(runs).toHaveLength(2);
      expect(runs[0]).not.toBe(runs[1]);
    });
  });

  describe('tool calls', () => {
    it('reports a tool call by the title the agent gave it, with the raw input as its arguments', () => {
      const { events } = feed([
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read package.json', kind: 'read', status: 'in_progress', rawInput: { path: 'package.json' } },
      ]);
      expect(events).toEqual([{ type: 'tool_call', id: 't1', name: 'Read package.json', args: { path: 'package.json' } }]);
    });

    // OpenCode 2.2.5 under `opencode acp`, as recorded live: the pending call
    // holds only its cwd, and the command arrives with the update after it.
    it('holds a pending call until its input is in, then reports that input', () => {
      const { events } = feed([
        { sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'shell', title: 'shell', kind: 'execute', status: 'pending', rawInput: { cwd: '/repo' } },
        { sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'sleep 60', kind: 'execute', status: 'in_progress', rawInput: { command: 'sleep 60', cwd: '/repo' } },
        { sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'sleep 60', status: 'in_progress', rawInput: { command: 'sleep 60', cwd: '/repo' } },
      ]);
      expect(events).toEqual([{ type: 'tool_call', id: 'c1', name: 'shell', args: { command: 'sleep 60', cwd: '/repo' } }]);
    });

    it('keeps a call pending through an update that leaves its status unchanged', () => {
      const { events } = feed([
        { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'shell', status: 'pending' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'c1', rawInput: { command: 'ls' } },
      ]);
      expect(events).toEqual([]);
    });

    it('reports a pending call that fails, as a call then its result', () => {
      const { events } = feed([
        { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'shell', status: 'pending', rawInput: { command: 'touch a' } },
        { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' },
      ]);
      expect(events).toEqual([
        { type: 'tool_call', id: 'c1', name: 'shell', args: { command: 'touch a' } },
        { type: 'tool_result', id: 'c1', name: 'shell', output: '', success: false },
      ]);
    });

    it('wraps a raw input that is not an object', () => {
      const { events } = feed([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'echo', rawInput: 'ls -la' }]);
      expect(events[0]).toMatchObject({ type: 'tool_call', args: { input: 'ls -la' } });
    });

    it('takes an explicit tool name over the title', () => {
      const { events } = feed([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Finish the task', name: 'ordewell__task_complete' }]);
      expect(events[0]).toMatchObject({ name: 'ordewell__task_complete' });
    });

    it('pairs a completed update with its call and keeps the name the call had', () => {
      const { events } = feed([
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ordewell__task_complete', kind: 'other', status: 'in_progress' },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          title: 'Completed',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'recorded' } }],
        },
      ]);
      expect(events).toEqual([
        { type: 'tool_call', id: 't1', name: 'ordewell__task_complete', args: {} },
        { type: 'tool_result', id: 't1', name: 'ordewell__task_complete', output: 'recorded', success: true },
      ]);
    });

    it('reports a failed update as an unsuccessful result', () => {
      const { events } = feed([
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run tests' },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', rawOutput: { exitCode: 1 } },
      ]);
      expect(events[1]).toEqual({ type: 'tool_result', id: 't1', name: 'Run tests', output: '{"exitCode":1}', success: false });
    });

    it('says nothing for an update that leaves the call running', () => {
      const { events } = feed([
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run tests' },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
      ]);
      expect(events).toHaveLength(1);
    });

    it('reports a call and its result together when the call arrives already finished', () => {
      const { events } = feed([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', status: 'completed' }]);
      expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
    });

    it('opens a call for an update that arrives first', () => {
      const { events } = feed([{ sessionUpdate: 'tool_call_update', toolCallId: 't9', title: 'grep', status: 'completed' }]);
      expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
      expect(events[1]).toMatchObject({ id: 't9', name: 'grep' });
    });

    it('does not report a result twice', () => {
      const done = { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' };
      const { events } = feed([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls' }, done, done]);
      expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
    });

    it('describes diff and terminal content in words', () => {
      const { events } = feed([
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'edit' },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          content: [
            { type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' },
            { type: 'terminal', terminalId: 'term-1' },
          ],
        },
      ]);
      expect((events[1] as { output: string }).output).toBe('Changed a.ts\nTerminal term-1');
    });

    it('passes a string raw output through whole', () => {
      const { events } = feed([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'echo', status: 'completed', rawOutput: 'hello' }]);
      expect(events[1]).toMatchObject({ type: 'tool_result', output: 'hello' });
    });

    it('gives an empty output when the agent returned nothing', () => {
      const { events } = feed([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', status: 'completed', rawOutput: null }]);
      expect(events[1]).toMatchObject({ type: 'tool_result', output: '' });
    });

    it('falls back to the tool kind, then a generic name, when a call has no title', () => {
      const { events } = feed([
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: '', kind: 'search' },
        { sessionUpdate: 'tool_call', toolCallId: 't2', title: '' },
      ]);
      expect(events.map((e) => (e as { name: string }).name)).toEqual(['search', 'tool']);
    });
  });

  // Qwen Code 0.27.1 marks every update a subagent makes with the call that
  // started it, in `_meta.parentToolCallId`.
  describe('a subagent\'s updates', () => {
    const child = { _meta: { parentToolCallId: 'p-1', subagentType: 'Explore' } };

    it('attributes its calls and their results to the call that started it', () => {
      const { events } = feed([
        { sessionUpdate: 'tool_call', toolCallId: 'p-1', title: 'agent', status: 'in_progress', rawInput: { prompt: 'look' } },
        { sessionUpdate: 'tool_call', toolCallId: 'c-1', title: 'Read a.ts', status: 'in_progress', rawInput: { path: 'a.ts' }, ...child },
        { sessionUpdate: 'tool_call_update', toolCallId: 'c-1', status: 'completed', rawOutput: 'text' },
      ]);
      expect(events).toEqual([
        { type: 'tool_call', id: 'p-1', name: 'agent', args: { prompt: 'look' } },
        { type: 'tool_call', id: 'c-1', name: 'Read a.ts', args: { path: 'a.ts' }, subagentId: 'p-1' },
        { type: 'tool_result', id: 'c-1', name: 'Read a.ts', output: 'text', success: true, subagentId: 'p-1' },
      ]);
    });

    it('attributes a call the turn closes to the call that started it', () => {
      const turn = feed([{ sessionUpdate: 'tool_call', toolCallId: 'c-1', title: 'Search', status: 'pending', ...child }]).turn;
      expect(endTurn(turn, 'end_turn', undefined, new TurnOutcome()).slice(0, 2)).toEqual([
        { type: 'tool_call', id: 'c-1', name: 'Search', args: {}, subagentId: 'p-1' },
        { type: 'turn_end' },
      ]);
    });

    it('keeps its words out of the planner\'s answer and shows its thoughts as its own', () => {
      const { turn, events } = feed([text('Looking. '), text('I found it.', child), { ...thought('hm'), ...child }, text('Done.')]);
      expect(events.filter((e) => e.type !== 'assistant_text_delta')).toEqual([{ type: 'thinking_delta', text: 'hm', subagentId: 'p-1' }]);
      expect(endTurn(turn, 'end_turn', undefined, new TurnOutcome()).filter((e) => e.type === 'assistant_text' || e.type === 'thinking')).toEqual([
        { type: 'assistant_text', runId: expect.any(String), text: 'Looking. Done.' },
      ]);
    });

    it('shows nothing of a thought that carries no text', () => {
      const { events } = feed([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'image', data: 'AA==', mimeType: 'image/png' }, ...child }]);
      expect(events).toEqual([]);
    });
  });

  describe('usage_update', () => {
    it('reports the context meter and nothing that adds up', () => {
      const { events } = feed([{ sessionUpdate: 'usage_update', used: 53000, size: 200000, cost: { amount: 0.045, currency: 'USD' } }]);
      expect(events).toEqual([{ type: 'usage', record: { source: 'acp-agent', contextTokens: 53000, contextWindow: 200000 } }]);
    });

    it('names the model when the turn knows it', () => {
      const { events } = feed([{ sessionUpdate: 'usage_update', used: 1, size: 2 }], newTurn({ source: 'acp-agent', model: 'm-1' }));
      expect(events[0]).toMatchObject({ record: { model: 'm-1' } });
    });
  });

  describe('updates that carry no event', () => {
    it.each([
      ['plan', { sessionUpdate: 'plan', entries: [{ content: 'x', priority: 'high', status: 'pending' }] }],
      ['available_commands_update', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'web', description: 'search' }] }],
      ['current_mode_update', { sessionUpdate: 'current_mode_update', currentModeId: 'code' }],
      ['config_option_update', { sessionUpdate: 'config_option_update', configOptions: [] }],
    ])('%s', (_name, raw) => {
      expect(feed([raw]).events).toEqual([]);
    });

    it('an unknown kind is skipped, not thrown', () => {
      expect(feed([{ sessionUpdate: 'session_info_update', title: 'x' }]).events).toEqual([]);
    });

    it('a malformed known kind is skipped, not thrown', () => {
      expect(feed([{ sessionUpdate: 'tool_call' }]).events).toEqual([]);
    });
  });
});

describe('endTurn', () => {
  const turnWith = (raws: unknown[]) => feed(raws).turn;

  describe('the stop reason', () => {
    it('ends an ordinary turn on end_turn', () => {
      expect(endTurn(newTurn({ source: 's' }), 'end_turn', undefined, new TurnOutcome())).toEqual([{ type: 'turn_end' }]);
    });

    it('marks a cancelled turn interrupted', () => {
      expect(endTurn(newTurn({ source: 's' }), 'cancelled', undefined, cancelSent())).toEqual([{ type: 'turn_end', interrupted: true }]);
    });

    it('marks cancelled interrupted even when Ordewell sent no cancel', () => {
      expect(endTurn(newTurn({ source: 's' }), 'cancelled', undefined, new TurnOutcome())).toEqual([{ type: 'turn_end', interrupted: true }]);
    });

    it('marks end_turn after a cancel interrupted, because the agent raced the cancel', () => {
      expect(endTurn(newTurn({ source: 's' }), 'end_turn', undefined, cancelSent())).toEqual([{ type: 'turn_end', interrupted: true }]);
    });

    it.each<string | { unreadable: string }>(['max_tokens', 'max_turn_requests', 'refusal', 'something_new', { unreadable: 'stopReason: Required' }])('marks %o after a cancel interrupted', (reason) => {
      const events = endTurn(newTurn({ source: 's' }), reason, undefined, cancelSent());
      expect(events[events.length - 1]).toEqual({ type: 'turn_end', interrupted: true });
      expect(events.some((e) => e.type === 'error')).toBe(false);
    });

    it('reports a refusal as an error in plain words, with no turn_end', () => {
      const events = endTurn(newTurn({ source: 's' }), 'refusal', undefined, new TurnOutcome());
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'error' });
      expect((events[0] as { message: string }).message).toMatch(/refus/i);
    });

    it('ends a max_tokens turn with a note', () => {
      const events = endTurn(newTurn({ source: 's' }), 'max_tokens', undefined, new TurnOutcome());
      expect(events.map((e) => e.type)).toEqual(['command_output', 'turn_end']);
      expect((events[0] as { text: string }).text).toMatch(/token limit/i);
      expect(events[1]).toEqual({ type: 'turn_end' });
    });

    it('ends a max_turn_requests turn with a note', () => {
      const events = endTurn(newTurn({ source: 's' }), 'max_turn_requests', undefined, new TurnOutcome());
      expect(events.map((e) => e.type)).toEqual(['command_output', 'turn_end']);
      expect((events[0] as { text: string }).text).toMatch(/requests/i);
    });

    it('ends a turn with a reason it does not know, and names the reason', () => {
      const events = endTurn(newTurn({ source: 's' }), 'exhausted', undefined, new TurnOutcome());
      expect(events.map((e) => e.type)).toEqual(['command_output', 'turn_end']);
      expect((events[0] as { text: string }).text).toContain('exhausted');
    });
  });

  describe('coalescing', () => {
    it('gathers the chunks of a run into one assistant_text under the id the deltas used', () => {
      const { turn, events } = feed([text('Hel'), text('lo')]);
      const runId = (events[0] as { runId: string }).runId;
      expect(endTurn(turn, 'end_turn', undefined, new TurnOutcome())).toEqual([
        { type: 'assistant_text', runId, text: 'Hello' },
        { type: 'turn_end' },
      ]);
    });

    it('gives each run its own complete text, in order', () => {
      const turn = turnWith([text('one', { messageId: 'a' }), text('two', { messageId: 'b' })]);
      const done = endTurn(turn, 'end_turn', undefined, new TurnOutcome()).filter((e) => e.type === 'assistant_text');
      expect(done.map((e) => (e as { text: string }).text)).toEqual(['one', 'two']);
    });

    it('closes a thought as one thinking event before the reply', () => {
      const turn = turnWith([thought('think'), thought('ing'), text('answer')]);
      const types = endTurn(turn, 'end_turn', undefined, new TurnOutcome()).map((e) => e.type);
      expect(types).toEqual(['thinking', 'assistant_text', 'turn_end']);
    });

    it('emits no text event for a turn that said nothing', () => {
      expect(endTurn(turnWith([{ sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', status: 'completed' }]), 'end_turn', undefined, new TurnOutcome())).toEqual([{ type: 'turn_end' }]);
    });

    it('keeps the text a refused turn already said', () => {
      const types = endTurn(turnWith([text('I cannot')]), 'refusal', undefined, new TurnOutcome()).map((e) => e.type);
      expect(types).toEqual(['assistant_text', 'error']);
    });
  });

  describe('calls still open', () => {
    it('leaves announced calls for the consumer to settle at turn end', () => {
      const turn = turnWith([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run tests' }]);
      const events = endTurn(turn, 'cancelled', undefined, cancelSent());
      expect(events.some((event) => event.type === 'tool_result')).toBe(false);
      expect(events[events.length - 1]).toEqual({ type: 'turn_end', interrupted: true });
    });

    it('reports a call that never left pending before closing it', () => {
      const turn = turnWith([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run tests', status: 'pending', rawInput: { command: 'npm test' } }]);
      const events = endTurn(turn, 'cancelled', undefined, cancelSent());
      expect(events).toEqual([
        { type: 'tool_call', id: 't1', name: 'Run tests', args: { command: 'npm test' } },
        { type: 'turn_end', interrupted: true },
      ]);
    });

    it('leaves a finished call alone', () => {
      const turn = turnWith([
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls' },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
      ]);
      expect(endTurn(turn, 'end_turn', undefined, new TurnOutcome())).toEqual([{ type: 'turn_end' }]);
    });
  });

  describe('usage', () => {
    it('reports the tokens the agent counted, with cache reads as cached input', () => {
      const events = endTurn(newTurn({ source: 'acp-agent' }), 'end_turn', { totalTokens: 30, inputTokens: 20, outputTokens: 10, cachedReadTokens: 5 }, new TurnOutcome());
      expect(events[0]).toEqual({ type: 'usage', record: { source: 'acp-agent', inputTokens: 20, outputTokens: 10, cachedInputTokens: 5 } });
    });

    it('leaves a measure the agent did not report absent, never zero', () => {
      const events = endTurn(newTurn({ source: 'acp-agent' }), 'end_turn', { inputTokens: 20 }, new TurnOutcome());
      const record: Record<string, unknown> = { ...(events[0] as Extract<AgentEvent, { type: 'usage' }>).record };
      expect(record).toEqual({ source: 'acp-agent', inputTokens: 20 });
      expect('outputTokens' in record).toBe(false);
      expect('cachedInputTokens' in record).toBe(false);
    });

    it('records no turn that reported only zeros, which is no measurement', () => {
      const events = endTurn(newTurn({ source: 's' }), 'end_turn', { inputTokens: 0, outputTokens: 0 }, new TurnOutcome());
      expect(events).toEqual([{ type: 'turn_end' }]);
    });

    it('keeps a reported zero beside a measure', () => {
      const events = endTurn(newTurn({ source: 's' }), 'end_turn', { inputTokens: 5, outputTokens: 0 }, new TurnOutcome());
      expect(events[0]).toEqual({ type: 'usage', record: { source: 's', inputTokens: 5, outputTokens: 0 } });
    });

    it.each([[undefined], [null], [{}], [{ totalTokens: 9 }], [{ inputTokens: null }]])('reports nothing for %j', (usage) => {
      const events = endTurn(newTurn({ source: 's' }), 'end_turn', usage as never, new TurnOutcome());
      expect(events).toEqual([{ type: 'turn_end' }]);
    });

    it('is reported even for an interrupted turn, which still spent them', () => {
      const events = endTurn(newTurn({ source: 's' }), 'cancelled', { inputTokens: 3 }, cancelSent());
      expect(events.map((e) => e.type)).toEqual(['usage', 'turn_end']);
    });

    it('names the model when the turn knows it', () => {
      const events = endTurn(newTurn({ source: 's', model: 'm-1' }), 'end_turn', { inputTokens: 1 }, new TurnOutcome());
      expect(events[0]).toMatchObject({ record: { model: 'm-1' } });
    });
  });
});
