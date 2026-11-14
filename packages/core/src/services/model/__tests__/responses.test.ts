import { describe, expect, it } from 'vitest';
import { acceptedEfforts, clampEffort, createResponsesClient, requestBody } from '../adapters/responses';
import { ModelError } from '../ModelError';
import type { ModelEvent, ModelRequest } from '../types';
import { BASE_REQUEST, collect, failure, fixture, refusal, replay, sse, type Replay } from './replay';

const recorded = (name: string) => sse(fixture('responses', name));
const REASONER = 'gpt-5.2';

function clientFor(transport: Replay) {
  return createResponsesClient({ provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.example.test/v1', fetch: transport.fetch });
}

const TOOLS: ModelRequest['tools'] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'grep', description: 'Search', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
];

function ofType<T extends ModelEvent['type']>(events: ModelEvent[], type: T): Array<Extract<ModelEvent, { type: T }>> {
  return events.filter((e): e is Extract<ModelEvent, { type: T }> => e.type === type);
}

describe('responses adapter: streams', () => {
  it('streams text, then usage, then a stop, as a stateless request', async () => {
    const transport = replay(recorded('text.sse'));
    const events = await collect(clientFor(transport), { ...BASE_REQUEST, model: REASONER });
    expect(events).toEqual([
      { type: 'text-delta', text: 'The tests' },
      { type: 'text-delta', text: ' pass.' },
      { type: 'usage', usage: { inputTokens: 1200, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 } },
      { type: 'finish', reason: 'stop' },
    ]);
    const [exchange] = transport.sent;
    expect(exchange.url).toBe('https://api.example.test/v1/responses');
    expect(exchange.headers.get('authorization')).toBe('Bearer sk-test');
    expect(exchange.body).toMatchObject({
      model: REASONER,
      stream: true,
      store: false,
      instructions: 'You are a coding agent.',
      input: [{ role: 'user', content: 'Run the tests.' }],
      include: ['reasoning.encrypted_content'],
      reasoning: { summary: 'auto' },
    });
    expect(exchange.body.tools).toBeUndefined();
    expect(exchange.body.prompt_cache_key).toMatch(/^ordewell-[0-9a-f]{32}$/);
  });

  it('streams reasoning summaries as thinking, reassembles parallel calls and carries the reasoning item', async () => {
    const transport = replay(recorded('reasoning-parallel-tools.sse'));
    const events = await collect(clientFor(transport), { ...BASE_REQUEST, model: REASONER, tools: TOOLS });
    expect(ofType(events, 'thinking-delta').map((e) => e.text)).toEqual(['Reading both', ' files.', '\n\n', 'Then search.']);
    expect(ofType(events, 'tool-call-start')).toEqual([
      { type: 'tool-call-start', id: 'call_read_a', name: 'read_file' },
      { type: 'tool-call-start', id: 'call_grep_b', name: 'grep' },
    ]);
    const deltas = ofType(events, 'tool-call-delta');
    expect(deltas.filter((d) => d.id === 'call_read_a').map((d) => d.argumentsDelta).join('')).toBe('{"path":"src/a.ts"}');
    expect(deltas.filter((d) => d.id === 'call_grep_b').map((d) => d.argumentsDelta).join('')).toBe('{"pattern":"TODO"}');
    const calls = ofType(events, 'tool-call-complete').map((e) => e.call);
    expect(calls).toEqual([
      { id: 'call_read_a', name: 'read_file', arguments: { path: 'src/a.ts' }, rawArguments: '{"path":"src/a.ts"}' },
      { id: 'call_grep_b', name: 'grep', arguments: { pattern: 'TODO' }, rawArguments: '{"pattern":"TODO"}' },
    ]);
    // Cached input and reasoning tokens are shares of the totals.
    expect(ofType(events, 'usage')[0].usage).toEqual({ inputTokens: 5400, outputTokens: 190, cacheReadTokens: 5120, reasoningTokens: 128 });
    expect(events.slice(-3).map((e) => e.type)).toEqual(['usage', 'provider-state', 'finish']);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' });
    expect(transport.sent[0].body).toMatchObject({
      tool_choice: 'auto',
      parallel_tool_calls: true,
      tools: [
        { type: 'function', name: 'read_file', description: 'Read a file', strict: false },
        { type: 'function', name: 'grep', strict: false },
      ],
    });

    const [state] = ofType(events, 'provider-state');
    expect(state.state.dialect).toBe('responses');
    // The state survives a session being saved and loaded.
    const persisted = JSON.parse(JSON.stringify(state.state)) as typeof state.state;

    const next = requestBody({
      ...BASE_REQUEST,
      model: REASONER,
      messages: [
        { role: 'user', text: 'Read it.' },
        { role: 'assistant', text: '', toolCalls: calls, providerState: persisted },
        { role: 'tool', results: [
          { callId: 'call_read_a', name: 'read_file', output: '# a' },
          { callId: 'call_grep_b', name: 'grep', output: 'none', isError: true },
        ] },
      ],
    });
    expect(next.input).toEqual([
      { role: 'user', content: 'Read it.' },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Reading both files.' }, { type: 'summary_text', text: 'Then search.' }],
        encrypted_content: 'gAAAAABo_encrypted_reasoning_blob_1',
      },
      { type: 'function_call', call_id: 'call_read_a', name: 'read_file', arguments: '{"path":"src/a.ts"}' },
      { type: 'function_call', call_id: 'call_grep_b', name: 'grep', arguments: '{"pattern":"TODO"}' },
      { type: 'function_call_output', call_id: 'call_read_a', output: '# a' },
      { type: 'function_call_output', call_id: 'call_grep_b', output: 'none' },
    ]);
  });

  it('sends no reasoning back with a turn that produced no output, or from another dialect', () => {
    const data = { items: [{ id: 'rs_1', summary: [], encrypted_content: 'blob' }] };
    const input = requestBody({
      ...BASE_REQUEST,
      messages: [
        { role: 'assistant', text: '', providerState: { dialect: 'responses', data } },
        { role: 'assistant', text: 'Hello.', providerState: { dialect: 'chat-completions', data } },
        { role: 'assistant', text: 'Bye.', providerState: { dialect: 'responses', data: { items: [{ id: 'rs_2', summary: [] }, 'junk'] } } },
      ],
    }).input;
    expect(input).toEqual([
      { role: 'assistant', content: 'Hello.' },
      { role: 'assistant', content: 'Bye.' },
    ]);
  });

  it('reports a reply cut off by the output limit as length', async () => {
    const events = await collect(clientFor(replay(recorded('incomplete.sse'))), { ...BASE_REQUEST, model: REASONER });
    expect(ofType(events, 'text-delta').map((e) => e.text)).toEqual(['The answer is']);
    expect(ofType(events, 'usage')[0].usage).toMatchObject({ outputTokens: 64, reasoningTokens: 60 });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'length' });
  });

  it('treats a stream that ends before the response completes as a transient failure', async () => {
    const err = await failure(clientFor(replay(recorded('truncated.sse'))), BASE_REQUEST);
    expect(err).toBeInstanceOf(ModelError);
    expect(err).toMatchObject({ kind: 'transient' });
  });

  it('throws the signal reason when stopped', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped by the user'));
    const err = await failure(clientFor(replay(recorded('text.sse'))), BASE_REQUEST, controller.signal);
    expect(err).toBe(controller.signal.reason);
  });
});

describe('responses adapter: request', () => {
  const body = (over: Partial<ModelRequest>) => requestBody({ ...BASE_REQUEST, tools: TOOLS, ...over });

  it.each([
    ['auto', 'auto'],
    ['none', 'none'],
    ['required', 'required'],
    [{ name: 'task_complete' }, { type: 'function', name: 'task_complete' }],
  ] as const)('maps tool choice %j', (choice, wire) => {
    expect(body({ toolChoice: choice }).tool_choice).toEqual(wire);
  });

  it('sends no tool settings without tools, and no reasoning to a model that does not reason', () => {
    const plain = requestBody({ ...BASE_REQUEST, model: 'gpt-4.1', effort: 'high', toolChoice: 'required' });
    expect(plain.tools).toBeUndefined();
    expect(plain.tool_choice).toBeUndefined();
    expect(plain.reasoning).toBeUndefined();
    expect(plain.include).toBeUndefined();
  });

  it('sends the output limit, and the same cache key for the same prefix only', () => {
    expect(body({ maxOutputTokens: 4096 }).max_output_tokens).toBe(4096);
    const key = (req: Partial<ModelRequest>) => body(req).prompt_cache_key;
    expect(key({})).toBe(key({ messages: [{ role: 'user', text: 'Something else.' }] }));
    expect(key({})).not.toBe(key({ system: [{ text: 'Another prompt.' }] }));
  });

  it('maps effort onto what the model accepts', () => {
    const effort = (model: string, level: ModelRequest['effort']) => requestBody({ ...BASE_REQUEST, model, ...(level ? { effort: level } : {}) }).reasoning?.effort;
    expect(effort('o3', 'low')).toBe('low');
    expect(effort('o4-mini', 'max')).toBe('high');
    expect(effort('gpt-5', 'xhigh')).toBe('high');
    expect(effort('gpt-5.1', 'max')).toBe('high');
    expect(effort('gpt-5.2', 'xhigh')).toBe('xhigh');
    expect(effort('gpt-5.2', 'max')).toBe('xhigh');
    expect(effort('gpt-5.1-codex-max', 'max')).toBe('xhigh');
    expect(effort('gpt-5.2', 'medium')).toBe('medium');
    expect(effort('gpt-5-pro', 'low')).toBe('high');
    expect(effort('gpt-5.2', undefined)).toBeUndefined();
  });

  it('knows which models reason and clamps to the nearest accepted level', () => {
    expect(acceptedEfforts('gpt-4o')).toBeUndefined();
    expect(acceptedEfforts('gpt-5-chat-latest')).toBeUndefined();
    expect(acceptedEfforts('claude-sonnet-5-5')).toBeUndefined();
    expect(acceptedEfforts('gpt-6')).toContain('xhigh');
    expect(clampEffort('low', ['high'])).toBe('high');
    expect(clampEffort('max', ['low', 'medium'])).toBe('medium');
  });
});

describe('responses adapter: errors', () => {
  it.each([
    ['a bad key', refusal(401, { error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } }), { kind: 'auth', status: 401 }],
    ['a forbidden model', refusal(403, { error: { message: 'Project lacks access' } }), { kind: 'auth', status: 403 }],
    ['a rate limit', refusal(429, { error: { message: 'Rate limit reached', type: 'tokens', code: 'rate_limit_exceeded' } }, { 'retry-after': '7' }), { kind: 'rate-limited', retryAfterMs: 7000 }],
    ['a rate limit with reset headers', refusal(429, { error: { message: 'slow down' } }, { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1m30s', 'x-ratelimit-reset-tokens': '20ms' }), { kind: 'rate-limited', retryAfterMs: 90_000 }],
    ['an exhausted quota', refusal(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }), { kind: 'usage-limit', code: 'insufficient_quota' }],
    ['an overflow by code', refusal(400, { error: { message: 'too long', type: 'invalid_request_error', code: 'context_length_exceeded' } }), { kind: 'context-overflow' }],
    ['a bad request', refusal(400, { error: { message: 'Unknown model', type: 'invalid_request_error', code: 'model_not_found' } }), { kind: 'bad-request', code: 'model_not_found' }],
    ['a server failure', refusal(503, { error: { message: 'overloaded' } }), { kind: 'transient', status: 503 }],
    ['a server error', refusal(500, { error: { message: 'The server had an error', type: 'server_error' } }), { kind: 'transient', status: 500 }],
  ])('classifies %s', async (_name, response, expected) => {
    const err = await failure(clientFor(replay(response)), BASE_REQUEST);
    expect(err).toBeInstanceOf(ModelError);
    expect(err).toMatchObject(expected);
  });

  it('classifies a response.failed event by its code, with the wait its message names', async () => {
    const err = await failure(clientFor(replay(recorded('failed.sse'))), BASE_REQUEST);
    expect(err).toMatchObject({ kind: 'rate-limited', code: 'rate_limit_exceeded', retryAfterMs: 1500 });
  });

  it.each(['error-event.sse', 'error-data.sse'])('classifies an error event inside the stream (%s)', async (name) => {
    const err = await failure(clientFor(replay(recorded(name))), BASE_REQUEST);
    expect(err).toMatchObject({ kind: 'context-overflow', code: 'context_length_exceeded' });
  });

  it('marks an unreachable provider as a network failure', async () => {
    const transport = replay(() => { throw new TypeError('fetch failed'); });
    const err = await failure(clientFor(transport), BASE_REQUEST);
    expect(err).toMatchObject({ kind: 'transient', network: true });
  });

  describe('a model that refuses the reasoning settings', () => {
    const refused = () => refusal(400, { error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning.effort' } });

    it('is retried once without them, and remembered', async () => {
      const transport = replay(refused, recorded('text.sse'), recorded('text.sse'));
      const client = clientFor(transport);
      const request = { ...BASE_REQUEST, model: 'gpt-5.2-custom', effort: 'high' } as const;
      await collect(client, request);
      await collect(client, request);
      expect(transport.sent).toHaveLength(3);
      expect(transport.sent[0].body.reasoning).toEqual({ summary: 'auto', effort: 'high' });
      expect(transport.sent[1].body.reasoning).toBeUndefined();
      expect(transport.sent[1].body.include).toBeUndefined();
      expect(transport.sent[2].body.reasoning).toBeUndefined();
    });

    it('is not retried when the refusal blames another field', async () => {
      const transport = replay(refusal(400, { error: { message: 'bad tools', type: 'invalid_request_error', param: 'tools' } }));
      const err = await failure(clientFor(transport), { ...BASE_REQUEST, model: REASONER, effort: 'high' });
      expect(err).toMatchObject({ kind: 'bad-request', param: 'tools' });
      expect(transport.sent).toHaveLength(1);
    });
  });
});
