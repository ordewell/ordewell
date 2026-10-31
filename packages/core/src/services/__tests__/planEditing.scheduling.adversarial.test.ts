import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { makeSession, testWorkspace, taskOf } from './sessionTestKit';
import { hitLimit, NOW, RESUME_AT, supervised, task as runTask, until } from './supervisorTestKit';
import type { ModelResolver } from '../ModelResolver';
import { applyTaskOps } from '../TaskOps';

/**
 * Adversarial: every writer of a task's shape goes through the same guards.
 * CONTEXT.md: "The user's direct edits are held to the same rules ... refused
 * only for one the edit breaks", and the planner may not remove a task that
 * has started or finished. A hand-added task and a planner's subtree edit are
 * the two routes that name no existing task to lock or check.
 */

const CATALOG = {
  'claude-code': [
    { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [] },
  ],
};
const resolverFor = (models: unknown) =>
  ({ modelsForRunners: vi.fn().mockResolvedValue(models) }) as unknown as Pick<ModelResolver, 'modelsForRunners'>;

function planWith(): LegacyPlanState {
  return {
    tasks: [createTask({ id: 't1', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: 'claude-code' })],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
  };
}

function session() {
  const made = makeSession({ modelResolver: resolverFor(CATALOG) });
  made.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });
  return made;
}

describe('a direct edit is held to the plan\'s rules', () => {
  it('refuses an ops task on its runner\'s read-only mode', async () => {
    await expect(session().updateTask('t1', { ops: true, taskMode: 'plan' }))
      .rejects.toThrow(/read-only profile/);
  });
});

describe('a hand-added task', () => {
  it('is refused when it breaks a rule the plan\'s tasks keep together', async () => {
    const made = session();
    await expect(made.addTask({ title: 'Ops', prompt: 'deploy', ops: true, taskMode: 'plan' }))
      .rejects.toThrow(/read-only profile/);
    await expect(made.addTask({
      title: 'Mixed',
      prompt: 'x',
      autonomy: 'AFK',
      userSteps: [{ order: 1, instruction: 'sign off', completed: false }],
    })).rejects.toThrow(/AFK/);
    await expect(made.addTask({
      title: 'Manual',
      type: 'user',
      sliceType: 'AFK',
      userSteps: [{ order: 1, instruction: 'sign off', completed: false }],
    })).rejects.toThrow(/HITL/);
    expect(made.planTasks.map((t) => t.title)).toEqual(['Setup']);
  });
});

describe('a paused task edited into a manual one', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not spawn a runner for it at its reset', async () => {
    const env = await supervised([runTask('t1', 1), runTask('t2', 2)], {
      settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 1 },
    });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);

    await env.session.updateTask('t1', {
      type: 'user',
      userSteps: [{ order: 1, instruction: 'sign off', completed: false }],
    });
    // The edit ends the pause, so the hold goes with it and the run takes its next task.
    expect(taskOf(env.session, 't1')).toMatchObject({ type: 'user', status: 'pending' });

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 1000);

    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(1);
  });
});

describe('a planner edit that removes a subtree', () => {
  it('is refused when a subtask has completed', () => {
    const parent = createTask({
      id: 'p', order: 1, title: 'Parent', prompt: 'parent',
      subtasks: [{ ...createTask({ id: 's', order: 1, title: 'Sub', prompt: 'sub' }), status: 'completed' }],
    });
    const result = applyTaskOps([parent], [{ op: 'remove', taskId: 'p' }], ['claude-code']);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/completed/);
  });
});
