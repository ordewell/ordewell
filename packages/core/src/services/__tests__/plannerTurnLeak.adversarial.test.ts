import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LegacyPlanState, RunnerId, Task } from '../../models/Task';
import type { Session, ChildPlacement } from '../createSession';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { TurnGate } from '../TurnGate';
import { FakeWorktreeIsolation } from '../../testing';
import { LEASE_STALE_MS, LeaseHost } from '../sessionLease';
import { openTaskLog } from '../../utils/taskLogStore';
import { saveSession } from '../../utils/sessionStore';
import { fakeConfig, makeSession, memoryTaskLogs } from './sessionTestKit';
import { heldPlanner, recordingRunner, plan, task, settled, until } from './supervisorTestKit';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

/**
 * A child's planner turn is let in by a slot of the tree's pool before any
 * conversation owns it (ADR-0059 L1, ADR-0055 D18). A goal refused in between
 * — no requested runner enabled, or a root another host has taken over — must
 * give that slot back: nothing later ends a turn that never opened, so the
 * reservation holds a slot of the whole tree until the child closes. A flat
 * root's turn is counted by nobody, so only a tree shows it.
 */
describe('a planner goal refused after its turn took a slot', () => {
  async function tree() {
    const config = fakeConfig({ maxParallelSessions: 1, worktreeIsolation: true, conflictRepairAttempts: 1 });
    const isolation = new FakeWorktreeIsolation();
    const settings = () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' as const }, enabledRunners: ['claude-code'] as RunnerId[] });
    const rootRun = recordingRunner();
    const root = makeSession({ config, isolation, runner: rootRun.runner, aiService: heldPlanner().aiService, settings, workspaceRoot: () => '/repo', sessionId: 'root' });
    root.loadPlan(plan([task('delegated', 1)]), 'the root goal', '/repo');
    await root.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => rootRun.spawnedIds().includes('delegated'));
    // The delegated task gives its slot back and keeps the worktree it seats a child in.
    await root.execute({ command: 'stop_task', task: 'delegated' }, { kind: 'user' });
    await settled();
    const seat: ChildPlacement = root.hostChild('delegated');
    const childOf = (name: string, tasks: Task[]) => {
      const runner = recordingRunner();
      const codeRoot = `/repo/.ordewell/worktrees/run1/${name}`;
      const session = makeSession({
        config, runner: runner.runner, aiService: heldPlanner().aiService, settings,
        workspaceRoot: () => codeRoot,
        placement: { ...seat, sessionId: name },
        saveSession: vi.fn(), openTaskLog: memoryTaskLogs(),
      });
      session.loadPlan(plan(tasks) as LegacyPlanState, `the goal of ${name}`, codeRoot);
      return { session, runner };
    };
    return { root, childOf };
  }

  it.each<[string, (session: Session) => Promise<unknown>]>([
    ['startPlanning', (session) => session.startPlanning('a new goal', ['opencode'])],
    ['generatePlan', (session) => session.generatePlan('a new goal', ['opencode'])],
  ])('gives the slot back when %s refuses the goal, so a sibling of the tree starts', async (_name, refusedGoal) => {
    const { root, childOf } = await tree();
    const a = childOf('a', [task('a1', 1)]);
    const b = childOf('b', [task('b1', 1)]);
    try {
      const refused = await refusedGoal(a.session).catch((err: unknown) => err);
      expect((refused as Error).message).toBe('None of the requested runners are enabled');
      // No turn opened, so nothing ever released what the opening reserved.
      expect((a.session as unknown as { gate: TurnGate }).gate.holding).toBe(false);

      await b.session.execute({ command: 'run_plan' }, { kind: 'user' });
      await until(() => b.runner.spawnedIds().includes('b1'));
      expect(b.runner.spawnedIds()).toContain('b1');
    } finally {
      a.session.destroy();
      b.session.destroy();
      root.destroy();
    }
  });

  it('gives the slot back when a compaction is refused before it takes the conversation', async () => {
    const { root, childOf } = await tree();
    const a = childOf('a', [task('a1', 1)]);
    try {
      await expect(a.session.compactConversation()).rejects.toThrow('too short to condense');
      expect((a.session as unknown as { gate: TurnGate }).gate.holding).toBe(false);
    } finally {
      a.session.destroy();
      root.destroy();
    }
  });

  it('leaves the slot with the live turn a refused goal came in beside', async () => {
    const { root, childOf } = await tree();
    const a = childOf('a', [task('a1', 1)]);
    const b = childOf('b', [task('b1', 1)]);
    try {
      const live = a.session.startPlanning('the live goal', ['claude-code']).catch((err: unknown) => err);
      await settled();
      expect(a.session.isPlannerBusy).toBe(true);

      await expect(a.session.startPlanning('a new goal', ['opencode'])).rejects.toThrow('None of the requested runners are enabled');
      expect((a.session as unknown as { gate: TurnGate }).gate.holding).toBe(true);

      await b.session.execute({ command: 'run_plan' }, { kind: 'user' });
      await settled();
      expect(b.runner.spawnedIds()).toEqual([]);
      a.session.abortPlannerTurn();
      await live;
    } finally {
      a.session.destroy();
      b.session.destroy();
      root.destroy();
    }
  });

  it('gives the slot back when the root was taken over before the goal opened', async () => {
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-turn-leak-')));
    const config = fakeConfig({ maxParallelSessions: 1, worktreeIsolation: true, conflictRepairAttempts: 1 });
    const isolation = new FakeWorktreeIsolation();
    const settings = () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' as const }, enabledRunners: ['claude-code'] as RunnerId[] });
    const rootRun = recordingRunner();
    const host = new LeaseHost();
    // Another host judged this process gone and took the tree (ADR-0049).
    const taker = new LeaseHost({ now: () => Date.now() + 2 * LEASE_STALE_MS });
    const root = makeSession({
      config, isolation, runner: rootRun.runner, aiService: heldPlanner().aiService, settings,
      workspaceRoot: () => stateRoot, sessionId: 'root',
      saveSession, openTaskLog, leaseHost: host,
    });
    let a: Session | undefined;
    try {
      root.loadPlan(plan([task('delegated', 1)]), 'the root goal', stateRoot, { sessionId: 'root' });
      await root.execute({ command: 'run_plan' }, { kind: 'user' });
      await until(() => rootRun.spawnedIds().includes('delegated'));
      await root.execute({ command: 'stop_task', task: 'delegated' }, { kind: 'user' });
      await settled();
      const seat: ChildPlacement = root.hostChild('delegated');
      const codeRoot = join(stateRoot, '.ordewell', 'worktrees', 'run1', 'a');
      a = makeSession({
        config, settings, runner: recordingRunner().runner,
        workspaceRoot: () => codeRoot, placement: { ...seat, sessionId: 'a' },
        saveSession: vi.fn(), openTaskLog: memoryTaskLogs(),
      });
      a.loadPlan(plan([task('a1', 1)]) as LegacyPlanState, 'the goal of a', codeRoot);
      taker.lease(() => undefined).claim('root', stateRoot);

      const refused = await a.startPlanning('a new goal', ['claude-code']).catch((err: unknown) => err);
      expect((refused as Error).message).toContain('another Ordewell host');
      expect((a as unknown as { gate: TurnGate }).gate.holding).toBe(false);
    } finally {
      a?.destroy();
      taker.releaseAll();
      host.releaseAll();
      root.destroy();
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
