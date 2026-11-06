import { describe, expect, it, vi } from 'vitest';
import { RUN_SETTINGS_DEFAULTS, type UserSettings } from '../../SettingsService';
import { createWorktreeIsolation } from '../../GitWorktreeIsolation';
import { TaskOrchestrator } from '../../TaskOrchestrator';
import { sessionRuntimeSettings } from '../../createSession';
import { fakeNotification, makeSession, type SessionOverrides } from '../../__tests__/sessionTestKit';
import { createTask, type LegacyPlanState } from '../../../models/Task';
import { FakeExecutionBackend, fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../../testing';
import type { IRunner } from '../../../interfaces/IRunner';

/** The `containers` setting through a real Session: what opts in, and what never falls back to the host. */

/** Every docker command a Session here would run: none reaches an engine, whose answer can take minutes on a CI runner. */
const docker = vi.hoisted(() => ({ calls: [] as (readonly string[])[] }));

vi.mock('../dockerCli', async (actual) => {
  const real = await actual<typeof import('../dockerCli')>();
  class AbsentDockerCli {
    async call(args: readonly string[]) {
      docker.calls.push(args);
      return { code: -1, stdout: '', stderr: 'spawn docker ENOENT' };
    }

    async entry(): Promise<never> {
      throw new Error('spawn docker ENOENT');
    }
  }
  return { ...real, SpawnedDockerCli: AbsentDockerCli };
});

vi.mock('../../GitWorktreeIsolation', async (actual) => {
  const real = await actual<typeof import('../../GitWorktreeIsolation')>();
  return { ...real, createWorktreeIsolation: vi.fn(real.createWorktreeIsolation) };
});

function session(containers?: unknown, execution?: SessionOverrides['execution']) {
  const spawn = vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => new FakeRunnerSession('s1', taskId));
  const stopAll = vi.fn();
  const notifications = fakeNotification();
  const parent = makeSession({
    runner: { spawn, stop: vi.fn(), stopAll, activeCount: 0 },
    ...(execution ? { execution } : {}),
    isolation: new FakeWorktreeIsolation(),
    notifications,
    config: fakeConfig({ maxParallelSessions: 2, aiProvider: 'claude-code' }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, ...(containers !== undefined ? { containers } : {}) }),
  });
  const tasks = [createTask({ id: 'a', order: 1, title: 'A', prompt: 'do a', assignedRunner: 'claude-code' })];
  parent.loadPlan({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState, 'the goal', '/workspace', { sessionId: 'containers-setting' });
  return { parent, spawn, stopAll, notifications };
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
    expect(docker.calls, 'no engine could take it, so none is asked').toEqual([]);
    env.parent.destroy();
  });

  it('reaches a Session from the settings file as it was written', () => {
    const containers = { image: 'mine', login: { kind: 'own-sign-in' } };

    expect(sessionRuntimeSettings({ containers } as UserSettings)).toMatchObject({ containers });
  });
});

describe('the hooks of a session on a container backend (ADR-0059 L6)', () => {
  const compose = (over: Partial<Parameters<typeof TaskOrchestrator.compose>[0]>) => TaskOrchestrator.compose({
    config: fakeConfig(), notifications: fakeNotification(), runner: { spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 }, ...over,
  });

  it('goes as far as the isolation it builds: every git call of a landing is then under it', () => {
    vi.mocked(createWorktreeIsolation).mockClear();

    compose({ execution: (local) => local });

    expect(createWorktreeIsolation).toHaveBeenCalledWith(expect.objectContaining({ noHooks: true }));
  });

  it('leaves a local run its hooks, as they always ran', () => {
    vi.mocked(createWorktreeIsolation).mockClear();

    compose({});

    expect(createWorktreeIsolation).toHaveBeenCalledWith(expect.not.objectContaining({ noHooks: true }));
  });
});

describe('a Session that closes with a run under way', () => {
  it('stops its runners on a flat run, and leaves nothing to wait for once they have gone', async () => {
    const env = session();
    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));

    env.parent.destroy();

    expect(env.stopAll).toHaveBeenCalled();
    expect(env.parent.isExecuting).toBe(false);
    await env.parent.gone;
  });

  it('is gone only once what its backend has running has: a next Session must find nothing of it at work', async () => {
    const backend = new FakeExecutionBackend();
    let done!: () => void;
    backend.settle = vi.fn(() => new Promise<void>((resolve) => { done = resolve; }));
    const env = session(undefined, () => backend);
    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));

    env.parent.destroy();
    let gone = false;
    void env.parent.gone.then(() => { gone = true; });

    expect(env.stopAll).toHaveBeenCalled();
    await vi.waitFor(() => expect(backend.settle).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(gone).toBe(false);

    done();
    await env.parent.gone;
  });
});
