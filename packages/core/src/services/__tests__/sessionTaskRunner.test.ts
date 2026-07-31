import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { makeSession, testWorkspace } from './sessionTestKit';
import type { ModelResolver } from '../ModelResolver';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';

function planWith(runners: string[] = ['claude-code']): LegacyPlanState {
  return {
    tasks: [
      createTask({
        id: 't1', order: 1, title: 'Refactor PlanStore', prompt: 'do it',
        assignedRunner: 'claude-code',
        assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', thinkingEffort: 'high', availableVariants: ['low', 'high'] },
        taskMode: 'acceptEdits',
      }),
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

const CODEX_CATALOG = {
  codex: [{ modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] }],
};

describe('Session.setTaskRunner', () => {
  it('reassigns the model and mode to the new runner catalog', async () => {
    const session = makeSession({ modelResolver: resolverFor(CODEX_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.setTaskRunner('t1', 'codex');

    const task = state!.tasks[0];
    expect(task.assignedRunner).toBe('codex');
    expect(task.assignedModel).toEqual({
      modelId: 'gpt-5-codex',
      modelLabel: 'GPT-5 Codex',
      thinkingEffort: 'high',
      availableVariants: ['low', 'high'],
    });
    // codex's manifest modes are agent/plan/fullAccess — 'acceptEdits' is Claude-only.
    expect(task.taskMode).toBe('agent');
  });

  it('admits the new runner into plan.runners so the next planner turn does not snap it back', async () => {
    const session = makeSession({ modelResolver: resolverFor(CODEX_CATALOG) });
    session.loadPlan(planWith(['claude-code']), 'goal', testWorkspace, { persist: false });

    const state = await session.setTaskRunner('t1', 'codex');

    expect(state!.runners).toContain('codex');
    expect(state!.runners).toContain('claude-code');
  });

  it('only asks discovery for the runner being switched to', async () => {
    const resolver = resolverFor(CODEX_CATALOG);
    const session = makeSession({ modelResolver: resolver });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await session.setTaskRunner('t1', 'codex');

    expect(resolver.modelsForRunners).toHaveBeenCalledWith(['codex']);
  });

  it('broadcasts the updated plan so every surface sees the derived model and mode', async () => {
    const broadcast = vi.fn();
    const session = makeSession({ modelResolver: resolverFor(CODEX_CATALOG), broadcast });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });
    broadcast.mockClear();

    await session.setTaskRunner('t1', 'codex');

    // A runner change derives three other fields; a `task_updated` naming only
    // the runner would leave the surfaces showing a stale model and mode.
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'plan_generated' }));
  });

  it('derives the model from the new runner allowlist, not its whole catalog', async () => {
    const catalog = {
      codex: [
        { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
        { modelId: 'gpt-5-mini', modelLabel: 'GPT-5 Mini', variants: [{ id: 'low', label: 'Low' }] },
      ],
    };
    const session = makeSession({
      modelResolver: resolverFor(catalog),
      settings: () => ({ tddEnabled: false, grillMeEnabled: false, modelAllowlist: { codex: ['gpt-5-mini'] } }),
    });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.setTaskRunner('t1', 'codex');

    expect(state!.tasks[0].assignedModel!.modelId).toBe('gpt-5-mini');
  });

  it('ignores an allowlist that matches nothing the new runner offers', async () => {
    const session = makeSession({
      modelResolver: resolverFor(CODEX_CATALOG),
      settings: () => ({ tddEnabled: false, grillMeEnabled: false, modelAllowlist: { codex: ['claude-sonnet-4-5'] } }),
    });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    // Honoring it would narrow codex's catalog to nothing, and a task derived
    // from an empty catalog keeps claude-code's model on a codex runner.
    const state = await session.setTaskRunner('t1', 'codex');

    expect(state!.tasks[0].assignedModel!.modelId).toBe('gpt-5-codex');
  });

  it('returns null for an unknown task id', async () => {
    const session = makeSession({ modelResolver: resolverFor(CODEX_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    expect(await session.setTaskRunner('nope', 'codex')).toBeNull();
  });

  it('is a no-op when the task already runs on that runner', async () => {
    const resolver = resolverFor(CODEX_CATALOG);
    const session = makeSession({ modelResolver: resolver });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.setTaskRunner('t1', 'claude-code');

    expect(state!.tasks[0].assignedModel!.modelId).toBe('claude-sonnet-4-5');
    expect(state!.tasks[0].taskMode).toBe('acceptEdits');
    expect(resolver.modelsForRunners).not.toHaveBeenCalled();
  });

  it('spawns the new runner when the task is run without an intervening plan reload', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 's1', taskId: 't1', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: () => '', write: vi.fn() });
    const session = makeSession({
      modelResolver: resolverFor(CODEX_CATALOG),
      runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as ITerminalRunner,
    });
    session.loadPlan(planWith(['claude-code']), 'goal', testWorkspace, { persist: false });

    await session.setTaskRunner('t1', 'codex');
    await session.runTask('t1');

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ runner: 'codex' }));
  });

  it('keeps the task runnable when discovery for the new runner fails', async () => {
    const resolver = { modelsForRunners: vi.fn().mockResolvedValue({ codex: [] }) } as unknown as Pick<ModelResolver, 'modelsForRunners'>;
    const session = makeSession({ modelResolver: resolver });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.setTaskRunner('t1', 'codex');

    expect(state!.tasks[0].assignedRunner).toBe('codex');
    expect(state!.tasks[0].assignedModel!.modelId).toBe('claude-sonnet-4-5');
    expect(state!.tasks[0].taskMode).toBe('agent');
  });
});
