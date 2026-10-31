import { describe, it, expect, vi } from 'vitest';
import { PlanEditor, type PlanEditCatalog } from '../PlanEditor';
import { PlanEditError } from '../PlanEditError';
import { PlanStore } from '../PlanStore';
import type { RunnerCatalog } from '../TaskAssignment';
import type { SessionMessage } from '../SessionMessage';
import type { SkillInfo } from '../SkillsService';
import type { SkillLookup } from '../taskSkills';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { createTask, type DiscoveredModel, type LegacyPlanState, type RunnerId, type Task } from '../../models/Task';

const model = (modelId: string, variants: string[] = []): DiscoveredModel =>
  ({ modelId, modelLabel: modelId, variants: variants.map((id) => ({ id, label: id })) });

const CATALOGS: Record<RunnerId, RunnerCatalog> = {
  'claude-code': {
    models: [model('claude-sonnet-4-5', ['low', 'high']), model('claude-haiku-4-5')],
    modes: [{ id: 'build', label: 'Build', description: '', autonomous: true }, { id: 'acceptEdits', label: 'Accept edits', description: '' }],
  },
  codex: {
    models: [model('gpt-5-codex', ['low', 'high']), model('gpt-5-mini')],
    modes: [{ id: 'agent', label: 'Agent', description: '' }, { id: 'fullAccess', label: 'Full access', description: '', autonomous: true }],
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
function setup(opts: { tasks?: Task[]; plan?: boolean; allowlist?: Partial<Record<RunnerId, string[]>>; catalogs?: Record<RunnerId, RunnerCatalog>; run?: IsolationRun | null; skills?: SkillInfo[]; uncommitted?: SkillLookup['uncommitted']; live?: (taskId: string) => boolean; plannedWith?: () => boolean } = {}) {
  const store = new PlanStore();
  const now = '2026-01-01T00:00:00Z';
  const plan: LegacyPlanState | null = opts.plan === false ? null : { tasks: [], generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
  store.load(opts.tasks ?? tasks(), ['claude-code']);
  const events: string[] = [];
  const sent: SessionMessage[] = [];
  const remembered: Partial<Record<RunnerId, DiscoveredModel[]>> = {};
  const catalogs = opts.catalogs ?? CATALOGS;
  const catalog: PlanEditCatalog = {
    edit: () => ({
      modelsByRunner: { 'claude-code': CATALOGS['claude-code'].models, ...remembered },
      runnerModes: { 'claude-code': CATALOGS['claude-code'].modes },
      ...(opts.allowlist ? { perRunnerAllowlist: opts.allowlist } : {}),
      ...(opts.live ? { liveRunner: opts.live } : {}),
    }),
    runner: vi.fn(async (runner: RunnerId) => catalogs[runner] ?? { models: [], modes: [] }),
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
    releaseMovedResume: (_taskId: string, changes: Partial<Task>) => changes,
    tick: vi.fn(async () => { events.push('tick'); }),
    releaseTask: vi.fn(async (taskId: string) => { events.push(`release:${taskId}`); }),
    planEdited: vi.fn(),
    resolverRefusal: vi.fn((): string | null => null),
    startWhenAllowed: vi.fn(),
  };
  const runs = { current: opts.run ?? null, linkResolver: vi.fn() };
  const notice = vi.fn();
  const approve = vi.fn<(ids: readonly string[]) => void>();
  const editor = new PlanEditor({
    store,
    plan: () => plan,
    catalog,
    mutate,
    scheduler,
    runs,
    broadcast: (m) => { sent.push(m); events.push(m.type); },
    taskSkills: () => ({ findSkill: (name) => opts.skills?.find((s) => s.name === name), searchedDirs: () => [], uncommitted: opts.uncommitted }),
    notice,
    approve,
    ...(opts.plannedWith ? { plannedWith: opts.plannedWith } : {}),
  });
  const task = (id: string) => store.get(id);
  return { editor, store, plan, events, sent, catalog, remembered, mutate, scheduler, runs, notice, approve, task };
}

describe('PlanEditor.updateTask', () => {
  it('edits a subtask\'s dependencies, model and ops flag, checking dependencies across the plan', async () => {
    const withSubtasks = tasks();
    withSubtasks[1].subtasks = [
      createTask({ id: 's1', order: 1, title: 'Compile', prompt: 'compile', assignedRunner: 'claude-code' }),
      createTask({ id: 's2', order: 2, title: 'Bundle', prompt: 'bundle', assignedRunner: 'claude-code' }),
    ];
    const { editor, task } = setup({ tasks: withSubtasks });

    await editor.updateTask('s2', { dependencies: ['s1'], assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku' } });
    expect(task('s2')!.dependencies).toEqual(['s1']);
    expect(task('s2')!.assignedModel?.modelId).toBe('claude-haiku-4-5');

    await expect(editor.updateTask('s1', { dependencies: ['s2'] })).rejects.toThrow(/cycle/i);
    await expect(editor.updateTask('s1', { ops: true })).rejects.toThrow('subtask');
  });

  // Bug: the flip derived nothing, so the task ran on the legacy `build` default and its runner's own model.
  it('gives a manual task turned into an AI task the mode and model the planner path would', async () => {
    const manual = createTask({ id: 'm1', order: 3, title: 'Sign off', type: 'user', userSteps: [{ order: 1, instruction: 'by hand', completed: false }], assignedRunner: 'codex' });
    const { editor, task } = setup({ tasks: [...tasks(), manual] });

    await editor.updateTask('m1', { type: 'ai', prompt: 'sign it off' });

    expect(task('m1')).toMatchObject({ type: 'ai', taskMode: 'fullAccess', assignedModel: { modelId: 'gpt-5-codex' } });
  });

  // Bug: the runner moved in one save and the rest in a second, unchecked, which the first save's reschedule could start the task ahead of.
  it('lands a runner change sent with other fields as one save, checked before the task can start', async () => {
    let live = false;
    const { editor, events, task, scheduler } = setup({ live: () => live });
    // A reschedule after a save is what starts a ready task.
    scheduler.tick.mockImplementation(async () => { events.push('tick'); live = true; });

    await editor.updateTask('t1', { assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5-mini', modelLabel: 'Mini' }, title: 'Set up' });

    expect(task('t1')).toMatchObject({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5-mini' }, title: 'Set up', taskMode: 'fullAccess' });
    expect(events).toEqual(['saved', 'plan announced', 'tick']);
  });

  it('refuses a move whose task started while its new runner was being discovered', async () => {
    let live = false;
    const { editor, catalog, task, mutate } = setup({ live: () => live });
    vi.mocked(catalog.runner).mockImplementationOnce(async () => { live = true; return CATALOGS.codex; });

    await expect(editor.updateTask('t1', { assignedRunner: 'codex', title: 'Set up' })).rejects.toThrow('"Setup" has a live runner, so its runner cannot change now: stop the task first');
    expect(mutate).not.toHaveBeenCalled();
    expect(task('t1')).toMatchObject({ assignedRunner: 'claude-code', title: 'Setup' });
  });

  // The card offers its editors only on a task that has not started. The
  // wider direct path keeps its contract, where a live task's prompt can still
  // be changed; this is the card's own narrower precondition.
  it('refuses a card edit to a task whose runner is live, while a direct edit of its prompt still lands', async () => {
    const { editor, task, mutate } = setup({ live: () => true });

    await expect(editor.updateTask('t1', { prompt: 'do it differently' }, { requireUnstarted: true }))
      .rejects.toThrow(/"Setup" started before this change was saved, so it was not changed/);
    expect(mutate).not.toHaveBeenCalled();
    expect(task('t1')!.prompt).toBe('setup');

    await editor.updateTask('t1', { prompt: 'do it differently' });
    expect(task('t1')!.prompt).toBe('do it differently');
  });

  it('refuses a card edit whose task started while its new runner was being discovered, changing nothing', async () => {
    const { editor, store, task, mutate, catalog } = setup();
    vi.mocked(catalog.runner).mockImplementationOnce(async () => {
      store.update('t1', { status: 'in_progress' });
      return CATALOGS.codex;
    });

    await expect(editor.updateTask('t1', { assignedRunner: 'codex', title: 'Set up' }, { requireUnstarted: true }))
      .rejects.toThrow(/"Setup" started before this change was saved, so it was not changed/);
    expect(mutate).not.toHaveBeenCalled();
    expect(task('t1')).toMatchObject({ assignedRunner: 'claude-code', title: 'Setup', status: 'in_progress' });
  });

  const skill = (name: string, appliesTo: SkillInfo['appliesTo']): SkillInfo => ({
    name, description: name, metadata: { name, description: name }, content: '', path: `/g/${name}/SKILL.md`, source: 'global', appliesTo, modelInvocable: false, userInvocable: true,
  });

  it('refuses a planner skill on a task and warns, once the edit lands, about a name not found', async () => {
    const { editor, task, notice, mutate } = setup({ skills: [skill('tdd', 'task'), skill('grilling', 'planner')] });

    await expect(editor.updateTask('t2', { skills: ['tdd', 'grilling'] })).rejects.toThrow(PlanEditError);
    expect(mutate).not.toHaveBeenCalled();

    await editor.updateTask('t2', { skills: ['tdd', 'later'] });
    expect(task('t2')!.skills).toEqual(['tdd', 'later']);
    expect(notice).toHaveBeenCalledWith('warn', expect.stringContaining('Task "Build": skill "later" not found'));
  });

  // The git check behind each edit can answer out of order: the first edit's
  // is released last here, and must still not overwrite the second.
  it('commits two quick skill edits to one task in the order they were made', async () => {
    const pending: (() => void)[] = [];
    const { editor, task, sent } = setup({
      skills: [skill('a', 'task'), skill('b', 'task')],
      uncommitted: () => new Promise((resolve) => pending.push(() => resolve(new Map()))),
    });
    const releaseNewest = async () => {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.pop()!();
    };

    const first = editor.updateTask('t2', { skills: ['a'] });
    const second = editor.updateTask('t2', { skills: ['a', 'b'] });
    await releaseNewest();
    await releaseNewest();
    await Promise.all([first, second]);

    expect(sent.map((m) => m.type === 'task_updated' && m.changes.skills)).toEqual([['a'], ['a', 'b']]);
    expect(task('t2')!.skills).toEqual(['a', 'b']);
  });

  it('runs the next edit to a task after one that was refused', async () => {
    const { editor, task } = setup({ skills: [skill('a', 'task'), skill('grilling', 'planner')] });

    const refused = editor.updateTask('t2', { skills: ['grilling'] });
    const next = editor.updateTask('t2', { skills: ['a'] });

    await expect(refused).rejects.toThrow(PlanEditError);
    await next;
    expect(task('t2')!.skills).toEqual(['a']);
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

    await expect(refused).rejects.toThrow(/cycle/i);
    await expect(refused).rejects.toBeInstanceOf(PlanEditError);
    expect(mutate).not.toHaveBeenCalled();
    expect(scheduler.tick).not.toHaveBeenCalled();
    expect(task('t1')!.dependencies).toEqual([]);
  });

  it('refuses a model the runner does not offer', async () => {
    const { editor } = setup();

    await expect(editor.updateTask('t1', { assignedModel: { modelId: 'gpt-9', modelLabel: 'GPT-9' } })).rejects.toThrow(/claude-code/);
  });

  // A bare runner write would leave the task on a model, effort and mode its old runner scoped.
  it('moves a runner patched as a field the way the runner picker does, re-deriving what it scopes', async () => {
    const { editor, plan, task } = setup();

    await editor.updateTask('t1', { assignedRunner: 'codex' });

    expect(task('t1')).toMatchObject({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5-codex' }, taskMode: 'fullAccess' });
    expect(plan!.runners).toEqual(['claude-code', 'codex']);
  });

  it('lets a model named beside the runner win over the one the move derives, and lands the rest of the patch', async () => {
    const { editor, task } = setup();

    await editor.updateTask('t1', { assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5-mini', modelLabel: 'gpt-5-mini' }, title: 'Set up' });

    expect(task('t1')).toMatchObject({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5-mini' }, taskMode: 'fullAccess', title: 'Set up' });
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
    expect(task('t1')!.sliceType).toBe('HITL');
    const [update] = sent;
    expect(update.type === 'task_updated' && Object.keys(update.changes).sort()).toEqual(['assignedModel', 'sliceType', 'taskMode', 'type', 'userSteps']);
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

    await editor.setTaskDependencies('t1', ['t2']);
    expect(task('t1')!.dependencies).toEqual(['t2']);
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

  // Only Claude Code lists the model, so it provably cannot run on Codex: the runner's own default stands in.
  it('unassigns a model only the old runner lists, and keeps nothing remembered, when discovery found nothing', async () => {
    const { editor, remembered, task, notice } = setup({ catalogs: { codex: { models: [], modes: CATALOGS.codex.modes } } });

    await editor.setTaskRunner('t1', 'codex');

    expect(task('t1')).toMatchObject({ assignedRunner: 'codex', assignedModel: undefined });
    expect(notice).toHaveBeenCalledWith('info', 'Task "Setup": model claude-sonnet-4-5 → none.');
    expect(remembered).toEqual({});
  });

  it('answers null for a task not in the plan, or without a plan', async () => {
    expect(await setup().editor.setTaskRunner('ghost', 'codex')).toBeNull();
    expect(await setup({ plan: false }).editor.setTaskRunner('t1', 'codex')).toBeNull();
  });
});

describe('PlanEditor.addTask', () => {
  it('approves a task the user adds, before the reschedule that may start it (ADR-0035)', async () => {
    const { editor, store, approve, scheduler } = setup();

    await editor.addTask({ title: 'Docs', prompt: 'write docs' });

    expect(approve).toHaveBeenCalledWith([store.planTasks.at(-1)!.id]);
    expect(approve.mock.invocationCallOrder[0]).toBeLessThan(scheduler.tick.mock.invocationCallOrder.at(-1)!);
  });

  // Bug: the model was swapped for the allowlist's with nothing said.
  it('replaces a model the allowlist excludes, carrying its effort, and tells the user', async () => {
    const { editor, store, notice } = setup({ allowlist: { 'claude-code': ['claude-haiku-4-5'] } });

    await editor.addTask({ title: 'Docs', prompt: 'write docs', assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'high' } });

    expect(store.planTasks.at(-1)!.assignedModel?.modelId).toBe('claude-haiku-4-5');
    expect(notice).toHaveBeenCalledWith('info', 'Task "Docs": model claude-sonnet-4-5 → claude-haiku-4-5, effort high → none.');
  });

  it('says nothing of a model it filled in where the user named none', async () => {
    const { editor, notice } = setup();

    await editor.addTask({ title: 'Docs', prompt: 'write docs' });

    expect(notice).not.toHaveBeenCalled();
  });

  it('fills in a runnable assignment on the plan\'s first runner', async () => {
    const { editor, store } = setup();

    await editor.addTask({ title: 'Docs', prompt: 'write docs' });

    expect(store.planTasks.at(-1)).toMatchObject({ title: 'Docs', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4-5' }, taskMode: 'acceptEdits' });
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

  it('asks the scheduler to start what it added, which a run with no scheduler would not', async () => {
    const { editor, store, scheduler } = setup({ run: conflicted });

    await editor.addConflictResolver('t1');

    expect(scheduler.startWhenAllowed).toHaveBeenCalledWith(store.planTasks.at(-1)!.id);
  });

  it('adds nothing when the scheduler says the conflict has its worker, in its words', async () => {
    const { editor, store, scheduler, runs } = setup({ run: conflicted });
    const before = store.planTasks.length;
    scheduler.resolverRefusal.mockReturnValue('Task "Setup" waits to repair its conflict.');

    await expect(editor.addConflictResolver('t1')).rejects.toThrow('waits to repair its conflict');

    expect(store.planTasks).toHaveLength(before);
    expect(runs.linkResolver).not.toHaveBeenCalled();
    expect(scheduler.startWhenAllowed).not.toHaveBeenCalled();
  });

  it('writes the resolver\'s merge message with the Planned-with trailer when the setting is on', async () => {
    const { editor, store } = setup({ run: conflicted, plannedWith: () => true });

    await editor.addConflictResolver('t1');

    expect(store.planTasks.at(-1)!.prompt).toContain("-m 'Merge: Setup (resolve conflicts with integration)' -m 'Planned-with: Ordewell'");
  });

  it('refuses a task that did not conflict, or a plan with no run', async () => {
    await expect(setup({ run: conflicted }).editor.addConflictResolver('t2')).rejects.toBeInstanceOf(PlanEditError);
    await expect(setup().editor.addConflictResolver('t1')).rejects.toThrow(/conflicted/);
  });

  it('answers null without a plan', async () => {
    expect(await setup({ plan: false, run: conflicted }).editor.addConflictResolver('t1')).toBeNull();
  });
});

describe('PlanEditor.admitRunner', () => {
  it('adds a runner once, and remembers only a catalog discovery filled', () => {
    const { editor, plan, remembered } = setup();

    editor.admitRunner('codex', []);
    editor.admitRunner('codex', CATALOGS.codex.models);

    expect(plan!.runners).toEqual(['claude-code', 'codex']);
    expect(remembered).toEqual({ codex: CATALOGS.codex.models });
  });
});

describe('PlanEditor.followRunnerModel', () => {
  const live = () => true;
  const withEffort = (effort?: string) => [
    createTask({ id: 't1', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku', ...(effort ? { thinkingEffort: effort } : {}) } }),
    createTask({ id: 'u1', order: 2, title: 'By hand', prompt: '', type: 'user' }),
  ];

  it('writes a model discovery lists as a visible edit, with its label and variants', async () => {
    const { editor, catalog, task, sent } = setup({ tasks: withEffort() });
    catalog.admit('claude-code', CATALOGS['claude-code'].models);

    await editor.followRunnerModel('t1', { model: 'claude-sonnet-4-5', label: 'ignored' }, 'low', live);

    expect(task('t1')?.assignedModel).toEqual({ modelId: 'claude-sonnet-4-5', modelLabel: 'claude-sonnet-4-5', thinkingEffort: 'low', availableVariants: ['low', 'high'] });
    expect(sent.map((m) => m.type)).toEqual(['task_updated']);
  });

  it('keeps the plan\'s effort when the runner reported none, clamped to the new model', async () => {
    const { editor, catalog, task } = setup({ tasks: withEffort('high') });
    catalog.admit('claude-code', CATALOGS['claude-code'].models);

    await editor.followRunnerModel('t1', { model: 'claude-sonnet-4-5' }, undefined, live);
    expect(task('t1')?.assignedModel?.thinkingEffort).toBe('high');

    await editor.followRunnerModel('t1', { model: 'claude-haiku-4-5' }, undefined, live);
    expect(task('t1')?.assignedModel?.thinkingEffort).toBeUndefined();
  });

  it('writes a model off the allowlist and unlisted by the runner\'s own label, else its id, with no effort', async () => {
    const { editor, task } = setup({ tasks: withEffort('high') });

    await editor.followRunnerModel('t1', { model: 'claude-future-1', label: 'Future' }, 'high', live);
    expect(task('t1')?.assignedModel).toEqual({ modelId: 'claude-future-1', modelLabel: 'Future' });

    await editor.followRunnerModel('t1', { model: 'claude-future-2' }, undefined, live);
    expect(task('t1')?.assignedModel).toEqual({ modelId: 'claude-future-2', modelLabel: 'claude-future-2' });
  });

  it('writes nothing when the plan already says so', async () => {
    const { editor, mutate, sent } = setup({ tasks: withEffort() });

    const plan = await editor.followRunnerModel('t1', { model: 'claude-haiku-4-5' }, undefined, live);

    expect(plan).not.toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('says nothing of a task that is gone, is the user\'s, or whose runner is no longer the live one', async () => {
    const { editor, mutate } = setup({ tasks: withEffort() });

    expect(await editor.followRunnerModel('ghost', { model: 'm' }, undefined, live)).toBeNull();
    expect(await editor.followRunnerModel('u1', { model: 'm' }, undefined, live)).toBeNull();
    expect(await editor.followRunnerModel('t1', { model: 'm' }, undefined, () => false)).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });
});
