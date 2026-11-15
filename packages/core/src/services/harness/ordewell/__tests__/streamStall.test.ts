import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../AgentAdapter';
import { withRetry, withStreamTimeouts, type ModelEvent, type ModelRequest } from '../../../model';
import { defaultModelInfo } from '../models';
import { OrdewellLoop } from '../loop';
import { scratch } from '../tools/__tests__/helpers';
import { call, eventsOf, fakeTaskTools, MemoryTranscriptStore, scriptedClient, STOP, type ScriptedStep } from './loopKit';

// A stall the client's timeouts cut, retried at once, end to end through the loop (ADR-0070).
const TIMEOUTS = { firstEventMs: 200, idleMs: 50 };
const FAST = { policy: { initialDelayMs: 1, maxDelayMs: 1, jitter: 0 } };

/** A stream that sends `events` and then nothing, until its request is aborted. */
function stallAfter(events: readonly ModelEvent[]): ScriptedStep {
  return async function* (_request: ModelRequest, signal: AbortSignal) {
    yield* events;
    await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
}

const DONE = call('done', 'task_complete', { status: 'done', summary: 'Fixed it.', commit: { subject: 'Fix the bug' } });

function loopWith(steps: readonly ScriptedStep[], taskNames: readonly string[] = ['task_complete']) {
  const { worktree, outputDir } = scratch();
  const store = new MemoryTranscriptStore();
  const scripted = scriptedClient(steps);
  const events: AgentEvent[] = [];
  // As the adapter wires it: the timeouts inside the client, withRetry over them.
  const client = withRetry(withStreamTimeouts(scripted, TIMEOUTS), {
    ...FAST,
    onRetry: ({ attempt }) => events.push({ type: 'command_output', text: `retry ${attempt} before any event` }),
  });
  const taskTools = fakeTaskTools(taskNames, async (name, args) => {
    if (name === 'probe') return { text: 'probe ran' };
    const commit = (args as { commit?: unknown }).commit;
    return typeof commit === 'string'
      ? { text: "Invocation error: task_complete rejected the call before it ran; nothing changed. parameter parsing failed: 'commit' expected object, the call sent string", isError: true }
      : { text: 'Recorded.' };
  });
  const loop = new OrdewellLoop({
    client,
    model: defaultModelInfo('openrouter', 'mock/test'),
    system: [{ text: 'You are a test agent.' }],
    store,
    taskTools,
    toolContext: { worktree, outputDir, env: process.env },
    hide: (value) => value,
    emit: (event) => events.push(event),
    retry: FAST,
  });
  const run = () => {
    const stop = new AbortController();
    const hard = new AbortController();
    return loop.runTurn('Fix the bug.', { stop: stop.signal, hard: hard.signal });
  };
  return { run, store, requests: scripted.requests, events, taskTools };
}

describe('a stalled model stream', () => {
  it('that stops after a few events is cut, and the step sent again, before the task completes', async () => {
    const { run, store, requests, events, taskTools } = loopWith([
      stallAfter([{ type: 'text-delta', text: 'Half a ' }, { type: 'text-delta', text: 'reply' }]),
      [{ type: 'text-delta', text: 'Done.' }, DONE, STOP],
      [STOP],
    ]);
    await expect(run()).resolves.toEqual({ interrupted: false });

    expect(requests).toHaveLength(3);
    // The resend is the same request: the partial reply was dropped.
    expect(requests[1]?.messages).toEqual(requests[0]?.messages);
    const note = eventsOf(events, 'command_output').map((e) => e.text);
    expect(note).toEqual([expect.stringMatching(/sent nothing for 0\.05 s.*The step is sent again in 0\.0 s \(retry 1\)/)]);
    expect(eventsOf(events, 'assistant_text').map((e) => e.runId)).toEqual(['step-1', 'step-1.2']);
    expect(JSON.stringify((await store.load()).messages)).not.toContain('Half a reply');
    expect(taskTools.calls).toEqual([{ name: 'task_complete', args: expect.objectContaining({ status: 'done' }) }]);
  });

  it('that never sends a first event is sent again by the client, before the task completes', async () => {
    const { run, requests, events, taskTools } = loopWith([stallAfter([]), [DONE, STOP], [STOP]]);
    await expect(run()).resolves.toEqual({ interrupted: false });

    expect(requests).toHaveLength(3);
    expect(requests[1]?.messages).toEqual(requests[0]?.messages);
    expect(eventsOf(events, 'command_output').map((e) => e.text)).toEqual(['retry 1 before any event']);
    expect(taskTools.calls).toHaveLength(1);
  });

  it('after a tool call ran does not run that call again: its result is kept and the next step goes on from it', async () => {
    const { run, store, requests, events, taskTools } = loopWith([
      stallAfter([{ type: 'text-delta', text: 'Probing.' }, call('p', 'probe', {}), { type: 'text-delta', text: ' Now' }]),
      [DONE, STOP],
      [STOP],
    ], ['probe', 'task_complete']);
    await expect(run()).resolves.toEqual({ interrupted: false });

    expect(taskTools.calls.map((c) => c.name)).toEqual(['probe', 'task_complete']);
    expect(requests).toHaveLength(3);
    const next = requests[1]?.messages ?? [];
    expect(next.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const tool = next[2];
    expect(tool?.role === 'tool' && tool.results.map((r) => [r.callId, r.output])).toEqual([['p', 'probe ran']]);
    expect(eventsOf(events, 'command_output').map((e) => e.text)).toEqual([
      expect.stringContaining('Its 1 finished tool call and their results are kept, and the next step goes on from them'),
    ]);
    expect((await store.load()).messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('after a rejected task_complete, as the qwen3-coder smoke showed, is retried and the corrected call completes the task', async () => {
    // Step 5 of the smoke: the commit sent as the model's own markup, refused before it ran, then text.
    const rejected = call('bad', 'task_complete', { status: 'done', summary: 'Fixed it.', commit: '<parameter=subject>\nFix the bug' });
    const { run, requests, events, taskTools } = loopWith([
      [rejected, { type: 'text-delta', text: 'Perfect! The test now passes. Let me summarize what I did:' }, STOP],
      // Step 6's stream: sent, then silent.
      stallAfter([]),
      stallAfter([{ type: 'text-delta', text: 'Let me retry' }]),
      [DONE, STOP],
      [STOP],
    ]);
    await expect(run()).resolves.toEqual({ interrupted: false });

    const second = requests[1]?.messages ?? [];
    const refusal = second.at(-1);
    expect(refusal?.role === 'tool' && refusal.results[0]).toMatchObject({ callId: 'bad', isError: true });
    // Both resends, the client's before any event and the loop's after one, send step 6 again unchanged.
    expect(requests.slice(2, 4).map((r) => r.messages)).toEqual([second, second]);
    expect(eventsOf(events, 'command_output')).toHaveLength(2);
    expect(taskTools.calls.map((c) => typeof (c.args as { commit?: unknown }).commit)).toEqual(['string', 'object']);
  });
});
