import { describe, it, expect, vi, afterEach } from 'vitest';
import { JsonRpcPeer, JsonRpcError, type RpcResponse } from '../jsonRpc';

function connection() {
  const written: Array<Record<string, unknown>> = [];
  const peer = new JsonRpcPeer((payload) => written.push(payload as Record<string, unknown>));
  return { peer, written };
}

const noEmit = () => {};

afterEach(() => vi.useRealTimers());

describe('JsonRpcPeer', () => {
  it('answers a request of the other side under a string id, as a result or as an error', () => {
    const { peer, written } = connection();
    peer.respond('abc', { ok: 1 });
    peer.respondError('def', -32000, 'signed out');
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 'abc', result: { ok: 1 } },
      { jsonrpc: '2.0', id: 'def', error: { code: -32000, message: 'signed out' } },
    ]);
  });

  it('sends a notification with no id, and drops one after close', () => {
    const { peer, written } = connection();
    peer.notify('session/cancel', { sessionId: 's1' });
    peer.notify('initialized');
    peer.close('gone');
    peer.notify('session/cancel', { sessionId: 's1' });
    expect(written).toEqual([
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } },
      { jsonrpc: '2.0', method: 'initialized', params: {} },
    ]);
  });

  it('routes an incoming request to its handler and answers with the result under the same id', () => {
    const { peer, written } = connection();
    const seen: unknown[] = [];
    peer.onRequest('session/request_permission', (params, ctx) => {
      seen.push([params, ctx.id, ctx.method]);
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    });

    expect(peer.dispatch({ id: 'perm-1', method: 'session/request_permission', params: { toolCall: 'x' } }, noEmit)).toBe(true);
    expect(seen).toEqual([[{ toolCall: 'x' }, 'perm-1', 'session/request_permission']]);
    expect(written).toEqual([{ jsonrpc: '2.0', id: 'perm-1', result: { outcome: { outcome: 'selected', optionId: 'allow' } } }]);
  });

  it('hands a handler the emitter of the line that carried the request, and no params as an empty object', () => {
    const { peer } = connection();
    const emit = () => {};
    let given: unknown;
    let params: unknown;
    peer.onRequest('fs/read_text_file', (p, ctx) => { given = ctx.emit; params = p; return {}; });
    peer.dispatch({ id: 3, method: 'fs/read_text_file' }, emit);
    expect(given).toBe(emit);
    expect(params).toEqual({});
  });

  it('answers an unknown method -32601', () => {
    const { peer, written } = connection();
    expect(peer.dispatch({ id: 9, method: 'terminal/create', params: {} }, noEmit)).toBe(true);
    expect(written).toEqual([{ jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'Method not found: terminal/create' } }]);
  });

  it('answers with the error a handler returns or throws, and -32603 for any other throw', () => {
    const { peer, written } = connection();
    peer.onRequest('a', () => new JsonRpcError(-32602, 'bad params'));
    peer.onRequest('b', () => { throw new JsonRpcError(-32000, 'signed out'); });
    peer.onRequest('c', () => { throw new Error('boom'); });
    peer.dispatch({ id: 1, method: 'a' }, noEmit);
    peer.dispatch({ id: 2, method: 'b' }, noEmit);
    peer.dispatch({ id: 3, method: 'c' }, noEmit);
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } },
      { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'signed out' } },
      { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'boom' } },
    ]);
  });

  it('answers once an asynchronous handler settles, and not at all when the peer closed meanwhile', async () => {
    const { peer, written } = connection();
    let release: (value: Record<string, unknown>) => void = () => {};
    peer.onRequest('slow', () => new Promise((resolve) => { release = resolve; }));
    peer.onRequest('rejects', () => Promise.reject(new JsonRpcError(-32001, 'refused')));
    peer.dispatch({ id: 1, method: 'slow' }, noEmit);
    peer.dispatch({ id: 2, method: 'rejects' }, noEmit);
    expect(written).toEqual([]);

    release({ done: true });
    await vi.waitFor(() => expect(written).toHaveLength(2));
    expect(written).toEqual(expect.arrayContaining([
      { jsonrpc: '2.0', id: 1, result: { done: true } },
      { jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'refused' } },
    ]));

    peer.onRequest('late', () => new Promise((resolve) => setTimeout(() => resolve({}), 0)));
    peer.dispatch({ id: 3, method: 'late' }, noEmit);
    peer.close('gone');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(written).toHaveLength(2);
  });

  it('routes a notification to its handler, and leaves an unrouted one to the caller', () => {
    const { peer, written } = connection();
    const seen: unknown[] = [];
    peer.onNotification('session/update', (params) => { seen.push(params); });
    expect(peer.dispatch({ method: 'session/update', params: { n: 1 } }, noEmit)).toBe(true);
    expect(peer.dispatch({ method: 'something/else' }, noEmit)).toBe(false);
    expect(seen).toEqual([{ n: 1 }]);
    expect(written).toEqual([]);
  });

  it('handles a notification before the response that follows it, in wire order', () => {
    const { peer } = connection();
    const order: string[] = [];
    peer.onNotification('session/update', () => { order.push('update'); });
    peer.send('session/prompt', {}, () => order.push('prompt answered'));
    peer.dispatch({ method: 'session/update', params: {} }, noEmit);
    peer.dispatch({ id: 1, result: { stopReason: 'end_turn' } }, noEmit);
    expect(order).toEqual(['update', 'prompt answered']);
  });

  it('gives up waiting on timeout but keeps the slot: the late reply is discarded without a word', async () => {
    vi.useFakeTimers();
    const { peer } = connection();
    const answers: RpcResponse[] = [];
    const waited = peer.call('initialize', {}, { timeoutMs: 1000 });
    void waited.then((r) => answers.push(r));

    await vi.advanceTimersByTimeAsync(1000);
    expect(answers).toEqual([{ ok: false, closed: false, timedOut: true, message: 'No answer to initialize within 1000 ms.' }]);

    expect(peer.dispatch({ id: 1, result: {} }, noEmit)).toBe(true);
    expect(peer.dispatch({ id: 1, result: {} }, noEmit)).toBe(true);
    expect(answers).toHaveLength(1);
  });

  it('does not time out a request that was answered in time', async () => {
    vi.useFakeTimers();
    const { peer } = connection();
    const answers: RpcResponse[] = [];
    void peer.call('initialize', {}, { timeoutMs: 1000 }).then((r) => answers.push(r));
    peer.dispatch({ id: 1, result: { v: 1 } }, noEmit);
    await vi.advanceTimersByTimeAsync(5000);
    expect(answers).toEqual([{ ok: true, result: { v: 1 } }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never treats a response under an unknown id as fatal', () => {
    const { peer, written } = connection();
    expect(peer.dispatch({ id: 404, result: {} }, noEmit)).toBe(true);
    expect(peer.dispatch({ id: 'nobody', error: { code: -32603, message: 'oneshot canceled' } }, noEmit)).toBe(true);
    expect(written).toEqual([]);
  });

  it('claims a message with no id and no method for no one', () => {
    const { peer } = connection();
    expect(peer.dispatch({ error: { code: -32700, message: 'parse error' } }, noEmit)).toBe(false);
  });

  it('rejects every pending request when it closes, and fails later ones without a write', async () => {
    const { peer, written } = connection();
    const first = peer.call('session/new', {});
    const second = peer.call('session/prompt', {}, { timeoutMs: 60_000 });
    const sent = written.length;

    peer.close('process ended');
    await expect(first).resolves.toEqual({ ok: false, closed: true, message: 'process ended' });
    await expect(second).resolves.toEqual({ ok: false, closed: true, message: 'process ended' });
    await expect(peer.call('session/cancel', {})).resolves.toMatchObject({ ok: false, closed: true });
    expect(written).toHaveLength(sent);
  });

  it('routes $/cancel_request to the handler of the request its requestId names, as ACP v1 publishes it', () => {
    const { peer, written } = connection();
    const signals = new Map<string | number, AbortSignal>();
    peer.onRequest('session/request_permission', (_params, ctx) => {
      signals.set(ctx.id, ctx.cancelled);
      return new Promise(() => {});
    });
    peer.dispatch({ id: 'p1', method: 'session/request_permission' }, noEmit);
    peer.dispatch({ id: 7, method: 'session/request_permission' }, noEmit);

    expect(peer.dispatch({ method: '$/cancel_request', params: { requestId: 'p1' } }, noEmit)).toBe(true);
    expect(signals.get('p1')?.aborted).toBe(true);
    expect(signals.get(7)?.aborted).toBe(false);
    expect(written).toEqual([]);
  });

  it('ignores a $/cancel_request that names no request in flight, or one already answered', () => {
    const { peer } = connection();
    let signal: AbortSignal | undefined;
    peer.onRequest('x', (_p, ctx) => { signal = ctx.cancelled; return {}; });
    peer.dispatch({ id: 1, method: 'x' }, noEmit);
    expect(peer.dispatch({ method: '$/cancel_request', params: { requestId: 1 } }, noEmit)).toBe(true);
    expect(peer.dispatch({ method: '$/cancel_request', params: { requestId: 'nope' } }, noEmit)).toBe(true);
    expect(peer.dispatch({ method: '$/cancel_request' }, noEmit)).toBe(true);
    expect(signal?.aborted).toBe(false);
  });

  it('cancels the requests in flight when it closes', () => {
    const { peer } = connection();
    let signal: AbortSignal | undefined;
    peer.onRequest('x', (_p, ctx) => { signal = ctx.cancelled; return new Promise(() => {}); });
    peer.dispatch({ id: 1, method: 'x' }, noEmit);
    peer.close('gone');
    expect(signal?.aborted).toBe(true);
  });
});
