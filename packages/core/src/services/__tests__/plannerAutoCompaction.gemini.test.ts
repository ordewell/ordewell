import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IFileSystem, ToolOutcome } from '../../interfaces/IFileSystem';
import type { ConversationMessage, PlannerCompaction } from '../../models/Task';
import type { SessionMessage } from '../SessionMessage';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { createEmptyPlan } from '../../models/Task';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { modelContext } from '../conversationSummary';
import { makeSession, testWorkspace } from './sessionTestKit';

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { output: string } };
}
interface Content { role: string; parts: Part[] }
interface SentRequest {
  model: string;
  contents: Content[];
  tools?: unknown[];
  generationConfig?: { maxOutputTokens?: number };
  promptTokens: number;
}

/**
 * Why `contents` breaks Gemini's turn rules, or null: no two turns in a row
 * are of one role, and a call is answered by the very next turn, one response
 * per call, by name and in order.
 */
function pairingProblem(contents: Content[]): string | null {
  if (contents[0]?.role !== 'user') return 'the first turn is not the user\'s';
  for (const [i, c] of contents.entries()) {
    if (c.parts.length === 0) return `turn ${i} has no parts`;
    if (i > 0 && c.role === contents[i - 1].role) return `turn ${i} has the role of turn ${i - 1}`;
    const calls = c.role === 'model' ? c.parts.filter((p) => p.functionCall).map((p) => p.functionCall!.name) : [];
    const next = contents[i + 1];
    if (calls.length > 0 && next) {
      const answers = next.role === 'function' ? next.parts.map((p) => p.functionResponse?.name) : [];
      if (JSON.stringify(answers) !== JSON.stringify(calls)) return `turn ${i + 1} does not answer the calls of turn ${i}`;
    }
    if (c.role === 'function') {
      const before = contents[i - 1];
      if (before?.role !== 'model' || !before.parts.some((p) => p.functionCall)) return `turn ${i} answers no function call`;
    }
  }
  return null;
}

type Reply = (req: SentRequest) => Array<Record<string, unknown>>;

const SUMMARY = 'The user is mapping the cache layer in src/cache.ts. The build ran with make step0 and passed; the planner noted the eviction rule in src/cache/lru.ts:42 and still has to run the tests.';
const tagged = (text: string) => `<conversation_summary>${text}</conversation_summary>`;

/**
 * Gemini's streaming endpoint as the SDK reaches it over fetch: a prompt is
 * four characters of its JSON to a token, refused past the model's input
 * limit; a request declaring no functions — a summary call — is answered from
 * its own script; any request that breaks the function-calling rules is
 * refused, which no test here expects to see.
 */
class FakeGemini {
  readonly requests: SentRequest[] = [];
  readonly summaries: SentRequest[] = [];
  malformed: string[] = [];
  refusals = 0;
  inputLimits: Record<string, number> = {};

  constructor(public replies: Reply[], public summaryReplies: Reply[] = []) {}

  fetch = async (url: string | URL, init: RequestInit): Promise<Response> => {
    const model = /models\/([^:]+):/.exec(String(url))?.[1] ?? '';
    const body = JSON.parse(String(init.body)) as Omit<SentRequest, 'model' | 'promptTokens'>;
    const sent: SentRequest = { ...body, model, promptTokens: Math.ceil(JSON.stringify({ contents: body.contents, tools: body.tools }).length / 4) };
    const isSummary = body.tools === undefined;
    (isSummary ? this.summaries : this.requests).push(sent);
    const problem = pairingProblem(body.contents);
    if (problem) {
      this.malformed.push(problem);
      return FakeGemini.error(400, `Please ensure that function response turn comes immediately after a function call turn (${problem}).`);
    }
    const limit = this.inputLimits[model];
    if (limit !== undefined && sent.promptTokens > limit) {
      this.refusals++;
      return FakeGemini.error(400, `The input token count (${sent.promptTokens}) exceeds the maximum number of tokens allowed (${limit}).`);
    }
    const chunks = isSummary ? (this.summaryReplies.shift() ?? says(tagged(SUMMARY)))(sent) : (this.replies.shift() ?? says('Done.'))(sent);
    chunks.push({ usageMetadata: { promptTokenCount: sent.promptTokens, candidatesTokenCount: 7 } });
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  static error(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: { code: status, message, status: 'INVALID_ARGUMENT' } }), { status, statusText: 'Bad Request' });
  }
}

const callsTools = (...calls: Array<[string, Record<string, unknown>]>): Reply => () => [
  { candidates: [{ content: { role: 'model', parts: calls.map(([name, args]) => ({ functionCall: { name, args } })) }, finishReason: 'STOP' }] },
];
const says = (text: string, finishReason = 'STOP'): Reply => () => [{ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }] }];

const out = (chars: number, fill = 'x'): ToolOutcome => ({ success: true, output: fill.repeat(chars), truncated: false });
const responses = (req: SentRequest) => req.contents.flatMap((c) => (c.role === 'function' ? c.parts.map((p) => p.functionResponse!) : []));
const textOf = (c: Content) => c.parts.map((p) => p.text ?? '').join('');

const GOAL = 'map the cache';

let gemini: FakeGemini;

function plannerSession(provider: FakeGemini, fs: IFileSystem) {
  gemini = provider;
  vi.stubGlobal('fetch', provider.fetch);
  const limits: { input: Record<string, number>; output?: number } = { input: {} };
  const events: SessionMessage[] = [];
  const config = fakeConfig({ aiProvider: 'google', apiKey: 'gem-key', orchestratorModel: 'gemini:big-model', researchMaxSteps: 40 });
  const session = makeSession({
    config,
    fsAdapter: fs,
    broadcast: (m) => events.push(m),
    modelResolver: {
      modelsForRunners: vi.fn().mockResolvedValue({}),
      contextWindowFor: (source, model) => (source === 'google' ? limits.input[model] : undefined),
      maxOutputTokensFor: (source) => (source === 'google' ? limits.output : undefined),
      warmPickerOptions: vi.fn(),
    },
    // Turns that read past the planner read limit's default on purpose, to fill the window; the limit has its own tests.
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, plannerReadLimit: false }),
  });
  session.loadPlan({ ...createEmptyPlan(), conversationHistory: [{ role: 'user', content: GOAL, timestamp: '2026-10-25T09:00:00Z' }] }, GOAL, testWorkspace, { persist: false });
  const compactions = () => events.flatMap((m) => (m.type === 'planner_compaction' ? [{ ...m.compaction, turnId: m.turnId }] : [])) as Array<PlannerCompaction & { turnId?: string }>;
  const turnIds = () => events.flatMap((m) => (m.type === 'planner_turn_started' ? [m.turnId] : []));
  const usage = () => events.flatMap((m) => (m.type === 'planner_usage' ? [m] : []));
  return { session, limits, config, events, compactions, turnIds, usage };
}

const history = (session: { planState: { conversationHistory?: ConversationMessage[] } | null }) => session.planState?.conversationHistory ?? [];

/** The first turn leaves a build log pruning cannot touch, on an input limit with room for one beside the conversation, not two. */
async function afterOneBuild(provider: FakeGemini) {
  const bash = vi.fn(async () => out(45_000, 'b'));
  const kit = plannerSession(provider, fakeFileSystem({ bash }));
  await kit.session.continueConversation('run the build');
  const limit = Math.ceil(provider.requests.at(-1)!.promptTokens * 1.45);
  kit.limits.input['big-model'] = limit;
  kit.limits.output = 8_192;
  return { ...kit, bash, limit };
}

const twoBuilds = (): Reply[] => [
  callsTools(['bash', { command: 'make step0' }]), says('Built.'),
  callsTools(['bash', { command: 'make test' }]), says('Tested.'),
];

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  expect(gemini.malformed).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a Gemini planner that cannot prune enough room', () => {
  it('condenses the history that landed before its turn into a checkpoint, by a call declaring no functions, and sends the same call', async () => {
    const provider = new FakeGemini(twoBuilds());
    const { session, bash, limit, compactions, turnIds } = await afterOneBuild(provider);
    await session.continueConversation('run the tests');

    expect(bash).toHaveBeenCalledTimes(2);
    expect(provider.refusals).toBe(0);
    expect(provider.summaries).toHaveLength(1);
    const [summary] = provider.summaries;
    expect(summary.model).toBe('big-model');
    expect(summary.tools).toBeUndefined();
    expect(summary.contents).toHaveLength(1);
    expect(textOf(summary.contents[0])).toContain('make step0');
    expect(summary.generationConfig?.maxOutputTokens).toBeLessThanOrEqual(8_192);

    const resent = provider.requests.find((r) => responses(r).some((p) => p.response.output.length === 45_000 && r.contents.some((c) => textOf(c).includes(SUMMARY))))!;
    expect(resent).toBeDefined();
    expect(resent.promptTokens).toBeLessThanOrEqual(limit * 0.9);
    expect(responses(resent)).toHaveLength(1);
    expect(textOf(resent.contents[1])).toContain(SUMMARY);
    expect(resent.contents[1].role).toBe('model');

    const transcript = history(session);
    const at = transcript.findIndex((m) => m.kind === 'compaction');
    expect(transcript[at].checkpoint).toMatchObject({ trigger: 'auto', keptFrom: transcript.findIndex((m) => m.content === 'run the tests') });
    expect(modelContext(transcript).map((m) => m.content)).toEqual([transcript[at].content, 'run the tests', 'Tested.']);
    expect(compactions().map((c) => [c.phase, c.id, c.turnId])).toEqual([
      ['started', transcript[at].checkpoint!.id, turnIds().at(-1)],
      ['ended', transcript[at].checkpoint!.id, turnIds().at(-1)],
    ]);
  });

  it('condenses a turn that fills the limit by itself in the live context alone, listing the commands it ran', async () => {
    const steps = 6;
    const provider = new FakeGemini([
      says('Hi.'),
      ...Array.from({ length: steps }, (_, i) => callsTools(['bash', { command: `make step${i}` }])),
      says('All steps done.'),
    ]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session, limits } = plannerSession(provider, fakeFileSystem({ bash }));
    await session.continueConversation('hello');
    const limit = provider.requests.at(-1)!.promptTokens * 2;
    limits.input['big-model'] = limit;
    limits.output = 8_192;
    await session.continueConversation('run all the steps');

    expect(bash).toHaveBeenCalledTimes(steps);
    expect(provider.refusals).toBe(0);
    expect(provider.summaries.length).toBeGreaterThanOrEqual(1);
    for (const req of provider.requests.slice(2)) expect(req.promptTokens).toBeLessThanOrEqual(limit);
    const last = provider.requests.at(-1)!;
    // The note joins the user's turn as a part of its own: the user's message is its own part, unchanged.
    const turn = last.contents.find((c) => c.parts.some((p) => p.text?.startsWith('[Context note from Ordewell]')))!;
    expect(turn.role).toBe('user');
    expect(turn.parts.map((p) => p.text?.slice(0, 28))).toEqual([expect.stringContaining('run all the steps'), '[Context note from Ordewell]']);
    expect(turn.parts[1].text).toMatch(/^- bash\(\{"command":"make step0"\}\) → s+/m);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
  });

  it('answers a command its condensed rounds already ran with what it returned, never running it again', async () => {
    const steps = 6;
    const provider = new FakeGemini([
      says('Hi.'),
      ...Array.from({ length: steps }, (_, i) => callsTools(['bash', { command: `make step${i}` }])),
      // A model that asks for the first command again, whatever the note tells it.
      callsTools(['bash', { command: 'make step0' }]),
      says('All steps done.'),
    ]);
    const bash = vi.fn(async (command: string) => out(20_000, command === 'make step0' ? 'a' : 's'));
    const { session, limits } = plannerSession(provider, fakeFileSystem({ bash }));
    await session.continueConversation('hello');
    limits.input['big-model'] = provider.requests.at(-1)!.promptTokens * 2;
    limits.output = 8_192;
    await session.continueConversation('run all the steps');

    expect(bash.mock.calls.map(([command]) => command)).toEqual(Array.from({ length: steps }, (_, i) => `make step${i}`));
    const answered = provider.requests.at(-1)!;
    const answer = responses(answered).at(-1)!;
    expect(answer.name).toBe('bash');
    expect(answer.response.output).toMatch(/^Not run again: this exact call already ran earlier in this turn/);
    expect(answer.response.output).toMatch(/a{100}/);
    expect(history(session).at(-1)).toMatchObject({ content: 'All steps done.' });
  });

  it('refuses a summary that is not a whole one, writes nothing, and holds the call that cannot fit', async () => {
    const provider = new FakeGemini(twoBuilds(), [says('<conversation_summary>The user is mapping the cache and', 'MAX_TOKENS')]);
    const { session, limits, bash, compactions } = await afterOneBuild(provider);

    await session.continueConversation('run the tests');
    expect(session.planState!.plannerContextPause!.reason).toMatch(/no summary could be had/);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
    expect(compactions().at(-1)).toMatchObject({ phase: 'ended', outcome: 'paused' });

    // The held function responses go once, on the user's retry: none is dropped.
    limits.input['big-model'] = 1_000_000;
    await session.retryPlannerCompaction();
    expect(responses(provider.requests.at(-1)!).map((r) => r.response.output.length)).toEqual([45_000, 45_000]);
    expect(bash).toHaveBeenCalledTimes(2);
  });

  it('commits nothing a summary returns after a stop, and keeps the responses it was sending', async () => {
    const during: { summary?: () => void } = {};
    const provider = new FakeGemini(twoBuilds(), [(req) => { during.summary?.(); return says(tagged(SUMMARY))(req); }]);
    const { session, limits, bash, compactions } = await afterOneBuild(provider);
    during.summary = () => { session.abortPlannerTurn(); };

    await expect(session.continueConversation('run the tests')).rejects.toThrow(/stopped/i);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
    expect(compactions().at(-1)).toMatchObject({ phase: 'ended', outcome: 'stopped' });

    limits.input = {};
    await session.continueConversation('never mind');
    expect(responses(provider.requests.at(-1)!).map((r) => r.response.output)).toEqual(['b'.repeat(45_000), 'b'.repeat(45_000)]);
    expect(bash).toHaveBeenCalledTimes(2);
  });
});

describe('/compact on a Gemini planner', () => {
  it('is written by a call declaring no functions, and the next message replays its projection', async () => {
    const provider = new FakeGemini([says('One.'), says('Two.'), says('Three.')]);
    const { session } = plannerSession(provider, fakeFileSystem());
    for (const text of ['first', 'second', 'third']) await session.continueConversation(text);
    const calls = provider.requests.length;

    await session.compactConversation();

    expect(provider.requests).toHaveLength(calls);
    expect(provider.summaries).toHaveLength(1);
    expect(provider.summaries[0].tools).toBeUndefined();
    const transcript = history(session);
    expect(transcript.at(-1)!.checkpoint).toMatchObject({ trigger: 'manual', keptFrom: transcript.findIndex((m) => m.content === 'second') });

    await session.continueConversation('fourth');
    const replayed = provider.requests.at(-1)!.contents.slice(1).map(textOf);
    expect(replayed.slice(0, 5)).toEqual([transcript.at(-1)!.content, 'second', 'Two.', 'third', 'Three.']);
  });
});

const sources = (chars: number) => vi.fn(async (path: string) => (path.endsWith('.ts') ? out(chars, path[0]) : { success: false, output: '', truncated: false }));

describe('a Gemini planner condensing its context', () => {
  it('prunes alone when pruning makes room, saying so once, with no summary and nothing written', async () => {
    const provider = new FakeGemini([callsTools(['read_file', { path: 'a.ts' }]), says('Read.'), callsTools(['read_file', { path: 'r.ts' }]), says('Read.')]);
    const { session, limits, compactions } = plannerSession(provider, fakeFileSystem({ readFile: sources(45_000) }));
    await session.continueConversation('read a.ts');
    limits.input['big-model'] = Math.ceil(provider.requests.at(-1)!.promptTokens * 1.45);
    await session.continueConversation('read r.ts');

    expect(provider.summaries).toHaveLength(0);
    const outputs = responses(provider.requests.at(-1)!).map((r) => r.response.output);
    expect(outputs[0]).toContain('read_file output pruned');
    expect(outputs[1]).toHaveLength(45_000);
    expect(compactions().map((c) => (c.phase === 'ended' ? c.outcome : c.phase))).toEqual(['pruned']);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
  });

  it('counts each summary call in the totals and never in the meter, which it clears for the next call to set', async () => {
    const provider = new FakeGemini(twoBuilds());
    const { session, usage } = await afterOneBuild(provider);
    await session.continueConversation('run the tests');

    const [summary] = provider.summaries;
    const planner = provider.requests.reduce((n, r) => n + r.promptTokens, 0);
    expect(usage().at(-1)?.totals.inputTokens).toBe(planner + summary.promptTokens);
    const fills = usage().map((u) => u.contextFill?.usedTokens);
    expect(fills).not.toContain(summary.promptTokens + 7);
    expect(fills.slice(-2)).toEqual([undefined, provider.requests.at(-1)!.promptTokens + 7]);
  });

  it('keeps the newest exchanges that fit as they replay, one turn per role, and drops one too large to fit', async () => {
    const paste = `please keep this log in mind: ${'L'.repeat(120_000)}`;
    const provider = new FakeGemini([says('Noted the log.'), says('Noted: no dependencies.'), callsTools(['bash', { command: 'make test' }]), says('Tested.')]);
    const { session, limits } = plannerSession(provider, fakeFileSystem({ bash: async () => out(45_000, 'b') }));
    await session.continueConversation(paste);
    await session.continueConversation('keep it dependency-free');
    limits.input['big-model'] = Math.ceil(provider.requests.at(-1)!.promptTokens * 1.3);
    await session.continueConversation('run the tests');

    const transcript = history(session);
    expect(transcript.find((m) => m.kind === 'compaction')!.checkpoint!.keptFrom).toBe(transcript.findIndex((m) => m.content === 'keep it dependency-free'));
    const resent = provider.requests.find((r) => responses(r).length === 1)!;
    expect(resent.contents.slice(1, 4).map((c) => [c.role, textOf(c)])).toEqual([
      ['model', expect.stringContaining(SUMMARY)],
      ['user', 'keep it dependency-free'],
      ['model', 'Noted: no dependencies.'],
    ]);
    expect(resent.contents.some((c) => textOf(c).includes('L'.repeat(1_000)))).toBe(false);
  });

  it('condenses the first summary with what followed it the second time, and the model context holds only the newest', async () => {
    const provider = new FakeGemini([...twoBuilds(), callsTools(['bash', { command: 'make lint' }]), says('Linted.')], [
      says(tagged(SUMMARY)),
      says(tagged('The user is mapping the cache layer in src/cache.ts; the build and the tests passed (make step0, make test), and lint is what is left to run.')),
    ]);
    const { session } = await afterOneBuild(provider);
    await session.continueConversation('run the tests');
    await session.continueConversation('run the linter');

    expect(provider.summaries).toHaveLength(2);
    expect(textOf(provider.summaries[1].contents[0])).toContain(SUMMARY);
    const transcript = history(session);
    const checkpoints = transcript.filter((m) => m.kind === 'compaction');
    expect(checkpoints).toHaveLength(2);
    expect(modelContext(transcript).map((m) => m.content)).toEqual([checkpoints[1].content, 'run the linter', 'Linted.']);
  });

  it('refuses a summary written while the planner model changed, committing nothing', async () => {
    const during: { summary?: () => void } = {};
    const provider = new FakeGemini(twoBuilds(), [(req) => { during.summary?.(); return says(tagged(SUMMARY))(req); }]);
    const { session, config } = await afterOneBuild(provider);
    during.summary = () => { (config as { orchestratorModel: string }).orchestratorModel = 'gemini:other-model'; };

    await session.continueConversation('run the tests');
    expect(session.planState!.plannerContextPause).toBeDefined();
    expect(provider.summaries.map((r) => r.model)).toEqual(['big-model']);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
  });

  it('folds a context its new, smaller model cannot take in one call, each call within its input limit', async () => {
    const builds = ['one', 'two', 'three'].flatMap((step): Reply[] => [callsTools(['bash', { command: `make ${step}` }]), says(`Built ${step}.`)]);
    const provider = new FakeGemini([...builds, callsTools(['bash', { command: 'make final' }]), says('Done.')]);
    const bash = vi.fn(async (command: string) => out(command.includes('final') ? 4_000 : 45_000, 'b'));
    const { session, limits, config } = plannerSession(provider, fakeFileSystem({ bash }));
    limits.input['big-model'] = 1_000_000;
    for (const step of ['one', 'two', 'three']) await session.continueConversation(`build ${step}`);
    const limit = provider.requests[0].promptTokens + 16_000;
    limits.input['small-model'] = limit;
    provider.inputLimits['small-model'] = limit;
    (config as { orchestratorModel: string }).orchestratorModel = 'gemini:small-model';
    await session.continueConversation('build final');

    expect(provider.refusals).toBe(0);
    expect(provider.summaries.length).toBeGreaterThanOrEqual(2);
    for (const summary of provider.summaries) {
      expect(summary.model).toBe('small-model');
      expect(summary.promptTokens).toBeLessThanOrEqual(limit);
    }
    for (const later of provider.summaries.slice(1)) expect(textOf(later.contents[0])).toContain(`<summary_so_far>\n${SUMMARY}\n</summary_so_far>`);
    expect(history(session).filter((m) => m.kind === 'compaction')).toHaveLength(1);
  });
});

describe('a Gemini planner opening a new plan', () => {
  it('sends its instructions and the goal as one user turn, so no two user turns follow each other', async () => {
    const provider = new FakeGemini([callsTools(['bash', { command: 'ls src' }]), says('Which cache?'), says('Noted.')]);
    const bash = vi.fn(async () => out(200));
    const { session } = plannerSession(provider, fakeFileSystem({ bash }));
    await session.startPlanning('add a cache', ['claude-code']);
    await session.continueConversation('the LRU one');

    expect(bash).toHaveBeenCalledTimes(1);
    expect(provider.requests.map((r) => r.contents.map((c) => c.role))).toEqual([
      ['user'],
      ['user', 'model', 'function'],
      ['user', 'model', 'function', 'model', 'user'],
    ]);
    const [opening] = provider.requests[0].contents;
    expect(opening.parts).toHaveLength(2);
    expect(opening.parts[0].text).not.toContain('add a cache\n\nCONTEXT');
    expect(opening.parts[1].text).toContain('add a cache');
  });
});
