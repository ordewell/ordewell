import type { EffortSent, ModelEvent } from './types';

/**
 * Puts a request's `effort` event ahead of the stream's first event, not ahead
 * of the stream: an adapter learns the effort sent when the HTTP call opens,
 * which is before any data, and `withStreamTimeouts` and `withRetry` take the
 * first event they see as the stream having started, so an event yielded at
 * the open would cut a silently thinking model at the idle allowance and keep
 * a failure before any content from being retried.
 */
export async function* effortBeforeFirst(effort: EffortSent | undefined, events: AsyncIterable<ModelEvent>): AsyncIterable<ModelEvent> {
  let pending = effort;
  for await (const event of events) {
    if (pending) {
      yield pending;
      pending = undefined;
    }
    yield event;
  }
}
