import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState } from '../../models/Task';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import { makeSession, saves, testWorkspace } from './sessionTestKit';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { WAKE_UP_RATE } from '../LoopGuards';
import { changeSettings, NOW, plan, prose, settled, supervised, task, until, waitForInput, wokenUp } from './supervisorTestKit';

/** Run settings are the user's, read from their settings and applied at once (ADR-0030). */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('run settings', () => {
  it('start a run at the user\'s supervisor level, whatever an older plan saved', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' }, plan: { supervisorLevel: 'off' } as Partial<LegacyPlanState> });

    expect(env.session.planState!.runSettings).toMatchObject({ supervisorLevel: 'act' });
  });

  it('are not read from an older plan, which drops its own copies when it is saved', () => {
    const session = makeSession({});
    const older = { ...plan([task('t1', 1)]), supervisorLevel: 'act', mergeAtGatesAutomatically: true, supervisorRetryLimit: 5, wakeUpReadBudget: 3 };

    session.loadPlan(older, 'build it', testWorkspace);

    const saved = saves(session).mock.calls.at(-1)![0];
    expect(saved).not.toHaveProperty('supervisorLevel');
    expect(saved).not.toHaveProperty('mergeAtGatesAutomatically');
    expect(saved).not.toHaveProperty('supervisorRetryLimit');
    expect(saved).not.toHaveProperty('wakeUpReadBudget');
  });
});

describe('the session\'s own run settings', () => {
  it('starts a run from the values the session opened with, not a file another session changed', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' }, execute: false });

    env.settings.supervisorLevel = 'off';
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(env.session.planState!.runSettings).toMatchObject({ supervisorLevel: 'act' });
  });

  it('gives the session its own copy when it opens, and only a change made here moves it', () => {
    const saved: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act', autorun: true };
    const session = makeSession({ settings: () => ({ run: saved }) });
    expect(session.runSettings()).toMatchObject({ supervisorLevel: 'act', autorun: true });

    // Another surface changes the file: this session already has its values.
    saved.supervisorLevel = 'off';
    saved.autorun = false;

    expect(session.runSettings()).toMatchObject({ supervisorLevel: 'act', autorun: true });

    session.applyRunSettings({ supervisorLevel: 'watch' });

    expect(session.runSettings()).toMatchObject({ supervisorLevel: 'watch', autorun: true });
  });

  it('reopens a saved session from the file, not the copy the window kept for its previous one', () => {
    // Loading a session from history is reopening it after closing (ADR-0030).
    const saved: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'watch', autorun: true };
    const session = makeSession({ settings: () => ({ run: saved }) });
    saved.supervisorLevel = 'act';
    saved.autorun = false;

    session.loadPlan(plan([task('t1', 1)]), 'build it', testWorkspace, { sessionId: 'saved-session', persist: false });

    expect(session.runSettings()).toMatchObject({ supervisorLevel: 'act', autorun: false });
  });

  it('leaves a finished run\'s record and transcript alone when a setting changes before the next run', () => {
    // The next run copies the session's new values, but the saved record of
    // the run that already happened must keep saying what it used.
    const session = makeSession();
    session.loadPlan(plan([task('t1', 1)], { runSettings: {
      supervisorLevel: 'act',
      mergeAtGatesAutomatically: true,
      supervisorRetryLimit: 4,
      wakeUpReadBudget: 7,
    } }), 'build it', testWorkspace);
    const transcript = session.planState!.conversationHistory?.length ?? 0;

    session.applyRunSettings({ mergeAtGatesAutomatically: false, supervisorRetryLimit: 1 });

    expect(session.planState!.runSettings).toMatchObject({ mergeAtGatesAutomatically: true, supervisorRetryLimit: 4 });
    expect(saves(session).mock.calls.at(-1)![0].runSettings).toMatchObject({ mergeAtGatesAutomatically: true, supervisorRetryLimit: 4 });
    expect(session.planState!.conversationHistory).toHaveLength(transcript);
    expect(session.runSettings()).toMatchObject({ mergeAtGatesAutomatically: false, supervisorRetryLimit: 1 });
  });

  it('ignores a field a client sends that is not a run setting', () => {
    const session = makeSession();
    const before = session.runSettings();

    session.applyRunSettings({ notASetting: true } as unknown as Partial<GlobalRunSettings>);

    expect(session.runSettings()).toEqual(before);
  });
});

describe('the Planned-with line', () => {
  it('is on until the user turns it off, and follows their setting as each commit is written, not the run\'s copy', () => {
    const run = { ...RUN_SETTINGS_DEFAULTS };
    const session = makeSession({ settings: () => ({ run }) });
    expect(session.plannedWithTrailer()).toBe(true);

    run.plannedWithTrailer = false;

    expect(session.plannedWithTrailer()).toBe(false);
  });
});

describe('the user\'s command after an automatic lowering', () => {
  it('raises a run a loop guard dropped to Watch back to Act, and the next wake-up may act', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' } });
    for (let i = 0; i <= WAKE_UP_RATE.max; i++) {
      waitForInput(env.run.of('t1'));
      await settled();
      await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
      await until(() => env.planner.calls.length === i + 1);
      env.planner.calls[i].finish(prose('Answered task 1.'));
      await settled();
      if (i < WAKE_UP_RATE.max) await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    }
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('watch');

    changeSettings(env, { supervisorLevel: 'act' });
    await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    waitForInput(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === WAKE_UP_RATE.max + 2);

    // Back at a level its context holds the rules of: a line (ADR-0057 R5).
    expect(env.planner.calls.at(-1)!.message).toMatch(/You are the supervisor at Act now/);
    expect(env.planner.calls.at(-1)!.message).not.toMatch(/At Act you may act/);
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('act');
  });

  it('brings back a supervisor that failed, and the next event wakes it', async () => {
    const env = await wokenUp();
    env.planner.calls[0].finish({ kind: 'message', text: 'Rate limit exceeded', researchLog: [], failed: true });
    await settled();
    expect(env.session.planState!.runSettings!.unsupervised).toBeDefined();

    changeSettings(env, { supervisorLevel: 'watch' });
    env.run.of('t2').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

    await until(() => env.planner.calls.length === 2);
    expect(env.session.planState!.runSettings!.unsupervised).toBeUndefined();
    expect(env.planner.calls[1].message).toMatch(/task #2 "Task t2" failed/);
  });
});
