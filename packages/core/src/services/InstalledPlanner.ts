import type { PlannerBackendId } from '../interfaces/IConfig';
import { DEFAULT_RUNNERS, type RunnerId } from '../models/Task';
import { CLI_PROVIDERS, runnerForProvider } from './ProviderRegistry';
import { configuredProviderRunners } from './providerRunners';
import { withHostCredentials } from './hostCredentials';
import type { RunnerInstallation } from './RunnerInstallation';
import type { RunnerAuth } from './runnerAuth';

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
/** The installed agents the latest probe's status commands said are signed out. */
let signedOutAgents = new Set<RunnerId>();
/** The installed agents the latest probe's status commands said are signed in, in registry order. */
let signedInAgents: RunnerId[] = [];
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

/** An installed agent and what its own status command said of the sign-in; undefined when it was not asked. */
interface FoundAgent {
  id: RunnerId;
  signIn: RunnerAuth['state'] | undefined;
}

/**
 * Every harness planner, in the order every planner picker lists them, whose
 * agent `plannerUsability` calls usable, with the sign-in verdict that rode
 * beside it. The agents are asked together, so a start waits for the slowest
 * of them rather than for each in turn.
 */
async function findInstalledAgents(installation: Pick<RunnerInstallation, 'plannerUsability'>): Promise<FoundAgent[]> {
  const found = await Promise.all(CLI_PROVIDERS.map(async (id): Promise<FoundAgent | null> => {
    const runner = runnerForProvider(id);
    if (runner === null) return null;
    // One agent's failing check is that agent not usable, not the end of the
    // search: another may be installed and must still be found.
    try {
      const usability = await installation.plannerUsability(runner);
      return usability.usable ? { id, signIn: usability.auth?.state } : null;
    } catch {
      return null;
    }
  }));
  return found.filter((agent): agent is FoundAgent => agent !== null);
}

/**
 * The default among the usable agents (ADR-0076): the first, in registry
 * order, not known to be signed out. A sign-in nobody could read (a slow or
 * failing status command) counts as good enough, so an unanswered check never
 * hands the default to a later agent. Only when every installed agent is
 * signed out is the first of them the default, so the refusal names its login.
 */
function defaultOf(agents: FoundAgent[]): RunnerId | null {
  return (agents.find((agent) => agent.signIn !== 'signed-out') ?? agents[0])?.id ?? null;
}

/** The default of {@link findInstalledAgents}; null when none is usable. */
export async function findInstalledPlanner(installation: Pick<RunnerInstallation, 'plannerUsability'>): Promise<PlannerBackendId | null> {
  return defaultOf(await findInstalledAgents(installation));
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
  const probe: Promise<PlannerBackendId | null> = findInstalledAgents(installation).catch((): FoundAgent[] => []).then((agents) => {
    const id = defaultOf(agents);
    // Only the latest probe speaks for the recorded answer.
    if (mine === generation) {
      recordInstalledPlanner(id);
      installedAgents = agents.map((agent) => agent.id);
      signedOutAgents = new Set(agents.filter((agent) => agent.signIn === 'signed-out').map((agent) => agent.id));
      signedInAgents = agents.filter((agent) => agent.signIn === 'signed-in').map((agent) => agent.id);
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
 * Whether the latest probe found this installed agent signed out. Read by the
 * sync `detectProvider`, which hands planning to a found key instead: the probe
 * that picked the default is the one whose verdict counts, whatever workspace
 * its installation records sign-ins under.
 */
export function installedAgentSignedOut(agent: PlannerBackendId): boolean {
  return signedOutAgents.has(agent);
}

/**
 * The first installed agent, other than `except`, that the latest probe found
 * signed in; null when there is none. A refusal of a signed-out planner names
 * it, so the way on is a switch rather than a login.
 */
export function signedInInstalledAgent(except: PlannerBackendId): RunnerId | null {
  return signedInAgents.find((agent) => agent !== except) ?? null;
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
  signedOutAgents = new Set();
  signedInAgents = [];
  answered = true;
  wakeWaiters();
}
