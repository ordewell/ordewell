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
import { PlannerUsageLedger } from '../PlannerUsage';
import { SessionWindows } from '../ContextWindowFill';
import { TurnBudgets } from '../PlannerBudgets';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { makeSession, testWorkspace } from './sessionTestKit';

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

  function usageEvents(config: IConfig, chunks: unknown[]): Promise<UsageRecord[]> {
    createSpy.mockReturnValue(streamOf(chunks));
    const progress: ResearchProgress[] = [];
    const req: ConversationRequest = {
      goal: 'add a cache',
      runners: ['claude-code'],
      modelsByRunner: {},
      fs: fakeFileSystem(),
      onProgress: (p) => progress.push(p),
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
        reportedCost: { amount: 0.0012, currency: 'USD', kind: 'billed' },
        contextTokens: 150,
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

    expect(records).toEqual([{ source: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 2, contextTokens: 12 }]);
    expect(records[0]).not.toHaveProperty('reportedCost');
    expect(records[0]).not.toHaveProperty('cachedInputTokens');
  });

  // The provider reports no window, so a record claims none: the session reads
  // the window of the model a record names from its catalog, per call.
  it('claims no context window the provider did not report', async () => {
    const records = await usageEvents(cfg(), [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }]);
    expect(records[0]).not.toHaveProperty('contextWindow');
  });

  it('measures the context against the window of the model each call used, across a same-provider switch', async () => {
    const config = cfg();
    const progress: ResearchProgress[] = [];
    createSpy
      .mockReturnValueOnce(streamOf([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [], usage: { prompt_tokens: 90000, completion_tokens: 2 } }]))
      .mockReturnValueOnce(streamOf([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [], usage: { prompt_tokens: 30000, completion_tokens: 2 } }]));
    const service = new OpenAiService(config);
    await service.startConversation({ goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: (p) => progress.push(p) });
    config.orchestratorModel = 'openai:gpt-4o-mini';
    await service.continueConversation('go on', (p) => progress.push(p));

    const windows: Record<string, number> = { 'gpt-4o': 128000, 'gpt-4o-mini': 64000 };
    const ledger = new PlannerUsageLedger(new SessionWindows((source, model) => source === 'openai' ? windows[model] : undefined));
    for (const p of progress) if (p.type === 'usage') ledger.record(p.record!);

    expect(ledger.message().model).toBe('gpt-4o-mini');
    // The prompt and the reply it produced, both in the next call's prompt.
    expect(ledger.message().contextFill).toEqual({ usedTokens: 30002, windowTokens: 64000 });
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
      { source: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 10, contextTokens: 110 },
      { source: 'openai', model: 'gpt-4o-mini', inputTokens: 40, outputTokens: 4, subagentId },
      { source: 'openai', model: 'gpt-4o', inputTokens: 150, outputTokens: 5, contextTokens: 155 },
    ]);
  });
});

describe('OpenAiService turn budgets', () => {
  beforeEach(() => createSpy.mockReset());

  it('puts the budget block in each turn\'s user message and never in the system prompt', async () => {
    createSpy.mockImplementation(() => streamOf([{ choices: [{ delta: { content: 'Which store?' }, finish_reason: 'stop' }] }]));
    let left = 40;
    const service = new OpenAiService(cfg(), { turnBudgets: new TurnBudgets([() => `Web reads left this turn: ${left}.`]) });
    await service.startConversation({ goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {} });
    left = 39;
    await service.continueConversation('in-process', () => {});

    const messages = (createSpy.mock.calls.at(-1)?.[0] as { messages: Array<{ role: string; content: string }> }).messages;
    const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(users).toEqual([
      'add a cache\n\nCONTEXT AND BUDGETS (this turn):\n- Web reads left this turn: 40.',
      'in-process\n\nCONTEXT AND BUDGETS (this turn):\n- Web reads left this turn: 39.',
    ]);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).not.toContain('CONTEXT AND BUDGETS');
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

/**
 * A provider counting four characters of message text to a token, so what a
 * call is measured at follows what it carries.
 */
function measuring(next: () => unknown[]) {
  return ({ messages }: { messages: Array<{ content?: string | null }> }) => {
    const promptTokens = Math.ceil(messages.reduce((n, m) => n + (m.content ?? '').length, 0) / 4);
    return streamOf([...next(), { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 5 } }]);
  };
}

/** A window whose ceiling (three quarters of a window under 128k) sits just over `promptTokens`, so a call carrying more is pruned. */
const windowJustOver = (promptTokens: number) => Math.floor((promptTokens * 1.05) / 0.75);

/** What the provider measured the last call at. */
const lastPromptTokens = () => (createSpy.mock.calls.at(-1)![0] as { messages: Array<{ content?: string | null }> }).messages.reduce((n, m) => n + (m.content ?? '').length, 0) / 4;

// ADR-0012 T10: a history pruned in place may have lost what a turn was sent,
// so the conversation is told of every pruning that removed something.
describe('OpenAiService compactions', () => {
  beforeEach(() => { createSpy.mockReset(); });

  const readsFile = (id: string) => () => [
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'read_file', arguments: `{"path":"${id}.ts"}` } }] }, finish_reason: 'tool_calls' }] },
  ];
  const answers = () => [{ choices: [{ delta: { content: 'Read it.' }, finish_reason: 'stop' }] }];
  const script = (...turns: Array<() => unknown[]>) => createSpy.mockImplementation(measuring(() => turns.shift()!()));
  const start = (service: OpenAiService) => service.startConversation({
    goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, onProgress: () => {},
    fs: fakeFileSystem({ readFile: async () => ({ success: true, output: 'x'.repeat(40_000), truncated: false }) }),
  });

  it('counts a pruning ahead of a call, and no call that found nothing to prune', async () => {
    const catalog: { contextWindow?: number } = {};
    const service = new OpenAiService(cfg(), { modelLimits: () => catalog });
    script(readsFile('a'), answers, answers, answers);
    await start(service);
    expect(service.compactions()).toBe(0);

    // The read is a turn old: the next message has no room for it.
    catalog.contextWindow = windowJustOver(lastPromptTokens());
    await service.continueConversation('go on', () => {});
    expect(service.compactions()).toBe(1);

    await service.continueConversation('and on', () => {});
    expect(service.compactions()).toBe(1);
  });

  it('counts a pruning asked for through pruneContext, which keeps the two newest rounds', async () => {
    script(readsFile('a'), readsFile('b'), readsFile('c'), answers);
    const service = new OpenAiService(cfg());
    await start(service);
    expect(service.compactions()).toBe(0);

    expect(service.pruneContext()).toBeGreaterThan(0);
    expect(service.compactions()).toBe(1);
    expect(service.pruneContext()).toBe(0);
    expect(service.compactions()).toBe(1);
  });
});

// ADR-0012 T10 end to end, through a session: the message list keeps every
// turn, so the plan goes whole once, then as what changed.
describe('the plan block an API planner is sent', () => {
  beforeEach(() => { createSpy.mockReset(); });

  const WHOLE = /^<current_plan>$/m;
  const says = () => [{ choices: [{ delta: { content: 'Noted.' }, finish_reason: 'stop' }] }];
  const readsAFile = () => [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-read', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] },
  ];

  function twoTaskPlan(): LegacyPlanState {
    return {
      tasks: [
        createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', assignedRunner: 'claude-code' }),
        createTask({ id: 'b', order: 2, title: 'Build', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
      ],
      generatedAt: '2026-10-23T09:00:00Z',
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: '2026-10-23T09:00:00Z',
      conversationHistory: [
        { role: 'user', content: 'add a cache', timestamp: '2026-10-23T09:00:00Z' },
        { role: 'assistant', content: 'Two tasks.', timestamp: '2026-10-23T09:00:01Z' },
      ],
    };
  }

  it('goes whole into the replay, then as what changed, and whole again after a turn pruned the history', async () => {
    const sent: string[] = [];
    const calls: Array<() => unknown[]> = [says, says, readsAFile, says, says, says];
    const measured = measuring(() => calls.shift()!());
    createSpy.mockImplementation((req: { messages: Array<{ role: string; content: string }> }) => {
      const last = req.messages.at(-1);
      if (last?.role === 'user') sent.push(last.content);
      return measured(req);
    });
    const catalog: { contextWindow?: number } = {};
    const session = makeSession({
      aiService: new OpenAiService(cfg(), { modelLimits: () => catalog }),
      fsAdapter: fakeFileSystem({ readFile: async () => ({ success: true, output: 'x'.repeat(40_000), truncated: false }) }),
    });
    session.loadPlan(twoTaskPlan(), 'add a cache', testWorkspace, { persist: false });

    await session.continueConversation('what is there?');
    await session.continueConversation('anything new?');
    await session.continueConversation('read a.ts');
    // The read is a turn old by the next message, which has no room for it.
    // That turn's blocks were built before its call pruned, against a context
    // that held them (pruning takes tool output only); the turn after it goes whole.
    catalog.contextWindow = windowJustOver(lastPromptTokens());
    await session.continueConversation('and now?');
    await session.continueConversation('and then?');

    expect(sent).toHaveLength(5);
    expect(sent[0]).toMatch(WHOLE);
    expect(sent[1]).not.toMatch(WHOLE);
    expect(sent[1]).toMatch(/<plan_changes>[^\n]*unchanged/);
    expect(sent[2]).not.toMatch(WHOLE);
    expect(sent[3]).not.toMatch(WHOLE);
    expect(sent[4]).toMatch(WHOLE);
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

  it('names the configured provider and its variable when the key is missing, and points at /planner', () => {
    const service = new OpenAiService(cfg({ aiProvider: 'openrouter', getProviderApiKey: () => '' } as Partial<IConfig>));
    expect(() => service.ensureInit()).toThrow(
      'OpenRouter API key not configured. Set OPENROUTER_API_KEY, or pick a coding agent with /planner: it plans with no API key.',
    );
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

describe('OpenAiService execution tools (ADR-0029)', () => {
  beforeEach(() => createSpy.mockReset());

  const toolNames = (call: number) => ((createSpy.mock.calls[call][0] as { tools: Array<{ function: { name: string } }> }).tools).map((t) => t.function.name);
  const systemPrompt = () => ((createSpy.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> }).messages[0].content);

  it('declares them when the session offers its planner tools, and answers a call through the offered handler', async () => {
    createSpy
      .mockReturnValueOnce(streamOf([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'stop_task', arguments: '{"task":"2"}' } }] }, finish_reason: 'tool_calls' }] }]))
      .mockReturnValueOnce(streamOf([{ choices: [{ delta: { content: 'Stopped task 2.' }, finish_reason: 'stop' }] }]));
    const stopTask = vi.fn(async () => ({ text: '{"ok":true,"result":"Stopped task #2."}' }));
    const progress: ResearchProgress[] = [];

    const turn = await new OpenAiService(cfg({ researchMaxSteps: 10 } as Partial<IConfig>)).startConversation({
      goal: 'stop task 2', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: (p) => progress.push(p),
      plannerTools: { sessionId: 's1', handler: { stopTask } },
    });

    expect(toolNames(0)).toEqual(expect.arrayContaining(['run_plan', 'run_task', 'stop_task', 'stop_run', 'retry_task', 'message_task', 'answer_approval', 'answer_checkpoint']));
    expect(systemPrompt()).toContain('RUNNING THE PLAN:');
    expect(systemPrompt()).toMatch(/- answer_checkpoint .*Only the supervisor at Act may, in a wake-up turn; in the user's own turn they answer it from the task's checkpoint card/);
    expect(stopTask).toHaveBeenCalledWith({ task: '2' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const fedBack = (createSpy.mock.calls[1][0] as { messages: Array<{ role: string; content: string }> }).messages.find((m) => m.role === 'tool');
    expect(fedBack?.content).toBe('{"ok":true,"result":"Stopped task #2."}');
    // Named as a harness planner's own tool is: the research tool union has no member for it.
    expect(progress.find((p) => p.type === 'tool_call')).toMatchObject({ tool: 'agent_tool', toolLabel: 'stop_task' });
    expect(turn.researchLog[0]).toMatchObject({ tool: 'agent_tool', toolLabel: 'stop_task', success: true });
  });

  it('neither declares them nor describes them without the offer', async () => {
    createSpy.mockReturnValueOnce(streamOf([{ choices: [{ delta: { content: 'Hello.' }, finish_reason: 'stop' }] }]));

    await new OpenAiService(cfg()).startConversation({ goal: 'hi', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {} });

    expect(toolNames(0)).not.toContain('run_task');
    expect(systemPrompt()).not.toContain('RUNNING THE PLAN:');
  });
});

/*
 * Whether a wake misses the prompt cache because its brief is sent and then
 * dropped from the history (ADR-0057). It is not dropped: a provider's prefix
 * cache hits only on a byte-identical prefix, and the live history keeps what
 * each turn sent, brief and blocks included. The transcript leaves them out,
 * which only a replay sees, and a replay is one fresh prefix however it reads.
 */
describe('OpenAiService: what a wake leaves in the prefix', () => {
  beforeEach(() => createSpy.mockReset());

  it('sends each call the last call\'s whole message list, unchanged, ahead of the new message', async () => {
    createSpy.mockImplementation(() => streamOf([{ choices: [{ delta: { content: 'Noted.' }, finish_reason: 'stop' }] }]));
    const service = new OpenAiService(cfg());
    await service.startConversation({ goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {} });

    await service.continueConversation('Run update:\n- task #1 failed\n\nThe level brief, 2,300 characters of it.', () => {});
    await service.continueConversation('Run update:\n- task #2 failed', () => {});

    const sent = createSpy.mock.calls.map((call) => (call[0] as { messages: unknown[] }).messages);
    const [opening, first, second] = sent;
    expect(first.slice(0, opening.length)).toEqual(opening);
    expect(second.slice(0, first.length)).toEqual(first);
    expect(JSON.stringify(second)).toContain('The level brief');
  });
});
