import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { runningLongThreshold } from '../RunningLong';

const MINUTE = 60_000;

function setup() {
  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${o.taskId}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: false }),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  return { orchestrator, sessions, task: (id: string) => orchestrator.storeInstance.get(id)! };
}

const plan = (overrides: Partial<Task> = {}): Task => ({
  ...createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'Parse objects and arrays.' }),
  ...overrides,
});

describe('a passed attempt\'s running time (ADR-0018 W1)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('leaves out its wait for input, so a night\'s wait raises no later task\'s threshold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T08:00:00Z'));
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    vi.setSystemTime(new Date('2026-11-14T08:03:00Z'));
    h.sessions[0].waitForInput();
    expect(h.task('t1').status).toBe('awaiting_user');
    vi.setSystemTime(new Date('2026-11-14T18:00:00Z'));
    h.orchestrator.sendTaskMessage('t1', 'go on');
    vi.setSystemTime(new Date('2026-11-14T18:02:00Z'));
    h.sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(h.task('t1').status).toBe('completed'));

    const usage = h.task('t1').attemptUsage!.at(-1)!;
    // vi.waitFor's polling moves the faked clock on a few milliseconds.
    expect(usage.wallTimeMs).toBeGreaterThanOrEqual(10 * 60 * MINUTE + 2 * MINUTE);
    expect(usage.runningMs).toBeGreaterThanOrEqual(5 * MINUTE);
    expect(usage.runningMs).toBeLessThan(6 * MINUTE);
    expect(runningLongThreshold([h.task('t1')])).toEqual({ ms: 30 * MINUTE });
  });
});
