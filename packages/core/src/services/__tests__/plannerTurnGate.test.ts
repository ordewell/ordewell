import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { ConversationTurn } from '../AiService';
import type { IConfig } from '../../interfaces/IConfig';
import { detectInstalledPlanner, recordInstalledPlanner, recordedInstalledPlanner, resetInstalledPlanner } from '../InstalledPlanner';
import { PlannerTurnDiscardedError, PlannerTurnStoppedError } from '../PlannerConversation';
import { PlannerNotReadyError } from '../plannerReadiness';
import { recordRunnerAuth, resetRunnerAuth } from '../runnerAuth';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { SessionMessage } from '../SessionMessage';
import { fakeConfig, makeSession, testWorkspace } from './sessionTestKit';
import { recordingRunner } from './supervisorTestKit';

/**
 * The one gate every planner turn passes before it opens (ADR-0009): it waits
 * for the installed-planner probe, then judges the planner in use at that
 * moment, and a refusal never costs the user the message it held up.
 */

/** No AI_PROVIDER and no vendor key: the planner is whatever the probe records, openrouter until it answers. */
function keylessConfig(): IConfig {
  const config = fakeConfig({ getProviderApiKey: () => '', orchestratorModel: '', planningModel: '' });
  Object.defineProperty(config, 'aiProvider', { get: () => recordedInstalledPlanner() ?? 'openrouter' });
  return config;
}

/** A probe whose answer the test gives: Claude Code is usable or not, every other agent never is. */
function heldProbe() {
  let answer!: (usable: boolean) => void;
  const claude = new Promise<{ usable: boolean }>((resolve) => { answer = (usable) => resolve({ usable }); });
  void detectInstalledPlanner({ plannerUsability: async (runner) => (runner === 'claude-code' ? claude : { usable: false }) });
  return { answer };
}

const prose = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });

/**
 * A planner that records which provider each turn was taken on. Like the real
 * openrouter transport, it throws when asked to plan with no key.
 */
function recordingPlanner(config: IConfig) {
  const providers: string[] = [];
  const aiService = {
    startConversation: vi.fn(),
    hasActiveConversation: () => true,
    continueConversation: vi.fn(async (message: string) => {
      if (config.aiProvider === 'openrouter' && !config.getProviderApiKey('openrouter')) throw new Error('OpenRouter API key not configured');
      providers.push(config.aiProvider);
      return prose(message.includes('<conversation_summary>') ? '<conversation_summary>Built it.</conversation_summary>' : 'Done.');
    }),
    reset: vi.fn(),
  };
  return { aiService, providers };
}

function savedPlan(pending: string[] = []): LegacyPlanState {
  const now = new Date().toISOString();
  return {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', assignedRunner: 'claude-code' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', assignedRunner: 'claude-code' }),
    ],
    generatedAt: now,
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: now,
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-10-11T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-10-11T00:00:01Z', kind: 'plan_generated' },
      { role: 'user', content: 'keep it small', timestamp: '2026-10-11T00:00:02Z' },
      { role: 'assistant', content: 'Noted.', timestamp: '2026-10-11T00:00:03Z' },
      { role: 'user', content: 'and typed', timestamp: '2026-10-11T00:00:04Z' },
      { role: 'assistant', content: 'Noted.', timestamp: '2026-10-11T00:00:05Z' },
    ],
    pendingTurns: pending.map((text, i) => ({ id: `turn-${i + 1}`, source: 'user', text, timestamp: '2026-10-11T00:00:02Z' })),
  };
}

const pendingTexts = (plan: LegacyPlanState | null) => (plan?.pendingTurns ?? []).map((t) => t.text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  resetInstalledPlanner();
  resetRunnerAuth();
});

describe('what a turn at the gate tells the surfaces', () => {
  function session() {
    const config = keylessConfig();
    const { aiService } = recordingPlanner(config);
    const heard: SessionMessage[] = [];
    const held = makeSession({ aiService, config, broadcast: (m) => heard.push(m) });
    held.loadPlan(savedPlan(), 'build it', testWorkspace, { persist: false });
    const told = () => heard.flatMap((m) => (m.type === 'planner_detection' ? [m.waiting ? 'waiting' : 'answered'] : m.type === 'planner_turn_started' ? ['turn'] : []));
    return { held, aiService, told };
  }

  it('says it waits on the probe, and has asked no planner, until the probe answers', async () => {
    const env = session();
    const probe = heldProbe();

    const turn = env.held.continueConversation('next step');
    await settle();

    expect(env.told()).toEqual(['waiting']);
    expect(env.held.plannerDetection()).toEqual({ type: 'planner_detection', waiting: true });
    expect(env.aiService.continueConversation).not.toHaveBeenCalled();

    probe.answer(true);
    await turn;

    expect(env.told()).toEqual(['waiting', 'answered', 'turn']);
    expect(env.held.plannerDetection()).toEqual({ type: 'planner_detection', waiting: false });
  });

  it('says so once for all that wait, and ends with the probe, not with a Stop', async () => {
    const env = session();
    const probe = heldProbe();

    const stop = new AbortController();
    const compacted = env.held.compactConversation(stop.signal).catch((err: unknown) => err);
    await settle();
    stop.abort();
    expect(await compacted).toBeInstanceOf(PlannerTurnStoppedError);
    const reply = env.held.continueConversation('next step');
    await settle();

    expect(env.told()).toEqual(['waiting']);

    probe.answer(true);
    await reply;

    expect(env.told()).toEqual(['waiting', 'answered', 'turn']);
  });

  it('says nothing of a turn the gate lets through at once', async () => {
    recordInstalledPlanner('claude-code');
    const env = session();

    await env.held.continueConversation('next step');

    expect(env.told()).toEqual(['turn']);
  });
});

describe('a restored message', () => {
  it('stays idle when the probe answers, then goes with the next user message', async () => {
    const config = keylessConfig();
    const { aiService, providers } = recordingPlanner(config);
    const probe = heldProbe();
    const session = makeSession({ config, aiService });

    session.loadPlan(savedPlan(['rename task 1']), 'build it', testWorkspace);
    await settle();
    expect(aiService.continueConversation).not.toHaveBeenCalled();
    expect(pendingTexts(session.planState)).toEqual(['rename task 1']);

    probe.answer(true);
    await settle();
    expect(providers).toEqual([]);
    await session.continueConversation('go on');
    await vi.waitFor(() => expect(providers).toEqual(['claude-code']));
    await vi.waitFor(() => expect(pendingTexts(session.planState)).toEqual([]));
  });
});

describe('a restored message', () => {
  it('stays queued silently on load, and reports a missing planner only when the user sends', async () => {
    const config = keylessConfig();
    const { aiService } = recordingPlanner(config);
    const probe = heldProbe();
    const notices: string[] = [];
    const session = makeSession({ config, aiService, onNotice: (n) => notices.push(n.message) });

    session.loadPlan(savedPlan(['rename task 1']), 'build it', testWorkspace);
    probe.answer(false);
    await settle();
    expect(notices).toEqual([]);
    await expect(session.continueConversation('try now')).rejects.toBeInstanceOf(PlannerNotReadyError);
    await vi.waitFor(() => expect(notices.some((n) => n.includes('/planner'))).toBe(true));

    expect(aiService.continueConversation).not.toHaveBeenCalled();
    expect(pendingTexts(session.planState)).toEqual(['rename task 1']);
    expect(notices.join('\n')).toContain('rename task 1');

    recordInstalledPlanner('claude-code');
    await session.continueConversation('and add tests');
    expect(aiService.continueConversation).toHaveBeenCalledTimes(1);
    expect(aiService.continueConversation.mock.calls[0][0]).toMatch(/rename task 1[\s\S]*and add tests/);
    expect(pendingTexts(session.planState)).toEqual([]);
  });

  it('is never answered by a session closed while the probe was out', async () => {
    const config = keylessConfig();
    const { aiService } = recordingPlanner(config);
    const probe = heldProbe();
    const session = makeSession({ config, aiService });

    session.loadPlan(savedPlan(['rename task 1']), 'build it', testWorkspace);
    session.destroy();
    probe.answer(true);
    await settle();
    await settle();

    expect(aiService.continueConversation).not.toHaveBeenCalled();
  });
});

describe('a message sent while the probe is out', () => {
  const sends: [string, (session: ReturnType<typeof makeSession>) => Promise<LegacyPlanState>][] = [
    ['a reply', (s) => s.continueConversation('rename task 1')],
    ['a force send', (s) => s.forceSendPrompt('rename task 1')],
  ];
  for (const [kind, send] of sends) {
    it(`waits for it, then is answered by the agent it finds: ${kind}`, async () => {
      const config = keylessConfig();
      const { aiService, providers } = recordingPlanner(config);
      const probe = heldProbe();
      const session = makeSession({ config, aiService });
      session.loadPlan(savedPlan(), 'build it', testWorkspace);

      const answered = send(session);
      await settle();
      expect(aiService.continueConversation).not.toHaveBeenCalled();
      expect(session.planState!.pendingTurns).toHaveLength(1);

      probe.answer(true);
      await answered;
      expect(providers).toEqual(['claude-code']);
    });
  }

  it('is dropped, unanswered, when its caller stops it before the probe answers', async () => {
    const config = keylessConfig();
    const { aiService } = recordingPlanner(config);
    const probe = heldProbe();
    const session = makeSession({ config, aiService });
    session.loadPlan(savedPlan(), 'build it', testWorkspace);
    const stop = new AbortController();

    const answered = session.continueConversation('rename task 1', { signal: stop.signal });
    stop.abort();
    probe.answer(true);

    await expect(answered).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(aiService.continueConversation).not.toHaveBeenCalled();
    expect(pendingTexts(session.planState)).toEqual([]);
  });

  it('a compaction waits for it, then summarises on the agent it finds', async () => {
    const config = keylessConfig();
    const { aiService, providers } = recordingPlanner(config);
    const probe = heldProbe();
    const session = makeSession({ config, aiService });
    session.loadPlan(savedPlan(), 'build it', testWorkspace);

    const compaction = session.compactConversation();
    await settle();
    expect(aiService.continueConversation).not.toHaveBeenCalled();

    probe.answer(true);
    await compaction;
    expect(providers).toEqual(['claude-code']);
  });
});

describe('after the selected vendor\'s key is taken away', () => {
  function keyedSession() {
    let key = 'sk-or';
    const config = fakeConfig({ aiProvider: 'openrouter', getProviderApiKey: () => key });
    const { aiService } = recordingPlanner(config);
    const notices: string[] = [];
    const session = makeSession({ config, aiService, onNotice: (n) => notices.push(n.message) });
    session.loadPlan(savedPlan(), 'build it', testWorkspace);
    key = '';
    return { session, aiService, notices };
  }

  const sends: [string, (session: ReturnType<typeof makeSession>) => Promise<unknown>][] = [
    ['a reply', (s) => s.continueConversation('rename task 1')],
    ['a force send', (s) => s.forceSendPrompt('rename task 1')],
    ['a compaction', (s) => s.compactConversation()],
  ];
  for (const [kind, send] of sends) {
    it(`refuses ${kind} with the /planner reason before the vendor is called`, async () => {
      const { session, aiService } = keyedSession();

      const refusal = send(session);
      await expect(refusal).rejects.toBeInstanceOf(PlannerNotReadyError);
      await expect(refusal).rejects.toThrow(/\/planner/);

      expect(aiService.continueConversation).not.toHaveBeenCalled();
      // The caller holds its message; nothing of it is left to replay unasked.
      expect(pendingTexts(session.planState)).toEqual([]);
      expect(session.isPlannerBusy).toBe(false);
    });
  }
});

describe('a planner whose agent is signed out', () => {
  const signedOut = { state: 'signed-out' as const, loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' };

  function signedOutSession() {
    const config = keylessConfig();
    recordInstalledPlanner('claude-code');
    const { aiService } = recordingPlanner(config);
    const notices: string[] = [];
    const session = makeSession({ config, aiService, onNotice: (n) => notices.push(n.message) });
    session.loadPlan(savedPlan(['rename task 1']), 'build it', testWorkspace);
    return { session, aiService, notices };
  }

  it('refuses the turn with the login reason, and keeps the message the user held', async () => {
    const { session, aiService, notices } = signedOutSession();
    recordRunnerAuth('claude-code', signedOut, testWorkspace);

    const refusal = session.continueConversation('try now');
    await expect(refusal).rejects.toBeInstanceOf(PlannerNotReadyError);
    await expect(refusal).rejects.toThrow(/Claude Code not logged in\. Sign in with \/login, or run claude auth login and try again\./);

    expect(aiService.continueConversation).not.toHaveBeenCalled();
    expect(pendingTexts(session.planState)).toEqual(['rename task 1']);
    await vi.waitFor(() => expect(notices.join('\n')).toContain('Claude Code not logged in'));
    expect(notices.join('\n')).toContain('rename task 1');
  });

  it('lets a signed-in agent plan as before', async () => {
    const { session, aiService } = signedOutSession();
    recordRunnerAuth('claude-code', { state: 'signed-in', loginCommand: ['claude', 'auth', 'login'] }, testWorkspace);

    await session.continueConversation('try now');

    expect(aiService.continueConversation).toHaveBeenCalledTimes(1);
    expect(pendingTexts(session.planState)).toEqual([]);
  });
});

describe('Stop while a turn waits at the gate', () => {
  /** A draft saved mid-conversation, with the user's answer no turn took before the reload. */
  function draftWithPending(text: string): LegacyPlanState {
    return { ...savedPlan([text]), tasks: [], status: 'draft' };
  }

  /** Autorun on, and a planner that submits a plan for whatever it is asked: the run would start on its own. */
  function autorunning() {
    const config = keylessConfig();
    const runner = recordingRunner();
    const asked: string[] = [];
    const submitted = (): ConversationTurn => ({ kind: 'plan', tasks: [createTask({ id: 'p1', order: 1, title: 'Do it', prompt: 'do it', assignedRunner: 'claude-code' })], text: '1. Do it', researchLog: [] });
    const aiService = {
      startConversation: vi.fn(async () => submitted()),
      hasActiveConversation: () => true,
      continueConversation: vi.fn(async (message: string) => {
        asked.push(message);
        return message.includes('<conversation_summary>') ? prose('<conversation_summary>Built it.</conversation_summary>') : submitted();
      }),
      reset: vi.fn(),
    };
    const session = makeSession({ config, aiService, runner: runner.runner, settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', autorun: true } }) });
    return { session, runner, asked, aiService };
  }

  it('has no live turn to stop after loading, and the probe answering opens no turn or autorun', async () => {
    const env = autorunning();
    const probe = heldProbe();
    env.session.loadPlan(draftWithPending('Postgres'), 'build it', testWorkspace);
    await settle();

    const stopped = env.session.abortPlannerTurn();
    probe.answer(true);
    await settle();
    await settle();

    expect(env.asked).toEqual([]);
    expect(env.runner.spawnedIds()).toEqual([]);
    expect(pendingTexts(env.session.planState)).toEqual(['Postgres']);
    expect(stopped).toBe(false);
  });

  it('tells a caller waiting there that its message was stopped, and a message sent after the Stop goes once the probe answers', async () => {
    const env = autorunning();
    const probe = heldProbe();
    env.session.loadPlan(draftWithPending('Postgres'), 'build it', testWorkspace);
    const before = env.session.continueConversation('and Redis');
    await settle();

    expect(env.session.abortPlannerTurn()).toBe(true);
    await expect(before).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    const after = env.session.continueConversation('use SQLite instead');
    await settle();
    expect(env.asked).toEqual([]);

    probe.answer(true);
    await after;
    expect(env.asked).toHaveLength(1);
    expect(env.asked[0]).toContain('use SQLite instead');
    expect(env.asked[0]).not.toMatch(/Postgres|Redis/);
  });

  it('stops a compaction waiting there at once, and the probe answering later summarises nothing', async () => {
    const env = autorunning();
    const probe = heldProbe();
    env.session.loadPlan(savedPlan(), 'build it', testWorkspace);
    const compaction = env.session.compactConversation();
    await settle();

    expect(env.session.abortPlannerTurn()).toBe(true);
    await expect(compaction).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    probe.answer(true);
    await settle();
    await settle();

    expect(env.asked).toEqual([]);
    expect(env.session.abortPlannerTurn()).toBe(false);
  });

  it('leaves a session destroyed while a compaction waits there to discard it, as before', async () => {
    const env = autorunning();
    const probe = heldProbe();
    env.session.loadPlan(savedPlan(), 'build it', testWorkspace);
    const compaction = env.session.compactConversation();

    env.session.destroy();
    probe.answer(true);

    await expect(compaction).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    expect(env.asked).toEqual([]);
  });
});


describe('a first goal waiting at the gate', () => {
  /** A planner that records every message it is sent, the opening's goal first. */
  function conversing() {
    const config = keylessConfig();
    const asked: string[] = [];
    const aiService = {
      startConversation: vi.fn(async ({ goal }: { goal: string }) => {
        asked.push(goal);
        return prose('Which database?');
      }),
      hasActiveConversation: () => true,
      continueConversation: vi.fn(async (message: string) => {
        asked.push(message);
        return prose('Noted.');
      }),
      reset: vi.fn(),
    };
    const session = makeSession({ config, aiService });
    const userSaid = () => (session.planState?.conversationHistory ?? []).filter((m) => m.role === 'user').map((m) => m.content);
    return { session, asked, aiService, userSaid };
  }

  it('is busy planner work, and a follow-up sent meanwhile is answered after it, in order, without replacing the goal', async () => {
    const env = conversing();
    const probe = heldProbe();

    const opening = env.session.startPlanning('Build an inventory service', ['claude-code']);
    expect(env.session.isPlannerBusy).toBe(true);
    const followUp = env.session.continueConversation('Use Postgres');
    await settle();
    expect(env.asked).toEqual([]);

    probe.answer(true);
    await opening;
    await followUp;

    expect(env.asked[0]).toBe('Build an inventory service');
    expect(env.asked).toHaveLength(2);
    expect(env.asked[1]).toContain('Use Postgres');
    expect(env.userSaid()).toEqual(['Build an inventory service', 'Use Postgres']);
    expect(env.session.currentGoal).toBe('Build an inventory service');
  });

  it('is discarded by a reset meanwhile: no planner call, and the reset session holds no transcript', async () => {
    const env = conversing();
    const probe = heldProbe();

    const opening = env.session.startPlanning('old goal', ['claude-code']);
    const settled = expect(opening).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    env.session.reset();
    await settled;
    probe.answer(true);
    await settle();
    await settle();

    expect(env.aiService.startConversation).not.toHaveBeenCalled();
    expect(env.session.planState).toBeNull();
    expect(env.session.currentGoal).toBe('');
    expect(env.session.isPlannerBusy).toBe(false);
  });

  it('is discarded by a session adopted meanwhile, which keeps its own transcript', async () => {
    const env = conversing();
    const probe = heldProbe();

    const opening = env.session.startPlanning('old goal', ['claude-code']);
    const settled = expect(opening).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    env.session.loadPlan(savedPlan(), 'build it', testWorkspace);
    await settled;
    probe.answer(true);
    await settle();
    await settle();

    expect(env.aiService.startConversation).not.toHaveBeenCalled();
    expect(env.session.currentGoal).toBe('build it');
    expect(env.userSaid()).toEqual(['build it', 'keep it small', 'and typed']);
  });

  it('is discarded by the session closing meanwhile, with what was sent behind it', async () => {
    const env = conversing();
    const probe = heldProbe();

    const opening = env.session.startPlanning('old goal', ['claude-code']);
    const followUp = env.session.continueConversation('Use Postgres');
    env.session.destroy();
    await expect(opening).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    await expect(followUp).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    probe.answer(true);
    await settle();

    expect(env.asked).toEqual([]);
  });

  it('rejects at once when its caller aborts, without waiting for the probe', async () => {
    const env = conversing();
    heldProbe();
    const caller = new AbortController();

    const opening = env.session.startPlanning('ship it', ['claude-code'], { signal: caller.signal });
    caller.abort();

    await expect(opening).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(env.session.isPlannerBusy).toBe(false);
    expect(env.aiService.startConversation).not.toHaveBeenCalled();
  });

  it('is stopped by Stop with the follow-up sent behind it: neither is answered, and a goal sent after the Stop is', async () => {
    const env = conversing();
    const probe = heldProbe();

    const opening = env.session.startPlanning('Build an inventory service', ['claude-code']);
    const followUp = env.session.continueConversation('Use Postgres');
    expect(env.session.abortPlannerTurn()).toBe(true);
    await expect(opening).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    await expect(followUp).rejects.toBeInstanceOf(PlannerTurnStoppedError);

    const after = env.session.startPlanning('Build a ledger', ['claude-code']);
    probe.answer(true);
    await after;
    await settle();

    expect(env.asked).toEqual(['Build a ledger']);
    expect(env.userSaid()).toEqual(['Build a ledger']);
  });

  it('is replaced by an explicit new goal sent meanwhile', async () => {
    const env = conversing();
    const probe = heldProbe();

    const first = env.session.startPlanning('first goal', ['claude-code']);
    const firstSettled = expect(first).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    const second = env.session.startPlanning('second goal', ['claude-code']);
    probe.answer(true);
    await firstSettled;
    await second;

    expect(env.asked).toEqual(['second goal']);
    expect(env.session.currentGoal).toBe('second goal');
  });

  it('a force send meanwhile goes first behind it rather than replacing it', async () => {
    const env = conversing();
    const probe = heldProbe();

    const opening = env.session.startPlanning('Build an inventory service', ['claude-code']);
    const reply = env.session.continueConversation('Use Postgres');
    const forced = env.session.forceSendPrompt('Make it multi-tenant');
    probe.answer(true);
    await Promise.all([opening, reply, forced]);

    expect(env.asked[0]).toBe('Build an inventory service');
    expect(env.asked[1]).toContain('Make it multi-tenant');
    expect(env.asked[1]).not.toContain('Use Postgres');
    expect(env.asked[2]).toContain('Use Postgres');
    expect(env.session.currentGoal).toBe('Build an inventory service');
  });

  it('a follow-up the planner is not ready for is refused with the opening', async () => {
    const env = conversing();
    const probe = heldProbe();

    const opening = env.session.startPlanning('ship it', ['claude-code']);
    const followUp = env.session.continueConversation('Use Postgres');
    probe.answer(false);

    await expect(opening).rejects.toBeInstanceOf(PlannerNotReadyError);
    await expect(followUp).rejects.toBeInstanceOf(PlannerNotReadyError);
    expect(env.asked).toEqual([]);
  });
});
