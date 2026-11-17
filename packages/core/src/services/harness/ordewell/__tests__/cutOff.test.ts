import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../AgentAdapter';
import type { ModelEvent } from '../../../model';
import { defaultModelInfo, type ModelInfo } from '../models';
import { OrdewellLoop, type LoopOptions } from '../loop';
import { scratch } from '../tools/__tests__/helpers';
import { call, eventsOf, fakeTaskTools, MemoryTranscriptStore, scriptedClient, STOP, type ScriptedStep } from './loopKit';

function signals(): { stop: AbortSignal; hard: AbortSignal } {
  return { stop: new AbortController().signal, hard: new AbortController().signal };
}

function model(contextWindow: number, maxOutputTokens: number): ModelInfo {
  const info = defaultModelInfo('openrouter', 'acme/model');
  return { ...info, contextWindow, contextWindowSource: 'catalog', maxOutputTokens, known: { ...info.known, contextWindow: true, maxOutputTokens: true } };
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

const LENGTH: ModelEvent = { type: 'finish', reason: 'length' };
/** A reply that spent its whole output on thinking, as the DeepSeek run's did. */
const thoughtOnly: ScriptedStep = [{ type: 'thinking-delta', text: 'Let me consider the layout of the repository first, then' }, { type: 'usage', usage: { inputTokens: 900, outputTokens: 4_096 } }, LENGTH];
const glob = (id: string, pattern = '*.md') => call(id, 'glob', { pattern });
const textOf = (message: unknown): string => (message && typeof message === 'object' && 'text' in message ? String(message.text) : '');

describe('the output limit a request carries', () => {
  it('is the model\'s own, when the window leaves room for it', async () => {
    const { loop, client } = loopWith([[{ type: 'text-delta', text: 'Done.' }, STOP]], { model: model(200_000, 8_000) });
    await loop.runTurn('Work.', signals());
    expect(client.requests[0]?.maxOutputTokens).toBe(8_000);
  });

  it('is cut to the room the window keeps above the compaction threshold, so prompt and reply fit', async () => {
    // DeepSeek V4.1 Flash as the catalog states it: 1,048,576 in, 943,718 out.
    // The compaction reserve is 15% of the window, rounded up: 157,286.4 -> 157,287.
    const { loop, client } = loopWith([[{ type: 'text-delta', text: 'Done.' }, STOP]], { model: model(1_048_576, 943_718) });
    await loop.runTurn('Work.', signals());
    expect(client.requests[0]?.maxOutputTokens).toBe(157_287);
  });

  it('keeps the default for a model nothing states a limit for', async () => {
    const { loop, client } = loopWith([[{ type: 'text-delta', text: 'Done.' }, STOP]]);
    await loop.runTurn('Work.', signals());
    expect(client.requests[0]?.maxOutputTokens).toBe(4_096);
  });
});

describe('a reply cut off at the output limit (ADR-0070)', () => {
  it('with no tool call does not end the turn: the turn goes on with a note to the model', async () => {
    const { loop, client, taskTools, events } = loopWith([thoughtOnly, [call('done', 'task_complete', { status: 'done', summary: 'ok' }), STOP], [STOP]]);
    const outcome = await loop.runTurn('Work.', signals());

    expect(outcome).toEqual({ interrupted: false });
    expect(client.requests).toHaveLength(3);
    const note = client.requests[1]?.messages.at(-1);
    expect(note).toMatchObject({ role: 'user' });
    expect(textOf(note)).toBe('[Ordewell] Your last reply was cut off at the output limit of 4096 tokens before it made a tool call. Go on with the task: act through tool calls, and keep your text and thinking short.');
    expect(taskTools.calls.map((c) => c.name)).toEqual(['task_complete']);
    // The log says why the step ended, rather than letting it pass for a finished reply.
    expect(eventsOf(events, 'command_output').map((e) => e.text)).toEqual([
      '[Ordewell] The model\'s reply stopped at the output limit of 4096 tokens with no tool call (cut-off 1 of 3 in a row); the turn goes on.',
    ]);
  });

  it('keeps the partial text it streamed, then the note', async () => {
    const { loop, store } = loopWith([[{ type: 'text-delta', text: 'First I will' }, LENGTH], [{ type: 'text-delta', text: 'Done.' }, STOP]]);
    await loop.runTurn('Work.', signals());
    const { messages } = await store.load();
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(textOf(messages[1])).toBe('First I will');
    expect(textOf(messages[2])).toMatch(/^\[Ordewell\] Your last reply was cut off at the output limit/);
  });

  it('with a complete tool call runs it, and the turn goes on from its result with no note', async () => {
    const { loop, client, events } = loopWith([[glob('g1'), LENGTH], [{ type: 'text-delta', text: 'Done.' }, STOP]]);
    const outcome = await loop.runTurn('Work.', signals());

    expect(outcome).toEqual({ interrupted: false });
    expect(eventsOf(events, 'tool_result').map((e) => e.id)).toEqual(['g1']);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ callId: 'g1', name: 'glob' }] });
    expect(eventsOf(events, 'command_output').map((e) => e.text)).toEqual([
      '[Ordewell] The model\'s reply stopped at the output limit of 4096 tokens; its 1 complete tool call runs and the turn goes on.',
    ]);
  });

  it('three times in a row with no tool call ends the attempt as failed, naming the output limit', async () => {
    const { loop, client, taskTools } = loopWith([thoughtOnly, thoughtOnly, thoughtOnly]);
    const outcome = await loop.runTurn('Work.', signals());

    expect(client.requests).toHaveLength(3);
    const reason = 'The model\'s reply was cut off at the output limit of 4096 tokens 3 times in a row without a tool call, so the built-in runner ended the attempt.';
    expect(taskTools.calls).toEqual([{ name: 'task_complete', args: { status: 'failed', summary: reason, reason } }]);
    // The turn ends as failed, never as a completed one the session would nudge and then wait on.
    expect(outcome).toEqual({ interrupted: false, failed: reason });
  });

  it('counts only cut-offs in a row: a step with a tool call starts the count again', async () => {
    const { loop, client, taskTools } = loopWith([thoughtOnly, thoughtOnly, [glob('g1'), STOP], thoughtOnly, thoughtOnly, [{ type: 'text-delta', text: 'Done.' }, STOP]]);
    const outcome = await loop.runTurn('Work.', signals());
    expect(outcome).toEqual({ interrupted: false });
    expect(client.requests).toHaveLength(6);
    expect(taskTools.calls).toEqual([]);
  });

  it('counts each continuation as a step against the step limit, the last one forced to report', async () => {
    const { loop, client, taskTools } = loopWith([thoughtOnly, [call('done', 'task_complete', { status: 'blocked', summary: 'cut off' }), STOP]], { stepLimit: 2 });
    await loop.runTurn('Work.', signals());
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]?.toolChoice).toEqual({ name: 'task_complete' });
    expect(taskTools.calls.map((c) => c.args)).toEqual([{ status: 'blocked', summary: 'cut off' }]);
  });

  it('on the last allowed call ends the attempt at the step limit', async () => {
    const { loop, client, taskTools } = loopWith([thoughtOnly], { stepLimit: 1 });
    const outcome = await loop.runTurn('Work.', signals());
    expect(client.requests).toHaveLength(1);
    expect(taskTools.calls).toEqual([{ name: 'task_complete', args: expect.objectContaining({ status: 'failed', reason: expect.stringMatching(/step limit of 1 model call/) }) }]);
    expect(outcome).toEqual({ interrupted: false });
  });
});
