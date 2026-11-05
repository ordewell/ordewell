import { describe, it, expect, vi } from 'vitest';
import { PlanEditor, type PlanEditCatalog } from '../PlanEditor';
import { PlanStore, assertAssignedRunners } from '../PlanStore';
import type { RunnerCatalog } from '../TaskAssignment';
import { createTask, type LegacyPlanState, type RunnerId, type Task } from '../../models/Task';
import { QWEN_CODE_MANIFEST } from '../../plugins/builtin/qwen.manifest';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';

// A manual task never spawns, so its runner need not be in the plan; once it is made an AI task it spawns, and on that runner.
const CATALOGS: Record<RunnerId, RunnerCatalog> = {
  'qwen-code': { models: [], modes: QWEN_CODE_MANIFEST.modes ?? [] },
  opencode: { models: [], modes: OPENCODE_MANIFEST.modes ?? [] },
  'claude-code': { models: [], modes: CLAUDE_CODE_MANIFEST.modes ?? [] },
};

function setup(tasks: Task[], runners: RunnerId[]) {
  const store = new PlanStore();
  const now = '2026-01-01T00:00:00Z';
  const plan: LegacyPlanState = { tasks: [], generatedAt: now, status: 'approved', runners: [...runners], lastUpdated: now };
  store.load(tasks, runners);
  const catalog: PlanEditCatalog = {
    edit: () => ({ modelsByRunner: {}, runnerModes: Object.fromEntries(plan.runners.map((r) => [r, CATALOGS[r].modes])) }),
    runner: vi.fn(async (r: RunnerId) => CATALOGS[r] ?? { models: [], modes: [] }),
    admit: vi.fn(),
  };
  const editor = new PlanEditor({
    store,
    plan: () => plan,
    catalog,
    mutate: vi.fn((op: () => boolean, notify?: () => void) => { if (!op()) return null; notify?.(); return plan; }),
    scheduler: {
      releaseMovedResume: (_id: string, c: Partial<Task>) => c,
      tick: vi.fn(async () => {}),
      releaseTask: vi.fn(async () => {}),
      planEdited: vi.fn(),
      resolverRefusal: vi.fn((): string | null => null),
      startWhenAllowed: vi.fn(),
    },
    runs: { current: null, linkResolver: vi.fn() },
    broadcast: () => {},
    taskSkills: () => ({ findSkill: () => undefined, searchedDirs: () => [] }),
    notice: vi.fn(),
    approve: vi.fn(),
  });
  return { editor, store, plan };
}

const MANIFESTS = { 'qwen-code': QWEN_CODE_MANIFEST, opencode: OPENCODE_MANIFEST, 'claude-code': CLAUDE_CODE_MANIFEST } as const;
type Runner = keyof typeof MANIFESTS;

/** The runner the spawn path picks (Attempts' resolveTaskRunner) and the flag its mode becomes there. */
function spawnedWith(store: PlanStore, id: string) {
  const task = store.get(id)!;
  const runner = store.resolveTaskRunner(task) as Runner;
  const mode = task.taskMode;
  if (mode === undefined) throw new Error(`task ${id} was given no mode`);
  return { runner, permissionMode: resolveTaskRunnerFlags(MANIFESTS[runner], { mode }).permissionMode };
}

const modeIds = (runner: Runner) => (MANIFESTS[runner].modes ?? []).map((m) => m.id);

describe('a manual task on a runner outside the plan, turned into an AI task, brings its runner into the plan', () => {
  it('a hand-added manual task on opencode, made AI, spawns opencode with one of its own modes', async () => {
    const { editor, store, plan } = setup([createTask({ id: 'a', order: 1, title: 'A', prompt: 'a', assignedRunner: 'qwen-code', taskMode: 'default' })], ['qwen-code']);
    await editor.addTask({ type: 'user', title: 'Sign off', userSteps: [{ order: 1, instruction: 'by hand', completed: false }], assignedRunner: 'opencode' });
    const manual = store.planTasks.find((t) => t.title === 'Sign off')!;
    await editor.updateTask(manual.id, { type: 'ai', prompt: 'sign it off' });

    expect(store.get(manual.id)).toMatchObject({ type: 'ai', assignedRunner: 'opencode' });
    expect({ store: store.planRunners, plan: plan.runners }).toEqual({ store: ['qwen-code', 'opencode'], plan: ['qwen-code', 'opencode'] });
    const spawn = spawnedWith(store, manual.id);
    expect(spawn.runner).toBe('opencode');
    expect(modeIds('opencode')).toContain(spawn.permissionMode);
  });

  it('a planner-made manual task left on the default runner, made AI, spawns that runner with one of its own modes', async () => {
    // createTask, as PlannedTask uses it for a manual task, defaults the runner to claude-code.
    const manual = createTask({ id: 'm', order: 2, title: 'Sign off', type: 'user', userSteps: [{ order: 1, instruction: 'by hand', completed: false }], assignedRunner: 'claude-code' });
    const { editor, store } = setup([createTask({ id: 'a', order: 1, title: 'A', prompt: 'a', assignedRunner: 'qwen-code', taskMode: 'default' }), manual], ['qwen-code']);
    await editor.updateTask('m', { type: 'ai', prompt: 'sign it off' });

    const spawn = spawnedWith(store, 'm');
    expect(spawn.runner).toBe('claude-code');
    expect(modeIds('claude-code')).toContain(spawn.permissionMode);
  });

  it('the edited plan still loads: a Run reload holds every AI task to the plan runners', async () => {
    const { editor, store } = setup([createTask({ id: 'a', order: 1, title: 'A', prompt: 'a', assignedRunner: 'qwen-code', taskMode: 'default' })], ['qwen-code']);
    await editor.addTask({ type: 'user', title: 'Sign off', userSteps: [{ order: 1, instruction: 'x', completed: false }], assignedRunner: 'opencode' });
    const manual = store.planTasks.find((t) => t.title === 'Sign off')!;
    await editor.updateTask(manual.id, { type: 'ai', prompt: 'sign it off' });
    expect(() => assertAssignedRunners(store.planTasks, store.planRunners)).not.toThrow();
  });
});
