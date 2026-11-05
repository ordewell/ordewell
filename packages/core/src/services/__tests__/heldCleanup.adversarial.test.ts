import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { EventStore } from '../eventStore';
import type { LegacyPlanState } from '../../models/Task';
import type { TreeFact } from '../../models/TreeEvent';
import { rootAuthority } from '../Mandate';
import { LEASE_STALE_MS, LeaseHost, SessionHeldError } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { fakeConfig, makeSession } from './sessionTestKit';
import { heldPlanner, settled } from './supervisorTestKit';
import { saveSession } from '../../utils/sessionStore';
import { removeDir } from '../../testing';

/**
 * A held session may not save anything (ADR-0049): `cleanupRun` discards its
 * children before the guarded isolation refuses, and closing a child's budget
 * node is a write to the tree's event log. The line lands in the holder's log,
 * where a restart reads it as that child having closed.
 */

describe('a held session\'s cleanup', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('writes no tree event before the isolation refuses it', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-held-cleanup-')));
    const host = new LeaseHost();
    const taker = new LeaseHost({ now: () => Date.now() + 2 * LEASE_STALE_MS });
    const appended: TreeFact[] = [];
    const store: EventStore = {
      append: async (events) => { appended.push(...events); },
      read: async function* () { /* a fresh log */ },
      close: async () => undefined,
    };
    const session = makeSession({
      config: fakeConfig({ worktreeIsolation: true }),
      aiService: heldPlanner().aiService,
      leaseHost: host,
      saveSession,
      workspaceRoot: () => workspace,
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' as const, delegationTokens: 100_000 } }),
      eventLog: () => store,
    });
    try {
      session.loadPlan(planWithChild(workspace), 'goal', workspace, { sessionId: 'root' });
      await settled();
      const ledger = await session.ledger();
      const mandate = rootAuthority(() => ({ autorun: false, autonomous: false, delegationTokens: 100_000, runners: ['claude-code'], models: {} })).mandate('off');
      const carved = ledger.carve('root', mandate, { level: 1, tokens: 5000, depth: 1, delegatedTasks: 1, tasksPerPlan: 10 }, { sessionId: 'child-x', taskId: 'd' });
      expect(carved.ok).toBe(true);

      taker.lease(() => undefined).claim('root', workspace);
      host.beat();
      expect(session.heldElsewhere()?.holder.hostId).toBe(taker.id);

      const before = appended.length;
      await expect(session.cleanupRun()).rejects.toBeInstanceOf(SessionHeldError);
      await settled();
      expect(appended.slice(before).filter((event) => event.kind === 'node_closed')).toEqual([]);
    } finally {
      taker.releaseAll();
      host.releaseAll();
      session.destroy();
      // The adoption's git may still be running in the workspace, and Windows
      // removes no folder a process works in: it goes once that git is done.
      await removeDir(workspace);
    }
  });
});

function planWithChild(workspace: string): LegacyPlanState {
  const now = '2026-11-01T00:00:00.000Z';
  return {
    tasks: [{
      id: 'd', order: 1, title: 'd', type: 'delegated', goal: 'g', status: 'pending',
      dependencies: [], subtasks: [], runnerSessionId: 'child-x', assignedRunner: 'claude-code',
      budget: { tokens: 1000 }, protectedPaths: [],
    }],
    generatedAt: now, lastUpdated: now, status: 'approved', runners: ['claude-code'],
    isolation: {
      run: {
        id: 'run1', workspaceRoot: workspace,
        repos: [{ path: '.', root: workspace, baseRef: 'a'.repeat(40), baseBranch: 'main', integrationBranch: 'ordewell/run1/integration' }],
        shared: [], sharedRepos: [], keepsEveryLanding: true, carried: {},
        tasks: { d: { taskId: 'd', order: 1, title: 'd', status: 'kept', branch: 'b', childSession: 'child-x', repos: {} } },
      },
      resolvers: {},
    },
  } as unknown as LegacyPlanState;
}
