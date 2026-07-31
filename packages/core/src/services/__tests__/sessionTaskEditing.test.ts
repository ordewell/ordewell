import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { makeSession, testWorkspace } from './sessionTestKit';
import { PlanStore } from '../PlanStore';
import type { ModelResolver } from '../ModelResolver';

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
});

describe('Session.removeTask', () => {
  it('detaches the removed task from everything that depended on it', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = session.removeTask('t1');

    expect(state!.tasks.map((t) => t.id)).toEqual(['t2']);
    expect(state!.tasks[0].dependencies).toEqual([]);
  });
});

describe('Session.setTaskDependencies', () => {
  it('replaces the list', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = session.setTaskDependencies('t2', []);

    expect(state!.tasks.find((t) => t.id === 't2')!.dependencies).toEqual([]);
  });

  it('refuses a dependency that comes after the task, saying why', () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    expect(() => session.setTaskDependencies('t1', ['t2'])).toThrow(/comes after it/);
    expect(session.planState!.tasks.find((t) => t.id === 't1')!.dependencies).toEqual([]);
  });

  // Position is not something a user sets any more, so the refusal must not
  // point at a control that no longer exists.
  it('does not tell the user to move the task instead', () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    expect(() => session.setTaskDependencies('t1', ['t2'])).not.toThrow(/reorder|move it/i);
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
