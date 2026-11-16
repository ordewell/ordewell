import { type PlannerBackendId, BaseConfig, DEFAULT_RUNNERS, defaultEnabledRunners, isApiProvider, normalizeGeminiModel } from '@ordewell/core';
import type { ConfiguredPlanner, ProviderModelLists, ResolvedPlanner } from '@ordewell/core';

export interface PlannerPick {
  model: string;
  provider: PlannerBackendId;
}

interface WebConfigOpts {
  enabledRunners?: string[];
  /**
   * The lists that route a model id to its vendor. A function is read on every
   * resolution, so a long-lived config (a session's) never routes on lists its
   * owner has since dropped for a removed key.
   */
  providerModelLists?: ProviderModelLists | (() => ProviderModelLists | undefined);
  modelOverride?: string;
  /** The model a settings write picked in this daemon and the planner it was for, read live; absent when none has. */
  pickedModel?: () => PlannerPick | undefined;
  /** The model ids a coding agent's discovery last listed, read live; empty while it is cold. */
  agentCatalog?: (provider: PlannerBackendId) => readonly string[];
}

export class WebConfig extends BaseConfig {
  private _enabledRunnersOverride: string[] | undefined;
  private _providerModelLists: () => ProviderModelLists | undefined;
  private _modelOverride: string | undefined;
  private _pickedModel: () => PlannerPick | undefined;
  private _agentCatalog: (provider: PlannerBackendId) => readonly string[];

  constructor(opts?: WebConfigOpts) {
    super();
    this._enabledRunnersOverride = opts?.enabledRunners;
    const lists = opts?.providerModelLists;
    this._providerModelLists = typeof lists === 'function' ? lists : () => lists;
    this._modelOverride = opts?.modelOverride;
    this._pickedModel = opts?.pickedModel ?? (() => undefined);
    this._agentCatalog = opts?.agentCatalog ?? (() => []);
  }

  protected agentCatalog(provider: PlannerBackendId): readonly string[] {
    return this._agentCatalog(provider);
  }

  setProviderModelLists(lists: ProviderModelLists): void {
    this._providerModelLists = () => lists;
  }

  /**
   * Read live, not fixed at construction: a session's WebConfig lives for the
   * whole session while /planner and /key-set (or the headless `ordewell model`)
   * mutate process.env under it. `routedProvider` keeps that cheap.
   */
  get planner(): ResolvedPlanner {
    return this.resolvePlanner({ ...this.configuredPlanner(), override: this._modelOverride }, this._providerModelLists());
  }

  /**
   * What the daemon inherited at startup, or what a settings write has set
   * since; the model counts as picked only while it is the one a write picked.
   */
  private configuredPlanner(): ConfiguredPlanner {
    const model = process.env.ORCHESTRATOR_MODEL || '';
    const pick = this._pickedModel();
    return { model, effort: process.env.ORDEWELL_PLANNER_EFFORT || '', pickedFor: pick?.model === model ? pick.provider : undefined };
  }

  get orchestratorModel(): string {
    return this.planner.model;
  }

  get aiProvider(): PlannerBackendId {
    return this.planner.provider;
  }

  get plannerThinkingEffort(): string | undefined {
    return this.planner.effort || undefined;
  }

  get apiKey(): string {
    const provider = this.aiProvider;
    return isApiProvider(provider) ? this.getProviderApiKey(provider) : '';
  }

  get planningModel(): string {
    const model = this.plannerChoiceFor(this.aiProvider, this.configuredPlanner()).model;
    return this.aiProvider === 'google' ? normalizeGeminiModel(process.env.GEMINI_MODEL || model) : model;
  }

  get enabledRunners(): string[] {
    if (this._enabledRunnersOverride) return this._enabledRunnersOverride;

    const envRunners = process.env.ORDEWELL_ENABLED_RUNNERS;
    if (envRunners) {
      const parsed = envRunners.split(',').map((s) => s.trim()).filter(Boolean);
      if (parsed.length > 0) return parsed;
    }

    // The per-runner toggles that predate ORDEWELL_ENABLED_RUNNERS: three fixed
    // variables, named by runner id on purpose; a newer runner is enabled
    // through the list above. Only a toggle that is set is a choice: with none,
    // claude-code's default-on toggle would hide a Codex- or OpenCode-only host.
    const toggles = ['ORDEWELL_CLAUDE_CODE_ENABLED', 'ORDEWELL_CODEX_ENABLED', 'ORDEWELL_OPENCODE_ENABLED'];
    if (toggles.every((name) => process.env[name] === undefined)) return defaultEnabledRunners();
    const out: string[] = [];
    if (process.env.ORDEWELL_CLAUDE_CODE_ENABLED !== 'false' && process.env.ORDEWELL_CLAUDE_CODE_ENABLED !== '0') {
      out.push('claude-code');
    }
    if (process.env.ORDEWELL_CODEX_ENABLED === 'true' || process.env.ORDEWELL_CODEX_ENABLED === '1') {
      out.push('codex');
    }
    if (process.env.ORDEWELL_OPENCODE_ENABLED === 'true' || process.env.ORDEWELL_OPENCODE_ENABLED === '1') {
      out.push('opencode');
    }
    return out.length > 0 ? out : [...DEFAULT_RUNNERS];
  }

}
