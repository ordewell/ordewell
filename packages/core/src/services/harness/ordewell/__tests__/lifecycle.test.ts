import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../AgentAdapter';
import { ModelError } from '../../../model';
import { createChatCompletionsClient } from '../../../model/adapters/chatCompletions';
import { BASE_REQUEST, failure, refusal, replay } from '../../../model/__tests__/replay';
import { classifyRunnerStop, readUsageLimitReset } from '../../../runnerExit';
import { defaultModelInfo } from '../models';
import { citesBudget, citesContext, OrdewellLoop, stepFailure, type LoopOptions } from '../loop';
import { scratch } from '../tools/__tests__/helpers';
import type { ModelEvent } from '../../../model';
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

const glob = (id: string) => call(id, 'glob', { pattern: '*.md' });

describe('the step limit', () => {
  it('forces task_complete on the last allowed call, every tool still offered, with an instruction to report', async () => {
    const { loop, client, taskTools } = loopWith(
      [[glob('a'), STOP], [call('b', 'task_complete', { status: 'blocked', summary: 'half done' }), STOP]],
      { stepLimit: 2 },
    );
    expect(await loop.runTurn('Work.', signals())).toEqual({ interrupted: false });

    expect(client.requests).toHaveLength(2);
    const [first, last] = client.requests;
    expect(first?.toolChoice).toBeUndefined();
    expect(last?.toolChoice).toEqual({ name: 'task_complete' });
    expect(last?.tools.map((t) => t.name)).toEqual(first?.tools.map((t) => t.name));
    const instruction = last?.messages.at(-1);
    expect(instruction).toMatchObject({ role: 'user' });
    expect(instruction && 'text' in instruction ? instruction.text : '').toMatch(/last model call.*step limit of 2.*task_complete.*what is done and what is not/is);
    // The model reported, so the runner adds no report of its own.
    expect(taskTools.calls.map((c) => c.args)).toEqual([{ status: 'blocked', summary: 'half done' }]);
  });

  it('ends the attempt as failed, naming the limit, when the forced call was not a report', async () => {
    const { loop, client, taskTools, events } = loopWith([[glob('a'), STOP]], { stepLimit: 1 });
    await loop.runTurn('Work.', signals());
    expect(client.requests).toHaveLength(1);
    expect(taskTools.calls).toHaveLength(1);
    expect(taskTools.calls[0]?.args).toMatchObject({ status: 'failed', reason: expect.stringMatching(/step limit of 1 model call/) });
    // The log shows the runner's own report as a call it made.
    expect(eventsOf(events, 'tool_call').at(-1)).toMatchObject({ name: 'task_complete', args: { status: 'failed' } });
  });

  it('counts across turns of one attempt, and a turn past the limit makes no call but reports the failure', async () => {
    const { loop, client, taskTools } = loopWith([[STOP], [call('b', 'task_complete', { status: 'done', summary: 'ok' }), STOP]], { stepLimit: 2 });
    await loop.runTurn('One.', signals());
    await loop.runTurn('Two.', signals());
    expect(client.requests[1]?.toolChoice).toEqual({ name: 'task_complete' });
    await loop.runTurn('Three.', signals());
    expect(client.requests).toHaveLength(2);
    // A new turn voids the report made before it (ADR-0023 D6), and no call is left to make another.
    expect(taskTools.calls.map((c) => (c.args as { status: string }).status)).toEqual(['done', 'failed']);
  });

  it('a report the handler refused does not count: the runner then reports the failure itself', async () => {
    const taskTools = fakeTaskTools(['task_complete'], async (_name, args) =>
      (args as { status: string }).status === 'done' ? { text: 'Refused: no commit.', isError: true } : { text: 'Recorded.' });
    const { loop } = loopWith([[call('b', 'task_complete', { status: 'done', summary: 'ok' }), STOP]], { stepLimit: 1, taskTools });
    await loop.runTurn('Work.', signals());
    expect(taskTools.calls.map((c) => (c.args as { status: string }).status)).toEqual(['done', 'failed']);
  });

  it('without a task_complete to call, the turn fails with the limit as its error', async () => {
    const { loop } = loopWith([[glob('a'), STOP]], { stepLimit: 1, taskTools: fakeTaskTools([]) });
    await expect(loop.runTurn('Work.', signals())).rejects.toThrow(/step limit of 1 model call/);
  });
});

describe('the budget notices', () => {
  /** A glob per step, each with its own pattern so the repeat guard stays quiet. */
  const working = (steps: number): ScriptedStep[] => Array.from({ length: steps }, (_, i) => [call(`g${i}`, 'glob', { pattern: `${i}/*.md` }), STOP]);
  /** The runner's notes the model was sent, by the model call (from 1) each was the last message of. */
  function notesOf(requests: readonly { messages: readonly { role: string }[] }[]): Map<number, string> {
    const notes = new Map<number, string>();
    requests.forEach((request, i) => {
      const last = request.messages.at(-1);
      if (i > 0 && last?.role === 'user' && 'text' in last && typeof last.text === 'string') notes.set(i + 1, last.text);
    });
    return notes;
  }

  it('tells the model once at 80% of its step budget and once at 95%, before the forced last call', async () => {
    const { loop, client } = loopWith([...working(39), [call('end', 'task_complete', { status: 'blocked', summary: 'part done' }), STOP]], { stepLimit: 40 });
    await loop.runTurn('Work.', signals());

    expect(client.requests).toHaveLength(40);
    const notes = notesOf(client.requests);
    // 32 of 40 calls used is 80%, 38 is 95%; the 40th is the last call's own instruction.
    expect([...notes.keys()]).toEqual([33, 39, 40]);
    expect(notes.get(33)).toMatch(/^\[Ordewell\] You have used 32 of the 40 model calls/);
    expect(notes.get(33)).toMatch(/commit/);
    expect(notes.get(39)).toMatch(/^\[Ordewell\] 2 model calls are left of the 40/);
    expect(notes.get(39)).toMatch(/what is done and what remains/);
    expect(notes.get(40)).toMatch(/last model call/);
    // Each notice carries the exact count, so the model need not keep one.
    expect(notes.get(33)).toContain('[calls: 32 of 40; context: ');
    expect(notes.get(39)).toContain('[calls: 38 of 40; context: ');
  });

  it('sends the exact count every 50 calls, on the newest message only, so the model never keeps its own', async () => {
    const { loop, client } = loopWith([...working(110), [STOP]], { stepLimit: 1000 });
    await loop.runTurn('Work.', signals());

    expect(client.requests).toHaveLength(111);
    const notes = notesOf(client.requests);
    expect([...notes.keys()]).toEqual([51, 101]);
    expect(notes.get(51)).toMatch(/^\[calls: 50 of 1000; context: [^\]]+\]$/);
    expect(notes.get(101)).toMatch(/^\[calls: 100 of 1000; context: [^\]]+\]$/);
  });

  describe('with the context fill beside the count', () => {
    const WINDOW = 1_048_576;
    const model = { ...defaultModelInfo('openrouter', 'mock/test'), contextWindow: WINDOW, contextWindowSource: 'catalog' as const };
    /** Each step reports a prompt of 375,990 tokens and a 10-token reply: 376,000 in all. */
    const filled = (steps: number): ScriptedStep[] => Array.from({ length: steps }, (_, i) => [
      call(`g${i}`, 'glob', { pattern: `${i}/*.md` }),
      { type: 'usage', usage: { inputTokens: 375_990, outputTokens: 10 } } as ModelEvent,
      STOP,
    ]);

    it('says how many tokens the context holds of its window, so the model never estimates it', async () => {
      const { loop, client } = loopWith([...filled(60), [STOP]], { stepLimit: 1000, model });
      await loop.runTurn('Work.', signals());
      expect(notesOf(client.requests).get(51)).toBe('[calls: 50 of 1000; context: 376k of 1.05M tokens (36%)]');
    });

    it('names where compaction starts when a compaction point is in force', async () => {
      const { loop, client } = loopWith([...filled(60), [STOP]], { stepLimit: 1000, model, compactAt: 840_000 });
      await loop.runTurn('Work.', signals());
      expect(notesOf(client.requests).get(51)).toBe('[calls: 50 of 1000; context: 376k of 1.05M tokens (36%); compaction starts at 840k]');
    });
  });

  it('changes nothing before the newest message, so each call reads the previous call\'s cached prefix', async () => {
    const { loop, client } = loopWith([...working(110), [STOP]], { stepLimit: 1000 });
    await loop.runTurn('Work.', signals());

    for (let i = 1; i < client.requests.length; i++) {
      const before = client.requests[i - 1]?.messages ?? [];
      const after = client.requests[i]?.messages ?? [];
      expect(after.length).toBeGreaterThan(before.length);
      expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    }
    // The count lines were among what each later call carried unchanged.
    const last = client.requests.at(-1)?.messages ?? [];
    const counts = last.filter((m) => m.role === 'user' && 'text' in m && /^\[calls: /.test(m.text)).map((m) => ('text' in m ? m.text : ''));
    expect(counts.map((text) => text.replace(/; context: [^\]]+/, ''))).toEqual(['[calls: 50 of 1000]', '[calls: 100 of 1000]']);
  });

  it('sends none once a report stands', async () => {
    const report = call('r', 'task_complete', { status: 'done', summary: 'ok' });
    const { loop, client, taskTools } = loopWith([...working(31), [report, STOP], ...working(7), [STOP]], { stepLimit: 40 });
    await loop.runTurn('Work.', signals());

    expect(client.requests).toHaveLength(40);
    expect([...notesOf(client.requests).keys()]).toEqual([40]);
    expect(taskTools.calls.map((c) => (c.args as { status: string }).status)).toEqual(['done']);
  });

  it('sends neither where a threshold falls on the last call, which has its own instruction', async () => {
    const { loop, client } = loopWith([...working(4), [call('end', 'task_complete', { status: 'blocked', summary: 'part done' }), STOP]], { stepLimit: 5 });
    await loop.runTurn('Work.', signals());
    expect([...notesOf(client.requests).keys()]).toEqual([5]);
  });
});

describe('a completion that cites the budget early', () => {
  const working = (steps: number): ScriptedStep[] => Array.from({ length: steps }, (_, i) => [call(`g${i}`, 'glob', { pattern: `${i}/*.md` }), STOP]);
  const USAGE: ModelEvent = { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } };
  const giveUp = (id: string, args: Record<string, unknown>): ScriptedStep => [call(id, 'task_complete', args), USAGE, STOP];
  const statuses = (calls: readonly { args: unknown }[]) => calls.map((c) => (c.args as { status: string }).status);

  it('cites the budget when a failed or blocked report gives the budget as why, in a phrase that names it', () => {
    // The reasons three recorded attempts ended on, each with most of its calls unspent.
    expect(citesBudget({ status: 'failed', summary: 'Partial.', reason: 'Budget exhausted before the done criterion held' })).toBe(true);
    expect(citesBudget({ status: 'failed', summary: 'model-call budget exhausted' })).toBe(true);
    expect(citesBudget({ status: 'blocked', summary: 'x', reason: 'scope exceeds the attempt budget' })).toBe(true);
    expect(citesBudget({ status: 'blocked', summary: 'Too few model CALLS left.' })).toBe(true);
    expect(citesBudget({ status: 'failed', summary: 'x', reason: 'about to hit the step limit' })).toBe(true);
    expect(citesBudget({ status: 'failed', summary: 'My budget ran out.' })).toBe(true);
    expect(citesBudget({ status: 'failed', summary: 'Partial; out of model calls.' })).toBe(true);
    // Another status, other words, or the words inside others, are not.
    expect(citesBudget({ status: 'done', summary: 'Budget code done.' })).toBe(false);
    expect(citesBudget({ status: 'blocked', summary: 'The API is rate-limited.', reason: 'It recalls nothing.' })).toBe(false);
    expect(citesBudget({ status: 'failed', summary: 'One call failed.' })).toBe(false);
    expect(citesBudget({ status: 'failed', summary: 'x', findings: [{ title: 'budget' }] })).toBe(false);
    // A check's verdict or a real block uses the same words for something else (review #382).
    expect(citesBudget({ status: 'failed', summary: 'Confirmed 2 problems in the parser; steps to reproduce are in F1.' })).toBe(false);
    expect(citesBudget({ status: 'failed', summary: 'The retry wrapper calls the endpoint twice on a 500.' })).toBe(false);
    expect(citesBudget({ status: 'blocked', summary: 'Cannot install deps.', reason: 'The sandbox refuses all network calls.' })).toBe(false);
    expect(citesBudget({ status: 'blocked', summary: 'x', reason: 'The provider rate limit is 0 for this key.' })).toBe(false);
    expect(citesBudget({ status: 'failed', summary: 'The budget test in loop.test.ts still fails.' })).toBe(false);
    expect(citesBudget('budget')).toBe(false);
  });

  // A report that names a budget, a limit or what is left, but not the attempt's own (review #382, round 2).
  it.each([
    ['steps that remain of the work', { status: 'failed', summary: 'x', reason: 'Two steps remain: the migration and the docs; the schema change breaks the old reader.' }],
    ['steps left that need what is missing', { status: 'failed', summary: 'x', reason: 'The importer works; three steps left that need the vendor SDK, which is not in the workspace.' }],
    ['calls left over in the code', { status: 'failed', summary: 'x', reason: 'Two calls remain to the deprecated fetchUser; the tests still fail on them.' }],
    ['few calls left, not named the model\'s', { status: 'blocked', summary: 'Too few calls left.' }],
    ['a provider\'s call limit', { status: 'blocked', summary: 'x', reason: 'The GitHub API call limit was hit (403, X-RateLimit-Remaining: 0); retry after 15:00.' }],
    ['a bundle-size budget', { status: 'failed', summary: 'x', reason: 'The bundle-size budget is exhausted: main.js is 412 KB against 400 KB.' }],
    ['a performance budget', { status: 'failed', summary: 'The performance budget is spent on the first paint.' }],
    ['an error budget', { status: 'blocked', summary: 'x', reason: 'The error budget was exhausted this week; deploys are frozen.' }],
  ])('does not cite the budget for %s', (_what, args) => {
    expect(citesBudget(args)).toBe(false);
  });

  it('cites it for a check\'s verdict whose subject is the call budget, a shape it shares with a recorded give-up', () => {
    // "the call budget answer" and "exceeds the attempt budget" are both a named budget with no word of its use;
    // telling them apart takes the verbs around it. The answer leaves such a report free to be sent again.
    expect(citesBudget({ status: 'failed', summary: 'x', reason: 'The call budget answer still swallows a check verdict: citesBudget matches it.' })).toBe(true);
  });

  it('records a check\'s failed verdict on its first call, whose words are not about the budget', async () => {
    const verdict = { status: 'failed', summary: 'Confirmed: the handler calls save twice.', findings: [{ severity: 'major', title: 'double save' }] };
    const { loop, taskTools } = loopWith([giveUp('v', verdict), [STOP]], { stepLimit: 1000 });
    await loop.runTurn('Review.', signals());
    expect(taskTools.calls.map((c) => c.args)).toEqual([verdict]);
  });

  it('is answered once with the real count, not recorded, and the turn goes on', async () => {
    const early = { status: 'failed', summary: 'Out of room.', reason: 'Budget exhausted before the done criterion held' };
    const { loop, client, taskTools, events } = loopWith(
      [...working(5), giveUp('early', early), [glob('more'), STOP], [call('end', 'task_complete', { status: 'done', summary: 'ok' }), STOP], [STOP]],
      { stepLimit: 1000 },
    );
    expect(await loop.runTurn('Work.', signals())).toEqual({ interrupted: false });

    // The handler never saw it, and the model worked on to a report of its own.
    expect(statuses(taskTools.calls)).toEqual(['done']);
    expect(client.requests).toHaveLength(9);
    const answer = eventsOf(events, 'tool_result').find((r) => r.id === 'early');
    // It holds for a report that stopped for another reason too, so it asks for that one again rather than to go on.
    expect(answer?.output).toBe(
      '[Ordewell] Not recorded: if you stopped because of the call budget, it is not spent, so go on with the brief. '
      + 'If you stopped for another reason, call task_complete again and that report is recorded.\n[calls: 6 of 1000]',
    );
    expect(answer?.success).toBe(false);
    // The model reads the answer as the call's result in its next request.
    expect(JSON.stringify(client.requests[6]?.messages.at(-1))).toContain('[calls: 6 of 1000]');
    // Its step is billed like any other.
    expect(eventsOf(events, 'usage')).toHaveLength(1);
  });

  it('is accepted as it is the second time in an attempt', async () => {
    const first = { status: 'blocked', summary: 'Scope exceeds the attempt budget.' };
    const second = { status: 'blocked', summary: 'Still too few model calls left.' };
    const { loop, client, taskTools, events } = loopWith([giveUp('one', first), [glob('more'), STOP], giveUp('two', second), [STOP]], { stepLimit: 1000 });
    await loop.runTurn('Work.', signals());

    expect(taskTools.calls.map((c) => c.args)).toEqual([second]);
    expect(eventsOf(events, 'tool_result').find((r) => r.id === 'two')).toMatchObject({ success: true });
    expect(client.requests).toHaveLength(4);
  });

  it.each([
    ['a blocked report that does not cite the budget', { status: 'blocked', summary: 'No credential.', reason: 'The AWS key is missing.' }, 10],
    ['a done report that does', { status: 'done', summary: 'All 40 calls of the API are covered.' }, 10],
    ['a budget-citing failure once the first notice is due', { status: 'failed', summary: 'Out of calls.', reason: 'model-call budget exhausted' }, 10],
  ])('passes %s straight through', async (_what, args, limit) => {
    // The 80% notice of a limit of 10 is due at 8 calls used; the report is the 9th call for the third case.
    const lead = args.status === 'failed' ? working(8) : [];
    const { loop, taskTools, events } = loopWith([...lead, giveUp('r', args), [STOP]], { stepLimit: limit });
    await loop.runTurn('Work.', signals());

    expect(taskTools.calls.map((c) => c.args)).toEqual([args]);
    expect(eventsOf(events, 'tool_result').find((r) => r.id === 'r')).toMatchObject({ success: true, output: 'ok' });
  });
});

describe('a completion that cites the context being exhausted', () => {
  const WINDOW = 1_048_576;
  const model = { ...defaultModelInfo('openrouter', 'mock/test'), contextWindow: WINDOW, contextWindowSource: 'catalog' as const };
  /** Each step reports a prompt of `prompt` tokens and a 10-token reply. */
  const working = (steps: number, prompt: number): ScriptedStep[] => Array.from({ length: steps }, (_, i) => [
    call(`g${i}`, 'glob', { pattern: `${i}/*.md` }),
    { type: 'usage', usage: { inputTokens: prompt - 10, outputTokens: 10 } } as ModelEvent,
    STOP,
  ]);
  const giveUp = (id: string, args: Record<string, unknown>): ScriptedStep => [call(id, 'task_complete', args), STOP];
  const statuses = (calls: readonly { args: unknown }[]) => calls.map((c) => (c.args as { status: string }).status);
  const failed = (reason: string) => ({ status: 'failed', summary: 'Partial.', reason });

  it.each([
    ['the reason the recorded run ended on', failed('Context nearly exhausted; stopping with the parser half done.')],
    ['my context window', failed('My context window is almost full.')],
    ['the attempt\'s context', { status: 'blocked', summary: 'The attempt\'s context is exhausted.' }],
    ['running out of context', failed('I am running out of context and cannot finish the migration.')],
    ['having run out of context', { status: 'failed', summary: 'Ran out of context after the third file.' }],
    ['my memory', failed('My memory is used up.')],
    ['the context window as the clause\'s subject', failed('Stopped. The context window is full.')],
    ['context exhaustion in the summary only', { status: 'failed', summary: 'Context exhausted.', reason: 'See summary.' }],
    ['its limit reached', failed('Context limit reached.')],
    ['its window\'s limit reached', failed('The context window limit was reached.')],
    ['its budget exhausted', failed('Stopping: context budget exhausted.')],
    ['its limit approached', failed('I am approaching my context limit and cannot finish.')],
    ['its window nearly exhausted', failed('Context window nearly exhausted.')],
    ['not enough of it left', failed('Not enough context left to continue.')],
    ['too little of it remaining', failed('Insufficient context remaining to finish the refactor.')],
    ['it getting full', failed('Context is getting full; stopping here.')],
  ])('cites it for %s', (_what, args) => {
    expect(citesContext(args)).toBe(true);
  });

  it.each([
    ['a done report', { status: 'done', summary: 'Context handling is exhausted of edge cases, all fixed.' }],
    ['a library\'s own context object', failed('The request context object is full of stale entries; the handler leaks it.')],
    ['a lost async context', failed('The AsyncLocalStorage context was lost between the two calls, so the test fails.')],
    ['a quote out of context', failed('The changelog test quotes the old text out of context.')],
    ['a context-length error a tool returned', failed('read_task returned: maximum context length is 8192 tokens, however you requested 9000 tokens.')],
    ['a tool\'s context_length_exceeded', failed('The embedding API refused the input: context_length_exceeded.')],
    ['a tool\'s context window exceeded', failed('The summarizer rejected the diff: context window exceeded for its model.')],
    ['an out-of-memory test', failed('jest: the parser test died, JavaScript heap out of memory.')],
    ['a build that ran out of memory', failed('The CI build ran out of memory (OOM killed) while linking.')],
    ['a test that names memory exhaustion', failed('The test "memory exhausted" still fails on the fixture.')],
    ['another reason altogether', failed('The schema is invalid and the migration cannot run.')],
    ['a container\'s memory limit', failed('Our memory limit was hit by the CI container (OOM).')],
    ['a context window full of something', failed('The test failed: the context window is full of stale entries in the LRU cache.')],
    ['a context value that reached a handler', failed('Failed. Context reached the handler as undefined, so the middleware throws.')],
    ['a finding that names it', { status: 'failed', summary: 'x', findings: [{ title: 'my context is exhausted' }] }],
    ['no arguments object', 'context exhausted'],
  ])('does not cite it for %s', (_what, args) => {
    expect(citesContext(args)).toBe(false);
  });

  it('is answered once with the real fill, not recorded, and the turn goes on', async () => {
    const early = failed('Context nearly exhausted.');
    const { loop, client, taskTools, events } = loopWith(
      [...working(5, 376_000), giveUp('early', early), [glob('more'), STOP], [call('end', 'task_complete', { status: 'done', summary: 'ok' }), STOP], [STOP]],
      { stepLimit: 1000, model, compactAt: 840_000 },
    );
    expect(await loop.runTurn('Work.', signals())).toEqual({ interrupted: false });

    expect(statuses(taskTools.calls)).toEqual(['done']);
    const answer = eventsOf(events, 'tool_result').find((r) => r.id === 'early');
    expect(answer?.output).toBe(
      '[Ordewell] Not recorded: if you stopped because your context is full, it is not: it holds 376k of 1.05M tokens (36%) and is compacted for you as it fills, so go on with the brief. '
      + 'If you stopped for another reason, call task_complete again and that report is recorded.\n'
      + '[calls: 6 of 1000; context: 376k of 1.05M tokens (36%); compaction starts at 840k]',
    );
    expect(answer?.success).toBe(false);
    expect(JSON.stringify(client.requests[6]?.messages.at(-1))).toContain('compaction starts at 840k');
  });

  it('is accepted as it is the second time in an attempt', async () => {
    const { loop, taskTools, events } = loopWith(
      [...working(3, 376_000), giveUp('one', failed('Context exhausted.')), [glob('more'), STOP], giveUp('two', failed('Context is still exhausted.')), [STOP]],
      { stepLimit: 1000, model, compactAt: 840_000 },
    );
    await loop.runTurn('Work.', signals());
    expect(statuses(taskTools.calls)).toEqual(['failed']);
    expect(eventsOf(events, 'tool_result').find((r) => r.id === 'two')).toMatchObject({ success: true });
  });

  it('answers with no compaction point in force while the fill is under 70% of the window', async () => {
    const { loop, taskTools, events } = loopWith([...working(3, 376_000), giveUp('early', failed('My context is exhausted.')), [STOP]], { stepLimit: 1000, model });
    await loop.runTurn('Work.', signals());
    expect(taskTools.calls).toHaveLength(0);
    expect(eventsOf(events, 'tool_result').find((r) => r.id === 'early')?.output).toMatch(/it holds 376k of 1\.05M tokens \(36%\)/);
  });

  it.each([
    ['with no compaction point, at 70% of the window', 740_000, undefined],
    ['at the compaction point', 840_000, 840_000],
  ])('accepts it at once %s: the context is as full as it gets', async (_what, prompt, compactAt) => {
    // A step between reports the fill, so the stop is judged on the figure the provider gave.
    const { loop, taskTools } = loopWith(
      [...working(3, prompt), giveUp('r', failed('Context nearly exhausted.')), [STOP]],
      { stepLimit: 1000, model, ...(compactAt !== undefined ? { compactAt } : {}) },
    );
    await loop.runTurn('Work.', signals());
    expect(statuses(taskTools.calls)).toEqual(['failed']);
  });

  it('holds back a report citing the budget and the context once, and records it the second time, as the answer promised', async () => {
    const both = failed('Budget nearly exhausted and my context is nearly full.');
    expect([citesBudget(both), citesContext(both)]).toEqual([true, true]);
    const { loop, taskTools, events } = loopWith([giveUp('one', both), giveUp('two', both), [STOP]], { stepLimit: 1000, model, compactAt: 840_000 });
    await loop.runTurn('Work.', signals());

    expect(taskTools.calls.map((c) => c.args)).toEqual([both]);
    expect(eventsOf(events, 'tool_result').find((r) => r.id === 'one')?.output).toMatch(/^\[Ordewell\] Not recorded: if you stopped because of the call budget/);
    // The context answer, given after the budget's, would hold back the report the budget's promised to record.
    expect(eventsOf(events, 'tool_result').find((r) => r.id === 'two')).toMatchObject({ success: true, output: 'ok' });
  });

  it('records a report that stopped for another reason on its first call', async () => {
    const { loop, taskTools } = loopWith([...working(3, 376_000), giveUp('r', failed('The jest run died: heap out of memory.')), [STOP]], { stepLimit: 1000, model });
    await loop.runTurn('Work.', signals());
    expect(statuses(taskTools.calls)).toEqual(['failed']);
  });
});

describe('the repeat guard', () => {
  it('nudges the third identical call in a row and ends the attempt on the fourth, naming the call', async () => {
    const { loop, client, taskTools, events } = loopWith([[glob('1'), STOP], [glob('2'), STOP], [glob('3'), STOP], [glob('4'), STOP]]);
    await loop.runTurn('Look.', signals());

    expect(client.requests).toHaveLength(4);
    const results = eventsOf(events, 'tool_result').filter((r) => r.name === 'glob');
    expect(results.map((r) => /identical/i.test(r.output))).toEqual([false, false, true, true]);
    expect(results[2]?.output).toMatch(/third .*glob.* same arguments/i);
    expect(results[3]).toMatchObject({ success: false });
    expect(results[3]?.output).toMatch(/^Not run/);
    const report = taskTools.calls.at(-1)?.args as { status: string; reason: string };
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('glob');
    expect(report.reason).toContain('{"pattern":"*.md"}');
    expect(report.reason).toMatch(/4 times in a row/);
  });

  it('any other call in between, or other arguments, starts the count again', async () => {
    const other = call('x', 'glob', { pattern: '*.ts' });
    const { loop, taskTools, events } = loopWith([[glob('1'), STOP], [glob('2'), STOP], [other, STOP], [glob('3'), STOP], [glob('4'), STOP], [STOP]]);
    await loop.runTurn('Look.', signals());
    expect(eventsOf(events, 'tool_result').some((r) => /identical/i.test(r.output))).toBe(false);
    expect(taskTools.calls).toHaveLength(0);
  });

  it('reads arguments by value, not by key order', async () => {
    const a = call('1', 'grep', { pattern: 'x', path: '.' });
    const b = call('2', 'grep', { path: '.', pattern: 'x' });
    const c = call('3', 'grep', { pattern: 'x', path: '.' });
    const { loop, events } = loopWith([[a, STOP], [b, STOP], [c, STOP], [STOP]]);
    await loop.runTurn('Look.', signals());
    expect(eventsOf(events, 'tool_result').map((r) => /identical/i.test(r.output))).toEqual([false, false, true]);
  });
});

describe('a failed step, as E1 and U1 read it', () => {
  it('pauses a usage limit until its reset', () => {
    const resetsAt = Date.now() + 3_600_000;
    const event = stepFailure(new ModelError({ kind: 'usage-limit', message: 'quota', resetsAt }));
    expect(classifyRunnerStop(event)).toBe('usage-limit');
    expect(readUsageLimitReset('ordewell', event)?.getTime()).toBe(resetsAt);
  });

  it('retries the turn for a provider still failing or throttling after the client\'s retries', () => {
    for (const error of [
      new ModelError({ kind: 'transient', message: 'upstream broke', status: 503 }),
      new ModelError({ kind: 'transient', message: 'timed out', status: 408 }),
      new ModelError({ kind: 'transient', message: 'ECONNREFUSED', network: true }),
      new ModelError({ kind: 'transient', message: 'stream said server_error' }),
      new ModelError({ kind: 'rate-limited', message: 'slow down', status: 429 }),
      new ModelError({ kind: 'rate-limited', message: 'Too many requests: quota exceeded per minute', status: 429 }),
    ]) {
      const event = stepFailure(error);
      expect(event.usageLimit, error.message).toBe(false);
      expect(classifyRunnerStop(event), error.message).toBe('transient');
    }
  });

  it('fails the rest, a bad key naming /key-set', () => {
    const auth = stepFailure(new ModelError({ kind: 'auth', message: 'invalid api key', status: 401 }));
    expect(auth.message).toMatch(/invalid api key/);
    expect(auth.message).toMatch(/\/key-set/);
    expect(classifyRunnerStop(auth)).toBe('stopped');
    for (const kind of ['bad-request', 'context-overflow', 'fatal'] as const) {
      const event = stepFailure(new ModelError({ kind, message: 'no', status: 400 }));
      expect(classifyRunnerStop(event), kind).toBe('stopped');
    }
  });

  it('puts a router\'s refusal in the turn\'s error, its status and words whole, and asks the user instead of retrying', async () => {
    // OpenRouter's answer, recorded live, when the account's privacy settings
    // leave a model no endpoint: the same for every request, so no E1 retry.
    const words = '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons):\nZDR violation (account settings): 1 endpoint excluded; configurable at https://openrouter.ai/settings/privacy';
    const body = { error: { message: words, code: 404, metadata: { ineligibility_reasons: [{ reason: 'zdr-violation-by-account', endpoint_count: 1 }] } } };
    const client = createChatCompletionsClient({ provider: 'openrouter', apiKey: 'sk-test', baseUrl: 'https://openrouter.test/api/v1', fetch: replay(refusal(404, body)).fetch });
    const event = stepFailure(await failure(client, { ...BASE_REQUEST, model: 'google/gemini-2.5-flash' }));
    expect(event.usageLimit).toBe(false);
    expect(event.message).toContain(words);
    expect(event.message).toMatch(/\(HTTP 404\)$/);
    expect(classifyRunnerStop(event)).toBe('stopped');
  });
});
