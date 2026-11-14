import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * A turn its provider failed is tried again in its saved session, after a
 * bounded backoff, before the task asks the user anything (ADR-0018 E1).
 */

// Claude Code's wording for an API 5xx, as its result carries it.
const BAD_GATEWAY = 'API Error: 502 Bad Gateway';

function setup() {
  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${sessions.length + 1}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ maxParallelSessions: 3 }),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    runSettings: () => ({ mergeAtGatesAutomatically: false }),
  });
  const task = (id: string): Readonly<Task> => orchestrator.storeInstance.get(id)!;
  /** Every status t1 was seen in, so a wait for the user that came and went still shows. */
  const seen: string[] = [];
  orchestrator.subscribe({ onTaskChanged: () => { const t = orchestrator.storeInstance.get('t1'); if (t) seen.push(t.status); } });
  return { orchestrator, sessions, spawn: runner.spawn, seen, task, notifications };
}

/** The provider's failure as the structured transport delivers it: the turn's error event, then a failed turn. */
function failTurn(session: FakeRunnerSession, message = BAD_GATEWAY): void {
  session.emitEvent({ type: 'error', message });
  session.emitOutput(`${message}\n`);
  session.emitTurnEnd('failed');
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i += 1) await flushMicrotasks();
  expect(condition()).toBe(true);
}

async function started(): Promise<ReturnType<typeof setup>> {
  const env = setup();
  env.orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
  await env.orchestrator.forceStartTask('t1');
  return env;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-14T10:00:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a turn its provider failed', () => {
  it('continues in the saved session after the backoff, and asks the user nothing', async () => {
    const { sessions, spawn, seen, task } = await started();

    failTurn(sessions[0]);
    await flushMicrotasks();
    expect(task('t1').status).toBe('in_progress');
    expect(sessions[0].fromOrdewell).toEqual([]);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(sessions[0].fromOrdewell).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessions[0].fromOrdewell).toHaveLength(1);
    expect(sessions[0].fromOrdewell[0]).toContain(BAD_GATEWAY);

    sessions[0].reportComplete({ status: 'done', summary: 'done' });
    await until(() => task('t1').status === 'completed');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(seen).not.toContain('awaiting_user');
  });

  it('asks for input naming the error once every try has failed', async () => {
    const { orchestrator, sessions, task } = await started();

    for (const wait of [30_000, 60_000, 120_000]) {
      failTurn(sessions[0]);
      await flushMicrotasks();
      expect(task('t1').status).toBe('in_progress');
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(sessions[0].fromOrdewell).toHaveLength(3);

    failTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    expect(task('t1').awaitingReason).toBe('input');
    expect(orchestrator.getTurnFailure('t1')).toBe(BAD_GATEWAY);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sessions[0].fromOrdewell).toHaveLength(3);
  });

  it('starts the backoff over once a try gets through', async () => {
    const { sessions, task } = await started();

    failTurn(sessions[0]);
    await vi.advanceTimersByTimeAsync(30_000);
    failTurn(sessions[0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessions[0].fromOrdewell).toHaveLength(2);
    // The second try ends its turn without calling task_complete: the completion reminder opens the next.
    sessions[0].emitTurnEnd('completed');
    expect(sessions[0].fromOrdewell).toHaveLength(3);

    failTurn(sessions[0]);
    await flushMicrotasks();
    expect(task('t1').status).toBe('in_progress');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessions[0].fromOrdewell).toHaveLength(4);
  });

  it('redacts a key the error carries from the notice and the try, as any text a runner wrote', async () => {
    const { notifications, sessions } = await started();
    const key = 'sk-ant-api03-' + 'A1b2C3d4E5'.repeat(9) + '-AAAAAA';

    failTurn(sessions[0], `API Error: 502 Bad Gateway (x-api-key ${key})`);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sessions[0].fromOrdewell).toHaveLength(1);
    expect(sessions[0].fromOrdewell[0]).toContain(BAD_GATEWAY);
    expect(sessions[0].fromOrdewell[0]).not.toContain(key);
    const told = vi.mocked(notifications.info).mock.calls.map(([text]) => String(text)).join('\n');
    expect(told).toContain(BAD_GATEWAY);
    expect(told).not.toContain(key);
  });

  it('does not retry an error that is not the provider\'s', async () => {
    const { orchestrator, sessions, task } = await started();

    failTurn(sessions[0], 'Invalid tool input: missing file_path');
    await until(() => task('t1').status === 'awaiting_user');
    expect(task('t1').awaitingReason).toBe('input');
    expect(orchestrator.getTurnFailure('t1')).toBe('Invalid tool input: missing file_path');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sessions[0].fromOrdewell).toEqual([]);
  });

  it('drops the waiting try when the user cancels the task', async () => {
    const { orchestrator, sessions } = await started();

    failTurn(sessions[0]);
    await flushMicrotasks();
    await orchestrator.cancelTask('t1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessions[0].fromOrdewell).toEqual([]);
  });
});
