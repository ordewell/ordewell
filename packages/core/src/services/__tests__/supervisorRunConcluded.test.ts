import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupervisorLevel } from '../../models/Execution';
import type { SessionMessage } from '../SessionMessage';
import { WAKE_UP_RATE } from '../LoopGuards';
import { CLOSING_TURN_BOUND_MS, WAKE_DEBOUNCE_MS } from '../Supervisor';
import { PlannerContextExhaustedError } from '../plannerContextBudget';
import { START_HOLD_TIMEOUT_MS } from '../PlanTurns';
import { changeSettings, ctx, LIMIT, NOW, plan, prose, RESUME_AT, settled, supervised, task, until, waitForInput, type Env } from './supervisorTestKit';

/**
 * `run_concluded` (ADR-0029): the run's end as a follower that cannot answer
 * it reads it. `execution_complete` says the run ended; at Act the
 * supervisor's closing turn may continue it, so the end stands only once that
 * turn is over.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const ends = (env: Env) => env.messages.filter((m) => m.type === 'execution_complete' || m.type === 'run_concluded').map((m) => m.type);
const concluded = (env: Env) => env.messages.filter((m): m is Extract<SessionMessage, { type: 'run_concluded' }> => m.type === 'run_concluded');

async function failedRun(level: SupervisorLevel, options: Parameters<typeof supervised>[1] = {}): Promise<Env> {
  const env = await supervised([task('t1', 1)], { ...options, settings: { supervisorLevel: level } });
  env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
  await until(() => env.messages.some((m) => m.type === 'execution_complete'));
  return env;
}

describe('a run concluded at Act', () => {
  it('waits for the closing turn, and follows the run it continued to its next end', async () => {
    const env = await failedRun('act');
    await until(() => env.planner.calls.length === 1);
    expect(ends(env)).toEqual(['execution_complete']);

    expect((await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'fix the import' }, ctx)).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Retried task 1.'));
    await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);
    await settled();
    expect(ends(env)).toEqual(['execution_complete']);

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish(prose('Task 1 passed; the run is done.'));
    await until(() => concluded(env).length > 0);

    expect(ends(env)).toEqual(['execution_complete', 'execution_complete', 'run_concluded']);
    expect(concluded(env)[0].summary).toMatchObject({ total: 1, completed: 1, failed: 0, blocked: 0 });
  });

  it('concludes after a closing turn that changed nothing, with the failure standing', async () => {
    const env = await failedRun('act');
    await until(() => env.planner.calls.length === 1);

    env.planner.calls[0].finish(prose('Task 1 needs you: the import is wrong.'));
    await until(() => concluded(env).length > 0);

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    expect(concluded(env)[0].summary).toMatchObject({ total: 1, completed: 0, failed: 1 });
  });
});

describe('a closing turn that failed, whose retry the planner gate refused', () => {
  it('concludes with the supervisor stopped, saying why', async () => {
    const env = await failedRun('act');
    await until(() => env.planner.calls.length === 1);
    // The spend cap is met between the closing turn and its retry: the gate refuses every turn.
    vi.spyOn(env.session, 'assertPlannerReady').mockImplementation(() => {
      throw new Error('the spend cap is met');
    });
    env.planner.calls[0].fail(new Error('planner exited with code 1'));
    await until(() => concluded(env).length > 0);

    expect(env.planner.calls).toHaveLength(1);
    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    expect(env.notices).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: expect.stringMatching(/^The supervisor stopped: its wake-up turn failed, and its retry was refused \(the spend cap is met\)\./),
    }));
  });
});

describe('a closing turn that failed, whose retry rode with a user\'s message', () => {
  it('concludes once that turn answered both', async () => {
    const env = await failedRun('act');
    await until(() => env.planner.calls.length === 1);
    // Another client sends a message while the closing turn runs.
    const answered = env.session.continueConversation('how is it going?');
    await settled();
    env.planner.calls[0].fail(new Error('planner exited with code 1'));
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toContain('how is it going?');
    expect(env.planner.calls[1].message).toContain('the import is wrong');

    env.planner.calls[1].finish(prose('Task 1 failed: the import is wrong.'));
    await answered;
    await until(() => concluded(env).length > 0);

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    expect(concluded(env)[0].summary).toMatchObject({ total: 1, completed: 0, failed: 1 });
  });
});

describe.each(['watch', 'off'] as const)('a run concluded at %s', (level) => {
  it('concludes as the run ends: no turn may continue it', async () => {
    const env = await failedRun(level);

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
  });
});

describe('a closing turn that failed, whose retry the user stopped', () => {
  it('concludes: the Stop dropped the retry, so none is owed', async () => {
    const env = await failedRun('act');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].fail(new Error('planner exited with code 1'));
    await until(() => env.planner.calls.length === 2);

    env.session.abortPlannerTurn();
    await vi.advanceTimersByTimeAsync(40 * 60_000);

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    expect(env.planner.calls).toHaveLength(2);
  });
});

/**
 * Every way the closing turn's wait can end (ADR-0029): each concludes the
 * run, once, with no turn of the supervisor's in flight or owed.
 */
describe('the closing turn\'s wait at Act ends on every path', () => {
  /** A failed run at Act whose closing turn is in flight. */
  async function closing(options: Parameters<typeof supervised>[1] = {}): Promise<Env> {
    const env = await failedRun('act', options);
    await until(() => env.planner.calls.length === 1);
    expect(ends(env)).toEqual(['execution_complete']);
    return env;
  }

  it('concludes when the user stops the closing turn on its first attempt', async () => {
    const env = await closing();

    expect(env.session.abortPlannerTurn()).toBe(true);
    await until(() => concluded(env).length > 0);

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(env.planner.calls).toHaveLength(1);
  });

  it('concludes when its retry is stopped, and a later failed turn is tried twice again', async () => {
    const env = await closing();
    env.planner.calls[0].fail(new Error('planner exited with code 1'));
    await until(() => env.planner.calls.length === 2);
    env.session.abortPlannerTurn();
    await until(() => concluded(env).length > 0);

    // The Stop ended the streak: the next run's failed closing turn is retried, not the second strike.
    expect(await env.session.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'fix the import' }, { kind: 'user' })).toMatchObject({ ok: true });
    await until(() => env.run.spawnedIds().length === 2);
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'still wrong' });
    await until(() => env.planner.calls.length === 3);
    env.planner.calls[2].fail(new Error('planner exited with code 1'));
    await until(() => env.planner.calls.length === 4);
    expect(env.session.planState!.runSettings?.unsupervised).toBeUndefined();
    env.planner.calls[3].finish(prose('Task 1 needs you.'));
    await until(() => concluded(env).length === 2);
  });

  it('concludes when the plan is replaced, which discards the closing turn', async () => {
    const env = await closing();

    env.session.loadPlan(plan([task('n1', 1)], { status: 'draft' }), 'something else', process.cwd());
    await settled();

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    expect(concluded(env)[0].summary).toMatchObject({ total: 1, failed: 1 });
  });

  it('concludes when the session closes during the wait', async () => {
    const env = await closing();

    env.session.destroy();
    await settled();

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
  });

  it('concludes, unsupervised, when the planner cannot be restarted for the retry', async () => {
    const env = await closing();
    env.planner.aiService.restart.mockImplementation(() => { throw new Error('the planner binary is gone'); });

    env.planner.calls[0].fail(new Error('planner exited with code 1'));
    await until(() => concluded(env).length > 0);

    expect(env.planner.calls).toHaveLength(1);
    expect(env.session.planState!.runSettings?.unsupervised).toMatch(/could not be restarted \(the planner binary is gone\)/);
    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
  });

  it('concludes, unsupervised, when the retry fails too', async () => {
    const env = await closing();
    env.planner.calls[0].fail(new Error('planner exited with code 1'));
    await until(() => env.planner.calls.length === 2);
    expect(ends(env)).toEqual(['execution_complete']);

    env.planner.calls[1].fail(new Error('planner exited with code 1'));
    await until(() => concluded(env).length > 0);

    expect(env.session.planState!.runSettings?.unsupervised).toMatch(/failed twice/);
    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
  });

  it('concludes within the bound when the planner backend never answers, even a Stop', async () => {
    const env = await closing();
    env.planner.state.ignoresStop = true;

    await vi.advanceTimersByTimeAsync(CLOSING_TURN_BOUND_MS);

    expect(env.planner.calls).toHaveLength(2);
    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    expect(env.session.planState!.runSettings?.unsupervised).toMatch(/failed twice/);
  });

  // The finished run keeps the level it ran at (ADR-0030): the turn already
  // open goes on at Act, and the wait ends with it.
  it.each(['watch', 'off'] as const)('concludes with the closing turn when the user sets the supervisor to %s during the wait', async (level) => {
    const env = await closing();

    changeSettings(env, { supervisorLevel: level });
    await settled();
    expect(ends(env)).toEqual(['execution_complete']);

    env.planner.calls[0].finish(prose('Noted.'));
    await until(() => concluded(env).length > 0);
    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
  });

  it('concludes, saying why, when the closing turn hits the planner\'s usage limit, not hours later at its reset', async () => {
    const env = await closing({ config: { aiProvider: 'claude-code' } });

    env.planner.calls[0].finish({ kind: 'message', text: LIMIT, researchLog: [], failed: true });
    await until(() => concluded(env).length > 0);

    expect(Date.now()).toBeLessThan(Date.parse(RESUME_AT));
    expect(env.session.planState!.plannerResend).toBeDefined();
    expect(concluded(env)[0].supervisorHeld).toMatch(/usage limit/);
    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
  });

  it('concludes, saying why, when the closing turn pauses the planner on its context', async () => {
    const env = await closing();

    env.planner.calls[0].fail(new PlannerContextExhaustedError('m', true, { done: [] }));
    await until(() => concluded(env).length > 0);

    expect(env.session.planState!.plannerContextPause).toBeDefined();
    expect(concluded(env)[0].supervisorHeld).toMatch(/paused on its context/);
  });

  it('concludes once the closing turn is over, with a user\'s message that arrived meanwhile still being answered', async () => {
    const env = await closing();
    const answered = env.session.continueConversation('how is it going?');
    await settled();

    env.planner.calls[0].finish(prose('Task 1 needs you.'));
    await until(() => env.planner.calls.length === 2);
    await until(() => concluded(env).length > 0);
    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);

    env.planner.calls[1].finish(prose('It ended with task 1 failed.'));
    await answered;
    expect(concluded(env)).toHaveLength(1);
  });

  it('concludes when the wake-up rate guard drops the closing turn to Watch', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' } });
    for (let i = 0; i < WAKE_UP_RATE.max; i++) {
      waitForInput(env.run.of('t1'));
      await settled();
      await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
      await until(() => env.planner.calls.length === i + 1);
      env.planner.calls[i].finish(prose('Answered task 1.'));
      await settled();
      await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    }

    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
    await until(() => env.planner.calls.length === WAKE_UP_RATE.max + 1);

    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('watch');
    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
  });
});

describe('a user\'s planner turn in flight as the run ends at Act', () => {
  it('concludes, saying why, when the user stops their turn: the closing turn waits for their next message', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' } });
    const answered = env.session.continueConversation('how is it going?').catch(() => {});
    await until(() => env.planner.calls.length === 1);
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
    // The user's turn holds new starts, and so the run's end, until its hold times out.
    await vi.advanceTimersByTimeAsync(START_HOLD_TIMEOUT_MS + 10);
    await until(() => env.messages.some((m) => m.type === 'execution_complete'));
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS + 10);
    expect(env.session.planState!.pendingTurns!.some((t) => t.source === 'supervisor')).toBe(true);

    env.session.abortPlannerTurn();
    await answered;
    await until(() => concluded(env).length > 0);

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    expect(concluded(env)[0].supervisorHeld).toMatch(/stopped.*next message/);
    // Kept as decided (ADR-0029): the Stop opens no turn, and the closing input goes with the user's next message.
    expect(env.planner.calls).toHaveLength(1);
    void env.session.continueConversation('carry on').catch(() => {});
    await until(() => env.planner.calls.length === 2);
    expect(concluded(env)).toHaveLength(1);
  });
});

describe('a user\'s Stop earlier in the run, behind which a wake-up waits, at Act', () => {
  /**
   * Tasks 1 and 2 run together, and task 3 needs task 1; task 1 fails during a
   * user's turn, and the user stops that turn, so task 1's wake-up waits for
   * their next message.
   */
  async function stoppedMidRun(): Promise<Env> {
    const env = await supervised([task('t1', 1), task('t2', 2), task('t3', 3, { dependencies: ['t1'] })], { settings: { supervisorLevel: 'act' }, config: { maxParallelSessions: 2 } });
    await until(() => env.run.spawnedIds().length === 2);
    const answered = env.session.continueConversation('how is it going?').catch(() => {});
    await until(() => env.planner.calls.length === 1);
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS + 10);
    expect(env.session.planState!.pendingTurns!.some((t) => t.source === 'supervisor')).toBe(true);

    env.session.abortPlannerTurn();
    await answered;
    await settled();
    expect(env.planner.calls).toHaveLength(1);
    return env;
  }

  it('waits for the closing turn the run\'s end owes, which carries the wake-up the Stop left waiting', async () => {
    const env = await stoppedMidRun();

    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => env.messages.some((m) => m.type === 'execution_complete'));
    await settled();
    expect(ends(env)).toEqual(['execution_complete']);

    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS + 10);
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toContain('the import is wrong');
    expect(ends(env)).toEqual(['execution_complete']);

    env.planner.calls[1].finish(prose('Task 1 needs you: the import is wrong.'));
    await until(() => concluded(env).length > 0);
    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    expect(concluded(env)[0].supervisorHeld).toBeUndefined();
  });

  it('concludes, saying why, when nothing is owed at the run\'s end: the wake-ups the user\'s Stop left go with their next message', async () => {
    const env = await stoppedMidRun();
    // The user's next message takes task 1's wake-up; the run ends during it, and the user stops that turn too.
    const asked = env.session.continueConversation('and now?').catch(() => {});
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toContain('the import is wrong');
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await vi.advanceTimersByTimeAsync(START_HOLD_TIMEOUT_MS + 10);
    await until(() => env.messages.some((m) => m.type === 'execution_complete'));
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS + 10);
    expect(env.session.planState!.pendingTurns!.some((t) => t.source === 'supervisor')).toBe(true);
    expect(ends(env)).toEqual(['execution_complete']);

    env.session.abortPlannerTurn();
    await asked;
    await until(() => concluded(env).length > 0);

    expect(ends(env)).toEqual(['execution_complete', 'run_concluded']);
    expect(concluded(env)[0].supervisorHeld).toMatch(/stopped.*next message/);
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(env.planner.calls).toHaveLength(2);
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(1);
  });
});
