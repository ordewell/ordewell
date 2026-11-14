import { createChatCompletionsClient } from '../model/adapters/chatCompletions';
import { createGeminiClient } from '../model/adapters/gemini';
import type { ModelClient, ModelClientOptions } from '../model';

// The API planner's tests drive it through a real ModelClient adapter whose
// transport is a test's own handler: the handler is given each request's wire
// body and returns the chunks to stream back, so a test scripts a provider at
// the level the provider speaks, and the adapter between them is the shipped
// one. `vi.mock('../model', ...)` swaps `createModelClient` for one of these,
// with no retry around it, so a refused call fails at once.

/** What a handler serves: a whole response (a refusal), or the chunks of a streamed one, each sent as it is yielded. */
export type Served = Response | Iterable<unknown> | AsyncIterable<unknown>;
/** What a handler is told beside the body, as an SDK's `create(body, { signal })` was. */
export interface WireCall { url: string; signal?: AbortSignal }
export type WireHandler = (body: Record<string, unknown>, call: WireCall) => Served | Promise<Served>;

function iterate(chunks: Iterable<unknown> | AsyncIterable<unknown>): AsyncIterator<unknown> {
  if (Symbol.asyncIterator in chunks) return chunks[Symbol.asyncIterator]();
  return (async function* () { yield* chunks; })();
}

/**
 * Each chunk as one SSE `data:` line. The stream errors when the call's signal
 * aborts, as a real body does, so a chunk the test never yields holds a call open until Stop.
 */
function eventStream(chunks: Iterable<unknown> | AsyncIterable<unknown>, signal: AbortSignal | null | undefined, terminator: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const it = iterate(chunks);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => { try { controller.error(signal?.reason); } catch { /* already closed */ } };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    },
    async pull(controller) {
      let next: IteratorResult<unknown>;
      try {
        next = await it.next();
      } catch (err) {
        controller.error(err);
        return;
      }
      if (signal?.aborted) {
        controller.error(signal.reason);
        return;
      }
      if (next.done) {
        if (terminator) controller.enqueue(encoder.encode(terminator));
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
    },
    async cancel() { await it.return?.(); },
  });
}

/**
 * A handler may throw an SDK-style error, `Object.assign(new Error('400 …'), { status, code })`:
 * it is sent as the HTTP refusal it stands for, so the adapter classifies it as
 * it would a provider's. Any other throw is a failed connection.
 */
function refusal(err: unknown): Response | undefined {
  if (!(err instanceof Error)) return undefined;
  const { status, code, type, param } = err as Error & { status?: unknown; code?: unknown; type?: unknown; param?: unknown };
  if (typeof status !== 'number') return undefined;
  const message = err.message.replace(new RegExp(`^${status} `), '');
  return new Response(JSON.stringify({ error: { message, code: code ?? null, type: type ?? null, param: param ?? null } }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

/** Chunks a test scripts with no finish reason end as a provider's stream ends, with `ending`, so a test scripts only what it is about. */
async function* finished(chunks: Iterable<unknown> | AsyncIterable<unknown>, isFinal: (chunk: unknown) => boolean, ending: unknown): AsyncIterable<unknown> {
  let final = false;
  for await (const chunk of chunks) {
    final ||= isFinal(chunk);
    yield chunk;
  }
  if (!final) yield ending;
}

function transport(handler: WireHandler, terminator: string, end: (chunks: Iterable<unknown> | AsyncIterable<unknown>) => AsyncIterable<unknown>): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    const text = typeof init?.body === 'string' ? init.body : '';
    let served: Served;
    try {
      served = await handler(text ? JSON.parse(text) as Record<string, unknown> : {}, { url, signal });
    } catch (err) {
      const refused = refusal(err);
      if (refused) return refused;
      throw err;
    }
    // A handler may stop the call itself, as a test's Stop mid-reply does.
    if (signal?.aborted) throw signal.reason;
    if (served instanceof Response) return served;
    return new Response(eventStream(end(served), signal, terminator), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null) : [];
const chunkField = (chunk: unknown, list: string): Record<string, unknown>[] =>
  typeof chunk === 'object' && chunk !== null ? records((chunk as Record<string, unknown>)[list]) : [];

/** A client for the provider over Chat Completions, whichever dialect it ships on: the planner is blind to dialect, and these chunks are what that wire carries. */
export function overChatCompletions(options: ModelClientOptions, handler: WireHandler): ModelClient {
  return createChatCompletionsClient({
    provider: options.provider,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl || 'https://api.example.test/v1',
    fetch: transport(handler, 'data: [DONE]\n\n', (chunks) => finished(
      chunks,
      (chunk) => chunkField(chunk, 'choices').some((c) => c.finish_reason),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    )),
  });
}

/** A Gemini client whose handler is also told the model each request names, which Gemini puts in the URL. */
export function overGemini(options: ModelClientOptions, handler: (body: Record<string, unknown>, model: string, call: WireCall) => Served | Promise<Served>): ModelClient {
  return createGeminiClient({
    provider: 'google',
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? '',
    fetch: transport(
      (body, call) => handler(body, decodeURIComponent(/\/models\/([^:/?]+)/.exec(call.url)?.[1] ?? ''), call),
      '',
      (chunks) => finished(
        chunks,
        (chunk) => chunkField(chunk, 'candidates').some((c) => c.finishReason),
        { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] },
      ),
    ),
  });
}
