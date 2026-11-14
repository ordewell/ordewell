import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../AgentAdapter';
import { ModelError } from '../../../model';
import type { ModelEvent, ModelRequest } from '../../../model';
import { HeldSecrets } from '../../../HeldSecrets';
import { defaultModelInfo } from '../models';
import { OrdewellLoop, stepFailure, type LoopOptions } from '../loop';
import { scratch } from '../tools/__tests__/helpers';
import { call, deferred, eventsOf, fakeTaskTools, MemoryTranscriptStore, scriptedClient, STOP, type ScriptedStep } from './loopKit';

const SYSTEM = [{ text: 'You are a test agent.', cacheBreakpoint: true }];

function signals(): { stop: AbortController; hard: AbortController; both: { stop: AbortSignal; hard: AbortSignal } } {
  const stop = new AbortController();
  const hard = new AbortController();
  return { stop, hard, both: { stop: stop.signal, hard: hard.signal } };
}

function loopWith(steps: readonly ScriptedStep[], overrides: Partial<LoopOptions> = {}) {
  const { worktree, outputDir } = scratch();
  const store = new MemoryTranscriptStore();
  const client = scriptedClient(steps);
  const events: AgentEvent[] = [];
  const taskTools = overrides.taskTools ?? fakeTaskTools(['task_complete']);
  const loop = new OrdewellLoop({
    client,
    model: defaultModelInfo('openrouter', 'mock/test'),
    system: SYSTEM,
    store,
    taskTools,
    toolContext: { worktree, outputDir, env: process.env },
    hide: (value) => value,
    emit: (event) => events.push(event),
    ...overrides,
  });
  return { loop, store, client, events, worktree, taskTools };
}

describe('OrdewellLoop', () => {
  it('streams text and thinking, records usage, and ends the turn on a step with no tool call', async () => {
    const { loop, store, events } = loopWith([
      [
        { type: 'thinking-delta', text: 'Think' },
        { type: 'thinking-delta', text: 'ing.' },
        { type: 'text-delta', text: 'Hel' },
        { type: 'text-delta', text: 'lo.' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cost: { amount: 0.5, currency: 'USD' } } },
        STOP,
      ],
    ]);
    const outcome = await loop.runTurn('Say hello.', signals().both);

    expect(outcome).toEqual({ interrupted: false });
    expect(eventsOf(events, 'assistant_text_delta').map((e) => e.text)).toEqual(['Hel', 'lo.']);
    expect(eventsOf(events, 'thinking')).toEqual([{ type: 'thinking', text: 'Thinking.' }]);
    expect(eventsOf(events, 'assistant_text')[0]?.text).toBe('Hello.');
    const usage = eventsOf(events, 'usage')[0]?.record;
    expect(usage).toMatchObject({ source: 'ordewell', model: 'openrouter:mock/test', inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 });
    expect(usage?.reportedCost).toEqual({ amount: 0.5, currency: 'USD', kind: 'billed' });
    // A defaulted window is still the one compaction acts on, so it is the one reported.
    expect(usage?.contextWindow).toBe(32_000);
    expect(usage?.contextTokens).toBe(14);

    const saved = await store.load();
    expect(saved.system).toEqual(SYSTEM);
    expect(saved.model).toBe('openrouter:mock/test');
    expect(saved.messages).toEqual([{ role: 'user', text: 'Say hello.' }, { role: 'assistant', text: 'Hello.' }]);
    expect(store.entries.some((entry) => entry.kind === 'usage')).toBe(true);
  });

  it('rebuilds every request from the transcript, with the same tools on every step', async () => {
    const { loop, client, worktree } = loopWith([[call('c1', 'read', { path: 'notes.txt' }), STOP], [{ type: 'text-delta', text: 'Read it.' }, STOP]]);
    writeFileSync(path.join(worktree, 'notes.txt'), 'first line\n');
    await loop.runTurn('Read notes.txt.', signals().both);

    const [first, second] = client.requests;
    expect(first?.system).toEqual(SYSTEM);
    expect(first?.messages).toEqual([{ role: 'user', text: 'Read notes.txt.' }]);
    expect(second?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const toolMessage = second?.messages[2];
    expect(toolMessage?.role === 'tool' && toolMessage.results[0]?.output).toContain('first line');
    expect(second?.tools).toEqual(first?.tools);
    expect(first?.tools.map((t) => t.name)).toEqual(['read', 'edit', 'write', 'shell', 'grep', 'glob', 'task_complete']);
    // A zod schema's `$schema` key is dropped: some providers refuse it.
    expect(first?.tools.at(-1)?.parameters).not.toHaveProperty('$schema');
    expect(first?.cache).toEqual({ afterTools: true, atLastMessage: true });
  });

  it('starts each call as soon as the stream completes it, runs calls side by side, and records results in call order', async () => {
    const order: string[] = [];
    const slowStarted = deferred();
    const releaseSlow = deferred();
    const taskTools = fakeTaskTools(['slow', 'fast'], async (name) => {
      order.push(`start ${name}`);
      if (name === 'slow') {
        slowStarted.resolve();
        await releaseSlow.promise;
      }
      order.push(`end ${name}`);
      return { text: `${name} done` };
    });
    const firstStep: ScriptedStep = async function* () {
      yield call('a', 'slow', {});
      // The stream waits for the first call to have started: it must not wait for the stream's end.
      await slowStarted.promise;
      order.push('stream continues');
      yield call('b', 'fast', {});
      yield STOP;
    };
    const { loop, store, events } = loopWith([firstStep, [STOP]], { taskTools });
    const turn = loop.runTurn('Go.', signals().both);
    await expect.poll(() => order.includes('end fast')).toBe(true);
    releaseSlow.resolve();
    await turn;

    expect(order.indexOf('start slow')).toBeLessThan(order.indexOf('stream continues'));
    // The fast call finished while the slow one ran.
    expect(order.indexOf('end fast')).toBeLessThan(order.indexOf('end slow'));
    expect(eventsOf(events, 'tool_result').map((e) => e.id)).toEqual(['b', 'a']);
    const tool = (await store.load()).messages.find((m) => m.role === 'tool');
    expect(tool?.role === 'tool' && tool.results.map((r) => r.callId)).toEqual(['a', 'b']);
  });

  it('runs a neutral tool through the gate, which can refuse it with the reason the model reads', async () => {
    const seen: string[] = [];
    const { loop, events, worktree } = loopWith([[call('w', 'write', { path: 'out.txt', content: 'x' }), STOP], [STOP]], {
      gate: ({ tool }) => {
        seen.push(tool.name);
        return { allow: false, reason: 'not in this mode' };
      },
    });
    await loop.runTurn('Write.', signals().both);

    expect(seen).toEqual(['write']);
    const result = eventsOf(events, 'tool_result')[0];
    expect(result?.success).toBe(false);
    expect(result?.output).toContain('not in this mode');
    expect(() => readFileSync(path.join(worktree, 'out.txt'))).toThrow();
  });

  it('answers an unknown tool and bad arguments with an error result, not a failed turn', async () => {
    const bad: ModelEvent = { type: 'tool-call-complete', call: { id: 'x', name: 'read', arguments: {}, rawArguments: '{', argumentsError: 'not JSON' } };
    const { loop, events } = loopWith([[call('u', 'nope', {}), bad, STOP], [STOP]]);
    await loop.runTurn('Go.', signals().both);

    const [unknown, invalid] = eventsOf(events, 'tool_result');
    expect(unknown?.output).toMatch(/Unknown tool "nope"\. The tools are: read, edit/);
    expect(invalid?.output).toBe('Invalid arguments for read: not JSON');
  });

  it('calls the task tools in-process with the hard signal', async () => {
    const received: AbortSignal[] = [];
    const taskTools = fakeTaskTools(['task_complete'], async (_name, _args, signal) => {
      received.push(signal);
      return { text: 'Task complete.' };
    });
    const s = signals();
    const { loop } = loopWith([[call('t', 'task_complete', { status: 'done', summary: 's' }), STOP], [STOP]], { taskTools });
    await loop.runTurn('Finish.', s.both);

    expect(taskTools.calls).toEqual([{ name: 'task_complete', args: { status: 'done', summary: 's' } }]);
    expect(received[0]).toBe(s.hard.signal);
  });

  it('lets the step boundary inject messages, choose the tool, and stop', async () => {
    const boundaries: { step: number; turnSteps: number }[] = [];
    const { loop, client } = loopWith([[call('r', 'read', { path: '.' }), STOP], [STOP]], {
      onStepBoundary: ({ step, turnSteps }) => {
        boundaries.push({ step, turnSteps });
        if (turnSteps === 0) return { inject: ['A message the user queued.'] };
        if (turnSteps === 1) return { toolChoice: { name: 'task_complete' } };
        return { stop: true };
      },
    });
    await loop.runTurn('Go.', signals().both);

    expect(boundaries).toEqual([{ step: 1, turnSteps: 0 }, { step: 2, turnSteps: 1 }]);
    expect(client.requests[0]?.messages.at(-1)).toEqual({ role: 'user', text: 'A message the user queued.' });
    expect(client.requests[1]?.toolChoice).toEqual({ name: 'task_complete' });

    const stopped = loopWith([[STOP]], { onStepBoundary: () => ({ stop: true }) });
    expect(await stopped.loop.runTurn('Go.', signals().both)).toEqual({ interrupted: false });
    expect(stopped.client.requests).toHaveLength(0);
  });

  it('hands the request assembler the transcript, and sends what it builds', async () => {
    const seen: number[] = [];
    const { loop, client } = loopWith([[STOP]], {
      assemble: (input): ModelRequest => {
        seen.push(input.transcript.messages.length);
        return { model: input.model.model, system: [{ text: 'assembled' }], messages: [...input.transcript.messages], tools: [] };
      },
    });
    await loop.runTurn('Go.', signals().both);
    expect(seen).toEqual([1]);
    expect(client.requests[0]?.system).toEqual([{ text: 'assembled' }]);
  });

  it('a cooperative stop lets the step in flight finish and starts no other step', async () => {
    const s = signals();
    const step: ScriptedStep = async function* () {
      yield { type: 'text-delta', text: 'Working' };
      s.stop.abort();
      yield call('r', 'read', { path: '.' });
      yield STOP;
    };
    const { loop, client, events } = loopWith([step, [STOP]]);
    expect(await loop.runTurn('Go.', s.both)).toEqual({ interrupted: true });
    expect(client.requests).toHaveLength(1);
    // The call came after the stop: it never ran, and its result says so.
    expect(eventsOf(events, 'tool_result')[0]?.output).toMatch(/^Interrupted/);
  });

  it('a hard abort ends the stream and the running tools, and the transcript stays a valid conversation', async () => {
    const s = signals();
    const started = deferred();
    const taskTools = fakeTaskTools(['hang'], (_name, _args, signal) => {
      started.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const step: ScriptedStep = async function* (_request, signal) {
      yield call('h', 'hang', {});
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stream aborted')), { once: true }));
    };
    const { loop, store } = loopWith([step], { taskTools });
    const turn = loop.runTurn('Go.', s.both);
    await started.promise;
    s.stop.abort();
    s.hard.abort();
    expect(await turn).toEqual({ interrupted: true });

    const messages = (await store.load()).messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const tool = messages[2];
    expect(tool?.role === 'tool' && tool.results[0]).toMatchObject({ callId: 'h', isError: true });
  });

  it('gives a call left without a result (the process ended) one before the next user message', async () => {
    const { loop, store, client } = loopWith([[STOP]]);
    await store.append({ v: 1, kind: 'session', at: 'then', model: 'openrouter:mock/test', system: SYSTEM });
    await store.append({ v: 1, kind: 'message', at: 'then', step: 1, message: { role: 'user', text: 'First.' } });
    await store.append({
      v: 1, kind: 'message', at: 'then', step: 1,
      message: { role: 'assistant', text: '', toolCalls: [{ id: 'cut', name: 'read', arguments: { path: '.' }, rawArguments: '{}' }] },
    });
    await loop.runTurn('Go on.', signals().both);

    const sent = client.requests[0]?.messages ?? [];
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    const tool = sent[2];
    expect(tool?.role === 'tool' && tool.results[0]).toMatchObject({ callId: 'cut', isError: true });
    // The session line is not written twice on a resume.
    expect(store.entries.filter((entry) => entry.kind === 'session')).toHaveLength(1);
  });

  it('a failed stream throws, keeping the results of the calls that already ran', async () => {
    const step: ScriptedStep = async function* () {
      yield call('r', 'read', { path: '.' });
      throw new ModelError({ kind: 'fatal', message: 'the provider fell over' });
    };
    const { loop, store } = loopWith([step]);
    await expect(loop.runTurn('Go.', signals().both)).rejects.toThrow('the provider fell over');
    expect((await store.load()).messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('hides what is held from every event and every transcript line (ADR-0061)', async () => {
    const held = new HeldSecrets();
    held.hold('sk-secret-value-123456');
    const taskTools = fakeTaskTools(['leak'], async () => ({ text: 'the key is sk-secret-value-123456' }));
    const { loop, store, events } = loopWith([[{ type: 'text-delta', text: 'echo sk-secret-value-123456' }, call('l', 'leak', {}), STOP], [STOP]], {
      taskTools,
      hide: (value) => held.hideIn(value),
    });
    await loop.runTurn('Go.', signals().both);

    expect(JSON.stringify(events)).not.toContain('sk-secret-value-123456');
    expect(JSON.stringify(store.entries)).not.toContain('sk-secret-value-123456');
  });
});

describe('stepFailure', () => {
  it('routes a usage limit as a pause and anything else as a failure', () => {
    const resetsAt = Date.UTC(2030, 0, 1);
    expect(stepFailure(new ModelError({ kind: 'usage-limit', message: 'quota', resetsAt }))).toEqual({
      type: 'error', message: 'quota', usageLimit: { resetsAt: new Date(resetsAt).toISOString() },
    });
    expect(stepFailure(new ModelError({ kind: 'usage-limit', message: 'quota' }))).toEqual({ type: 'error', message: 'quota', usageLimit: {} });
    expect(stepFailure(new ModelError({ kind: 'auth', message: 'bad key' }))).toMatchObject({ type: 'error', message: expect.stringContaining('bad key'), usageLimit: false });
    expect(stepFailure('plain')).toEqual({ type: 'error', message: 'plain' });
  });
});
