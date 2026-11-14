import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelError } from '../ModelError';
import { DEFAULT_RETRY_POLICY, retryDelay, withRetry, type RetryNotice } from '../retry';
import type { ModelClient, ModelEvent } from '../types';
import { BASE_REQUEST } from './replay';

const transient = () => new ModelError({ kind: 'transient', message: 'overloaded', status: 503 });
const unreachable = () => new ModelError({ kind: 'transient', message: 'ECONNREFUSED', network: true });
const MIDDLE = () => 0.5;

describe('retryDelay', () => {
  it('doubles from 2 s and caps each gap at 10 s', () => {
    const gaps = [1, 2, 3, 4, 5].map((attempt) => retryDelay(transient(), attempt, 0, DEFAULT_RETRY_POLICY, MIDDLE));
    expect(gaps).toEqual([2000, 4000, 8000, 10000, 10000]);
  });

  it('spreads each gap by the jitter, never past the cap', () => {
    expect(retryDelay(transient(), 1, 0, DEFAULT_RETRY_POLICY, () => 0)).toBe(1600);
    expect(retryDelay(transient(), 1, 0, DEFAULT_RETRY_POLICY, () => 1)).toBe(2400);
    expect(retryDelay(transient(), 4, 0, DEFAULT_RETRY_POLICY, () => 1)).toBe(10000);
  });

  it('waits at least as long as Retry-After asks, up to 15 minutes', () => {
    const asked = (retryAfterMs: number) => new ModelError({ kind: 'rate-limited', message: 'slow down', retryAfterMs });
    expect(retryDelay(asked(500), 1, 0, DEFAULT_RETRY_POLICY, MIDDLE)).toBe(2000);
    expect(retryDelay(asked(45_000), 1, 0, DEFAULT_RETRY_POLICY, MIDDLE)).toBe(45_000);
    expect(retryDelay(asked(3_600_000), 1, 0, DEFAULT_RETRY_POLICY, MIDDLE)).toBe(900_000);
  });

  it('gives up after the last attempt for a failure the provider answered', () => {
    expect(retryDelay(transient(), DEFAULT_RETRY_POLICY.maxAttempts - 1, 0)).toBeDefined();
    expect(retryDelay(transient(), DEFAULT_RETRY_POLICY.maxAttempts, 0)).toBeUndefined();
  });

  it('keeps retrying an unreachable provider until its window closes, past the attempt bound', () => {
    expect(retryDelay(unreachable(), 40, 299_000)).toBe(10000 * (1 + 0.2 * (2 * 0.5 - 1)));
    expect(retryDelay(unreachable(), 40, 300_000)).toBeUndefined();
  });

  it.each(['usage-limit', 'context-overflow', 'auth', 'bad-request', 'fatal'] as const)('does not retry %s', (kind) => {
    expect(retryDelay(new ModelError({ kind, message: kind }), 1, 0)).toBeUndefined();
  });
});

/** A client whose attempts follow a script: each entry fails with an error, or streams events. */
function scripted(...attempts: Array<ModelError | Error | ModelEvent[] | { events: ModelEvent[]; then: Error }>) {
  let calls = 0;
  const client: ModelClient = {
    provider: 'groq',
    dialect: 'chat-completions',
    async *stream() {
      const step = attempts[calls++];
      if (step === undefined) throw new Error('No attempt left in the script');
      if (step instanceof Error) throw step;
      const events = Array.isArray(step) ? step : step.events;
      for (const event of events) yield event;
      if (!Array.isArray(step)) throw step.then;
    },
  };
  return { client, calls: () => calls };
}

const DONE: ModelEvent[] = [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: 'stop' }];

async function drain(client: ModelClient, signal?: AbortSignal): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of client.stream(BASE_REQUEST, signal)) events.push(event);
  return events;
}

describe('withRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sleeps each gap before the next attempt, then streams the one that worked', async () => {
    const { client, calls } = scripted(transient(), transient(), transient(), DONE);
    const notices: RetryNotice[] = [];
    const run = drain(withRetry(client, { random: MIDDLE, onRetry: (n) => notices.push(n) }));

    await vi.advanceTimersByTimeAsync(1999);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(run).resolves.toEqual(DONE);
    expect(notices.map((n) => [n.attempt, n.delayMs])).toEqual([[1, 2000], [2, 4000], [3, 8000]]);
  });

  it('honours a Retry-After longer than its own gap', async () => {
    const { client, calls } = scripted(new ModelError({ kind: 'rate-limited', message: 'slow', status: 429, retryAfterMs: 30_000 }), DONE);
    const run = drain(withRetry(client, { random: MIDDLE }));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toEqual(DONE);
  });

  it('rethrows the last failure once the attempts run out', async () => {
    const errors = Array.from({ length: 3 }, transient);
    const { client, calls } = scripted(...errors);
    const run = drain(withRetry(client, { random: MIDDLE, policy: { maxAttempts: 3 } }));
    const settled = expect(run).rejects.toBe(errors[2]);
    await vi.advanceTimersByTimeAsync(6000);
    await settled;
    expect(calls()).toBe(3);
  });

  it('retries an unreachable provider for its whole window, then gives up', async () => {
    let clock = 0;
    const errors = Array.from({ length: 40 }, unreachable);
    const { client, calls } = scripted(...errors);
    const run = drain(withRetry(client, { random: MIDDLE, now: () => clock }));
    const settled = expect(run).rejects.toBeInstanceOf(ModelError);
    while (clock < 300_000) {
      await vi.advanceTimersByTimeAsync(1000);
      clock += 1000;
    }
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    // Far past the six attempts an answered failure gets.
    expect(calls()).toBeGreaterThan(DEFAULT_RETRY_POLICY.maxAttempts);
  });

  it('never retries once output reached the caller', async () => {
    const midway = transient();
    const { client, calls } = scripted({ events: [{ type: 'text-delta', text: 'half' }], then: midway }, DONE);
    const seen: ModelEvent[] = [];
    await expect((async () => { for await (const e of withRetry(client).stream(BASE_REQUEST)) seen.push(e); })()).rejects.toBe(midway);
    expect(seen).toEqual([{ type: 'text-delta', text: 'half' }]);
    expect(calls()).toBe(1);
  });

  it('passes through a failure it does not own without retrying', async () => {
    const auth = new ModelError({ kind: 'auth', message: 'bad key', status: 401 });
    const bug = new TypeError('not a model failure');
    for (const err of [auth, bug]) {
      const { client, calls } = scripted(err, DONE);
      await expect(drain(withRetry(client))).rejects.toBe(err);
      expect(calls()).toBe(1);
    }
  });

  it('stops sleeping when the signal aborts, with its reason', async () => {
    const { client, calls } = scripted(transient(), DONE);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const run = drain(withRetry(client, { random: MIDDLE }), controller.signal);
    const settled = expect(run).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(reason);
    await settled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls()).toBe(1);
  });

  it('keeps the wrapped client\'s provider and dialect', () => {
    const wrapped = withRetry(scripted().client);
    expect([wrapped.provider, wrapped.dialect]).toEqual(['groq', 'chat-completions']);
  });
});
