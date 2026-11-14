import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import type { ToolOutcome } from '../../interfaces/IFileSystem';
import type { ResearchProgress } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { createEmptyPlan } from '../../models/Task';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';

const createSpy = vi.hoisted(() => vi.fn());

// The real Chat Completions adapter, its transport each test's `createSpy`: given a request's wire body, it returns the chunks to stream back.
vi.mock('../model', async (importOriginal) => {
  const { overChatCompletions } = await import('./plannerWire');
  return {
    ...await importOriginal<typeof import('../model')>(),
    createModelClient: (options: import('../model').ModelClientOptions) => {
      return overChatCompletions(options, (body, call) => createSpy(body, call));
    },
    withRetry: (client: import('../model').ModelClient) => client,
  };
});

import { OpenAiService } from '../OpenAiService';
import { PlannerContextExhaustedError, type ModelLimits } from '../plannerContextBudget';
import type { ConversationTurnContext } from '../BaseAiService';
import type { SessionMessage } from '../SessionMessage';
import { contextMeterText, contextMeterTitle } from '../../models/Usage';
import { makeSession, testWorkspace } from './sessionTestKit';

interface SentMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}
interface SentRequest {
  model: string;
  messages: SentMessage[];
  tools: unknown[];
  max_tokens: number;
}

/**
 * A provider that counts a request's prompt by its own rule — four characters
 * of message and tool text to a token — and refuses one whose prompt and
 * requested reply together pass the model's window, the way OpenAI does.
 */
class FakeProvider {
  readonly requests: Array<SentRequest & { promptTokens: number }> = [];
  refusals = 0;

  constructor(private windows: Record<string, number>, private replies: Array<() => unknown[]>) {}

  static tokensOf(req: SentRequest): number {
    const text = req.messages.map((m) => (m.content ?? '') + JSON.stringify(m.tool_calls ?? '')).join('') + JSON.stringify(req.tools);
    return Math.ceil(text.length / 4);
  }

  create = (req: SentRequest): AsyncIterable<unknown> => {
    // The SDK reads the list it was handed as it sends it; a copy is what went out.
    const sent = { ...req, messages: req.messages.map((m) => ({ ...m })) };
    const promptTokens = FakeProvider.tokensOf(sent);
    this.requests.push({ ...sent, promptTokens });
    const window = this.windows[req.model];
    if (window !== undefined && promptTokens + req.max_tokens > window) {
      this.refusals++;
      throw Object.assign(new Error(`400 This model's maximum context length is ${window} tokens. However, you requested ${promptTokens + req.max_tokens} tokens.`), {
        status: 400, code: 'context_length_exceeded', type: 'invalid_request_error',
      });
    }
    const chunks = this.replies.shift()?.() ?? [{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }];
    return (async function* () {
      for (const c of chunks) yield c;
      yield { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 5 } };
    })();
  };
}

const callsTool = (id: string, name: string, args: Record<string, unknown>) => () => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] },
];
const says = (text: string) => () => [{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }];

function cfg(over: Partial<IConfig> = {}): IConfig {
  return {
    aiProvider: 'openai',
    orchestratorModel: 'openai:big-model',
    researchMaxSteps: 40,
    getProviderBaseUrl: () => 'https://api.openai.com/v1',
    getProviderApiKey: () => 'sk-test',
    ...over,
  } as unknown as IConfig;
}

const file = (chars: number): ToolOutcome => ({ success: true, output: 'x'.repeat(chars), truncated: false });

/** Every tool call each request carries, answered exactly once and only after it was made. */
function pairsValid(messages: SentMessage[]): boolean {
  const asked = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    for (const c of m.tool_calls ?? []) asked.add(c.id);
    if (m.role === 'tool') {
      if (!m.tool_call_id || !asked.has(m.tool_call_id) || answered.has(m.tool_call_id)) return false;
      answered.add(m.tool_call_id);
    }
  }
  return [...asked].every((id) => answered.has(id));
}

const toolOutputs = (req: SentRequest) => req.messages.filter((m) => m.role === 'tool');

function service(config: IConfig, limits: Record<string, ModelLimits>, autoCompaction = () => true): OpenAiService {
  return new OpenAiService(config, {
    modelLimits: (source, model) => (source === 'openai' ? limits[model] : undefined),
    autoCompaction,
  });
}

function start(svc: OpenAiService, fs = fakeFileSystem({ readFile: async () => file(49_000) }), onProgress: (p: ResearchProgress) => void = () => {}) {
  return svc.startConversation({ goal: 'map the cache', runners: ['claude-code'], modelsByRunner: {}, fs, onProgress });
}

describe('an API planner budgets each call against its model\'s known window', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('keeps a long run of wide reads under 90% of the window less the reply it asks for, pruning only older reads', async () => {
    const rounds = 12;
    const provider = new FakeProvider({ 'big-model': 131_072 }, [
      ...Array.from({ length: rounds }, (_, i) => callsTool(`call_${i}`, 'read_file', { path: `f${i}.ts` })),
      says('All read.'),
    ]);
    createSpy.mockImplementation(provider.create);

    const turn = await start(service(cfg(), { 'big-model': { contextWindow: 131_072 } }));

    expect(turn.kind).toBe('message');
    expect(provider.refusals).toBe(0);
    expect(provider.requests).toHaveLength(rounds + 1);
    // 131,072 less the 32,000-token reply is 99,072, under 90% of the window (117,964).
    for (const req of provider.requests) {
      expect(req.promptTokens).toBeLessThanOrEqual(99_072);
      expect(req.max_tokens).toBe(32_000);
      expect(pairsValid(req.messages)).toBe(true);
      // The results being sent and the two newest rounds before them are what the model is acting on: never cut.
      for (const out of toolOutputs(req).slice(-3)) expect(out.content).toHaveLength(49_000);
      for (const out of toolOutputs(req)) expect(out.content).not.toMatch(/re-run/i);
    }
    const last = provider.requests.at(-1)!;
    expect(toolOutputs(last).some((m) => (m.content ?? '').length < 49_000)).toBe(true);
    expect(last.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['map the cache']);
  });
});

describe('the reply an API planner asks for', () => {
  beforeEach(() => { createSpy.mockReset(); });

  async function maxTokensSent(limits: ModelLimits | undefined): Promise<number> {
    const provider = new FakeProvider({}, [says('Hello.')]);
    createSpy.mockImplementation(provider.create);
    await start(service(cfg(), limits ? { 'big-model': limits } : {}));
    return provider.requests[0].max_tokens;
  }

  it('leaves a small window room for its prompt, and never asks past a cap the provider states', async () => {
    expect(await maxTokensSent({ contextWindow: 32_768 })).toBe(8_192);
    expect(await maxTokensSent({ contextWindow: 1_048_576, maxOutputTokens: 4_096 })).toBe(4_096);
    expect(await maxTokensSent({ maxOutputTokens: 4_096 })).toBe(4_096);
    expect(await maxTokensSent({ contextWindow: 131_072 })).toBe(32_000);
    expect(await maxTokensSent(undefined)).toBe(32_000);
  });
});

describe('an API planner whose model\'s window is unknown', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('prunes nothing ahead of a call, and says automatic compaction is off for want of the window', async () => {
    const provider = new FakeProvider({}, [
      ...Array.from({ length: 12 }, (_, i) => callsTool(`call_${i}`, 'read_file', { path: `f${i}.ts` })),
      says('All read.'),
    ]);
    createSpy.mockImplementation(provider.create);
    const svc = service(cfg(), {});

    await start(svc);

    for (const out of toolOutputs(provider.requests.at(-1)!)) expect(out.content).toHaveLength(49_000);
    expect(svc.compactions()).toBe(0);
    expect(svc.plannerContextStatus()).toEqual({ auto: 'unknown_window', model: 'big-model' });
  });

  it('states the window it budgets on once the catalog knows it, and that it is off when the config file says so', () => {
    expect(service(cfg(), { 'big-model': { contextWindow: 131_072 } }).plannerContextStatus())
      .toEqual({ auto: 'on', model: 'big-model', contextWindow: 131_072, maxOutputTokens: 32_000 });
    expect(service(cfg(), { 'big-model': { contextWindow: 131_072 } }, () => false).plannerContextStatus()).toEqual({ auto: 'off' });
  });
});

describe('a model switched in the middle of a planner turn', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('budgets the next call on the new model\'s window, without taking the old model\'s measurement as its own', async () => {
    const config = cfg();
    const replies = [
      ...Array.from({ length: 6 }, (_, i) => callsTool(`call_${i}`, 'read_file', { path: `f${i}.ts` })),
      says('All read.'),
    ];
    const provider = new FakeProvider({ 'big-model': 1_048_576, 'small-model': 64_000 }, replies);
    let calls = 0;
    createSpy.mockImplementation((req: SentRequest) => {
      // The user picks the smaller model while the fourth call is out.
      if (++calls === 4) (config as { orchestratorModel: string }).orchestratorModel = 'openai:small-model';
      return provider.create(req);
    });
    const progress: ResearchProgress[] = [];

    // Reads small enough that what is kept whole fits the smaller window; together they do not.
    await start(
      service(config, { 'big-model': { contextWindow: 1_048_576 }, 'small-model': { contextWindow: 64_000 } }),
      fakeFileSystem({ readFile: async () => file(30_000) }),
      (p) => progress.push(p),
    );

    expect(provider.requests.map((r) => r.model)).toEqual(['big-model', 'big-model', 'big-model', 'big-model', 'small-model', 'small-model', 'small-model']);
    expect(provider.refusals).toBe(0);
    // 64,000 less its 16,000-token reply is 48,000, under 90% of it (57,600).
    const small = provider.requests.filter((r) => r.model === 'small-model');
    expect(toolOutputs(small[0]).some((m) => (m.content ?? '').includes('read_file output pruned'))).toBe(true);
    for (const req of small) {
      expect(req.max_tokens).toBe(16_000);
      expect(req.promptTokens).toBeLessThanOrEqual(48_000);
      expect(pairsValid(req.messages)).toBe(true);
    }
    // Usage reports what each call's provider measured, and nothing estimated.
    const records = progress.filter((p) => p.type === 'usage').map((p) => p.record!);
    expect(records.map((r) => [r.model, r.inputTokens])).toEqual(provider.requests.map((r) => [r.model, r.promptTokens]));
  });

  it('refuses no message on the old model\'s tokenizer: a model nothing has measured is sent to, the provider being its judge', async () => {
    // Two tokenizers: the first model's two characters to a token, the second's five.
    const perToken: Record<string, number> = { 'dense-model': 2, 'sparse-model': 5 };
    const sent: SentRequest[] = [];
    createSpy.mockImplementation((req: SentRequest) => {
      sent.push(req);
      const chars = req.messages.reduce((n, m) => n + (m.content ?? '').length, 0) + JSON.stringify(req.tools).length;
      return (async function* () {
        yield { choices: [{ delta: { content: 'Noted.' }, finish_reason: 'stop' }] };
        yield { choices: [], usage: { prompt_tokens: Math.ceil(chars / perToken[req.model]), completion_tokens: 2 } };
      })();
    });
    const config = cfg({ orchestratorModel: 'openai:dense-model' } as Partial<IConfig>);
    const svc = service(config, { 'dense-model': { contextWindow: 200_000 }, 'sparse-model': { contextWindow: 200_000 } });
    await start(svc, fakeFileSystem({}));
    (config as { orchestratorModel: string }).orchestratorModel = 'openai:sparse-model';

    // 400,000 characters: 200,000 tokens on the first model's tokenizer, 80,000 on this one's.
    const message = 'y'.repeat(400_000);
    await svc.continueConversation(message, () => {});

    expect(sent.at(-1)!.model).toBe('sparse-model');
    expect(sent.at(-1)!.messages.at(-1)!.content).toContain(message);
  });
});

describe('what an API planner never prunes, and what it does when that cannot fit', () => {
  beforeEach(() => { createSpy.mockReset(); });

  const bashRounds = (n: number) => Array.from({ length: n }, (_, i) => callsTool(`bash_${i}`, 'bash', { command: `make step${i}` }));

  it('keeps every command\'s output whole, and ends the turn on a typed error instead of sending what cannot fit', async () => {
    const provider = new FakeProvider({ 'mid-model': 64_000 }, [...bashRounds(8), says('Built.')]);
    createSpy.mockImplementation(provider.create);
    const bash = vi.fn(async () => file(45_000));
    const svc = service(cfg({ orchestratorModel: 'openai:mid-model' } as Partial<IConfig>), { 'mid-model': { contextWindow: 64_000 } });

    const failed = start(svc, fakeFileSystem({ bash }));

    await expect(failed).rejects.toBeInstanceOf(PlannerContextExhaustedError);
    expect(provider.refusals).toBe(0);
    for (const req of provider.requests) {
      for (const out of toolOutputs(req)) expect(out.content).toHaveLength(45_000);
    }
    // The opening call, then one per round sent: the last round's results were held, not sent.
    const ran = bash.mock.calls.length;
    expect(provider.requests).toHaveLength(ran);

    // A larger model has room: the next message carries the held results once, and no command runs again.
    createSpy.mockImplementation(new FakeProvider({}, [says('Built.')]).create);
    (svc as unknown as { config: { orchestratorModel: string } }).config.orchestratorModel = 'openai:big-model';
    await svc.continueConversation('go on', () => {});
    const next = createSpy.mock.calls.at(-1)![0] as SentRequest;
    expect(pairsValid(next.messages)).toBe(true);
    expect(toolOutputs(next)).toHaveLength(ran);
    expect(bash).toHaveBeenCalledTimes(ran);
  });

  it('sends held results again whole on resend, running nothing a second time', async () => {
    const provider = new FakeProvider({ 'mid-model': 64_000 }, [...bashRounds(8), says('Built.')]);
    createSpy.mockImplementation(provider.create);
    const bash = vi.fn(async () => file(45_000));
    const config = cfg({ orchestratorModel: 'openai:mid-model' } as Partial<IConfig>);
    const svc = service(config, { 'mid-model': { contextWindow: 64_000 } });
    await expect(start(svc, fakeFileSystem({ bash }))).rejects.toBeInstanceOf(PlannerContextExhaustedError);
    const ran = bash.mock.calls.length;
    const chat = (svc as unknown as { conversation: { ctx: ConversationTurnContext } }).conversation.ctx.chat;
    expect(chat.holdsInput?.()).toBe(true);

    (config as { orchestratorModel: string }).orchestratorModel = 'openai:big-model';
    const later = new FakeProvider({}, [says('Built.')]);
    createSpy.mockImplementation(later.create);
    const turn = await chat.resend!();

    expect(turn.text).toBe('Built.');
    expect(chat.holdsInput?.()).toBe(false);
    expect(pairsValid(later.requests[0].messages)).toBe(true);
    expect(toolOutputs(later.requests[0])).toHaveLength(ran);
    expect(bash).toHaveBeenCalledTimes(ran);
  });

  it('takes a provider\'s refusal as one more pruning pass and one resend of the same results, then stops', async () => {
    // The catalog states a larger window than the provider serves: the estimate fits, the call does not.
    const provider = new FakeProvider({ 'big-model': 131_072 }, [
      ...Array.from({ length: 12 }, (_, i) => callsTool(`call_${i}`, 'read_file', { path: `f${i}.ts` })),
      says('All read.'),
    ]);
    createSpy.mockImplementation(provider.create);
    const readFile = vi.fn(async (_path: string) => file(49_000));
    const svc = service(cfg(), { 'big-model': { contextWindow: 200_000 } });

    const turn = await start(svc, fakeFileSystem({ readFile }));

    expect(turn.kind).toBe('message');
    expect(provider.refusals).toBe(1);
    // Once each: the conversation's own opening reads project files besides.
    expect(readFile.mock.calls.filter(([path]) => /^f\d+\.ts$/.test(path))).toHaveLength(12);
    const refused = provider.requests.findIndex((r) => r.promptTokens + r.max_tokens > 131_072);
    const resent = provider.requests[refused + 1];
    expect(toolOutputs(resent).map((m) => m.tool_call_id)).toEqual(toolOutputs(provider.requests[refused]).map((m) => m.tool_call_id));
    expect(pairsValid(resent.messages)).toBe(true);
  });

  it('with automatic compaction off, prunes nothing and holds what a refused call was to send', async () => {
    const provider = new FakeProvider({ 'big-model': 131_072 }, Array.from({ length: 12 }, (_, i) => callsTool(`call_${i}`, 'read_file', { path: `f${i}.ts` })));
    createSpy.mockImplementation(provider.create);
    const svc = service(cfg(), { 'big-model': { contextWindow: 131_072 } }, () => false);

    const failed = start(svc);

    await expect(failed).rejects.toMatchObject({ name: 'PlannerContextExhaustedError', refusedByProvider: true });
    expect(provider.refusals).toBe(1);
    expect(svc.compactions()).toBe(0);
    const refused = provider.requests.at(-1)!;
    for (const out of toolOutputs(refused)) expect(out.content).toHaveLength(49_000);

    // The refused results are filed once, under the next message; the history is not refused twice for a duplicate.
    createSpy.mockImplementation(new FakeProvider({}, [says('Noted.')]).create);
    await svc.continueConversation('stop reading', () => {});
    const next = createSpy.mock.calls.at(-1)![0] as SentRequest;
    expect(pairsValid(next.messages)).toBe(true);
    expect(toolOutputs(next)).toHaveLength(toolOutputs(refused).length);
  });

  it('keeps any other failure on its old path: the input stays in the history, and nothing is retried', async () => {
    const provider = new FakeProvider({}, [callsTool('call_0', 'read_file', { path: 'a.ts' })]);
    let calls = 0;
    createSpy.mockImplementation((req: SentRequest) => {
      if (++calls === 2) throw Object.assign(new Error('500 upstream unavailable'), { status: 500 });
      return provider.create(req);
    });
    const svc = service(cfg(), { 'big-model': { contextWindow: 131_072 } });

    await expect(start(svc)).rejects.toThrow('500 upstream unavailable');
    expect(calls).toBe(2);

    createSpy.mockImplementation(new FakeProvider({}, [says('Retrying.')]).create);
    await svc.continueConversation('try again', () => {});
    const next = createSpy.mock.calls.at(-1)![0] as SentRequest;
    expect(toolOutputs(next).map((m) => m.tool_call_id)).toEqual(['call_0']);
    expect(pairsValid(next.messages)).toBe(true);
  });
});

describe('a session\'s API planner', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('budgets on the catalogs the session holds, warming them when its model is not in them, and reads the setting at each call', async () => {
    const provider = new FakeProvider({}, [callsTool('call_a', 'read_file', { path: 'a.ts' }), says('Read.'), says('Noted.'), says('Noted.')]);
    createSpy.mockImplementation(provider.create);
    const catalog: { contextWindow?: number } = {};
    let auto = true;
    const warmPickerOptions = vi.fn();
    const session = makeSession({
      config: fakeConfig({ aiProvider: 'openrouter', orchestratorModel: 'vendor/model' }),
      fsAdapter: fakeFileSystem({ readFile: async () => file(40_000) }),
      modelResolver: {
        modelsForRunners: vi.fn().mockResolvedValue({}),
        contextWindowFor: (source, model) => (source === 'openrouter' && model === 'vendor/model' ? catalog.contextWindow : undefined),
        maxOutputTokensFor: (source, model) => (catalog.contextWindow !== undefined && source === 'openrouter' && model === 'vendor/model' ? 4_096 : undefined),
        warmPickerOptions,
      },
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, plannerAutoCompaction: auto }),
    });
    session.loadPlan({ ...createEmptyPlan(), conversationHistory: [{ role: 'user', content: 'map the cache', timestamp: '2026-10-25T09:00:00Z' }] }, 'map the cache', testWorkspace, { persist: false });

    await session.continueConversation('read a.ts');
    expect(warmPickerOptions).toHaveBeenCalled();
    expect(provider.requests.map((r) => r.max_tokens)).toEqual([32_000, 32_000]);

    // The catalog has loaded, with a window that has no room for the read a
    // turn on: its ceiling, the window less the 4,096-token reply, sits just
    // over what the last call carried.
    catalog.contextWindow = Math.floor(provider.requests.at(-1)!.promptTokens * 1.05) + 4_096;
    auto = false;
    await session.continueConversation('anything else?');
    expect(provider.requests.at(-1)!.max_tokens).toBe(4_096);
    expect(toolOutputs(provider.requests.at(-1)!)[0].content).toHaveLength(40_000);

    auto = true;
    await session.continueConversation('and now?');
    expect(toolOutputs(provider.requests.at(-1)!)[0].content).toContain('read_file output pruned');
  });
  it('says on the planner\'s meter when automatic compaction is not running, and why, as it stood at the last call', async () => {
    const provider = new FakeProvider({}, [says('Hi.'), says('Noted.'), says('Noted.')]);
    createSpy.mockImplementation(provider.create);
    const catalog: { contextWindow?: number } = {};
    let auto = true;
    const events: SessionMessage[] = [];
    const session = makeSession({
      config: fakeConfig({ aiProvider: 'openrouter', orchestratorModel: 'vendor/model' }),
      fsAdapter: fakeFileSystem({}),
      broadcast: (m) => events.push(m),
      modelResolver: {
        modelsForRunners: vi.fn().mockResolvedValue({}),
        contextWindowFor: (source, model) => (source === 'openrouter' && model === 'vendor/model' ? catalog.contextWindow : undefined),
        maxOutputTokensFor: () => undefined,
        warmPickerOptions: vi.fn(),
      },
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, plannerAutoCompaction: auto }),
    });
    session.loadPlan({ ...createEmptyPlan(), conversationHistory: [{ role: 'user', content: 'map the cache', timestamp: '2026-10-25T09:00:00Z' }] }, 'map the cache', testWorkspace, { persist: false });
    const meter = () => {
      const fill = events.filter((m): m is Extract<SessionMessage, { type: 'planner_usage' }> => m.type === 'planner_usage').at(-1)!.contextFill!;
      return { text: contextMeterText(fill), title: contextMeterTitle(fill) };
    };

    await session.continueConversation('hello');
    expect(meter().text).toMatch(/^ctx \S+ · no auto-compact$/);
    expect(meter().title).toMatch(/no catalog Ordewell holds states vendor\/model's window.*\/compact/);

    catalog.contextWindow = 200_000;
    auto = false;
    await session.continueConversation('anything else?');
    expect(meter().text).toMatch(/^ctx \S+ \(\d+%\) · no auto-compact$/);
    expect(meter().title).toMatch(/off in the settings file.*\/compact/);

    auto = true;
    await session.continueConversation('and now?');
    expect(meter().text).toMatch(/^ctx \S+ \(\d+%\)$/);
  });
});
