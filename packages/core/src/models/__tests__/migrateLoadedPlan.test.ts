import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { createEmptyPlan, createTask, migrateLoadedPlan, type LegacyPlanState, type PendingPlanTurn } from '../Task';

function plan(overrides: Partial<LegacyPlanState> = {}): LegacyPlanState {
  return { ...createEmptyPlan(), ...overrides };
}

/** A plan as a build older than the field wrote it, with fields today's type no longer names. */
function withLegacyFields(value: LegacyPlanState, fields: Record<string, unknown>): LegacyPlanState {
  return Object.assign(value, fields);
}

describe('migrateLoadedPlan', () => {
  it('reads approval from the status when the plan kept no approval record', () => {
    const loaded = plan({
      status: 'approved',
      tasks: [
        createTask({ id: 't1', title: 'Build' }),
        createTask({ id: 't2', title: 'Ship', subtasks: [createTask({ id: 't2.1', title: 'Tag' })] }),
      ],
    });

    migrateLoadedPlan(loaded);

    expect(loaded.approved).toBe(true);
    expect(loaded.approvedTasks).toEqual(['t1', 't2', 't2.1']);
  });

  it('reads a draft plan as not approved, with no task approved', () => {
    const loaded = plan({ status: 'draft', tasks: [createTask({ id: 't1' })] });

    migrateLoadedPlan(loaded);

    expect(loaded.approved).toBe(false);
    expect(loaded.approvedTasks).toBeUndefined();
  });

  it('leaves an approval record the plan already has', () => {
    const loaded = plan({ status: 'running', approved: true, approvedTasks: ['t2'] });

    migrateLoadedPlan(loaded);

    expect(loaded.approvedTasks).toEqual(['t2']);
  });

  it('drops a saved task pause on adoption, which belonged to a run that is gone', () => {
    const loaded = plan({
      tasks: [Object.assign(createTask({ id: 't1', status: 'awaiting_user', awaitingReason: 'usage-limit' }), { resumeAt: '2026-10-11T20:11:00.000Z' })],
    });

    migrateLoadedPlan(loaded);

    expect(loaded.tasks[0].resumeAt).toBeUndefined();
  });

  it('keeps a live run’s task pause when the same plan is reloaded', () => {
    const resumeAt = '2026-10-11T20:11:00.000Z';
    const loaded = plan({ tasks: [Object.assign(createTask({ id: 't1', status: 'awaiting_user', awaitingReason: 'usage-limit' }), { resumeAt })] });

    migrateLoadedPlan(loaded, { adopting: false });

    expect(loaded.tasks[0].resumeAt).toBe(resumeAt);
  });

  it('brings an ADR-0013 isolation run to the grouped shape', () => {
    // As this platform writes a workspace root: the migration joins the repo onto it natively.
    const repo = path.resolve('/repo');
    const loaded = plan({
      isolation: {
        run: {
          id: 'run-1',
          workspaceRoot: repo,
          baseRef: 'main',
          integrationBranch: 'ordewell/run-1/integration',
          tasks: {
            t1: { taskId: 't1', order: 1, title: 'Build', branch: 'ordewell/run-1/t1', worktree: '/tmp/wt', status: 'merged', linked: [] },
          },
        },
        resolvers: {},
      } as unknown as LegacyPlanState['isolation'],
    });

    migrateLoadedPlan(loaded);

    expect(loaded.isolation?.run.repos).toEqual([
      { path: '.', root: repo, baseRef: 'main', integrationBranch: 'ordewell/run-1/integration' },
    ]);
    expect(loaded.isolation?.run.tasks.t1.repos).toEqual({ '.': { worktree: '/tmp/wt', linked: [], changed: true } });
  });

  it('drops the retired transport copy and the plan’s own run settings', () => {
    const loaded = withLegacyFields(plan(), {
      runnerTransport: 'structured',
      supervisorLevel: 'watch',
      mergeAtGatesAutomatically: true,
      supervisorRetryLimit: 2,
      wakeUpReadBudget: 3,
    });

    migrateLoadedPlan(loaded);

    expect(loaded).not.toHaveProperty('runnerTransport');
    expect(loaded).not.toHaveProperty('supervisorLevel');
    expect(loaded).not.toHaveProperty('mergeAtGatesAutomatically');
    expect(loaded).not.toHaveProperty('supervisorRetryLimit');
    expect(loaded).not.toHaveProperty('wakeUpReadBudget');
  });

  it('drops the retired research budget, its settings, its turn flag and a task’s report wait', () => {
    const task = createTask({ id: 't1', title: 'Build' });
    const loaded = withLegacyFields(plan({ tasks: [task], runSettings: {
      mergeAtGatesAutomatically: false,
      supervisorLevel: 'watch',
      researchMaxParallel: 6,
      researchMaxPerMessage: 5,
    } as unknown as LegacyPlanState['runSettings'], pendingTurns: [
      { id: 'q1', source: 'supervisor', text: 'note', timestamp: '2026-10-01T00:00:02Z', budgetStarted: true } as unknown as PendingPlanTurn,
    ] }), { researchBudget: { tasks: 2, reports: 1 } });
    Object.assign(task, { researchWait: 'a report still owed' });

    migrateLoadedPlan(loaded);

    expect(loaded).not.toHaveProperty('researchBudget');
    expect(loaded.runSettings).toEqual({ mergeAtGatesAutomatically: false, supervisorLevel: 'watch' });
    expect(loaded.pendingTurns?.[0]).not.toHaveProperty('budgetStarted');
    expect(loaded.tasks[0]).not.toHaveProperty('researchWait');
  });

  it('carries a queued mid-run edit over as a pending user turn', () => {
    const skill = { invokedBy: 'user' as const, name: 'tdd', source: 'workspace' as const, path: '/repo/.ordewell/skills/tdd/SKILL.md', content: '# TDD' };
    const loaded = plan({
      pendingTurns: [{ id: 'q0', source: 'user', text: 'already waiting', timestamp: '2026-10-01T00:00:01Z' }],
      queuedMessages: [{ id: 'q1', text: 'add tests', timestamp: '2026-10-01T00:00:02Z', skills: [skill] }],
    });

    migrateLoadedPlan(loaded);

    expect(loaded.queuedMessages).toBeUndefined();
    expect(loaded.pendingTurns).toEqual([
      { id: 'q0', source: 'user', text: 'already waiting', timestamp: '2026-10-01T00:00:01Z' },
      { id: 'q1', source: 'user', text: 'add tests', timestamp: '2026-10-01T00:00:02Z', skills: [skill] },
    ]);
  });

  it('changes nothing on a plan already in today’s shape', () => {
    const loaded = plan({ status: 'approved', tasks: [createTask({ id: 't1', title: 'Build' })] });
    migrateLoadedPlan(loaded);
    const once = structuredClone(loaded);

    migrateLoadedPlan(loaded);

    expect(loaded).toEqual(once);
  });
});
