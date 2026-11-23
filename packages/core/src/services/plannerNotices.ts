import type { AiProvider, PlannerBackendId } from '../interfaces/IConfig';
import { VENDORS } from './apiProviders';
import type { RunnerId } from '../models/Task';
import { RUNNER_INSTALL_DOCS, RUNNER_LABELS } from './runnerCatalog';

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
 * for planning because a detected coding agent plans (ADR-0076), so the user
 * learns which planner is active, why, and where to change it. `pickPlanner`
 * is the surface's own spelling of the planner picker.
 */
export function describeUnusedPlanningKey(agent: PlannerBackendId, vendor: AiProvider, pickPlanner: string): string {
  const label = VENDORS[vendor]?.label ?? vendor;
  const found = vendor === 'openai_compatible' ? `${label} endpoint` : `${label} key`;
  const article = /^[aeiou]/i.test(found) ? 'An' : 'A';
  return `Planning with ${RUNNER_LABELS[agent] ?? agent}. ${article} ${found} was found and is not used for planning; ${pickPlanner} changes that.`;
}

/** One coding agent a first screen offers to install, with the command its vendor documents. */
export interface AgentInstallRoute {
  runner: RunnerId;
  label: string;
  command: string;
  /** The vendor's own setup page, for every other way in and for the sign-in. */
  docs: string;
}

/*
 * The two agents most people already pay for, offered first when nothing can
 * plan. The commands are each vendor's documented one-line installer; the rest
 * of the agents stay one /planner away once installed.
 */
const INSTALLERS: Readonly<Record<'posix' | 'windows', readonly [RunnerId, string][]>> = {
  posix: [
    ['claude-code', 'curl -fsSL https://claude.ai/install.sh | bash'],
    ['codex', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'],
  ],
  windows: [
    ['claude-code', 'irm https://claude.ai/install.ps1 | iex'],
    ['codex', 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'],
  ],
};

/** How to install a coding agent on `platform`, for a first screen with nothing that can plan. */
export function agentInstallRoutes(platform: 'posix' | 'windows'): AgentInstallRoute[] {
  return INSTALLERS[platform].map(([runner, command]) => ({
    runner,
    label: RUNNER_LABELS[runner] ?? runner,
    command,
    docs: RUNNER_INSTALL_DOCS[runner] ?? '',
  }));
}

/** Ordewell has no sign-in of its own for an agent: the agent's first run asks. */
export const AGENT_SIGN_IN_NOTE = 'Signing in happens in the agent itself: run claude or codex once in a terminal and follow its sign-in prompt.';
