import { describe, expect, it } from 'vitest';
import { requestBody as anthropicBody } from '../adapters/anthropicMessages';
import { requestBody as chatBody } from '../adapters/chatCompletions';
import { createGeminiClient } from '../adapters/gemini';
import { requestBody as responsesBody } from '../adapters/responses';
import type { Dialect } from '../dialects';
import type { AiProvider } from '../../../interfaces/IConfig';
import type { ModelMessage, ModelRequest } from '../types';
import { BASE_REQUEST, collect, fixture, replay, sse } from './replay';

// How each dialect answers the request-level reasoning hint (ADR-0070): which
// earlier turns may go back without their reasoning. Every case compares the
// body sent with the hint against the body sent without it, so "ignores the
// hint" means byte for byte.

const TOOLS: ModelRequest['tools'] = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const FLASH = 'deepseek/deepseek-v4.1-flash';

/** The upstreams the reasoning-omission probe found took a conversation whose older turns carried none, by the names OpenRouter reports. */
const PROBED = [
  'BaseTen', 'Cloudflare', 'Cohere', 'CoreWeave', 'Crusoe', 'DeepInfra', 'DigitalOcean', 'Fireworks', 'Google', 'InferenceNet', 'Ionstream', 'Makora',
  'Mancer 2', 'Modal', 'Nebius', 'OpenInference', 'Parasail', 'Reka', 'Relace', 'River', 'Together', 'Venice', 'Wafer',
];

/** A task message, then three tool-calling turns each with its result: the turns sit at 1, 3 and 5. */
function conversation(dialect: Dialect, data: (turn: number) => unknown): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', text: 'Read the three files.' }];
  for (let turn = 1; turn <= 3; turn++) {
    const id = `call_${turn}`;
    messages.push({ role: 'assistant', text: '', toolCalls: [{ id, name: 'read_file', arguments: { path: `${turn}.ts` }, rawArguments: `{"path":"${turn}.ts"}` }], providerState: { dialect, data: data(turn) } });
    messages.push({ role: 'tool', results: [{ callId: id, name: 'read_file', output: `file ${turn}` }] });
  }
  return messages;
}

const HINT = { reasoning: { keepFrom: 5 } } as const;

function chatState(turn: number, upstream: string | undefined, model = FLASH, field: 'reasoning' | 'reasoning_content' = 'reasoning'): unknown {
  return {
    reasoning: `thought ${turn}`,
    field,
    details: [{ type: 'reasoning.text', text: `thought ${turn}`, index: 0 }],
    ...(upstream ? { upstream: { model, name: upstream } } : {}),
  };
}

function chatRequest(upstream: string | undefined, model = FLASH): ModelRequest {
  return { ...BASE_REQUEST, model, tools: TOOLS, messages: conversation('chat-completions', (turn) => chatState(turn, upstream, model)) };
}

type Wire = { role: string; reasoning_details?: unknown; reasoning_content?: unknown };
const assistants = (body: { messages: unknown[] }) => (body.messages as Wire[]).filter((m) => m.role === 'assistant');

describe('chat-completions through OpenRouter', () => {
  it('leaves out the reasoning before the boundary on an upstream the probe showed takes that, and keeps the call there', () => {
    const body = chatBody('openrouter', { ...chatRequest('DeepInfra'), ...HINT });
    expect(assistants(body).map((m) => m.reasoning_details !== undefined)).toEqual([false, false, true]);
    expect(assistants(body)[2]?.reasoning_details).toEqual([{ type: 'reasoning.text', text: 'thought 3', index: 0 }]);
    // A fallback stays among the upstreams known to take it, so the next call's upstream is one of them.
    expect(body.provider).toEqual({ order: ['DeepInfra'], allow_fallbacks: true, only: PROBED });
  });

  it.each(PROBED)('honours the hint on %s', (upstream) => {
    expect(assistants(chatBody('openrouter', { ...chatRequest(upstream), ...HINT })).map((m) => m.reasoning_details !== undefined)).toEqual([false, false, true]);
  });

  it.each([
    ['the upstream is not known', chatRequest(undefined)],
    ['the upstream was not probed', chatRequest('Novita')],
    ['the probe could not reach it', chatRequest('SiliconFlow')],
    ['the model was not probed, on a probed upstream', chatRequest('DeepInfra', 'qwen/qwen3-coder')],
    ['the model id routes itself', chatRequest('DeepInfra', `${FLASH}:nitro`)],
    ['a Claude model, whose upstream checks its signatures', chatRequest('Anthropic', 'anthropic/claude-haiku-5.5')],
  ])('sends everything, byte for byte as with no hint, when %s', (_why, request) => {
    expect(JSON.stringify(chatBody('openrouter', { ...request, ...HINT }))).toBe(JSON.stringify(chatBody('openrouter', request)));
  });

  it('leaves out a reasoning_content an upstream streamed, too, before the boundary', () => {
    const request: ModelRequest = { ...BASE_REQUEST, model: FLASH, tools: TOOLS, messages: conversation('chat-completions', (turn) => chatState(turn, 'Fireworks', FLASH, 'reasoning_content')) };
    const body = chatBody('openrouter', { ...request, ...HINT });
    expect(assistants(body).map((m) => m.reasoning_content !== undefined)).toEqual([false, false, true]);
  });
});

describe('chat-completions to a provider directly', () => {
  // DeepSeek's thinking-mode guide: a request with tools must carry every earlier turn's reasoning, or it is answered 400.
  it.each(['deepseek', 'kimi', 'groq', 'together', 'openai_compatible'] satisfies AiProvider[])('%s ignores the hint', (provider) => {
    const request: ModelRequest = { ...BASE_REQUEST, model: 'deepseek-chat', tools: TOOLS, messages: conversation('chat-completions', (turn) => chatState(turn, undefined, 'deepseek-chat', 'reasoning_content')) };
    expect(JSON.stringify(chatBody(provider, { ...request, ...HINT }))).toBe(JSON.stringify(chatBody(provider, request)));
  });

  it('sends DeepSeek every turn\'s reasoning under the hint', () => {
    const request: ModelRequest = { ...BASE_REQUEST, model: 'deepseek-chat', tools: TOOLS, messages: conversation('chat-completions', (turn) => chatState(turn, undefined, 'deepseek-chat', 'reasoning_content')) };
    expect(assistants(chatBody('deepseek', { ...request, ...HINT })).map((m) => m.reasoning_content)).toEqual(['thought 1', 'thought 2', 'thought 3']);
  });
});

describe('the other dialects ignore the hint', () => {
  it('Anthropic messages', () => {
    const request: ModelRequest = {
      ...BASE_REQUEST,
      model: 'claude-opus-5-5',
      tools: TOOLS,
      messages: conversation('anthropic-messages', (turn) => ({ content: [{ type: 'thinking', thinking: `thought ${turn}`, signature: `sig${turn}` }] })),
    };
    expect(JSON.stringify(anthropicBody({ ...request, ...HINT }))).toBe(JSON.stringify(anthropicBody(request)));
  });

  it('OpenAI responses', () => {
    const request: ModelRequest = {
      ...BASE_REQUEST,
      model: 'gpt-5.5',
      tools: TOOLS,
      messages: conversation('responses', (turn) => ({ items: [{ type: 'reasoning', id: `rs_${turn}`, summary: [], encrypted_content: `enc${turn}` }] })),
    };
    expect(JSON.stringify(responsesBody({ ...request, ...HINT }))).toBe(JSON.stringify(responsesBody(request)));
  });

  it('Gemini', async () => {
    const request: ModelRequest = {
      ...BASE_REQUEST,
      model: 'gemini-3-flash-preview',
      tools: TOOLS,
      messages: conversation('gemini', (turn) => ({ parts: [{ text: `thought ${turn}`, thought: true }, { functionCall: { name: 'read_file', args: { path: `${turn}.ts` } }, thoughtSignature: `sig${turn}` }] })),
    };
    const transport = replay(sse(fixture('gemini', 'text.sse')), sse(fixture('gemini', 'text.sse')));
    const client = createGeminiClient({ provider: 'google', apiKey: 'AIza-test', baseUrl: '', fetch: transport.fetch });
    await collect(client, request);
    await collect(client, { ...request, ...HINT });
    expect(JSON.stringify(transport.sent[1]?.body)).toBe(JSON.stringify(transport.sent[0]?.body));
  });
});
