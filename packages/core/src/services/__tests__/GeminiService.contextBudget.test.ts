import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import type { IFileSystem, ToolOutcome } from '../../interfaces/IFileSystem';
import type { ResearchProgress } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { createEmptyPlan } from '../../models/Task';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { makeSession, testWorkspace } from './sessionTestKit';
import { GeminiService } from '../GeminiService';

// The real Gemini adapter over the fetch each test stubs, with no retry around
// it: a refused call fails at once, as these tests script it. The Retry-After
// policy is ModelClient's own, and tested with it.
vi.mock('../model', async (importOriginal) => ({
  ...await importOriginal<typeof import('../model')>(),
  withRetry: (client: import('../model').ModelClient) => client,
}));
import { PlannerContextExhaustedError, type ModelLimits } from '../plannerContextBudget';
import type { ConversationTurnContext } from '../BaseAiService';
import { STOPPED_TOOL_RESULT } from '../executeTool';

interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { output: string } };
}
interface Content { role: string; parts: Part[] }
interface SentRequest {
  model: string;
  contents: Content[];
  tools: unknown[];
  generationConfig?: { maxOutputTokens?: number };
  promptTokens: number;
}

/** A turn of function responses, which Gemini takes as the user's. */
const answersCalls = (c: Content | undefined): boolean => c !== undefined && c.parts.length > 0 && c.parts.every((p) => p.functionResponse);

/**
 * Why `contents` breaks Gemini's function-calling rules, or null: a turn of
 * function calls is answered by the very next turn, one holding
 * one response per call, by name and in order; a response answers nothing else.
 */
function pairingProblem(contents: Content[]): string | null {
  if (contents[0]?.role !== 'user') return 'the first turn is not the user\'s';
  for (const [i, c] of contents.entries()) {
    if (c.parts.length === 0) return `turn ${i} has no parts`;
    const calls = c.role === 'model' ? c.parts.filter((p) => p.functionCall).map((p) => p.functionCall!.name) : [];
    const next = contents[i + 1];
    if (calls.length > 0 && next) {
      const answers = answersCalls(next) ? next.parts.map((p) => p.functionResponse?.name) : [];
      if (JSON.stringify(answers) !== JSON.stringify(calls)) return `turn ${i + 1} does not answer the calls of turn ${i}`;
    }
    if (answersCalls(c)) {
      const before = contents[i - 1];
      if (before?.role !== 'model' || !before.parts.some((p) => p.functionCall)) return `turn ${i} answers no function call`;
    }
  }
  return null;
}

type Reply = () => Array<Record<string, unknown>>;

/**
 * Gemini's streaming endpoint as the SDK reaches it over fetch: it counts a
 * prompt at four characters of its JSON to a token, refuses one past the
 * model's input limit — the reply has its own — and refuses any request that
 * breaks the function-calling rules, which no test here expects to see.
 */
class FakeGemini {
  readonly requests: SentRequest[] = [];
  refusals = 0;
  malformed: string[] = [];
  /** Requests answered with a server error instead of a reply, by their index. */
  failAt = new Set<number>();
  /** Requests left hanging until their signal aborts, by their index. */
  hangAt = new Set<number>();

  constructor(public inputLimits: Record<string, number>, public replies: Reply[]) {}

  fetch = async (url: string | URL, init: RequestInit): Promise<Response> => {
    const model = /models\/([^:]+):/.exec(String(url))?.[1] ?? '';
    const body = JSON.parse(String(init.body)) as Omit<SentRequest, 'model' | 'promptTokens'>;
    const promptTokens = Math.ceil(JSON.stringify({ contents: body.contents, tools: body.tools }).length / 4);
    const index = this.requests.push({ ...body, model, promptTokens }) - 1;
    const problem = pairingProblem(body.contents);
    if (problem) {
      this.malformed.push(problem);
      return FakeGemini.error(400, `Please ensure that function response turn comes immediately after a function call turn (${problem}).`);
    }
    const limit = this.inputLimits[model];
    if (limit !== undefined && promptTokens > limit) {
      this.refusals++;
      return FakeGemini.error(400, `The input token count (${promptTokens}) exceeds the maximum number of tokens allowed (${limit}).`);
    }
    if (this.failAt.has(index)) return FakeGemini.error(503, 'The model is overloaded. Please try again later.');
    if (this.hangAt.has(index)) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }
    const chunks = this.replies.shift()?.() ?? [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }] }];
    chunks.push({ usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 5 } });
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  static error(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: { code: status, message, status: status === 400 ? 'INVALID_ARGUMENT' : 'UNAVAILABLE' } }), { status, statusText: status === 400 ? 'Bad Request' : 'Service Unavailable' });
  }
}

const callsTools = (...calls: Array<[string, Record<string, unknown>]>): Reply => () => [
  { candidates: [{ content: { role: 'model', parts: calls.map(([name, args]) => ({ functionCall: { name, args } })) }, finishReason: 'STOP' }] },
];
const says = (text: string): Reply => () => [{ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }];

const file = (chars: number): ToolOutcome => ({ success: true, output: 'x'.repeat(chars), truncated: false });

const functionResponses = (req: SentRequest) => req.contents.flatMap((c) => (answersCalls(c) ? c.parts.map((p) => p.functionResponse!) : []));

function config(over: Partial<IConfig> = {}): IConfig {
  return fakeConfig({ aiProvider: 'google', apiKey: 'gem-key', orchestratorModel: 'gemini:big-model', researchMaxSteps: 40, ...over });
}

function service(cfg: IConfig, limits: Record<string, ModelLimits> = {}, autoCompaction = () => true): GeminiService {
  return new GeminiService(cfg, {
    modelLimits: (source, model) => (source === 'google' ? limits[model] : undefined),
    autoCompaction,
  });
}

function start(svc: GeminiService, fs: IFileSystem = fakeFileSystem({ readFile: async () => file(49_000) }), onProgress: (p: ResearchProgress) => void = () => {}, signal?: AbortSignal) {
  return svc.startConversation({ goal: 'map the cache', runners: ['claude-code'], modelsByRunner: {}, fs, onProgress, signal });
}

let gemini: FakeGemini;
function serve(inputLimits: Record<string, number>, replies: Reply[]): FakeGemini {
  gemini = new FakeGemini(inputLimits, replies);
  vi.stubGlobal('fetch', gemini.fetch);
  return gemini;
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  expect(gemini.malformed).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a Gemini planner keeps every function response it sent', () => {
  it('keeps the responses of a call the transport failed, so the next message answers no call twice and drops none', async () => {
    const provider = serve({}, [callsTools(['read_file', { path: 'a.ts' }], ['read_file', { path: 'b.ts' }])]);
    provider.failAt.add(1);
    const reads: string[] = [];
    const svc = service(config());
    const fs = fakeFileSystem({ readFile: async (path: string) => { if (path.endsWith('.ts')) reads.push(path); return file(2_000); } });

    await expect(start(svc, fs)).rejects.toThrow(/503|overloaded/i);
    const turn = await svc.continueConversation('try again', () => {});

    expect(turn.kind).toBe('message');
    expect(reads).toEqual(['a.ts', 'b.ts']);
    const retry = provider.requests[2];
    expect(retry.contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'user']);
    expect(functionResponses(retry).map((r) => [r.name, r.response.output.length])).toEqual([['read_file', 2_000], ['read_file', 2_000]]);
    expect(retry.contents.at(-1)?.parts[0].text).toMatch(/^try again/);
  });
});

describe('a stopped Gemini planner turn', () => {
  it('ends a call under way on Stop, and the next message carries the responses it was sending once', async () => {
    const provider = serve({}, [callsTools(['read_file', { path: 'a.ts' }])]);
    provider.hangAt.add(1);
    const svc = service(config());
    const caller = new AbortController();
    const turn = start(svc, undefined, () => {}, caller.signal);

    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    caller.abort();
    await expect(turn).rejects.toThrow(/abort/i);
    await svc.continueConversation('go on', () => {});

    const next = provider.requests[2];
    expect(next.contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'user']);
    expect(functionResponses(next)).toHaveLength(1);
    expect(functionResponses(next)[0].response.output).toHaveLength(49_000);
  });

  it('keeps what a Stop let run and says which call it stopped, so the next message never reports a call that ran as unrun', async () => {
    const provider = serve({}, [callsTools(['read_file', { path: 'a.ts' }], ['bash', { command: 'npm test' }])]);
    const svc = service(config());
    const caller = new AbortController();
    const bash = vi.fn(async () => file(10));
    const fs = fakeFileSystem({
      readFile: async (path: string) => {
        if (path.endsWith('.ts')) caller.abort();
        return file(100);
      },
      bash,
    });

    await start(svc, fs, () => {}, caller.signal).catch(() => {});
    expect(provider.requests).toHaveLength(1);
    await svc.continueConversation('never mind', () => {});

    const next = provider.requests[1];
    expect(next.contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'user']);
    expect(bash).not.toHaveBeenCalled();
    expect(functionResponses(next).map((r) => [r.name, r.response.output])).toEqual([
      ['read_file', 'x'.repeat(100)],
      ['bash', STOPPED_TOOL_RESULT],
    ]);
  });
});

const readRounds = (n: number, from = 0): Reply[] => Array.from({ length: n }, (_, i) => callsTools(['read_file', { path: `f${from + i}.ts` }]));
const outputs = (req: SentRequest) => functionResponses(req).map((r) => r.response.output);
const pruned = (output: string) => /read_file output pruned .* read it again/.test(output);

describe('a Gemini planner budgets each call on its model\'s input limit', () => {
  // A session hands a Gemini model's window over as the catalog holds it: its
  // inputTokenLimit, with its outputTokenLimit as the reply's cap.
  const small = { contextWindow: 32_768, maxOutputTokens: 8_192 };

  it('keeps a prompt under 90% of an input-only limit, never taking the reply out of it', async () => {
    const provider = serve({ 'small-model': 32_768 }, [...readRounds(6), says('All read.')]);
    const svc = service(config({ orchestratorModel: 'gemini:small-model' }), { 'small-model': small });

    const turn = await start(svc, fakeFileSystem({ readFile: async () => file(20_000) }));

    expect(turn.kind).toBe('message');
    expect(provider.refusals).toBe(0);
    expect(provider.requests).toHaveLength(7);
    for (const req of provider.requests) {
      expect(req.generationConfig?.maxOutputTokens).toBe(8_192);
      expect(req.promptTokens).toBeLessThanOrEqual(29_491);
      // What is being sent and the two newest rounds before it stay whole.
      for (const out of outputs(req).slice(-3)) expect(out).toHaveLength(20_000);
    }
    // Over 32,768 less the 8,192-token reply, and still under 90% of the
    // input limit with its margin: sent whole, since the reply has its own room.
    const whole = provider.requests.filter((r) => r.promptTokens > 24_576 && !outputs(r).some(pruned));
    expect(whole.length).toBeGreaterThan(0);
    // Above it, older reads went, oldest first.
    const last = outputs(provider.requests.at(-1)!);
    expect(last.filter(pruned).length).toBeGreaterThan(0);
    expect(last.findIndex((o) => !pruned(o))).toBe(last.filter(pruned).length);
    expect(svc.plannerContextStatus()).toEqual({ auto: 'on', model: 'small-model', contextWindow: 32_768, maxOutputTokens: 8_192 });
  });

  it('prunes nothing for a model whose large limit has room, and asks for its usual reply under a higher cap', async () => {
    const provider = serve({ 'big-model': 1_048_576 }, [...readRounds(12), says('All read.')]);
    const svc = service(config(), { 'big-model': { contextWindow: 1_048_576, maxOutputTokens: 65_536 } });

    await start(svc);

    expect(provider.requests).toHaveLength(13);
    for (const req of provider.requests) {
      expect(req.generationConfig?.maxOutputTokens).toBe(16_384);
      expect(outputs(req).some(pruned)).toBe(false);
    }
    expect(svc.compactions()).toBe(0);
  });

  it('prunes nothing ahead of a call on a model whose limit is unknown, and says so', async () => {
    const provider = serve({}, [...readRounds(12), says('All read.')]);
    const svc = service(config({ orchestratorModel: 'gemini:unlisted' }));

    await start(svc);

    for (const req of provider.requests) {
      expect(req.generationConfig?.maxOutputTokens).toBe(16_384);
      expect(outputs(req).some(pruned)).toBe(false);
    }
    expect(svc.plannerContextStatus()).toEqual({ auto: 'unknown_window', model: 'unlisted' });
    expect(service(config(), {}, () => false).plannerContextStatus()).toEqual({ auto: 'off' });
  });

  it('budgets the next call of a running tool loop on a model switched to, from its own limits', async () => {
    const cfg = config();
    const provider = serve({ 'small-model': 65_536 }, [...readRounds(6), says('All read.')]);
    let reads = 0;
    const fs = fakeFileSystem({
      readFile: async (path: string) => {
        if (path.endsWith('.ts') && ++reads === 4) cfg.orchestratorModel = 'gemini:small-model';
        return file(40_000);
      },
    });
    const svc = service(cfg, { 'big-model': { contextWindow: 1_048_576, maxOutputTokens: 65_536 }, 'small-model': { contextWindow: 65_536, maxOutputTokens: 8_192 } });

    await start(svc, fs);

    expect(provider.refusals).toBe(0);
    expect(provider.requests.map((r) => r.model)).toEqual(['big-model', 'big-model', 'big-model', 'big-model', 'small-model', 'small-model', 'small-model']);
    const switched = provider.requests[4];
    expect(switched.generationConfig?.maxOutputTokens).toBe(8_192);
    expect(switched.promptTokens).toBeLessThanOrEqual(58_982);
    expect(outputs(switched).filter(pruned).length).toBeGreaterThan(0);
    expect(outputs(switched).slice(-3).some(pruned)).toBe(false);
    expect(functionResponses(switched)).toHaveLength(4);
  });

  it('keeps a round of wide results whole, answering each of its calls once in one turn', async () => {
    const wide = (i: number) => callsTools(...Array.from({ length: 4 }, (_, j): [string, Record<string, unknown>] => ['read_file', { path: `r${i}_${j}.ts` }]));
    const provider = serve({ 'mid-model': 131_072 }, [...Array.from({ length: 6 }, (_, i) => wide(i)), says('All read.')]);
    const svc = service(config({ orchestratorModel: 'gemini:mid-model' }), { 'mid-model': { contextWindow: 131_072, maxOutputTokens: 8_192 } });

    await start(svc, fakeFileSystem({ readFile: async () => file(25_000) }));

    expect(provider.refusals).toBe(0);
    for (const req of provider.requests) {
      expect(req.promptTokens).toBeLessThanOrEqual(117_964);
      const turns = req.contents.filter(answersCalls);
      for (const t of turns) expect(t.parts).toHaveLength(4);
      for (const out of outputs(req).slice(-12)) expect(out).toHaveLength(25_000);
    }
    expect(outputs(provider.requests.at(-1)!).filter(pruned).length).toBeGreaterThan(0);
  });
});

type Chat = ConversationTurnContext['chat'];
const chatOf = (svc: GeminiService): Chat => (svc as unknown as { conversation: { ctx: ConversationTurnContext } }).conversation.ctx.chat;

describe('what a Gemini planner never prunes, and what it does when that cannot fit', () => {
  const bashRounds = (n: number): Reply[] => Array.from({ length: n }, (_, i) => callsTools(['bash', { command: `make step${i}` }]));
  const mid = { 'mid-model': { contextWindow: 64_000, maxOutputTokens: 8_192 } };

  it('keeps every command\'s output whole, and ends the turn on a typed error instead of sending what cannot fit', async () => {
    const provider = serve({ 'mid-model': 64_000 }, [...bashRounds(8), says('Built.')]);
    const bash = vi.fn(async () => file(45_000));
    const cfg = config({ orchestratorModel: 'gemini:mid-model' });
    const svc = service(cfg, mid);

    await expect(start(svc, fakeFileSystem({ bash }))).rejects.toBeInstanceOf(PlannerContextExhaustedError);
    expect(provider.refusals).toBe(0);
    for (const req of provider.requests) for (const out of outputs(req)) expect(out).toHaveLength(45_000);
    // The opening call, then one per round sent: the last round's responses were held, not sent.
    const ran = bash.mock.calls.length;
    expect(provider.requests).toHaveLength(ran);

    // A larger model has room: the next message carries the held responses once, and no command runs again.
    cfg.orchestratorModel = 'gemini:big-model';
    provider.replies = [says('Built.')];
    await svc.continueConversation('go on', () => {});
    expect(outputs(provider.requests.at(-1)!)).toEqual(Array(ran).fill('x'.repeat(45_000)));
    expect(bash).toHaveBeenCalledTimes(ran);
  });

  it('sends held responses again whole on resend, running nothing a second time', async () => {
    const provider = serve({ 'mid-model': 64_000 }, [...bashRounds(8), says('Built.')]);
    const bash = vi.fn(async () => file(45_000));
    const cfg = config({ orchestratorModel: 'gemini:mid-model' });
    const svc = service(cfg, mid);
    await expect(start(svc, fakeFileSystem({ bash }))).rejects.toBeInstanceOf(PlannerContextExhaustedError);
    const ran = bash.mock.calls.length;
    const chat = chatOf(svc);
    expect(chat.holdsInput?.()).toBe(true);

    cfg.orchestratorModel = 'gemini:big-model';
    provider.replies = [says('Built.')];
    const turn = await chat.resend!();

    expect(turn.text).toBe('Built.');
    expect(chat.holdsInput?.()).toBe(false);
    const resent = provider.requests.at(-1)!;
    expect(answersCalls(resent.contents.at(-1))).toBe(true);
    expect(outputs(resent)).toHaveLength(ran);
    expect(bash).toHaveBeenCalledTimes(ran);
  });

  it('takes the API\'s refusal as one more pruning pass and one resend of the same responses, then stops', async () => {
    // The catalog states a larger limit than the model is served with: the estimate fits, the call does not.
    const provider = serve({ 'big-model': 131_072 }, [...readRounds(12), says('All read.')]);
    const readFile = vi.fn(async (_path: string) => file(49_000));
    const svc = service(config(), { 'big-model': { contextWindow: 200_000 } });

    const turn = await start(svc, fakeFileSystem({ readFile }));

    expect(turn.kind).toBe('message');
    expect(provider.refusals).toBe(1);
    expect(readFile.mock.calls.filter(([path]) => /^f\d+\.ts$/.test(path))).toHaveLength(12);
    const refused = provider.requests.findIndex((r) => r.promptTokens > 131_072);
    const resent = provider.requests[refused + 1];
    expect(functionResponses(resent)).toHaveLength(functionResponses(provider.requests[refused]).length);
    expect(outputs(resent).at(-1)).toHaveLength(49_000);
    expect(outputs(resent).filter(pruned).length).toBeGreaterThan(outputs(provider.requests[refused]).filter(pruned).length);
  });

  it('with automatic compaction off, prunes nothing and holds what a refused call was to send', async () => {
    const provider = serve({ 'big-model': 131_072 }, readRounds(12));
    const svc = service(config(), { 'big-model': { contextWindow: 131_072 } }, () => false);

    await expect(start(svc)).rejects.toMatchObject({ name: 'PlannerContextExhaustedError', refusedByProvider: true });
    expect(provider.refusals).toBe(1);
    expect(svc.compactions()).toBe(0);
    const refused = provider.requests.at(-1)!;
    for (const out of outputs(refused)) expect(out).toHaveLength(49_000);

    // The refused responses are filed once, under the next message.
    provider.inputLimits = {};
    provider.replies = [says('Noted.')];
    await svc.continueConversation('stop reading', () => {});
    const next = provider.requests.at(-1)!;
    expect(outputs(next)).toEqual(outputs(refused));
    expect(next.contents.at(-1)?.parts[0].text).toMatch(/^stop reading/);
  });

  it('takes a reseeded history in one step, and refuses one that would break pairing, changing nothing', async () => {
    const provider = serve({}, [callsTools(['read_file', { path: 'a.ts' }]), says('Read.'), says('Summarized.')]);
    const svc = service(config());
    await start(svc);
    const chat = chatOf(svc);

    expect(() => chat.reseed!([{ role: 'user', content: 'goal' }, { role: 'tool', tool_call_id: 'nope', content: 'orphan' }])).toThrow(/answers no call/);
    chat.reseed!([
      { role: 'user', content: 'system prompt' },
      { role: 'user', content: 'Summary of the conversation so far.' },
      { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'k1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'k1', content: 'kept' },
      { role: 'assistant', content: 'Read.' },
    ]);
    await svc.continueConversation('next', () => {});

    expect(provider.requests.at(-1)!.contents).toEqual([
      { role: 'user', parts: [{ text: 'system prompt\n\nSummary of the conversation so far.' }] },
      { role: 'model', parts: [{ text: 'Reading.' }, { functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'kept' } } }] },
      { role: 'model', parts: [{ text: 'Read.' }] },
      { role: 'user', parts: [{ text: expect.stringMatching(/^next/) }] },
    ]);
    expect(svc.compactions()).toBe(1);
  });
});

describe('the model turns a Gemini planner sends back', () => {
  it('returns a thinking model\'s signature with the turn it came on, and its thought text only as thought', async () => {
    const provider = serve({}, [
      () => [
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Weighing which file.', thought: true }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Reading ' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'it.' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'sig-1' }] }, finishReason: 'STOP' }] },
      ],
      says('Read.'),
    ]);

    await start(service(config()));

    expect(provider.requests[1].contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Weighing which file.', thought: true },
        { text: 'Reading it.' },
        { functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'sig-1' },
      ],
    });
  });
});

describe('a thinking Gemini model\'s turns, sent back with their signatures', () => {
  /** A call that reasoned first: its thought and the signature it rides on go back with the turn, as long as they are. */
  const thinksThenReads = (i: number): Reply => () => [
    { candidates: [{ content: { role: 'model', parts: [{ text: `Weighing f${i}.ts: ${'t'.repeat(3_000)}`, thought: true, thoughtSignature: 's'.repeat(6_000) }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: `f${i}.ts` } }, thoughtSignature: 'g'.repeat(6_000) }] }, finishReason: 'STOP' }] },
  ];

  it('count toward the prompt they are sent in, so a call that cannot fit is held rather than refused', async () => {
    const limit = 60_000;
    const provider = serve({ 'small-model': limit }, [...Array.from({ length: 30 }, (_, i) => thinksThenReads(i)), says('All read.')]);
    const svc = service(config({ orchestratorModel: 'gemini:small-model' }), { 'small-model': { contextWindow: limit, maxOutputTokens: 8_192 } });

    // Reads too small to prune: only the turns' own reasoning fills the limit.
    await expect(start(svc, fakeFileSystem({ readFile: async () => file(1_000) }))).rejects.toBeInstanceOf(PlannerContextExhaustedError);

    expect(provider.refusals).toBe(0);
    for (const req of provider.requests) expect(req.promptTokens).toBeLessThanOrEqual(limit);
    // Each turn went back whole, signatures and all.
    expect(provider.requests.at(-1)!.contents.filter((c) => c.parts.some((p) => p.thoughtSignature === 's'.repeat(6_000))).length).toBeGreaterThan(1);
  });
});

describe('a session\'s Gemini planner', () => {
  it('budgets on the input and output limits the session\'s catalogs hold for the model', async () => {
    const provider = serve({}, [callsTools(['read_file', { path: 'a.ts' }]), says('Read.'), callsTools(['read_file', { path: 'b.ts' }]), says('Read.'), says('Noted.')]);
    const limits: { contextWindow?: number } = {};
    const session = makeSession({
      config: config({ orchestratorModel: 'gemini:gemini-small' }),
      fsAdapter: fakeFileSystem({ readFile: async () => file(40_000) }),
      modelResolver: {
        modelsForRunners: vi.fn().mockResolvedValue({}),
        contextWindowFor: (source, model) => (source === 'google' && model === 'gemini-small' ? limits.contextWindow : undefined),
        maxOutputTokensFor: (source, model) => (source === 'google' && model === 'gemini-small' ? 8_192 : undefined),
        warmPickerOptions: vi.fn(),
      },
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    });
    session.loadPlan({ ...createEmptyPlan(), conversationHistory: [{ role: 'user', content: 'map the cache', timestamp: '2026-10-25T09:00:00Z' }] }, 'map the cache', testWorkspace, { persist: false });

    await session.continueConversation('read a.ts');
    await session.continueConversation('read b.ts');
    expect(provider.requests.map((r) => r.generationConfig?.maxOutputTokens)).toEqual([8_192, 8_192, 8_192, 8_192]);
    expect(outputs(provider.requests.at(-1)!).some(pruned)).toBe(false);

    // The catalog now states an input limit the next message would pass 90%
    // of: the reads of turns before it go, and the reply keeps its own cap.
    limits.contextWindow = Math.floor(provider.requests.at(-1)!.promptTokens * 1.05);
    await session.continueConversation('anything else?');
    const last = provider.requests.at(-1)!;
    expect(last.generationConfig?.maxOutputTokens).toBe(8_192);
    expect(last.promptTokens).toBeLessThanOrEqual(limits.contextWindow * 0.9);
    expect(outputs(last).map(pruned)).toEqual([true, true]);
  });
});
