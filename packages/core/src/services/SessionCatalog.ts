import type { TaskQueryCatalog } from './TaskQuery';
import { assignableRunners, type AssignmentCatalog, type AssignmentWriter, type RunnerCatalog } from './TaskAssignment';
import type { ModelResolver } from './ModelResolver';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { IConfig } from '../interfaces/IConfig';
import { filterModelsForPrompt } from './ModelAllowlistResolver';
import { runnerModesFrom, type RunnerModeInfo } from './ModeResolver';
import type { AssignmentScope } from './AssignmentScope';
import { runnerForProvider } from './ProviderRegistry';
import type { DiscoveredModel, RunnerId } from '../models/Task';

type ModelsByRunner = Partial<Record<RunnerId, DiscoveredModel[]>>;

export interface SessionCatalogDeps {
  config: Pick<IConfig, 'enabledRunners' | 'autonomousMode' | 'aiProvider'>;
  /** Whether a task's mode defaults to its runner's autonomous one: a child's mandate says, the config's level unless set (ADR-0056 M6). */
  autonomous?: () => boolean;
  registry: Pick<RunnerRegistry, 'getManifest'>;
  modelResolver: Pick<ModelResolver, 'modelsForRunners' | 'getCachedRunnerModels'>;
  /** Read at each call: a toggle or allowlist edit made since the session was built counts (#69). */
  settings: () => { enabledRunners?: RunnerId[]; modelAllowlist?: Record<string, string[]> };
  /** The runners of the plan being edited; empty while the session has none. */
  planRunners: () => RunnerId[];
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

  constructor(private readonly deps: SessionCatalogDeps) {}

  private autonomous(): boolean {
    return this.deps.autonomous?.() ?? this.deps.config.autonomousMode;
  }

  /** The runners enabled right now. */
  enabledRunners(): RunnerId[] {
    return (this.deps.settings().enabledRunners ?? this.deps.config.enabledRunners)
      .filter((runner) => this.deps.registry.getManifest(runner) !== undefined);
  }

  /** The runners `writer` may put a task on now ({@link assignableRunners}); undefined means any. */
  runnersFor(writer: AssignmentWriter): RunnerId[] | undefined {
    return assignableRunners(writer, this.enabledRunners());
  }

  /**
   * The allowlist in force right now. Unset means no restriction — falling
   * back to the one planning started under would keep a restriction the user
   * has since cleared.
   */
  allowlist(): Record<string, string[]> {
    return this.deps.settings().modelAllowlist ?? {};
  }

  /** The enabled runners and allowlist together, for whoever compares an assignment with them. */
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
    const found = await this.deps.modelResolver.modelsForRunners(runners);
    this.discovered = { ...this.discovered, ...found };
    return found;
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
  }

  modes(runners: RunnerId[]): Record<RunnerId, RunnerModeInfo[]> {
    return runnerModesFrom(this.deps.registry, runners);
  }

  /**
   * What a planner may assign right now: every enabled runner, its modes, and
   * its allowlisted models. Discovers a runner's models the first time it is
   * asked for.
   */
  async live(): Promise<TaskQueryCatalog> {
    await this.discover(this.enabledRunners());
    return this.current();
  }

  /**
   * What {@link live} answers, from what is cached and without discovering:
   * the enabled runners, however the plan was started. The per-turn block
   * reads this, so it can never offer a different set than `list_runners`.
   */
  current(): TaskQueryCatalog {
    return this.queryCatalog(this.runnersFor('plan') ?? []);
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
    // old setup reach the agent when it is not also a task runner.
    const planner = runnerForProvider(this.deps.config.aiProvider);
    const [modelsByRunner] = await Promise.all([
      this.discover(runners),
      planner && !runners.includes(planner) ? this.deps.modelResolver.modelsForRunners([planner]) : undefined,
    ]);
    return {
      modelsByRunner,
      filteredModels: filterModelsForPrompt(modelsByRunner, this.allowlist()),
      runnerModes: this.modes(runners),
    };
  }
}
