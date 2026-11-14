import { describe, it, expect } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import { fakeFileSystem } from '../../testing';
import { OpenAiService } from '../OpenAiService';
import { PlannerClients, plannerEffort, plannerRequest, streamReply, usageRecordOf, type PlannerMessage } from '../modelPlannerChat';
import { createModelClient, ModelError, type ModelClient, type ModelEvent, type ModelRequest, type ToolDefinition } from '../model';

const tool: ToolDefinition = { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };

const conversation: PlannerMessage[] = [
  { role: 'system', content: 'You plan.' },
  { role: 'user', content: 'add a cache' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'export const a = 1;' },
  { role: 'user', content: 'and a test' },
];

/** The wire body and path a provider's request reaches, refused at once so nothing streams. */
async function sentOver(provider: 'anthropic' | 'openai', request: ModelRequest): Promise<{ path: string; body: Record<string, unknown> }> {
  let sent: { path: string; body: Record<string, unknown> } | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent = { path: new URL(url).pathname, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return new Response(JSON.stringify({ error: { message: 'refused for the test' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  const clients = new PlannerClients((options) => createModelClient({ ...options, fetch }));
  await expect(streamReply(clients.get(provider, 'key', ''), request, undefined)).rejects.toThrow();
  return sent!;
}

describe('plannerRequest', () => {
  it('puts the system prompt in system with a breakpoint, and asks for one after the tools and at the last message', () => {
    const request = plannerRequest(conversation, { model: 'm', tools: [tool], maxOutputTokens: 1000 });

    expect(request.system).toEqual([{ text: 'You plan.', cacheBreakpoint: true }]);
    expect(request.cache).toEqual({ afterTools: true, atLastMessage: true });
    expect(request.toolChoice).toBe('auto');
    expect(request.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(request.messages[1]).toMatchObject({ toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' }, rawArguments: '{"path":"a.ts"}' }] });
    // A result names the call it answers, so Gemini can key it by tool.
    expect(request.messages[2]).toEqual({ role: 'tool', results: [{ callId: 'c1', name: 'read_file', output: 'export const a = 1;' }] });
  });

  it('marks only the last of several system parts, the end of the stable prefix', () => {
    const request = plannerRequest([{ role: 'system', content: 'one' }, { role: 'system', content: 'two' }, { role: 'user', content: 'go' }], { model: 'm', tools: [], maxOutputTokens: 10 });
    expect(request.system).toEqual([{ text: 'one', cacheBreakpoint: false }, { text: 'two', cacheBreakpoint: true }]);
    expect(request.cache).toEqual({ afterTools: false, atLastMessage: true });
    expect(request.toolChoice).toBeUndefined();
  });

  it('joins consecutive user turns when asked, as the Gemini planner always sent them', () => {
    const messages: PlannerMessage[] = [{ role: 'user', content: 'goal' }, { role: 'user', content: 'budgets' }];
    expect(plannerRequest(messages, { model: 'm', tools: [], maxOutputTokens: 10, mergeSameRole: true }).messages).toEqual([{ role: 'user', text: 'goal\n\nbudgets' }]);
    expect(plannerRequest(messages, { model: 'm', tools: [], maxOutputTokens: 10 }).messages).toHaveLength(2);
  });

  it('sends the effort only when one is set', () => {
    expect(plannerRequest(conversation, { model: 'm', tools: [], maxOutputTokens: 10, effort: 'high' }).effort).toBe('high');
    expect(plannerRequest(conversation, { model: 'm', tools: [], maxOutputTokens: 10 })).not.toHaveProperty('effort');
  });
});

describe('plannerEffort', () => {
  it('reads the planner\'s effort setting as a request\'s effort, and leaves an unknown one to the model', () => {
    expect(plannerEffort(' High ')).toBe('high');
    expect(plannerEffort('max')).toBe('max');
    expect(plannerEffort('extreme')).toBeUndefined();
    expect(plannerEffort(undefined)).toBeUndefined();
  });
});

describe('usageRecordOf', () => {
  it('counts the whole prompt, cache writes included, and the cached share as the reads alone', () => {
    expect(usageRecordOf('anthropic', 'claude', { inputTokens: 1200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 300 })).toEqual({
      source: 'anthropic', model: 'claude', inputTokens: 1200, outputTokens: 50, cachedInputTokens: 800, contextTokens: 1250,
    });
  });

  it('bills only a cost the provider reported, and records nothing for nothing reported', () => {
    expect(usageRecordOf('openrouter', 'm', { inputTokens: 1, cost: { amount: 0.5, currency: 'USD' } })?.reportedCost).toEqual({ amount: 0.5, currency: 'USD', kind: 'billed' });
    expect(usageRecordOf('openai', 'm', {})).toBeUndefined();
    expect(usageRecordOf('openai', 'm', undefined)).toBeUndefined();
  });
});

describe('each provider by its dialect', () => {
  it('reaches Anthropic over Messages, with cache breakpoints and thinking at the planner\'s effort', async () => {
    const { path, body } = await sentOver('anthropic', plannerRequest(conversation, { model: 'claude-sonnet-5-5', tools: [tool], maxOutputTokens: 4000, effort: 'high' }));

    expect(path).toMatch(/\/messages$/);
    const json = JSON.stringify(body);
    expect(json).toContain('cache_control');
    expect(body).toHaveProperty('thinking');
    expect(body.system).toEqual([expect.objectContaining({ text: 'You plan.', cache_control: expect.any(Object) })]);
  });

  it('reaches OpenAI over Responses, the effort as its reasoning effort', async () => {
    const { path, body } = await sentOver('openai', plannerRequest(conversation, { model: 'gpt-5', tools: [tool], maxOutputTokens: 4000, effort: 'low' }));

    expect(path).toMatch(/\/responses$/);
    expect(body.reasoning).toMatchObject({ effort: 'low' });
  });
});

describe('a usage limit on the API planner (ADR-0044)', () => {
  it('ends the turn as the provider\'s limit, its reset taken from the error\'s field', async () => {
    const resetsAt = Date.parse('2026-11-15T03:00:00Z');
    const limited: ModelClient = {
      provider: 'openai',
      dialect: 'responses',
      // eslint-disable-next-line require-yield -- refuses before its first event, as a spent limit does
      async *stream(): AsyncIterable<ModelEvent> {
        throw new ModelError({ kind: 'usage-limit', message: 'You exceeded your current quota.', status: 429, resetsAt });
      },
    };
    const config = {
      aiProvider: 'openai',
      orchestratorModel: 'openai:gpt-5',
      getProviderBaseUrl: () => '',
      getProviderApiKey: () => 'sk-test',
    } as unknown as IConfig;

    const reply = await new OpenAiService(config, { modelClient: () => limited }).startConversation({
      goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem() as IFileSystem, onProgress: () => {},
    });

    expect(reply).toMatchObject({ kind: 'message', failed: true, usageLimit: { resetsAt: '2026-11-15T03:00:00.000Z' } });
  });
});
