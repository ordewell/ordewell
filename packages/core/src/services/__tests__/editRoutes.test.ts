import { describe, it, expect, vi } from 'vitest';
import { PlanEditor, type PlanEditCatalog } from '../PlanEditor';
import { PlanStore } from '../PlanStore';
import { applyTaskOps, type PlannerTaskSpec } from '../TaskOps';
import type { AssignmentCatalog } from '../TaskAssignment';
import type { RunnerModeInfo } from '../ModeResolver';
import { createTask, flattenTasks, type DiscoveredModel, type LegacyPlanState, type RunnerId, type Task, type TaskType, type UserStep } from '../../models/Task';

/**
 * CONTEXT.md's "Direct edit vs planner edit": both routes prepare an edit
 * through one `prepareTaskEdit`, so one table of edits runs against both, and
 * a row that expects them to differ names the difference it pins.
 */

const model = (modelId: string, variants: string[] = []): DiscoveredModel =>
  ({ modelId, modelLabel: modelId, variants: variants.map((id) => ({ id, label: id })) });

const MODES: RunnerModeInfo[] = [
  { id: 'build', label: 'Build', description: '', autonomous: true },
  { id: 'plan', label: 'Read only', description: '', readOnly: true },
];

const CATALOG: AssignmentCatalog & { runnerModes: Record<RunnerId, RunnerModeInfo[]> } = {
  modelsByRunner: {
    'claude-code': [model('claude-sonnet-4-5', ['low', 'high']), model('claude-haiku-4-5')],
    opencode: [model('big-pickle')],
    gemini: [model('gemini-pro')],
    codex: [model('gpt-5-codex')],
  },
  runnerModes: {
    'claude-code': MODES,
    opencode: [{ id: 'go', label: 'Go', description: '', autonomous: true }, { id: 'look', label: 'Look', description: '', readOnly: true }],
    gemini: [{ id: 'yolo', label: 'Yolo', description: '', autonomous: true }],
    codex: [{ id: 'fullAccess', label: 'Full access', description: '', autonomous: true }],
  },
};

/** Codex is off, so only the user's edit may move a task onto it. */
const steps = (...instructions: string[]): UserStep[] => instructions.map((instruction, i) => ({ order: i + 1, instruction, completed: false }));

const RUNNERS: RunnerId[] = ['claude-code', 'opencode', 'gemini'];

function plan(): Task[] {
  return [
    createTask({ id: 't1', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet' }, taskMode: 'build' }),
    createTask({
      id: 't2', order: 2, title: 'Build', prompt: 'build', assignedRunner: 'claude-code', taskMode: 'build', dependencies: ['t1'],
      subtasks: [createTask({ id: 's1', order: 1, title: 'Compile', prompt: 'compile', assignedRunner: 'claude-code', taskMode: 'build' })],
    }),
    createTask({ id: 'r', order: 3, title: 'Research', prompt: 'investigate', assignedRunner: 'claude-code', research: true, taskMode: 'plan' }),
    createTask({ id: 'done', order: 4, title: 'Shipped', prompt: 'ship', assignedRunner: 'claude-code', taskMode: 'build', status: 'completed' }),
  ];
}

type Outcome = { landed: Partial<Task> } | { refused: RegExp };
type Route = 'direct' | 'planner';

interface EditCase {
  name: string;
  tasks?: () => Task[];
  taskId: string;
  changes: Partial<Task>;
  /** What the planner writes instead, where its vocabulary differs from the user's (ADR-0031: it sets `readOnly`, never a mode). */
  planner?: PlannerTaskSpec;
  expect: Outcome | Record<Route, Outcome>;
}

const CASES: EditCase[] = [
  {
    name: 'a flip to manual with steps clears the runner\'s model and mode and holds the task to HITL',
    taskId: 't1',
    changes: { type: 'user', userSteps: steps('Click deploy') },
    expect: { landed: { type: 'user', userSteps: steps('Click deploy'), sliceType: 'HITL', assignedModel: undefined, taskMode: undefined } },
  },
  { name: 'a flip to manual without steps is refused', taskId: 't1', changes: { type: 'user' }, expect: { refused: /without user steps/ } },
  // Bug: a type no kind owns reached the kind table and threw a TypeError, a 500 or an internal tool error.
  { name: 'a type no kind owns is refused', taskId: 't1', changes: { type: 'manual' as string as TaskType, prompt: 'by hand' }, expect: { refused: /"manual", which is no kind of task/ } },
  { name: 'a type cleared to null is refused', taskId: 't1', changes: { type: null as unknown as TaskType }, expect: { refused: /null, which is no kind of task/ } },
  // Bug: the refactor read an edit's null as left out, so a script took a runner's prompt or model the edit check had refused.
  {
    name: 'a null prompt on a script task is refused',
    tasks: () => [...plan(), createTask({ id: 'sh', order: 5, title: 'Push', type: 'script', commands: [['git', 'push']] })],
    taskId: 'sh',
    changes: { prompt: null as unknown as string },
    expect: { refused: /is a script task.*leave out "prompt"/ },
  },
  {
    name: 'a null model on a script task is refused',
    tasks: () => [...plan(), createTask({ id: 'sh', order: 5, title: 'Push', type: 'script', commands: [['git', 'push']] })],
    taskId: 'sh',
    changes: { assignedModel: null as unknown as Task['assignedModel'] },
    expect: { refused: /is a script task.*leave out "assignedModel"/ },
  },
  { name: 'a script body on a task that is not a script is refused', taskId: 't1', changes: { commands: [['npm', 'test']] }, expect: { refused: /not a script task/ } },
  { name: 'ops on a subtask is refused', taskId: 's1', changes: { ops: true }, expect: { refused: /subtask/ } },
  { name: 'a dependency cycle is refused', taskId: 't1', changes: { dependencies: ['t2'] }, expect: { refused: /cycle/i } },
  {
    name: 'a model the runner does not offer is refused',
    taskId: 't1',
    changes: { assignedModel: { modelId: 'no-such-model', modelLabel: 'None' } },
    expect: { refused: /no-such-model/ },
  },
  {
    name: 'leaving the read-only profile ends the research',
    taskId: 'r',
    changes: { taskMode: 'build' },
    planner: { readOnly: false },
    expect: { landed: { research: false, taskMode: 'build' } },
  },
  {
    // Research holds only under the read-only profile (ADR-0037), a rule of the plan both routes are held to once the edit lands.
    name: 'leaving it while asking for research again is refused',
    taskId: 'r',
    changes: { taskMode: 'build', research: true },
    planner: { readOnly: false, research: true },
    expect: { refused: /research is only for top-level read-only/ },
  },
  {
    name: 'a research task moved to another runner stays read-only, and research, in that runner\'s own mode',
    taskId: 'r',
    changes: { assignedRunner: 'opencode' },
    expect: { landed: { assignedRunner: 'opencode', taskMode: 'look', research: true } },
  },
  {
    name: 'a read-only task cannot move to a runner with no read-only mode',
    taskId: 'r',
    changes: { assignedRunner: 'gemini' },
    expect: { refused: /no read-only mode/ },
  },
  { name: 'an edit that keeps the read-only profile keeps the research', taskId: 'r', changes: { title: 'Look around' }, expect: { landed: { title: 'Look around', research: true, taskMode: 'plan' } } },
  {
    name: 'a rule another task already breaks does not refuse an edit that breaks nothing new',
    tasks: () => [...plan(), createTask({ id: 'u', order: 5, title: 'Approve', type: 'user', userSteps: steps('Approve'), sliceType: 'AFK' })],
    taskId: 't1',
    changes: { title: 'Prepare' },
    expect: { landed: { title: 'Prepare' } },
  },
  {
    // The lock is the planner's: the user may change a finished task, and pays for it at the call site (ADR-0029).
    name: 'a completed task is the user\'s to change, never the planner\'s',
    taskId: 'done',
    changes: { title: 'Shipped again' },
    expect: { direct: { landed: { title: 'Shipped again' } }, planner: { refused: /completed/ } },
  },
  {
    // The planner is held to the runners enabled now; the user may pick any (ADR-0003's writer table).
    name: 'a runner not enabled is the user\'s to choose, never the planner\'s',
    taskId: 't1',
    changes: { assignedRunner: 'codex' },
    expect: { direct: { landed: { assignedRunner: 'codex' } }, planner: { refused: /codex/ } },
  },
];

function editor(tasks: Task[]): { editor: PlanEditor; store: PlanStore } {
  const store = new PlanStore();
  const now = '2026-01-01T00:00:00Z';
  const state: LegacyPlanState = { tasks: [], generatedAt: now, status: 'approved', runners: RUNNERS, lastUpdated: now };
  store.load(tasks, RUNNERS);
  const catalog: PlanEditCatalog = {
    edit: () => CATALOG,
    runner: vi.fn(async (runner: RunnerId) => ({ models: CATALOG.modelsByRunner[runner] ?? [], modes: CATALOG.runnerModes[runner] ?? [] })),
    admit: vi.fn(),
  };
  return {
    store,
    editor: new PlanEditor({
      store,
      plan: () => state,
      catalog,
      mutate: (op) => (op() ? state : null),
      scheduler: {
        releaseMovedResume: (_taskId: string, changes: Partial<Task>) => changes,
        tick: vi.fn(async () => {}),
        releaseTask: vi.fn(async () => {}),
        planEdited: vi.fn(),
        resolverRefusal: vi.fn((): string | null => null),
        startWhenAllowed: vi.fn(),
      },
      runs: { taskState: () => undefined, conflictOf: () => null, handoffBranch: null, linkResolver: vi.fn() },
      broadcast: () => {},
      taskSkills: () => ({ findSkill: () => undefined, searchedDirs: () => [] }),
      notice: vi.fn(),
      approve: vi.fn(),
    }),
  };
}

/** The task as the route left it, or the reason it refused. */
async function run(route: Route, c: EditCase): Promise<{ task: Task } | { error: string }> {
  const tasks = (c.tasks ?? plan)();
  if (route === 'direct') {
    const { editor: e, store } = editor(tasks);
    try {
      await e.updateTask(c.taskId, c.changes);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    return { task: store.get(c.taskId)! };
  }
  const result = applyTaskOps(tasks, [{ op: 'update', taskId: c.taskId, changes: c.planner ?? c.changes }], RUNNERS, CATALOG);
  if (!result.ok) return { error: result.errors.join('\n') };
  return { task: flattenTasks(result.tasks).find((t) => t.id === c.taskId)! };
}

describe('one edit, either route', () => {
  describe.each<Route>(['direct', 'planner'])('the %s route', (route) => {
    it.each(CASES)('$name', async (c) => {
      const expected = 'direct' in c.expect ? c.expect[route] : c.expect;
      const outcome = await run(route, c);
      if ('refused' in expected) {
        expect(outcome).toHaveProperty('error');
        expect('error' in outcome && outcome.error).toMatch(expected.refused);
      } else {
        expect(outcome).not.toHaveProperty('error');
        const task = 'task' in outcome ? outcome.task : undefined;
        for (const [field, value] of Object.entries(expected.landed)) expect(task?.[field as keyof Task], field).toEqual(value);
      }
    });
  });
});
