import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  createSession, createTask, ModelResolver, RunnerRegistry,
  type IRunner, type LegacyPlanState, type Session, type SessionMessage,
} from '@ordewell/core';
import { fakeConfig, fakeFileSystem, FakeRunnerSession } from '@ordewell/core/testing';
import type { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

const RESUME_AT = '2026-10-11T20:11:00.000Z';

describe('task editing route with a task waiting on a usage-limit reset', () => {
  let session: Session;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-11T18:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    session?.destroy();
    vi.useRealTimers();
  });

  it('changing the runner through PUT clears the resume badge and starts on the new runner', async () => {
    const sessions: FakeRunnerSession[] = [];
    const runner = {
      spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
        const spawned = new FakeRunnerSession(`s${sessions.length + 1}`, taskId);
        sessions.push(spawned);
        return spawned;
      }),
      stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
    } satisfies IRunner;
    const config = fakeConfig();
    const registry = new RunnerRegistry();
    const messages: SessionMessage[] = [];
    session = createSession({
      config, registry, runner,
      notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
      workspaceRoot: () => process.cwd(),
      fsAdapter: fakeFileSystem(),
      broadcast: (m) => messages.push(m),
      modelResolver: new ModelResolver(registry, config, { execImpl: async () => ({ stdout: '' }) }),
      settings: () => ({}),
      saveSession: () => {},
      openTaskLog: () => ({ attempt: 1, append() {} }),
    });
    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Build', prompt: 'build it', assignedRunner: 'claude-code' })],
      runners: ['claude-code'], status: 'approved', generatedAt: '2026-10-11T18:00:00Z', lastUpdated: '2026-10-11T18:00:00Z',
    };
    session.loadPlan(plan, 'build it', process.cwd());
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    const limit = "You've hit your session limit · resets 8:10pm (UTC)";
    sessions[0].emitEvent({ type: 'error', message: limit });
    sessions[0].emitOutput(limit);
    sessions[0].emitTurnEnd('failed');
    await vi.waitFor(() => expect(session.planTasks[0].resumeAt).toBe(RESUME_AT));
    const pool = { session: () => session } as unknown as OrchestratorPool;
    const app = new Hono().route('/api/plans', plansRoute(pool));

    const response = await app.request('/api/plans/s1/tasks/t1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignedRunner: 'opencode' }),
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    expect(runner.spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', runner: 'opencode' });
    await vi.advanceTimersByTimeAsync(1000);
    const status = messages.filter((m) => m.type === 'status_update').at(-1)!;
    expect(status.tasks[0].status).toBe('in_progress');
    expect(status.tasks[0].resumeAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 1000);
    expect(sessions).toHaveLength(2);
  });
});
