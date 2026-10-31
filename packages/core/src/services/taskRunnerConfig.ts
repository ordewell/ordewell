import type { IRunner } from '../interfaces/IRunner';
import type { TaskRunnerConfig } from './harness/AgentAdapter';

/**
 * A runner whose spawns carry what the user's settings file says a task
 * runner loads of their own setup (`taskRunnerConfig`), read as each one
 * starts so a change reaches the next attempt in any session. A spawn that
 * already names its config keeps it: a delegated subtree can ask for less.
 */
export function withTaskRunnerConfig(runner: IRunner, setting: () => TaskRunnerConfig | undefined): IRunner {
  return {
    spawn: (opts) => {
      const runnerConfig = opts.runnerConfig ?? setting();
      return runner.spawn(runnerConfig === undefined ? opts : { ...opts, runnerConfig });
    },
    stop: (sessionId) => runner.stop(sessionId),
    stopAll: () => runner.stopAll(),
    get activeCount() { return runner.activeCount; },
  };
}
