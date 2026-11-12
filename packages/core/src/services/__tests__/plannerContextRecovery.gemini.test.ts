import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IFileSystem, ToolOutcome } from '../../interfaces/IFileSystem';
import type { ConversationMessage, LegacyPlanState } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { createEmptyPlan } from '../../models/Task';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { makeSession, saves, testWorkspace } from './sessionTestKit';

interface Part {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { output: string } };
}
interface Content { role: string; parts: Part[] }
interface SentRequest {
  model: string;
  contents: Content[];
  tools?: unknown[];
  promptTokens: number;
  refused?: true;
}

/** Why `contents` breaks Gemini's function-calling rules, or null: a call is answered by the very next turn, one response per call, by name and in order. */
function pairingProblem(contents: Content[]): string | null {
  if (contents[0]?.role !== 'user') return 'the first turn is not the user\'s';
  for (const [i, c] of contents.entries()) {
    if (c.parts.length === 0) return `turn ${i} has no parts`;
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

type Reply = () => Array<Record<string, unknown>>;

const SUMMARY = 'The user asked for every build step to run. The planner ran make step0 through make step2 with bash, each passing, and still has the later steps to run before it reports back.';
const tagged = (text: string) => `<conversation_summary>${text}</conversation_summary>`;

/**
 * Gemini's streaming endpoint as the SDK reaches it over fetch: a prompt is
 * four characters of its JSON to a token, refused past the model's input
 * limit with the limit stated, as Gemini words it; `refuseNext` refuses that
 * many planner requests whatever their size, and `refusesAfter` adds to it on
 * each refusal by limit. A request declaring no functions, a summary call, is
 * answered with a whole summary while `summariesOk`. `errors` answers by
 * planner request index. Any request that breaks the function-calling rules
 * is refused, which no test here expects to see.
 */
class FakeGemini {
  readonly requests: SentRequest[] = [];
  readonly summaries: SentRequest[] = [];
  malformed: string[] = [];
  inputLimits: Record<string, number> = {};
  summariesOk = true;
  refuseNext = 0;
  refusesAfter = 0;
  errors = new Map<number, Response>();

  constructor(public replies: Reply[]) {}

  get refusals(): number { return this.requests.filter((r) => r.refused).length; }

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
    const error = isSummary ? undefined : this.errors.get(this.requests.length - 1);
    if (error) return error;
    const limit = this.inputLimits[model];
    const overLimit = limit !== undefined && sent.promptTokens > limit;
    const refusing = !isSummary && this.refuseNext > 0;
    if (refusing) this.refuseNext--;
    if (overLimit || refusing) {
      sent.refused = true;
      if (overLimit) this.refuseNext += this.refusesAfter;
      return FakeGemini.error(400, `The input token count (${sent.promptTokens}) exceeds the maximum number of tokens allowed (${limit ?? sent.promptTokens - 1}).`);
    }
    const chunks = isSummary
      ? (this.summariesOk ? says(tagged(SUMMARY)) : says('The steps ran; no tags here.'))()
      : (this.replies.shift() ?? says('Done.'))();
    chunks.push({ usageMetadata: { promptTokenCount: sent.promptTokens, candidatesTokenCount: 7 } });
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  static error(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: { code: status, message, status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT' } }), { status, statusText: 'Bad Request' });
  }
}

const callsTools = (...calls: Array<[string, Record<string, unknown>]>): Reply => () => [
  { candidates: [{ content: { role: 'model', parts: calls.map(([name, args]) => ({ functionCall: { name, args } })) }, finishReason: 'STOP' }] },
];
const says = (text: string, finishReason = 'STOP'): Reply => () => [{ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }] }];

const out = (chars: number, fill = 'x'): ToolOutcome => ({ success: true, output: fill.repeat(chars), truncated: false });
const responses = (req: SentRequest) => req.contents.flatMap((c) => (c.role === 'function' ? c.parts.map((p) => p.functionResponse!) : []));
/** The function responses a request sends after its last model turn: what that turn's calls returned. */
const trailing = (req: SentRequest) => {
  const last = req.contents.map((c) => c.role).lastIndexOf('model');
  return req.contents.slice(last + 1).flatMap((c) => (c.role === 'function' ? c.parts.map((p) => p.functionResponse!.response.output.length) : []));
};

const GOAL = 'run the build';
const STEPS = 6;
const steps = (): Reply[] => Array.from({ length: STEPS }, (_, i) => callsTools(['bash', { command: `make step${i}` }]));
const allSteps = Array.from({ length: STEPS }, (_, i) => `make step${i}`);
const ran = (bash: ReturnType<typeof vi.fn>) => bash.mock.calls.map((c) => c[0] as string);

let gemini: FakeGemini;

function plannerSession(provider: FakeGemini, fs: IFileSystem, plan?: LegacyPlanState) {
  gemini = provider;
  vi.stubGlobal('fetch', provider.fetch);
  const limits: { input: Record<string, number>; output?: number } = { input: {} };
  const config = fakeConfig({ aiProvider: 'google', apiKey: 'gem-key', orchestratorModel: 'gemini:big-model', researchMaxSteps: 40 });
  const session = makeSession({
    config,
    fsAdapter: fs,
    modelResolver: {
      modelsForRunners: vi.fn().mockResolvedValue({}),
      contextWindowFor: (source, model) => (source === 'google' ? limits.input[model] : undefined),
      maxOutputTokensFor: (source) => (source === 'google' ? limits.output : undefined),
      warmPickerOptions: vi.fn(),
    },
    // Turns that read past the planner read limit's default on purpose, to fill the window; the limit has its own tests.
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, plannerReadLimit: false }),
  });
  session.loadPlan(plan ?? { ...createEmptyPlan(), conversationHistory: [{ role: 'user', content: GOAL, timestamp: '2026-10-25T09:00:00Z' }] }, GOAL, testWorkspace, { persist: false });
  return { session, limits, config };
}

const history = (session: { planState: { conversationHistory?: ConversationMessage[] } | null }) => session.planState?.conversationHistory ?? [];

/**
 * The catalog states an input limit ten times the opening exchange, which
 * the estimate never comes near, while the provider takes about three of
 * the turn's command outputs: every call fits by the estimate, and the
 * provider refuses the fourth.
 */
async function overstatedLimit(provider: FakeGemini, bash: ReturnType<typeof vi.fn>) {
  const kit = plannerSession(provider, fakeFileSystem({ bash }));
  await kit.session.continueConversation('hello');
  const opening = provider.requests.at(-1)!.promptTokens;
  kit.limits.input['big-model'] = opening * 10;
  kit.limits.output = 4_096;
  provider.inputLimits['big-model'] = opening + 3 * 5_000 + 2_000;
  return { ...kit, opening };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  expect(gemini.malformed).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a Gemini provider refusal of a planner call as too long', () => {
  it('is answered by one compaction and one resend of the function responses it refused, none dropped or sent twice', async () => {
    const provider = new FakeGemini([says('Hi.'), ...steps(), says('All steps done.')]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = await overstatedLimit(provider, bash);

    await session.continueConversation('run all the steps');

    expect(provider.refusals).toBe(1);
    expect(ran(bash)).toEqual(allSteps);
    const refused = provider.requests.findIndex((r) => r.refused);
    expect(trailing(provider.requests[refused + 1])).toEqual(trailing(provider.requests[refused]));
    expect(provider.requests[refused + 1].promptTokens).toBeLessThan(provider.requests[refused].promptTokens);
    expect(provider.summaries.length).toBeGreaterThan(0);
    expect(history(session).at(-1)).toMatchObject({ content: 'All steps done.' });
    expect(session.planState!.plannerContextPause).toBeUndefined();
  });

  it('pauses only the planner when the resend is refused again, nothing landed and the input waiting whole', async () => {
    const provider = new FakeGemini([says('Hi.'), ...steps(), says('All steps done.')]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = await overstatedLimit(provider, bash);
    provider.refusesAfter = 1;

    await session.continueConversation('run all the steps');

    expect(provider.refusals).toBe(2);
    const refused = provider.requests.filter((r) => r.refused);
    expect(trailing(refused[1])).toEqual(trailing(refused[0]));
    const pause = session.planState!.plannerContextPause!;
    expect(pause).toMatchObject({ model: 'big-model', reason: expect.stringMatching(/Retry compaction/) });
    expect(session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['run all the steps']);
    expect(history(session).filter((m) => m.role === 'user' && m.content === 'run all the steps')).toHaveLength(0);
    expect(pause.done).toHaveLength(ran(bash).length);
  });

  it('is retried on the user\'s say-so once a summary can be had, the held function response sent once and none dropped', async () => {
    const provider = new FakeGemini([says('Hi.'), ...steps(), says('All steps done.')]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const kit = plannerSession(provider, fakeFileSystem({ bash }));
    await kit.session.continueConversation('hello');
    kit.limits.input['big-model'] = provider.requests.at(-1)!.promptTokens * 2;
    kit.limits.output = 4_096;
    provider.summariesOk = false;
    await kit.session.continueConversation('run all the steps');
    expect(kit.session.planState!.plannerContextPause).toBeDefined();
    expect(provider.refusals).toBe(0);
    const commands = ran(bash);
    provider.summariesOk = true;
    const from = provider.requests.length;

    await kit.session.retryPlannerCompaction();

    expect(trailing(provider.requests[from])).toEqual([20_000]);
    expect(ran(bash).slice(0, commands.length)).toEqual(commands);
    expect(ran(bash)).toEqual(allSteps);
    expect(history(kit.session).filter((m) => m.role === 'user' && m.content === 'run all the steps')).toHaveLength(1);
    expect(history(kit.session).at(-1)).toMatchObject({ content: 'All steps done.' });
    expect(kit.session.planState!.plannerContextPause).toBeUndefined();
  });

  it('after a reload stays paused rather than start the turn again from the transcript: its commands ran, so no call is made and none runs twice', async () => {
    const provider = new FakeGemini([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = await overstatedLimit(provider, bash);
    provider.refusesAfter = 1;
    await session.continueConversation('run all the steps');
    const saved = structuredClone(saves(session).mock.calls.at(-1)![0]);
    const commands = ran(bash);
    expect(commands.length).toBeGreaterThan(0);

    // A model that asks for the first command again, whatever it is told.
    const later = new FakeGemini([callsTools(['bash', { command: 'make step0' }]), says('Carrying on from the steps that ran.')]);
    const reloaded = plannerSession(later, fakeFileSystem({ bash }), saved);
    reloaded.limits.input['big-model'] = 1_000_000;

    await expect(reloaded.session.retryPlannerCompaction()).rejects.toMatchObject({ name: 'ConversationEditError', message: expect.stringMatching(/already ran .*Stop it to drop the turn/s) });

    expect(later.requests).toHaveLength(0);
    expect(ran(bash)).toEqual(commands);
    expect(reloaded.session.planState!.plannerContextPause).toEqual(saved.plannerContextPause);
    expect(reloaded.session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['run all the steps']);

    // Stop is the way on, and the next message goes over a history Gemini accepts.
    later.replies = [says('Where should I pick up?')];
    expect(reloaded.session.abortPlannerTurn()).toBe(true);
    await reloaded.session.continueConversation('steps 0 to 2 ran; carry on from step 3');
    expect(responses(later.requests[0])).toEqual([]);
    expect(history(reloaded.session).at(-1)).toMatchObject({ content: 'Where should I pick up?' });
    expect(ran(bash)).toEqual(commands);
  });

  it('on the same session stays paused when the planner was switched to a model whose limit is unknown, its commands not run again', async () => {
    const provider = new FakeGemini([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session, config } = await overstatedLimit(provider, bash);
    provider.refusesAfter = 1;
    await session.continueConversation('run all the steps');
    const pause = session.planState!.plannerContextPause!;
    const commands = ran(bash);
    (config as { orchestratorModel: string }).orchestratorModel = 'gemini:unlisted-model';
    provider.replies = [callsTools(['bash', { command: 'make step0' }]), says('Carrying on.')];
    const from = provider.requests.length;

    await expect(session.retryPlannerCompaction()).rejects.toMatchObject({ name: 'ConversationEditError', message: expect.stringMatching(/already ran .*Stop it to drop the turn.*switch it to one it knows/s) });

    expect(provider.requests).toHaveLength(from);
    expect(ran(bash)).toEqual(commands);
    expect(session.planState!.plannerContextPause).toEqual(pause);
  });

  it('is not what any other failure is taken for: a server error or a quota is not retried and pauses nothing', async () => {
    for (const status of [500, 429]) {
      const provider = new FakeGemini([says('Hi.'), callsTools(['bash', { command: 'make step0' }])]);
      const bash = vi.fn(async () => out(20_000, 's'));
      const { session } = await overstatedLimit(provider, bash);
      provider.errors.set(provider.requests.length + 1, FakeGemini.error(status, status === 429 ? 'Resource has been exhausted (e.g. check quota).' : 'Internal error encountered.'));

      await expect(session.continueConversation('run all the steps')).rejects.toBeDefined();

      expect(provider.requests).toHaveLength(3);
      expect(provider.summaries).toHaveLength(0);
      expect(bash).toHaveBeenCalledTimes(1);
      expect(session.planState!.plannerContextPause).toBeUndefined();
    }
  });

  it('is dropped with its turn by a Stop, and the next message goes over a history Gemini accepts, no command run again', async () => {
    const provider = new FakeGemini([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = await overstatedLimit(provider, bash);
    provider.refusesAfter = 1;
    await session.continueConversation('run all the steps');
    const commands = ran(bash);

    expect(session.abortPlannerTurn()).toBe(true);
    expect(session.planState!.plannerContextPause).toBeUndefined();
    expect(session.planState!.pendingTurns).toEqual([]);

    // The limit the refusal stated still holds: the next call is fitted on it, over a history whose every call is answered.
    provider.replies = [says('Stopping there.')];
    await session.continueConversation('never mind');
    expect(provider.requests.at(-1)!.refused).toBeUndefined();
    expect(ran(bash)).toEqual(commands);
    expect(history(session).at(-1)).toMatchObject({ content: 'Stopping there.' });
  });
});
