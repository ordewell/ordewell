import { describe, it, expect, vi } from 'vitest';
import type { IRunner } from '../../interfaces/IRunner';
import type { TaskRunnerConfig } from '../harness/AgentAdapter';
import { withTaskRunnerConfig } from '../taskRunnerConfig';

type SpawnOpts = Parameters<IRunner['spawn']>[0];

function recording() {
  const spawn = vi.fn(async (_opts: SpawnOpts) => ({}) as Awaited<ReturnType<IRunner['spawn']>>);
  const runner: IRunner = { spawn, stop: async () => {}, stopAll: () => {}, activeCount: 0 };
  return { runner, spawn };
}

const task = { taskId: 't', runner: 'claude-code', prompt: 'p', cwd: '/repo' };

describe('withTaskRunnerConfig', () => {
  it('hands each spawn the setting as it stands at that spawn', async () => {
    const { runner, spawn } = recording();
    let setting: TaskRunnerConfig | undefined = 'minimal';
    const wrapped = withTaskRunnerConfig(runner, () => setting);

    await wrapped.spawn(task);
    setting = 'user';
    await wrapped.spawn(task);

    expect(spawn.mock.calls.map(([opts]) => opts.runnerConfig)).toEqual(['minimal', 'user']);
  });

  it('leaves a spawn alone when nothing is set, and when the caller already chose', async () => {
    const { runner, spawn } = recording();
    await withTaskRunnerConfig(runner, () => undefined).spawn(task);
    await withTaskRunnerConfig(runner, () => 'minimal').spawn({ ...task, runnerConfig: 'user' });

    expect(spawn.mock.calls[0][0]).not.toHaveProperty('runnerConfig');
    expect(spawn.mock.calls[1][0].runnerConfig).toBe('user');
  });

  it('passes stop and the active count through', async () => {
    const stop = vi.fn(async () => {});
    const stopAll = vi.fn();
    const wrapped = withTaskRunnerConfig({ spawn: async () => ({}) as never, stop, stopAll, activeCount: 3 }, () => 'minimal');
    await wrapped.stop('s');
    wrapped.stopAll();
    expect(stop).toHaveBeenCalledWith('s');
    expect(stopAll).toHaveBeenCalled();
    expect(wrapped.activeCount).toBe(3);
  });
});
