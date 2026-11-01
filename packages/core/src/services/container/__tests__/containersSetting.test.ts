import { describe, expect, it, vi } from 'vitest';
import { RUN_SETTINGS_DEFAULTS, type UserSettings } from '../../SettingsService';
import { sessionRuntimeSettings } from '../../createSession';
import { fakeNotification, makeSession } from '../../__tests__/sessionTestKit';
import { createTask, type LegacyPlanState } from '../../../models/Task';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../../testing';
import type { IRunner } from '../../../interfaces/IRunner';

/** The `containers` setting through a real Session: what opts in, and what never falls back to the host. */

function session(containers?: unknown) {
  const spawn = vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => new FakeRunnerSession('s1', taskId));
  const notifications = fakeNotification();
  const parent = makeSession({
    runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 },
    isolation: new FakeWorktreeIsolation(),
    notifications,
    config: fakeConfig({ maxParallelSessions: 2, aiProvider: 'claude-code' }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, ...(containers !== undefined ? { containers } : {}) }),
  });
  const tasks = [createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a', assignedRunner: 'claude-code' })];
  parent.loadPlan({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState, 'the goal', '/workspace', { sessionId: 'containers-setting' });
  return { parent, spawn, notifications };
}

describe('the containers setting', () => {
  it('stays out of the way when it is not set: local worktrees are the default (ADR-0059 L4)', async () => {
    const env = session();

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
    expect(env.spawn.mock.calls[0][0].placement).toBeUndefined();
    env.parent.destroy();
  });

  it('refuses a task under a setting it cannot use, and never runs it on the host instead', async () => {
    const env = session('docker');

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(vi.mocked(env.notifications.error).mock.calls.join()).toContain('the containers setting must be an object'));
    expect(env.spawn).not.toHaveBeenCalled();
    env.parent.destroy();
  });

  it('reaches a Session from the settings file as it was written', () => {
    const containers = { image: 'mine', login: { kind: 'own-sign-in' } };

    expect(sessionRuntimeSettings({ containers } as UserSettings)).toMatchObject({ containers });
  });
});
