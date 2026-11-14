import { describe, expect, it } from 'vitest';
import { createGeminiClient, thinkingConfig } from '../adapters/gemini';
import { createModelClient } from '../createModelClient';
import { ModelError } from '../ModelError';
import type { ModelEvent, ModelMessage, ModelRequest } from '../types';
import { BASE_REQUEST, collect, failure, fixture, refusal, replay, sse, type Replay } from './replay';

const recorded = (name: string) => sse(fixture('gemini', name));

function clientFor(transport: Replay, apiKey = 'AIza-test') {
  return createGeminiClient({ provider: 'google', apiKey, baseUrl: '', fetch: transport.fetch });
}

const TOOLS: ModelRequest['tools'] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'grep', description: 'Search', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
];

function ofType<T extends ModelEvent['type']>(events: ModelEvent[], type: T): Array<Extract<ModelEvent, { type: T }>> {
  return events.filter((e): e is Extract<ModelEvent, { type: T }> => e.type === type);
}

/** Google's error envelope, as the REST API answers. */
function googleError(code: number, status: string, message: string, details: unknown[] = []) {
  return { error: { code, message, status, details } };
}

const RETRY_INFO = (delay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay });
const QUOTA_FAILURE = (quotaId: string) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId }],
});

describe('gemini adapter: streams', () => {
  it('streams text, then usage, then a stop', async () => {
    const transport = replay(recorded('text.sse'));
    const events = await collect(clientFor(transport), { ...BASE_REQUEST, model: 'gemini-2.5-flash' });
    expect(events).toEqual([
      { type: 'text-delta', text: 'The tests' },
      { type: 'text-delta', text: ' pass.' },
      { type: 'usage', usage: { inputTokens: 1200, outputTokens: 5 } },
      { type: 'finish', reason: 'stop' },
    ]);
    const [exchange] = transport.sent;
    expect(exchange.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(exchange.headers.get('x-goog-api-key')).toBe('AIza-test');
    expect(exchange.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'Run the tests.' }] }],
      systemInstruction: { parts: [{ text: 'You are a coding agent.' }] },
    });
    expect(exchange.body.tools).toBeUndefined();
    expect(exchange.body.generationConfig ?? {}).toEqual({});
  });

  it('joins the system parts and ignores cache hints', async () => {
    const transport = replay(recorded('text.sse'));
    await collect(clientFor(transport), {
      ...BASE_REQUEST,
      system: [{ text: 'one', cacheBreakpoint: true }, { text: 'two' }],
      cache: { afterTools: true, atLastMessage: true },
      maxOutputTokens: 4096,
    });
    expect(transport.sent[0].body).toMatchObject({
      systemInstruction: { parts: [{ text: 'one\n\ntwo' }] },
      generationConfig: { maxOutputTokens: 4096 },
    });
    expect(JSON.stringify(transport.sent[0].body)).not.toMatch(/cache/i);
  });

  it('streams thought summaries as thinking and records the signature where it arrived', async () => {
    const transport = replay(recorded('thinking.sse'));
    const events = await collect(clientFor(transport), { ...BASE_REQUEST, model: 'gemini-3-flash-preview', effort: 'high' });
    expect(events).toEqual([
      { type: 'thinking-delta', text: '**Checking the suite**\n' },
      { type: 'thinking-delta', text: 'I should run it first.' },
      { type: 'text-delta', text: 'Running the ' },
      { type: 'text-delta', text: 'suite.' },
      { type: 'usage', usage: { inputTokens: 900, outputTokens: 64, reasoningTokens: 60 } },
      {
        type: 'provider-state',
        state: {
          dialect: 'gemini',
          data: {
            parts: [
              { text: '**Checking the suite**\nI should run it first.', thought: true },
              { text: 'Running the suite.', thoughtSignature: 'c2lnLXRleHQ=' },
            ],
          },
        },
      },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(transport.sent[0].body.generationConfig).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } });
  });

  it('reassembles parallel function calls, reports cached and thoughts tokens, and records signatures', async () => {
    const transport = replay(recorded('parallel-calls.sse'));
    const events = await collect(clientFor(transport), { ...BASE_REQUEST, model: 'gemini-3-flash-preview', tools: TOOLS });
    const calls = ofType(events, 'tool-call-complete').map((e) => e.call);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ name: 'read_file', arguments: { path: 'src/a.ts' }, rawArguments: '{"path":"src/a.ts"}' });
    expect(calls[1]).toMatchObject({ name: 'grep', arguments: { pattern: 'TODO' }, rawArguments: '{"pattern":"TODO"}' });
    // The API's own id is kept; a call it left unnamed gets one of ours.
    expect(calls[2]).toMatchObject({ id: 'fc-9', name: 'read_file', arguments: {}, rawArguments: '{}' });
    expect(calls[0].id).not.toBe(calls[1].id);
    expect(ofType(events, 'tool-call-start').map((e) => e.name)).toEqual(['read_file', 'grep', 'read_file']);
    expect(ofType(events, 'tool-call-delta')[0]).toEqual({ type: 'tool-call-delta', id: calls[0].id, argumentsDelta: '{"path":"src/a.ts"}' });
    expect(ofType(events, 'usage')[0].usage).toEqual({
      inputTokens: 5400,
      outputTokens: 90,
      cacheReadTokens: 5120,
      reasoningTokens: 60,
    });
    expect(events.slice(-3).map((e) => e.type)).toEqual(['usage', 'provider-state', 'finish']);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' });
    expect(transport.sent[0].body).toMatchObject({
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      tools: [{ functionDeclarations: [
        { name: 'read_file', description: 'Read a file', parametersJsonSchema: TOOLS[0].parameters },
        { name: 'grep' },
      ] }],
    });
  });

  it('sends the recorded turn back unchanged, signatures in place, and the results keyed by the API ids', async () => {
    const first = replay(recorded('parallel-calls.sse'));
    const events = await collect(clientFor(first), { ...BASE_REQUEST, model: 'gemini-3-flash-preview', tools: TOOLS });
    const calls = ofType(events, 'tool-call-complete').map((e) => e.call);
    const state = ofType(events, 'provider-state')[0].state;
    // A session persists it between steps.
    const persisted = JSON.parse(JSON.stringify(state)) as typeof state;

    const second = replay(recorded('text.sse'));
    await collect(clientFor(second), {
      ...BASE_REQUEST,
      model: 'gemini-3-flash-preview',
      tools: TOOLS,
      messages: [
        ...BASE_REQUEST.messages,
        { role: 'assistant', text: '', toolCalls: calls, providerState: persisted },
        { role: 'tool', results: calls.map((c, i) => ({ callId: c.id, name: c.name, output: `result ${i}`, ...(i === 1 ? { isError: true } : {}) })) },
      ],
    });
    expect(second.sent[0].body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Run the tests.' }] },
      {
        role: 'model',
        parts: [
          { text: 'Reading both files.', thought: true },
          { functionCall: { name: 'read_file', args: { path: 'src/a.ts' } }, thoughtSignature: 'c2lnLWNhbGwtMQ==' },
          { functionCall: { name: 'grep', args: { pattern: 'TODO' } } },
          { functionCall: { id: 'fc-9', name: 'read_file', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', response: { output: 'result 0' } } },
          { functionResponse: { name: 'grep', response: { error: 'result 1' } } },
          { functionResponse: { id: 'fc-9', name: 'read_file', response: { output: 'result 2' } } },
        ],
      },
    ]);
  });

  it('drops state from another dialect and stands a placeholder signature in on Gemini 3', async () => {
    const call = { id: 'call_x', name: 'read_file', arguments: { path: 'a' }, rawArguments: '{"path":"a"}' };
    const history: ModelMessage[] = [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: 'Reading.', toolCalls: [call, { ...call, id: 'call_y' }], providerState: { dialect: 'chat-completions', data: { parts: [{ text: 'foreign' }] } } },
      { role: 'tool', results: [{ callId: 'call_x', name: 'read_file', output: 'a' }, { callId: 'call_y', name: 'read_file', output: 'b' }] },
    ];
    const gemini3 = replay(recorded('text.sse'));
    await collect(clientFor(gemini3), { ...BASE_REQUEST, model: 'gemini-3.1-pro-preview', tools: TOOLS, messages: history });
    expect(gemini3.sent[0].body.contents).toEqual([
      { role: 'user', parts: [{ text: 'go' }] },
      {
        role: 'model',
        parts: [
          { text: 'Reading.' },
          { functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'skip_thought_signature_validator' },
          { functionCall: { name: 'read_file', args: { path: 'a' } } },
        ],
      },
      { role: 'user', parts: [
        { functionResponse: { name: 'read_file', response: { output: 'a' } } },
        { functionResponse: { name: 'read_file', response: { output: 'b' } } },
      ] },
    ]);

    // 2.5 does not check them, so it is sent none.
    const older = replay(recorded('text.sse'));
    await collect(clientFor(older), { ...BASE_REQUEST, model: 'gemini-2.5-pro', tools: TOOLS, messages: history });
    expect(JSON.stringify(older.sent[0].body)).not.toContain('thoughtSignature');
  });

  it('finishes on length and on a blocked prompt', async () => {
    const long = await collect(clientFor(replay(recorded('max-tokens.sse'))), BASE_REQUEST);
    expect(long.at(-1)).toEqual({ type: 'finish', reason: 'length' });
    const blocked = await collect(clientFor(replay(recorded('blocked.sse'))), BASE_REQUEST);
    expect(blocked.at(-1)).toEqual({ type: 'finish', reason: 'content-filter' });
  });
});

describe('gemini adapter: tool choice', () => {
  const modeOf = async (toolChoice: ModelRequest['toolChoice']) => {
    const transport = replay(recorded('text.sse'));
    await collect(clientFor(transport), { ...BASE_REQUEST, tools: TOOLS, ...(toolChoice ? { toolChoice } : {}) });
    return (transport.sent[0].body.toolConfig as { functionCallingConfig: unknown }).functionCallingConfig;
  };

  it('maps auto, none, required and a forced tool', async () => {
    expect(await modeOf(undefined)).toEqual({ mode: 'AUTO' });
    expect(await modeOf('auto')).toEqual({ mode: 'AUTO' });
    expect(await modeOf('none')).toEqual({ mode: 'NONE' });
    expect(await modeOf('required')).toEqual({ mode: 'ANY' });
    expect(await modeOf({ name: 'grep' })).toEqual({ mode: 'ANY', allowedFunctionNames: ['grep'] });
  });

  it('keeps every declaration in the request when a tool is forced', async () => {
    const transport = replay(recorded('text.sse'));
    await collect(clientFor(transport), { ...BASE_REQUEST, tools: TOOLS, toolChoice: { name: 'grep' } });
    const tools = transport.sent[0].body.tools as Array<{ functionDeclarations: unknown[] }>;
    expect(tools[0].functionDeclarations).toHaveLength(2);
  });
});

describe('gemini adapter: thinking effort', () => {
  it('sets a budget on Gemini 2.5, capped by what the model takes', () => {
    expect(thinkingConfig('gemini-2.5-flash', 'low')).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
    expect(thinkingConfig('gemini-2.5-flash', 'medium')).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
    expect(thinkingConfig('gemini-2.5-flash', 'high')).toEqual({ includeThoughts: true, thinkingBudget: 16_384 });
    expect(thinkingConfig('gemini-2.5-flash', 'max')).toEqual({ includeThoughts: true, thinkingBudget: 24_576 });
    expect(thinkingConfig('gemini-2.5-flash-lite', 'xhigh')).toEqual({ includeThoughts: true, thinkingBudget: 24_576 });
    expect(thinkingConfig('gemini-2.5-pro', 'xhigh')).toEqual({ includeThoughts: true, thinkingBudget: 24_576 });
    expect(thinkingConfig('models/gemini-2.5-pro', 'max')).toEqual({ includeThoughts: true, thinkingBudget: 32_768 });
  });

  it('sets a level on Gemini 3 and later, never both', () => {
    expect(thinkingConfig('gemini-3-flash-preview', 'low')).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' });
    expect(thinkingConfig('gemini-3-flash-preview', 'medium')).toEqual({ includeThoughts: true, thinkingLevel: 'MEDIUM' });
    expect(thinkingConfig('gemini-3.1-pro-preview', 'high')).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
    expect(thinkingConfig('gemini-3.1-pro-preview', 'max')).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
    expect(thinkingConfig('gemini-flash-latest', 'xhigh')).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
    // Gemini 3 Pro knows only low and high.
    expect(thinkingConfig('gemini-3-pro-preview', 'medium')).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
    expect(thinkingConfig('gemini-4-hydrogen', 'xhigh')).toEqual({ includeThoughts: true, thinkingLevel: 'XHIGH' });
  });

  it('sends nothing to a model that does not think', () => {
    expect(thinkingConfig('gemini-2.0-flash', 'high')).toBeUndefined();
    expect(thinkingConfig('gemini-1.5-pro', 'high')).toBeUndefined();
    expect(thinkingConfig('gemma-3-27b-it', 'high')).toBeUndefined();
  });

  it('sends no thinking setting without an effort', async () => {
    const transport = replay(recorded('text.sse'));
    await collect(clientFor(transport), { ...BASE_REQUEST, model: 'gemini-2.5-flash' });
    expect(JSON.stringify(transport.sent[0].body)).not.toContain('thinkingConfig');
  });

  it('retries once without thinking when the model refuses it, and remembers', async () => {
    const refuse = () => refusal(400, googleError(400, 'INVALID_ARGUMENT', 'Unable to submit request because thinking_level is not supported by this model.'));
    const transport = replay(refuse, recorded('text.sse'), recorded('text.sse'));
    const client = clientFor(transport);
    const request: ModelRequest = { ...BASE_REQUEST, model: 'gemini-3-flash-preview', effort: 'low' };
    const events = await collect(client, request);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
    expect(JSON.stringify(transport.sent[0].body)).toContain('thinkingConfig');
    expect(JSON.stringify(transport.sent[1].body)).not.toContain('thinkingConfig');
    await collect(client, request);
    expect(transport.sent).toHaveLength(3);
    expect(JSON.stringify(transport.sent[2].body)).not.toContain('thinkingConfig');
  });

  it('does not mistake a missing-signature refusal for a thinking refusal', async () => {
    const transport = replay(() => refusal(400, googleError(400, 'INVALID_ARGUMENT', 'Function call is missing a thought_signature in functionCall parts, thinking mode.')));
    const err = await failure(clientFor(transport), { ...BASE_REQUEST, effort: 'low', model: 'gemini-3-flash-preview' });
    expect(err).toMatchObject({ kind: 'bad-request', status: 400 });
    expect(transport.sent).toHaveLength(1);
  });
});

describe('gemini adapter: errors', () => {
  const errorOf = async (response: Response | (() => Response)) => failure(clientFor(replay(response)), BASE_REQUEST);

  it('maps a per-minute 429 to rate-limited with RetryInfo as the wait', async () => {
    const err = await errorOf(refusal(429, googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
      QUOTA_FAILURE('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
      RETRY_INFO('34s'),
    ])));
    expect(err).toBeInstanceOf(ModelError);
    expect(err).toMatchObject({ kind: 'rate-limited', status: 429, code: 'RESOURCE_EXHAUSTED', retryAfterMs: 34_000, message: 'You exceeded your current quota.' });
  });

  it('maps a 429 with no details to rate-limited', async () => {
    const err = await errorOf(refusal(429, googleError(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).')));
    expect(err).toMatchObject({ kind: 'rate-limited', status: 429 });
    expect((err as ModelError).retryAfterMs).toBeUndefined();
  });

  it('maps a daily quota to usage-limit, reset taken from RetryInfo', async () => {
    const before = Date.now();
    const err = await errorOf(refusal(429, googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
      QUOTA_FAILURE('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
      RETRY_INFO('3600s'),
    ])));
    expect(err).toMatchObject({ kind: 'usage-limit', status: 429 });
    const resetsAt = (err as ModelError).resetsAt ?? 0;
    expect(resetsAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(resetsAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('maps a daily quota with no RetryInfo to usage-limit with no reset', async () => {
    const err = await errorOf(refusal(429, googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', [QUOTA_FAILURE('GenerateContentRequestsPerDay')])));
    expect(err).toMatchObject({ kind: 'usage-limit' });
    expect((err as ModelError).resetsAt).toBeUndefined();
  });

  it.each([
    [500, 'INTERNAL', 'An internal error has occurred.'],
    [503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'],
    [504, 'DEADLINE_EXCEEDED', 'The service is unable to finish in time.'],
  ])('maps a %i to transient', async (status, code, message) => {
    const err = await errorOf(refusal(status, googleError(status, code, message)));
    expect(err).toMatchObject({ kind: 'transient', status, code });
  });

  it('maps a token-limit refusal to context-overflow', async () => {
    const err = await errorOf(refusal(400, googleError(400, 'INVALID_ARGUMENT', 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048575).')));
    expect(err).toMatchObject({ kind: 'context-overflow', status: 400 });
  });

  it('maps an invalid key, which Google answers with a 400, to auth', async () => {
    const err = await errorOf(refusal(400, googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' },
    ])));
    expect(err).toMatchObject({ kind: 'auth', status: 400 });
  });

  it('maps a 403 and a 401 to auth', async () => {
    expect(await errorOf(refusal(403, googleError(403, 'PERMISSION_DENIED', 'Your API key was reported as leaked.')))).toMatchObject({ kind: 'auth', status: 403 });
    expect(await errorOf(refusal(401, googleError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.')))).toMatchObject({ kind: 'auth', status: 401 });
  });

  it('maps other client errors to bad-request', async () => {
    expect(await errorOf(refusal(404, googleError(404, 'NOT_FOUND', 'models/nope is not found.')))).toMatchObject({ kind: 'bad-request', status: 404 });
    expect(await errorOf(refusal(400, googleError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received.')))).toMatchObject({ kind: 'bad-request', status: 400 });
  });

  it('maps a non-JSON error body by its status', async () => {
    const err = await errorOf(new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    expect(err).toMatchObject({ kind: 'transient', status: 502 });
  });

  it('maps an unreachable provider to a network transient', async () => {
    const err = await errorOf(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    });
    expect(err).toMatchObject({ kind: 'transient', network: true });
  });

  it('maps an error event inside the stream, with its status', async () => {
    const err = await failure(clientFor(replay(recorded('midstream-error.sse'))), BASE_REQUEST);
    expect(err).toMatchObject({ kind: 'transient', status: 503, code: 'UNAVAILABLE' });
  });

  it('fails a stream that ends before the model finishes', async () => {
    const err = await failure(clientFor(replay(recorded('truncated.sse'))), BASE_REQUEST);
    expect(err).toMatchObject({ kind: 'transient' });
  });

  it('fails a reply that stopped for no usable reason', async () => {
    const empty = sse('data: {"candidates":[{"finishReason":"OTHER","index":0}]}\n\n');
    expect(await failure(clientFor(replay(empty)), BASE_REQUEST)).toMatchObject({ kind: 'fatal', code: 'OTHER' });
    const malformed = sse('data: {"candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL","index":0}]}\n\n');
    expect(await failure(clientFor(replay(malformed)), BASE_REQUEST)).toMatchObject({ kind: 'transient', code: 'MALFORMED_FUNCTION_CALL' });
  });

  it('fails without a key, before any request', async () => {
    const transport = replay(recorded('text.sse'));
    const err = await failure(clientFor(transport, ''), BASE_REQUEST);
    expect(err).toMatchObject({ kind: 'auth' });
    expect(transport.sent).toHaveLength(0);
  });

  it('throws the signal reason on a stop, not a provider failure', async () => {
    const controller = new AbortController();
    const reason = new Error('stopped by the user');
    controller.abort(reason);
    const transport = replay(recorded('text.sse'));
    expect(await failure(clientFor(transport), BASE_REQUEST, controller.signal)).toBe(reason);
  });

  it('never retries on its own: one request per failure', async () => {
    const transport = replay(
      refusal(503, googleError(503, 'UNAVAILABLE', 'overloaded')),
      refusal(503, googleError(503, 'UNAVAILABLE', 'overloaded')),
    );
    await failure(clientFor(transport), BASE_REQUEST);
    expect(transport.sent).toHaveLength(1);
  });
});

describe('gemini adapter: factory', () => {
  it('is what createModelClient builds for google', async () => {
    const transport = replay(recorded('text.sse'));
    const client = createModelClient({ provider: 'google', apiKey: 'AIza-test', fetch: transport.fetch });
    expect(client).toMatchObject({ provider: 'google', dialect: 'gemini' });
    await collect(client, BASE_REQUEST);
    expect(transport.sent[0].url).toContain('https://generativelanguage.googleapis.com/');
  });

  it('honours a base URL override', async () => {
    const transport = replay(recorded('text.sse'));
    const client = createGeminiClient({ provider: 'google', apiKey: 'k', baseUrl: 'https://proxy.example.test/', fetch: transport.fetch });
    await collect(client, BASE_REQUEST);
    expect(transport.sent[0].url).toMatch(/^https:\/\/proxy\.example\.test\/v1beta\/models\//);
  });
});
