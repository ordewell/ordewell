import { describe, expect, it } from 'vitest';
import type { AiProvider } from '../../../interfaces/IConfig';
import { createModelClient } from '../createModelClient';
import { ModelError } from '../ModelError';
import { DEFAULT_STREAM_TIMEOUTS, withStreamTimeouts } from '../streamTimeouts';
import type { ModelClient, ModelEvent, ModelRequest } from '../types';
import { BASE_REQUEST, fixture } from './replay';

const SHORT = { firstEventMs: 300, idleMs: 60 };

/** A client that streams `events`, a `wait` entry pausing that long, then waits for its abort when told to hang. */
function client(steps: Array<ModelEvent | { wait: number }>, hang: boolean): ModelClient & { aborted: () => unknown } {
  let reason: unknown;
  return {
    provider: 'openrouter',
    dialect: 'chat-completions',
    aborted: () => reason,
    async *stream(_request: ModelRequest, signal?: AbortSignal) {
      for (const step of steps) {
        if ('wait' in step) await new Promise((resolve) => setTimeout(resolve, step.wait));
        else yield step;
      }
      if (!hang) return;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reason = signal.reason;
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
}

async function run(stream: AsyncIterable<ModelEvent>): Promise<{ events: ModelEvent[]; error?: unknown; ms: number }> {
  const events: ModelEvent[] = [];
  const started = Date.now();
  try {
    for await (const event of stream) events.push(event);
  } catch (error) {
    return { events, error, ms: Date.now() - started };
  }
  return { events, ms: Date.now() - started };
}

const TEXT: ModelEvent = { type: 'text-delta', text: 'Half' };

describe('withStreamTimeouts', () => {
  it('waits longer for the first event than between events', () => {
    expect(DEFAULT_STREAM_TIMEOUTS.firstEventMs).toBeGreaterThan(DEFAULT_STREAM_TIMEOUTS.idleMs);
  });

  it('abandons a stream that goes quiet after a few events, as a transient failure, aborting its request', async () => {
    const inner = client([TEXT, TEXT], true);
    const { events, error, ms } = await run(withStreamTimeouts(inner, SHORT).stream(BASE_REQUEST));
    expect(events).toEqual([TEXT, TEXT]);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ kind: 'transient', message: expect.stringContaining('sent nothing for 0.06 s') });
    expect((error as ModelError).network).toBeUndefined();
    // The idle allowance, not the first event's.
    expect(ms).toBeLessThan(SHORT.firstEventMs);
    expect(inner.aborted()).toBe(error);
  });

  it('abandons a stream that never sends a first event, after the longer allowance', async () => {
    const inner = client([], true);
    const { events, error, ms } = await run(withStreamTimeouts(inner, SHORT).stream(BASE_REQUEST));
    expect(events).toEqual([]);
    expect(error).toMatchObject({ kind: 'transient', message: expect.stringContaining('no first event within 0.3 s') });
    expect(ms).toBeGreaterThanOrEqual(SHORT.firstEventMs - 5);
  });

  it('lets a slow first event and a steady stream through, each event restarting the clock', async () => {
    const inner = client([{ wait: 150 }, TEXT, { wait: 40 }, TEXT, { wait: 40 }, TEXT, { wait: 40 }, TEXT], false);
    const { events, error } = await run(withStreamTimeouts(inner, SHORT).stream(BASE_REQUEST));
    expect(error).toBeUndefined();
    expect(events).toHaveLength(4);
  });

  it('passes the caller\'s abort through with its own reason', async () => {
    const inner = client([TEXT], true);
    const stop = new AbortController();
    const reason = new Error('stopped');
    const running = run(withStreamTimeouts(inner, { firstEventMs: 10_000, idleMs: 10_000 }).stream(BASE_REQUEST, stop.signal));
    setTimeout(() => stop.abort(reason), 20);
    const { error } = await running;
    expect(error).toBe(reason);
  });

  it('ends the request when the caller stops reading', async () => {
    const inner = client([TEXT, TEXT, TEXT], false);
    let returned = false;
    const tracked: ModelClient = {
      ...inner,
      stream: (request, signal) => {
        const events = inner.stream(request, signal)[Symbol.asyncIterator]();
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => events.next(),
            return: async () => {
              returned = true;
              return events.return ? events.return() : { done: true, value: undefined };
            },
          }),
        };
      },
    };
    for await (const event of withStreamTimeouts(tracked, SHORT).stream(BASE_REQUEST)) {
      expect(event).toEqual(TEXT);
      break;
    }
    expect(returned).toBe(true);
  });
});

/** A dialect's recorded stream, served up to `blocks` of its events, whose body then never ends until the request is aborted. */
function stalling(body: string, blocks: number): typeof globalThis.fetch {
  const events = body.split(/\n\n/).filter((block) => block.trim() !== '').slice(0, blocks);
  return async (_input, init) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(new TextEncoder().encode(`${event}\n\n`));
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

const DIALECTS: Array<{ provider: AiProvider; dialect: string }> = [
  { provider: 'openrouter', dialect: 'chat-completions' },
  { provider: 'openai', dialect: 'responses' },
  { provider: 'anthropic', dialect: 'anthropic-messages' },
  { provider: 'google', dialect: 'gemini' },
];

describe('createModelClient\'s stream timeouts', () => {
  it.each(DIALECTS)('cut a $dialect stream that stops part way', async ({ provider, dialect }) => {
    const body = fixture(dialect, 'text.sse');
    const all = body.split(/\n\n/).filter((block) => block.trim() !== '').length;
    const model = createModelClient({ provider, apiKey: 'k', fetch: stalling(body, Math.max(1, all - 2)), timeouts: SHORT });
    const { events, error } = await run(model.stream(BASE_REQUEST));
    expect(events.some((event) => event.type === 'text-delta'), dialect).toBe(true);
    expect(error, dialect).toMatchObject({ kind: 'transient', message: expect.stringContaining('sent nothing') });
  });

  it.each(DIALECTS)('cut a $dialect stream that sends no event at all', async ({ provider }) => {
    const model = createModelClient({ provider, apiKey: 'k', fetch: stalling('', 0), timeouts: SHORT });
    const { events, error } = await run(model.stream(BASE_REQUEST));
    expect(events).toEqual([]);
    expect(error).toMatchObject({ kind: 'transient', message: expect.stringContaining('no first event') });
  });

  it('counts events, not bytes: a keepalive comment does not hold a quiet stream open', async () => {
    const keepalive: typeof globalThis.fetch = async (_input, init) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // What OpenRouter sends while its upstream is busy.
          timer = setInterval(() => controller.enqueue(new TextEncoder().encode(': OPENROUTER PROCESSING\n\n')), 10);
          init?.signal?.addEventListener('abort', () => {
            clearInterval(timer);
            controller.error(init.signal?.reason);
          }, { once: true });
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const model = createModelClient({ provider: 'openrouter', apiKey: 'k', fetch: keepalive, timeouts: SHORT });
    const { error } = await run(model.stream(BASE_REQUEST));
    expect(error).toMatchObject({ kind: 'transient', message: expect.stringContaining('no first event') });
  });
});
