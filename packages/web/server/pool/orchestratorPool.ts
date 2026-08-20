import { WebSocket } from 'ws';
import {
  Session,
  type SessionMessage,
  type SessionRuntimeSettings,
  ModelResolver,
  RunnerRegistry,
  RunnerInstallation,
  listSessions,
  loadSession,
  deleteSession,
  SettingsService,
  sessionRuntimeSettings,
  type PlanState,
  type LegacyPlanState,
  migratePlanState,
  type RunnerId,
  type DiscoveredModel,
  type OrchestratorOption,
  type RunnerModeInfo,
  runnerModesFrom,
  PROVIDER_PRIORITY,
  assertWorkspaceExists,
  assertWorkspaceIsProject,
  runnerForProvider,
  PlannerModelMemory,
  admitSettingsEnv,
  PROVIDER_CREDENTIAL_ENV,
  type AiProvider,
  type PlannerModelCandidate,
} from '@ordewell/core';
import { WebConfig } from '../adapters/WebConfig';
import { scanWorkspaces as scanWorkspacesImpl } from '../utils/workspaceScanner';
import { PoolFileSystem } from '../adapters/PoolFileSystem';
import { PoolAwareRunner } from '../adapters/PoolAwareRunner';
import type { RunnerRegistry as CoreRunnerRegistry, ITerminalRunner } from '@ordewell/core';

export interface OrchestratorPoolDeps {
  /**
   * Shared across every session instead of each `PoolAwareRunner` defaulting
   * to its own `HeadlessRunner` — needed so a tmux-backed runner's one
   * session/many-windows lifecycle outlives any single planning session.
   * Left undefined, behavior is unchanged from before this existed.
   */
  runner?: ITerminalRunner;
  /**
   * Overrides the pool's own `ModelResolver`. Left undefined, behavior is
   * unchanged; tests inject one built with fake exec/fetch impls so a
   * planner-switch catalog lookup can be seeded without spawning real CLIs.
   */
  modelResolver?: ModelResolver;
}

export class OrchestratorPool {
  private sessions = new Map<string, Session>();
  private clients = new Map<string, Set<WebSocket>>();
  /** The in-flight planning turn's abort controller, one per session — see `cancelPlanning`. */
  private planningAborts = new Map<string, AbortController>();
  private registry: CoreRunnerRegistry = (() => { const r = new RunnerRegistry(); r.loadUserPlugins(); return r; })();
  private modelResolver: ModelResolver;
  private runnerInstallation = new RunnerInstallation(this.registry);
  private cachedProviderLists: Record<string, string[]> | undefined;
  private settingsService = new SettingsService();
  private plannerModelMemory = new PlannerModelMemory(this.settingsService);
  private sharedRunner?: ITerminalRunner;

  constructor(deps: OrchestratorPoolDeps = {}) {
    this.sharedRunner = deps.runner;
    this.modelResolver = deps.modelResolver ?? new ModelResolver(this.registry, new WebConfig());
  }

  subscribe(sessionId: string, ws: WebSocket): void {
    if (!this.clients.has(sessionId)) this.clients.set(sessionId, new Set());
    this.clients.get(sessionId)!.add(ws);
    // Replay the planner dialogue so a (re)connecting client gets the backlog
    // instead of an empty chat. Read-only — no LLM call is made.
    const plan = this.sessions.get(sessionId)?.planState;
    const history = plan?.conversationHistory ?? [];
    if (history.length > 0 && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'chat_backlog', history }));
    }
  }

  unsubscribe(sessionId: string, ws: WebSocket): void {
    this.clients.get(sessionId)?.delete(ws);
    if (this.clients.get(sessionId)?.size === 0) this.clients.delete(sessionId);
  }

  private broadcast(sessionId: string, msg: SessionMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients.get(sessionId) ?? []) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  hasSession(sessionId: string): boolean { return this.sessions.has(sessionId); }

  /** Answer a planner approval prompt. False means the id was unknown or already settled. */
  resolveApproval(sessionId: string, approvalId: string, granted: boolean): boolean {
    return this.sessions.get(sessionId)?.resolveApproval(approvalId, granted) ?? false;
  }

  outstandingApprovals(sessionId: string) {
    return this.sessions.get(sessionId)?.outstandingApprovals() ?? [];
  }

  approvedScopes(sessionId: string): string[] {
    return this.sessions.get(sessionId)?.approvedScopes() ?? [];
  }
  isExecuting(sessionId: string): boolean { return this.sessions.get(sessionId)?.isExecuting ?? false; }
  getPlan(sessionId: string): LegacyPlanState | null { return this.sessions.get(sessionId)?.planState ?? null; }
  /**
   * The plan of a session this process is holding, straight from its store —
   * null for an id the pool never adopted. Reading it through the saved file
   * instead answers as if nothing were running.
   */
  getPlanState(sessionId: string): PlanState | null {
    return this.sessions.get(sessionId)?.currentPlanState ?? null;
  }
  getGoal(sessionId: string): string { return this.sessions.get(sessionId)?.currentGoal ?? ''; }

  private runtimeSettings(): SessionRuntimeSettings {
    return sessionRuntimeSettings(this.settingsService.getAll());
  }

  private createSessionFor(sessionId: string, workspace: string, modelOverride?: string): Session {
    // Rejected here rather than left to the planner: a non-existent workspace
    // otherwise reaches the harness adapter's `spawn` as an ENOENT that reads
    // as a missing agent binary, not a missing directory.
    assertWorkspaceExists(workspace);
    // Rejected here too: without a project marker, the filesystem root or an
    // arbitrary system directory becomes the confinement boundary for every
    // read, search and permitted command the planner runs.
    assertWorkspaceIsProject(workspace);
    const config = new WebConfig({
      enabledRunners: this.enabledRunnerOverride(),
      modelOverride,
      providerModelLists: this.cachedProviderLists,
    });
    const fsAdapter = new PoolFileSystem(workspace);
    const broadcast = (msg: SessionMessage) => this.broadcast(sessionId, msg);
    const runner = new PoolAwareRunner(sessionId, broadcast, this.sharedRunner);
    return new Session({
      config,
      notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
      runner,
      registry: this.registry,
      workspaceRoot: () => workspace,
      fsAdapter,
      broadcast,
      modelResolver: this.modelResolver,
      settings: () => this.runtimeSettings(),
      sessionId,
    });
  }

  /**
   * The user's runner choice, or undefined when they have never made one —
   * which is what lets `WebConfig` fall back to the environment's defaults.
   * Read per call rather than cached: the settings file is shared with the
   * VS Code extension host, and `getAll()` already invalidates on mtime.
   */
  private enabledRunnerOverride(): string[] | undefined {
    return this.settingsService.getEnabledRunners();
  }

  /**
   * Persisted, not held in memory: the daemon dies with the TUI, and a
   * process-local override meant every reopen silently reinstated the
   * environment's defaults over what the user had chosen.
   */
  setRunnerEnabled(id: string, enabled: boolean): void {
    const current = this.enabledRunnerOverride() ?? new WebConfig().enabledRunners;
    const next = enabled
      ? (current.includes(id) ? current : [...current, id])
      : current.filter((r) => r !== id);
    this.settingsService.setEnabledRunners(next);
  }

  getSettings() {
    const config = new WebConfig({ enabledRunners: this.enabledRunnerOverride() });
    const userSettings = this.settingsService.getAll();
    return {
      orchestratorModel: config.orchestratorModel,
      // Who plans (ADR-0009) — a vendor id, or one of the three harness
      // planners. Surfaces need it to render the planner picker and to know
      // whether the planner model comes from a runner catalog or a vendor one.
      aiProvider: config.aiProvider,
      // A harness planner's thinking effort (ADR-0009). Surfaces need it back
      // to render the current level; without it the picker shows "default"
      // for a planner that is running at "high".
      plannerThinkingEffort: config.plannerThinkingEffort ?? '',
      tdd: userSettings.tdd,
      verification: userSettings.verification,
      modelAllowlist: userSettings.modelAllowlist,
      // The model remembered per planner backend (this task), so a surface can
      // render what's remembered without a second round-trip.
      plannerModels: userSettings.plannerModels,
    };
  }

  /**
   * The catalog `PlannerModelMemory.recall` should judge `provider`'s
   * remembered model against — a harness planner's own runner catalog, or the
   * cross-provider picker list for a vendor (ADR-0009), same split as
   * `plannerModelItems` in the TUI reducer. Read from whatever the resolver
   * has already cached so this stays synchronous; a cold cache degrades to an
   * empty catalog rather than kicking off discovery mid-settings-write.
   */
  private plannerCatalogFor(provider: AiProvider): PlannerModelCandidate[] {
    const runner = runnerForProvider(provider);
    if (runner) {
      return this.modelResolver.getCachedRunnerModels(runner).map((m) => ({ id: m.modelId, variants: m.variants }));
    }
    return this.modelResolver.getCachedPickerOptions().map((o) => ({ id: o.id }));
  }

  updateSettings(changes: Record<string, unknown>) {
    // Read before any of this call's changes land, so a switch is judged
    // against what was actually in effect a moment ago.
    const providerBefore = new WebConfig({
      enabledRunners: this.enabledRunnerOverride(),
      providerModelLists: this.cachedProviderLists,
    }).aiProvider;

    // Only allowlisted keys reach `process.env`, and everything else comes back
    // to the caller by name — the daemon's environment is inherited by every
    // runner it spawns, so this write is the whole of `admitSettingsEnv`'s
    // reason to exist. All downstream reads below use `envChanges`, which is
    // the admitted subset, never the raw body.
    const rawEnv = changes.env && typeof changes.env === 'object' && !Array.isArray(changes.env)
      ? (changes.env as Record<string, unknown>)
      : undefined;
    const admission = rawEnv ? admitSettingsEnv(rawEnv) : undefined;
    const envChanges = admission ? admission.accepted : undefined;
    const incomingAiProvider = typeof envChanges?.AI_PROVIDER === 'string' ? envChanges.AI_PROVIDER : undefined;
    // The name the client sent wins over re-deriving it from `config.aiProvider`
    // later: for a vendor pick that resolution reads the model id, and a switch
    // may have just cleared it — model-based resolution would misfire on the
    // very call meant to establish the new provider.
    const switchedToProvider: AiProvider | undefined =
      incomingAiProvider && incomingAiProvider !== providerBefore ? (incomingAiProvider as AiProvider) : undefined;
    // Read the incoming provider's catalog now, before the env-touched refresh
    // below clears the resolver's cache — recall must judge the memory against
    // what was already discovered, not force a fresh (async) discovery here.
    const switchRecall = switchedToProvider
      ? this.plannerModelMemory.recall(switchedToProvider, this.plannerCatalogFor(switchedToProvider))
      : undefined;

    if (typeof changes.orchestratorModel === 'string') {
      process.env.ORCHESTRATOR_MODEL = changes.orchestratorModel;
    }
    if (typeof changes.plannerThinkingEffort === 'string') {
      process.env.ORDEWELL_PLANNER_EFFORT = changes.plannerThinkingEffort;
    }
    if (changes.tdd && typeof (changes.tdd as Record<string, unknown>).enabled === 'boolean') {
      this.settingsService.setTdd((changes.tdd as Record<string, unknown>).enabled as boolean);
    }
    if (changes.verification && typeof (changes.verification as Record<string, unknown>).enabled === 'boolean') {
      this.settingsService.setVerification((changes.verification as Record<string, unknown>).enabled as boolean);
    }
    if (envChanges) {
      let touched = false;
      for (const [key, value] of Object.entries(envChanges)) {
        process.env[key] = value;
        // Only a credential or endpoint change touches what a catalog
        // contains. A planner, model or effort pick does not, and invalidating
        // on one would wipe the very cache `plannerCatalogFor` reads
        // synchronously below, right before the next call's switch needs it.
        if (PROVIDER_CREDENTIAL_ENV.has(key)) touched = true;
      }
      // A new/changed provider key or base URL must re-probe the catalog;
      // without this the picker keeps serving the pre-key cache until restart.
      if (touched) {
        this.modelResolver.invalidate();
        this.modelResolver.refreshRunnerModels();
      }
    }

    // A planner switch resolves through memory rather than whatever the
    // client's env carried for the model/effort — an older client still sends
    // a blind `ORCHESTRATOR_MODEL: ''` clear here, and even a current one
    // should land on the model this provider was last using, not nothing.
    // Applied after the env loop above so it overrides that clear rather than
    // being overwritten by it.
    if (switchRecall) {
      process.env.ORCHESTRATOR_MODEL = switchRecall.model;
      process.env.ORDEWELL_PLANNER_EFFORT = switchRecall.effort;
    }

    if (changes.modelAllowlist && typeof changes.modelAllowlist === 'object') {
      const allowlist = changes.modelAllowlist as Record<string, unknown>;
      for (const [runner, ids] of Object.entries(allowlist)) {
        if (Array.isArray(ids)) {
          this.settingsService.setModelAllowlist(runner, ids.map(String));
        } else if (ids === null) {
          this.settingsService.setModelAllowlist(runner, undefined);
        }
      }
    }

    // An explicit model/effort pick is remembered against whichever provider
    // is in effect: the one this same call just switched to, or — resolved
    // fresh, now that ORCHESTRATOR_MODEL reflects this call's changes —
    // today's, so a vendor pick keys correctly off its model id. The pick
    // arrives either as a top-level field (a vendor model, `ordewell model
    // set`) or through env (`ordewell planner-effort`, the TUI's effort
    // picker send ORDEWELL_PLANNER_EFFORT this way) — both are a real pick,
    // never the switch's own env, which always carries AI_PROVIDER too.
    const envCarriesModelOrEffort = envChanges?.AI_PROVIDER === undefined &&
      (typeof envChanges?.ORCHESTRATOR_MODEL === 'string' || typeof envChanges?.ORDEWELL_PLANNER_EFFORT === 'string');
    if (typeof changes.orchestratorModel === 'string' || typeof changes.plannerThinkingEffort === 'string' || envCarriesModelOrEffort) {
      const rememberProvider = switchedToProvider ?? new WebConfig({
        enabledRunners: this.enabledRunnerOverride(),
        providerModelLists: this.cachedProviderLists,
      }).aiProvider;
      this.plannerModelMemory.remember(
        rememberProvider,
        process.env.ORCHESTRATOR_MODEL || '',
        process.env.ORDEWELL_PLANNER_EFFORT || '',
      );
    }

    // Refused keys are named back rather than dropped: a client that sent one
    // wrote it to `.env` on the strength of this response, and would otherwise
    // reinstate the refusal as the next daemon's startup environment.
    const rejectedEnvKeys = admission?.rejected ?? [];
    const settings: ReturnType<OrchestratorPool['getSettings']> & { rejectedEnvKeys?: string[] } = this.getSettings();
    if (rejectedEnvKeys.length > 0) settings.rejectedEnvKeys = rejectedEnvKeys;
    return settings;
  }

  setOrchestratorModel(model: string): string {
    process.env.ORCHESTRATOR_MODEL = model;
    return model;
  }

  async getProviderModels(): Promise<{
    models: DiscoveredModel[];
    modelsByRunner: Record<string, DiscoveredModel[]>;
    /** Each runner's manifest modes, so a surface can offer a per-task mode picker. */
    modesByRunner: Record<string, RunnerModeInfo[]>;
    orchestratorModel: string;
    providers: string[];
    /** Full cross-provider catalog for the orchestrator (planner) model picker. */
    orchestratorModels: OrchestratorOption[];
    /** Per-provider catalog-fetch failures, keyed by provider id. */
    providerErrors: Record<string, string>;
  }> {
    const config = new WebConfig();

    const runnerIds = this.registry.list().map((p) => p.manifest.name);
    const [runnerModels, providerLists] = await Promise.all([
      this.modelResolver.modelsForRunners(runnerIds),
      this.modelResolver.refresh(),
    ]);

    // `refresh()` populates the picker cache, so this is the same fetch — no
    // second network round-trip. Errors are whatever that fetch recorded.
    const orchestratorModels = await this.modelResolver.pickerOptions();
    const providerErrors = this.modelResolver.getDiscoveryErrors();

    this.cachedProviderLists = providerLists;

    const allModels: DiscoveredModel[] = [];
    const seen = new Set<string>();
    const modelsByRunner: Record<string, DiscoveredModel[]> = {};

    for (const id of runnerIds) {
      modelsByRunner[id] = runnerModels[id] ?? [];
      for (const m of modelsByRunner[id]) {
        if (!seen.has(m.modelId)) {
          seen.add(m.modelId);
          allModels.push(m);
        }
      }
    }

    const providers: string[] = [];
    for (const provider of PROVIDER_PRIORITY) {
      if (provider === 'openai_compatible') {
        if (config.openaiCompatibleBaseUrl) providers.push(provider);
      } else if (provider === 'openrouter') {
        if (config.openrouterKey) providers.push(provider);
      } else if (provider === 'google') {
        if (config.geminiKey) providers.push(provider);
      } else if (config.getProviderApiKey(provider)) {
        providers.push(provider);
      }
    }

    return {
      models: allModels,
      modelsByRunner,
      modesByRunner: runnerModesFrom(this.registry, runnerIds),
      orchestratorModel: process.env.ORCHESTRATOR_MODEL || '',
      providers,
      orchestratorModels,
      providerErrors,
    };
  }

  getRunnerState(): { enabledRunners: RunnerId[]; orchestratorModel: string } {
    const config = new WebConfig({ enabledRunners: this.enabledRunnerOverride() });
    return { enabledRunners: config.enabledRunners, orchestratorModel: config.orchestratorModel };
  }

  /**
   * Runners whose CLI is actually installed on the host, with display name and
   * enabled state. Only these should be offered for selection — an uninstalled
   * runner can't be spawned.
   */
  async getInstalledRunners(): Promise<{ id: string; name: string; enabled: boolean }[]> {
    const config = new WebConfig({ enabledRunners: this.enabledRunnerOverride() });
    const enabled = new Set(config.enabledRunners);
    const plugins = this.registry.list();
    const installedIds = new Set(
      await this.runnerInstallation.filterInstalled(plugins.map((p) => p.manifest.name)),
    );
    return plugins
      .filter((p) => installedIds.has(p.manifest.name))
      .map((p) => ({
        id: p.manifest.name,
        name: p.manifest.displayName,
        enabled: enabled.has(p.manifest.name),
      }));
  }

  async generatePlan(sessionId: string, goal: string, runners: RunnerId[], workspace: string, modelOverride?: string): Promise<PlanState> {
    const session = this.createSessionFor(sessionId, workspace, modelOverride);
    // Registered before the blocking call, not after: research inside
    // generatePlan can raise an approval and await the answer, and that
    // answer arrives over POST /api/approvals/:sessionId — which 404s until
    // the session is in this map. Registering only on return made the first
    // approval of every session unanswerable until its 5-minute timeout.
    this.sessions.set(sessionId, session);
    const controller = new AbortController();
    this.planningAborts.set(sessionId, controller);
    try {
      const plan = await session.generatePlan(goal, runners, { signal: controller.signal });
      return migratePlanState(plan);
    } finally {
      this.clearPlanningAbort(sessionId, controller);
    }
  }

  /**
   * Conversational planning (ADR-0002): start the planner dialogue for a
   * session. Returns the current plan state — a committed plan when the
   * planner had enough context, otherwise the dialogue so far (last
   * assistant message lives in conversationHistory).
   */
  async startPlanning(sessionId: string, goal: string, runners: RunnerId[], workspace: string, modelOverride?: string): Promise<LegacyPlanState> {
    const session = this.createSessionFor(sessionId, workspace, modelOverride);
    // See generatePlan: must be registered before the blocking call so a
    // mid-research approval is answerable rather than 404ing until timeout.
    this.sessions.set(sessionId, session);
    const controller = new AbortController();
    this.planningAborts.set(sessionId, controller);
    try {
      return await session.startPlanning(goal, runners, { signal: controller.signal });
    } finally {
      this.clearPlanningAbort(sessionId, controller);
    }
  }

  /** Continue the planner dialogue with the user's reply. */
  async continuePlanning(sessionId: string, message: string): Promise<LegacyPlanState> {
    const controller = new AbortController();
    this.planningAborts.set(sessionId, controller);
    try {
      return await this.session(sessionId).continueConversation(message, { signal: controller.signal });
    } finally {
      this.clearPlanningAbort(sessionId, controller);
    }
  }

  /**
   * Abort the planning turn in flight for a session, if any. Answers whether
   * there was one to cancel — the route reports that rather than 404ing a
   * session that simply is not planning right now.
   */
  cancelPlanning(sessionId: string): boolean {
    const controller = this.planningAborts.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Only clears the map entry if it still holds the controller this turn
   * created — a later turn may already have installed its own by the time
   * this one's `finally` runs (a fresh request racing a slow abort).
   */
  private clearPlanningAbort(sessionId: string, controller: AbortController): void {
    if (this.planningAborts.get(sessionId) === controller) this.planningAborts.delete(sessionId);
  }

  /**
   * Register a session persisted on disk so its plan becomes executable and
   * editable. Only sessions planned in this process are otherwise addressable,
   * which left a restored plan readable but inert — every task endpoint
   * answered "Session not found".
   *
   * No LLM call happens here: the plan is adopted as saved, and the planner is
   * only contacted when the user next sends a message.
   */
  adoptSavedSession(sessionId: string, workspace: string): LegacyPlanState {
    // Re-adopting would clear the execution log and drop a running plan back to
    // its saved state, so a live session wins over the file.
    const live = this.sessions.get(sessionId);
    if (live?.planState) return live.planState;

    const saved = loadSession(sessionId, workspace);
    if (!saved) throw new Error('Session not found');

    const session = this.createSessionFor(sessionId, workspace);
    // The saved id is adopted too, so later persists rewrite the same file
    // instead of forking the session under a fresh identity.
    session.loadPlan(saved.plan, saved.meta.goal, workspace, { sessionId: saved.meta.id });
    this.sessions.set(sessionId, session);

    return session.planState ?? saved.plan;
  }

  /**
   * Direct access to a session's interface — routes call the Session; the
   * pool only registers sessions and fans broadcasts out to WS clients.
   */
  session(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    return session;
  }

  destroy(sessionId: string): void {
    this.sessions.get(sessionId)?.destroy();
    this.sessions.delete(sessionId);
  }

  destroyAll(): void { for (const id of this.sessions.keys()) this.destroy(id); }
}

export const scanWorkspaces = scanWorkspacesImpl;

export function getSessionList(workspace: string) { return listSessions(workspace); }
export function getSession(sessionId: string, workspace: string) { return loadSession(sessionId, workspace); }
export function removeSession(sessionId: string, workspace: string) { return deleteSession(sessionId, workspace); }
