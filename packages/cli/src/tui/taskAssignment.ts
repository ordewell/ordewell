import type { ModeView, ModelView, TaskView } from './state';

/**
 * Whether a runner can spawn a model: discovery tagged it for that runner, or
 * it didn't scope the model to one at all.
 *
 * `state.models` is the union of every runner's catalog, so this is the rule
 * that keeps one runner's ids out of another's lists — a Codex model offered
 * for a Claude Code task, or allowlisted for it, is not a degraded choice but
 * an unspawnable one. Keyed on the runner id rather than on a task so the
 * allowlist pickers (which have a runner and no task) share it.
 */
export function runnerServes(runner: string | undefined, model: Pick<ModelView, 'runners'>): boolean {
  return !runner || !model.runners || model.runners.length === 0 || model.runners.includes(runner);
}

export function modelsForRunner(models: ModelView[], runner: string | undefined): ModelView[] {
  return models.filter((model) => runnerServes(runner, model));
}

/** A model is assignable to a task only if the task's runner serves it. */
export function runnerAccepts(task: TaskView, model: Pick<ModelView, 'runners'>): boolean {
  return runnerServes(task.assignedRunner, model);
}

export function modelsForTask(models: ModelView[], task: TaskView): ModelView[] {
  return modelsForRunner(models, task.assignedRunner);
}

export function effortsForTask(models: ModelView[], task: TaskView): { id: string; label: string }[] {
  const model = models.find((candidate) => candidate.id === task.assignedModel?.modelId);
  if (model?.variants?.length) return model.variants;
  return (task.assignedModel?.availableVariants ?? []).map((id) => ({
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
  }));
}

/** Carries the current effort over only if the new model still supports it, so switching models never leaves a stale effort assigned. */
export function assignedModelFor(model: ModelView, currentEffort: string | undefined): NonNullable<TaskView['assignedModel']> {
  const variants = model.variants ?? [];
  const thinkingEffort = variants.some((variant) => variant.id === currentEffort) ? currentEffort : undefined;
  return {
    modelId: model.id,
    modelLabel: model.label,
    thinkingEffort,
    availableVariants: variants.map((variant) => variant.id),
  };
}

/** The modes a task may run in — its runner's, since a mode id means nothing outside the runner that declares it. */
export function modesForTask(modesByRunner: Record<string, ModeView[]>, task: TaskView): ModeView[] {
  if (!task.assignedRunner) return [];
  return modesByRunner[task.assignedRunner] ?? [];
}
