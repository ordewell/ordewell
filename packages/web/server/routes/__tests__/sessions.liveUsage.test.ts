import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { planUsage, rejoinPlanTree, saveSession, taskUsageSummary, tasksTotalText, type IRunner, type LegacyPlanState, type RunnerSpawnOptions, type Task } from '@ordewell/core';
import { FakeRunnerSession } from '@ordewell/core/testing';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { sessionsRoute } from '../sessions';

function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['claude-code'],
    generatedAt: '2026-10-17T10:00:00.000Z',
    tasks: [
      { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'pending', description: 'd', dependencies: [], assignedRunner: 'claude-code', subtasks: [], prompt: 'do it' },
    ],
  } as unknown as LegacyPlanState;
}

/** What `ordewell status` reads a task's spend from: the plan the route serves, rejoined as the CLI does. */
describe('GET /api/sessions/:id while a failed task is retried', () => {
  let workspace: string;
  let settingsDir: string;
  let savedSettingsPath: string | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-route-liveusage-'));
    mkdirSync(join(workspace, '.git'));
    settingsDir = mkdtempSync(join(tmpdir(), 'ordewell-route-liveusage-settings-'));
    savedSettingsPath = process.env.ORDEWELL_SETTINGS_PATH;
    process.env.ORDEWELL_SETTINGS_PATH = join(settingsDir, 'settings.json');
    // No supervisor: its wake-up turn on the failure would need a planner this test has no use for.
    writeFileSync(process.env.ORDEWELL_SETTINGS_PATH, JSON.stringify({ supervisorLevel: 'off' }));
  });

  afterEach(() => {
    if (savedSettingsPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = savedSettingsPath;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it('serves the retry live with the spend of both attempts, during it and after it is cancelled', async () => {
    const sessions: FakeRunnerSession[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const pool = new OrchestratorPool({ runner });
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-liveusage');
    pool.adoptSavedSession(meta.id, workspace);
    const app = new Hono();
    app.route('/api/sessions', sessionsRoute(pool));
    const served = async (): Promise<Task[]> => {
      const res = await app.request(`/api/sessions/${meta.id}?workspace=${encodeURIComponent(workspace)}`);
      const { plan } = (await res.json()) as { plan: { pendingTasks: Task[]; executionLog?: Task[] } };
      return rejoinPlanTree(plan.pendingTasks, plan.executionLog ?? []);
    };

    try {
      const live = pool.session(meta.id, undefined);
      await live.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(sessions).toHaveLength(1));
      sessions[0].emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'claude-opus-5-5', inputTokens: 100, contextTokens: 61_000, contextWindow: 1_000_000, reportedCost: { amount: 1, currency: 'USD' } } });
      sessions[0].emitExit(1);
      await vi.waitFor(async () => expect((await served())[0].status).toBe('failed'));

      await live.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' });
      await vi.waitFor(() => expect(sessions).toHaveLength(2));
      sessions[1].emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 200, reportedCost: { amount: 2, currency: 'USD' } } });
      const during = await served();
      expect(during[0].status).toBe('in_progress');
      expect(planUsage(during)).toMatchObject({ attempts: 2, totals: { inputTokens: 300, reportedCost: { USD: 3 } } });
      // The counts stay in the ledger the route serves; what is drawn of it is the cost.
      expect(tasksTotalText(during)).toBe('Tasks total: $3.00');
      // The task's meter is served live too, read on the latest attempt, and
      // the run snapshot a reconnecting client receives carries the same ledger.
      expect(taskUsageSummary(during[0]).contextFill).toEqual({ usedTokens: 200 });
      expect(during[0].attemptUsage?.[0] && taskUsageSummary({ attemptUsage: [during[0].attemptUsage[0]] }).contextFill).toEqual({ usedTokens: 61_000, windowTokens: 1_000_000 });
      expect(taskUsageSummary(pool.runSnapshot(meta.id)!.tasks[0]).contextFill).toEqual({ usedTokens: 200 });

      await live.execute({ command: 'stop_task', task: 't1' }, { kind: 'user' });
      const after = await served();
      expect(after[0].status).toBe('pending');
      expect(planUsage(after)).toMatchObject({ attempts: 2, totals: { inputTokens: 300, reportedCost: { USD: 3 } } });
      expect(tasksTotalText(after)).toBe('Tasks total: $3.00');
      expect(taskUsageSummary(after[0]).contextFill).toEqual({ usedTokens: 200 });
      expect(taskUsageSummary(pool.runSnapshot(meta.id)!.tasks[0]).contextFill).toEqual({ usedTokens: 200 });
    } finally {
      pool.destroyAll();
    }
  });
});
