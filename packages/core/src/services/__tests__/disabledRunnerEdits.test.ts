import { describe, it, expect } from 'vitest';
import { createTask, type DiscoveredModel, type RunnerId, type Task } from '../../models/Task';
import { PlanChangeCheck, planChangeErrorText, type CheckedChange, type PlanChangeScope } from '../PlanChangeCheck';
import { SessionCatalog } from '../SessionCatalog';
import type { TaskOp } from '../TaskOps';
import type { SkillInfo } from '../SkillsService';
import type { SkillLookup } from '../taskSkills';

const model = (modelId: string): DiscoveredModel => ({ modelId, modelLabel: modelId, variants: [] });

const MODELS: Record<string, DiscoveredModel[]> = { 'claude-code': [model('sonnet')], codex: [model('gpt-5'), model('gpt-5-mini')], opencode: [model('kimi')], gemini: [model('flash')] };
const MODES = [{ id: 'build', label: 'Build', description: '' }, { id: 'agent', label: 'Agent', description: '', autonomous: true }, { id: 'plan', label: 'Plan', description: '', readOnly: true }];

/**
 * A session's scope as createSession.changeScope builds it, read through the
 * real SessionCatalog: the plan's runner set still holds Codex (and Gemini),
 * and the enabled list rightly leaves them out, so no toggle defect is involved.
 * A planner edit may put a task only on an enabled runner (ADR-0003 V1); the
 * plan's history does not widen that.
 */
function scopeWith(tasks: Task[], enabled: RunnerId[]) {
  const planRunners: RunnerId[] = ['codex', 'claude-code', 'opencode', 'gemini'];
  const live = { tasks, enabled, skills: undefined as SkillLookup | undefined };
  const catalog = new SessionCatalog({
    config: { enabledRunners: [], autonomousMode: true, aiProvider: 'openrouter' },
    registry: { getManifest: (id: string) => ({ name: id, displayName: id, runner: { command: id }, features: {}, modelDiscovery: { method: 'hardcoded' }, modes: MODES }) as never },
    modelResolver: { modelsForRunners: async () => ({}), getCachedRunnerModels: (runner: RunnerId) => MODELS[runner] ?? [] },
    settings: () => ({ enabledRunners: live.enabled, modelAllowlist: { codex: ['gpt-5'] } }),
    planRunners: () => planRunners,
  });
  const scope: PlanChangeScope = {
    tasks: () => live.tasks,
    runners: (kind) => catalog.runnersFor(kind === 'plan' ? 'plan' : 'edit') ?? [],
    catalog: (runners) => catalog.edit([...new Set([...planRunners, ...runners])]),
    skills: () => live.skills ?? { findSkill: () => undefined, searchedDirs: () => [] },
  };
  return { live, catalog, check: new PlanChangeCheck(scope) };
}

const ai = (id: string, order: number, runner: RunnerId, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, description: 'd', prompt: 'p', type: 'ai', assignedRunner: runner, sliceType: 'AFK', autonomy: 'AFK', ...over });
const manual = (runner: RunnerId) => createTask({ id: 'manual', order: 3, title: 'Sign off', description: 'd', type: 'user', assignedRunner: runner, sliceType: 'HITL' });

const ENABLED: RunnerId[] = ['claude-code', 'opencode'];
/** Codex in the plan's history only: a completed task on it, a manual task stored with it, and a pending one still on it. */
const plan = () => scopeWith([ai('old', 1, 'codex', { status: 'completed' }), ai('cc', 2, 'claude-code'), manual('codex'), ai('pending', 4, 'codex')], ENABLED);

const text = (c: CheckedChange) => (c.ok ? 'ACCEPTED' : c.errors.map(planChangeErrorText).join('; '));
const task = (c: CheckedChange, title: string) => (c.ok ? c.tasks.flatMap((t) => [t, ...t.subtasks]).find((t) => t.title === title) : undefined);
const submit = (ops: TaskOp[], s = plan()) => s.check.check({ kind: 'ops', ops }, 'submit');
/** A subtask as the planner writes it, which the op's intake fills in. */
const child = (over: Record<string, unknown> = {}) => ({ title: 'Child', type: 'ai', sliceType: 'AFK', autonomy: 'AFK', ...over }) as unknown as Task;

describe('a planner edit, a runner switched off that the plan once used', () => {
  it.each<[string, TaskOp[]]>([
    ['an added task naming it', [{ op: 'add', task: { title: 'New', assignedRunner: 'codex' } }]],
    ['an added subtask naming it', [{ op: 'add', task: { title: 'New', assignedRunner: 'claude-code', subtasks: [child({ assignedRunner: 'codex' })] } }]],
    ['a task moved onto it', [{ op: 'update', taskId: 'cc', changes: { assignedRunner: 'codex' } }]],
    ['a manual task stored with it made an AI task', [{ op: 'update', taskId: 'manual', changes: { type: 'ai', prompt: 'do it', userSteps: [], sliceType: 'AFK' } }]],
    ['a split part naming it', [{ op: 'split', taskId: 'cc', parts: [{ title: 'One' }, { title: 'Two', assignedRunner: 'codex' }] }]],
    ['a merged task naming it', [{ op: 'merge', taskIds: ['cc', 'manual'], merged: { title: 'Both', type: 'ai', sliceType: 'AFK', assignedRunner: 'codex' } }]],
    ['a re-armed task moved onto it', [{ op: 'rearm', taskId: 'done', changes: { assignedRunner: 'codex' } }]],
    ['split parts that inherit it', [{ op: 'split', taskId: 'pending', parts: [{ title: 'One' }, { title: 'Two' }] }]],
  ])('refuses %s', async (_name, ops) => {
    const s = plan();
    s.live.tasks = [...s.live.tasks, ai('done', 5, 'claude-code', { status: 'completed' })];
    expect(text(await submit(ops, s))).toMatch(/invalid assignedRunner "codex"\. Expected one of: claude-code, opencode/);
  });

  it('refuses a merged task that inherits it from its first task', async () => {
    const s = plan();
    s.live.tasks = [ai('pending', 1, 'codex'), ai('cc', 2, 'claude-code')];
    expect(text(await submit([{ op: 'merge', taskIds: ['pending', 'cc'], merged: { title: 'Both' } }], s))).toMatch(/Task "Both" has invalid assignedRunner "codex"/);
  });

  it('refuses moving a task from one runner switched off to another the plan once used', async () => {
    const s = plan();
    s.live.tasks = [ai('pending', 1, 'codex'), ai('cc', 2, 'claude-code')];
    expect(text(await submit([{ op: 'update', taskId: 'pending', changes: { assignedRunner: 'gemini' } }], s))).toMatch(/invalid assignedRunner "gemini"/);
  });

  it('puts a task that names no runner, and its subtasks, on an enabled one', async () => {
    const added = await submit([{ op: 'add', task: { title: 'New', subtasks: [child()] } }]);
    expect([task(added, 'New')?.assignedRunner, task(added, 'Child')?.assignedRunner]).toEqual(['claude-code', 'claude-code']);
  });

  it('refuses at landing an edit accepted while it was on, once it is switched off', async () => {
    const s = plan();
    s.live.enabled = ['claude-code', 'codex', 'opencode'];
    const ops: TaskOp[] = [{ op: 'add', task: { title: 'New', assignedRunner: 'codex' } }];
    expect(text(await s.check.check({ kind: 'ops', ops }, 'submit'))).toBe('ACCEPTED');
    s.live.enabled = ENABLED;
    expect(text(s.check.checkNow({ kind: 'ops', ops }, 'land'))).toMatch(/invalid assignedRunner "codex"/);
  });

  it('refuses an edit whose skill lookup outlasts the runner being switched off', async () => {
    const s = plan();
    s.live.enabled = ['claude-code', 'codex', 'opencode'];
    let release = () => {};
    let asked = false;
    const tdd = { name: 'tdd', path: '/g/tdd/SKILL.md', appliesTo: 'task', source: 'global', content: 'Red, green.' } as SkillInfo;
    s.live.skills = {
      findSkill: (name) => (name === 'tdd' ? tdd : undefined),
      searchedDirs: () => [],
      uncommitted: () => new Promise((resolve) => { asked = true; release = () => resolve(new Map()); }),
    };
    const pending = submit([{ op: 'add', task: { title: 'New', assignedRunner: 'codex', skills: ['tdd'] } }], s);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(true);
    s.live.enabled = ENABLED;
    release();
    expect(text(await pending)).toMatch(/invalid assignedRunner "codex"/);
  });

  it.each<[string, TaskOp[]]>([
    ['an edit of another task', [{ op: 'update', taskId: 'cc', changes: { title: 'Renamed' } }]],
    ['an edit of the task on it that leaves its runner alone', [{ op: 'update', taskId: 'pending', changes: { title: 'Renamed' } }]],
    ['a new prompt for the task on it', [{ op: 'update', taskId: 'pending', changes: { prompt: 'do it better' } }]],
    ['a model its allowlist holds for the task on it', [{ op: 'update', taskId: 'pending', changes: { assignedModel: { modelId: 'gpt-5', modelLabel: 'gpt-5' } } }]],
    ['a re-arm of a completed task on it, which reruns as assigned (ADR-0043)', [{ op: 'rearm', taskId: 'old' }]],
    ['a re-arm of a completed task on it with a new prompt, its runner left alone', [{ op: 'rearm', taskId: 'old', changes: { prompt: 'again, better' } }]],
    ['a re-arm that restates the runner the task is already on', [{ op: 'rearm', taskId: 'old', changes: { assignedRunner: 'codex' } }]],
    ['a move off it', [{ op: 'update', taskId: 'pending', changes: { assignedRunner: 'claude-code' } }]],
    ['a move off it onto another enabled runner', [{ op: 'update', taskId: 'pending', changes: { assignedRunner: 'opencode' } }]],
    ['a re-arm that moves a completed task off it', [{ op: 'rearm', taskId: 'old', changes: { assignedRunner: 'opencode' } }]],
    ['removing the task on it', [{ op: 'remove', taskId: 'pending' }]],
    ['a reorder', [{ op: 'reorder', taskIds: ['cc', 'old', 'manual', 'pending'] }]],
    ['a task added on an enabled runner', [{ op: 'add', task: { title: 'New', assignedRunner: 'opencode' } }]],
    ['split parts of an enabled task, inheriting its runner', [{ op: 'split', taskId: 'cc', parts: [{ title: 'One' }, { title: 'Two' }] }]],
  ])('still accepts %s', async (_name, ops) => {
    expect(text(await submit(ops))).toBe('ACCEPTED');
  });

  it('keeps the task a re-arm or a move left on it where it was', async () => {
    const kept = await submit([{ op: 'update', taskId: 'pending', changes: { title: 'Renamed' } }, { op: 'rearm', taskId: 'old' }]);
    expect([task(kept, 'Renamed')?.assignedRunner, task(kept, 'Task old')?.assignedRunner]).toEqual(['codex', 'codex']);
  });

  it('still holds a model named for the task left on it to that runner\'s allowlist', async () => {
    const mini = await submit([{ op: 'update', taskId: 'pending', changes: { assignedModel: { modelId: 'gpt-5-mini', modelLabel: 'gpt-5-mini' } } }]);
    expect(text(mini)).toMatch(/Model "gpt-5-mini" is excluded by the allowlist for runner "codex"/);
  });

  it('still holds a model named in a move off it to the new runner\'s models', async () => {
    const wrong = await submit([{ op: 'update', taskId: 'pending', changes: { assignedRunner: 'claude-code', assignedModel: { modelId: 'gpt-5', modelLabel: 'gpt-5' } } }]);
    expect(text(wrong)).toMatch(/Runner "claude-code" does not offer model "gpt-5"/);
  });

  describe('the invariants of a task left on it', () => {
    const readOnly = (id: string, order: number) => ai(id, order, 'codex', { taskMode: 'plan' });

    it('derives the read-only mode from its modes when the planner says the task is read-only', async () => {
      const s = scopeWith([ai('pending', 1, 'codex')], ENABLED);
      const edited = await submit([{ op: 'update', taskId: 'pending', changes: { readOnly: true } }], s);
      expect(task(edited, 'Task pending')).toMatchObject({ assignedRunner: 'codex', taskMode: 'plan' });
    });

    it('keeps a read-only task from becoming an ops task', async () => {
      const s = scopeWith([readOnly('pending', 1)], ENABLED);
      expect(text(await submit([{ op: 'update', taskId: 'pending', changes: { ops: true } }], s))).toMatch(/"readOnly" is not for an ops task/);
    });

    it('keeps a research flag to a read-only task', async () => {
      const s = scopeWith([ai('pending', 1, 'codex')], ENABLED);
      expect(text(await submit([{ op: 'update', taskId: 'pending', changes: { research: true } }], s))).not.toBe('ACCEPTED');
      const ro = scopeWith([readOnly('pending', 1)], ENABLED);
      expect(text(await submit([{ op: 'update', taskId: 'pending', changes: { research: true } }], ro))).toBe('ACCEPTED');
    });

    it('refuses read-only on a task moved onto it, as on any other off runner', async () => {
      const s = scopeWith([ai('cc', 1, 'claude-code')], ENABLED);
      const moved = await submit([{ op: 'update', taskId: 'cc', changes: { assignedRunner: 'codex', readOnly: true } }], s);
      expect(text(moved)).toMatch(/invalid assignedRunner "codex"\. Expected one of: claude-code, opencode/);
    });
  });

  describe('a request the planner handcrafts, though list_runners never showed it the runner', () => {
    it('offers only the enabled runners to a planner', async () => {
      const { catalog } = plan();
      expect(catalog.runnersFor('plan')).toEqual(ENABLED);
    });

    it.each<[string, TaskOp[]]>([
      ['an add', [{ op: 'add', task: { title: 'Stale', assignedRunner: 'codex' } }]],
      ['a move', [{ op: 'update', taskId: 'cc', changes: { assignedRunner: 'codex' } }]],
      ['a re-arm that moves the task', [{ op: 'rearm', taskId: 'cc2', changes: { assignedRunner: 'codex' } }]],
    ])('is refused for %s, naming the runners it may use', async (_name, ops) => {
      const s = plan();
      s.live.tasks = [...s.live.tasks, ai('cc2', 5, 'claude-code', { status: 'completed' })];
      const answer = await submit(ops, s);
      expect(answer.ok).toBe(false);
      expect(text(answer)).toMatch(/invalid assignedRunner "codex"\. Expected one of: claude-code, opencode/);
    });
  });

  describe('landing, once the runner is switched off between the check and the commit', () => {
    it.each<[string, TaskOp[]]>([
      ['an add', [{ op: 'add', task: { title: 'New', assignedRunner: 'codex' } }]],
      ['a move', [{ op: 'update', taskId: 'cc', changes: { assignedRunner: 'codex' } }]],
      ['a manual task made an AI task', [{ op: 'update', taskId: 'manual', changes: { type: 'ai', prompt: 'do it', userSteps: [], sliceType: 'AFK' } }]],
      ['a re-arm that moves the task', [{ op: 'rearm', taskId: 'done', changes: { assignedRunner: 'codex' } }]],
      ['a split part', [{ op: 'split', taskId: 'cc', parts: [{ title: 'One' }, { title: 'Two', assignedRunner: 'codex' }] }]],
    ])('refuses %s', async (_name, ops) => {
      const s = plan();
      s.live.tasks = [...s.live.tasks, ai('done', 5, 'claude-code', { status: 'completed' })];
      s.live.enabled = ['claude-code', 'codex', 'opencode'];
      expect(text(await s.check.check({ kind: 'ops', ops }, 'submit')), 'accepted while it was on').toBe('ACCEPTED');
      s.live.enabled = ENABLED;
      expect(text(s.check.checkNow({ kind: 'ops', ops }, 'land'))).toMatch(/invalid assignedRunner "codex"/);
    });

    it('lands an edit that leaves the task on it alone, though it was switched off since', async () => {
      const s = plan();
      const ops: TaskOp[] = [{ op: 'update', taskId: 'pending', changes: { title: 'Renamed' } }];
      expect(text(await s.check.check({ kind: 'ops', ops }, 'submit'))).toBe('ACCEPTED');
      expect(text(s.check.checkNow({ kind: 'ops', ops }, 'land'))).toBe('ACCEPTED');
    });
  });
});
