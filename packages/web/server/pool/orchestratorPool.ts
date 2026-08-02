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
}

export class OrchestratorPool {
  private sessions = new Map<string, Session>();
  private clients = new Map<string, Set<WebSocket>>();
  private registry: CoreRunnerRegistry = (() => { const r = new RunnerRegistry(); r.loadUserPlugins(); return r; })();
  private modelResolver = new ModelResolver(this.registry, new WebConfig());
  private runnerInstallation = new RunnerInstallation(this.registry);
  private cachedProviderLists: Record<string, string[]> | undefined;
  private settingsService = new SettingsService();
  private sharedRunner?: ITerminalRunner;

  constructor(deps: OrchestratorPoolDeps = {}) {
    this.sharedRunner = deps.runner;
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
      grillMe: userSettings.grillMe,
      tdd: userSettings.tdd,
      prd: userSettings.prd,
      review: userSettings.review,
      verification: userSettings.verification,
      researchSubagents: userSettings.researchSubagents,
      modelAllowlist: userSettings.modelAllowlist,
    };
  }

  updateSettings(changes: Record<string, unknown>) {
    if (typeof changes.orchestratorModel === 'string') {
      process.env.ORCHESTRATOR_MODEL = changes.orchestratorModel;
    }
    if (typeof changes.plannerThinkingEffort === 'string') {
      process.env.ORDEWELL_PLANNER_EFFORT = changes.plannerThinkingEffort;
    }
    if (changes.grillMe && typeof (changes.grillMe as Record<string, unknown>).enabled === 'boolean') {
      this.settingsService.setGrillMe((changes.grillMe as Record<string, unknown>).enabled as boolean);
    }
    if (changes.tdd && typeof (changes.tdd as Record<string, unknown>).enabled === 'boolean') {
      this.settingsService.setTdd((changes.tdd as Record<string, unknown>).enabled as boolean);
    }
    if (changes.prd && typeof (changes.prd as Record<string, unknown>).enabled === 'boolean') {
      this.settingsService.setPrd((changes.prd as Record<string, unknown>).enabled as boolean);
    }
    if (changes.review && typeof (changes.review as Record<string, unknown>).enabled === 'boolean') {
      this.settingsService.setReview((changes.review as Record<string, unknown>).enabled as boolean);
    }
    if (changes.verification && typeof (changes.verification as Record<string, unknown>).enabled === 'boolean') {
      this.settingsService.setVerification((changes.verification as Record<string, unknown>).enabled as boolean);
    }
    if (changes.researchSubagents && typeof (changes.researchSubagents as Record<string, unknown>).enabled === 'boolean') {
      this.settingsService.setResearchSubagents((changes.researchSubagents as Record<string, unknown>).enabled as boolean);
    }
    if (changes.env && typeof changes.env === 'object' && !Array.isArray(changes.env)) {
      const env = changes.env as Record<string, string>;
      let touched = false;
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string' && /^[A-Z_]+$/.test(key)) {
          process.env[key] = value;
          touched = true;
        }
      }
      // A new/changed provider key or base URL must re-probe the catalog;
      // without this the picker keeps serving the pre-key cache until restart.
      if (touched) {
        this.modelResolver.invalidate();
        this.modelResolver.refreshRunnerModels();
      }
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
    return this.getSettings();
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
    const plan = await session.generatePlan(goal, runners);
    return migratePlanState(plan);
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
    const plan = await session.startPlanning(goal, runners);
    return plan;
  }

  /** Continue the planner dialogue with the user's reply. */
  async continuePlanning(sessionId: string, message: string): Promise<LegacyPlanState> {
    return this.session(sessionId).continueConversation(message);
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
