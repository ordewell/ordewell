import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { createEmptyPlan, createTask, migrateLoadedPlan, type LegacyPlanState, type PendingPlanTurn, type Task } from '../Task';
import { EXECUTION_FIELDS } from '../TaskExecution';
import { checkPlanInvariants } from '../../services/PlannedTask';
import { prepareTaskEdit } from '../../services/TaskEdit';

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

  it('keeps the execution state a later retry or rearm is decided from, but for a pause’s reset time', () => {
    const ran: Task = {
      ...createTask({ id: 't1', title: 'Build', status: 'awaiting_user', awaitingReason: 'usage-limit', assignedRunner: 'claude-code' }),
      verdict: { outcome: 'fail', reason: 'broke', checks: [], decidedAt: '2026-10-01T00:00:00Z' },
      handoff: { summary: 'It broke.', findings: [], findingCount: 0 },
      runnerSessionId: 'session-1',
      runnerSessionOwner: 'claude-code',
      parkedQuestion: 'Which database?',
      waitsEnded: 2,
      resumeAt: '2026-10-11T20:11:00.000Z',
      carriedFrom: 'codex',
      reverted: true,
      forcedPastGate: ['Earlier work'],
      attempted: true,
      loopRound: 2,
    };
    const loaded = plan({ tasks: [structuredClone(ran)] });

    migrateLoadedPlan(loaded);

    for (const field of EXECUTION_FIELDS) expect(loaded.tasks[0][field], field).toEqual(field === 'resumeAt' ? undefined : ran[field]);
  });

  it('changes nothing on a plan already in today’s shape', () => {
    const loaded = plan({ status: 'approved', tasks: [createTask({ id: 't1', title: 'Build' })] });
    migrateLoadedPlan(loaded);
    const once = structuredClone(loaded);

    migrateLoadedPlan(loaded);

    expect(loaded).toEqual(once);
  });

  // Bug: an older direct edit stored "manual" or null as a task's type, and the next plan check or edit threw a TypeError reading the kind table.
  it.each<[string, unknown]>([['a type no kind owns', 'manual'], ['a cleared type', null], ['no type', undefined]])(
    'reads %s as an AI task, so the plan checks and edits it',
    (_name, type) => {
      const stored = createTask({ id: 't', title: 'T', prompt: 'Do it.', assignedRunner: 'claude-code', subtasks: [createTask({ id: 't.1', title: 'Sub' })] });
      Object.assign(stored, { type });
      Object.assign(stored.subtasks[0], { type });
      const loaded = plan({ tasks: [stored] });

      migrateLoadedPlan(loaded);

      expect(loaded.tasks[0].type).toBe('ai');
      expect(loaded.tasks[0].subtasks[0].type).toBe('ai');
      expect(checkPlanInvariants(loaded.tasks, ['claude-code'])).toEqual([]);
      expect(prepareTaskEdit('planner', loaded.tasks, 't', { title: 'T2' }, { modelsByRunner: {} })).toMatchObject({ ok: true });
    },
  );
});
