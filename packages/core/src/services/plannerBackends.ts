import type { AiProvider, PlannerBackendId } from '../interfaces/IConfig';
import type { RunnerId } from '../models/Task';
import { PROVIDER_PRIORITY, VENDORS } from './apiProviders';
import { RUNNER_CATALOG } from './runnerCatalog';
import type { RunnerAuth } from './runnerAuth';

/** One harness planner: the runner that plans, under the manifest's own name. */
export interface HarnessPlanner {
  id: PlannerBackendId;
  label: string;
  runner: RunnerId;
}

/** One runner's planner usability, as `RunnerInstallation.plannerUsability` reports it. */
export interface PlannerUsability {
  usable: boolean;
  reason?: string;
  /** The runner's own login verdict, beside usability: a signed-out agent is still offered. */
  auth?: RunnerAuth;
}

/**
 * One entry of the planner backend list (ADR-0009). `id` is the
 * `PlannerBackendId` either way; `runner` is set only for a harness planner, whose model catalog
 * comes from that runner, and `reason` is the second line a surface renders —
 * the block detail for a harness planner, the API-key variable for a vendor.
 */
export interface PlannerBackendEntry {
  id: PlannerBackendId;
  label: string;
  kind: 'harness' | 'vendor';
  runner?: string;
  usable: boolean;
  reason?: string;
  /** Set for a harness planner whose login status was asked; never a gate on `usable`. */
  auth?: RunnerAuth;
}

/** The detail a usable harness planner is always shown with. */
export const HARNESS_PLANNER_REASON = 'coding agent · no API key needed';

/** Shown for a harness planner no host has reported a status for: it may not be installed. */
export const HARNESS_PLANNER_UNAVAILABLE_REASON = 'not available';

/**
 * The planner backends every surface offers, in order: the harness planners
 * first, always listed so a missing CLI is greyed with its reason rather than
 * hidden, then the configured vendors in `PROVIDER_PRIORITY` order. Pure: the
 * caller supplies the harness list and what it knows of each runner (VS Code
 * its `plannerUsability` results, the TUI its installed set) and maps the
 * entries to its own item type, keeping surface-specific affordances — e.g. the
 * CLI's empty-vendor placeholder — to itself.
 */
export function plannerBackendEntriesFor(
  harnessPlanners: readonly HarnessPlanner[],
  usability: Readonly<Record<string, PlannerUsability>>,
  configured: readonly AiProvider[],
): PlannerBackendEntry[] {
  const harness: PlannerBackendEntry[] = harnessPlanners.map(({ id, label, runner }) => {
    const status = usability[runner];
    const signedOut = status?.auth?.state === 'signed-out';
    return {
      id,
      label,
      kind: 'harness' as const,
      runner,
      usable: status?.usable ?? false,
      reason: status
        ? (status.reason ?? (signedOut ? (status.auth?.detail ?? 'not logged in') : HARNESS_PLANNER_REASON))
        : HARNESS_PLANNER_UNAVAILABLE_REASON,
      ...(status?.auth ? { auth: status.auth } : {}),
    };
  });
  const vendors: PlannerBackendEntry[] = PROVIDER_PRIORITY
    .filter((id) => configured.includes(id))
    .map((id) => ({
      id,
      label: VENDORS[id].label,
      kind: 'vendor' as const,
      usable: true,
      reason: VENDORS[id].apiKeyEnvVar,
    }));
  return [...harness, ...vendors];
}

/**
 * The same list from core's built-in runner catalog alone, for a renderer that
 * cannot load the Node-bound provider registry. Hosts use the registry's own
 * `plannerBackendEntries`, which also sees a plugin runner.
 */
export function builtinPlannerBackends(
  usability: Readonly<Record<string, PlannerUsability>>,
  configured: readonly AiProvider[],
): PlannerBackendEntry[] {
  return plannerBackendEntriesFor(
    RUNNER_CATALOG.map((runner) => ({ id: runner.id, label: runner.label, runner: runner.id })),
    usability,
    configured,
  );
}
