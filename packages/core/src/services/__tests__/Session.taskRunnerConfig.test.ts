import { describe, expect, it } from 'vitest';
import { makeSession, testWorkspace } from './sessionTestKit';
import { heldPlanner, plan, recordingRunner, task } from './supervisorTestKit';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { SessionDeps } from '../createSession';

/** Starts one task in a session over `settings` and returns what its runner was spawned with. */
async function spawnedWith(settings: ReturnType<SessionDeps['settings']>) {
  const run = recordingRunner();
  const session = makeSession({ runner: run.runner, aiService: heldPlanner().aiService, settings: () => settings });
  session.loadPlan(plan([task('parent', 1, { type: 'user', subtasks: [{ ...task('t1', 1), status: 'awaiting_user', awaitingReason: 'usage-limit', runnerSessionId: 'native-saved' }] })]), 'build it', testWorkspace);
  await session.execute({ command: 'retry_task', task: 't1', from: 'session' }, { kind: 'user' });
  session.destroy();
  return run.runner.spawn.mock.calls[0][0];
}

describe('the taskRunnerConfig setting', () => {
  it('reaches the runner a task is spawned on', async () => {
    const opts = await spawnedWith({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, taskRunnerConfig: 'minimal' });
    expect(opts.runnerConfig).toBe('minimal');
  });

  it('is absent from the spawn when the file does not set it', async () => {
    const opts = await spawnedWith({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } });
    expect(opts).not.toHaveProperty('runnerConfig');
  });
});
