import type { TaskQueryCatalog } from './TaskQuery';
import { assignableRunners, type AssignmentCatalog, type AssignmentWriter, type RunnerCatalog } from './TaskAssignment';
import type { ModelResolver } from './ModelResolver';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { IConfig } from '../interfaces/IConfig';
import { filterModelsForPrompt } from './ModelAllowlistResolver';
import { runnerModesFrom, type RunnerModeInfo } from './ModeResolver';
import type { AssignmentScope } from './AssignmentScope';
import { runnerForProvider } from './ProviderRegistry';
import { withinLimits, type MandateLimits } from './Mandate';
import type { DiscoveredModel, RunnerId } from '../models/Task';
import { RUNNER_LABELS } from './runnerCatalog';

type ModelsByRunner = Partial<Record<RunnerId, DiscoveredModel[]>>;

/**
 * How long a planner's read, or planning's start, waits on model discovery
 * before answering with what is known (ADR-0022 L4). A discovery still
 * running goes on, and what it finds is kept for the next read: one CLI that
 * hangs while listing its models costs minutes (`opencode` runs three
 * commands, each retried once at 45s), longer than a planner's turn can wait.
 */
export const DISCOVERY_WAIT_MS = 10_000;

export interface SessionCatalogDeps {
  config: Pick<IConfig, 'enabledRunners' | 'autonomousMode' | 'aiProvider'>;
  /** Whether a task's mode defaults to its runner's autonomous one: a child's mandate says, the config's level unless set (ADR-0056 M6). */
  autonomous?: () => boolean;
  /** The runners and models a child's mandate holds it to, which a live setting can only narrow (ADR-0056 M3). Unset, or undefined, at a root: the settings are what it holds. */
  held?: () => Pick<MandateLimits, 'runners' | 'models'> | undefined;
  registry: Pick<RunnerRegistry, 'getManifest'>;
  modelResolver: Pick<ModelResolver, 'modelsForRunners' | 'getCachedRunnerModels'>;
  /** Read at each call: a toggle or allowlist edit made since the session was built counts (#69). */
  settings: () => { enabledRunners?: RunnerId[]; modelAllowlist?: Record<string, string[]> };
  /** The runners of the plan being edited; empty while the session has none. */
  planRunners: () => RunnerId[];
  /**
   * Why an enabled runner is not offered to a planner right now, read at each
   * call: an agent known to be signed out ('signed out'), which is offered
   * again by itself once its check reads signed in (ADR-0052). Undefined
   * offers it. The user's settings keep it enabled either way.
   */
  withheld?: (runner: RunnerId) => string | undefined;
  /** Whether a task's runner is up: an attempt claimed, running, quiet or waiting on someone. */
  liveRunner?: (taskId: string) => boolean;
}

/**
 * What a session may assign: the enabled runners, their modes, the models
 * discovery found for them and the allowlist narrowing those. Every view of
 * it — the planner's per-turn block, its tools, a user's direct edit — reads
 * it here, so none can be shown or checked against something the others are not.
 *
 * The discovered models are remembered per runner and only ever merged into:
 * discovering one runner must not forget another's, since coercion later clamps
 * thinking efforts against whatever was last found.
 */
export class SessionCatalog {
  private discovered: ModelsByRunner = {};
  /** Each runner's discovery still running, so a later read joins it rather than asking the resolver again. */
  private pending = new Map<RunnerId, Promise<DiscoveredModel[]>>();
  /** Bumped by {@link reset}: a discovery begun for the last goal lands nothing in the next one's catalog. */
  private generation = 0;

  constructor(private readonly deps: SessionCatalogDeps) {}

  private autonomous(): boolean {
    return this.deps.autonomous?.() ?? this.deps.config.autonomousMode;
  }

  /** The settings as they stand, within what this node's mandate holds. */
  private assignable(): { runners: RunnerId[]; allowlist: Record<string, string[]> } {
    const { enabledRunners, modelAllowlist = {} } = this.deps.settings();
    const enabled = (enabledRunners ?? this.deps.config.enabledRunners).filter((runner) => this.deps.registry.getManifest(runner) !== undefined);
    const held = this.deps.held?.();
    return held ? withinLimits(held, enabled, modelAllowlist) : { runners: enabled, allowlist: modelAllowlist };
  }

  /** The runners enabled right now. */
  enabledRunners(): RunnerId[] {
    return this.assignable().runners;
  }

  /** The enabled runners a planner is offered now: those not {@link withheld}. */
  offeredRunners(): RunnerId[] {
    return this.enabledRunners().filter((runner) => this.deps.withheld?.(runner) === undefined);
  }

  /**
   * The enabled runners a planner is not offered now, each with the line it is
   * told why, so it neither assigns one nor asks the user to enable it.
   */
  withheld(): { runner: RunnerId; reason: string }[] {
    return this.enabledRunners().flatMap((runner) => {
      const why = this.deps.withheld?.(runner);
      return why === undefined ? [] : [{ runner, reason: `${RUNNER_LABELS[runner] ?? runner}: ${why}, not offered until signed in` }];
    });
  }

  /**
   * The runners `writer` may put a task on now ({@link assignableRunners});
   * undefined means any. A planner, the supervisor included, is held to the
   * offered ones; the user's own edit is not.
   */
  runnersFor(writer: AssignmentWriter): RunnerId[] | undefined {
    return assignableRunners(writer, this.offeredRunners());
  }

  /**
   * The allowlist in force right now. Unset means no restriction — falling
   * back to the one planning started under would keep a restriction the user
   * has since cleared.
   */
  allowlist(): Record<string, string[]> {
    return this.assignable().allowlist;
  }

  /**
   * The enabled runners and allowlist together, for whoever compares an
   * assignment with them. The user's enabled runners, not the offered ones: a
   * task on a signed-out agent is not switched off, and fails at its start
   * with the sign-in hint.
   */
  scope(): AssignmentScope {
    return { enabledRunners: this.enabledRunners(), allowlist: this.allowlist(), models: this.models() };
  }

  /**
   * The discovered catalog as the resolver holds it now, per runner, with this
   * session's own discovery as the fallback where the resolver has nothing
   * cached. The resolver's cache outlives this session's snapshot in both
   * directions — an allowlist picker re-discovers into it mid-session — and a
   * model allowed after that must reach the planner with its real label and
   * variants, not as an id-only stub. Never triggers discovery itself.
   */
  models(): ModelsByRunner {
    const out = { ...this.discovered };
    for (const runner of new Set([...Object.keys(out), ...this.deps.planRunners(), ...this.enabledRunners()])) {
      const cached = this.deps.modelResolver.getCachedRunnerModels(runner);
      if (cached.length > 0) out[runner] = cached;
    }
    return out;
  }

  /** What this session's own discovery found for a runner; empty when it never ran there. */
  known(runner: RunnerId): DiscoveredModel[] {
    return this.discovered[runner] ?? [];
  }

  /** Discover the runners' models, spawning their CLIs where the resolver has none cached, and remember them. */
  async discover(runners: RunnerId[]): Promise<ModelsByRunner> {
    const found = await Promise.all([...new Set(runners)].map(async (runner) => [runner, await this.discoverOne(runner)] as const));
    return Object.fromEntries(found);
  }

  /**
   * One runner's discovery, remembered as it lands. Apart from the others:
   * one CLI that hangs while listing its models must not keep what every
   * other runner was found to offer out of the catalog.
   */
  private discoverOne(runner: RunnerId): Promise<DiscoveredModel[]> {
    const running = this.pending.get(runner);
    if (running) return running;
    const generation = this.generation;
    const started = this.deps.modelResolver.modelsForRunners([runner])
      .then((found) => {
        // Merged, never replaced: a runner the answer leaves out keeps what was learned before.
        if (generation === this.generation) this.discovered = { ...this.discovered, ...found };
        return found[runner] ?? [];
      }, () => [])
      .finally(() => { if (this.pending.get(runner) === started) this.pending.delete(runner); });
    this.pending.set(runner, started);
    return started;
  }

  /**
   * Keep what an admitted runner was found to offer, for the next coercion's
   * effort clamping. An empty list is discovery having found nothing, not a
   * runner offering nothing, so it never displaces what is known.
   */
  admit(runner: RunnerId, models: DiscoveredModel[]): void {
    if (models.length > 0) this.discovered = { ...this.discovered, [runner]: models };
  }

  /** Session boundaries are hard: nothing discovered for one goal informs the next. */
  reset(): void {
    this.discovered = {};
    this.pending.clear();
    this.generation++;
  }

  modes(runners: RunnerId[]): Record<RunnerId, RunnerModeInfo[]> {
    return runnerModesFrom(this.deps.registry, runners);
  }

  /**
   * What a planner may assign right now: every offered runner, its modes, and
   * its allowlisted models. Discovers the models of `runners` (every offered
   * one unless named) where the resolver has none cached; a read that needs
   * one runner's models, or none, waits on no other runner's CLI.
   */
  async live(runners: readonly RunnerId[] = this.offeredRunners()): Promise<TaskQueryCatalog> {
    await this.discoverWithin(runners);
    return this.current();
  }

  /**
   * Discover `runners` for at most {@link DISCOVERY_WAIT_MS}. A runner whose
   * models are not found by then is answered as one discovery found nothing
   * for, which an assignment accepts as written and the runner validates last.
   */
  private async discoverWithin(runners: readonly RunnerId[]): Promise<void> {
    if (runners.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, DISCOVERY_WAIT_MS); });
    await Promise.race([this.discover([...runners]), waited]);
    clearTimeout(timer);
  }

  /**
   * What {@link live} answers, from what is cached and without discovering:
   * the offered runners, however the plan was started, and why any enabled
   * one is not. The per-turn block
   * reads this, so it can never offer a different set than `list_runners`.
   */
  current(): TaskQueryCatalog {
    const withheld = this.withheld();
    const catalog = this.queryCatalog(this.runnersFor('plan') ?? []);
    // An empty list a planner reads as "no models" may be one still being listed.
    const discovering = catalog.runners.filter((runner) => this.pending.has(runner) && !catalog.models[runner]?.length);
    return { ...catalog, ...(withheld.length > 0 ? { withheld } : {}), ...(discovering.length > 0 ? { discovering } : {}) };
  }

  queryCatalog(runners: RunnerId[]): TaskQueryCatalog {
    const registered = runners.filter((runner) => this.deps.registry.getManifest(runner) !== undefined);
    return {
      runners: registered,
      // Allowlist-filtered: neither the per-turn block nor a read may offer
      // a model the planner is forbidden to assign.
      models: filterModelsForPrompt(this.models(), this.allowlist()),
      modes: this.modes(registered),
      autonomousDefault: this.autonomous(),
    };
  }

  /**
   * The catalog an assignment is resolved against — the same discovered
   * models and manifest modes the per-turn catalog block shows the planner,
   * so a refusal can never name something invalid that the planner was never
   * told about. The models are not filtered by the allowlist here: the
   * resolver reads the allowlist itself (`resolveAssignment`).
   */
  edit(runners: RunnerId[] = this.deps.planRunners()): AssignmentCatalog & { runnerModes: Record<RunnerId, RunnerModeInfo[]> } {
    return {
      modelsByRunner: this.models(),
      runnerModes: this.modes(runners),
      perRunnerAllowlist: this.allowlist(),
      autonomousDefault: this.autonomous(),
      ...(this.deps.liveRunner ? { liveRunner: this.deps.liveRunner } : {}),
    };
  }

  /**
   * What a runner offers a task moved to it or added on it. Spawns the
   * runner's CLI to list models; null for a runner no manifest declares,
   * which has no CLI to ask.
   */
  async runner(runner: RunnerId): Promise<RunnerCatalog | null> {
    if (this.deps.registry.getManifest(runner) === undefined) return null;
    return {
      models: (await this.deps.modelResolver.modelsForRunners([runner]))[runner] ?? [],
      modes: this.modes([runner])[runner],
    };
  }

  /**
   * The one place planning discovers what it may draw from: the runners'
   * models and their modes. `filteredModels` is the allowlisted view a prompt
   * may show; `modelsByRunner` stays whole because coercion needs real labels
   * and variants.
   */
  async planning(runners: RunnerId[]) {
    // The planning agent's own catalog too, though it is not offered: it is
    // the evidence its model is judged by, and OpenCode's ids share an
    // OpenRouter slug's shape, so a cold one would let a model left from an
    // old setup reach the agent when it is not also a task runner. So it is
    // waited on whole, and the task runners only for the discovery wait (ADR-0022 L4).
    const planner = runnerForProvider(this.deps.config.aiProvider);
    await Promise.all([
      this.discoverWithin(runners),
      planner && !runners.includes(planner) ? this.deps.modelResolver.modelsForRunners([planner]) : undefined,
      planner && runners.includes(planner) ? this.discoverOne(planner) : undefined,
    ]);
    const modelsByRunner: ModelsByRunner = Object.fromEntries(runners.flatMap((runner) => {
      const models = this.discovered[runner];
      return models ? [[runner, models]] : [];
    }));
    return {
      modelsByRunner,
      filteredModels: filterModelsForPrompt(modelsByRunner, this.allowlist()),
      runnerModes: this.modes(runners),
    };
  }
}
