import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask, type ConversationMessage, type LegacyPlanState } from '../../models/Task';
import * as sessionStore from '../../utils/sessionStore';
import type { ConversationTurn, IAiService } from '../AiService';
import { fromTranscript } from '../../conversation/transcript';
import { makeSession, type SessionOverrides } from './sessionTestKit';

/**
 * A compaction shortens what the planner model is given, never what the
 * session keeps: every case here goes through the real store and reads the
 * session back the way a reopened surface and a replayed planner do.
 */

const GOAL = 'build me a parser';
const at = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}Z`;

function plannedDialogue(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'do it', assignedRunner: 'claude-code' }),
      createTask({ id: 't2', order: 2, title: 'Stream it', prompt: 'do it', assignedRunner: 'claude-code' }),
    ],
    generatedAt: at(0),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: at(0),
    conversationHistory: [
      { role: 'user', content: GOAL, timestamp: at(0) },
      { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: at(2), kind: 'plan_generated' },
      { role: 'user', content: 'U1 use a pull reader', timestamp: at(3) },
      { role: 'assistant', content: 'A1 noted', timestamp: at(5) },
      { role: 'user', content: 'U2 add streaming', timestamp: at(6) },
      { role: 'assistant', content: 'A2 added #2', timestamp: at(7) },
      { role: 'user', content: 'U3 no dependencies', timestamp: at(8) },
      { role: 'assistant', content: 'A3 noted', timestamp: at(10) },
    ],
    researchLog: [
      { id: 'rs-early', timestamp: at(4), tool: 'read_file', args: '{"path":"EARLY.md"}', result: 'early', success: true, outcome: 'success' },
      { id: 'rs-late', timestamp: at(9), tool: 'read_file', args: '{"path":"LATE.md"}', result: 'late', success: true, outcome: 'success' },
    ],
  };
}

const ORIGINALS = plannedDialogue().conversationHistory!.map((m) => m.content);

const reply = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });
const summary = (text: string): ConversationTurn => reply(`<conversation_summary>${text}</conversation_summary>`);

type PlannerFake = Pick<IAiService, 'startConversation' | 'continueConversation' | 'hasActiveConversation' | 'reset'> & Partial<Pick<IAiService, 'conversationMatchesConfig'>>;

/**
 * A vendor API planner: its context is the message list it is rebuilt from.
 * Each start records what was replayed; each summary request records the
 * context it was asked to condense. Summaries come from `summaries` in turn.
 */
function apiStylePlanner(summaries: string[] = ['S1', 'S2', 'S3']) {
  const state = { context: null as string[] | null, replays: [] as string[][], condensed: [] as string[][] };
  const answer = (message: string): ConversationTurn => {
    if (!message.includes('<conversation_summary>')) return reply(`reply to ${message.split('\n').at(-1)}`);
    state.condensed.push(state.context!.slice(0, -1));
    return summary(summaries.shift() ?? 'S?');
  };
  const planner: PlannerFake = {
    startConversation: async (req) => {
      const replayed = (req.priorHistory ?? []).map((m: ConversationMessage) => m.content);
      state.replays.push(replayed);
      state.context = [...replayed, req.initialMessage ?? req.goal];
      return answer(state.context.at(-1)!);
    },
    continueConversation: async (message) => {
      state.context!.push(message);
      return answer(message);
    },
    hasActiveConversation: () => state.context !== null,
    reset: () => { state.context = null; },
  };
  return { planner, state };
}

describe('preserved planner history across compaction', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-history-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const saved = (sessionId = 'session-original') => sessionStore.loadSession(sessionId, workspace)!.plan;

  /** A session adopted from the real store and saving back to it. */
  function adopted(plan: LegacyPlanState, overrides: SessionOverrides = {}, sessionId = 'session-original') {
    sessionStore.saveSession(plan, GOAL, workspace, sessionId);
    const session = makeSession({ saveSession: sessionStore.saveSession, ...overrides });
    session.loadPlan(saved(sessionId), GOAL, workspace, { sessionId });
    return session;
  }

  it('keeps every original message and the research log on disk, with rewind positions and tasks as they were', async () => {
    const { planner } = apiStylePlanner();
    const session = adopted(plannedDialogue(), { aiService: planner });
    const targetsBefore = session.rewindTargets().map(({ index, preview }) => ({ index, preview }));
    const tasksBefore = structuredClone(session.planTasks);

    await session.compactConversation();

    const plan = saved();
    expect(plan.conversationHistory!.map((m) => m.content).slice(0, ORIGINALS.length)).toEqual(ORIGINALS);
    expect(plan.conversationHistory).toHaveLength(ORIGINALS.length + 1);
    expect(plan.conversationHistory!.at(-1)).toMatchObject({ kind: 'compaction', content: expect.stringContaining('S1') });
    expect(plan.researchLog!.map((e) => e.id)).toEqual(['rs-early', 'rs-late']);
    expect(plan.tasks).toEqual(tasksBefore);
    expect(session.rewindTargets().map(({ index, preview }) => ({ index, preview }))).toEqual(targetsBefore);
    session.destroy();
  });

  it('reopens showing everything said and researched, the summary where it was made, and replays only the summary and what it kept', async () => {
    const first = apiStylePlanner();
    const session = adopted(plannedDialogue(), { aiService: first.planner });
    await session.compactConversation();
    session.destroy();

    const plan = saved();
    const view = fromTranscript(plan.conversationHistory, plan.researchLog);
    const drawn = view.blocks.map((b) => (b.type === 'message' ? `${b.role}: ${b.text.split('\n').at(-1)}` : b.type === 'tool' ? `tool: ${b.headline.keyArg}`
      : b.type === 'compaction' ? `compaction: ${b.summary?.split('\n').at(-1)}` : b.type));
    expect(drawn).toEqual([
      `user: ${GOAL}`, 'plan', 'user: U1 use a pull reader', 'tool: EARLY.md', 'planner: A1 noted',
      'user: U2 add streaming', 'planner: A2 added #2', 'user: U3 no dependencies', 'tool: LATE.md', 'planner: A3 noted',
      'compaction: S1',
    ]);

    const { planner, state } = apiStylePlanner();
    const reopened = makeSession({ saveSession: sessionStore.saveSession, aiService: planner });
    reopened.loadPlan(plan, GOAL, workspace, { sessionId: 'session-original' });
    await reopened.continueConversation('U4 add CSV');

    expect(state.replays).toHaveLength(1);
    expect(state.replays[0][0]).toContain('S1');
    expect(state.replays[0].slice(1)).toEqual(['U2 add streaming', 'A2 added #2', 'U3 no dependencies', 'A3 noted']);
    expect(saved().conversationHistory!.slice(0, ORIGINALS.length).map((m) => m.content)).toEqual(ORIGINALS);
    reopened.destroy();
  });

  it('refuses a second compaction that could save nothing, changing nothing', async () => {
    const { planner } = apiStylePlanner();
    const session = adopted(plannedDialogue(), { aiService: planner });
    await session.compactConversation();
    const before = fs.readdirSync(path.join(workspace, '.ordewell', 'sessions')).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(workspace, '.ordewell', 'sessions', f), 'utf-8'));

    await expect(session.compactConversation()).rejects.toThrow(/too short/i);

    const after = fs.readdirSync(path.join(workspace, '.ordewell', 'sessions')).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(workspace, '.ordewell', 'sessions', f), 'utf-8'));
    expect(after).toEqual(before);
    session.destroy();
  });

  it('condenses the condensed context the second time, and replays only the newest summary after it, live or reloaded', async () => {
    const { planner, state } = apiStylePlanner();
    const session = adopted(plannedDialogue(), { aiService: planner });
    await session.compactConversation();
    for (const said of ['U4 add CSV', 'U5 and TSV', 'U6 docs']) await session.continueConversation(said);

    await session.compactConversation();

    // Asked of the live context, which was replayed from the first summary on.
    const condensed = state.condensed[1].join('\n');
    expect(condensed.match(/S1/g)).toHaveLength(1);
    expect(condensed).not.toContain('U1 use a pull reader');
    expect(condensed).not.toContain(GOAL);
    expect(condensed).toContain('U4 add CSV');

    const history = saved().conversationHistory!;
    expect(history.filter((m) => m.kind === 'compaction').map((m) => m.content.split('\n').at(-1))).toEqual(['S1', 'S2']);
    expect(history.slice(0, ORIGINALS.length).map((m) => m.content)).toEqual(ORIGINALS);
    session.destroy();

    const reloaded = apiStylePlanner();
    const reopened = makeSession({ saveSession: sessionStore.saveSession, aiService: reloaded.planner });
    reopened.loadPlan(saved(), GOAL, workspace, { sessionId: 'session-original' });
    await reopened.continueConversation('U7 ship it');
    const [replayed] = reloaded.state.replays;
    expect(replayed[0]).toContain('S2');
    expect(replayed.join('\n')).not.toContain('S1');
    expect(replayed.slice(1).filter((m) => m.startsWith('U') || m.includes('\nU')).map((m) => m.split('\n').at(-1))).toEqual(['U5 and TSV', 'U6 docs']);
    reopened.destroy();
  });

  it('condenses a reloaded conversation by replaying its condensed context, not the originals', async () => {
    const first = apiStylePlanner();
    const session = adopted(plannedDialogue(), { aiService: first.planner });
    await session.compactConversation();
    for (const said of ['U4 add CSV', 'U5 and TSV']) await session.continueConversation(said);
    session.destroy();

    const { planner, state } = apiStylePlanner(['S2']);
    const reopened = makeSession({ saveSession: sessionStore.saveSession, aiService: planner });
    reopened.loadPlan(saved(), GOAL, workspace, { sessionId: 'session-original' });
    await reopened.compactConversation();

    expect(state.replays[0][0]).toContain('S1');
    expect(state.replays[0].join('\n')).not.toContain('U1 use a pull reader');
    expect(state.replays[0].map((m) => m.split('\n').at(-1))).toContain('U4 add CSV');
    reopened.destroy();
  });

  /** The original, compacted twice: the eight originals, S1 at 8, U4..A6, then S2. */
  async function twiceCondensed() {
    const { planner } = apiStylePlanner();
    const session = adopted(plannedDialogue(), { aiService: planner });
    await session.compactConversation();
    for (const said of ['U4 add CSV', 'U5 and TSV', 'U6 docs']) await session.continueConversation(said);
    await session.compactConversation();
    return session;
  }

  /** What the fork's planner is replayed on its first message. */
  async function forkReplay(sessionId: string): Promise<string[]> {
    const { planner, state } = apiStylePlanner();
    const fork = makeSession({ saveSession: sessionStore.saveSession, aiService: planner });
    fork.loadPlan(saved(sessionId), GOAL, workspace, { sessionId, persist: false });
    await fork.continueConversation('next');
    fork.destroy();
    return state.replays[0].map((m) => m.split('\n').at(-1)!);
  }

  it('rewinds before, between and after compactions to a fork replaying that point\'s context, never a later summary', async () => {
    const session = await twiceCondensed();
    const targets = session.rewindTargets();
    expect(targets.map((t) => t.preview)).toEqual(['U1 use a pull reader', 'U2 add streaming', 'U3 no dependencies', 'U4 add CSV', 'U5 and TSV', 'U6 docs']);
    const indexOf = (preview: string) => targets.find((t) => t.preview === preview)!.index;

    const beforeAny = session.rewindConversation(indexOf('U1 use a pull reader'));
    expect(await forkReplay(beforeAny.sessionId)).toEqual([GOAL, 'Plan generated with 1 task.']);

    const between = session.rewindConversation(indexOf('U5 and TSV'));
    const betweenReplay = await forkReplay(between.sessionId);
    expect(betweenReplay[0]).toBe('S1');
    expect(betweenReplay).not.toContain('S2');
    expect(betweenReplay).not.toContain('U1 use a pull reader');
    expect(betweenReplay.slice(1).filter((m) => m.startsWith('U'))).toEqual(['U2 add streaming', 'U3 no dependencies', 'U4 add CSV']);

    const fork = session.forkConversation();
    expect(saved(fork.sessionId).conversationHistory).toEqual(saved().conversationHistory);
    const forkReplayed = await forkReplay(fork.sessionId);
    expect(forkReplayed[0]).toBe('S2');
    expect(forkReplayed).not.toContain('S1');
    expect(forkReplayed.slice(1).filter((m) => m.startsWith('U'))).toEqual(['U5 and TSV', 'U6 docs']);
    session.destroy();
  });

  it('replays the condensed context when a switched planner model reopens the conversation', async () => {
    const { planner, state } = apiStylePlanner();
    const session = adopted(plannedDialogue(), { aiService: planner });
    await session.compactConversation();
    await session.continueConversation('U4 add CSV');
    planner.conversationMatchesConfig = () => false;

    await session.continueConversation('U5 on the new model');

    const replayed = state.replays.at(-1)!.map((m) => m.split('\n').at(-1));
    expect(replayed[0]).toBe('S1');
    expect(replayed).not.toContain('U1 use a pull reader');
    expect(replayed.filter((m) => m!.startsWith('U'))).toEqual(['U2 add streaming', 'U3 no dependencies', 'U4 add CSV']);
    session.destroy();
  });

  it('leaves the saved session byte for byte when the summary turn is stopped or returns no summary', async () => {
    const file = () => fs.readdirSync(path.join(workspace, '.ordewell', 'sessions')).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(workspace, '.ordewell', 'sessions', f), 'utf-8'));
    const controller = new AbortController();
    const { planner, state } = apiStylePlanner();
    const session = adopted(plannedDialogue(), { aiService: planner });
    await session.continueConversation('U4 add CSV');
    const before = file();

    planner.continueConversation = async () => { controller.abort(); return summary('half done'); };
    await expect(session.compactConversation(controller.signal)).rejects.toThrow(/stopped/i);
    expect(file()).toEqual(before);

    state.context = ['live'];
    planner.continueConversation = async () => reply('no tags here');
    await expect(session.compactConversation()).rejects.toThrow(/no summary/i);
    expect(file()).toEqual(before);
    expect(session.isPlannerBusy).toBe(false);
    session.destroy();
  });

  /** A session saved by a build whose compaction replaced the messages it condensed: the summary first, the originals gone. */
  function legacyDialogue(): LegacyPlanState {
    const plan = plannedDialogue();
    plan.conversationHistory = [
      { role: 'assistant', content: 'Conversation condensed: the earlier messages were replaced by the summary below.\n\nS0', timestamp: at(11), kind: 'compaction' },
      ...plan.conversationHistory!.slice(4),
    ];
    return plan;
  }

  it('reads a legacy compaction as before: drawn first without the research it condensed, replayed as the context\'s start', async () => {
    const plan = legacyDialogue();
    const view = fromTranscript(plan.conversationHistory, plan.researchLog);
    expect(view.blocks.map((b) => (b.type === 'message' ? b.text.split('\n').at(-1) : b.type === 'tool' ? b.headline.keyArg : b.type === 'compaction' ? b.summary?.split('\n').at(-1) : b.type))).toEqual([
      'S0', 'U2 add streaming', 'A2 added #2', 'U3 no dependencies', 'LATE.md', 'A3 noted',
    ]);

    const { planner, state } = apiStylePlanner();
    const session = adopted(plan, { aiService: planner });
    expect(session.rewindTargets().map((t) => t.index)).toEqual([1, 3]);
    await session.continueConversation('U4 add CSV');
    expect(state.replays[0].map((m) => m.split('\n').at(-1))).toEqual(['S0', 'U2 add streaming', 'A2 added #2', 'U3 no dependencies', 'A3 noted']);

    await session.compactConversation();
    const history = saved().conversationHistory!;
    expect(history[0].content).toContain('S0');
    expect(history.at(-1)).toMatchObject({ kind: 'compaction', checkpoint: { keptFrom: 3, trigger: 'manual' } });
    session.destroy();

    expect(await forkReplay('session-original')).toEqual(['S1', 'U3 no dependencies', 'A3 noted', 'U4 add CSV', 'reply to U4 add CSV']);
  });

  /** The originals, then a compaction entry as some other build or a hand edit left it, then one more exchange. */
  function withSavedMarker(marker: Record<string, unknown>): LegacyPlanState {
    const plan = plannedDialogue();
    plan.conversationHistory!.push(
      { role: 'assistant', content: 'Conversation condensed.\n\nSX', timestamp: at(11), kind: 'compaction', ...marker } as ConversationMessage,
      { role: 'user', content: 'U4 add CSV', timestamp: at(12) },
      { role: 'assistant', content: 'A4 added', timestamp: at(13) },
    );
    return plan;
  }

  it.each([
    ['no checkpoint (a marker drawn, never replayed)', {}],
    ['a cut past the marker', { checkpoint: { id: 'c1', keptFrom: 9, trigger: 'manual' } }],
    ['a cut that is not an index', { checkpoint: { id: 'c1', keptFrom: '4', trigger: 'manual' } }],
    ['a negative cut', { checkpoint: { id: 'c1', keptFrom: -1, trigger: 'manual' } }],
    ['no id', { checkpoint: { keptFrom: 4, trigger: 'manual' } }],
    ['an unknown trigger', { checkpoint: { id: 'c1', keptFrom: 4, trigger: 'native' } }],
    ['a checkpoint that is not an object', { checkpoint: 4 }],
  ])('replays every message past a saved compaction entry with %s, and shows it all', async (_case, marker) => {
    const plan = withSavedMarker(marker);
    const view = fromTranscript(plan.conversationHistory, plan.researchLog);
    expect(view.blocks.flatMap((b) => (b.type === 'message' ? [b.text] : b.type === 'compaction' ? [b.summary ?? ''] : [])).map((text) => text.split('\n').at(-1))).toEqual([
      GOAL, 'U1 use a pull reader', 'A1 noted', 'U2 add streaming', 'A2 added #2', 'U3 no dependencies', 'A3 noted', 'SX', 'U4 add CSV', 'A4 added',
    ]);

    const { planner, state } = apiStylePlanner();
    const session = adopted(plan, { aiService: planner });
    await session.continueConversation('U5 and TSV');

    expect(state.replays[0]).toEqual([...ORIGINALS, 'U4 add CSV', 'A4 added']);
    session.destroy();
  });

  it('passes over a saved checkpoint that cuts behind the one before it, keeping the earlier one', async () => {
    const plan = withSavedMarker({ checkpoint: { id: 'c1', keptFrom: 6, trigger: 'manual' } });
    plan.conversationHistory!.push({ role: 'assistant', content: 'Conversation condensed.\n\nSY', timestamp: at(14), kind: 'compaction', checkpoint: { id: 'c2', keptFrom: 4, trigger: 'auto' } });
    const { planner, state } = apiStylePlanner();
    const session = adopted(plan, { aiService: planner });

    await session.continueConversation('U5 and TSV');

    expect(state.replays[0].map((m) => m.split('\n').at(-1))).toEqual(['SX', 'U3 no dependencies', 'A3 noted', 'U4 add CSV', 'A4 added']);
    session.destroy();
  });
});
