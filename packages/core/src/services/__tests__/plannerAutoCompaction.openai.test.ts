import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IFileSystem, ToolOutcome } from '../../interfaces/IFileSystem';
import type { ConversationMessage, PlannerCompaction } from '../../models/Task';
import type { SessionMessage } from '../SessionMessage';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { createEmptyPlan } from '../../models/Task';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { modelContext } from '../conversationSummary';
import { SUMMARY_LIMITS } from '../contextSummary';

const createSpy = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createSpy } };
  },
}));

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
  tools?: unknown[];
  tool_choice?: unknown;
  max_tokens: number;
}
type Sent = SentRequest & { promptTokens: number };

const SUMMARY = 'The user is mapping the cache layer in src/cache.ts. The build ran with make step0 and passed; the planner noted the eviction rule in src/cache/lru.ts:42 and still has to run the tests.';
const tagged = (text: string) => `<conversation_summary>${text}</conversation_summary>`;

/**
 * An OpenAI-compatible provider at the SDK's create(): it counts a prompt at
 * four characters of its text to a token, refuses one whose prompt and
 * requested reply pass the model's window, and answers a request that offers
 * no tools — a summary call — from its own script, apart from the planner's.
 */
class FakeProvider {
  readonly requests: Sent[] = [];
  readonly summaries: Sent[] = [];
  refusals = 0;
  windows: Record<string, number> = {};
  /** Planner requests answered with a server error, by their index. */
  failAt = new Set<number>();

  constructor(private replies: Array<() => unknown[]>, public summaryReplies: Array<(req: SentRequest) => unknown[]> = []) {}

  static tokensOf(req: SentRequest): number {
    const text = req.messages.map((m) => (m.content ?? '') + JSON.stringify(m.tool_calls ?? '')).join('') + JSON.stringify(req.tools ?? []);
    return Math.ceil(text.length / 4);
  }

  create = (req: SentRequest): AsyncIterable<unknown> => {
    const sent: Sent = { ...req, messages: req.messages.map((m) => ({ ...m })), promptTokens: 0 };
    sent.promptTokens = FakeProvider.tokensOf(sent);
    const isSummary = req.tools === undefined;
    (isSummary ? this.summaries : this.requests).push(sent);
    if (!isSummary && this.failAt.has(this.requests.length - 1)) throw Object.assign(new Error('500 upstream unavailable'), { status: 500 });
    const window = this.windows[req.model];
    if (window !== undefined && sent.promptTokens + req.max_tokens > window) {
      this.refusals++;
      throw Object.assign(new Error(`400 This model's maximum context length is ${window} tokens.`), { status: 400, code: 'context_length_exceeded' });
    }
    const chunks = isSummary
      ? (this.summaryReplies.shift() ?? (() => says(tagged(SUMMARY))()))(sent)
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

const GOAL = 'map the cache';

/** A session on an OpenRouter planner whose window the test sets once it has measured a call. */
function plannerSession(provider: FakeProvider, fs: IFileSystem, opts: { auto?: () => boolean } = {}) {
  createSpy.mockImplementation(provider.create);
  const catalog: { windows: Record<string, number>; maxOutput?: number } = { windows: {} };
  const events: SessionMessage[] = [];
  const config = fakeConfig({ aiProvider: 'openrouter', orchestratorModel: 'vendor/model' });
  const session = makeSession({
    config,
    fsAdapter: fs,
    broadcast: (m) => events.push(m),
    modelResolver: {
      modelsForRunners: vi.fn().mockResolvedValue({}),
      contextWindowFor: (source, model) => (source === 'openrouter' ? catalog.windows[model] : undefined),
      maxOutputTokensFor: (source) => (source === 'openrouter' ? catalog.maxOutput : undefined),
      warmPickerOptions: vi.fn(),
    },
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, plannerAutoCompaction: opts.auto?.() ?? true }),
  });
  session.loadPlan({ ...createEmptyPlan(), conversationHistory: [{ role: 'user', content: GOAL, timestamp: '2026-10-25T09:00:00Z' }] }, GOAL, testWorkspace, { persist: false });
  const compactions = () => events.flatMap((m) => (m.type === 'planner_compaction' ? [{ ...m.compaction, turnId: m.turnId }] : [])) as Array<PlannerCompaction & { turnId?: string }>;
  const turnIds = () => events.flatMap((m) => (m.type === 'planner_turn_started' ? [m.turnId] : []));
  const usage = () => events.filter((m): m is Extract<SessionMessage, { type: 'planner_usage' }> => m.type === 'planner_usage').at(-1);
  return { session, catalog, config, events, compactions, turnIds, usage };
}

const history = (session: { planState: { conversationHistory?: ConversationMessage[] } | null }) => session.planState?.conversationHistory ?? [];
const toolOutputs = (req: SentRequest) => req.messages.filter((m) => m.role === 'tool');

describe('an API planner that cannot prune enough room condenses the history that landed before its turn', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('writes a checkpoint for it mid-turn, with no tools offered to the summary, and sends the same call on the condensed context', async () => {
    const provider = new FakeProvider([
      callsTool('bash_0', 'bash', { command: 'make step0' }), says('Built.'),
      callsTool('bash_1', 'bash', { command: 'make test' }), says('Tested.'),
    ]);
    const bash = vi.fn(async () => out(45_000, 'b'));
    const { session, catalog, events, compactions, turnIds, usage } = plannerSession(provider, fakeFileSystem({ bash }));

    await session.continueConversation('run the build');
    // The window is known from here: roomy enough for one build log beside
    // the conversation, not for two, which pruning cannot touch.
    const window = Math.ceil(provider.requests.at(-1)!.promptTokens * 1.45);
    catalog.windows['vendor/model'] = window;
    catalog.maxOutput = 4_096;
    await session.continueConversation('run the tests');

    expect(bash).toHaveBeenCalledTimes(2);
    expect(provider.refusals).toBe(0);
    // One summary call, offering no tools, on the planner's own model.
    expect(provider.summaries).toHaveLength(1);
    const [summary] = provider.summaries;
    expect(summary.model).toBe('vendor/model');
    expect(summary.tools).toBeUndefined();
    expect(summary.tool_choice).toBeUndefined();
    expect(summary.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(summary.messages[1].content).toContain('make step0');
    expect(summary.max_tokens).toBeLessThanOrEqual(4_096);

    // The call that sends the second build log goes out on the condensed context, the same results once.
    const resent = provider.requests.find((r) => toolOutputs(r).some((m) => m.tool_call_id === 'bash_1'))!;
    expect(pairsValid(resent.messages)).toBe(true);
    expect(toolOutputs(resent).map((m) => m.tool_call_id)).toEqual(['bash_1']);
    expect(resent.messages[1]).toMatchObject({ role: 'assistant', content: expect.stringContaining(SUMMARY) });
    expect(resent.messages.some((m) => (m.content ?? '').includes('b'.repeat(1_000)) && m.tool_call_id === 'bash_0')).toBe(false);
    expect(resent.promptTokens + resent.max_tokens).toBeLessThanOrEqual(window);

    // The transcript keeps everything and gains a checkpoint cutting before the turn's message.
    const transcript = history(session);
    const at = transcript.findIndex((m) => m.kind === 'compaction');
    expect(transcript.map((m) => m.content.slice(0, 13))).toEqual([GOAL, 'run the build', 'Built.', 'run the tests', expect.stringContaining('Conversation'), 'Tested.']);
    expect(transcript[at].checkpoint).toMatchObject({ trigger: 'auto', keptFrom: 3 });
    expect(modelContext(transcript).map((m) => m.content)).toEqual([transcript[at].content, 'run the tests', 'Tested.']);

    // One compaction, announced in the turn, under the checkpoint's id.
    const turnId = turnIds().at(-1);
    expect(compactions().map(({ phase, id, turnId: t, trigger }) => ({ phase, id, turnId: t, trigger }))).toEqual([
      { phase: 'started', id: transcript[at].checkpoint!.id, turnId, trigger: 'auto' },
      { phase: 'ended', id: transcript[at].checkpoint!.id, turnId, trigger: 'auto' },
    ]);
    expect(compactions().at(-1)).toMatchObject({ outcome: 'condensed', origin: 'ordewell' });

    // Its spend is in the totals; the meter never reads it, is cleared with
    // the context it measured, and then reads the planner's own last call.
    const planner = provider.requests.reduce((n, r) => n + r.promptTokens, 0);
    expect(usage()?.totals.inputTokens).toBe(planner + summary.promptTokens);
    const fills = events.filter((m) => m.type === 'planner_usage').map((m) => (m.type === 'planner_usage' ? m.contextFill?.usedTokens : undefined));
    expect(fills).not.toContain(summary.promptTokens + 7);
    expect(fills.slice(-2)).toEqual([undefined, provider.requests.at(-1)!.promptTokens + 7]);
  });

  it('seeds the condensed context with the decision record, the constraint in the user\'s words, then where things are (ADR-0067)', async () => {
    const record = { entries: [{ kind: 'decision', text: 'Evict by least recent use', why: 'the cache is read-heavy' }, { kind: 'constraint', text: 'Never add a runtime dependency.' }] };
    const provider = new FakeProvider([
      callsTool('rec_0', 'record', record), callsTool('bash_0', 'bash', { command: 'make step0' }), says('Built.'),
      callsTool('bash_1', 'bash', { command: 'make test' }), says('Tested.'),
    ]);
    const { session, catalog } = plannerSession(provider, fakeFileSystem({ bash: vi.fn(async () => out(45_000, 'b')) }));

    await session.continueConversation('run the build. Never add a runtime dependency.');
    expect(session.planState?.decisionRecord).toHaveLength(2);
    catalog.windows['vendor/model'] = Math.ceil(provider.requests.at(-1)!.promptTokens * 1.45);
    catalog.maxOutput = 4_096;
    await session.continueConversation('run the tests');

    expect(provider.summaries).toHaveLength(1);
    expect(provider.summaries[0].messages[0].content).toMatch(/restated whole beside your summary/);
    const resent = provider.requests.find((r) => toolOutputs(r).some((m) => m.tool_call_id === 'bash_1'))!;
    expect(resent.messages[1]).toMatchObject({ role: 'assistant', content: expect.stringContaining([
      '<decision_record>',
      'Decisions:',
      '- D1: Evict by least recent use. Why: the cache is read-heavy',
      'Constraints, in the user\'s words:',
      '- C1: "Never add a runtime dependency."',
      '</decision_record>',
      '',
      'Where we are:',
      SUMMARY,
    ].join('\n')) });
    expect(history(session).find((m) => m.kind === 'compaction')?.checkpoint).toMatchObject({ trigger: 'auto', record: 2 });
  });
});

/** Workspace reads of `.ts` files only: the conversation's own opening reads project files, which stay out of it. */
const sources = (chars: number) => vi.fn(async (path: string) => (path.endsWith('.ts') ? out(chars, path[0]) : { success: false, output: '', truncated: false }));

/** The first turn leaves a build log pruning cannot touch, on a window with room for one beside the conversation, not two. */
async function afterOneBuild(provider: FakeProvider, extra: Partial<IFileSystem> = {}) {
  const bash = vi.fn(async () => out(45_000, 'b'));
  const kit = plannerSession(provider, fakeFileSystem({ bash, ...extra }));
  await kit.session.continueConversation('run the build');
  const window = Math.ceil(provider.requests.at(-1)!.promptTokens * 1.45);
  kit.catalog.windows['vendor/model'] = window;
  kit.catalog.maxOutput = 4_096;
  return { ...kit, bash, window };
}

const twoBuilds = () => [
  callsTool('bash_0', 'bash', { command: 'make step0' }), says('Built.'),
  callsTool('bash_1', 'bash', { command: 'make test' }), says('Tested.'),
];

describe('an API planner whose pruning makes room', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('prunes alone, with no summary and nothing written, and says so once as a pruning', async () => {
    const provider = new FakeProvider([
      callsTool('read_0', 'read_file', { path: 'a.ts' }), says('Read.'),
      callsTool('read_1', 'read_file', { path: 'r.ts' }), says('Read.'),
    ]);
    const { session, catalog, compactions, turnIds } = plannerSession(provider, fakeFileSystem({ readFile: sources(45_000) }));
    await session.continueConversation('read a.ts');
    catalog.windows['vendor/model'] = Math.ceil(provider.requests.at(-1)!.promptTokens * 1.45);
    catalog.maxOutput = 4_096;
    await session.continueConversation('read r.ts');

    expect(provider.summaries).toHaveLength(0);
    const sent = provider.requests.find((r) => toolOutputs(r).some((m) => m.tool_call_id === 'read_1'))!;
    expect(toolOutputs(sent).find((m) => m.tool_call_id === 'read_0')?.content).toContain('read_file output pruned');
    expect(toolOutputs(sent).find((m) => m.tool_call_id === 'read_1')?.content).toHaveLength(45_000);
    expect(compactions()).toEqual([expect.objectContaining({ phase: 'ended', outcome: 'pruned', origin: 'ordewell', trigger: 'auto', turnId: turnIds().at(-1) })]);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
  });
});

describe('what a landed-history checkpoint keeps', () => {
  beforeEach(() => { createSpy.mockReset(); });

  const paste = `please keep this log in mind: ${'L'.repeat(120_000)}`;

  it('keeps the newest exchanges that fit beside the turn as they replay, and cuts at the oldest of them', async () => {
    const provider = new FakeProvider([says('Noted the log.'), says('Noted: no dependencies.'), callsTool('bash_0', 'bash', { command: 'make test' }), says('Tested.')]);
    const { session, catalog } = plannerSession(provider, fakeFileSystem({ bash: async () => out(45_000, 'b') }));
    await session.continueConversation(paste);
    await session.continueConversation('keep it dependency-free');
    catalog.windows['vendor/model'] = Math.ceil(provider.requests.at(-1)!.promptTokens * 1.3);
    catalog.maxOutput = 4_096;
    await session.continueConversation('run the tests');

    expect(provider.summaries).toHaveLength(1);
    expect(provider.summaries[0].messages[1].content).toContain('L'.repeat(1_000));
    const transcript = history(session);
    const checkpoint = transcript.find((m) => m.kind === 'compaction')!.checkpoint!;
    expect(checkpoint.keptFrom).toBe(transcript.findIndex((m) => m.content === 'keep it dependency-free'));
    const resent = provider.requests.find((r) => toolOutputs(r).some((m) => m.tool_call_id === 'bash_0'))!;
    expect(resent.messages.slice(1, 4).map((m) => [m.role, m.content])).toEqual([
      ['assistant', expect.stringContaining(SUMMARY)],
      ['user', 'keep it dependency-free'],
      ['assistant', 'Noted: no dependencies.'],
    ]);
    expect(resent.messages.some((m) => (m.content ?? '').includes('L'.repeat(1_000)))).toBe(false);
    expect(pairsValid(resent.messages)).toBe(true);
  });

  it('keeps no exchange too large to fit, however recent: the summary stands for it, and the cut is the turn\'s own message', async () => {
    const provider = new FakeProvider([says('Noted the log.'), callsTool('bash_0', 'bash', { command: 'make test' }), says('Tested.')]);
    const { session, catalog } = plannerSession(provider, fakeFileSystem({ bash: async () => out(45_000, 'b') }));
    await session.continueConversation(paste);
    catalog.windows['vendor/model'] = Math.ceil(provider.requests.at(-1)!.promptTokens * 1.3);
    catalog.maxOutput = 4_096;
    await session.continueConversation('run the tests');

    const transcript = history(session);
    expect(transcript.find((m) => m.kind === 'compaction')!.checkpoint!.keptFrom).toBe(transcript.findIndex((m) => m.content === 'run the tests'));
    const resent = provider.requests.find((r) => toolOutputs(r).some((m) => m.tool_call_id === 'bash_0'))!;
    expect(resent.messages.some((m) => (m.content ?? '').includes('L'.repeat(1_000)))).toBe(false);
    expect(resent.messages[1]).toMatchObject({ role: 'assistant', content: expect.stringContaining(SUMMARY) });
  });

  it('condenses the first summary with what followed it the second time, and the model context holds only the newest', async () => {
    const provider = new FakeProvider([...twoBuilds(), callsTool('bash_2', 'bash', { command: 'make lint' }), says('Linted.')], [
      says(tagged(SUMMARY)),
      says(tagged('The user is mapping the cache layer in src/cache.ts; the build and the tests passed (make step0, make test), and lint is what is left to run.')),
    ]);
    const { session } = await afterOneBuild(provider);
    await session.continueConversation('run the tests');
    await session.continueConversation('run the linter');

    expect(provider.summaries).toHaveLength(2);
    const second = provider.summaries[1].messages[1].content!;
    expect(second).toContain(SUMMARY);
    expect(second).toContain('make test');
    expect(second).not.toContain('b'.repeat(46_000));
    const transcript = history(session);
    const checkpoints = transcript.filter((m) => m.kind === 'compaction');
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[1].checkpoint!.keptFrom).toBe(transcript.findIndex((m) => m.content === 'run the linter'));
    expect(modelContext(transcript).map((m) => m.content)).toEqual([checkpoints[1].content, 'run the linter', 'Linted.']);
  });
});

describe('a checkpoint written during a turn', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('stays valid when the turn then fails, its message not landed, and a replay of the conversation opens with it', async () => {
    const provider = new FakeProvider(twoBuilds());
    const { session } = await afterOneBuild(provider);
    // The call after the condensing — the one sending the second build log — fails.
    provider.failAt.add(provider.requests.length + 1);

    await expect(session.continueConversation('run the tests')).rejects.toThrow('500 upstream unavailable');
    const transcript = history(session);
    expect(transcript.map((m) => m.kind ?? m.content)).toEqual([GOAL, 'run the build', 'Built.', 'compaction']);
    expect(transcript[3].checkpoint!.keptFrom).toBe(3);
    expect(modelContext(transcript)).toEqual([transcript[3]]);

    // Reloaded, the conversation replays the summary alone, then the new message.
    const later = new FakeProvider([says('Picking up.')]);
    createSpy.mockImplementation(later.create);
    const reloaded = makeSession({ config: fakeConfig({ aiProvider: 'openrouter', orchestratorModel: 'vendor/model' }) });
    reloaded.loadPlan(structuredClone(session.planState!), GOAL, testWorkspace, { persist: false });
    await reloaded.continueConversation('where were we?');
    expect(later.requests[0].messages.slice(1).map((m) => [m.role, m.content?.slice(0, 40)])).toEqual([
      ['assistant', transcript[3].content.slice(0, 40)],
      ['user', expect.any(String)],
    ]);
    expect(later.requests[0].messages.at(-1)!.content).toContain('where were we?');
  });
});

describe('a planner provider switched after an automatic checkpoint', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('replays the checkpoint\'s projection to the new provider: its summary, then what it kept', async () => {
    const provider = new FakeProvider(twoBuilds());
    const { session, config } = await afterOneBuild(provider);
    await session.continueConversation('run the tests');
    const checkpoint = history(session).find((m) => m.kind === 'compaction')!;

    const sent: Array<{ contents: Array<{ role: string; parts: Array<{ text?: string }> }> }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      const reply = { candidates: [{ content: { role: 'model', parts: [{ text: 'Picking up.' }] }, finishReason: 'STOP' }] };
      return new Response(`data: ${JSON.stringify(reply)}\r\n\r\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    try {
      Object.assign(config, { aiProvider: 'google', apiKey: 'gem-key', orchestratorModel: 'gemini:g-model' });
      await session.continueConversation('where were we?');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(sent).toHaveLength(1);
    const texts = sent[0].contents.map((c) => [c.role, c.parts.map((p) => p.text ?? '').join('')]);
    expect(texts.slice(1)).toEqual([
      ['model', checkpoint.content],
      ['user', 'run the tests'],
      ['model', 'Tested.'],
      ['user', expect.stringContaining('where were we?')],
    ]);
    expect(texts.some(([, text]) => text.includes('b'.repeat(1_000)))).toBe(false);
  });
});

describe('an API planner turn that fills the window by itself', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('condenses its own older rounds in the live context only, listing every command it ran so none runs again', async () => {
    const steps = 6;
    const provider = new FakeProvider([
      says('Hi.'),
      ...Array.from({ length: steps }, (_, i) => callsTool(`bash_${i}`, 'bash', { command: `make step${i}` })),
      says('All steps done.'),
    ]);
    const bash = vi.fn(async () => out(20_000, 's'));
    const { session, catalog, compactions, turnIds } = plannerSession(provider, fakeFileSystem({ bash }));
    await session.continueConversation('hello');
    const window = provider.requests.at(-1)!.promptTokens * 2;
    catalog.windows['vendor/model'] = window;
    catalog.maxOutput = 4_096;
    await session.continueConversation('run all the steps');

    expect(bash).toHaveBeenCalledTimes(steps);
    expect(provider.refusals).toBe(0);
    expect(provider.summaries.length).toBeGreaterThanOrEqual(2);
    for (const summary of provider.summaries) expect(summary.messages[0].content).toContain('current turn');
    const turn = provider.requests.slice(2);
    for (const req of turn) {
      expect(pairsValid(req.messages)).toBe(true);
      expect(req.promptTokens + req.max_tokens).toBeLessThanOrEqual(window);
      // The user's message stays whole in every call of its turn.
      expect(req.messages.filter((m) => m.role === 'user' && (m.content ?? '').includes('run all the steps'))).toHaveLength(1);
    }
    const last = provider.requests.at(-1)!;
    const note = last.messages.find((m) => (m.content ?? '').startsWith('[Context note from Ordewell]'))!.content!;
    const listed = [...note.matchAll(/^- bash\(\{"command":"make (step\d)"\}\) → s+/gm)].map((m) => m[1]);
    const shown = toolOutputs(last).map((m) => m.tool_call_id);
    // Every command ran once, and is either listed as done or still shown as it returned — never both, never neither.
    expect([...listed, ...shown.map((id) => `step${id!.slice(5)}`)].sort()).toEqual(Array.from({ length: steps }, (_, i) => `step${i}`));
    expect(new Set(listed).size).toBe(listed.length);
    // The transcript is not where a turn's own rounds are condensed.
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
    expect(compactions().filter((c) => c.phase === 'ended').every((c) => c.outcome === 'condensed' && c.turnId === turnIds().at(-1))).toBe(true);
  });

  it('answers a call its condensed rounds already made with what that call returned, never running it again', async () => {
    const steps = 6;
    const provider = new FakeProvider([
      says('Hi.'),
      ...Array.from({ length: steps }, (_, i) => callsTool(`bash_${i}`, 'bash', { command: `make step${i}` })),
      // A model that asks for the first command again, whatever the note tells it.
      callsTool('bash_again', 'bash', { command: 'make step0' }),
      says('All steps done.'),
    ]);
    const bash = vi.fn(async (command: string) => out(20_000, command === 'make step0' ? 'a' : 's'));
    const { session, catalog, events } = plannerSession(provider, fakeFileSystem({ bash }));
    await session.continueConversation('hello');
    catalog.windows['vendor/model'] = provider.requests.at(-1)!.promptTokens * 2;
    catalog.maxOutput = 4_096;
    await session.continueConversation('run all the steps');

    expect(bash.mock.calls.map(([command]) => command)).toEqual(Array.from({ length: steps }, (_, i) => `make step${i}`));
    const asked = provider.requests.findIndex((r) => r.messages.some((m) => m.tool_calls?.some((c) => c.id === 'bash_again')));
    // It was condensed out of the context the model asked from: listed in the note, its result no longer shown.
    const before = provider.requests[asked - 1];
    expect(before.messages.find((m) => (m.content ?? '').startsWith('[Context note from Ordewell]'))!.content).toMatch(/^- bash\(\{"command":"make step0"\}\) → a+…$/m);
    expect(toolOutputs(before).some((m) => m.tool_call_id === 'bash_0')).toBe(false);
    const answer = toolOutputs(provider.requests[asked]).find((m) => m.tool_call_id === 'bash_again')!.content!;
    expect(answer).toMatch(/^Not run again: this exact call already ran earlier in this turn/);
    expect(answer).toMatch(/a{100}/);
    for (const req of provider.requests) expect(pairsValid(req.messages)).toBe(true);
    const step = events.flatMap((m) => (m.type === 'research_step_done' ? [m] : [])).find((m) => m.step?.toolCallId === 'bash_again');
    expect(step?.step).toMatchObject({ outcome: 'not_executed', success: false });
    expect(history(session).at(-1)).toMatchObject({ content: 'All steps done.' });
  });
});

describe('a turn whose condensed rounds made many calls that changed something', () => {
  beforeEach(() => { createSpy.mockReset(); });

  /** Long enough that each listed call is a long line of the note. */
  const FLAGS = Array.from({ length: 20 }, (_, i) => `--define=FEATURE_${i}=on`).join(' ');

  /** One reply asking for `n` commands at once. */
  const callsCommands = (round: number, n: number) => () => [{
    choices: [{
      delta: { tool_calls: Array.from({ length: n }, (_, i) => ({ index: i, id: `bash_${round}_${i}`, function: { name: 'bash', arguments: JSON.stringify({ command: `make step${round} part${i} ${FLAGS}` }) } })) },
      finish_reason: 'tool_calls',
    }],
  }];

  it('holds the call it condensed for on a model nothing has measured when its estimate still says it cannot fit, rather than sending it to be refused', async () => {
    const rounds = 10;
    const perRound = 8;
    const provider = new FakeProvider([
      says('Hi.'),
      ...Array.from({ length: rounds }, (_, r) => callsCommands(r, perRound)),
      says('All steps done.'),
    ]);
    const bash = vi.fn(async (_command: string) => out(1_500, 's'));
    const { session, catalog, config } = plannerSession(provider, fakeFileSystem({ bash }));
    await session.continueConversation('hello');
    const window = provider.requests.at(-1)!.promptTokens * 2;
    catalog.windows['vendor/model'] = 1_000_000;
    catalog.windows['vendor/small'] = window;
    provider.windows['vendor/small'] = window;
    catalog.maxOutput = 4_096;
    const switchAt = provider.requests.length + 6;
    createSpy.mockImplementation((req: SentRequest) => {
      // The user picks a smaller model, never called yet, six rounds into the turn.
      if (provider.requests.length === switchAt) (config as { orchestratorModel: string }).orchestratorModel = 'vendor/small';
      return provider.create(req);
    });
    await session.continueConversation('run all the steps');

    expect(provider.refusals).toBe(0);
    for (const req of provider.requests.filter((r) => r.model === 'vendor/small')) expect(req.promptTokens + req.max_tokens).toBeLessThanOrEqual(window);
    const pause = session.planState!.plannerContextPause!;
    expect(pause.reason).toMatch(/even after pruning older file reads and condensing the conversation/);
    // Every command ran once, and the pause lists what ran for a recovery to carry.
    const commands = bash.mock.calls.map(([command]) => command);
    expect(new Set(commands).size).toBe(commands.length);
    expect(pause.done!.length).toBeGreaterThan(0);
    expect(pause.done!.every((line) => line.startsWith('- bash('))).toBe(true);
  });
});

describe('a summary that cannot stand in for what it condensed', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it.each([
    ['carries no tags', says('Here is the summary: the build passed and the tests are next.')],
    ['is trivially short', says(tagged('Build fine.'))],
    ['was cut off before its closing tag', says('<conversation_summary>The user is mapping the cache layer and the build', 'length')],
    ['is reported cut off by its output limit, closing tag or not', says(tagged(SUMMARY), 'length')],
    ['does not condense what it was given', (req: SentRequest) => says(tagged(req.messages[1].content!))()],
    ['declines', says(tagged('I cannot summarize this conversation because it contains a large build log without context for me.'))],
  ])('is refused when it %s: nothing is written, and a call that cannot fit is held, its tools not run again', async (_label, reply) => {
    const provider = new FakeProvider(twoBuilds(), [reply as (req: SentRequest) => unknown[]]);
    const { session, catalog, bash, compactions } = await afterOneBuild(provider);
    const before = structuredClone(history(session));

    await session.continueConversation('run the tests');
    expect(session.planState!.plannerContextPause!.reason).toMatch(/no summary could be had/);
    expect(history(session).slice(0, before.length)).toEqual(before);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
    expect(compactions().map((c) => (c.phase === 'ended' ? c.outcome : c.phase))).toEqual(['started', 'paused']);
    expect(bash).toHaveBeenCalledTimes(2);

    // A model with room takes the held results once, on the user's retry.
    catalog.windows['vendor/model'] = 1_000_000;
    await session.retryPlannerCompaction();
    const next = provider.requests.at(-1)!;
    expect(pairsValid(next.messages)).toBe(true);
    expect(toolOutputs(next).map((m) => m.tool_call_id)).toEqual(['bash_0', 'bash_1']);
    expect(bash).toHaveBeenCalledTimes(2);
  });

  it('is refused when the planner model changed while it was written, and the summary of the old model is not committed', async () => {
    const during: { summary?: () => void } = {};
    const provider = new FakeProvider(twoBuilds(), [() => { during.summary?.(); return says(tagged(SUMMARY))(); }]);
    const { session, config } = await afterOneBuild(provider);
    during.summary = () => { (config as { orchestratorModel: string }).orchestratorModel = 'vendor/other'; };

    await session.continueConversation('run the tests');
    expect(session.planState!.plannerContextPause).toBeDefined();
    expect(provider.summaries.map((r) => r.model)).toEqual(['vendor/model']);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
  });
});

describe('a planner turn stopped while its context is condensed', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('commits no summary that arrives after the stop, keeps the results it was sending, and runs nothing again', async () => {
    const during: { summary?: () => void } = {};
    const provider = new FakeProvider(twoBuilds(), [() => { during.summary?.(); return says(tagged(SUMMARY))(); }]);
    const { session, catalog, bash, compactions } = await afterOneBuild(provider);
    during.summary = () => { session.abortPlannerTurn(); };

    await expect(session.continueConversation('run the tests')).rejects.toThrow(/stopped/i);
    expect(provider.summaries).toHaveLength(1);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
    expect(compactions().at(-1)).toMatchObject({ phase: 'ended', outcome: 'stopped' });

    // With no window to budget on, the next message shows the live context as the stop left it.
    catalog.windows = {};
    await session.continueConversation('never mind');
    const next = provider.requests.at(-1)!;
    expect(pairsValid(next.messages)).toBe(true);
    expect(toolOutputs(next).find((m) => m.tool_call_id === 'bash_1')?.content).toBe('b'.repeat(45_000));
    expect(bash).toHaveBeenCalledTimes(2);
  });
});

describe('a planner turn abandoned while its context is condensed', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('ends the compaction it announced, before the turn\'s end, so no surface joining later is told it still runs', async () => {
    const during: { summary?: () => void } = {};
    const provider = new FakeProvider(twoBuilds(), [() => { during.summary?.(); return says(tagged(SUMMARY))(); }]);
    const { session, events } = await afterOneBuild(provider);
    // A new plan is adopted while the summary is being written: the turn is let go, its stream muted.
    during.summary = () => session.loadPlan({ ...createEmptyPlan(), conversationHistory: [] }, 'another goal', testWorkspace, { persist: false });

    await session.continueConversation('run the tests').catch(() => {});

    const turnId = events.flatMap((m) => (m.type === 'planner_turn_started' ? [m.turnId] : [])).at(-1);
    const told = events.flatMap((m) => (m.type === 'planner_compaction' && m.turnId === turnId ? [m.compaction.phase === 'ended' ? m.compaction.outcome : 'started']
      : m.type === 'planner_turn_ended' && m.turnId === turnId ? ['turn ended'] : []));
    expect(told).toEqual(['started', 'stopped', 'turn ended']);
    expect(session.plannerCompaction()).toBeUndefined();
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
  });
});

describe('the summary of a context too long for one summary call', () => {
  beforeEach(() => { createSpy.mockReset(); });

  /** Three build logs on a large model, then the planner moved to a small one. */
  async function bigThenSmall(provider: FakeProvider, small: (base: number) => number) {
    const bash = vi.fn(async (command: string) => out(command.includes('final') ? 4_000 : 45_000, 'b'));
    const kit = plannerSession(provider, fakeFileSystem({ bash }));
    kit.catalog.windows['vendor/model'] = 1_000_000;
    kit.catalog.maxOutput = 4_096;
    for (const step of ['one', 'two', 'three']) await kit.session.continueConversation(`build ${step}`);
    const base = provider.requests[0].promptTokens;
    const window = small(base);
    kit.catalog.windows['vendor/small'] = window;
    (kit.config as { orchestratorModel: string }).orchestratorModel = 'vendor/small';
    provider.windows['vendor/small'] = window;
    return { ...kit, bash, window };
  }

  const builds = () => ['one', 'two', 'three'].flatMap((step, i) => [callsTool(`bash_${i}`, 'bash', { command: `make ${step}` }), says(`Built ${step}.`)]);

  it('folds it part by part into the summary so far, each call within the window, then commits the whole', async () => {
    const provider = new FakeProvider([...builds(), callsTool('bash_f', 'bash', { command: 'make final' }), says('Done.')]);
    const { session, window } = await bigThenSmall(provider, (base) => base + 16_000);
    await session.continueConversation('build final');

    expect(provider.refusals).toBe(0);
    expect(provider.summaries.length).toBeGreaterThanOrEqual(2);
    expect(provider.summaries.length).toBeLessThanOrEqual(SUMMARY_LIMITS.maxPasses);
    for (const summary of provider.summaries) {
      expect(summary.model).toBe('vendor/small');
      expect(summary.promptTokens + summary.max_tokens).toBeLessThanOrEqual(window);
    }
    expect(provider.summaries[0].messages[1].content).not.toContain('<summary_so_far>');
    for (const later of provider.summaries.slice(1)) expect(later.messages[1].content).toContain(`<summary_so_far>\n${SUMMARY}\n</summary_so_far>`);
    expect(history(session).filter((m) => m.kind === 'compaction')).toHaveLength(1);
    expect(provider.requests.at(-1)!.model).toBe('vendor/small');
  });

  it('makes no call at all when it would take more than its bounded number of passes, and pauses with nothing written', async () => {
    const provider = new FakeProvider(builds());
    const { session, compactions } = await bigThenSmall(provider, () => 6_000);

    await session.continueConversation('build final');
    // The window is smaller than the planner's own instructions: no summary of the conversation could make room.
    expect(session.planState!.plannerContextPause!.reason).toMatch(/^vendor\/small's window is too small for the planner's own instructions and tools/);
    expect(provider.summaries).toHaveLength(0);
    // vendor/small was never measured, so another model's ratio could not hold the call: the provider's refusal of it measured the model.
    expect(provider.refusals).toBe(1);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
    expect(compactions().at(-1)).toMatchObject({ phase: 'ended', outcome: 'paused' });
  });
});

describe('/compact on an API planner', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it('is written by one call that offers no tools, so nothing the summary says can run one', async () => {
    const provider = new FakeProvider([says('One.'), says('Two.'), says('Three.')], [
      () => [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'sneaky', function: { name: 'bash', arguments: '{"command":"rm -rf build"}' } }] } }] },
        ...says(tagged(SUMMARY))(),
      ],
    ]);
    const bash = vi.fn(async () => out(10, 'b'));
    const { session } = plannerSession(provider, fakeFileSystem({ bash }));
    for (const text of ['first', 'second', 'third']) await session.continueConversation(text);
    const calls = provider.requests.length;

    const compaction = await session.compactConversation();

    expect(compaction.summary).toBe(SUMMARY);
    expect(provider.requests).toHaveLength(calls);
    expect(provider.summaries).toHaveLength(1);
    expect(provider.summaries[0].tools).toBeUndefined();
    expect(provider.summaries[0].messages[1].content).toContain('second');
    expect(bash).not.toHaveBeenCalled();
    const transcript = history(session);
    expect(transcript.at(-1)!.checkpoint).toMatchObject({ trigger: 'manual', keptFrom: transcript.findIndex((m) => m.content === 'second') });

    // The next message replays the projection: the summary, then the two kept exchanges.
    await session.continueConversation('fourth');
    expect(provider.requests.at(-1)!.messages.slice(1).map((m) => m.content)).toEqual([
      transcript.at(-1)!.content, 'second', 'Two.', 'third', 'Three.', expect.stringContaining('fourth'),
    ]);
  });
});

describe('an API planner that does not condense', () => {
  beforeEach(() => { createSpy.mockReset(); });

  it.each([
    ['its model\'s window is unknown', () => true, false],
    ['the config file turns automatic compaction off', () => false, true],
  ])('writes no summary when %s', async (_label, auto, known) => {
    const provider = new FakeProvider(twoBuilds());
    const bash = vi.fn(async () => out(45_000, 'b'));
    const { session, catalog } = plannerSession(provider, fakeFileSystem({ bash }), { auto });
    await session.continueConversation('run the build');
    if (known) catalog.windows['vendor/model'] = Math.ceil(provider.requests.at(-1)!.promptTokens * 1.45);
    await session.continueConversation('run the tests');

    expect(provider.summaries).toHaveLength(0);
    expect(history(session).some((m) => m.kind === 'compaction')).toBe(false);
  });
});
