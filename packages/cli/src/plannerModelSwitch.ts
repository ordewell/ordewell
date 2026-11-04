import { CLI_PROVIDERS, getProviderMeta, isVendorModelFor, runnerForProvider } from '@ordewell/core';
import type { PlannerModelRecall, SettingsUpdateResponse } from '@ordewell/core';

/**
 * What a planner-switch response settled on, for the surface to word.
 *
 * The daemon decides this and says so (`switchRecall`), but only when the write
 * actually changed the planner. Reselecting the one already in use keeps its
 * model — the one it remembers, since every pick is remembered — so the
 * response's own model and effort are the answer, worded as a restore.
 */
export function plannerSwitchRecall(settings: SettingsUpdateResponse): PlannerModelRecall {
  if (settings.switchRecall) return settings.switchRecall;
  const model = settings.orchestratorModel;
  return model
    ? { model, effort: settings.plannerThinkingEffort, source: 'remembered' }
    : { model: '', effort: '', source: 'none' };
}

/**
 * Why `model` cannot be picked for coding-agent planner `provider`, or null.
 * A plain vendor id is refused even before discovery lands: the agent cannot
 * run it, and the user who typed it most likely meant to plan with that
 * vendor, which is a planner switch rather than a model.
 */
export function vendorModelRefusal(provider: string, model: string, pickPlanner: string): string | null {
  const meta = getProviderMeta(provider);
  if (!runnerForProvider(provider) || !meta || !isVendorModelFor(meta.id, model)) return null;
  return `${model} is a vendor's model, which ${meta.label} cannot run. To plan with that vendor, switch planner with ${pickPlanner}.`;
}

/**
 * Why coding agent `provider` cannot be switched to, or null. `installed` is
 * the daemon's runner list, the result of its install probe: an agent missing
 * from it would only fail the first turn with a spawn error.
 */
export function uninstalledPlannerRefusal(provider: string, installed: readonly string[], pickPlanner: string): string | null {
  const runner = runnerForProvider(provider);
  if (!runner || installed.includes(runner)) return null;
  const agents = CLI_PROVIDERS.filter((id) => installed.includes(runnerForProvider(id) ?? ''));
  const label = getProviderMeta(provider)?.label ?? provider;
  return agents.length > 0
    ? `${label} is not installed or not on PATH. Installed coding agents: ${agents.join(', ')}. Switch with ${pickPlanner}.`
    : `${label} is not installed or not on PATH, and no other coding agent is. Install one, or plan with an API provider through ${pickPlanner}.`;
}

/**
 * Why a runner that can run tasks but cannot plan was not taken as a planner,
 * or null for any id that is not such a runner. `runners` is the daemon's
 * runner list: an ACP runner sits there beside the coding agents, so calling
 * its id an unknown planner contradicts the list the user just read.
 */
export function taskOnlyRunnerRefusal(id: string, runners: readonly { id: string; name: string }[], pickPlanner: string): string | null {
  if (getProviderMeta(id)) return null;
  const runner = runners.find((r) => r.id === id);
  if (!runner) return null;
  return `${runner.name} runs tasks but cannot plan in Ordewell yet. The coding agents that plan are ${CLI_PROVIDERS.join(', ')}: switch with ${pickPlanner}.`;
}
