import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { FakeTerminalSession, makeSession, testWorkspace } from './sessionTestKit';
import { PlanStore } from '../PlanStore';
import type { ModelResolver } from '../ModelResolver';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';

/** One AI task, so a removal leaves the scheduler with nothing else to spawn. */
function soloPlan(): LegacyPlanState {
  return {
    tasks: [createTask({ id: 'only', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'claude-code' })],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * A plan the scheduler has already run into a pause: the first task completed,
 * the second is the user's to do, the third waits on it. Nothing is live, but
 * the scheduler stays armed so completing the user task fans the third out.
 */
function pausedOnUserTask(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'setup', status: 'completed', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Sign off', type: 'user', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'Ship', prompt: 'ship', dependencies: ['b'], assignedRunner: 'claude-code' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
  };
}

/** A runner double that records what it spawned and what it was told to stop. */
function recordingRunner(): ITerminalRunner & { spawned: string[]; stopped: string[] } {
  const spawned: string[] = [];
  const stopped: string[] = [];
  return {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      spawned.push(taskId);
      return new FakeTerminalSession(`s-${taskId}`, taskId);
    }),
    stop: vi.fn((sessionId: string) => { stopped.push(sessionId); }),
    stopAll: vi.fn(),
    activeCount: 0,
    spawned,
    stopped,
  } as unknown as ITerminalRunner & { spawned: string[]; stopped: string[] };
}

function planWith(runners: string[] = ['claude-code']): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: runners[0] }),
      createTask({ id: 't2', order: 2, title: 'Build', prompt: 'build', assignedRunner: runners[0], dependencies: ['t1'] }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners,
    lastUpdated: new Date().toISOString(),
  };
}

function resolverFor(models: Record<string, { modelId: string; modelLabel: string; variants: { id: string; label: string }[] }[]>) {
  return { modelsForRunners: vi.fn().mockResolvedValue(models) } as unknown as Pick<ModelResolver, 'modelsForRunners'>;
}

const CLAUDE_CATALOG = {
  'claude-code': [
    { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    { modelId: 'claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5', variants: [] },
  ],
};

describe('Session.addTask', () => {
  it('gives a hand-added task a runnable assignment from the plan first runner', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({ title: 'Docs', prompt: 'write docs' });

    const added = state!.tasks.find((t) => t.title === 'Docs')!;
    expect(added.assignedRunner).toBe('claude-code');
    expect(added.assignedModel!.modelId).toBe('claude-sonnet-4-5');
    expect(added.taskMode).toBeTruthy();
    expect(added.status).toBe('pending');
  });

  it('keeps an explicit runner and admits it into the plan runner set', async () => {
    const session = makeSession({
      modelResolver: resolverFor({ codex: [{ modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', variants: [] }] }),
    });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({ title: 'Docs', prompt: 'write docs', assignedRunner: 'codex' });

    expect(state!.tasks.find((t) => t.title === 'Docs')!.assignedRunner).toBe('codex');
    expect(state!.runners).toContain('codex');
  });

  it('keeps a model the caller chose when the runner offers it', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({
      title: 'Docs',
      assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5' },
    });

    expect(state!.tasks.find((t) => t.title === 'Docs')!.assignedModel!.modelId).toBe('claude-haiku-4-5');
  });

  it('carries the dependencies the caller picked', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({ title: 'Docs', dependencies: ['t1', 't2'] });

    expect(state!.tasks.find((t) => t.title === 'Docs')!.dependencies).toEqual(['t1', 't2']);
  });

  it('drops a dependency on a task that is no longer in the plan', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({ title: 'Docs', dependencies: ['t1', 'ghost'] });

    expect(state!.tasks.find((t) => t.title === 'Docs')!.dependencies).toEqual(['t1']);
  });

  it('never spawns a runner for a manual task', async () => {
    const resolver = resolverFor(CLAUDE_CATALOG);
    const session = makeSession({ modelResolver: resolver });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({ title: 'Sign off', type: 'user' });

    expect(state!.tasks.find((t) => t.title === 'Sign off')!.assignedModel).toBeUndefined();
    expect(resolver.modelsForRunners).not.toHaveBeenCalled();
  });

  // Nothing wakes an armed-but-paused scheduler after a hand edit unless the
  // edit does it: a direct edit never queues, so the queue-drain path never runs.
  it('starts an added task whose dependencies are already complete', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(pausedOnUserTask(), 'goal', testWorkspace, { persist: false });
    await session.executePlan();
    expect(runner.spawned).toEqual([]);

    const state = await session.addTask({ title: 'Docs', prompt: 'write docs', dependencies: ['a'] });

    const added = state!.tasks.find((t) => t.title === 'Docs')!;
    expect(runner.spawned).toEqual([added.id]);
    expect(session.getTask(added.id)!.status).toBe('in_progress');
  });
});

describe('Session.removeTask', () => {
  it('detaches the removed task from everything that depended on it', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.removeTask('t1');

    expect(state!.tasks.map((t) => t.id)).toEqual(['t2']);
    expect(state!.tasks[0].dependencies).toEqual([]);
  });

  // A plan that drops a running task can no longer reach the runner it spawned:
  // the tmux session keeps going and the orchestrator's entry for it is never
  // cleared, which is one of the ways "Execution is running" became permanent.
  it('cancels a live runner before dropping the task that owns it', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(soloPlan(), 'goal', testWorkspace, { persist: false });
    await session.executePlan();
    expect(runner.spawned).toEqual(['only']);

    await session.removeTask('only');

    expect(runner.stopped).toEqual(['s-only']);
    expect(session.hasLiveWork).toBe(false);
    expect(session.planTasks).toEqual([]);
  });

  // The scheduler stays armed after the removal, and nothing but this re-tick
  // wakes it — a direct edit never queues, so the queue-drain path never runs.
  it('fans the dependents out once their blocker is removed', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });
    await session.executePlan();

    await session.removeTask('t1');

    expect(runner.spawned).toEqual(['t1', 't2']);
  });

  // Deleting one's own finished task is allowed — the plan belongs to the user.
  // What must not happen is the rest of the plan losing its way afterwards: the
  // completed id leaves the completed set, so anything still pointing at it
  // would never satisfy its dependency check again.
  it('leaves the dependents of a removed completed task schedulable', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(pausedOnUserTask(), 'goal', testWorkspace, { persist: false });
    await session.executePlan();

    await session.removeTask('a');

    expect(session.planTasks.map((t) => t.id)).toEqual(['b', 'c']);
    expect(session.getTask('b')!.dependencies).toEqual([]);
    expect(session.getTask('b')!.status).toBe('pending');

    // Still schedulable: the run is armed, so finishing the user task fans out.
    await session.markTaskComplete('b');
    expect(runner.spawned).toEqual(['c']);
  });
});

describe('Session.setTaskDependencies', () => {
  it('replaces the list', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.setTaskDependencies('t2', []);

    expect(state!.tasks.find((t) => t.id === 't2')!.dependencies).toEqual([]);
  });

  it('refuses a dependency that comes after the task, saying why', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await expect(session.setTaskDependencies('t1', ['t2'])).rejects.toThrow(/comes after it/);
    expect(session.planState!.tasks.find((t) => t.id === 't1')!.dependencies).toEqual([]);
  });

  // Position is not something a user sets any more, so the refusal must not
  // point at a control that no longer exists.
  it('does not tell the user to move the task instead', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await expect(session.setTaskDependencies('t1', ['t2'])).rejects.not.toThrow(/reorder|move it/i);
  });

  // A dependency list arriving as a plain field patch must meet the same rule —
  // otherwise the picker's guard is bypassed by anything that patches fields.
  it('applies the same guard when dependencies arrive as a field patch', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await expect(session.updateTask('t1', { dependencies: ['t2'] })).rejects.toThrow(/comes after it/);
    await expect(session.updateTask('t2', { dependencies: ['ghost'] })).rejects.toThrow(/Unknown dependency/);
  });
});

describe('reordering is not part of the plan API', () => {
  // Independent tasks fan out, so a stored position never was the execution
  // order it looked like. Nothing may reintroduce a positional mutator.
  it('exposes no reorder on the session or its store', () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    expect((session as unknown as Record<string, unknown>).reorderTasks).toBeUndefined();
    expect((new PlanStore() as unknown as Record<string, unknown>).reorder).toBeUndefined();
  });
});
