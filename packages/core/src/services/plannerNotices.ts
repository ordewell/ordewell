import type { AiProvider, PlannerBackendId } from '../interfaces/IConfig';
import { VENDORS } from './apiProviders';
import { RUNNER_LABELS } from './runnerCatalog';

/*
 * Planner wording every surface shows as it is, kept apart from the readiness
 * check so the browser-side surfaces (the chat webview, the desktop renderer)
 * import it too: this module reads only the vendor and runner tables.
 */

/**
 * What a planner's model reads as while none is picked: for a coding agent a
 * working state, its own default model, never a missing setting.
 */
export const AGENT_DEFAULT_MODEL = 'agent default';

/**
 * The one line a surface's first screen shows when a found key is not used
 * for planning because a detected coding agent plans (ADR-0075), so the user
 * learns which planner is active, why, and where to change it. `pickPlanner`
 * is the surface's own spelling of the planner picker.
 */
export function describeUnusedPlanningKey(agent: PlannerBackendId, vendor: AiProvider, pickPlanner: string): string {
  const label = VENDORS[vendor]?.label ?? vendor;
  const found = vendor === 'openai_compatible' ? `${label} endpoint` : `${label} key`;
  const article = /^[aeiou]/i.test(found) ? 'An' : 'A';
  return `Planning with ${RUNNER_LABELS[agent] ?? agent}. ${article} ${found} was found and is not used for planning; ${pickPlanner} changes that.`;
}
