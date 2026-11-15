import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelClient, ModelEvent, ModelRequest } from '../types';

// Shared by every dialect's tests: a recorded stream or a refusal, served
// through the adapter's injected fetch, so no test reaches a network.

export function fixture(dialect: string, name: string): string {
  return readFileSync(join(__dirname, 'fixtures', dialect, name), 'utf8');
}

export interface Exchange {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

export interface Replay {
  fetch: typeof globalThis.fetch;
  /** Every request the adapter sent, in order. */
  sent: Exchange[];
}

/** Serves each response in turn, one per request; a function answers lazily, and may throw to fail the connection. */
export function replay(...responses: Array<Response | (() => Response)>): Replay {
  const sent: Exchange[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const text = typeof init?.body === 'string' ? init.body : '';
    sent.push({ url, headers: new Headers(init?.headers), body: text ? JSON.parse(text) as Record<string, unknown> : {} });
    const next = responses.shift();
    if (!next) throw new Error(`No recorded response left for ${url}`);
    return typeof next === 'function' ? next() : next;
  };
  return { fetch, sent };
}

export function sse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

export function refusal(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export async function collect(client: ModelClient, request: ModelRequest, signal?: AbortSignal): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of client.stream(request, signal)) events.push(event);
  return events;
}

/** The thrown value of a stream expected to fail. */
export async function failure(client: ModelClient, request: ModelRequest, signal?: AbortSignal): Promise<unknown> {
  try {
    await collect(client, request, signal);
  } catch (err) {
    return err;
  }
  throw new Error('The stream did not fail');
}

export const BASE_REQUEST: ModelRequest = {
  model: 'test-model',
  system: [{ text: 'You are a coding agent.' }],
  messages: [{ role: 'user', text: 'Run the tests.' }],
  tools: [],
};
