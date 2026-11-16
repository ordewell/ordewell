import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatCompletionsClient, requestBody } from '../adapters/chatCompletions';
import { ModelError } from '../ModelError';
import type { AiProvider } from '../../../interfaces/IConfig';
import type { ModelEvent, ModelRequest } from '../types';
import { BASE_REQUEST, collect, failure, fixture, refusal, replay, sse, type Replay } from './replay';

const recorded = (name: string) => sse(fixture('chat-completions', name));

function clientFor(provider: AiProvider, transport: Replay) {
  return createChatCompletionsClient({ provider, apiKey: 'sk-test', baseUrl: 'https://api.example.test/v1', fetch: transport.fetch });
}

const TOOLS: ModelRequest['tools'] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'grep', description: 'Search', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
];

function ofType<T extends ModelEvent['type']>(events: ModelEvent[], type: T): Array<Extract<ModelEvent, { type: T }>> {
  return events.filter((e): e is Extract<ModelEvent, { type: T }> => e.type === type);
}

describe('chat-completions adapter: transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends through the global fetch when given none, as the built-in runner does', async () => {
    const transport = replay(sse(fixture('chat-completions', 'text.sse')));
    vi.stubGlobal('fetch', transport.fetch);
    // A closed loopback port: a transport other than the global fetch fails here, offline.
    const client = createChatCompletionsClient({ provider: 'openrouter', apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9/v1' });
    const events = await collect(client, BASE_REQUEST);
    expect(transport.sent.map((e) => e.url)).toEqual(['http://127.0.0.1:9/v1/chat/completions']);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });
});

describe('chat-completions adapter: streams', () => {
  it('streams text, then usage, then a stop', async () => {
    const transport = replay(recorded('text.sse'));
    const events = await collect(clientFor('groq', transport), BASE_REQUEST);
    expect(events).toEqual([
      { type: 'text-delta', text: 'The tests' },
      { type: 'text-delta', text: ' pass.' },
      { type: 'usage', usage: { inputTokens: 1200, outputTokens: 5 } },
      { type: 'finish', reason: 'stop' },
    ]);
    const [exchange] = transport.sent;
    expect(exchange.url).toBe('https://api.example.test/v1/chat/completions');
    expect(exchange.headers.get('authorization')).toBe('Bearer sk-test');
    expect(exchange.body).toMatchObject({ model: 'test-model', stream: true, stream_options: { include_usage: true } });
    expect(exchange.body.tools).toBeUndefined();
  });

  it('reassembles parallel tool calls by index and reports cached prompt tokens', async () => {
    const transport = replay(recorded('parallel-tools.sse'));
    const events = await collect(clientFor('xai', transport), { ...BASE_REQUEST, tools: TOOLS });
    expect(ofType(events, 'tool-call-start')).toEqual([
      { type: 'tool-call-start', id: 'call_read_a', name: 'read_file' },
      { type: 'tool-call-start', id: 'call_grep_b', name: 'grep' },
    ]);
    const deltas = ofType(events, 'tool-call-delta');
    expect(deltas.filter((d) => d.id === 'call_read_a').map((d) => d.argumentsDelta).join('')).toBe('{"path":"src/a.ts"}');
    expect(deltas.filter((d) => d.id === 'call_grep_b').map((d) => d.argumentsDelta).join('')).toBe('{"pattern":"TODO"}');
    expect(ofType(events, 'tool-call-complete').map((e) => e.call)).toEqual([
      { id: 'call_read_a', name: 'read_file', arguments: { path: 'src/a.ts' }, rawArguments: '{"path":"src/a.ts"}' },
      { id: 'call_grep_b', name: 'grep', arguments: { pattern: 'TODO' }, rawArguments: '{"pattern":"TODO"}' },
    ]);
    expect(ofType(events, 'usage')[0].usage).toEqual({ inputTokens: 5400, outputTokens: 61, cacheReadTokens: 5120, reasoningTokens: 0 });
    expect(events.slice(-2).map((e) => e.type)).toEqual(['usage', 'finish']);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' });
    expect(transport.sent[0].body).toMatchObject({
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file' } }, { type: 'function', function: { name: 'grep' } }],
    });
  });

  it('streams reasoning_content as thinking and keeps it to send back with the tool-calling turn', async () => {
    const events = await collect(clientFor('deepseek', replay(recorded('reasoning-content.sse'))), { ...BASE_REQUEST, tools: TOOLS });
    expect(ofType(events, 'thinking-delta').map((e) => e.text)).toEqual(['The user wants', ' the file read.']);
    expect(ofType(events, 'usage')[0].usage).toEqual({ inputTokens: 3000, outputTokens: 40, cacheReadTokens: 2944, reasoningTokens: 28 });
    const [state] = ofType(events, 'provider-state');
    expect(state.state).toEqual({ dialect: 'chat-completions', data: { field: 'reasoning_content', reasoning: 'The user wants the file read.' } });
    const [complete] = ofType(events, 'tool-call-complete');

    const next = requestBody('deepseek', {
      ...BASE_REQUEST,
      messages: [
        { role: 'user', text: 'Read it.' },
        { role: 'assistant', text: '', toolCalls: [complete.call], providerState: state.state },
        { role: 'tool', results: [{ callId: 'call_00_ds', name: 'read_file', output: '# Readme' }] },
        { role: 'assistant', text: 'Read.', providerState: state.state },
      ],
    });
    expect(next.messages.slice(1)).toEqual([
      { role: 'user', content: 'Read it.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_00_ds', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
        reasoning_content: 'The user wants the file read.',
      },
      { role: 'tool', tool_call_id: 'call_00_ds', content: '# Readme' },
      // A turn without calls goes back without its reasoning, which DeepSeek refuses there.
      { role: 'assistant', content: 'Read.' },
    ]);
  });

  it('reads OpenRouter reasoning details, cache writes and its reported cost', async () => {
    const events = await collect(clientFor('openrouter', replay(recorded('openrouter-reasoning.sse'))), BASE_REQUEST);
    expect(ofType(events, 'thinking-delta').map((e) => e.text)).toEqual(['Checking', ' the plan.']);
    expect(ofType(events, 'text-delta').map((e) => e.text)).toEqual(['Done.']);
    expect(ofType(events, 'usage')[0].usage).toEqual({
      inputTokens: 8000,
      outputTokens: 30,
      cacheReadTokens: 6000,
      cacheWriteTokens: 1900,
      reasoningTokens: 12,
      cost: { amount: 0.0042, currency: 'USD' },
    });
    const [state] = ofType(events, 'provider-state');
    expect(state.state.data).toEqual({
      field: 'reasoning',
      reasoning: 'Checking the plan.',
      details: [{ type: 'reasoning.text', text: 'Checking the plan.', signature: 'EqQBCkgIBRABGAIiQL3sig==', format: 'anthropic-claude-v1', index: 0 }],
    });

    const next = requestBody('openrouter', { ...BASE_REQUEST, messages: [{ role: 'assistant', text: 'Done.', providerState: state.state }] });
    expect(next.messages[1]).toEqual({ role: 'assistant', content: 'Done.', reasoning_details: (state.state.data as { details: unknown }).details });
  });

  it('takes a cost only from OpenRouter, the one vendor whose figure is a billed amount', async () => {
    const body = fixture('chat-completions', 'openrouter-reasoning.sse');
    const events = await collect(clientFor('together', replay(sse(body))), BASE_REQUEST);
    expect(ofType(events, 'usage')[0].usage.cost).toBeUndefined();
  });

  it('names a call a local server left unidentified, and reports arguments that do not parse', async () => {
    const events = await collect(clientFor('openai_compatible', replay(recorded('unidentified-call.sse'))), BASE_REQUEST);
    const [start] = ofType(events, 'tool-call-start');
    expect(start.id).toMatch(/^call_/);
    expect(start.name).toBe('task_complete');
    const [complete] = ofType(events, 'tool-call-complete');
    expect(complete.call).toMatchObject({ id: start.id, arguments: {}, rawArguments: '{"status": "done"' });
    expect(complete.call.argumentsError).toBeTruthy();
    // The server said `stop` on a turn that called a tool.
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' });
  });

  it('treats a stream that ends without a finish reason as a transient failure', async () => {
    const transport = replay(recorded('truncated.sse'));
    const events: ModelEvent[] = [];
    const err = await (async () => {
      try { for await (const e of clientFor('qwen', transport).stream(BASE_REQUEST)) events.push(e); } catch (e) { return e; }
    })();
    expect(events).toEqual([{ type: 'text-delta', text: 'Partial' }]);
    expect(err).toBeInstanceOf(ModelError);
    expect(err).toMatchObject({ kind: 'transient' });
  });

  it('classifies an error OpenRouter sends mid-stream by the status in its code', async () => {
    const err = await failure(clientFor('openrouter', replay(recorded('midstream-error.sse'))), BASE_REQUEST);
    expect(err).toMatchObject({ kind: 'transient', status: 502, code: '502' });
  });

  it('maps finish reasons for length and the content filter', async () => {
    const chunk = (finish: string) => `data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":"${finish}"}]}\n\ndata: [DONE]\n\n`;
    for (const [wire, reason] of [['length', 'length'], ['content_filter', 'content-filter']] as const) {
      const events = await collect(clientFor('mistral', replay(sse(chunk(wire)))), BASE_REQUEST);
      expect(events.at(-1)).toEqual({ type: 'finish', reason });
    }
    const err = await failure(clientFor('openrouter', replay(sse(chunk('error')))), BASE_REQUEST);
    expect(err).toMatchObject({ kind: 'transient' });
  });

  it('stops with the signal\'s own reason', async () => {
    const controller = new AbortController();
    const reason = new Error('stopped by the user');
    controller.abort(reason);
    const err = await failure(clientFor('groq', replay(recorded('text.sse'))), BASE_REQUEST, controller.signal);
    expect(err).toBe(reason);
  });
});

describe('chat-completions adapter: request body', () => {
  it('forces one named tool while keeping every definition', () => {
    const body = requestBody('groq', { ...BASE_REQUEST, tools: TOOLS, toolChoice: { name: 'grep' }, maxOutputTokens: 4096 });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'grep' } });
    expect(body.tools).toHaveLength(2);
    expect(body.max_tokens).toBe(4096);
    expect(requestBody('groq', { ...BASE_REQUEST, tools: TOOLS, toolChoice: 'required' }).tool_choice).toBe('required');
    expect(requestBody('groq', { ...BASE_REQUEST, tools: TOOLS, toolChoice: 'none' }).tool_choice).toBe('none');
  });

  it('maps efforts onto reasoning_effort, OpenRouter\'s reasoning object, or nothing', () => {
    expect(requestBody('groq', { ...BASE_REQUEST, effort: 'medium' }).reasoning_effort).toBe('medium');
    expect(requestBody('xai', { ...BASE_REQUEST, effort: 'max' }).reasoning_effort).toBe('high');
    expect(requestBody('openrouter', { ...BASE_REQUEST, effort: 'xhigh' }).reasoning).toEqual({ effort: 'high' });
    const deepseek = requestBody('deepseek', { ...BASE_REQUEST, effort: 'low' });
    expect(deepseek.reasoning_effort).toBeUndefined();
    expect(deepseek.reasoning).toBeUndefined();
    expect(requestBody('groq', { ...BASE_REQUEST, effort: 'low' }, true).reasoning_effort).toBeUndefined();
  });

  it('leaves stream_options out for Mistral, which refuses unknown fields', () => {
    expect(requestBody('mistral', BASE_REQUEST).stream_options).toBeUndefined();
  });

  it('places cache breakpoints only for an Anthropic model behind OpenRouter', () => {
    const request: ModelRequest = {
      ...BASE_REQUEST,
      system: [{ text: 'stable', cacheBreakpoint: true }, { text: 'per run' }],
      messages: [
        { role: 'user', text: 'go' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'grep', arguments: { pattern: 'x' }, rawArguments: '' }] },
        { role: 'tool', results: [{ callId: 'c1', name: 'grep', output: 'one' }, { callId: 'c2', name: 'grep', output: 'two' }] },
      ],
      cache: { afterTools: true, atLastMessage: true },
    };
    const anthropic = requestBody('openrouter', { ...request, model: 'anthropic/claude-sonnet-4.5' });
    expect(anthropic.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'per run' }],
    });
    expect(anthropic.messages[2]).toMatchObject({ tool_calls: [{ function: { arguments: '{"pattern":"x"}' } }] });
    expect(anthropic.messages.slice(3)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'one' },
      { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'two', cache_control: { type: 'ephemeral' } }] },
    ]);

    const implicit = requestBody('openrouter', { ...request, model: 'openai/gpt-5' });
    expect(implicit.messages[0]).toEqual({ role: 'system', content: 'stable\n\nper run' });
    expect(implicit.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'two' });

    // Live, breakpoints on gemini-3.1-flash-lite wrote nothing (OpenRouter
    // writes from 4096 tokens) and one of three runs still read nothing, so
    // Gemini is left to its implicit cache, unrouted.
    const gemini = requestBody('openrouter', { ...request, model: 'google/gemini-3.1-flash-lite' });
    expect(gemini.messages[0]).toEqual({ role: 'system', content: 'stable\n\nper run' });
    expect(gemini.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'two' });
    expect(gemini.provider).toBeUndefined();
  });

  it('caps the system breakpoints so the last message keeps one of Anthropic\'s four', () => {
    const system = ['a', 'b', 'c', 'd'].map((text) => ({ text, cacheBreakpoint: true }));
    const body = requestBody('openrouter', { ...BASE_REQUEST, model: 'anthropic/claude-haiku-4.5', system, cache: { atLastMessage: true } });
    const parts = body.messages[0].content as Array<{ cache_control?: unknown }>;
    expect(parts.map((p) => p.cache_control !== undefined)).toEqual([false, true, true, true]);
    expect(body.messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Run the tests.', cache_control: { type: 'ephemeral' } }] });
  });

  // Live, Vertex's global endpoint (OpenRouter's usual pick for Claude) wrote
  // nearly every step's whole prompt and read none of it; Bedrock read every step.
  it('routes a cached Claude request to upstreams whose cache holds across steps, keeping fallbacks', async () => {
    const cached: ModelRequest = { ...BASE_REQUEST, model: 'anthropic/claude-haiku-5.5', system: [{ text: 'stable', cacheBreakpoint: true }], cache: { atLastMessage: true } };
    const transport = replay(recorded('text.sse'));
    await collect(clientFor('openrouter', transport), cached);
    expect(transport.sent[0].body.provider).toEqual({ order: ['anthropic', 'amazon-bedrock'] });

    expect(requestBody('openrouter', { ...BASE_REQUEST, model: 'anthropic/claude-haiku-5.5' }).provider).toBeUndefined();
    expect(requestBody('openrouter', { ...cached, model: 'openai/gpt-4.1-mini' }).provider).toBeUndefined();
    expect(requestBody('openai_compatible', cached).provider).toBeUndefined();
  });

  it('drops state another dialect left, and state that is not its own shape', () => {
    const body = requestBody('openrouter', {
      ...BASE_REQUEST,
      messages: [
        { role: 'assistant', text: 'a', providerState: { dialect: 'anthropic-messages', data: { details: [{ type: 'x' }] } } },
        { role: 'assistant', text: 'b', providerState: { dialect: 'chat-completions', data: 'garbage' } },
      ],
    });
    expect(body.messages.slice(1)).toEqual([{ role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' }]);
  });

  it('sends a placeholder key to a keyless local endpoint', async () => {
    const transport = replay(recorded('text.sse'));
    await collect(createChatCompletionsClient({ provider: 'openai_compatible', apiKey: '', baseUrl: 'http://localhost:11434/v1', fetch: transport.fetch }), BASE_REQUEST);
    expect(transport.sent[0].headers.get('authorization')).toBe('Bearer not-needed');
  });
});

describe('chat-completions adapter: errors', () => {
  const cases: Array<[string, Response, Partial<ModelError>]> = [
    ['a bad key', refusal(401, { error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } }), { kind: 'auth', status: 401 }],
    ['a forbidden model', refusal(403, { error: { message: 'Forbidden' } }), { kind: 'auth', status: 403 }],
    ['a rate limit', refusal(429, { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }, { 'retry-after': '7' }), { kind: 'rate-limited', retryAfterMs: 7000 }],
    ['a rate limit with reset headers', refusal(429, { error: { message: 'slow down' } }, { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1m30s', 'x-ratelimit-reset-tokens': '20ms' }), { kind: 'rate-limited', retryAfterMs: 90_000 }],
    ['an exhausted quota', refusal(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }), { kind: 'usage-limit', code: 'insufficient_quota' }],
    ['spent credits', refusal(402, { error: { code: 402, message: 'Insufficient credits' } }), { kind: 'usage-limit', status: 402 }],
    ['an overflow by code', refusal(400, { error: { message: 'too long', type: 'invalid_request_error', code: 'context_length_exceeded' } }), { kind: 'context-overflow' }],
    ['an overflow by wording alone', refusal(400, { error: { message: "This model's maximum context length is 65536 tokens.", type: 'invalid_request_error' } }), { kind: 'context-overflow' }],
    ['an oversized request', refusal(413, { error: { message: 'Request too large' } }), { kind: 'context-overflow' }],
    ['a bad request', refusal(400, { error: { message: 'Unknown model', type: 'invalid_request_error', code: 'model_not_found' } }), { kind: 'bad-request', code: 'model_not_found' }],
    ['a missing route', refusal(404, { error: { message: 'Not found' } }), { kind: 'bad-request', status: 404 }],
    ['a server failure', refusal(503, { error: { message: 'overloaded' } }), { kind: 'transient', status: 503 }],
  ];
  it.each(cases)('classifies %s', async (_name, response, expected) => {
    const err = await failure(clientFor('groq', replay(response)), BASE_REQUEST);
    expect(err).toBeInstanceOf(ModelError);
    expect(err).toMatchObject(expected);
    if (expected.kind === 'usage-limit') expect((err as ModelError).resetsAt).toBeUndefined();
    expect((err as ModelError).cause).toBeDefined();
  });

  it('dates a usage limit\'s reset where the headers say', async () => {
    const before = Date.now();
    const err = await failure(clientFor('groq', replay(refusal(402, { error: { message: 'no credit' } }, { 'retry-after': '3600' }))), BASE_REQUEST);
    expect((err as ModelError).resetsAt).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it('marks an unreachable provider as a network failure', async () => {
    const transport = replay(() => { throw new TypeError('fetch failed'); });
    const err = await failure(clientFor('groq', transport), BASE_REQUEST);
    expect(err).toMatchObject({ kind: 'transient', network: true });
  });

  it('sends no effort again to a model that refused it, and retries the request without it', async () => {
    const refused = () => refusal(400, { error: { message: 'reasoning_effort is not supported with this model', type: 'invalid_request_error', param: 'reasoning_effort' } });
    const transport = replay(refused(), recorded('text.sse'), recorded('text.sse'));
    const client = clientFor('groq', transport);
    const request: ModelRequest = { ...BASE_REQUEST, effort: 'high' };
    const events = await collect(client, request);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
    await collect(client, request);
    expect(transport.sent.map((s) => s.body.reasoning_effort)).toEqual(['high', undefined, undefined]);
  });

  it('does not retry a refusal that blames another field', async () => {
    const transport = replay(refusal(400, { error: { message: 'bad tools', type: 'invalid_request_error', param: 'tools' } }));
    const err = await failure(clientFor('groq', transport), { ...BASE_REQUEST, effort: 'high' });
    expect(err).toMatchObject({ kind: 'bad-request', param: 'tools' });
    expect(transport.sent).toHaveLength(1);
  });
});
