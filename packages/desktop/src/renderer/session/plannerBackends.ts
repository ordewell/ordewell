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
  // The daemon's readiness rides on each agent's row, read from the same
  // record and discovery answer it judges a pick by (ADR-0052).
  const backends: PlannerBackend[] = builtinPlannerBackends(usability, providers).map((backend) => {
    const readiness = backend.kind === 'harness' ? installed.get(backend.runner ?? backend.id)?.readiness : undefined;
    return readiness ? { ...backend, readiness } : backend;
  });
  // An agent the daemon says can plan is still offered when core's catalog,
  // which names the shipped agents, does not. A runner that cannot plan is no
  // harness planner: a provider runner above all, whose id is a vendor planner's
  // already listed above, the API planner on that same key (ADR-0009, ADR-0070).
  for (const runner of runners) {
    if (RUNNER_CATALOG.some((catalogEntry) => catalogEntry.id === runner.id)) continue;
    if (runner.plans !== true || runner.provider !== undefined) continue;
    backends.push({
      id: runner.id,
      label: runner.name || RUNNER_LABELS[runner.id] || runner.id,
      kind: 'harness',
      runner: runner.id,
      usable: runner.usable !== false,
      ...(runner.usable === false ? { reason: runner.reason ?? HARNESS_PLANNER_UNAVAILABLE_REASON } : {}),
      ...(runner.auth ? { auth: runner.auth } : {}),
      ...(runner.readiness ? { readiness: runner.readiness } : {}),
    });
  }
  return backends;
}

/**
 * The runner a planner provider drives, or none for a vendor. The backend list
 * is core's one planner list (ADR-0009), the same `runnerForProvider` mapping
 * VS Code sends, so a workspace manifest's own agent resolves too; it is read
 * here rather than from core's main barrel because that barrel is Node-only.
 */
export function plannerRunnerFor(provider: string, backends: readonly PlannerBackend[]): string | undefined {
  if (!provider) return undefined;
  const backend = backends.find((candidate) => candidate.id === provider);
  return backend?.kind === 'harness' ? backend.runner ?? backend.id : undefined;
}
