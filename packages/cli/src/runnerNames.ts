import { CLI_PROVIDERS, RunnerRegistry } from '@ordewell/core';

/**
 * The runners help and error text names, read from the registry on each call
 * so that text lists what is registered instead of a copy of it that goes
 * stale when a runner is added.
 */
function manifests() {
  return new RunnerRegistry().list().map((entry) => entry.manifest);
}

/** Only the runners with a harness planner: a runner can run tasks before it can plan. */
function plannerManifests() {
  const planners: readonly string[] = CLI_PROVIDERS;
  return manifests().filter((m) => planners.includes(m.name));
}

const or = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`);

/** Runner ids in picker order, as a comma-separated list. */
export function runnerIdList(): string {
  return manifests().map((m) => m.name).join(', ');
}

/** The ids of the runners that can plan, as a comma-separated list. */
export function plannerIdList(): string {
  return plannerManifests().map((m) => m.name).join(', ');
}

/** The ids of the runners that can plan, as a `|`-separated choice, as a usage line writes one. */
export function plannerIdChoice(): string {
  return plannerManifests().map((m) => m.name).join('|');
}

/** The display names of the runners that can plan, as "A, B or C". */
export function plannerNamesOr(): string {
  return or(plannerManifests().map((m) => m.displayName));
}
