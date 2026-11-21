import { describe, expect, it } from 'vitest';
import { ModelError, type ModelEvent, type ModelMessage, type ModelRequest } from '../../../model';
import { RunSettingsError } from '../../../SettingsService';
import { defaultModelInfo } from '../models';
import { assembleRequest, OrdewellLoop, type LoopOptions } from '../loop';
import { reasoningHintOf, taskReasoningKeptOf } from '../reasoningWindow';
import { scratch } from '../tools/__tests__/helpers';
import { call, fakeTaskTools, MemoryTranscriptStore, scriptedClient, STOP, type ScriptedStep } from './loopKit';

/** The conversation call `k` is sent: the task message, then k - 1 tool-calling turns, each with its result. */
function conversationAt(k: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', text: 'Fix the bug.' }];
  for (let turn = 1; turn < k; turn++) {
    const id = `c${turn}`;
    messages.push({ role: 'assistant', text: '', toolCalls: [{ id, name: 'read', arguments: {}, rawArguments: '{}' }] });
    messages.push({ role: 'tool', results: [{ callId: id, name: 'read', output: `read ${turn}` }] });
  }
  return messages;
}

/** Which assistant turns, counted from 1, the hint lets keep their reasoning. */
function keptTurns(messages: readonly ModelMessage[], keepFrom: number | undefined): number[] {
  const turns: number[] = [];
  let turn = 0;
  messages.forEach((message, i) => {
    if (message.role !== 'assistant') return;
    turn += 1;
    if (keepFrom === undefined || i >= keepFrom) turns.push(turn);
  });
  return turns;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('reasoningHintOf: which turns keep their reasoning at call k', () => {
  // Keep the last 5 calls, the boundary advancing every 10: the stepped window the brief's simulation priced.
  it.each([
    [1, []],
    [5, range(1, 4)],
    [15, range(1, 14)],
    [16, range(11, 15)],
    [25, range(11, 24)],
    [26, range(21, 25)],
    [35, range(21, 34)],
    [36, range(31, 35)],
  ])('keeping 5, call %i sends the reasoning of turns %j', (k, expected) => {
    const messages = conversationAt(k);
    expect(keptTurns(messages, reasoningHintOf(messages, 5)?.keepFrom)).toEqual(expected);
  });

  it.each([
    [2, [1]],
    [3, [1, 2]],
    [4, [3]],
    [5, [3, 4]],
    [6, [5]],
  ])('keeping 1, call %i sends the reasoning of turns %j', (k, expected) => {
    const messages = conversationAt(k);
    expect(keptTurns(messages, reasoningHintOf(messages, 1)?.keepFrom)).toEqual(expected);
  });

  it('sets no hint at all, the default, whatever the conversation', () => {
    expect(reasoningHintOf(conversationAt(400), 'all')).toBeUndefined();
  });

  it('sets no hint while nothing would be left out', () => {
    expect(reasoningHintOf(conversationAt(15), 5)).toBeUndefined();
  });

  it('only ever moves the boundary forward, and holds it between its steps', () => {
    let previous = 0;
    const moves: number[] = [];
    for (let k = 1; k <= 60; k++) {
      const keepFrom = reasoningHintOf(conversationAt(k), 5)?.keepFrom ?? 0;
      expect(keepFrom).toBeGreaterThanOrEqual(previous);
      if (keepFrom !== previous) moves.push(k);
      previous = keepFrom;
    }
    expect(moves).toEqual([16, 26, 36, 46, 56]);
  });

  it('always keeps the latest turn, the one whose results the call answers', () => {
    for (let k = 2; k <= 40; k++) {
      const messages = conversationAt(k);
      expect(keptTurns(messages, reasoningHintOf(messages, 1)?.keepFrom).at(-1)).toBe(k - 1);
    }
  });

  it('counts model turns, not the user messages the runner adds between them', () => {
    const messages = conversationAt(4);
    messages.splice(3, 0, { role: 'user', text: '[Ordewell] a notice' });
    messages.push({ role: 'user', text: '[Ordewell] another' });
    expect(keptTurns(messages, reasoningHintOf(messages, 1)?.keepFrom)).toEqual([3]);
  });

  it('starts over on a compacted conversation, counting only the turns it kept', () => {
    // A compaction keeps the task message, a summary and a tail of three turns.
    const tail = conversationAt(40).slice(-6);
    const compacted: ModelMessage[] = [{ role: 'user', text: 'Fix the bug.' }, { role: 'user', text: 'Summary.' }, ...tail];
    expect(reasoningHintOf(compacted, 5)).toBeUndefined();
    expect(keptTurns(compacted, reasoningHintOf(compacted, 1)?.keepFrom)).toEqual([3]);
  });
});

describe('taskReasoningKeptOf', () => {
  it.each([
    [undefined, undefined, 'all'],
    ['all', undefined, 'all'],
    [' ALL ', undefined, 'all'],
    [5, undefined, 5],
    ['12', undefined, 12],
    [5, ' 8 ', 8],
    [5, 'all', 'all'],
  ])('reads file %j with env %j as %j', (file, env, expected) => {
    expect(taskReasoningKeptOf(file, env)).toBe(expected);
  });

  it('treats a blank env as unset', () => {
    expect(taskReasoningKeptOf(7, '  ')).toBe(7);
  });

  it.each([0, -1, 2.5, 'some', '5k', '', true, {}])('refuses file value %j, saying what is accepted', (file) => {
    expect(() => taskReasoningKeptOf(file, undefined)).toThrow(RunSettingsError);
    expect(() => taskReasoningKeptOf(file, undefined)).toThrow(/taskReasoningKept.*all or a whole number of calls greater than zero/);
  });

  it('refuses a bad env, naming the variable', () => {
    expect(() => taskReasoningKeptOf(undefined, '0')).toThrow(/ORDEWELL_TASK_REASONING_KEPT/);
  });
});

describe('the hint where the request is assembled', () => {
  const FAST = { policy: { initialDelayMs: 1, maxDelayMs: 1, jitter: 0 } };
  const STATE: ModelEvent = { type: 'provider-state', state: { dialect: 'chat-completions', data: { reasoning: 'Thinking.', field: 'reasoning' } } };
  const probe = (n: number): ScriptedStep => [{ type: 'thinking-delta', text: 'Thinking.' }, call(`c${n}`, 'probe', { n }), STATE, STOP];
  const FINAL: ScriptedStep = [{ type: 'text-delta', text: 'Done.' }, STATE, STOP];

  function loopWith(steps: readonly ScriptedStep[], overrides: Partial<LoopOptions> = {}, store = new MemoryTranscriptStore()) {
    const { worktree, outputDir } = scratch();
    const client = scriptedClient(steps);
    const loop = new OrdewellLoop({
      client,
      model: defaultModelInfo('openrouter', 'mock/test'),
      system: [{ text: 'You are a test agent.', cacheBreakpoint: true }],
      store,
      taskTools: fakeTaskTools(['task_complete', 'probe']),
      toolContext: { worktree, outputDir, env: process.env },
      retry: FAST,
      hide: (value) => value,
      emit: () => undefined,
      ...overrides,
    });
    return { loop, store, client };
  }

  const run = (loop: OrdewellLoop, text = 'Probe four times.') => loop.runTurn(text, { stop: new AbortController().signal, hard: new AbortController().signal });
  const script = (): ScriptedStep[] => [probe(1), probe(2), probe(3), probe(4), FINAL];

  it('at all, sends every request byte for byte as with no setting', async () => {
    const unset = loopWith(script());
    await run(unset.loop);
    const all = loopWith(script(), { reasoningKept: 'all' });
    await run(all.loop);
    expect(all.client.requests).toHaveLength(5);
    expect(all.client.requests.every((request) => !('reasoning' in request))).toBe(true);
    expect(JSON.stringify(all.client.requests)).toBe(JSON.stringify(unset.client.requests));
  });

  it('at all, assembles the same request as before the setting existed', () => {
    const transcript = { messages: conversationAt(30), steps: 29, compactions: 0 };
    const input = { model: defaultModelInfo('openrouter', 'mock/test'), system: [{ text: 'one' }], transcript, tools: [] };
    expect(JSON.stringify(assembleRequest({ ...input, reasoningKept: 'all' }))).toBe(JSON.stringify(assembleRequest(input)));
  });

  it('puts each call\'s boundary on its request, from the transcript', async () => {
    const { loop, client } = loopWith(script(), { reasoningKept: 1 });
    await run(loop);
    // [task, a1, t1, a2, t2, a3, t3, a4, t4]: calls 4 and 5 leave out turns 1 and 2, keeping from a3.
    expect(client.requests.map((request) => request.reasoning)).toEqual([undefined, undefined, undefined, { keepFrom: 5 }, { keepFrom: 5 }]);
  });

  it('continues a session from the boundary its transcript gives', async () => {
    const first = loopWith(script(), { reasoningKept: 1 });
    await run(first.loop);
    const resumed = loopWith([FINAL], { reasoningKept: 1 }, first.store);
    await run(resumed.loop, 'Go on.');
    // [task, a1, t1, a2, t2, a3, t3, a4, t4, a5, go on]: five turns, so four are left out and a5 keeps its own.
    expect(resumed.client.requests[0]?.reasoning).toEqual({ keepFrom: 9 });
  });

  it('starts the count over once a compaction has replaced the conversation', async () => {
    const store = new MemoryTranscriptStore();
    await store.append({ v: 1, kind: 'session', at: 't', model: 'openrouter:mock/test', system: [{ text: 'You are a test agent.', cacheBreakpoint: true }] });
    const before = conversationAt(20);
    for (const [i, message] of before.entries()) await store.append({ v: 1, kind: 'message', at: 't', step: i + 1, message });
    const ahead = loopWith([FINAL], { reasoningKept: 5 }, store);
    await run(ahead.loop, 'Go on.');
    // Nineteen turns: the boundary had moved past the first ten.
    expect(ahead.client.requests[0]?.reasoning).toEqual({ keepFrom: 21 });

    // A compaction keeps the task message, then its summary and the last three turns.
    const { messages } = await store.load();
    await store.append({ v: 1, kind: 'compaction', at: 't', step: 40, head: 1, tailFrom: messages.length - 6, message: { role: 'user', text: 'Summary.' }, preTokens: 9_000, postTokens: 900 });
    const after = loopWith([FINAL], { reasoningKept: 5 }, store);
    await run(after.loop, 'Again.');
    expect(after.client.requests[0]?.messages.filter((m) => m.role === 'assistant')).toHaveLength(3);
    expect(after.client.requests[0]?.reasoning).toBeUndefined();
  });

  it('sends a step whose stream broke off part way again with the same boundary', async () => {
    const broken: ScriptedStep = async function* () {
      yield { type: 'thinking-delta', text: 'Thin' };
      throw new ModelError({ kind: 'transient', message: 'upstream broke', status: 503 });
    };
    const { loop, client } = loopWith([probe(1), probe(2), probe(3), broken, FINAL], { reasoningKept: 1 });
    await run(loop);
    expect(client.requests).toHaveLength(5);
    const [, , , cut, again] = client.requests as ModelRequest[];
    expect(cut?.reasoning).toEqual({ keepFrom: 5 });
    expect(again?.reasoning).toEqual(cut?.reasoning);
    expect(again?.messages).toEqual(cut?.messages);
  });
});
