import {
  CLI_PROVIDERS, getProviderMeta, plannerBackendEntries, runnerForProvider, selectPlanner,
  type PlannerBackendId, type ModelResolver, type PlannerModelMemory,
  type PlannerSelectionChange, type PlannerSelectionResult, type PlannerUsability, type RunnerInstallation,
} from '@ordewell/core';
import type { VsCodeConfig } from './adapters/VsCodeConfig';
import type { ChatViewProvider, PlannerBackend } from './providers/ChatViewProvider';

export interface PlannerSelectionDeps {
  config: VsCodeConfig;
  modelResolver: ModelResolver;
  plannerModelMemory: PlannerModelMemory;
  runnerInstallation: RunnerInstallation;
  chatProvider: ChatViewProvider;
  /** Push the chosen model and its provider label to the webview. */
  sendModelConfig: () => void;
  log: (msg: string) => void;
}

/**
 * Who plans, and with which model. The one owner of that transition, shared by
 * the webview pills and the `/planner` command, so neither can half-apply it.
 */
export class PlannerSelection {
  /**
   * Changes run one after another: each reads the configuration the last one
   * wrote, so two quick picks land as the later one, never interleaved.
   */
  private changes: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PlannerSelectionDeps) {}

  private inOrder<T>(work: () => Promise<T>): Promise<T> {
    const next = this.changes.then(work);
    this.changes = next.catch(() => undefined);
    return next;
  }

  /**
   * Every planner the user could pick, ready or not (ADR-0009). Harness
   * planners come first and are always listed — an uninstalled agent is shown
   * greyed with the reason, because discovering a missing CLI after typing a
   * goal is the failure the preflight exists to prevent. Vendor providers
   * follow, gated on a configured key exactly as `configuredProviders` defines
   * it.
   */
  async backends(): Promise<PlannerBackend[]> {
    const usability: Record<string, PlannerUsability> = {};
    await Promise.all(CLI_PROVIDERS.map(async (id) => {
      const runner = runnerForProvider(id)!;
      usability[runner] = await this.deps.runnerInstallation.plannerUsability(runner);
    }));
    return plannerBackendEntries(usability, this.deps.config.configuredProviders);
  }

  /** Switch who plans, landing on what that backend remembers (ADR-0009). */
  async apply(provider: PlannerBackendId): Promise<void> {
    if (!getProviderMeta(provider)) return;
    await this.inOrder(async () => {
      try {
        await this.change({ provider });
      } catch (err) {
        // The pill the webview lit for this pick has to settle on what is true.
        await this.sendState().catch(() => undefined);
        throw err;
      }
      await this.publish(`Planner set to ${provider}`);
    });
  }

  /**
   * Switch backend, model and effort as one change — the `/planner` wizard's
   * last step. The pick is remembered, not recalled: it is what the user just
   * chose, so it has to win over whatever the memory held for the backend.
   */
  async applyChoice(provider: PlannerBackendId, modelId: string, effort: string): Promise<void> {
    if (!getProviderMeta(provider)) return;
    await this.inOrder(async () => {
      await this.change({ provider, model: modelId, effort });
      await this.publish(`Planner set to ${provider}, model ${modelId}`);
    });
  }

  /** A model picked with no effort is a pick of the runner's default. */
  async setModel(modelId: string, effort?: string): Promise<void> {
    await this.inOrder(async () => {
      await this.change({ model: modelId, effort: effort ?? '' });
      await this.publish(`Planner model set to ${modelId}`);
    });
  }

  /** Any change of who plans, from a slash command or a picker. */
  async pick(change: PlannerSelectionChange): Promise<void> {
    await this.inOrder(async () => {
      const { next } = await this.change(change);
      await this.publish(`Planner set to ${next.provider}, model ${next.model || '(none)'}, effort ${next.effort || 'default'}`);
    });
  }

  /**
   * Core decides (`selectPlanner`); this is only the storage — the extension's
   * configuration and the shared settings file's memory.
   */
  private async change(change: PlannerSelectionChange): Promise<PlannerSelectionResult> {
    const { config, plannerModelMemory } = this.deps;
    // The model as the extension reads it, a Gemini id normalized.
    const current = { ...config.planner, model: config.orchestratorModel };
    const catalog = await this.deps.modelResolver.plannerCatalog(change.provider ?? current.provider);
    const result = selectPlanner(current, change, plannerModelMemory, catalog);
    const { next } = result;
    // The effective provider can be a detected default, which is never saved; a
    // provider the user named is a choice, so it is saved even when it equals
    // the default, or the next detection could move the planner off it.
    const saveProvider = next.provider !== current.provider || (change.provider !== undefined && config.rawAiProvider !== next.provider);
    // An effort on its own leaves the configured model as it was: a detected
    // agent's model in effect can be its remembered one, which a key added
    // later must not find written over `orchestratorModel`.
    const saveModel = saveProvider || change.model !== undefined;
    if (!result.remember && !result.recall && !saveModel && change.effort === undefined) return result;
    if (saveProvider) await config.update('aiProvider', next.provider);
    if (saveModel) await config.update('orchestratorModel', next.model);
    // Read after the writes above: the pick is for whoever they route to.
    if (change.model !== undefined) config.notePlannerPick(next.model, config.aiProvider);
    await config.update('plannerThinkingEffort', next.effort);
    if (result.remember) {
      const { provider, model, effort } = result.remember;
      // A vendor planner is resolved from its model id, so without a switch the
      // pick is keyed by the provider that model now resolves to.
      plannerModelMemory.remember(provider !== current.provider ? provider : config.aiProvider, model, effort);
    }
    return result;
  }


  private async publish(logLine: string): Promise<void> {
    this.deps.sendModelConfig();
    await this.sendState();
    this.deps.log(logLine);
  }

  async sendState(): Promise<void> {
    const provider = this.deps.config.aiProvider;
    this.deps.chatProvider.setPlannerBackends(
      await this.backends(),
      provider,
      runnerForProvider(provider) ?? undefined,
      this.deps.config.plannerThinkingEffort,
    );
  }
}
