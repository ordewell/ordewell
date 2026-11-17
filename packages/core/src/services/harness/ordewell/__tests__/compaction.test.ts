import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../AgentAdapter';
import { ModelError } from '../../../model';
import type { ModelClient, ModelEvent, ModelMessage, ModelRequest } from '../../../model';
import {
  SUMMARY_HEADINGS,
  COMPACT_AT_MIN_TOKENS,
  compactionReserve,
  compactionStart,
  compactionThreshold,
  estimateMessageTokens,
  estimatePromptTokens,
  missingHeadings,
  normalizeSummary,
  shouldCompact,
  splitForCompaction,
  summarize,
} from '../compaction';
import { assembleRequest, OrdewellLoop, type LoopOptions } from '../loop';
import { defaultModelInfo, type ModelInfo } from '../models';
import { foldTranscript, type TranscriptEntry } from '../transcript';
import { scratch } from '../tools/__tests__/helpers';
import { call, eventsOf, fakeTaskTools, MemoryTranscriptStore, scriptedClient, STOP } from './loopKit';

const SYSTEM = [{ text: 'You are a test agent.', cacheBreakpoint: true }];

const FULL_SUMMARY = SUMMARY_HEADINGS.map((heading) => `${'#'.repeat(heading.level)} ${heading.name}\nbody of ${heading.name}`).join('\n\n');

const user = (text: string): ModelMessage => ({ role: 'user', text });
const assistant = (text: string): ModelMessage => ({ role: 'assistant', text });
const withCall = (id: string): ModelMessage => ({ role: 'assistant', text: '', toolCalls: [{ id, name: 'read', arguments: {}, rawArguments: '{}' }] });
const result = (id: string, output: string): ModelMessage => ({ role: 'tool', results: [{ callId: id, name: 'read', output }] });
const chars = (n: number): string => 'x'.repeat(n);

describe('the compaction trigger', () => {
  it('reserves 15% of the window, and at least 16k tokens', () => {
    expect(compactionReserve(200_000)).toBe(30_000);
    expect(compactionReserve(100_000)).toBe(16_000);
    expect(compactionReserve(1_000_000)).toBe(150_000);
  });

  it('compacts only past the window minus the reserve', () => {
    expect(compactionThreshold(200_000)).toBe(170_000);
    expect(shouldCompact(170_000, 200_000)).toBe(false);
    expect(shouldCompact(170_001, 200_000)).toBe(true);
    expect(compactionThreshold(100_000)).toBe(84_000);
  });

  it('never starts under half the window, so a small window does not compact on every step', () => {
    expect(compactionThreshold(32_000)).toBe(16_000);
    expect(compactionThreshold(20_000)).toBe(10_000);
  });

  it('measures from the last count plus an estimate of what was added since', () => {
    const added = [user('a'.repeat(400)), assistant('b'.repeat(400))];
    const messages = [user('task'), ...added];
    const sinceTokens = added.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    expect(estimatePromptTokens({ messages, steps: 1, compactions: 0, measured: { tokens: 5_000, covers: 1 } }, 100)).toBe(5_000 + sinceTokens);
    // No count (a fresh attempt, or the step after a compaction): everything is estimated, the system prompt and tools included.
    const all = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    expect(estimatePromptTokens({ messages, steps: 1, compactions: 0 }, 100)).toBe(100 + all);
  });
});

describe('where taskCompactAt starts compaction on the built-in runner', () => {
  const RUNNER = 'OpenRouter runner';
  const start = (window: number, at: 'auto' | 'off' | number) => {
    const lines: string[] = [];
    return { at: compactionStart(window, at, RUNNER, (line) => lines.push(line)), lines };
  };

  it('auto keeps the capacity guard: the window less the larger of 16k and 15%, never under half', () => {
    expect(start(200_000, 'auto')).toEqual({ at: 170_000, lines: [] });
    expect(start(100_000, 'auto')).toEqual({ at: 84_000, lines: [] });
    expect(start(20_000, 'auto')).toEqual({ at: 10_000, lines: [] });
  });

  it('a number starts compaction at that context size, silently, when the window allows it', () => {
    expect(start(200_000, 60_000)).toEqual({ at: 60_000, lines: [] });
    expect(start(200_000, 170_000)).toEqual({ at: 170_000, lines: [] });
  });

  it('a number past the guard is held at the guard, and one under the floor at the floor, each said in one line', () => {
    expect(COMPACT_AT_MIN_TOKENS).toBe(32_000);
    const high = start(200_000, 500_000);
    expect(high.at).toBe(170_000);
    expect(high.lines).toEqual(['OpenRouter runner: taskCompactAt 500000 is outside the 32000 to 170000 tokens it can compact at; using 170000.']);
    const low = start(200_000, 5_000);
    expect(low.at).toBe(32_000);
    expect(low.lines).toHaveLength(1);
    // A window too small for the floor leaves only the guard.
    expect(start(40_000, 25_000).at).toBe(24_000);
  });

  it('off is auto here, since this runner would otherwise run into the provider\'s overflow error, and says so', () => {
    const off = start(200_000, 'off');
    expect(off.at).toBe(170_000);
    expect(off.lines).toEqual([
      'OpenRouter runner: taskCompactAt off is not honoured: without compaction this runner would run into the provider\'s context limit, so it compacts as auto does, from 170000 tokens.',
    ]);
  });
});

describe('the verbatim tail', () => {
  const pairs = (n: number, size: number): ModelMessage[] => Array.from({ length: n }, (_, i) => [user(`q${i}${chars(size)}`), assistant(`a${i}`)]).flat();

  it('starts at the earliest user message whose suffix fits, after the task message', () => {
    const messages = [user('task'), ...pairs(6, 400)];
    const split = splitForCompaction(messages, 330);
    // Each pair is about 108 tokens: the last three fit 330.
    expect(split).toEqual({ head: 1, tailFrom: 1 + 3 * 2 });
    expect(messages[split?.tailFrom ?? 0]?.role).toBe('user');
  });

  it('never starts the tail at a tool result, so a call stays with its result', () => {
    const messages: ModelMessage[] = [user('task'), withCall('c1'), result('c1', chars(400)), withCall('c2'), result('c2', chars(400)), withCall('c3'), result('c3', chars(40))];
    for (let budget = 0; budget < 600; budget += 10) {
      const split = splitForCompaction(messages, budget);
      if (!split) continue;
      const first = messages[split.tailFrom];
      expect(first?.role).not.toBe('tool');
      // The call that opens the tail brings its result along.
      if (first?.role === 'assistant') expect(messages[split.tailFrom + 1]?.role).toBe('tool');
    }
    expect(splitForCompaction(messages, 60)).toEqual({ head: 1, tailFrom: 5 });
  });

  it('prefers a user boundary and falls back to an assistant one when no user message fits', () => {
    const messages: ModelMessage[] = [user('task'), user(chars(4_000)), withCall('c1'), result('c1', 'ok'), withCall('c2'), result('c2', 'ok')];
    expect(splitForCompaction(messages, 100)).toEqual({ head: 1, tailFrom: 2 });
  });

  it('keeps the newest step even over budget unless an empty tail is allowed, and finds nothing when only the task is there', () => {
    const messages: ModelMessage[] = [user('task'), withCall('c1'), result('c1', chars(4_000)), withCall('c2'), result('c2', chars(4_000))];
    expect(splitForCompaction(messages, 10)).toEqual({ head: 1, tailFrom: 3 });
    expect(splitForCompaction(messages, 10, { allowEmptyTail: true })).toEqual({ head: 1, tailFrom: messages.length });
    expect(splitForCompaction([user('task')], 1_000)).toBeUndefined();
    expect(splitForCompaction([user('task'), withCall('c1'), result('c1', 'ok')], 1_000)).toBeUndefined();
  });
});

describe('the summary', () => {
  const info: ModelInfo = defaultModelInfo('openrouter', 'mock/test');

  it('finds the headings a model left out, whatever markdown level it wrote them at', () => {
    expect(missingHeadings(FULL_SUMMARY)).toEqual([]);
    expect(missingHeadings('# Objective\nx\n**Decisions**\n### Work State')).toEqual(['Requirements', 'Decisions', 'Completed', 'Active', 'Blocked', 'Next Move', 'Relevant Files', 'Important Context']);
    expect(missingHeadings('#### objective:\nx')).not.toContain('Objective');
  });

  it('always has every heading, in order, with a plain marker for what is missing', () => {
    const text = normalizeSummary('Preface line.\n\n## Decisions\nUse a map.\n\n## Next Move\nRun the tests.');
    expect(missingHeadings(text)).toEqual([]);
    const order = SUMMARY_HEADINGS.map((heading) => text.indexOf(`\n${'#'.repeat(heading.level)} ${heading.name}\n`) + 1 || text.indexOf(`${'#'.repeat(heading.level)} ${heading.name}\n`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toMatch(/## Objective\nPreface line\./);
    expect(text).toMatch(/## Decisions\nUse a map\./);
    expect(text).toMatch(/## Requirements\n\(not recorded\)/);
    expect(text).toMatch(/### Blocked\n\(not recorded\)/);
  });

  it('asks once for a missing heading, and keeps what the second reply says', async () => {
    const client = scriptedClient([[{ type: 'text-delta', text: '## Objective\nOnly this.' }, STOP], [{ type: 'text-delta', text: FULL_SUMMARY }, STOP]]);
    const { summary } = await summarize(client, info, [user('task'), assistant('did a thing')], { maxInputChars: 10_000 });
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.tools).toEqual([]);
    const reminder = client.requests[1]?.messages.at(-1);
    expect(reminder).toMatchObject({ role: 'user' });
    expect(reminder?.role === 'user' ? reminder.text : '').toContain('Requirements');
    expect(summary).toContain('body of Requirements');
    expect(missingHeadings(summary)).toEqual([]);
  });

  it('does not ask again when the reminder still leaves a heading out', async () => {
    const client = scriptedClient([[{ type: 'text-delta', text: '## Objective\nA' }, STOP], [{ type: 'text-delta', text: '## Objective\nB' }, STOP]]);
    const { summary } = await summarize(client, info, [assistant('x')], { maxInputChars: 10_000 });
    expect(client.requests).toHaveLength(2);
    expect(summary).toContain('## Objective\nB');
    expect(summary).toContain('### Active\n(not recorded)');
  });

  it('sends the middle as plain text, with no tool-call blocks and no tool list', async () => {
    const client = scriptedClient([[{ type: 'text-delta', text: FULL_SUMMARY }, STOP]]);
    await summarize(client, info, [withCall('c1'), result('c1', 'file contents')], { maxInputChars: 10_000 });
    const [request] = client.requests;
    expect(request?.tools).toEqual([]);
    expect(request?.messages.every((m) => m.role === 'user')).toBe(true);
    expect(request?.messages[0]?.role === 'user' ? request.messages[0].text : '').toContain('[tool result read]\nfile contents');
  });

  it('fails on an empty reply rather than compacting to nothing', async () => {
    await expect(summarize(scriptedClient([[STOP]]), info, [assistant('x')], { maxInputChars: 1_000 })).rejects.toThrow(/empty summary/);
  });
});

// ─── In the loop ────────────────────────────────────────────────────────────

function isSummaryCall(request: ModelRequest): boolean {
  return request.tools.length === 0;
}

function loopWith(client: ModelClient, overrides: Partial<LoopOptions> = {}, store = new MemoryTranscriptStore()) {
  const { worktree, outputDir } = scratch();
  const events: AgentEvent[] = [];
  const loop = new OrdewellLoop({
    client,
    model: { ...defaultModelInfo('openrouter', 'mock/test'), contextWindow: 100_000 },
    system: SYSTEM,
    store,
    taskTools: fakeTaskTools(['note'], async () => ({ text: chars(100_000) })),
    toolContext: { worktree, outputDir, env: process.env },
    hide: (value) => value,
    emit: (event) => events.push(event),
    ...overrides,
  });
  return { loop, store, events };
}

const abort = (): { stop: AbortSignal; hard: AbortSignal } => ({ stop: new AbortController().signal, hard: new AbortController().signal });
const text = (value: string): ModelEvent => ({ type: 'text-delta', text: value });
const usage = (inputTokens: number, outputTokens = 10): ModelEvent => ({ type: 'usage', usage: { inputTokens, outputTokens } });

/** A client that answers summary calls with `FULL_SUMMARY` and everything else from `main`. */
function splitClient(main: (request: ModelRequest, index: number) => readonly ModelEvent[]): ModelClient & { requests: ModelRequest[]; mainRequests: ModelRequest[]; summaryRequests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const mainRequests: ModelRequest[] = [];
  const summaryRequests: ModelRequest[] = [];
  return {
    provider: 'openrouter',
    dialect: 'chat-completions',
    requests,
    mainRequests,
    summaryRequests,
    stream(request) {
      requests.push(request);
      if (isSummaryCall(request)) {
        summaryRequests.push(request);
        return (async function* () {
          yield text(FULL_SUMMARY);
          yield usage(2_000, 300);
          yield STOP;
        })();
      }
      mainRequests.push(request);
      const events = main(request, mainRequests.length - 1);
      return (async function* () {
        yield* events;
      })();
    },
  };
}

describe('compaction in the loop', () => {
  // Three 25k-token tool results with a measured prompt of 60k leave an estimated 85k for the fourth request: past 84k.
  const script = (_request: ModelRequest, index: number): readonly ModelEvent[] => {
    if (index < 3) return [call(`c${index + 1}`, 'note', {}), usage([1_000, 30_000, 60_000][index] ?? 0), STOP];
    return [text('All done.'), usage(20_000), STOP];
  };

  it('replaces the middle with a summary, keeps the task and the newest step word for word, and records the compaction', async () => {
    const client = splitClient(script);
    const { loop, store, events } = loopWith(client);
    await expect(loop.runTurn('The task prompt.', abort())).resolves.toEqual({ interrupted: false });

    expect(client.summaryRequests).toHaveLength(1);
    const final = client.mainRequests[3];
    expect(final?.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'tool']);
    expect(final?.messages[0]).toEqual({ role: 'user', text: 'The task prompt.' });
    const summary = final?.messages[1];
    expect(summary?.role === 'user' ? summary.text : '').toContain('<summary>');
    expect(summary?.role === 'user' ? summary.text : '').toContain('body of Next Move');
    // The newest step, a call with its result.
    expect(final?.messages[2]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'c3' }] });
    expect(final?.messages[3]).toMatchObject({ role: 'tool', results: [{ callId: 'c3' }] });
    // The middle went to the summary call as text.
    const given = client.summaryRequests[0]?.messages[0];
    expect(given?.role === 'user' ? given.text : '').toContain('[tool call note]');

    const [event] = eventsOf(events, 'compaction');
    expect(eventsOf(events, 'compaction')).toHaveLength(1);
    expect(event).toMatchObject({ type: 'compaction', trigger: 'auto' });
    expect(event?.preTokens).toBeGreaterThan(84_000);
    expect(event?.postTokens).toBeLessThan(event?.preTokens ?? 0);

    // The meter resets to the new size, and the summary call is billed apart from it.
    const records = eventsOf(events, 'usage').map((e) => e.record);
    expect(records.find((r) => r.compacted)).toMatchObject({ compacted: true, contextTokens: event?.postTokens, contextWindow: 100_000 });
    expect(records.find((r) => r.purpose === 'compaction')).toMatchObject({ aggregate: true, inputTokens: 2_000, outputTokens: 300 });

    // Persisted: the lines stay, one more says what replaced them, and a resume loads the compacted conversation.
    expect(store.entries.filter((e) => e.kind === 'compaction')).toHaveLength(1);
    const resumed = foldTranscript(store.entries);
    expect(resumed.compactions).toBe(1);
    expect(resumed.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'tool', 'assistant']);
    expect(store.entries.filter((e) => e.kind === 'message').length).toBeGreaterThan(resumed.messages.length);
  });

  it('runs a model nothing describes under an assumed 128,000-token window, not a 16k threshold', async () => {
    // Eight steps of a 5k-token tool result each: about 45k tokens by the last request, past 16k early on and under 108,800 throughout.
    const client = splitClient((_request, index) => {
      if (index < 8) return [call(`c${index + 1}`, 'note', { text: `step ${index}` }), usage(1_000 + index * 5_000), STOP];
      return [text('Done.'), usage(45_000), STOP];
    });
    const { loop, events } = loopWith(client, {
      model: defaultModelInfo('openrouter', 'acme/unknown'),
      taskTools: fakeTaskTools(['note'], async () => ({ text: chars(20_000) })),
    });
    await expect(loop.runTurn('Task.', abort())).resolves.toEqual({ interrupted: false });
    expect(client.mainRequests).toHaveLength(9);
    expect(client.summaryRequests).toHaveLength(0);
    expect(eventsOf(events, 'compaction')).toEqual([]);
    const windows = eventsOf(events, 'usage').map((e) => e.record.contextWindow);
    expect(new Set(windows)).toEqual(new Set([128_000]));
    // The meter names the window as assumed, so a user reads it as a guess.
    expect(eventsOf(events, 'usage').every((e) => e.record.contextWindowAssumed === true)).toBe(true);
  });

  it('keeps the system prompt and tools byte-identical across steps, with a breakpoint on each prefix', async () => {
    const client = splitClient(script);
    const { loop } = loopWith(client);
    await loop.runTurn('The task prompt.', abort());

    const prefixes = client.mainRequests.map((request) => JSON.stringify({ system: request.system, tools: request.tools }));
    expect(client.mainRequests).toHaveLength(4);
    expect(new Set(prefixes).size).toBe(1);
    for (const request of client.mainRequests) {
      expect(request.cache).toEqual({ afterTools: true, atLastMessage: true });
      expect(request.system.at(-1)?.cacheBreakpoint).toBe(true);
    }
    // The compaction in the middle of the run did not touch the cached prefix.
    expect(client.mainRequests[3]?.system).toEqual(client.mainRequests[0]?.system);
  });

  it('compacts from the start size a number sets, well below the guard', async () => {
    // Under auto the fourth request (an estimated 85k) is the first past 84k; at 40k the third (about 55k) is.
    const client = splitClient(script);
    const { loop, events } = loopWith(client, { compactAt: 40_000 });
    await loop.runTurn('The task prompt.', abort());
    const [first] = eventsOf(events, 'compaction');
    expect(first?.preTokens).toBeGreaterThan(40_000);
    expect(first?.preTokens).toBeLessThan(84_000);
    // The summary call came between the second and third main requests.
    expect(client.requests.findIndex((r) => client.summaryRequests.includes(r))).toBe(2);
  });

  it('does not compact below the threshold', async () => {
    const client = splitClient((_request, index) => (index === 0 ? [call('c1', 'note', {}), usage(1_000), STOP] : [text('Done.'), usage(30_000), STOP]));
    const { loop, events } = loopWith(client);
    await loop.runTurn('Task.', abort());
    expect(client.summaryRequests).toHaveLength(0);
    expect(eventsOf(events, 'compaction')).toEqual([]);
  });

  it('puts no timestamp or counter in the cached prefix: a resumed attempt sends the stored system prompt', async () => {
    const store = new MemoryTranscriptStore();
    const stored = [{ text: 'Stored prompt. Date: 2020-01-01', cacheBreakpoint: true }];
    await store.append({ v: 1, kind: 'session', at: 't', model: 'openrouter:mock/test', system: stored });
    const client = scriptedClient([[text('Hi.'), STOP]]);
    const { loop } = loopWith(client, {}, store);
    await loop.runTurn('Hello.', abort());
    expect(client.requests[0]?.system).toEqual(stored);
  });

  it('marks the last system part when the prompt marked none', () => {
    const request = assembleRequest({
      model: defaultModelInfo('openrouter', 'mock/test'),
      system: [{ text: 'one' }, { text: 'two' }],
      transcript: { messages: [], steps: 0, compactions: 0 },
      tools: [],
    });
    expect(request.system).toEqual([{ text: 'one' }, { text: 'two', cacheBreakpoint: true }]);
    expect(request.cache).toEqual({ afterTools: true, atLastMessage: true });
  });
});

describe('overflow recovery', () => {
  const overflow = (): never => {
    throw new ModelError({ kind: 'context-overflow', message: 'prompt is too long' });
  };

  /** A resumed conversation of `count` alternating messages, whose last measured prompt (small) hides how big it is. */
  async function longConversation(count: number): Promise<MemoryTranscriptStore> {
    const store = new MemoryTranscriptStore();
    const entries: TranscriptEntry[] = [{ v: 1, kind: 'session', at: 't', model: 'openrouter:mock/test', system: SYSTEM }];
    const messages = [user('The task prompt.'), ...Array.from({ length: count }, (_, i) => (i % 2 === 0 ? assistant(`a${i}${chars(5_000)}`) : user(`u${i}${chars(5_000)}`)))];
    messages.forEach((message, i) => entries.push({ v: 1, kind: 'message', at: 't', step: i + 1, message }));
    entries.push({ v: 1, kind: 'usage', at: 't', step: messages.length, usage: { inputTokens: 1_000, outputTokens: 10 }, covers: messages.length });
    for (const entry of entries) await store.append(entry);
    return store;
  }

  it('compacts and retries the same step when the provider refuses the request as too long', async () => {
    const store = await longConversation(60);
    let main = 0;
    const client = splitClient(() => (main++ === 0 ? overflow() : [text('Done.'), STOP]));
    const { loop, events } = loopWith(client, {}, store);
    await expect(loop.runTurn('Go on.', abort())).resolves.toEqual({ interrupted: false });

    expect(client.mainRequests).toHaveLength(2);
    expect(client.summaryRequests).toHaveLength(1);
    expect(client.mainRequests[1]?.messages.length).toBeLessThan(client.mainRequests[0]?.messages.length ?? 0);
    expect(eventsOf(events, 'compaction')).toHaveLength(1);
  });

  it('shrinks further on each refusal, then fails with the provider\'s own error', async () => {
    const store = await longConversation(60);
    const client = splitClient(() => overflow());
    const { loop, events } = loopWith(client, {}, store);
    await expect(loop.runTurn('Go on.', abort())).rejects.toMatchObject({ kind: 'context-overflow' });

    // The first try, and one retry per fraction (0.85, 0.7, 0.5, 0.35), each from a smaller conversation.
    expect(client.mainRequests).toHaveLength(5);
    const sizes = client.mainRequests.map((request) => request.messages.length);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThan(sizes[i - 1] ?? 0);
    const compactions = eventsOf(events, 'compaction');
    expect(compactions).toHaveLength(4);
    const posts = compactions.map((c) => c.postTokens ?? 0);
    for (let i = 1; i < posts.length; i++) expect(posts[i]).toBeLessThan(posts[i - 1] ?? 0);
    // The task message is kept every time.
    expect(client.mainRequests.at(-1)?.messages[0]).toEqual({ role: 'user', text: 'The task prompt.' });
  });

  it('keeps the smaller window for the rest of the attempt, so it does not walk back into the same refusal', async () => {
    const store = await longConversation(60);
    // Refused once; the retry, at 85% of the 100k window, measures 50k and adds a 25k tool result.
    // 75k is under the full window's 84k threshold but past the shrunk 85k window's 69k.
    const client = splitClient((_request, index) => {
      if (index === 0) return overflow();
      if (index === 1) return [call('c1', 'note', {}), usage(50_000), STOP];
      return [text('Done.'), usage(20_000), STOP];
    });
    const { loop, events } = loopWith(client, {}, store);
    await expect(loop.runTurn('Go on.', abort())).resolves.toEqual({ interrupted: false });

    expect(client.mainRequests).toHaveLength(3);
    expect(client.summaryRequests).toHaveLength(2);
    expect(eventsOf(events, 'compaction')).toHaveLength(2);
    // The meter reads the window the attempt now runs under.
    const windows = eventsOf(events, 'usage').map((e) => e.record).filter((r) => !r.aggregate).map((r) => r.contextWindow);
    expect(windows.at(-1)).toBe(85_000);
  });

  it('fails at once when there is nothing to compact', async () => {
    const client = splitClient(() => overflow());
    const { loop } = loopWith(client);
    await expect(loop.runTurn('Task.', abort())).rejects.toMatchObject({ kind: 'context-overflow' });
    expect(client.summaryRequests).toHaveLength(0);
    expect(client.mainRequests).toHaveLength(1);
  });

  it('does not retry any other failure', async () => {
    const client = splitClient(() => {
      throw new ModelError({ kind: 'auth', message: 'bad key' });
    });
    const { loop } = loopWith(client);
    await expect(loop.runTurn('Task.', abort())).rejects.toMatchObject({ kind: 'auth' });
    expect(client.summaryRequests).toHaveLength(0);
  });
});
