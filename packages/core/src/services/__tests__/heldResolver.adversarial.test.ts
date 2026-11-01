import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { LEASE_STALE_MS, LeaseHost, SessionHeldError } from '../sessionLease';
import { saveSession } from '../../utils/sessionStore';
import { fakeConfig, makeSession, taskOf } from './sessionTestKit';
import { heldPlanner, recordingRunner, settled, until } from './supervisorTestKit';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

/**
 * The held-start refusal is in the command seam, so the start paths beside it
 * are not refused at all (ADR-0049). Resolving a conflict as a task is one: it
 * adds an approved task to the plan and starts it. On a session another host
 * holds, it must refuse like any start, not add a task this host cannot run
 * and will not save, and answer a surface with a plan.
 */
describe('a held session does not resolve a conflict as a task', () => {
  it('refuses before adding the resolver task', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-held-resolver-')));
    const host = new LeaseHost();
    const taker = new LeaseHost({ now: () => Date.now() + 2 * LEASE_STALE_MS });
    const isolation = new FakeWorktreeIsolation();
    isolation.outcomes.set('t1', 'conflict');
    isolation.conflictFiles.set('t1', ['a.ts']);
    const run = recordingRunner();
    const session = makeSession({
      config: fakeConfig({ worktreeIsolation: true, maxParallelSessions: 3, conflictRepairAttempts: 0 }),
      saveSession, leaseHost: host, isolation, runner: run.runner,
      aiService: heldPlanner().aiService,
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
      workspaceRoot: () => workspace,
      sessionId: 'root',
    });
    try {
      const now = new Date().toISOString();
      const plan: LegacyPlanState = { tasks: [createTask({ id: 't1', order: 1, title: 'Task t1', prompt: 'do t1' })], generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
      session.loadPlan(plan, 'goal', workspace, { sessionId: 'root' });
      await session.execute({ command: 'run_plan' }, { kind: 'user' });
      await until(() => run.spawnedIds().includes('t1'));
      run.of('t1').reportComplete({ status: 'done', summary: '' });
      await until(() => taskOf(session, 't1')?.status === 'awaiting_user');
      await settled();

      // Another host took the tree after judging this process gone (ADR-0049).
      taker.lease(() => undefined).claim('root', workspace);
      expect(session.heldElsewhere()?.holder.hostId).toBe(taker.id);
      const before = session.planTasks.map((t) => t.id);

      await expect(session.resolveConflictAsTask('t1')).rejects.toBeInstanceOf(SessionHeldError);
      expect(session.planTasks.map((t) => t.id)).toEqual(before);
    } finally {
      taker.releaseAll();
      host.releaseAll();
      session.destroy();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
