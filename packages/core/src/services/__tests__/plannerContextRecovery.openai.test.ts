import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IFileSystem, ToolOutcome } from '../../interfaces/IFileSystem';
import type { ConversationMessage, LegacyPlanState, PlannerCompaction } from '../../models/Task';
import type { SessionMessage } from '../SessionMessage';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { createEmptyPlan } from '../../models/Task';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { PlannerTurnStoppedError } from '../PlannerConversation';

const createSpy = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createSpy } };
  },
}));

import { makeSession, saves, testWorkspace } from './sessionTestKit';
import { plan as runPlan, recordingRunner, task } from './supervisorTestKit';

interface SentMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}
interface SentRequest {
  model: string;
  messages: SentMessage[];
  tools?: unknown[];
  max_tokens: number;
}
type Sent = SentRequest & { promptTokens: number; refused?: true };

const SUMMARY = 'The user asked for every build step to run. The planner ran make step0 through make step2 with bash, each passing, and still has the later steps to run before it reports back.';
const tagged = (text: string) => `<conversation_summary>${text}</conversation_summary>`;

/**
 * An OpenAI-compatible provider at the SDK's create(): it counts a prompt at
 * four characters of its text to a token, refuses one whose prompt and
 * requested reply pass the model's window — saying the window, as OpenAI
 * does, unless told not to — and answers a request that offers no tools, a
 * summary call, from its own script: a whole summary while `summariesOk`,
 * else one with no tags. `refuseNext` refuses that many planner requests
 * whatever their size, and `refusesAfter` adds to it on each refusal by
 * window: a server that keeps refusing. `errors` throws, by planner request
 * index, what a test makes it.
 */
class FakeProvider {
  readonly requests: Sent[] = [];
  readonly summaries: Sent[] = [];
  windows: Record<string, number> = {};
  statesWindow = true;
  summariesOk = true;
  refuseNext = 0;
  refusesAfter = 0;
  errors = new Map<number, () => unknown>();
  /** A summary reply waits on this when set, as a slow call would: a stop reaches it there. */
  summaryGate: Promise<void> | undefined;
  /** Told of each planner request as it arrives, before it is answered. */
  onRequest: ((sent: Sent) => void) | undefined;

  constructor(public replies: Array<() => unknown[]>) {}

  get refusals(): number { return this.requests.filter((r) => r.refused).length; }

  static tokensOf(req: SentRequest): number {
    const text = req.messages.map((m) => (m.content ?? '') + JSON.stringify(m.tool_calls ?? '')).join('') + JSON.stringify(req.tools ?? []);
    return Math.ceil(text.length / 4);
  }

  create = async (req: SentRequest, opts?: { signal?: AbortSignal }): Promise<AsyncIterable<unknown>> => {
    const sent: Sent = { ...req, messages: req.messages.map((m) => ({ ...m })), promptTokens: 0 };
    sent.promptTokens = FakeProvider.tokensOf(sent);
    const isSummary = req.tools === undefined;
    (isSummary ? this.summaries : this.requests).push(sent);
    if (!isSummary) this.onRequest?.(sent);
    if (isSummary && this.summaryGate) {
      const gate = this.summaryGate;
      await new Promise<void>((resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' })), { once: true });
        void gate.then(resolve);
      });
    }
    const error = isSummary ? undefined : this.errors.get(this.requests.length - 1);
    if (error) throw error();
    const window = this.windows[req.model];
    const overWindow = window !== undefined && sent.promptTokens + req.max_tokens > window;
    const refusing = !isSummary && this.refuseNext > 0;
    if (refusing) this.refuseNext--;
    if (overWindow || refusing) {
      sent.refused = true;
      if (overWindow) this.refuseNext += this.refusesAfter;
      const states = this.statesWindow && window !== undefined ? `This model's maximum context length is ${window} tokens. ` : '';
      throw Object.assign(new Error(`400 ${states}Please reduce the length of the messages.`), { status: 400, code: 'context_length_exceeded', type: 'invalid_request_error' });
    }
    const chunks = isSummary
      ? (this.summariesOk ? says(tagged(SUMMARY)) : says('Here is the summary, untagged: the steps ran.'))()
      : this.replies.shift()?.() ?? says('Done.')();
    return (async function* () {
      for (const c of chunks) yield c;
      yield { choices: [], usage: { prompt_tokens: sent.promptTokens, completion_tokens: 7 } };
    })();
  };
}

const callsTool = (id: string, name: string, args: Record<string, unknown>) => () => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] },
];
const says = (text: string, finish = 'stop') => () => [{ choices: [{ delta: { content: text }, finish_reason: finish }] }];

const out = (chars: number, fill = 'x'): ToolOutcome => ({ success: true, output: fill.repeat(chars), truncated: false });

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

/** The results a request sends after its last assistant message: what that call's tools returned. */
function trailingResults(req: SentRequest): string[] {
  const last = req.messages.map((m) => m.role).lastIndexOf('assistant');
  return req.messages.slice(last + 1).filter((m) => m.role === 'tool').map((m) => m.tool_call_id!);
}

const GOAL = 'run the build';
const MODEL = 'vendor/model';

/** A session on an OpenRouter planner, the window of each model in its catalog set by the test. */
function plannerSession(provider: FakeProvider, fs: IFileSystem, opts: { auto?: () => boolean; plan?: LegacyPlanState; runner?: ReturnType<typeof recordingRunner> } = {}) {
  createSpy.mockImplementation(provider.create);
  const catalog: { windows: Record<string, number>; maxOutput?: number } = { windows: {} };
  const events: SessionMessage[] = [];
  const config = fakeConfig({ aiProvider: 'openrouter', orchestratorModel: MODEL });
  const session = makeSession({
    config,
    fsAdapter: fs,
    broadcast: (m) => events.push(m),
    ...(opts.runner ? { runner: opts.runner.runner } : {}),
    modelResolver: {
      modelsForRunners: vi.fn().mockResolvedValue({}),
      contextWindowFor: (source, model) => (source === 'openrouter' ? catalog.windows[model] : undefined),
      maxOutputTokensFor: (source) => (source === 'openrouter' ? catalog.maxOutput : undefined),
      warmPickerOptions: vi.fn(),
    },
    // Turns that read past the planner read limit's default on purpose, to fill the window; the limit has its own tests.
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, plannerAutoCompaction: opts.auto?.() ?? true, plannerReadLimit: false }),
  });
  session.loadPlan(opts.plan ?? { ...createEmptyPlan(), conversationHistory: [{ role: 'user', content: GOAL, timestamp: '2026-10-25T09:00:00Z' }] }, GOAL, testWorkspace, { persist: false });
  const compactions = () => events.flatMap((m) => (m.type === 'planner_compaction' ? [m.compaction] : [])) as PlannerCompaction[];
  return { session, catalog, config, events, compactions };
}

const history = (session: { planState: { conversationHistory?: ConversationMessage[] } | null }): ConversationMessage[] => session.planState?.conversationHistory ?? [];
const userSaid = (session: { planState: { conversationHistory?: ConversationMessage[] } | null }, text: string) => history(session).filter((m) => m.role === 'user' && m.content === text);

const STEPS = 6;
const steps = () => Array.from({ length: STEPS }, (_, i) => callsTool(`bash_${i}`, 'bash', { command: `make step${i}` }));
const ran = (bash: ReturnType<typeof vi.fn>) => bash.mock.calls.map((c) => (c[0] as string));

/**
 * The first exchange measures how the provider counts; then the catalog
 * states a window ten times that, which the estimate never comes near, while
 * the provider serves one that holds only about three of the turn's command
 * outputs. Every call fits by the estimate; the provider refuses the fourth.
 */
async function overstatedWindow(provider: FakeProvider, fs: IFileSystem, opts: Parameters<typeof plannerSession>[2] = {}) {
  const env = plannerSession(provider, fs, opts);
  await env.session.continueConversation('hello');
  const opening = provider.requests.at(-1)!.promptTokens;
  env.catalog.windows[MODEL] = opening * 10;
  env.catalog.maxOutput = 4_096;
  provider.windows[MODEL] = opening + 4_096 + 3 * 5_000 + 2_000;
  return { ...env, opening };
}

/**
 * A catalog window the turn's commands fill by themselves, as the estimate
 * says before any call, while no summary of them can be had: the planner
 * pauses on its context with no call refused, holding the results it could
 * not send.
 */
async function pausedOnSummaries(provider: FakeProvider, fs: IFileSystem, opts: Parameters<typeof plannerSession>[2] = {}) {
  const env = plannerSession(provider, fs, opts);
  await env.session.continueConversation('hello');
  const opening = provider.requests.at(-1)!.promptTokens;
  env.catalog.windows[MODEL] = opening * 2;
  env.catalog.maxOutput = 4_096;
  provider.summariesOk = false;
  await env.session.continueConversation('run all the steps');
  expect(env.session.planState!.plannerContextPause).toBeDefined();
  provider.summariesOk = true;
  return { ...env, opening };
}

/** The input a paused turn's chat holds: the results of the newest command it ran, which no request has carried yet. */
function heldCall(provider: FakeProvider, bash: ReturnType<typeof vi.fn>): string[] {
  const id = `bash_${ran(bash).length - 1}`;
  expect(provider.requests.some((r) => r.messages.some((m) => m.role === 'tool' && m.tool_call_id === id))).toBe(false);
  return [id];
}

const wideReads = (n: number) => () => [{
  choices: [{ delta: { tool_calls: Array.from({ length: n }, (_, i) => ({ index: i, id: `read_${i}`, function: { name: 'read_file', arguments: JSON.stringify({ path: `src/part${i}.ts` }) } })) }, finish_reason: 'tool_calls' }],
}];

const allSteps = Array.from({ length: STEPS }, (_, i) => `make step${i}`);

describe('a provider refusal of a planner call as too long', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('is answered by one compaction and one resend of the call it refused, and bounds every later call of the turn below it', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps(), says('All steps done.')]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session, compactions } = await overstatedWindow(provider, fakeFileSystem({ bash }));

    await session.continueConversation('run all the steps');

    expect(provider.refusals).toBe(1);
    expect(ran(bash)).toEqual(allSteps);
    const refused = provider.requests.findIndex((r) => r.refused);
    const resent = provider.requests[refused + 1];
    // The same call's results, sent once more, each answering its call once.
    expect(trailingResults(resent)).toEqual(trailingResults(provider.requests[refused]));
    expect(resent.promptTokens).toBeLessThan(provider.requests[refused].promptTokens);
    for (const req of provider.requests) expect(pairsValid(req.messages)).toBe(true);
    // The compaction that made room was a summary, which offers no tools.
    expect(provider.summaries.length).toBeGreaterThan(0);
    expect(compactions().flatMap((c) => (c.phase === 'ended' ? [c.outcome] : []))).toContain('condensed');
    expect(history(session).at(-1)).toMatchObject({ role: 'assistant', content: 'All steps done.' });
    expect(userSaid(session, 'run all the steps')).toHaveLength(1);
    expect(session.planState?.plannerContextPause).toBeUndefined();
  });

  it('pauses only the planner when the resend is refused again: nothing lands, the input waits whole, and no command runs twice', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps(), says('All steps done.')]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = await overstatedWindow(provider, fakeFileSystem({ bash }));
    provider.refusesAfter = 1;

    await expect(session.continueConversation('run all the steps')).resolves.toBeDefined();

    expect(provider.refusals).toBe(2);
    const refused = provider.requests.filter((r) => r.refused);
    expect(trailingResults(refused[1])).toEqual(trailingResults(refused[0]));
    const pause = session.planState!.plannerContextPause!;
    expect(pause).toMatchObject({ model: MODEL, reason: expect.stringMatching(/refused the planner's call as too long for its window, even after .*Retry compaction/) });
    expect(session.planState!.pendingTurns!.map((t) => t.id)).toEqual(pause.inputs);
    expect(session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['run all the steps']);
    expect(userSaid(session, 'run all the steps')).toHaveLength(0);
    expect(history(session).at(-1)).toMatchObject({ kind: 'error', content: pause.reason });
    // Read off the calls, not asked of a model: every command that ran.
    expect(pause.done?.map((line) => /make (step\d)/.exec(line)![1])).toEqual(ran(bash).map((c) => c.slice(5)));
    const calls = provider.requests.length;

    // Paused, a message is saved and answered at once, and nothing is sent.
    await session.continueConversation('then lint it');
    expect(provider.requests).toHaveLength(calls);
    expect(session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['run all the steps', 'then lint it']);
  });

  it('pauses without a resend when eight wide reads in one round are past the window by themselves, none cut or run again', async () => {
    const provider = new FakeProvider([says('Hi.'), wideReads(8)]);
    const readFile = vi.fn(async (path: string) => out(49_000, path.endsWith('.ts') ? 'r' : ''));
    const { session } = await overstatedWindow(provider, fakeFileSystem({ readFile }));
    const reads = () => readFile.mock.calls.filter(([path]) => /^src\/part\d\.ts$/.test(path as string));

    await session.continueConversation('read the parts');

    expect(provider.refusals).toBe(1);
    const refused = provider.requests.at(-1)!;
    expect(refused.refused).toBe(true);
    expect(trailingResults(refused)).toHaveLength(8);
    for (const m of refused.messages.filter((m) => m.role === 'tool')) expect(m.content).toHaveLength(49_000);
    const { reason } = session.planState!.plannerContextPause!;
    expect(reason).toMatch(/^What the planner's last tool calls returned is too long for vendor\/model's window by itself/);
    // No compaction makes room for what is too long by itself: Retry on this model would only pause again.
    expect(reason).toMatch(/switch it to a model with a larger window, then Retry compaction, or stop it to drop the turn\.$/);
    expect(reason).not.toMatch(/tries to condense/);
    expect(reads()).toHaveLength(8);
  });
});

describe('Retry compaction of a planner paused on its context', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('condenses with the user\'s consent and sends the held input once on the live context, then what waited goes in the next turn', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps(), says('All steps done.'), says('Linted.')]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = await pausedOnSummaries(provider, fakeFileSystem({ bash }));
    expect(provider.refusals).toBe(0);
    await session.continueConversation('then lint it');
    const held = heldCall(provider, bash);
    const before = ran(bash);
    const from = provider.requests.length;

    await session.retryPlannerCompaction();

    const retried = provider.requests[from];
    expect(trailingResults(retried)).toEqual(held);
    // Nothing new is said to the planner: neither the paused message again nor what waited since.
    expect(retried.messages.filter((m) => m.role === 'user' && (m.content ?? '').includes('run all the steps'))).toHaveLength(1);
    expect(retried.messages.some((m) => (m.content ?? '').includes('then lint it'))).toBe(false);
    // Nor does any summary the retry asked for: what waited is the next turn's.
    expect(provider.summaries.length).toBeGreaterThan(0);
    for (const summary of provider.summaries) expect(JSON.stringify(summary.messages)).not.toContain('then lint it');
    expect(ran(bash).slice(0, before.length)).toEqual(before);
    expect(ran(bash)).toEqual(allSteps);
    for (const req of provider.requests) expect(pairsValid(req.messages)).toBe(true);
    expect(userSaid(session, 'run all the steps')).toHaveLength(1);
    expect(history(session).some((m) => m.content === 'All steps done.')).toBe(true);
    expect(session.planState?.plannerContextPause).toBeUndefined();

    await vi.waitFor(() => expect(history(session).at(-1)).toMatchObject({ content: 'Linted.' }));
    expect(userSaid(session, 'then lint it')).toHaveLength(1);
    expect(session.planState!.pendingTurns).toEqual([]);
  });

  it('after a reload stays paused rather than start again from the transcript a turn whose commands ran: no call is made, so none runs twice', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = await pausedOnSummaries(provider, fakeFileSystem({ bash }));
    const saved = structuredClone(saves(session).mock.calls.at(-1)![0]);
    const commands = ran(bash);
    expect(commands.length).toBeGreaterThan(0);

    // A model that asks for the first command again, whatever it is told.
    const later = new FakeProvider([callsTool('bash_again', 'bash', { command: 'make step0' }), says('Carried on.')]);
    const reloaded = plannerSession(later, fakeFileSystem({ bash }), { plan: saved });
    reloaded.catalog.windows[MODEL] = 1_000_000;
    expect(reloaded.session.planState!.plannerContextPause).toEqual(saved.plannerContextPause);

    await expect(reloaded.session.retryPlannerCompaction()).rejects.toMatchObject({ name: 'ConversationEditError', message: expect.stringMatching(/already ran .*Stop/s) });

    expect(later.requests).toHaveLength(0);
    expect(later.summaries).toHaveLength(0);
    expect(ran(bash)).toEqual(commands);
    expect(reloaded.session.planState!.plannerContextPause).toEqual(saved.plannerContextPause);
    expect(reloaded.session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['run all the steps']);
    expect(userSaid(reloaded.session, 'run all the steps')).toHaveLength(0);

    // Stop is the way on: the pause goes with its turn, and the next message is sent.
    later.replies = [says('Where should I pick up?')];
    expect(reloaded.session.abortPlannerTurn()).toBe(true);
    await reloaded.session.continueConversation('steps 0 to 2 ran; carry on from step 3');
    expect(reloaded.session.planState!.plannerContextPause).toBeUndefined();
    expect(history(reloaded.session).at(-1)).toMatchObject({ content: 'Where should I pick up?' });
    expect(ran(bash)).toEqual(commands);
  });

  it('after a reload stays paused on a saved pause whose list of what ran was cut short, whatever of it is kept', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = await pausedOnSummaries(provider, fakeFileSystem({ bash }));
    const saved = structuredClone(saves(session).mock.calls.at(-1)![0]) as LegacyPlanState;
    const commands = ran(bash);
    for (const done of [saved.plannerContextPause!.done, undefined]) {
      const plan = structuredClone(saved);
      plan.plannerContextPause = { ...plan.plannerContextPause!, doneTruncated: true };
      if (done === undefined) delete plan.plannerContextPause.done;
      const later = new FakeProvider([callsTool('bash_again', 'bash', { command: 'make step0' }), says('Carried on.')]);
      const reloaded = plannerSession(later, fakeFileSystem({ bash }), { plan });
      reloaded.catalog.windows[MODEL] = 1_000_000;

      await expect(reloaded.session.retryPlannerCompaction()).rejects.toMatchObject({ name: 'ConversationEditError', message: expect.stringMatching(/already ran .*- \(more\)$/s) });

      expect(later.requests).toHaveLength(0);
      expect(ran(bash)).toEqual(commands);
      expect(reloaded.session.planState!.plannerContextPause).toEqual(plan.plannerContextPause);
    }
  });

  it('after a reload starts a paused turn that only read again from the transcript: reads may run again, and the message is sent once', async () => {
    const provider = new FakeProvider([says('Hi.'), wideReads(8)]);
    const readFile = vi.fn(async () => out(49_000, 'r'));
    const { session } = await overstatedWindow(provider, fakeFileSystem({ readFile }));
    await session.continueConversation('read every part');
    expect(session.planState!.plannerContextPause).toBeDefined();
    expect(session.planState!.plannerContextPause!.done).toBeUndefined();
    const saved = structuredClone(saves(session).mock.calls.at(-1)![0]);

    const later = new FakeProvider([says('The parts are read.')]);
    const reloaded = plannerSession(later, fakeFileSystem(), { plan: saved });
    reloaded.catalog.windows[MODEL] = 1_000_000;

    await reloaded.session.retryPlannerCompaction();

    expect(later.requests).toHaveLength(1);
    expect(later.requests[0].messages.filter((m) => m.role === 'user' && (m.content ?? '').includes('read every part'))).toHaveLength(1);
    expect(userSaid(reloaded.session, 'read every part')).toHaveLength(1);
    expect(history(reloaded.session).at(-1)).toMatchObject({ content: 'The parts are read.' });
    expect(reloaded.session.planState!.plannerContextPause).toBeUndefined();
  });

  it('pauses again, bounded, when the retry\'s one call is refused, and keeps everything for the next', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = await pausedOnSummaries(provider, fakeFileSystem({ bash }));
    const pause = session.planState!.plannerContextPause!;
    const commands = ran(bash);
    provider.refuseNext = 1;
    const from = provider.requests.length;

    await expect(session.retryPlannerCompaction()).resolves.toBeDefined();

    // One call: the retry is the one attempt, with no backstop of its own.
    expect(provider.requests.slice(from)).toHaveLength(1);
    expect(provider.refusals).toBe(1);
    expect(session.planState!.plannerContextPause).toMatchObject({ inputs: pause.inputs, done: pause.done });
    expect(session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['run all the steps']);
    expect(ran(bash)).toEqual(commands);
  });

  it('is retried on the model the planner is switched to, which a larger window lets fit without a summary', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps(), says('All steps done.')]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session, catalog, config, opening } = await pausedOnSummaries(provider, fakeFileSystem({ bash }));
    catalog.windows['vendor/large'] = opening * 20;
    (config as { orchestratorModel: string }).orchestratorModel = 'vendor/large';
    const held = heldCall(provider, bash);
    const summaries = provider.summaries.length;
    const from = provider.requests.length;

    await session.retryPlannerCompaction();

    expect(provider.requests[from]).toMatchObject({ model: 'vendor/large' });
    expect(trailingResults(provider.requests[from])).toEqual(held);
    expect(provider.summaries).toHaveLength(summaries);
    expect(ran(bash)).toEqual(allSteps);
    expect(history(session).at(-1)).toMatchObject({ content: 'All steps done.' });
  });

  it('stays paused when the planner was switched to a model whose window is unknown, rather than replay commands that ran, and carries on once switched to one known', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session, config, catalog, opening } = await pausedOnSummaries(provider, fakeFileSystem({ bash }));
    const pause = session.planState!.plannerContextPause!;
    (config as { orchestratorModel: string }).orchestratorModel = 'vendor/unlisted';
    // A model that asks for the first command again, whatever it is told.
    provider.replies = [callsTool('bash_again', 'bash', { command: 'make step0' }), says('Picking up from the steps that ran.')];
    const held = heldCall(provider, bash);
    const commands = ran(bash);
    const from = provider.requests.length;
    const summaries = provider.summaries.length;

    await expect(session.retryPlannerCompaction()).rejects.toMatchObject({ name: 'ConversationEditError', message: expect.stringMatching(/already ran .*Stop it to drop the turn.*switch it to one it knows/s) });

    expect(provider.requests).toHaveLength(from);
    expect(provider.summaries).toHaveLength(summaries);
    expect(ran(bash)).toEqual(commands);
    expect(session.planState!.plannerContextPause).toEqual(pause);
    expect(session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['run all the steps']);

    // On a model whose window is known, the live context sends what it holds, once.
    catalog.windows['vendor/large'] = opening * 20;
    (config as { orchestratorModel: string }).orchestratorModel = 'vendor/large';
    provider.replies = [...steps().slice(commands.length), says('All steps done.')];
    await session.retryPlannerCompaction();
    expect(trailingResults(provider.requests[from])).toEqual(held);
    expect(ran(bash)).toEqual(allSteps);
    expect(history(session).at(-1)).toMatchObject({ content: 'All steps done.' });
  });

  it('stays paused when the planner provider was switched on the same session, its live context let go with the old one: no call is made', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session, config, catalog } = await pausedOnSummaries(provider, fakeFileSystem({ bash }));
    const pause = session.planState!.plannerContextPause!;
    const commands = ran(bash);
    (config as { aiProvider: string }).aiProvider = 'openai';
    catalog.windows[MODEL] = 1_000_000;
    provider.replies = [callsTool('bash_again', 'bash', { command: 'make step0' }), says('Carried on.')];
    const from = provider.requests.length;

    await expect(session.retryPlannerCompaction()).rejects.toMatchObject({ name: 'ConversationEditError', message: expect.stringMatching(/its live context is gone.*Stop it to drop the turn/s) });

    expect(provider.requests).toHaveLength(from);
    expect(ran(bash)).toEqual(commands);
    expect(session.planState!.plannerContextPause).toEqual(pause);
    expect(session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['run all the steps']);
  });

  it('pauses an opening that fills its window, its goal waiting out of the dialogue, and lands the goal once on the retry', async () => {
    const provider = new FakeProvider([...steps(), says('All steps done.')]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session, catalog } = plannerSession(provider, fakeFileSystem({ bash }));
    // Once the first call is measured, the catalog states a window the turn's commands soon fill.
    provider.onRequest = (sent) => {
      if (provider.requests.length !== 1) return;
      catalog.windows[MODEL] = sent.promptTokens * 2;
      catalog.maxOutput = 4_096;
    };
    provider.summariesOk = false;

    await session.startPlanning('run all the steps');

    expect(session.planState!.plannerContextPause).toBeDefined();
    expect(history(session).map((m) => m.kind)).toEqual(['error']);
    expect(session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['run all the steps']);
    expect(session.planState!.plannerContextPause!.inputs).toEqual(session.planState!.pendingTurns!.map((t) => t.id));
    const commands = ran(bash);
    provider.summariesOk = true;

    await session.retryPlannerCompaction();

    expect(ran(bash).slice(0, commands.length)).toEqual(commands);
    expect(ran(bash)).toEqual(allSteps);
    expect(userSaid(session, 'run all the steps')).toHaveLength(1);
    expect(history(session).at(-1)).toMatchObject({ content: 'All steps done.' });
    expect(session.planState!.pendingTurns).toEqual([]);
    expect(session.planState!.plannerContextPause).toBeUndefined();
  });

  it('is refused while nothing is paused', async () => {
    const provider = new FakeProvider([says('Hi.')]);
    const { session } = plannerSession(provider, fakeFileSystem());
    await expect(session.retryPlannerCompaction()).rejects.toMatchObject({ name: 'ConversationEditError' });
  });
});

describe('a Stop of a planner paused on its context', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('drops the paused turn and the pause, and the next message carries on over a history the provider accepts', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session, catalog } = await pausedOnSummaries(provider, fakeFileSystem({ bash }));
    const commands = ran(bash);

    expect(session.abortPlannerTurn()).toBe(true);

    expect(session.planState!.plannerContextPause).toBeUndefined();
    expect(session.planState!.pendingTurns).toEqual([]);
    catalog.windows[MODEL] = 1_000_000;
    provider.replies = [says('Fine, stopping there.')];
    await session.continueConversation('never mind');
    expect(pairsValid(provider.requests.at(-1)!.messages)).toBe(true);
    expect(ran(bash)).toEqual(commands);
    expect(history(session).at(-1)).toMatchObject({ content: 'Fine, stopping there.' });
  });

  it('stops a retry mid-summary: the late summary commits nothing, the pause ends, and no command runs again', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = await pausedOnSummaries(provider, fakeFileSystem({ bash }));
    const commands = ran(bash);
    const calls = provider.requests.length;
    const before = history(session).length;
    let open!: () => void;
    provider.summaryGate = new Promise((resolve) => { open = resolve; });
    const summaries = provider.summaries.length;

    const retry = session.retryPlannerCompaction();
    await vi.waitFor(() => expect(provider.summaries.length).toBeGreaterThan(summaries));
    expect(session.abortPlannerTurn()).toBe(true);
    open();

    await expect(retry).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(provider.requests).toHaveLength(calls);
    expect(history(session).slice(before).some((m) => m.kind === 'compaction')).toBe(false);
    expect(session.planState!.plannerContextPause).toBeUndefined();
    expect(session.planState!.pendingTurns).toEqual([]);
    expect(ran(bash)).toEqual(commands);
  });
  it('stops a /compact run while paused: the pause ends with the paused turn, the late summary commits nothing', async () => {
    const provider = new FakeProvider([says('Hi.'), says('Noted.'), says('Sure.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const env = plannerSession(provider, fakeFileSystem({ bash }));
    const { session } = env;
    // Exchanges enough for /compact to have something to condense.
    for (const text of ['hello', 'keep it small', 'and quick']) await session.continueConversation(text);
    env.catalog.windows[MODEL] = provider.requests[0].promptTokens * 2;
    env.catalog.maxOutput = 4_096;
    provider.summariesOk = false;
    await session.continueConversation('run all the steps');
    expect(session.planState!.plannerContextPause).toBeDefined();
    provider.summariesOk = true;
    const commands = ran(bash);
    const before = history(session).length;
    let open!: () => void;
    provider.summaryGate = new Promise((resolve) => { open = resolve; });
    const summaries = provider.summaries.length;

    const compact = session.compactConversation();
    await vi.waitFor(() => expect(provider.summaries.length).toBeGreaterThan(summaries));
    expect(session.abortPlannerTurn()).toBe(true);
    open();

    await expect(compact).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(session.planState!.plannerContextPause).toBeUndefined();
    expect(session.planState!.pendingTurns).toEqual([]);
    expect(history(session).slice(before).some((m) => m.kind === 'compaction')).toBe(false);
    expect(ran(bash)).toEqual(commands);
  });
});

describe('a planner call that fails for any other reason', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it.each([
    ['a server error', () => Object.assign(new Error('500 upstream unavailable'), { status: 500 })],
    ['a rate limit', () => Object.assign(new Error('429 Rate limit reached for requests'), { status: 429, code: 'rate_limit_exceeded' })],
    ['a refused key', () => Object.assign(new Error('401 Incorrect API key provided'), { status: 401, code: 'invalid_api_key' })],
    ['another bad request', () => Object.assign(new Error("400 Invalid value for 'max_tokens': too large"), { status: 400, code: 'invalid_value' })],
    ['a dropped connection', () => Object.assign(new Error('Connection error.'), { cause: new Error('fetch failed') })],
  ])('is not taken for an overflow after %s: no compaction, no retry, no pause', async (_label, error) => {
    const provider = new FakeProvider([says('Hi.'), callsTool('bash_0', 'bash', { command: 'make step0' })]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session, compactions } = await overstatedWindow(provider, fakeFileSystem({ bash }));
    provider.errors.set(provider.requests.length + 1, error);

    await expect(session.continueConversation('run all the steps')).rejects.toBeDefined();

    // The opening exchange, the call that asked for the command, and the one that failed: never a second try.
    expect(provider.requests).toHaveLength(3);
    expect(provider.summaries).toHaveLength(0);
    expect(compactions()).toHaveLength(0);
    expect(bash).toHaveBeenCalledTimes(1);
    expect(session.planState!.plannerContextPause).toBeUndefined();
  });

  it('is not taken for an overflow when the output limit cut the reply: it stays on the repair path', async () => {
    const provider = new FakeProvider([says('Hi.'), says('The steps are: one, two, thr', 'length')]);
    const { session, compactions } = await overstatedWindow(provider, fakeFileSystem());

    await session.continueConversation('list the steps');

    expect(provider.refusals).toBe(0);
    expect(compactions()).toHaveLength(0);
    expect(session.planState!.plannerContextPause).toBeUndefined();
  });
});

describe('a message too long for the planner model\'s window by itself', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('is never sent, nor cut to fit: the planner pauses with it whole, and says it is the message', async () => {
    const provider = new FakeProvider([says('Hi.')]);
    const { session, catalog } = plannerSession(provider, fakeFileSystem());
    await session.continueConversation('hello');
    catalog.windows[MODEL] = provider.requests.at(-1)!.promptTokens * 3;
    const message = `please review this log:\n${'L'.repeat(provider.requests.at(-1)!.promptTokens * 4 * 4)}`;
    const calls = provider.requests.length;

    await session.continueConversation(message);

    expect(provider.requests).toHaveLength(calls);
    const pause = session.planState!.plannerContextPause!;
    expect(pause.reason).toMatch(/^Your message is too long for vendor\/model's window by itself/);
    expect(session.planState!.pendingTurns!.map((t) => t.text)).toEqual([message]);
  });

  it('is sent once on the user\'s Retry whatever the estimate, and lands where the model takes more than its catalog says', async () => {
    const provider = new FakeProvider([says('Hi.'), says('Reviewed.')]);
    const { session, catalog } = plannerSession(provider, fakeFileSystem());
    await session.continueConversation('hello');
    catalog.windows[MODEL] = provider.requests.at(-1)!.promptTokens * 3;
    const message = `please review this log:\n${'L'.repeat(provider.requests.at(-1)!.promptTokens * 4 * 4)}`;
    await session.continueConversation(message);
    expect(session.planState!.plannerContextPause).toBeDefined();
    const calls = provider.requests.length;

    await session.retryPlannerCompaction();

    expect(provider.requests).toHaveLength(calls + 1);
    expect(provider.requests.at(-1)!.messages.at(-1)!.content).toContain(message);
    expect(session.planState!.plannerContextPause).toBeUndefined();
    expect(userSaid(session, message)).toHaveLength(1);
    expect(history(session).at(-1)).toMatchObject({ role: 'assistant', content: 'Reviewed.' });
  });
});

describe('a planner call a summary was committed for', () => {
  beforeEach(() => { createSpy.mockReset(); });

  const WINDOW = 200_000;

  /** A long exchange lands while no window is known; then a message that, with that history condensed away, still fills 95% of the window. */
  async function overBudgetAfterSummary(provider: FakeProvider) {
    const env = plannerSession(provider, fakeFileSystem());
    await env.session.continueConversation('hello');
    const opening = provider.requests.at(-1)!.promptTokens;
    await env.session.continueConversation(`here is the old log:\n${'B'.repeat(300_000)}`);
    env.catalog.windows[MODEL] = WINDOW;
    env.catalog.maxOutput = 4_096;
    provider.windows[MODEL] = WINDOW;
    const message = `review this:\n${'M'.repeat((Math.floor(WINDOW * 0.95) - opening) * 4)}`;
    const calls = provider.requests.length;
    await env.session.continueConversation(message);
    return { ...env, message, calls };
  }

  it('is held past 90% of the window, though the model would take it, and the planner pauses', async () => {
    const provider = new FakeProvider([says('Hi.'), says('Read.'), says('Reviewed.')]);
    const { session, message, calls, compactions } = await overBudgetAfterSummary(provider);

    expect(provider.summaries).toHaveLength(1);
    expect(provider.requests).toHaveLength(calls);
    expect(compactions().flatMap((c) => (c.phase === 'ended' ? [c.outcome] : []))).toEqual(['paused']);
    const pause = session.planState!.plannerContextPause!;
    expect(pause.reason).toMatch(/^The planner's context is estimated past the 90% of vendor\/model's window it is kept to, even after .*condensing.*Retry compaction/);
    expect(pause.reason).not.toMatch(/by itself/);
    expect(session.planState!.pendingTurns!.map((t) => t.text)).toEqual([message]);
  });
});

describe('a planner model whose window no catalog states', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('compacts nothing on its own: the provider\'s refusal pauses the planner at once, and says why', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = plannerSession(provider, fakeFileSystem({ bash }));
    await session.continueConversation('hello');
    provider.windows[MODEL] = provider.requests.at(-1)!.promptTokens + 32_000 + 3 * 5_000;

    await session.continueConversation('run all the steps');

    expect(provider.refusals).toBe(1);
    expect(provider.summaries).toHaveLength(0);
    expect(session.planState!.plannerContextPause!.reason).toMatch(/no catalog Ordewell holds states/);
  });

  it('is retried on the window the refusal stated, condensed with the user\'s consent, and sent once', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps(), says('All steps done.')]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = plannerSession(provider, fakeFileSystem({ bash }));
    await session.continueConversation('hello');
    provider.windows[MODEL] = provider.requests.at(-1)!.promptTokens + 32_000 + 3 * 5_000;
    await session.continueConversation('run all the steps');
    const refused = provider.requests.filter((r) => r.refused).at(-1)!;
    const from = provider.requests.length;

    await session.retryPlannerCompaction();

    expect(provider.summaries.length).toBeGreaterThan(0);
    expect(trailingResults(provider.requests[from])).toEqual(trailingResults(refused));
    expect(provider.requests[from].promptTokens).toBeLessThan(refused.promptTokens);
    // The reply asked for is sized on the stated window from then on.
    for (const req of provider.requests.slice(from)) expect(req.max_tokens).toBeLessThan(32_000);
    expect(ran(bash)).toEqual(allSteps);
    expect(history(session).some((m) => m.content === 'All steps done.')).toBe(true);
  });

  it('stays paused when the refusal stated no window either, rather than replay commands that ran: no call is made', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps()]);
    provider.statesWindow = false;
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session } = plannerSession(provider, fakeFileSystem({ bash }));
    await session.continueConversation('hello');
    provider.windows[MODEL] = provider.requests.at(-1)!.promptTokens + 32_000 + 3 * 5_000;
    await session.continueConversation('run all the steps');
    const pause = session.planState!.plannerContextPause!;
    const commands = ran(bash);
    provider.replies = [callsTool('bash_again', 'bash', { command: 'make step0' }), says('Carrying on from the steps that ran.')];
    const from = provider.requests.length;

    await expect(session.retryPlannerCompaction()).rejects.toMatchObject({ name: 'ConversationEditError', message: expect.stringMatching(/already ran .*Stop it to drop the turn.*switch it to one it knows: Retry compaction can then continue the turn.*Already ran:\n- bash\(\{"command":"make step0"\}\)/s) });

    expect(provider.requests).toHaveLength(from);
    expect(ran(bash)).toEqual(commands);
    expect(session.planState!.plannerContextPause).toEqual(pause);
  });
});

describe('the run while the planner is paused on its context', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('goes on: a running task completes on its own evidence and the next one starts', async () => {
    const provider = new FakeProvider([says('Hi.'), ...steps()]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const runner = recordingRunner();
    const tasks = [task('t1', 1), task('t2', 2, { dependencies: ['t1'] })];
    const env = plannerSession(provider, fakeFileSystem({ bash }), { runner, plan: runPlan(tasks) });
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawnedIds()).toEqual(['t1']));
    await env.session.continueConversation('hello');
    env.catalog.windows[MODEL] = provider.requests.at(-1)!.promptTokens * 2;
    env.catalog.maxOutput = 4_096;
    provider.summariesOk = false;

    await env.session.continueConversation('run all the steps');
    expect(env.session.planState!.plannerContextPause).toBeDefined();

    runner.of('t1').reportComplete({ status: 'done', summary: 'built' });
    await vi.waitFor(() => expect(runner.spawnedIds()).toEqual(['t1', 't2']));
    expect(env.session.planTasks.find((t) => t.id === 't1')?.status).toBe('completed');
    expect(env.session.planState!.plannerContextPause).toBeDefined();
  });
});
