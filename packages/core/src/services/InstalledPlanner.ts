import type { PlannerBackendId } from '../interfaces/IConfig';
import { DEFAULT_RUNNERS, type RunnerId } from '../models/Task';
import { CLI_PROVIDERS, runnerForProvider } from './ProviderRegistry';
import { configuredProviderRunners } from './providerRunners';
import { withHostCredentials } from './hostCredentials';
import type { RunnerInstallation } from './RunnerInstallation';

/**
 * The planner a host falls back to when the user chose none (ADR-0009): an
 * installed coding agent, so a first run needs no API key, ahead of a found
 * vendor key the user chose nothing for (ADR-0076). Derived at startup and
 * again on a runner-list refresh, and never saved, so a `/planner` pick still
 * wins, and an agent installed while a host runs is found without a restart
 * (ADR-0039).
 *
 * Held per process because `BaseConfig.detectProvider` is sync, read on every
 * `aiProvider`, while finding an agent spawns its binary; a host probes at
 * startup and when its runner list is refreshed, and every config it builds
 * reads the answer here.
 */
let recorded: PlannerBackendId | null = null;
/** Every usable agent the latest probe found, in registry order; empty until one answers. */
let installedAgents: RunnerId[] = [];
let answered = true;
/**
 * Callers of {@link installedPlannerDetected} parked until the state next
 * settles. They wait on the state, not on the probe that was out when they
 * called, so a newer probe answering frees them while an older one is still held.
 */
let waiters: Array<() => void> = [];

function wakeWaiters(): void {
  const parked = waiters;
  waiters = [];
  for (const wake of parked) wake();
}
/**
 * Which probe may still write the state above. A reset or a newer probe moves
 * it on, so an older probe finishing late — leftover work of a disposed host or
 * test — answers its own caller but cannot refill or overwrite the global.
 */
let generation = 0;

/**
 * Every harness planner, in the order every planner picker lists them, whose
 * agent `plannerUsability` calls usable. The agents are asked together, so a
 * start waits for the slowest of them rather than for each in turn.
 */
async function findInstalledAgents(installation: Pick<RunnerInstallation, 'plannerUsability'>): Promise<RunnerId[]> {
  const usable = await Promise.all(CLI_PROVIDERS.map(async (id) => {
    const runner = runnerForProvider(id);
    if (runner === null) return false;
    // One agent's failing check is that agent not usable, not the end of the
    // search: another may be installed and must still be found.
    try {
      return (await installation.plannerUsability(runner)).usable;
    } catch {
      return false;
    }
  }));
  return CLI_PROVIDERS.filter((_, i) => usable[i]);
}

/** The first of {@link findInstalledAgents}; null when none is usable. */
export async function findInstalledPlanner(installation: Pick<RunnerInstallation, 'plannerUsability'>): Promise<PlannerBackendId | null> {
  return (await findInstalledAgents(installation))[0] ?? null;
}

/**
 * Find the installed agent and record it, for a host to start at startup. A
 * goal can be typed before the probe answers, so every planner turn waits on
 * {@link installedPlannerDetected} rather than planning with openrouter.
 */
export function detectInstalledPlanner(installation: Pick<RunnerInstallation, 'plannerUsability'>): Promise<PlannerBackendId | null> {
  // A probe that throws is no agent found: the turn waiting on it must still
  // start, and say what the openrouter fallback is missing.
  const mine = ++generation;
  const probe: Promise<PlannerBackendId | null> = findInstalledAgents(installation).catch((): RunnerId[] => []).then((agents) => {
    const id = agents[0] ?? null;
    // Only the latest probe speaks for the recorded answer.
    if (mine === generation) {
      recordInstalledPlanner(id);
      installedAgents = agents;
      answered = true;
      wakeWaiters();
    }
    return id;
  });
  answered = false;
  return probe;
}

/** Settles once the latest probe has recorded its answer; at once when none was started. */
export async function installedPlannerDetected(): Promise<void> {
  // A wake-up is not an answer: a reset can be followed at once by a new
  // probe, so re-check and park again until the current generation answered.
  while (!answered) await new Promise<void>((resolve) => { waiters.push(resolve); });
}

/**
 * Whether the latest probe has recorded its answer, for a check that must run
 * at once when it can: a planner preflight read while the probe is out would
 * judge the openrouter fallback the answer may replace.
 */
export function installedPlannerAnswered(): boolean {
  return answered;
}

export function recordInstalledPlanner(id: PlannerBackendId | null): void {
  recorded = id;
}

export function recordedInstalledPlanner(): PlannerBackendId | null {
  return recorded;
}

/**
 * The runners enabled while the user has never saved a choice: the agents the
 * latest probe found installed, so a Codex-only or OpenCode-only host can plan
 * and run on its first start, then the built-in runner on every provider the
 * host holds a key for (ADR-0070), so a key alone runs tasks too. The host's
 * own: its environment, which `~/.ordewell/.env` fills in the CLI and the
 * daemon, and the credentials it holds (VS Code's secret storage), never a
 * workspace's `.ordewell/env` or `.envrc`, which differ by workspace while this
 * list is one per host. A key only there lists its runner, and the user
 * enables it;
 * DEFAULT_RUNNERS while neither was found or no probe has answered and no key
 * is set. Read on each call and never saved, so an agent installed or a key
 * set later joins — a runner-list refresh asks again — and a saved choice,
 * even an empty one, still wins.
 * Every host's config reads it here, so the daemon, CLI, TUI and VS Code agree.
 */
export function defaultEnabledRunners(): RunnerId[] {
  const enabled = [...installedAgents, ...configuredProviderRunners(withHostCredentials(process.env))];
  return enabled.length > 0 ? enabled : [...DEFAULT_RUNNERS];
}

/** For tests: the recorded default is process-wide, so one case's must not decide the next's. */
export function resetInstalledPlanner(): void {
  generation++;
  recorded = null;
  installedAgents = [];
  answered = true;
  wakeWaiters();
}
