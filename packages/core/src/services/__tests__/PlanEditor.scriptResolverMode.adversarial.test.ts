import { describe, it, expect, vi } from 'vitest';
import { PlanEditor, type PlanEditCatalog } from '../PlanEditor';
import { PlanStore } from '../PlanStore';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { QWEN_CODE_MANIFEST } from '../../plugins/builtin/qwen.manifest';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';

/**
 * Review #73, round 2: a resolver added for a conflicted script task inherits
 * the script's absent mode, so on a Qwen Code plan its spawn carries `build`
 * (Attempts.ts:986 `this.modeOf(task, attempt) ?? 'build'`), which is not one of
 * Qwen's mode ids.
 */
describe('conflict resolver of a script task on an ACP runner', () => {
  it('gives the resolver a mode the runner owns', async () => {
    const now = '2026-01-01T00:00:00Z';
    const store = new PlanStore();
    // As plannedTask writes a script task: the plan's first runner, no mode (PlannedTask.ts:254, :329).
    const script = createTask({ id: 't1', order: 1, title: 'Codegen', type: 'script', commands: [['npm', 'run', 'gen']], assignedRunner: 'qwen-code' });
    expect(script.taskMode).toBeUndefined();
    store.load([script], ['qwen-code']);
    const plan: LegacyPlanState = { tasks: [], generatedAt: now, status: 'approved', runners: ['qwen-code'], lastUpdated: now };
    const run: IsolationRun = {
      id: 'run1', workspaceRoot: '/repo', shared: [], sharedRepos: [],
      repos: [{ path: '.', root: '/repo', baseRef: 'abc', integrationBranch: 'ordewell/run1/integration' }],
      tasks: { t1: { taskId: 't1', order: 1, title: 'Codegen', branch: 'ordewell/run1/1-t1', workspace: '/wt/1', status: 'conflict', conflictRepo: '.', repos: { '.': { worktree: '/wt/1', linked: [] } } } },
    };
    const catalog: PlanEditCatalog = {
      edit: () => ({ modelsByRunner: { 'qwen-code': [] }, runnerModes: { 'qwen-code': QWEN_CODE_MANIFEST.modes ?? [] } }),
      runner: vi.fn(async () => ({ models: [], modes: QWEN_CODE_MANIFEST.modes ?? [] })),
      admit: vi.fn(),
    };
    const editor = new PlanEditor({
      store, plan: () => plan, catalog,
      mutate: vi.fn((op: () => boolean) => (op() ? plan : null)),
      scheduler: { releaseMovedResume: (_id: string, c: object) => c, tick: vi.fn(async () => {}), releaseTask: vi.fn(async () => {}), planEdited: vi.fn(), resolverRefusal: vi.fn(() => null), startWhenAllowed: vi.fn() } as never,
      runs: { current: run, linkResolver: vi.fn() },
      broadcast: () => {},
      taskSkills: () => ({ findSkill: () => undefined, searchedDirs: () => [] }),
      notice: vi.fn(),
      approve: vi.fn(),
    });

    await editor.addConflictResolver('t1');
    const resolver = store.planTasks.at(-1)!;
    expect(resolver).toMatchObject({ type: 'ai', assignedRunner: 'qwen-code' });
    expect(store.resolveTaskRunner(resolver)).toBe('qwen-code');

    // What Attempts.ts:986 and StructuredRunner.ts:1107 hand the ACP adapter, whose
    // session-mode route (AcpAdapter.ts:349) puts `permissionMode` on the session.
    const spawnMode = resolver.taskMode ?? 'build';
    const flags = resolveTaskRunnerFlags(QWEN_CODE_MANIFEST, { mode: spawnMode });
    const qwenModes = (QWEN_CODE_MANIFEST.modes ?? []).map((m) => m.id);
    expect({ spawnMode, permissionMode: flags.permissionMode, qwenModes }).toMatchObject({ permissionMode: expect.any(String) });
    expect(qwenModes).toContain(flags.permissionMode);
  });
});

describe('a script task made AI by a hand edit, on a Qwen plan', () => {
  it('gets a mode Qwen owns', async () => {
    const now = '2026-01-01T00:00:00Z';
    const store = new PlanStore();
    store.load([createTask({ id: 't1', order: 1, title: 'Codegen', type: 'script', commands: [['npm', 'run', 'gen']], assignedRunner: 'qwen-code' })], ['qwen-code']);
    const plan: LegacyPlanState = { tasks: [], generatedAt: now, status: 'approved', runners: ['qwen-code'], lastUpdated: now };
    const editor = new PlanEditor({
      store, plan: () => plan,
      catalog: { edit: () => ({ modelsByRunner: { 'qwen-code': [] }, runnerModes: { 'qwen-code': QWEN_CODE_MANIFEST.modes ?? [] } }), runner: vi.fn(async () => ({ models: [], modes: QWEN_CODE_MANIFEST.modes ?? [] })), admit: vi.fn() },
      mutate: vi.fn((op: () => boolean) => (op() ? plan : null)),
      scheduler: { releaseMovedResume: (_id: string, c: object) => c, tick: vi.fn(async () => {}), releaseTask: vi.fn(async () => {}), planEdited: vi.fn(), resolverRefusal: vi.fn(() => null), startWhenAllowed: vi.fn() } as never,
      runs: { current: null, linkResolver: vi.fn() },
      broadcast: () => {}, taskSkills: () => ({ findSkill: () => undefined, searchedDirs: () => [] }), notice: vi.fn(), approve: vi.fn(),
    });
    await editor.updateTask('t1', { type: 'ai', prompt: 'generate' });
    const t = store.get('t1')!;
    const flags = resolveTaskRunnerFlags(QWEN_CODE_MANIFEST, { mode: t.taskMode ?? 'build' });
    expect({ type: t.type, runner: store.resolveTaskRunner(t) }).toEqual({ type: 'ai', runner: 'qwen-code' });
    expect((QWEN_CODE_MANIFEST.modes ?? []).map((m) => m.id)).toContain(flags.permissionMode);
  });
});
