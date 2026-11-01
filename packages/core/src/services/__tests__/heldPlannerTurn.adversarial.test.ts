import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { flushMicrotasks } from '../../testing';
import { createTask, type LegacyPlanState, type RunnerId } from '../../models/Task';
import type { ChildPlacement, Session } from '../createSession';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { FakeWorktreeIsolation } from '../../testing';
import { LEASE_STALE_MS, LeaseHost, SessionHeldError } from '../sessionLease';
import { openTaskLog } from '../../utils/taskLogStore';
import { saveSession } from '../../utils/sessionStore';
import { fakeConfig, makeSession, memoryTaskLogs } from './sessionTestKit';
import { heldPlanner, plan, prose, recordingRunner, settled, task, until } from './supervisorTestKit';

const PRD = '<!-- ORDEWELL_PRD_START slug="sub" --># A PRD<!-- ORDEWELL_PRD_END -->';

/**
 * A host that does not hold a session's lease holds none of its work
 * (ADR-0049): its tasks are refused at the seam, its saves are refused, and
 * its run is stopped. A planner turn is not: the hold is read in the seam for
 * starts and in `persist` for saves, but a turn opens on the lease anyway, runs
 * the planner's process, and writes the PRD into the user's workspace — a file
 * their other host never sees, and one that leaves the checkout dirty for the
 * next isolated run.
 */
describe('a held session does not run a planner turn', () => {
  function heldSession(saved: Partial<LegacyPlanState> = {}, sessionId?: string) {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-held-turn-')));
    const host = new LeaseHost();
    const taker = new LeaseHost({ now: () => Date.now() + 2 * LEASE_STALE_MS });
    const turns: string[] = [];
    const session = makeSession({
      config: fakeConfig({ worktreeIsolation: true }),
      saveSession, leaseHost: host,
      aiService: {
        hasActiveConversation: () => true,
        startConversation: async (req: { goal: string }) => {
          turns.push(req.goal);
          return { kind: 'message', text: 'ok', researchLog: [] };
        },
        continueConversation: async (prompt: string) => {
          turns.push(prompt);
          return { kind: 'message', text: PRD, researchLog: [] };
        },
        reset: () => undefined,
      },
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, enabledRunners: ['claude-code'] as RunnerId[] }),
      workspaceRoot: () => workspace,
      ...(sessionId ? { sessionId } : {}),
    });
    const now = new Date().toISOString();
    const loaded: LegacyPlanState = { tasks: [createTask({ id: 't1', order: 1, title: 'Task t1', prompt: 'do t1' })], generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now, ...saved };
    session.loadPlan(loaded, 'goal', workspace, { sessionId: 'root' });
    // Another host took the tree after judging this process gone (ADR-0049).
    taker.lease(() => undefined).claim('root', workspace);
    expect(session.heldElsewhere()?.holder.hostId).toBe(taker.id);
    return {
      session, workspace, turns,
      cleanup: () => {
        taker.releaseAll();
        host.releaseAll();
        session.destroy();
        rmSync(workspace, { recursive: true, force: true });
      },
    };
  }

  it('refuses before the turn runs or writes its PRD', async () => {
    const { session, workspace, turns, cleanup } = heldSession({}, 'root');
    try {
      await expect(session.continueConversation('write the PRD')).rejects.toBeInstanceOf(SessionHeldError);
      await flushMicrotasks();
      expect(turns).toEqual([]);
      expect(session.planState?.prdMarkdown).toBeUndefined();
      expect(existsSync(join(workspace, '.scratch', 'sub', 'PRD.md'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('refuses a compaction', async () => {
    const { session, turns, cleanup } = heldSession({}, 'root');
    try {
      await expect(session.compactConversation()).rejects.toBeInstanceOf(SessionHeldError);
      expect(turns).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('refuses a retry of a pause on the planner\'s context, and keeps the pause', async () => {
    const at = new Date().toISOString();
    const { session, turns, cleanup } = heldSession({
      pendingTurns: [{ id: 'i1', source: 'user', text: 'paused', timestamp: at }],
      plannerContextPause: { model: 'm', at, reason: 'full', inputs: ['i1'] },
    }, 'root');
    try {
      await expect(session.retryPlannerCompaction()).rejects.toBeInstanceOf(SessionHeldError);
      expect(turns).toEqual([]);
      expect(session.planState?.plannerContextPause).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('leaves a new goal under a minted id alone: it is a new session, not the held one', async () => {
    const { session, turns, cleanup } = heldSession();
    try {
      await session.startPlanning('a new goal', ['claude-code']);
      expect(turns).toEqual(['a new goal']);
      expect(session.sessionId).not.toBe('root');
      expect(session.heldElsewhere()).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('refuses a new goal under the host\'s fixed id, which writes the held session\'s file', async () => {
    const { session, turns, cleanup } = heldSession({}, 'root');
    try {
      await expect(session.startPlanning('a new goal', ['claude-code'])).rejects.toBeInstanceOf(SessionHeldError);
      expect(turns).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

/** A child holds no lease of its own (ADR-0055 D13): its turns go by its root's. */
describe('a child\'s planner turns', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('run while its root is held here, and are refused once another host takes the root', async () => {
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-held-child-')));
    const config = fakeConfig({ maxParallelSessions: 1, worktreeIsolation: true, conflictRepairAttempts: 1 });
    const settings = () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' as const }, enabledRunners: ['claude-code'] as RunnerId[] });
    const rootRun = recordingRunner();
    const host = new LeaseHost();
    const taker = new LeaseHost({ now: () => Date.now() + 2 * LEASE_STALE_MS });
    const root = makeSession({
      config, isolation: new FakeWorktreeIsolation(), runner: rootRun.runner, aiService: heldPlanner().aiService, settings,
      workspaceRoot: () => stateRoot, sessionId: 'root',
      saveSession, openTaskLog, leaseHost: host,
    });
    const planner = heldPlanner();
    let child: Session | undefined;
    try {
      root.loadPlan(plan([task('delegated', 1)]), 'the root goal', stateRoot, { sessionId: 'root' });
      await root.execute({ command: 'run_plan' }, { kind: 'user' });
      await until(() => rootRun.spawnedIds().includes('delegated'));
      await root.execute({ command: 'stop_task', task: 'delegated' }, { kind: 'user' });
      await settled();
      const seat: ChildPlacement = root.hostChild('delegated');
      const codeRoot = join(stateRoot, '.ordewell', 'worktrees', 'run1', 'a');
      child = makeSession({
        config, settings, runner: recordingRunner().runner, aiService: planner.aiService,
        workspaceRoot: () => codeRoot, placement: { ...seat, sessionId: 'a' },
        saveSession: vi.fn(), openTaskLog: memoryTaskLogs(),
      });

      const opened = child.startPlanning('the goal of a', ['claude-code']);
      await until(() => planner.calls.length === 1);
      planner.calls[0].finish(prose('A question?'));
      await opened;
      const replied = child.continueConversation('An answer');
      await until(() => planner.calls.length === 2);
      planner.calls[1].finish(prose('Thanks'));
      await replied;

      taker.lease(() => undefined).claim('root', stateRoot);
      await expect(child.continueConversation('And again')).rejects.toBeInstanceOf(SessionHeldError);
      expect(planner.calls).toHaveLength(2);
    } finally {
      child?.destroy();
      taker.releaseAll();
      host.releaseAll();
      root.destroy();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
