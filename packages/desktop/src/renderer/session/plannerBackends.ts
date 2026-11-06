import type { AiProvider, RunnersResponse } from '@ordewell/core';
import {
  HARNESS_PLANNER_UNAVAILABLE_REASON, RUNNER_CATALOG, RUNNER_LABELS, builtinPlannerBackends, type PlannerUsability,
} from '@ordewell/core/plan-utils';
import type { PlannerBackend } from '@ordewell/ui/protocol';

type RunnerEntry = RunnersResponse['runners'][number];

/**
 * The planners a surface offers, from core's one list (ADR-0009): every
 * built-in agent, an uninstalled one included and greyed with its reason, then
 * the configured vendors. `runners` is the daemon's installed list, so an
 * absent runner is the one this machine does not have.
 */
export function plannerBackendsFor(
  runners: readonly RunnerEntry[],
  providers: readonly AiProvider[],
): PlannerBackend[] {
  const installed = new Map(runners.map((runner) => [runner.id, runner]));
  const usability: Record<string, PlannerUsability> = {};
  for (const runner of RUNNER_CATALOG) {
    const entry = installed.get(runner.id);
    // An agent the daemon found but cannot start (too old for its ACP profile,
    // or no directly spawnable file) stays listed with the daemon's reason
    // rather than being offered as a planner that will fail at start.
    usability[runner.id] = !entry
      ? { usable: false, reason: HARNESS_PLANNER_UNAVAILABLE_REASON }
      : entry.usable === false
        ? { usable: false, reason: entry.reason ?? HARNESS_PLANNER_UNAVAILABLE_REASON, ...(entry.auth ? { auth: entry.auth } : {}) }
        : { usable: true, ...(entry.auth ? { auth: entry.auth } : {}) };
  }
  const backends: PlannerBackend[] = builtinPlannerBackends(usability, providers);
  // A runner a workspace's own manifest adds is still offered: core's catalog
  // names the shipped agents, and the daemon may know one more.
  for (const runner of runners) {
    if (RUNNER_CATALOG.some((catalogEntry) => catalogEntry.id === runner.id)) continue;
    backends.push({
      id: runner.id,
      label: runner.name || RUNNER_LABELS[runner.id] || runner.id,
      kind: 'harness',
      runner: runner.id,
      usable: runner.usable !== false,
      ...(runner.usable === false ? { reason: runner.reason ?? HARNESS_PLANNER_UNAVAILABLE_REASON } : {}),
      ...(runner.auth ? { auth: runner.auth } : {}),
    });
  }
  return backends;
}
