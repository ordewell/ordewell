import { describe, it, expect, vi } from 'vitest';
import { PlanEditor, type PlanEditCatalog } from '../PlanEditor';
import { PlanEditError } from '../PlanEditError';
import { PlanStore } from '../PlanStore';
import type { RunnerCatalog } from '../TaskRetarget';
import type { SessionMessage } from '../SessionMessage';
import type { SkillInfo } from '../SkillsService';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { createTask, type DiscoveredModel, type LegacyPlanState, type RunnerId, type Task } from '../../models/Task';

const model = (modelId: string, variants: string[] = []): DiscoveredModel =>
  ({ modelId, modelLabel: modelId, variants: variants.map((id) => ({ id, label: id })) });

const CATALOGS: Record<RunnerId, RunnerCatalog> = {
  'claude-code': {
    models: [model('claude-sonnet-4-5', ['low', 'high']), model('claude-haiku-4-5')],
    modes: [{ id: 'build', label: 'Build', description: '' }, { id: 'acceptEdits', label: 'Accept edits', description: '' }],
    defaultMode: 'build',
  },
  codex: {
    models: [model('gpt-5-codex', ['low', 'high']), model('gpt-5-mini')],
    modes: [{ id: 'agent', label: 'Agent', description: '' }, { id: 'fullAccess', label: 'Full access', description: '', autonomous: true }],
    defaultMode: 'fullAccess',
  },
};

function tasks(): Task[] {
  return [
    createTask({ id: 't1', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet' } }),
    createTask({ id: 't2', order: 2, title: 'Build', prompt: 'build', assignedRunner: 'claude-code', dependencies: ['t1'] }),
  ];
}

/**
 * An editor over a real PlanStore and a plain plan object. The mutation seam
 * is the session's contract in miniature — the op runs, and only a change is
 * saved and announced — so what the editor hands it is all that is asserted.
 */
function setup(opts: { plan?: boolean; allowlist?: Partial<Record<RunnerId, string[]>>; catalogs?: Record<RunnerId, RunnerCatalog>; run?: IsolationRun | null; skills?: SkillInfo[] } = {}) {
  const store = new PlanStore();
  const now = '2026-01-01T00:00:00Z';
  const plan: LegacyPlanState | null = opts.plan === false ? null : { tasks: [], generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
  store.load(tasks(), ['claude-code']);
  const events: string[] = [];
  const sent: SessionMessage[] = [];
  const remembered: Partial<Record<RunnerId, DiscoveredModel[]>> = {};
  const catalogs = opts.catalogs ?? CATALOGS;
  const catalog: PlanEditCatalog = {
    edit: () => ({ modelsByRunner: { 'claude-code': CATALOGS['claude-code'].models }, runnerModes: { 'claude-code': CATALOGS['claude-code'].modes } }),
    runner: vi.fn(async (runner: RunnerId) => catalogs[runner] ?? { models: [], modes: [] }),
    allowlistFor: (runner) => opts.allowlist?.[runner],
    models: () => ({ ...remembered }),
    admit: vi.fn((runner: RunnerId, models: DiscoveredModel[]) => { if (models.length > 0) remembered[runner] = models; }),
  };
  const mutate = vi.fn((op: () => boolean, notify?: () => void) => {
    if (!plan) return null;
    if (!op()) return null;
    events.push('saved');
    if (notify) notify();
    else events.push('plan announced');
    return plan;
  });
  const scheduler = {
    tick: vi.fn(async () => { events.push('tick'); }),
    releaseTask: vi.fn(async (taskId: string) => { events.push(`release:${taskId}`); }),
  };
  const runs = { current: opts.run ?? null, linkResolver: vi.fn() };
  const plannerTools = vi.fn(() => false);
  const notice = vi.fn();
  const editor = new PlanEditor({
    store,
    plan: () => plan,
    catalog,
    mutate,
    scheduler,
    runs,
    broadcast: (m) => { sent.push(m); events.push(m.type); },
    plannerTools,
    taskSkills: () => ({ findSkill: (name) => opts.skills?.find((s) => s.name === name), searchedDirs: () => [] }),
    notice,
  });
  const task = (id: string) => store.get(id);
  return { editor, store, plan, events, sent, catalog, mutate, scheduler, runs, plannerTools, notice, task };
}

describe('PlanEditor.updateTask', () => {
  it('refuses a planner skill on a task and warns, once the edit lands, about a name not found', async () => {
    const skill = (name: string, appliesTo: SkillInfo['appliesTo']): SkillInfo => ({
      name, description: name, metadata: { name, description: name }, content: '', path: `/g/${name}/SKILL.md`, source: 'global', appliesTo, modelInvocable: false, userInvocable: true,
    });
    const { editor, task, notice, mutate } = setup({ skills: [skill('tdd', 'task'), skill('grilling', 'planner')] });

    await expect(editor.updateTask('t2', { skills: ['tdd', 'grilling'] })).rejects.toThrow(PlanEditError);
    expect(mutate).not.toHaveBeenCalled();

    await editor.updateTask('t2', { skills: ['tdd', 'later'] });
    expect(task('t2')!.skills).toEqual(['tdd', 'later']);
    expect(notice).toHaveBeenCalledWith('warn', expect.stringContaining('Task "Build": skill "later" not found'));
  });

  it('lands a patch, announces it as task_updated, then reschedules', async () => {
    const { editor, events, sent, task } = setup();

    await editor.updateTask('t2', { title: 'Build it' });

    expect(task('t2')!.title).toBe('Build it');
    expect(sent).toEqual([{ type: 'task_updated', taskId: 't2', changes: { title: 'Build it' } }]);
    expect(events).toEqual(['saved', 'task_updated', 'tick']);
  });

  it('stores hand-set skills trimmed and deduplicated, and none as absent', async () => {
    const { editor, task } = setup();

    await editor.updateTask('t2', { skills: [' tdd ', 'tdd', 'api'] });
    expect(task('t2')!.skills).toEqual(['tdd', 'api']);

    await editor.updateTask('t2', { skills: [] });
    expect(task('t2')!.skills).toBeUndefined();
  });

  it('refuses an incoherent patch before anything lands, saying why', async () => {
    const { editor, mutate, scheduler, task } = setup();

    const refused = editor.updateTask('t1', { dependencies: ['t2'] });

    await expect(refused).rejects.toThrow(/comes after it/);
    await expect(refused).rejects.toBeInstanceOf(PlanEditError);
    expect(mutate).not.toHaveBeenCalled();
    expect(scheduler.tick).not.toHaveBeenCalled();
    expect(task('t1')!.dependencies).toEqual([]);
  });

  it('refuses a model the runner does not offer', async () => {
    const { editor } = setup();

    await expect(editor.updateTask('t1', { assignedModel: { modelId: 'gpt-9', modelLabel: 'GPT-9' } })).rejects.toThrow(/claude-code/);
  });

  it('answers null for a task not in the plan, and does not reschedule', async () => {
    const { editor, scheduler, sent } = setup();

    expect(await editor.updateTask('ghost', { dependencies: ['t1'] })).toBeNull();
    expect(scheduler.tick).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('clears the fields a flip to MAN strips of meaning, in the plan and in what it announces', async () => {
    const { editor, sent, task } = setup();

    await editor.updateTask('t1', { type: 'user', userSteps: [{ order: 1, instruction: 'by hand', completed: false }] });

    expect(task('t1')!.assignedModel).toBeUndefined();
    expect(task('t1')!.taskMode).toBeUndefined();
    const [update] = sent;
    expect(update.type === 'task_updated' && Object.keys(update.changes).sort()).toEqual(['assignedModel', 'taskMode', 'type', 'userSteps']);
  });

  it('stores an ops flag turned off as absent', async () => {
    const { editor, store, task } = setup();
    store.update('t2', { ops: true });

    await editor.updateTask('t2', { ops: false });

    expect(task('t2')).not.toHaveProperty('ops', false);
    expect(task('t2')!.ops).toBeUndefined();
  });
});

describe('PlanEditor.setTaskDependencies', () => {
  it('replaces the list under the same guard as a field patch', async () => {
    const { editor, task } = setup();

    await editor.setTaskDependencies('t2', []);
    expect(task('t2')!.dependencies).toEqual([]);

    await expect(editor.setTaskDependencies('t1', ['t2'])).rejects.toThrow(/comes after it/);
  });

  it('answers null without a plan', async () => {
    const { editor, mutate } = setup({ plan: false });

    expect(await editor.setTaskDependencies('t2', [])).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('PlanEditor.setTaskRunner', () => {
  it('re-derives the model and mode from the new runner, and admits it to the plan', async () => {
    const { editor, plan, store, catalog, task, events } = setup();

    await editor.setTaskRunner('t1', 'codex');

    expect(task('t1')).toMatchObject({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5-codex' }, taskMode: 'fullAccess' });
    expect(plan!.runners).toEqual(['claude-code', 'codex']);
    expect(store.planRunners).toContain('codex');
    expect(catalog.admit).toHaveBeenCalledWith('codex', CATALOGS.codex.models);
    expect(events).toEqual(['saved', 'plan announced', 'tick']);
  });

  it('derives from the allowlist, but remembers everything the runner offers', async () => {
    const { editor, catalog, task } = setup({ allowlist: { codex: ['gpt-5-mini'] } });

    await editor.setTaskRunner('t1', 'codex');

    expect(task('t1')!.assignedModel!.modelId).toBe('gpt-5-mini');
    expect(catalog.admit).toHaveBeenCalledWith('codex', CATALOGS.codex.models);
  });

  it('ignores an allowlist that names nothing the runner offers', async () => {
    const { editor, task } = setup({ allowlist: { codex: ['claude-sonnet-4-5'] } });

    await editor.setTaskRunner('t1', 'codex');

    expect(task('t1')!.assignedModel!.modelId).toBe('gpt-5-codex');
  });

  it('never asks discovery for a re-pick of the same runner, or for a manual task', async () => {
    const { editor, store, plan, catalog, mutate } = setup();
    store.update('t2', { type: 'user', userSteps: [{ order: 1, instruction: 'by hand', completed: false }] });

    expect(await editor.setTaskRunner('t1', 'claude-code')).toBe(plan);
    expect(await editor.setTaskRunner('t2', 'codex')).toBe(plan);

    expect(catalog.runner).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('keeps nothing in the remembered catalog when discovery found nothing', async () => {
    const { editor, catalog, task } = setup({ catalogs: { codex: { models: [], modes: CATALOGS.codex.modes, defaultMode: 'fullAccess' } } });

    await editor.setTaskRunner('t1', 'codex');

    expect(task('t1')).toMatchObject({ assignedRunner: 'codex', assignedModel: { modelId: 'claude-sonnet-4-5' } });
    expect(catalog.models()).toEqual({});
  });

  it('answers null for a task not in the plan, or without a plan', async () => {
    expect(await setup().editor.setTaskRunner('ghost', 'codex')).toBeNull();
    expect(await setup({ plan: false }).editor.setTaskRunner('t1', 'codex')).toBeNull();
  });
});

describe('PlanEditor.addTask', () => {
  it('fills in a runnable assignment on the plan\'s first runner', async () => {
    const { editor, store } = setup();

    await editor.addTask({ title: 'Docs', prompt: 'write docs' });

    expect(store.planTasks.at(-1)).toMatchObject({ title: 'Docs', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4-5' }, taskMode: 'build' });
  });

  it('keeps what the caller chose where the runner offers it, and drops dependencies on tasks that are gone', async () => {
    const { editor, store } = setup();

    await editor.addTask({ title: 'Docs', assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku' }, dependencies: ['t1', 'ghost'] });

    expect(store.planTasks.at(-1)).toMatchObject({ assignedModel: { modelId: 'claude-haiku-4-5' }, dependencies: ['t1'] });
  });

  it('admits an explicit runner into the plan', async () => {
    const { editor, plan } = setup();

    await editor.addTask({ title: 'Docs', prompt: 'write docs', assignedRunner: 'codex' });

    expect(plan!.runners).toEqual(['claude-code', 'codex']);
  });

  it('asks no catalog for a manual task', async () => {
    const { editor, catalog, store } = setup();

    await editor.addTask({ title: 'Sign off', type: 'user' });

    expect(catalog.runner).not.toHaveBeenCalled();
    expect(store.planTasks.at(-1)!.assignedModel).toBeUndefined();
  });

  it('reschedules once the task has landed', async () => {
    const { editor, events } = setup();

    await editor.addTask({ title: 'Docs', prompt: 'write docs' });

    expect(events).toEqual(['saved', 'plan announced', 'tick']);
  });
});

describe('PlanEditor.removeTask', () => {
  it('releases the task\'s runner before dropping it, and detaches its dependents', async () => {
    const { editor, events, task } = setup();

    await editor.removeTask('t1');

    expect(events).toEqual(['release:t1', 'saved', 'plan announced', 'tick']);
    expect(task('t1')).toBeUndefined();
    expect(task('t2')!.dependencies).toEqual([]);
  });

  it('releases nothing for a task not in the plan', async () => {
    const { editor, scheduler } = setup();

    expect(await editor.removeTask('ghost')).toBeNull();
    expect(scheduler.releaseTask).not.toHaveBeenCalled();
  });
});

describe('PlanEditor.addConflictResolver', () => {
  const conflicted: IsolationRun = {
    id: 'run1', workspaceRoot: '/repo', shared: [], sharedRepos: [],
    repos: [{ path: '.', root: '/repo', baseRef: 'abc', integrationBranch: 'ordewell/run1/integration' }],
    tasks: {
      t1: { taskId: 't1', order: 1, title: 'Setup', branch: 'ordewell/run1/1-t1', workspace: '/wt/1', status: 'conflict', conflictRepo: '.', repos: { '.': { worktree: '/wt/1', linked: [] } } },
    },
  };

  it('adds a task on the conflicted task\'s runner and model, and links it to the conflict', async () => {
    const { editor, store, runs, events } = setup({ run: conflicted });

    await editor.addConflictResolver('t1');

    const resolver = store.planTasks.at(-1)!;
    expect(resolver).toMatchObject({ title: 'Resolve merge conflict: Setup', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4-5' }, dependencies: [] });
    expect(resolver.prompt).toContain('ordewell/run1/1-t1');
    expect(runs.linkResolver).toHaveBeenCalledWith(resolver.id, 't1');
    expect(events).toEqual(['saved', 'plan announced', 'tick']);
  });

  it('refuses a task that did not conflict, or a plan with no run', async () => {
    await expect(setup({ run: conflicted }).editor.addConflictResolver('t2')).rejects.toBeInstanceOf(PlanEditError);
    await expect(setup().editor.addConflictResolver('t1')).rejects.toThrow(/conflicted/);
  });

  it('answers null without a plan', async () => {
    expect(await setup({ plan: false, run: conflicted }).editor.addConflictResolver('t1')).toBeNull();
  });
});

describe('PlanEditor merge and split requests', () => {
  it('words a merge of compatible tasks for the planner', () => {
    const { editor, plannerTools } = setup();

    const prompt = editor.mergeRequest(['t1', 't2']);

    expect(prompt).toContain('id=t1');
    expect(prompt).toContain('id=t2');
    expect(plannerTools).toHaveBeenCalled();
  });

  it('words a split for the planner', () => {
    const { editor } = setup();

    expect(editor.splitRequest('t2')).toContain('Split task #2 "Build"');
  });

  it('refuses before the planner is consulted at all', () => {
    const { editor, plannerTools } = setup();

    expect(() => editor.mergeRequest(['t1'])).toThrow(/at least two/i);
    expect(() => editor.splitRequest('ghost')).toThrow('Task not found');
    expect(plannerTools).not.toHaveBeenCalled();
  });

  it('refuses without a plan', () => {
    const { editor } = setup({ plan: false });

    expect(() => editor.mergeRequest(['t1', 't2'])).toThrow('No active plan state');
    expect(() => editor.splitRequest('t1')).toThrow('No active plan state');
  });
});

describe('PlanEditor.admitRunner', () => {
  it('adds a runner once, and remembers only a catalog discovery filled', () => {
    const { editor, plan, catalog } = setup();

    editor.admitRunner('codex', []);
    editor.admitRunner('codex', CATALOGS.codex.models);

    expect(plan!.runners).toEqual(['claude-code', 'codex']);
    expect(catalog.models()).toEqual({ codex: CATALOGS.codex.models });
  });
});
