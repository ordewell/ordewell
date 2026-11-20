import { ModelError } from './ModelError';
import type { ModelClient, ModelEvent, ModelRequest } from './types';

/**
 * How long a stream may go without an event before it is abandoned. A stream
 * that stops sending events otherwise holds its step for the SDK's whole
 * request timeout, since every adapter's own retries are off. What counts is a
 * `ModelEvent`, not a byte: OpenRouter sends an SSE comment every half second
 * while the upstream is busy, so a byte-level timer would never fire.
 */
export interface StreamTimeouts {
  /** Before the first event, which a reasoning model can spend thinking with nothing shown. */
  firstEventMs: number;
  /** Between one event and the next. */
  idleMs: number;
}

/**
 * Measured on OpenRouter (bench/live/runner-smoke.mjs, four models): the first
 * event came in under 30 s and no two events were further apart than 16 s.
 * The first allowance leaves room for a reasoning model's silent thinking, the
 * second about four times the widest gap seen; a stall waits out one of them.
 */
export const DEFAULT_STREAM_TIMEOUTS: Readonly<StreamTimeouts> = {
  firstEventMs: 180_000,
  idleMs: 60_000,
};

/**
 * The client, aborting a request whose stream goes quiet past the timeouts and
 * failing it with a transient `ModelError`. Before any event `withRetry` sends
 * the request again; after one, the caller knows what the partial reply did
 * and decides (ADR-0070): the Ordewell loop keeps the tool calls that ran,
 * and the API planner's `streamReply` drops the partial reply and sends again.
 */
export function withStreamTimeouts(client: ModelClient, timeouts: StreamTimeouts = DEFAULT_STREAM_TIMEOUTS): ModelClient {
  return {
    provider: client.provider,
    dialect: client.dialect,
    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
      const local = new AbortController();
      const forward = (): void => local.abort(signal?.reason);
      if (signal?.aborted) forward();
      else signal?.addEventListener('abort', forward, { once: true });
      const events = client.stream(request, local.signal)[Symbol.asyncIterator]();
      let first = true;
      let ended = false;
      try {
        for (;;) {
          const waitMs = first ? timeouts.firstEventMs : timeouts.idleMs;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const quiet = new Promise<'quiet'>((resolve) => {
            timer = setTimeout(() => resolve('quiet'), waitMs);
          });
          let next: IteratorResult<ModelEvent> | 'quiet';
          try {
            next = await Promise.race([events.next(), quiet]);
          } finally {
            clearTimeout(timer);
          }
          if (next === 'quiet') {
            ended = true;
            const error = stalled(first, waitMs);
            // The adapter's pending read rejects with this reason; nothing waits on it any more.
            local.abort(error);
            throw error;
          }
          if (next.done) {
            ended = true;
            return;
          }
          first = false;
          yield next.value;
        }
      } catch (err) {
        ended = true;
        throw err;
      } finally {
        signal?.removeEventListener('abort', forward);
        // The caller stopped reading early: end the request rather than leave it streaming.
        if (!ended) {
          local.abort();
          await events.return?.();
        }
      }
    },
  };
}

function stalled(first: boolean, waitMs: number): ModelError {
  const seconds = waitMs / 1000;
  return new ModelError({
    kind: 'transient',
    message: first
      ? `The model stream sent no first event within ${seconds} s, so the request was abandoned.`
      : `The model stream sent nothing for ${seconds} s, so the request was abandoned.`,
  });
}
