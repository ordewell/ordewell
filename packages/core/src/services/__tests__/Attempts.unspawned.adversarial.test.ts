import { describe, expect, it, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * Adversarial, the cancel-keep review, round 2: an attempt ended while its
 * spawn is in flight stays in `Attempts.unspawned` until its spawn lets go.
 * A spawn that fails on its own ends the attempt from inside the spawn, after
 * which no path calls `abandonSpawn` — so the entry is never dropped.
 */

describe('an attempt its own failed spawn ended', () => {
  it('does not stay in the in-flight list', async () => {
    const isolation = new FakeWorktreeIsolation();
    const runner: IRunner = {
      spawn: vi.fn(async () => { throw new Error('runner refused to start'); }),
      stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
    };
    const orchestrator = TaskOrchestrator.compose({ config: fakeConfig(), notifications: fakeNotification(), runner, output: new BufferedTaskOutputSource(), isolation, workspaceRoot: () => '/repo' });
    const attempts = (orchestrator as unknown as { attempts: { unspawned: Map<string, unknown> } }).attempts;
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'T1', prompt: 'do' })]);
    await orchestrator.forceStartTask('t1').catch((): undefined => undefined);
    await flushMicrotasks(20);

    expect(orchestrator.runs.planIsolation?.run.tasks.t1).toBeUndefined();
    expect(attempts.unspawned.size).toBe(0);
  });
});
