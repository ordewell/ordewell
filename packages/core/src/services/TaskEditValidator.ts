import { Task, RunnerId, DiscoveredModel, TaskModelAssignment, TaskMode } from '../models/Task';
import { canSetDependencies } from './TaskOps';
import { effectiveAllowlist } from './ModelAllowlistResolver';
import type { RunnerModeInfo } from './ModeResolver';

/**
 * Who is making the edit. The planner (`applyTaskOps`) and the direct-edit
 * path (`Session.updateTask`/`setTaskDependencies`, reached by the TUI, the
 * webview task card, and `PUT /tasks/:taskId`) are deliberately asymmetric —
 * see CONTEXT.md, "Direct edit vs planner edit". The planner may not reach
 * into a task that is running or already finished; the direct path may,
 * because it is the user editing their own plan, and pays what that costs at
 * the call site (cancelling a live runner, releasing blocked dependents).
 */
export type TaskEditActor = 'planner' | 'direct';

export interface TaskEditCheck {
  ok: boolean;
  error?: string;
  /**
   * Fields a type flip strips of meaning, to be force-cleared by the caller
   * (set to `undefined` in the applied changes) and named in whatever summary
   * reaches the transcript. Only lists fields the target actually had a value
   * for — nothing to clear reads as nothing lost.
   */
  clear?: (keyof Task)[];
}

const AI_ONLY_FIELDS = ['assignedModel', 'thinkingEffort', 'taskMode', 'autonomy'] as const satisfies readonly (keyof Task)[];

/**
 * The catalog a model/task-mode edit is checked against — the same discovered
 * models and manifest modes the planner was shown in the per-turn catalog
 * block (`Session.catalogBlock`), so a refusal here can never name something
 * as invalid that the planner was never told about, or vice versa.
 */
export interface EditCatalog {
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>;
  runnerModes: Partial<Record<RunnerId, RunnerModeInfo[]>>;
  /** Raw (unfiltered) allowlist, keyed by runner — the same shape `coerceAssignments` takes. */
  perRunnerAllowlist?: Partial<Record<RunnerId, string[]>>;
}

/**
 * Whether an assigned model and task mode are things the target runner
 * actually offers. Invented ids are refused rather than silently substituted
 * downstream (`coerceAssignments` remains the safety net for paths that never
 * go through this validator) — the planner gets the refusal, with the runner
 * named, through the same repair loop as every other edit rejection.
 *
 * `catalog` is optional: callers with no discovered catalog on hand (most unit
 * tests, a runner with no manifest modes) skip these checks rather than
 * refusing everything sight-unseen.
 */
export function checkModelAndModeValidity(
  runner: RunnerId,
  assignedModel: TaskModelAssignment | undefined,
  taskMode: TaskMode | undefined,
  catalog: EditCatalog | undefined,
): TaskEditCheck {
  if (!catalog) return { ok: true };

  if (assignedModel) {
    const models = catalog.modelsByRunner[runner];
    if (models) {
      const modelId = assignedModel.modelId;
      if (!models.some((m) => m.modelId === modelId)) {
        return { ok: false, error: `Runner "${runner}" does not offer model "${modelId}"` };
      }
      const allowed = effectiveAllowlist(catalog.perRunnerAllowlist?.[runner], runner, catalog.modelsByRunner);
      if (allowed && !allowed.includes(modelId)) {
        return { ok: false, error: `Model "${modelId}" is excluded by the allowlist for runner "${runner}"` };
      }
    }
  }

  if (taskMode !== undefined) {
    const modes = catalog.runnerModes[runner];
    if (modes && modes.length > 0 && !modes.some((m) => m.id === taskMode)) {
      return { ok: false, error: `Runner "${runner}" has no task mode "${taskMode}" — valid modes: ${modes.map((m) => m.id).join(', ')}` };
    }
  }

  return { ok: true };
}

/**
 * Coherence between `type` and the fields that only make sense for one side
 * of it. Deriving user steps from an AI prompt (or vice versa) would fabricate
 * instructions nobody wrote (ADR-0001: the plan is the source of truth), so a
 * flip that lacks the content the new type needs is refused rather than
 * silently patched — the planner gets that refusal back through the repair
 * loop; a direct edit gets it as a thrown reason. A flip that IS well-formed
 * clears the fields that stopped meaning anything, named for the caller.
 */
function typeCoherenceCheck(target: Task, changes: Partial<Task>): TaskEditCheck | null {
  if (!changes.type || changes.type === target.type) return null;

  if (changes.type === 'user') {
    if (!Array.isArray(changes.userSteps) || changes.userSteps.length === 0) {
      return { ok: false, error: `"${target.title}" cannot become a manual task without user steps — include "userSteps" in this edit` };
    }
    return { ok: true, clear: AI_ONLY_FIELDS.filter((f) => target[f] !== undefined) };
  }

  // changes.type === 'ai'
  if (!changes.prompt || !changes.prompt.trim()) {
    return { ok: false, error: `"${target.title}" cannot become an AI task without a prompt — include "prompt" in this edit` };
  }
  return { ok: true, clear: target.userSteps && target.userSteps.length > 0 ? ['userSteps'] : [] };
}

/**
 * The rules governing one task edit, shared by both actors. Lock rules
 * (running/completed) apply to the planner only. Well-formedness rules — like
 * a hand-set dependency list, the one edit that can leave the plan
 * unschedulable, and type/content coherence on an AI↔MAN flip — describe the
 * task rather than who asked, so they run for both, through the same
 * {@link canSetDependencies} guard the pickers and the API read.
 */
export function validateTaskEdit(
  actor: TaskEditActor,
  tasks: Task[],
  taskId: string,
  changes: Partial<Task>,
  catalog?: EditCatalog,
): TaskEditCheck {
  const target = tasks.find((t) => t.id === taskId);
  if (!target) return { ok: false, error: 'Task not found' };

  if (actor === 'planner') {
    if (target.status === 'in_progress') return { ok: false, error: `"${target.title}" is running and cannot be modified` };
    if (target.status === 'completed') return { ok: false, error: `"${target.title}" is completed and cannot be modified` };
  }

  if (changes.dependencies) {
    const depCheck = canSetDependencies(tasks, taskId, changes.dependencies);
    if (!depCheck.ok) return depCheck;
  }

  const coherence = typeCoherenceCheck(target, changes);
  if (coherence && !coherence.ok) return coherence;

  const runner = changes.assignedRunner ?? target.assignedRunner;
  const validity = checkModelAndModeValidity(runner, changes.assignedModel, changes.taskMode, catalog);
  if (!validity.ok) return validity;

  return coherence ?? { ok: true };
}
