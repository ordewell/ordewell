import { describe, expect, it } from 'vitest';
import { createAnthropicMessagesClient, requestBody } from '../adapters/anthropicMessages';
import { ModelError } from '../ModelError';
import type { ModelEvent, ModelMessage, ModelRequest } from '../types';
import { BASE_REQUEST, collect, failure, fixture, refusal, replay, sse, type Replay } from './replay';

const recorded = (name: string) => sse(fixture('anthropic-messages', name));

function clientFor(transport: Replay) {
  return createAnthropicMessagesClient({ provider: 'anthropic', apiKey: 'sk-ant-test', baseUrl: 'https://api.anthropic.test/v1', fetch: transport.fetch });
}

const TOOLS: ModelRequest['tools'] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'grep', description: 'Search', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
];

const COMPLETE: ModelRequest['tools'] = [...TOOLS, { name: 'task_complete', description: 'Finish', parameters: { type: 'object' } }];

function ofType<T extends ModelEvent['type']>(events: ModelEvent[], type: T): Array<Extract<ModelEvent, { type: T }>> {
  return events.filter((e): e is Extract<ModelEvent, { type: T }> => e.type === type);
}

const breakpoints = (body: unknown) => JSON.stringify(body).split('"cache_control"').length - 1;

function error(type: string, message: string, details?: Record<string, unknown>) {
  return { type: 'error', error: { type, message, ...(details ? { details } : {}) } };
}

describe('anthropic-messages adapter: streams', () => {
  it('streams text, then usage, then a stop', async () => {
    const transport = replay(recorded('text.sse'));
    const events = await collect(clientFor(transport), BASE_REQUEST);
    expect(events).toEqual([
      { type: 'text-delta', text: 'The tests' },
      { type: 'text-delta', text: ' pass.' },
      { type: 'usage', usage: { inputTokens: 1200, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'finish', reason: 'stop' },
    ]);
    const [exchange] = transport.sent;
    // The registered base URL ends in /v1 and the SDK adds its own.
    expect(exchange.url).toBe('https://api.anthropic.test/v1/messages');
    // SDK 1.x authenticates an API key as a bearer token.
    expect(exchange.headers.get('authorization')).toBe('Bearer sk-ant-test');
    expect(exchange.body).toMatchObject({
      model: 'test-model',
      stream: true,
      max_tokens: 32_000,
      system: [{ type: 'text', text: 'You are a coding agent.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Run the tests.' }] }],
    });
    expect(exchange.body.tools).toBeUndefined();
    expect(exchange.body.tool_choice).toBeUndefined();
  });

  it('reassembles parallel tool calls by index, even with their deltas interleaved', async () => {
    const transport = replay(recorded('parallel-tools.sse'));
    const events = await collect(clientFor(transport), { ...BASE_REQUEST, tools: TOOLS });
    expect(ofType(events, 'tool-call-start')).toEqual([
      { type: 'tool-call-start', id: 'toolu_read_a', name: 'read_file' },
      { type: 'tool-call-start', id: 'toolu_grep_b', name: 'grep' },
    ]);
    const deltas = ofType(events, 'tool-call-delta');
    expect(deltas.filter((d) => d.id === 'toolu_read_a').map((d) => d.argumentsDelta).join('')).toBe('{"path":"src/a.ts"}');
    expect(deltas.filter((d) => d.id === 'toolu_grep_b').map((d) => d.argumentsDelta).join('')).toBe('{"pattern":"TODO"}');
    expect(ofType(events, 'tool-call-complete').map((e) => e.call)).toEqual([
      { id: 'toolu_read_a', name: 'read_file', arguments: { path: 'src/a.ts' }, rawArguments: '{"path":"src/a.ts"}' },
      { id: 'toolu_grep_b', name: 'grep', arguments: { pattern: 'TODO' }, rawArguments: '{"pattern":"TODO"}' },
    ]);
    expect(events.slice(-2).map((e) => e.type)).toEqual(['usage', 'finish']);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' });
    expect(transport.sent[0].body).toMatchObject({
      tool_choice: { type: 'auto' },
      tools: [
        { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'grep' },
      ],
    });
  });

  it('counts cache reads and writes in the input and reports each share', async () => {
    const events = await collect(clientFor(replay(recorded('parallel-tools.sse'))), { ...BASE_REQUEST, tools: TOOLS });
    expect(ofType(events, 'usage')[0].usage).toEqual({ inputTokens: 5400, outputTokens: 61, cacheReadTokens: 5120, cacheWriteTokens: 230 });
  });

  it('keeps the start usage a message_delta reports as null', async () => {
    const events = await collect(clientFor(replay(recorded('cache-usage.sse'))), BASE_REQUEST);
    expect(ofType(events, 'usage')[0].usage).toEqual({ inputTokens: 3412, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 3400 });
  });

  it('streams thinking and keeps its signed blocks, in order, as provider state', async () => {
    const events = await collect(clientFor(replay(recorded('thinking.sse'))), { ...BASE_REQUEST, tools: TOOLS, effort: 'high', model: 'claude-opus-5-5' });
    expect(ofType(events, 'thinking-delta').map((e) => e.text)).toEqual(['The user wants', ' the file read.']);
    expect(ofType(events, 'text-delta').map((e) => e.text)).toEqual(['Reading it.']);
    expect(ofType(events, 'usage')[0].usage).toMatchObject({ outputTokens: 90, reasoningTokens: 61 });
    const [state] = ofType(events, 'provider-state');
    expect(state.state).toEqual({
      dialect: 'anthropic-messages',
      data: {
        content: [
          { type: 'thinking', thinking: 'The user wants the file read.', signature: 'EqQBCkYIBxgCc2lnbmVk' },
          { type: 'redacted_thinking', data: 'EmwKAhgB' },
          { type: 'text', text: 'Reading it.' },
          { type: 'tool_use', id: 'toolu_read' },
        ],
      },
    });
    expect(events.map((e) => e.type).slice(-4)).toEqual(['tool-call-complete', 'usage', 'provider-state', 'finish']);
  });

  it('keeps no provider state for a turn that did not think', async () => {
    const events = await collect(clientFor(replay(recorded('text.sse'))), BASE_REQUEST);
    expect(ofType(events, 'provider-state')).toEqual([]);
  });

  it('sends the thinking blocks back, signed and unchanged, with the tool results', async () => {
    const first = await collect(clientFor(replay(recorded('thinking.sse'))), { ...BASE_REQUEST, tools: TOOLS, model: 'claude-opus-5-5', effort: 'high' });
    const [call] = ofType(first, 'tool-call-complete').map((e) => e.call);
    const [state] = ofType(first, 'provider-state');
    const messages: ModelMessage[] = [
      ...BASE_REQUEST.messages,
      { role: 'assistant', text: 'Reading it.', toolCalls: [call], providerState: JSON.parse(JSON.stringify(state.state)) },
      { role: 'tool', results: [{ callId: call.id, name: call.name, output: 'file text' }, { callId: 'toolu_other', name: 'grep', output: '', isError: true }] },
    ];
    const transport = replay(recorded('text.sse'));
    await collect(clientFor(transport), { ...BASE_REQUEST, tools: TOOLS, model: 'claude-opus-5-5', effort: 'high', messages });
    const wire = transport.sent[0].body.messages;
    expect(wire).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Run the tests.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'The user wants the file read.', signature: 'EqQBCkYIBxgCc2lnbmVk' },
          { type: 'redacted_thinking', data: 'EmwKAhgB' },
          { type: 'text', text: 'Reading it.' },
          { type: 'tool_use', id: 'toolu_read', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_read', content: 'file text' },
          { type: 'tool_result', tool_use_id: 'toolu_other', is_error: true },
        ],
      },
    ]);
  });

  it('drops provider state from another dialect and thinking a model cannot take', () => {
    const assistant: ModelMessage = {
      role: 'assistant',
      text: 'Hi.',
      providerState: { dialect: 'chat-completions', data: { content: [{ type: 'thinking', thinking: 'x', signature: 'y' }] } },
    };
    const foreign = requestBody({ ...BASE_REQUEST, model: 'claude-opus-5-5', messages: [...BASE_REQUEST.messages, assistant] });
    expect(foreign.messages[1].content).toEqual([{ type: 'text', text: 'Hi.' }]);

    const signed: ModelMessage = {
      role: 'assistant',
      text: 'Hi.',
      providerState: { dialect: 'anthropic-messages', data: { content: [{ type: 'thinking', thinking: 'x', signature: 'y' }, { type: 'text', text: 'Hi.' }] } },
    };
    const unknown = requestBody({ ...BASE_REQUEST, model: 'some-proxy-model', messages: [...BASE_REQUEST.messages, signed] });
    expect(unknown.messages[1].content).toEqual([{ type: 'text', text: 'Hi.' }]);
    const known = requestBody({ ...BASE_REQUEST, model: 'claude-opus-5-5', messages: [...BASE_REQUEST.messages, signed] });
    expect(known.messages[1].content).toEqual([{ type: 'thinking', thinking: 'x', signature: 'y' }, { type: 'text', text: 'Hi.' }]);
  });

  it('finishes with length on max_tokens and never completes a tool call the limit cut short', async () => {
    const events = await collect(clientFor(replay(recorded('max-tokens.sse'))), { ...BASE_REQUEST, tools: TOOLS });
    expect(ofType(events, 'tool-call-start').map((e) => e.id)).toEqual(['toolu_cut']);
    expect(ofType(events, 'tool-call-complete')).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'length' });
  });

  it('completes the whole tool calls of a reply cut off at max_tokens, and not the one cut short', async () => {
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const body = [
      event('message_start', { message: { id: 'msg_02', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_whole', name: 'grep', input: {} } }),
      event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"pattern":"TODO"}' } }),
      event('content_block_stop', { index: 0 }),
      event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_cut', name: 'write_file', input: {} } }),
      event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts","content":"unfini' } }),
      event('content_block_stop', { index: 1 }),
      event('message_delta', { delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 32000 } }),
      event('message_stop', {}),
    ].join('');
    const events = await collect(clientFor(replay(sse(body))), { ...BASE_REQUEST, tools: TOOLS });
    expect(ofType(events, 'tool-call-complete').map((e) => [e.call.id, e.call.arguments])).toEqual([['toolu_whole', { pattern: 'TODO' }]]);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'length' });
  });

  it('throws a transient error for a stream that ends before a stop reason', async () => {
    const err = await failure(clientFor(replay(recorded('truncated.sse'))), BASE_REQUEST);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('transient');
  });

  it('turns an overloaded error event inside the stream into a transient error', async () => {
    const err = await failure(clientFor(replay(recorded('midstream-error.sse'))), BASE_REQUEST);
    expect(err).toMatchObject({ kind: 'transient', status: 529 });
  });

  it('throws the abort reason when stopped', async () => {
    const controller = new AbortController();
    const reason = new Error('stopped by the user');
    controller.abort(reason);
    expect(await failure(clientFor(replay(recorded('text.sse'))), BASE_REQUEST, controller.signal)).toBe(reason);
  });
});

describe('anthropic-messages adapter: cache breakpoints', () => {
  const system = [{ text: 'stable', cacheBreakpoint: true }, { text: 'also stable' }, { text: 'per run', cacheBreakpoint: true }];

  it('marks the last tool, the marked system parts and the last message', () => {
    const body = requestBody({ ...BASE_REQUEST, system, tools: TOOLS, cache: { afterTools: true, atLastMessage: true } });
    expect(body.tools?.map((t) => 'cache_control' in t)).toEqual([false, true]);
    expect(body.system).toEqual([
      { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'also stable' },
      { type: 'text', text: 'per run', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'Run the tests.', cache_control: { type: 'ephemeral' } }]);
    expect(breakpoints(body)).toBe(4);
  });

  it('never sends more than four, keeping the later system parts', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((text) => ({ text, cacheBreakpoint: true }));
    const body = requestBody({ ...BASE_REQUEST, system: many, tools: TOOLS, cache: { afterTools: true, atLastMessage: true } });
    expect(breakpoints(body)).toBe(4);
    expect(body.system).toMatchObject([{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd', cache_control: {} }, { text: 'e', cache_control: {} }]);
    expect((body.system as unknown[] as object[]).slice(0, 3).some((p) => 'cache_control' in p)).toBe(false);
    expect(breakpoints(requestBody({ ...BASE_REQUEST, system: many }))).toBe(4);
    expect(breakpoints(requestBody({ ...BASE_REQUEST, system: many, tools: TOOLS, cache: { afterTools: true } }))).toBe(4);
  });

  it('sends none unasked, and none after tools when there are none', () => {
    expect(breakpoints(requestBody({ ...BASE_REQUEST, tools: TOOLS }))).toBe(0);
    expect(breakpoints(requestBody({ ...BASE_REQUEST, cache: { afterTools: true } }))).toBe(0);
  });

  it('puts the last-message breakpoint on the final tool result', () => {
    const body = requestBody({
      ...BASE_REQUEST,
      cache: { atLastMessage: true },
      messages: [
        ...BASE_REQUEST.messages,
        { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'grep', arguments: {}, rawArguments: '' }] },
        { role: 'tool', results: [{ callId: 't1', name: 'grep', output: 'a' }, { callId: 't2', name: 'grep', output: 'b' }] },
      ],
    });
    expect(body.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'a' },
      { type: 'tool_result', tool_use_id: 't2', content: 'b', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('skips empty system parts and sends a stand-in for empty turns', () => {
    const body = requestBody({
      ...BASE_REQUEST,
      system: [{ text: '  ', cacheBreakpoint: true }, { text: 'real' }],
      messages: [{ role: 'user', text: '' }, { role: 'assistant', text: '' }, { role: 'user', text: 'go' }],
    });
    expect(body.system).toEqual([{ type: 'text', text: 'real' }]);
    expect(body.messages.map((m) => m.content)).toEqual([
      [{ type: 'text', text: '(empty message)' }],
      [{ type: 'text', text: '(empty reply)' }],
      [{ type: 'text', text: 'go' }],
    ]);
  });
});

describe('anthropic-messages adapter: effort', () => {
  const thinkingOf = (model: string, effort: ModelRequest['effort'], maxOutputTokens?: number) => {
    const body = requestBody({ ...BASE_REQUEST, model, effort, ...(maxOutputTokens ? { maxOutputTokens } : {}) });
    return { thinking: body.thinking, effort: body.output_config?.effort };
  };
  const ADAPTIVE = { type: 'adaptive', display: 'summarized' };

  it('asks an adaptive model for adaptive thinking at the effort it takes', () => {
    expect(thinkingOf('claude-opus-5-5', 'low')).toEqual({ thinking: ADAPTIVE, effort: 'low' });
    expect(thinkingOf('claude-opus-5-5', 'xhigh')).toEqual({ thinking: ADAPTIVE, effort: 'xhigh' });
    expect(thinkingOf('claude-fable-5-1', 'max')).toEqual({ thinking: ADAPTIVE, effort: 'max' });
    expect(thinkingOf('claude-sonnet-5-5', 'medium')).toEqual({ thinking: ADAPTIVE, effort: 'medium' });
    expect(thinkingOf('claude-haiku-5-5', 'high')).toEqual({ thinking: ADAPTIVE, effort: 'high' });
  });

  it('steps down to the nearest level a model takes', () => {
    expect(thinkingOf('claude-opus-4-6', 'xhigh').effort).toBe('high');
    expect(thinkingOf('claude-opus-4-6', 'max').effort).toBe('max');
    expect(thinkingOf('claude-sonnet-4-6', 'max').effort).toBe('high');
    expect(thinkingOf('claude-opus-4-7', 'xhigh').effort).toBe('xhigh');
  });

  it('gives a budget-only model a budget that fits under max_tokens', () => {
    expect(thinkingOf('claude-haiku-4-5', 'low')).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 }, effort: undefined });
    expect(thinkingOf('claude-sonnet-4-5-20250929', 'high').thinking).toEqual({ type: 'enabled', budget_tokens: 10_000 });
    expect(thinkingOf('claude-opus-4-1', 'max').thinking).toEqual({ type: 'enabled', budget_tokens: 32_000 - 1024 });
    expect(thinkingOf('claude-opus-4-20250514', 'max', 8000).thinking).toEqual({ type: 'enabled', budget_tokens: 6976 });
    expect(thinkingOf('claude-3-7-sonnet-20250219', 'medium').thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(thinkingOf('claude-haiku-4-5', 'max', 2000).thinking).toBeUndefined();
  });

  it('leaves the model to its default with no effort, and a model that cannot think alone', () => {
    expect(thinkingOf('claude-opus-5-5', undefined)).toEqual({ thinking: undefined, effort: undefined });
    expect(thinkingOf('claude-haiku-4-5', undefined).thinking).toBeUndefined();
    expect(thinkingOf('claude-3-5-haiku-20241022', 'high')).toEqual({ thinking: undefined, effort: undefined });
    expect(thinkingOf('some-proxy-model', 'high')).toEqual({ thinking: undefined, effort: undefined });
  });
});

describe('anthropic-messages adapter: tool choice', () => {
  const request = (model: string, toolChoice: ModelRequest['toolChoice'], effort: ModelRequest['effort'] = 'high'): ModelRequest => ({
    ...BASE_REQUEST,
    model,
    tools: COMPLETE,
    toolChoice,
    effort,
  });

  it('maps auto, none and required, and forces a named tool natively where thinking can be switched off', () => {
    expect(requestBody(request('claude-opus-4-8', 'auto')).tool_choice).toEqual({ type: 'auto' });
    expect(requestBody(request('claude-opus-4-8', 'none')).tool_choice).toEqual({ type: 'none' });
    expect(requestBody(request('claude-opus-4-8', 'required')).tool_choice).toEqual({ type: 'any' });
    const forced = requestBody(request('claude-opus-4-8', { name: 'task_complete' }));
    expect(forced.tool_choice).toEqual({ type: 'tool', name: 'task_complete' });
    // The effort asked for would be a 400 beside a disabled thinking config.
    expect(forced.thinking).toEqual({ type: 'disabled' });
    expect(forced.output_config).toBeUndefined();
    expect(forced.tools).toHaveLength(3);
  });

  it('forces natively, with no thinking field, for a model that never thinks', () => {
    const body = requestBody(request('some-proxy-model', { name: 'task_complete' }));
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'task_complete' });
    expect(body.thinking).toBeUndefined();
  });

  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1'])(
    'keeps thinking on and asks for the tool in words on %s, where forcing is refused',
    (model) => {
      const body = requestBody({ ...request(model, { name: 'task_complete' }), cache: { atLastMessage: true } });
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body.output_config).toEqual({ effort: 'high' });
      // The nudge follows the breakpoint, so it never enters the cached prefix.
      expect(body.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Run the tests.', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'Call the `task_complete` tool now.' },
          ],
        },
      ]);
    },
  );

  it('nudges a required choice without naming a tool', () => {
    const body = requestBody(request('claude-opus-5-5', 'required'));
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(JSON.stringify(body.messages)).toContain('Call a tool now.');
  });

  it('retries once without the forced tool when a model refuses it, and remembers', async () => {
    const transport = replay(
      refusal(400, error('invalid_request_error', 'tool_choice: forcing a tool is not supported with this model')),
      recorded('text.sse'),
      recorded('text.sse'),
    );
    const client = clientFor(transport);
    const forced: ModelRequest = { ...BASE_REQUEST, model: 'future-model', tools: COMPLETE, toolChoice: { name: 'task_complete' } };
    await collect(client, forced);
    expect(transport.sent.map((s) => s.body.tool_choice)).toEqual([{ type: 'tool', name: 'task_complete' }, { type: 'auto' }]);
    await collect(client, forced);
    expect(transport.sent[2].body.tool_choice).toEqual({ type: 'auto' });
  });

  it('retries without thinking when a model refuses it, and gives up on a second refusal', async () => {
    const refuse = () => refusal(400, error('invalid_request_error', 'thinking.budget_tokens: not supported'));
    const transport = replay(refuse(), refuse());
    const err = await failure(clientFor(transport), { ...BASE_REQUEST, model: 'claude-haiku-4-5', effort: 'high' });
    expect(err).toMatchObject({ kind: 'bad-request', status: 400 });
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0].body.thinking).toBeDefined();
    expect(transport.sent[1].body.thinking).toBeUndefined();
  });
});

describe('anthropic-messages adapter: errors', () => {
  const fail = (response: Response, request: ModelRequest = BASE_REQUEST) => failure(clientFor(replay(response)), request);

  it('maps a 429 to rate-limited with the retry-after it sent', async () => {
    const err = await fail(refusal(429, error('rate_limit_error', 'Number of request tokens has exceeded your rate limit'), { 'retry-after': '7' }));
    expect(err).toBeInstanceOf(ModelError);
    expect(err).toMatchObject({ kind: 'rate-limited', status: 429, retryAfterMs: 7000 });
  });

  it('reads the anthropic-ratelimit reset header when there is no retry-after', async () => {
    const reset = new Date(Date.now() + 30_000).toISOString();
    const err = (await fail(
      refusal(429, error('rate_limit_error', 'slow down'), {
        'anthropic-ratelimit-tokens-remaining': '0',
        'anthropic-ratelimit-tokens-reset': reset,
        'anthropic-ratelimit-requests-reset': new Date(Date.now() + 5000).toISOString(),
      }),
    )) as ModelError;
    expect(err.kind).toBe('rate-limited');
    expect(err.retryAfterMs).toBeGreaterThan(20_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(30_000);
  });

  it('maps a 429 with no timing to rate-limited without a delay', async () => {
    const err = (await fail(refusal(429, error('rate_limit_error', 'slow down')))) as ModelError;
    expect(err.kind).toBe('rate-limited');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('maps 529 overloaded and a 500 to transient', async () => {
    expect(await fail(refusal(529, error('overloaded_error', 'Overloaded')))).toMatchObject({ kind: 'transient', status: 529 });
    expect(await fail(refusal(500, error('api_error', 'Internal server error')))).toMatchObject({ kind: 'transient', status: 500 });
  });

  it('maps an empty credit balance to a usage limit, whichever way it is reported', async () => {
    const low = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
    expect(await fail(refusal(400, error('invalid_request_error', low)))).toMatchObject({ kind: 'usage-limit', status: 400 });
    expect(await fail(refusal(402, error('billing_error', 'Payment required')))).toMatchObject({ kind: 'usage-limit', status: 402 });
  });

  it('reads when a spend limit resets from the message', async () => {
    const err = await fail(
      refusal(
        400,
        error('invalid_request_error', 'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.', {
          error_code: 'enforced_spend_limit_reached',
        }),
      ),
    );
    expect(err).toMatchObject({ kind: 'usage-limit', resetsAt: Date.UTC(2026, 11, 1), code: 'enforced_spend_limit_reached' });
  });

  it('maps a prompt over the window to context-overflow', async () => {
    expect(await fail(refusal(400, error('invalid_request_error', 'prompt is too long: 215000 tokens > 200000 maximum')))).toMatchObject({
      kind: 'context-overflow',
      status: 400,
    });
    expect(await fail(refusal(400, error('invalid_request_error', 'input length and `max_tokens` exceed context limit: 188240 + 20000 > 200000')))).toMatchObject({
      kind: 'context-overflow',
    });
    expect(await fail(refusal(413, error('request_too_large', 'Request exceeds the maximum allowed number of bytes.')))).toMatchObject({
      kind: 'context-overflow',
      status: 413,
    });
  });

  it('maps 401 and 403 to auth', async () => {
    expect(await fail(refusal(401, error('authentication_error', 'invalid x-api-key')))).toMatchObject({ kind: 'auth', status: 401 });
    expect(await fail(refusal(403, error('permission_error', 'not allowed')))).toMatchObject({ kind: 'auth', status: 403 });
  });

  it('maps another 400 to bad-request', async () => {
    expect(await fail(refusal(400, error('invalid_request_error', 'messages: text content blocks must be non-empty')))).toMatchObject({ kind: 'bad-request' });
  });

  it('maps an unreachable server to a transient network error', async () => {
    const transport = replay(() => {
      throw new TypeError('fetch failed');
    });
    expect(await failure(clientFor(transport), BASE_REQUEST)).toMatchObject({ kind: 'transient', network: true });
  });

  it('does not retry on its own', async () => {
    const transport = replay(refusal(529, error('overloaded_error', 'Overloaded')), recorded('text.sse'));
    await failure(clientFor(transport), BASE_REQUEST);
    expect(transport.sent).toHaveLength(1);
  });
});
