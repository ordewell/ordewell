import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState, Task } from '../../models/Task';
import type { ChildPlacement, Session } from '../createSession';
import { FakeWorktreeIsolation } from '../../testing';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { fakeConfig, makeSession, memoryTaskLogs } from './sessionTestKit';
import { heldPlanner, NOW, plan, prose, recordingRunner, settled, task, until } from './supervisorTestKit';

/**
 * A child's opening takes a slot at its gate, then its fresh plan ends the old
 * plan scope before the conversation claims the turn. That end used to return
 * the slot, a sibling's kept turn took it, and `turnClaiming` ignored its own
 * refusal: both planner turns ran at Parallel 1 (ADR-0055 D18, ADR-0058 S4).
 */

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

async function tree() {
  const config = fakeConfig({ maxParallelSessions: 1, worktreeIsolation: true, conflictRepairAttempts: 1 });
  const isolation = new FakeWorktreeIsolation();
  const settings = () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' as const } });
  const rootRun = recordingRunner();
  const root = makeSession({ config, isolation, runner: rootRun.runner, aiService: heldPlanner().aiService, settings, workspaceRoot: () => '/repo', sessionId: 'root' });
  const seats: Session[] = [];
  root.loadPlan(plan([task('delegated', 1)]), 'root goal', '/repo');
  await root.execute({ command: 'run_plan' }, { kind: 'user' });
  await until(() => rootRun.spawnedIds().includes('delegated'));
  await root.execute({ command: 'stop_task', task: 'delegated' }, { kind: 'user' });
  await settled();
  const placement: ChildPlacement = root.hostChild('delegated');

  const child = (name: string, tasks: Task[], saved: Partial<LegacyPlanState> = {}) => {
    const run = recordingRunner();
    const planner = heldPlanner();
    const codeRoot = `/repo/.ordewell/worktrees/run1/${name}`;
    const session = makeSession({
      config, runner: run.runner, aiService: planner.aiService, settings,
      workspaceRoot: () => codeRoot,
      placement: { ...placement, sessionId: name },
      saveSession: (() => ({ id: name })) as never,
      openTaskLog: memoryTaskLogs(),
      notifications: { info: () => undefined, warn: () => undefined, error: () => undefined, confirm: async () => undefined },
    });
    session.loadPlan({ ...plan(tasks), ...saved } as LegacyPlanState, `goal ${name}`, codeRoot);
    seats.push(session);
    return { session, run, planner };
  };
  const close = () => {
    for (const session of seats) session.destroy();
    root.destroy();
  };
  return { child, close };
}

describe('a child opening whose slot a sibling takes', () => {
  it('keeps it: at Parallel 1 the opening runs, and the sibling waits for it to end', async () => {
    const { child, close } = await tree();
    const a = child('a', []);
    const b = child('b', []);
    const c = child('c', [task('c1', 1)]);
    try {
      // C holds the one slot.
      await c.session.execute({ command: 'run_plan' }, { kind: 'user' });
      await until(() => c.run.spawnedIds().includes('c1'));

      // A's opening and B's turn both wait for it, in that order.
      const opening = a.session.startPlanning('A goal');
      await settled();
      const message = b.session.continueConversation('B message');
      await settled();
      expect(a.planner.calls).toHaveLength(0);
      expect(b.planner.calls).toHaveLength(0);

      // The slot frees: A is offered it, and its fresh plan must not give it to B.
      c.run.of('c1').reportComplete({ status: 'done', summary: 'Done.' });
      await until(() => a.planner.calls.length === 1);
      await settled();
      expect(b.planner.calls).toHaveLength(0);

      a.planner.calls[0].finish(prose('ok'));
      await opening;
      await until(() => b.planner.calls.length === 1);
      b.planner.calls[0].finish(prose('ok'));
      await message;
    } finally {
      close();
    }
  });
});

describe('a turn nothing gates for a slot', () => {
  it('is refused at a full tree, its pause kept, rather than run one past the limit', async () => {
    const { child, close } = await tree();
    const at = new Date(NOW).toISOString();
    const a = child('a', [], {
      plannerContextPause: { model: 'm', at, reason: 'full', inputs: ['i1'] },
      pendingTurns: [{ id: 'i1', source: 'user', text: 'held', timestamp: at }],
    });
    const c = child('c', [task('c1', 1)]);
    try {
      await c.session.execute({ command: 'run_plan' }, { kind: 'user' });
      await until(() => c.run.spawnedIds().includes('c1'));

      await expect(a.session.retryPlannerCompaction()).rejects.toThrow(/already running/);

      expect(a.planner.calls).toHaveLength(0);
      expect(a.session.planState?.plannerContextPause).toBeDefined();
    } finally {
      close();
    }
  });
});
