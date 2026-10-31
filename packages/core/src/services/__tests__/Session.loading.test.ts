import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSession, saves, taskOf, testWorkspace } from './sessionTestKit';
import { heldPlanner, NOW, plan, prose, recordingRunner, RESUME_AT, supervised, task, until } from './supervisorTestKit';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => { vi.useRealTimers(); });

describe('loading a session spends no tokens', () => {
  it.each([RESUME_AT, new Date(NOW.getTime() - 60_000).toISOString()])('keeps tasks paused when their saved reset is %s', async (resumeAt) => {
    const planner = heldPlanner();
    const run = recordingRunner();
    const session = makeSession({
      runner: run.runner, aiService: planner.aiService,
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, autorun: true, supervisorLevel: 'act', mergeAtGatesAutomatically: true } }),
    });
    const saved = plan([task('parent', 1, { type: 'user', subtasks: [{ ...task('t1', 1),
      status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt, runnerSessionId: 'native-saved',
    }] })]);
    session.loadPlan(saved, 'build it', testWorkspace, { sessionId: 'saved-session' });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(run.runner.spawn).not.toHaveBeenCalled();
    expect(planner.aiService.startConversation).not.toHaveBeenCalled();
    expect(planner.aiService.continueConversation).not.toHaveBeenCalled();
    expect(taskOf(session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit', runnerSessionId: 'native-saved' });
    expect(taskOf(session, 't1')!.resumeAt).toBeUndefined();
    expect(saves(session).mock.calls.at(-1)![3]).toBe('saved-session');

    expect(await session.execute({ command: 'retry_task', task: 't1', from: 'session' }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(run.runner.spawn).toHaveBeenCalledTimes(1);
    expect(run.runner.spawn.mock.calls[0][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'native-saved' });
    session.destroy();
  });

  it('keeps a saved supervisor debounce idle until new work is requested', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' } });
    env.run.of('t1').waitForInput();
    await until(() => (env.session.planState!.supervision?.wake?.policy.attention.length ?? 0) > 0);
    const saved = structuredClone(env.session.planState!);
    expect(saved.supervision!.wake!.policy.attention.length).toBeGreaterThan(0);
    env.session.destroy();

    const planner = heldPlanner();
    const run = recordingRunner();
    const session = makeSession({ aiService: planner.aiService, runner: run.runner });
    session.loadPlan(saved, 'build it', testWorkspace);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(planner.calls).toHaveLength(0);
    expect(run.runner.spawn).not.toHaveBeenCalled();
    expect(session.planState!.supervision?.wake?.policy.attention).toEqual([]);
    expect(session.planState!.pendingTurns).toEqual([expect.objectContaining({ source: 'supervisor', text: expect.stringContaining('waiting for input') })]);

    const sent = session.continueConversation('what happened?');
    await until(() => planner.calls.length === 1);
    expect(JSON.stringify(planner.calls[0])).toContain('waiting for input');
    planner.calls[0].finish(prose('The previous task failed.'));
    await sent;
    expect(session.planState!.pendingTurns ?? []).toEqual([]);
    session.destroy();
  });
});
