import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IRunner } from '../../../interfaces/IRunner';
import { createTask, type LegacyPlanState, type Task } from '../../../models/Task';
import { fakeConfig, FakeExecutionBackend, FakeRunnerSession, FakeWorktreeIsolation } from '../../../testing';
import { fakeFs, fakeNotification, makeSession } from '../../__tests__/sessionTestKit';
import type { RunnerLaunch, RunnerPlacement } from '../../executionLease';
import { ScriptRunner } from '../../ScriptRunner';
import { RUN_SETTINGS_DEFAULTS } from '../../SettingsService';

/** What an attempt does with a lease that runs it elsewhere, through a real Session and a fake backend: nothing here needs an engine. */

function placement() {
  const asked: RunnerLaunch[] = [];
  const lease: RunnerPlacement = {
    place: vi.fn(async (launch: RunnerLaunch) => {
      asked.push(launch);
      return { command: process.execPath, args: ['-e', ''], env: {}, stop: vi.fn(), ended: vi.fn() };
    }),
    reach: async (url) => url,
    blob: vi.fn(async () => 'c0ffee'.repeat(6) + 'c0ff'),
  };
  return { asked, lease };
}

const states: string[] = [];
afterEach(() => { for (const dir of states.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

function session(tasks: Task[], { runner }: { runner?: IRunner } = {}) {
  const state = mkdtempSync(join(realpathSync(tmpdir()), 'ordewell-lease-attempts-'));
  states.push(state);
  const backend = new FakeExecutionBackend();
  const { asked, lease } = placement();
  backend.placement = lease;
  const parent = makeSession({
    ...(runner ? { runner } : {}),
    // The fake lease's folders are on no disk, and all that starts there is a client of what runs elsewhere.
    scriptRunner: new ScriptRunner({ isDirectory: () => true, spawn: (file, args, options) => spawn(file, args, { ...options, cwd: state }) }),
    isolation: new FakeWorktreeIsolation(),
    notifications: fakeNotification(),
    fsAdapter: fakeFs(),
    config: fakeConfig({ maxParallelSessions: 2, aiProvider: 'claude-code' }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 1_000_000 } }),
    delegationOffered: true,
    execution: () => backend,
    workspaceRoot: () => state,
  });
  parent.loadPlan({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState, 'the goal', state, { sessionId: 'lease-attempts' });
  return { parent, asked, lease, backend };
}

const script = (over: Partial<Task> = {}) => createTask({ id: 's', order: 1, title: 'Test it', type: 'script', commands: [['npm', 'test']], ...over });

describe('a script task under a lease that runs it elsewhere (ADR-0059 L5)', () => {
  it('takes the lease\'s placement, and asks for a container by its role', async () => {
    const env = session([script()]);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(env.asked).toEqual([{ command: 'npm', args: ['test'], env: {}, files: [] }]));
    expect(env.backend.requests.map(({ role }) => role)).toContain('script');
    env.parent.destroy();
  });

  it('needs no seal for a read-only script: its container is one, and a host with none does not fail it', async () => {
    const env = session([script({ readOnly: true })]);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(env.asked).toHaveLength(1));
    expect(env.parent.planTasks[0].verdict?.reason ?? '').not.toContain('sealed');
    env.parent.destroy();
  });

  it('passes on the exit status of what ran there', async () => {
    const env = session([script()]);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(env.parent.planTasks[0].status).toBe('completed'));
    env.parent.destroy();
  });
});

describe('a board pin from an attempt its lease runs elsewhere (ADR-0057 R9)', () => {
  it('reads the file through the lease: its worktree on this host holds what it was seeded with', async () => {
    const said: string[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async (opts) => {
        const running = new FakeRunnerSession('s1', opts.taskId);
        setTimeout(() => {
          void opts.post!({ type: 'claim', title: 'a.txt holds what I wrote', files: ['a.txt'] }).then(({ text }: { text: string }) => {
            said.push(text);
            running.reportComplete({ status: 'done', summary: 'Done.' } as never);
          });
        }, 1);
        return running;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const delegated = createTask({ id: 'd', order: 2, title: 'Delegated', type: 'delegated', goal: 'x', budget: { tokens: 1000 }, assignedRunner: 'claude-code', dependencies: ['t'] });
    const check = createTask({ id: 'c', order: 3, title: 'Check', prompt: 'read', dependencies: ['d'], assignedRunner: 'claude-code' });
    const env = session([createTask({ id: 't', order: 1, title: 'Write a', prompt: 'write', assignedRunner: 'claude-code' }), delegated, check], { runner });

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(said).toHaveLength(1));
    expect(said[0]).toContain('Posted');
    expect(env.lease.blob).toHaveBeenCalledWith('a.txt');
    env.parent.destroy();
  });
});
