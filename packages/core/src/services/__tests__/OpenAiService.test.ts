import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import { fakeFileSystem } from '../../testing';
import type { ResearchProgress } from '../../models/Task';
import type { UsageRecord } from '../../models/Usage';
import type { ConversationRequest } from '../AiService';
import type { SkillInfo } from '../SkillsService';

const createSpy = vi.hoisted(() => vi.fn());
const clientSpy = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createSpy } };
    constructor(opts: unknown) { clientSpy(opts); }
  },
}));

import { OpenAiService } from '../OpenAiService';

function streamOf(chunks: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function cfg(over: Partial<IConfig> = {}): IConfig {
  return {
    aiProvider: 'openai',
    orchestratorModel: 'openai:gpt-4o',
    getProviderBaseUrl: () => 'https://api.openai.com/v1',
    getProviderApiKey: () => 'sk-test',
    ...over,
  } as unknown as IConfig;
}

/** Invoke the protected streamPlanText and return the model sent to the API. */
async function modelSentFor(config: IConfig): Promise<string> {
  createSpy.mockReturnValue(streamOf([{ choices: [{ delta: { content: 'ok' } }] }]));
  const service = new OpenAiService(config);
  await (service as unknown as {
    streamPlanText(p: string, h: string | undefined, onToken: (t: string) => void): Promise<string>;
  }).streamPlanText('prompt', undefined, () => {});
  return (createSpy.mock.calls[0][0] as { model: string }).model;
}

describe('OpenAiService model-id prefix stripping', () => {
  beforeEach(() => createSpy.mockClear());

  it('strips the provider prefix before sending the model to the API', async () => {
    expect(await modelSentFor(cfg())).toBe('gpt-4o');
  });

  it('passes openai_compat: models through as the bare id', async () => {
    const model = await modelSentFor(cfg({
      aiProvider: 'openai_compatible',
      orchestratorModel: 'openai_compat:llama3',
    } as Partial<IConfig>));
    expect(model).toBe('llama3');
  });

  it('leaves an unprefixed OpenRouter id untouched', async () => {
    const model = await modelSentFor(cfg({
      aiProvider: 'openrouter',
      orchestratorModel: 'openai/gpt-4o',
    } as Partial<IConfig>));
    expect(model).toBe('openai/gpt-4o');
  });
});

describe('OpenAiService usage reporting (#49)', () => {
  beforeEach(() => createSpy.mockClear());

  function usageEvents(config: IConfig, chunks: unknown[], contextWindow?: number): Promise<UsageRecord[]> {
    createSpy.mockReturnValue(streamOf(chunks));
    const progress: ResearchProgress[] = [];
    const req: ConversationRequest = {
      goal: 'add a cache',
      runners: ['claude-code'],
      modelsByRunner: {},
      fs: fakeFileSystem(),
      onProgress: (p) => progress.push(p),
      ...(contextWindow ? { contextWindow } : {}),
    };
    return new OpenAiService(config).startConversation(req).then(() =>
      progress.filter((p) => p.type === 'usage').map((p) => p.record!),
    );
  }

  it('reports tokens, the cached share and the OpenRouter cost from the final chunk', async () => {
    const records = await usageEvents(
      cfg({ aiProvider: 'openrouter', orchestratorModel: 'openai/gpt-4o' } as Partial<IConfig>),
      [
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 80 }, cost: 0.0012 } },
      ],
    );

    expect(records).toEqual([
      {
        source: 'openrouter',
        model: 'openai/gpt-4o',
        inputTokens: 120,
        outputTokens: 30,
        cachedInputTokens: 80,
        reportedCost: { amount: 0.0012, currency: 'USD' },
      },
    ]);
  });

  it('leaves cost and cached share absent when the provider reports neither', async () => {
    const records = await usageEvents(
      cfg(),
      [
        { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ],
    );

    expect(records).toEqual([{ source: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 2 }]);
    expect(records[0]).not.toHaveProperty('reportedCost');
    expect(records[0]).not.toHaveProperty('cachedInputTokens');
  });

  it('carries a known context window on the record and omits an unknown one', async () => {
    const withWindow = await usageEvents(
      cfg(),
      [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }],
      128000,
    );
    expect(withWindow[0].contextWindow).toBe(128000);

    const withoutWindow = await usageEvents(
      cfg(),
      [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }],
    );
    expect(withoutWindow[0]).not.toHaveProperty('contextWindow');
  });

  // A research subagent's calls must reach the ledger as the subagent's, or its
  // prompt is read as the planner's own and the context fill measures the wrong model.
  it('files a research subagent\'s calls under that subagent, and only the planner\'s as its own', async () => {
    createSpy
      .mockReturnValueOnce(streamOf([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'spawn_research_agent', arguments: '{"prompt":"find the cache"}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
      ]))
      .mockReturnValueOnce(streamOf([
        { choices: [{ delta: { content: 'src/cache.ts holds it' } }] },
        { choices: [], usage: { prompt_tokens: 40, completion_tokens: 4 } },
      ]))
      .mockReturnValueOnce(streamOf([
        { choices: [{ delta: { content: 'It lives in src/cache.ts.' } }] },
        { choices: [], usage: { prompt_tokens: 150, completion_tokens: 5 } },
      ]));
    const progress: ResearchProgress[] = [];

    await new OpenAiService(cfg({ researchSubagentModel: 'openai:gpt-4o-mini', researchMaxSteps: 5 } as Partial<IConfig>)).startConversation({
      goal: 'where is the cache?',
      runners: ['claude-code'],
      modelsByRunner: {},
      fs: fakeFileSystem(),
      onProgress: (p) => progress.push(p),
    });

    const subagentId = progress.find((p) => p.type === 'subagent_started')?.subagentId;
    expect(subagentId).toBeDefined();
    expect(progress.filter((p) => p.type === 'usage').map((p) => p.record)).toEqual([
      { source: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 10 },
      { source: 'openai', model: 'gpt-4o-mini', inputTokens: 40, outputTokens: 4, subagentId },
      { source: 'openai', model: 'gpt-4o', inputTokens: 150, outputTokens: 5 },
    ]);
  });
});

describe('OpenAiService conversation history', () => {
  beforeEach(() => createSpy.mockReset());

  const toolCallChunks = () => streamOf([{
    choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${createSpy.mock.calls.length}`, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }, finish_reason: 'tool_calls' }],
  }]);

  /** Tool calls the history leaves unanswered — what the API refuses a request over. */
  function unansweredCalls(messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>): string[] {
    const answered = new Set(messages.flatMap((m) => (m.role === 'tool' && m.tool_call_id ? [m.tool_call_id] : [])));
    return messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : [])).filter((id) => !answered.has(id));
  }

  // A model that keeps calling tools past its wrap-up rounds ends the turn
  // with its last calls unanswered. The API refuses a history like that, so
  // every later message in the conversation failed.
  it('answers the calls a turn gave up on before the next message goes out', async () => {
    createSpy.mockImplementation(() => toolCallChunks());
    const service = new OpenAiService(cfg({ researchMaxSteps: 1 } as Partial<IConfig>));
    await service.startConversation({ goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {} });

    createSpy.mockImplementation(() => streamOf([{ choices: [{ delta: { content: 'Here is what I found.' }, finish_reason: 'stop' }] }]));
    await service.continueConversation('go on', () => {});

    const sent = createSpy.mock.calls.at(-1)?.[0] as { messages: Parameters<typeof unansweredCalls>[0] };
    expect(unansweredCalls(sent.messages)).toEqual([]);
  });
});

describe('OpenAiService credentials', () => {
  beforeEach(() => { createSpy.mockClear(); clientSpy.mockClear(); });

  const plan = (service: OpenAiService) => (service as unknown as {
    streamPlanText(p: string, h: string | undefined, onToken: (t: string) => void): Promise<string>;
  }).streamPlanText('prompt', undefined, () => {});

  it('sends a key replaced after the first call, not the one the client was built with', async () => {
    let key = 'sk-old';
    const service = new OpenAiService(cfg({ aiProvider: 'openrouter', orchestratorModel: 'openai/gpt-4o', getProviderApiKey: () => key } as Partial<IConfig>));
    createSpy.mockImplementation(() => streamOf([{ choices: [{ delta: { content: 'ok' } }] }]));

    await plan(service);
    key = 'sk-new';
    await plan(service);

    expect(clientSpy.mock.calls.map((c) => (c[0] as { apiKey: string }).apiKey)).toEqual(['sk-old', 'sk-new']);
  });

  it('keeps one client while the credentials are unchanged', async () => {
    const service = new OpenAiService(cfg());
    createSpy.mockImplementation(() => streamOf([{ choices: [{ delta: { content: 'ok' } }] }]));

    await plan(service);
    await plan(service);

    expect(clientSpy).toHaveBeenCalledTimes(1);
  });

  it('carries a key replaced mid-conversation into the next turn', async () => {
    let key = 'sk-old';
    const service = new OpenAiService(cfg({ aiProvider: 'openrouter', orchestratorModel: 'openai/gpt-4o', getProviderApiKey: () => key } as Partial<IConfig>));
    createSpy.mockImplementation(() => streamOf([{ choices: [{ delta: { content: 'ok' } }], finish_reason: 'stop' }]));

    await service.startConversation({
      goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {},
    });
    key = 'sk-new';
    await service.continueConversation('go on', () => {});

    expect(clientSpy.mock.calls.map((c) => (c[0] as { apiKey: string }).apiKey)).toEqual(['sk-old', 'sk-new']);
  });

  it('carries a model picked mid-conversation into the next turn', async () => {
    const config = cfg({ aiProvider: 'openrouter', orchestratorModel: 'openai/gpt-4o' } as Partial<IConfig>);
    const service = new OpenAiService(config);
    createSpy.mockImplementation(() => streamOf([{ choices: [{ delta: { content: 'ok' } }], finish_reason: 'stop' }]));

    await service.startConversation({
      goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {},
    });
    (config as { orchestratorModel: string }).orchestratorModel = 'deepseek/deepseek-v4-flash:free';
    await service.continueConversation('go on', () => {});

    expect(createSpy.mock.calls.map((c) => (c[0] as { model: string }).model)).toEqual(['openai/gpt-4o', 'deepseek/deepseek-v4-flash:free']);
  });

  it('names the configured provider and its variable when the key is missing', () => {
    const service = new OpenAiService(cfg({ aiProvider: 'openrouter', getProviderApiKey: () => '' } as Partial<IConfig>));
    expect(() => service.ensureInit()).toThrow('OpenRouter API key not configured. Set OPENROUTER_API_KEY.');
  });

  it('lets a keyless openai_compatible endpoint through with a placeholder key', async () => {
    const service = new OpenAiService(cfg({
      aiProvider: 'openai_compatible',
      orchestratorModel: 'openai_compat:llama3',
      openaiCompatibleBaseUrl: 'http://localhost:11434/v1',
      getProviderApiKey: () => '',
    } as Partial<IConfig>));
    createSpy.mockImplementation(() => streamOf([{ choices: [{ delta: { content: 'ok' } }] }]));

    expect(() => service.ensureInit()).not.toThrow();
    await plan(service);
    expect((clientSpy.mock.calls[0][0] as { apiKey: string }).apiKey).toBeTruthy();
  });
});

describe('OpenAiService planner skill catalog', () => {
  beforeEach(() => createSpy.mockReset());

  it('shows the task skills the planner may attach, and no planner skills, which load only through tools', async () => {
    createSpy.mockImplementation(() => streamOf([{ choices: [{ delta: { content: 'Which cache?' }, finish_reason: 'stop' }] }]));
    const skill = (name: string, appliesTo: SkillInfo['appliesTo']): SkillInfo => ({
      name, description: `${name} description`, metadata: { name, description: '' }, content: 'BODY',
      source: 'global', path: `/skills/${name}/SKILL.md`, appliesTo, modelInvocable: true, userInvocable: true,
    });

    await new OpenAiService(cfg()).startConversation({
      goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {},
      skills: [skill('pr-style', 'task'), skill('review-plan', 'planner')],
    });

    const [{ messages }] = createSpy.mock.calls[0] as [{ messages: { role: string; content: string }[] }];
    expect(messages[0].content).toContain('Task skills you may attach:\n- pr-style: pr-style description');
    expect(messages[0].content).not.toMatch(/review-plan|load_skill/);
  });
});
