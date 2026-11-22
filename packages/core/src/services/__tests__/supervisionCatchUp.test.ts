import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRequest } from '../AiService';
import type { SessionNotice } from '../SessionMessage';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { settleReply } from '../settleReply';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { makeSession, testWorkspace } from './sessionTestKit';
import { changeSettings, ctx, LIMIT, NOW, plan, prose, recordingRunner, RESUME_AT, settled, task, until, waitForInput, wokenUp, type Env } from './supervisorTestKit';

/**
 * A failure that blocks other tasks reaches the supervisor (ADR-0029,
 * ADR-0030, ADR-0057 R4): what happens while supervision has stopped is kept,
 * and raising the level again catches the supervisor up, in one wake.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const fail = (env: Env, id: string) => env.run.of(id).reportComplete({ status: 'failed', summary: '', reason: 'the review found two bugs' });

/** A run whose supervisor stopped: its wake-up turn on task 1 waiting for input failed twice. */
async function stopped(settings: Parameters<typeof wokenUp>[0] = {}): Promise<Env> {
  const env = await wokenUp(settings, [task('t1', 1), task('t2', 2), task('t3', 3, { dependencies: ['t2'] }), task('t4', 4, { dependencies: ['t2'] })]);
  env.planner.calls[0].fail(new Error('API Error: Can\'t reach the API server (EAI_AGAIN)'));
  await until(() => env.planner.calls.length === 2);
  env.planner.calls[1].fail(new Error('API Error: Can\'t reach the API server (EAI_AGAIN)'));
  await settled();
  expect(env.session.planState!.runSettings!.unsupervised).toBeDefined();
  return env;
}

describe('supervision stopped by failed wake-up turns, then raised again by the user', () => {
  it('keeps what happens while stopped, and wakes the supervisor once with it as the level is raised: the failed check and what waits on it', async () => {
    const env = await stopped({ settings: { supervisorLevel: 'act' } });

    fail(env, 't2');
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    expect(env.planner.calls).toHaveLength(2);

    changeSettings(env, { supervisorLevel: 'act' });
    await until(() => env.planner.calls.length === 3);
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);

    expect(env.planner.calls).toHaveLength(3);
    const woken = env.planner.calls[2].message;
    expect(woken).toMatch(/- task #1 "Task t1" is waiting for input/);
    expect(woken).toMatch(/- task #2 "Task t2" failed: .*the review found two bugs; it blocks tasks #3 "Task t3" and #4 "Task t4"/);
    env.planner.calls[2].finish(prose('Retrying task 2.'));
    await settled();
    expect(env.session.planState!.runSettings).toMatchObject({ supervisorLevel: 'act' });
    expect(env.session.planState!.runSettings!.unsupervised).toBeUndefined();
  });
});

const OUTAGE = 'API Error: Can\'t reach the API server (EAI_AGAIN)';

/**
 * A planner whose every call goes through the real reply settling, its
 * provider retries included, and fails as Claude Code does while the network
 * is down, until `back`.
 */
function plannerBehindOutage(back: number) {
  const sent: string[] = [];
  let live = false;
  const answer = (message: string, signal?: AbortSignal) => settleReply({
    message,
    send: async (text) => {
      sent.push(text);
      return Date.now() < back ? { text: '', researchLog: [], failure: OUTAGE } : { text: 'Retrying task 1 with a note.', researchLog: [] };
    },
    onProgress: () => {},
    signal,
  });
  const aiService = {
    startConversation: vi.fn((req: ConversationRequest) => {
      live = true;
      return answer(req.initialMessage ?? req.goal, req.signal);
    }),
    continueConversation: vi.fn((message: string, _progress?: unknown, signal?: AbortSignal) => answer(message, signal)),
    hasActiveConversation: () => live,
    reset: vi.fn(() => { live = false; }),
    restart: vi.fn(),
  };
  return { aiService, sent };
}

describe('a network outage during a wake-up turn (ADR-0018 E1, ADR-0029)', () => {
  it('is waited out: five minutes down and then back leaves supervision running, and the failure reaches the supervisor', async () => {
    const planner = plannerBehindOutage(NOW.getTime() + 5 * 60_000);
    const run = recordingRunner();
    const notices: SessionNotice[] = [];
    const session = makeSession({
      aiService: planner.aiService,
      runner: run.runner,
      onNotice: (n) => notices.push(n),
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act' } }),
    });
    session.loadPlan(plan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]), 'build it', testWorkspace);
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => run.spawnedIds().includes('t1'));

    run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the review found two bugs' });
    await settled();
    for (let minute = 0; minute < 8; minute++) await vi.advanceTimersByTimeAsync(60_000);
    await settled();

    expect(planner.sent.some((text) => /- task #1 "Task t1" failed: .*the review found two bugs; it blocks task #2 "Task t2"/.test(text))).toBe(true);
    expect(session.planState!.runSettings!.unsupervised).toBeUndefined();
    expect(session.planState!.conversationHistory!.at(-1)).toMatchObject({ content: 'Retrying task 1 with a note.' });
    expect(session.planState!.pendingTurns ?? []).toEqual([]);
    expect(notices.some((n) => /The supervisor stopped/.test(n.message))).toBe(false);
  });
});

describe('a planner usage limit after the wake-up turn made its change (ADR-0029, ADR-0044)', () => {
  it('keeps supervision when the reset is known, and what arrives meanwhile goes at the reset', async () => {
    const env = await wokenUp({ config: { aiProvider: 'claude-code' }, settings: { supervisorLevel: 'act' } }, [task('t1', 1), task('t2', 2), task('t3', 3, { dependencies: ['t1'] })]);
    expect((await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 't3', changes: { title: 'Answer t1 first' } }] }, ctx)).isError).toBeFalsy();

    env.planner.calls[0].finish({ kind: 'message', text: LIMIT, researchLog: [], failed: true });
    await settled();

    expect(env.session.planState!.runSettings!.unsupervised).toBeUndefined();
    expect(env.session.planState!.plannerResend).toEqual({ runner: 'claude-code', at: RESUME_AT });
    expect(env.session.planState!.conversationHistory!.at(-1)!.content).toMatch(/^claude-code usage limit, resets .*What the planner changed before it stays, and nothing waits to be sent again; what arrives meanwhile goes at /);

    waitForInput(env.run.of('t2'));
    await settled();
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() - 1000);
    expect(env.planner.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toMatch(/- task #2 "Task t2" is waiting for input/);
    expect(env.planner.calls[1].message).not.toMatch(/- task #1 "Task t1" is waiting for input/);
  });
});
