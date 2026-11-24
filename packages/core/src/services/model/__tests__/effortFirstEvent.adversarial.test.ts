import { describe, expect, it } from 'vitest';
import { createChatCompletionsClient } from '../adapters/chatCompletions';
import { withRetry } from '../retry';
import { withStreamTimeouts } from '../streamTimeouts';
import type { ModelEvent, ModelRequest } from '../types';
import { BASE_REQUEST, fixture, replay, type Replay } from './replay';

const TIMEOUTS = { firstEventMs: 2_000, idleMs: 150 };

/** An SSE response whose headers come at once and whose body starts after `delayMs`, as a reasoning model thinking silently. */
function slow(body: string, delayMs: number): () => Response {
  return () => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const client = (t: Replay) => createChatCompletionsClient({ provider: 'openrouter', apiKey: 'sk-test', baseUrl: 'https://api.example.test/v1', fetch: t.fetch });

async function outcome(stream: AsyncIterable<ModelEvent>): Promise<string> {
  const events: ModelEvent[] = [];
  try { for await (const e of stream) events.push(e); } catch (err) { return `threw: ${(err as Error).message}`; }
  return `ok: ${events.map((e) => e.type).join(',')}`;
}

describe('the effort event and the first-event allowance', () => {
  it.each([[undefined], ['high' as const]])('a reply whose first chunk comes after the idle allowance but within the first-event one, effort %s', async (effort) => {
    const t = replay(slow(fixture('chat-completions', 'text.sse'), 600));
    const request: ModelRequest = { ...BASE_REQUEST, ...(effort ? { effort } : {}) };
    expect(await outcome(withStreamTimeouts(client(t), TIMEOUTS).stream(request))).toMatch(/^ok:/);
  });
});

describe('the effort event and withRetry', () => {
  const firstIsError = ': OPENROUTER PROCESSING\n\ndata: {"error":{"code":502,"message":"Provider returned error"}}\n\n';
  it.each([[undefined], ['high' as const]])('a 502 before any content is sent again, effort %s', async (effort) => {
    const t = replay(slow(firstIsError, 0), slow(fixture('chat-completions', 'text.sse'), 0));
    const request: ModelRequest = { ...BASE_REQUEST, ...(effort ? { effort } : {}) };
    const retried = withRetry(client(t), { policy: { initialDelayMs: 0, maxDelayMs: 0 } });
    expect(await outcome(retried.stream(request))).toMatch(/^ok:/);
    expect(t.sent).toHaveLength(2);
  });
});
