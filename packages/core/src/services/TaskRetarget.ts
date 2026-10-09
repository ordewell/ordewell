import type { DiscoveredModel, RunnerId, Task } from '../models/Task';
import { clampThinkingEffort } from './ModelAllowlistResolver';
import type { RunnerModeInfo } from './ModeResolver';

/** What a runner offers a task: the models discovered for it and the modes its manifest declares. */
export interface RunnerCatalog {
  models: DiscoveredModel[];
  modes: RunnerModeInfo[];
  /**
   * The mode a task lands on when it carries none this runner offers: the
   * manifest's `autonomous`/`safe`-tagged mode under the user's toggle
   * (ADR-0001). Absent, `modes[0]` stands in — which for Codex is its
   * workspace-write sandbox, not the full access an unattended run needs.
   */
  defaultMode?: string;
}

/**
 * The model, thinking effort and mode a runner offers for a task.
 *
 * A task's model, effort and mode are all scoped to its runner:
 * `claude-sonnet-4-5` on Codex, or `acceptEdits` on OpenCode, are not degraded
 * choices but unspawnable ones. So this is where any task acquires a runnable
 * assignment — a runner change (below) and a hand-added task derive it the same
 * way. Each field in `current` is preserved when the runner also offers it, and
 * otherwise snapped to that runner's preferred entry (discovery already sorts
 * models by the manifest's `preferredPatterns`; the mode is the catalog's
 * `defaultMode`).
 *
 * An empty catalog means discovery failed — not that the runner offers nothing. That field is left out of the
 * patch and the runner validates last, matching `coerceAssignments`.
 */
export function runnerAssignment(
  catalog: RunnerCatalog,
  current?: Pick<Task, 'assignedModel' | 'taskMode'>,
): Partial<Task> {
  const changes: Partial<Task> = {};

  const kept = current?.assignedModel && catalog.models.find((m) => m.modelId === current.assignedModel!.modelId);
  const model = kept ?? catalog.models[0];
  if (model) {
    const thinkingEffort = clampThinkingEffort(current?.assignedModel?.thinkingEffort, model.variants);
    changes.assignedModel = {
      modelId: model.modelId,
      modelLabel: model.modelLabel,
      thinkingEffort,
      availableVariants: model.variants.map((v) => v.id),
    };
    // Task.thinkingEffort predates assignedModel.thinkingEffort and is still
    // read by migration and task_ops. Left behind it would name an effort the
    // new model has no variant for.
    changes.thinkingEffort = thinkingEffort;
  }

  if (catalog.modes.length > 0) {
    changes.taskMode = catalog.modes.some((m) => m.id === current?.taskMode) ? current!.taskMode : catalog.defaultMode ?? catalog.modes[0].id;
  }

  return changes;
}

/**
 * Move a task onto a different runner, carrying its model, thinking effort and
 * mode over to values that runner actually offers. A runner change is never a
 * single-field edit — it either brings the other three with it or leaves the
 * task unrunnable.
 *
 * Returns the patch to apply, or `{}` when there is nothing to change.
 */
export function retargetTaskRunner(task: Task, runner: RunnerId, catalog: RunnerCatalog): Partial<Task> {
  if (task.type === 'user') return {};
  if (task.assignedRunner === runner) return {};
  return { assignedRunner: runner, ...runnerAssignment(catalog, task) };
}
