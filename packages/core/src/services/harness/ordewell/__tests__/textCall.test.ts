import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../AgentAdapter';
import { defaultModelInfo } from '../models';
import { OrdewellLoop, type LoopOptions } from '../loop';
import { scratch } from '../tools/__tests__/helpers';
import { call, eventsOf, fakeTaskTools, MemoryTranscriptStore, scriptedClient, STOP, type ScriptedStep } from './loopKit';

function signals(): { stop: AbortSignal; hard: AbortSignal } {
  return { stop: new AbortController().signal, hard: new AbortController().signal };
}

function loopWith(steps: readonly ScriptedStep[], overrides: Partial<LoopOptions> = {}) {
  const { worktree, outputDir } = scratch();
  const store = new MemoryTranscriptStore();
  const client = scriptedClient(steps);
  const events: AgentEvent[] = [];
  const taskTools = fakeTaskTools(['task_complete']);
  const loop = new OrdewellLoop({
    client,
    model: defaultModelInfo('openrouter', 'mock/test'),
    system: [{ text: 'You are a test agent.' }],
    store,
    taskTools,
    toolContext: { worktree, outputDir, env: process.env },
    hide: (value) => value,
    emit: (event) => events.push(event),
    ...overrides,
  });
  return { loop, store, client, events, taskTools };
}

const reply = (text: string, usage = { inputTokens: 100, outputTokens: 30 }): ScriptedStep => [
  { type: 'text-delta', text },
  { type: 'usage', usage },
  STOP,
];
const textOf = (message: unknown): string => (message && typeof message === 'object' && 'text' in message ? String(message.text) : '');

/** A call written out as text, in the shape a model without a working tool channel falls back to. */
const WRITTEN = 'The work is finished.\n\n<tool_call>\n{"name":"task_complete","arguments":{"status":"done","summary":"All set."}}\n</tool_call>';
const NOTE = '[Ordewell] Your last reply wrote a tool call (task_complete) as text, so it was not made. Make the call through the tool-calling interface, not in your reply text, and go on with the task.';

describe('a tool call written as text in a reply (ADR-0070)', () => {
  it('does not end the turn: the turn goes on with a correction, and the text is never run as a call', async () => {
    const { loop, client, taskTools, events } = loopWith([reply(WRITTEN), [call('done', 'task_complete', { status: 'done', summary: 'ok' }), STOP], [STOP]]);
    const outcome = await loop.runTurn('Work.', signals());

    expect(outcome).toEqual({ interrupted: false });
    expect(client.requests).toHaveLength(3);
    const note = client.requests[1]?.messages.at(-1);
    expect(note).toMatchObject({ role: 'user' });
    expect(textOf(note)).toBe(NOTE);
    // Only the structured call reached the task tool: the written one was never executed.
    expect(taskTools.calls).toEqual([{ name: 'task_complete', args: { status: 'done', summary: 'ok' } }]);
    expect(eventsOf(events, 'tool_call').map((e) => e.id)).toEqual(['done']);
  });

  it('three times in a row ends the attempt as failed, naming the cause', async () => {
    const { loop, client, taskTools, events } = loopWith([reply(WRITTEN), reply(WRITTEN), reply(WRITTEN)]);
    const outcome = await loop.runTurn('Work.', signals());

    expect(client.requests).toHaveLength(3);
    const reason = 'The model wrote its task_complete call as text in its reply 3 times in a row instead of making it through the tool-calling interface, so the built-in runner ended the attempt.';
    // The attempt's report is the runner's own failed one; the model's written call never reaches the tool.
    expect(taskTools.calls).toEqual([{ name: 'task_complete', args: { status: 'failed', summary: reason, reason } }]);
    expect(outcome).toEqual({ interrupted: false, failed: reason });
    expect(eventsOf(events, 'command_output').map((e) => e.text)).toEqual([
      '[Ordewell] The model\'s reply wrote a task_complete call as text instead of making it (1 of 3 in a row); the turn goes on.',
      '[Ordewell] The model\'s reply wrote a task_complete call as text instead of making it (2 of 3 in a row); the turn goes on.',
    ]);
  });

  it('counts only replies in a row: a step with a tool call starts the count again', async () => {
    const glob = call('g1', 'glob', { pattern: '*.md' });
    const { loop, client, taskTools } = loopWith([reply(WRITTEN), reply(WRITTEN), [glob, STOP], reply(WRITTEN), reply(WRITTEN), reply('Done.')]);
    const outcome = await loop.runTurn('Work.', signals());
    expect(outcome).toEqual({ interrupted: false });
    expect(client.requests).toHaveLength(6);
    expect(taskTools.calls).toEqual([]);
  });

  it('records the usage of the reply, as of any call', async () => {
    const { loop, store } = loopWith([reply(WRITTEN, { inputTokens: 111, outputTokens: 22 }), reply('Done.')]);
    await loop.runTurn('Work.', signals());
    const usages = store.entries.filter((entry) => entry.kind === 'usage');
    expect(usages[0]).toMatchObject({ usage: { inputTokens: 111, outputTokens: 22 } });
  });

  it('ends the turn once the work is reported, with nothing left to correct', async () => {
    const { loop, client } = loopWith([[call('done', 'task_complete', { status: 'done', summary: 'ok' }), STOP], reply(WRITTEN)]);
    const outcome = await loop.runTurn('Work.', signals());
    expect(outcome).toEqual({ interrupted: false });
    expect(client.requests).toHaveLength(2);
  });
});

describe('a reply that is not a written call', () => {
  const finished = async (text: string) => {
    const { loop, client } = loopWith([reply(text)]);
    const outcome = await loop.runTurn('Work.', signals());
    return { outcome, requests: client.requests.length };
  };

  it.each([
    ['prose naming the syntax', 'I cannot use a <tool_call> block here; I will call task_complete properly.'],
    ['a mid-sentence quote', 'The model wrote <tool_call>{"name":"task_complete","arguments":{}}</tool_call> in its reply, which I fixed.'],
    ['an inline code span', 'Avoid writing `\n<tool_call>{"name":"task_complete"}</tool_call>` as text.'],
    ['a fenced block', 'The old reply looked like this:\n\n```xml\n<tool_call>\n{"name":"task_complete","arguments":{}}\n</tool_call>\n```\n\nIt is fixed.'],
    ['a block naming a tool that was not offered', '<tool_call>\n{"name":"launch_missiles","arguments":{}}\n</tool_call>'],
    ['a block with no tool name', '<tool_call>\nnot json at all\n</tool_call>'],
  ])('ends the turn as a finished one: %s', async (_label, text) => {
    expect(await finished(text)).toEqual({ outcome: { interrupted: false }, requests: 1 });
  });
});
