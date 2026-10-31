import { spawn as nodeSpawn } from 'child_process';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { WebSocket } from 'ws';
import {
  AccountLimitMonitor,
  claudeAccountLimitCollector,
  codexAccountLimitCollector,
  openCodeGoAccountLimitCollector,
  assignedRunnerOf,
  flattenTasks,
  type AccountLimitCollector,
  type AccountLimitsFrame,
  Session,
  createSession,
  type ConversationCompaction,
  type ConversationFork,
  type RunView,
  type SessionMessage,
  type SessionNotice,
  type SessionRuntimeSettings,
  type SessionFrame,
  type ApprovalRequestMessage,
  type StreamStamp,
  ModelResolver,
  RunnerRegistry,
  removedPluginNotice,
  RunnerInstallation,
  listSessions,
  loadSession,
  deleteSession,
  SettingsService,
  sessionRuntimeSettings,
  type GlobalRunSettings,
  type PlanState,
  type LegacyPlanState,
  migratePlanState,
  type RunnerId,
  type DiscoveredModel,
  type ModelsResponse,
  type RunnersResponse,
  type SettingsResponse,
  type SettingsUpdateResponse,
  SessionNotFoundError,
  runnerModesFrom,
  configuredProviders,
  assertWorkspaceExists,
  assertWorkspaceIsProject,
  WorkspaceNotAProjectError,
  ensureStateDirIgnored,
  runnerForProvider,
  PlannerModelMemory,
  selectPlanner,
  admitSettingsEnv,
  PROVIDER_CREDENTIAL_ENV,
  type PlannerBackendId,
  type PlannerModelCandidate,
  type PlannerSelectionChange,
  type PlannerSelectionCurrent,
  StructuredRunner,
  CodexSandboxAvailability,
  detectInstalledPlanner,
  installedPlannerAnswered,
  PlannerNotReadyError,
  PlannerTurnDiscardedError,
  PlannerTurnStoppedError,
  type LeaseHost,
  workspaceEnvOf,
  recordedRunnerAuth,
  createIsolationPreview,
  type IIsolationPreview,
  type IsolationPreview,
} from '@ordewell/core';
import { WebConfig, type PlannerPick } from '../adapters/WebConfig';
import { scanWorkspaces as scanWorkspacesImpl } from '../utils/workspaceScanner';
import { PoolFileSystem } from '../adapters/PoolFileSystem';
import { PoolAwareRunner } from '../adapters/PoolAwareRunner';
import type { ApprovalAnswer, RunnerRegistry as CoreRunnerRegistry, IRunner } from '@ordewell/core';

/** A fork the pool has adopted: addressable at once, its plan read back from the file it was written to. */
export interface AdoptedFork {
  sessionId: string;
  goal: string;
  plan: LegacyPlanState;
}

/**
 * The installation checks a host supplies the pool. `refresh` is optional so a
 * test may hand in only the two probes; the real `RunnerInstallation` always
 * has it, and a refresh then re-probes a CLI installed since the last look.
 */
type RunnerInstall = Pick<RunnerInstallation, 'filterInstalled' | 'plannerUsability'> & Partial<Pick<RunnerInstallation, 'refresh'>>;

export interface OrchestratorPoolDeps {
  /** Inject acquisition boundaries without reading real accounts in host lifecycle tests. */
  accountLimitCollectors?: (workspace: string) => readonly AccountLimitCollector[];
  /**
   * Where every plan's tasks run (ADR-0018), shared across sessions behind
   * each plan's `PoolAwareRunner`. Defaulted to a real one; tests inject a fake.
   */
  runner?: IRunner;
  /**
   * Overrides the pool's own `ModelResolver`. Left undefined, behavior is
   * unchanged; tests inject one built with fake exec/fetch impls so a
   * planner-switch catalog lookup can be seeded without spawning real CLIs.
   */
  modelResolver?: ModelResolver;
  /** Overrides the pool's Codex sandbox probe; tests inject one so no real `codex` is started. */
  codexSandbox?: Pick<CodexSandboxAvailability, 'ensure' | 'refresh'>;
  /** Overrides the pool's installation checks; tests inject one so no real agent binary is asked. */
  runnerInstallation?: RunnerInstall;
  /**
   * The host whose leases the pool's sessions hold (ADR-0049); this process's
   * unless a test runs two pools as two hosts.
   */
  leaseHost?: LeaseHost;
  /**
   * The read-only repository look a surface shows before any run. Defaulted to
   * one built from the daemon's config; tests inject a fake so no real git runs.
   */
  isolationPreview?: IIsolationPreview;
}

export class OrchestratorPool {
  // A daemon serves several workspaces; login selection must never follow
  // whichever session was opened most recently (ADR-0051).
  private readonly sessionWorkspaces = new Map<string, string>();
  private readonly accountLimits = new Map<string, AccountLimitMonitor>();
  private readonly accountLimitCollectors: (workspace: string) => readonly AccountLimitCollector[];
  private limitsRevision = 0;
  private sessions = new Map<string, Session>();
  private clients = new Map<string, Set<WebSocket>>();
  /**
   * This process's broadcast numbering (see `StreamStamp`), per session id
   * rather than per Session object: a session replaced under the same id
   * keeps counting up, so a client never mistakes its first broadcast for one
   * of the old session's it already showed.
   */
  private readonly stream = randomUUID();
  private sequence = new Map<string, number>();
  private registry: CoreRunnerRegistry = new RunnerRegistry();
  private modelResolver: ModelResolver;
  /** A host that supplied its own resolver answers for every workspace, as a supplied probe does. */
  private suppliedModelResolver: boolean;
  private runnerInstallation: RunnerInstall;
  /**
   * A host that supplied its own probe (a test, or a surface that owns one).
   * Everything else asks {@link installationFor}, which keys a real probe by
   * the workspace whose account it is judging (ADR-0016).
   */
  private suppliedRunnerInstallation: RunnerInstall | undefined;
  private workspaceInstallations = new Map<string, RunnerInstall>();
  private cachedProviderLists: Record<string, string[]> | undefined;
  private settingsService = new SettingsService();
  private plannerModelMemory = new PlannerModelMemory(this.settingsService);
  /**
   * The model a settings write picked in this daemon, and the workspace it was
   * picked in. The environment's model is otherwise inherited, and an agent
   * planning only because detection found it does not plan with an inherited
   * model it cannot be shown to run. The pick is that workspace's: another
   * may name another account, whose catalog judges the model afresh.
   */
  private pickedModel: (PlannerPick & { workspace: string }) | undefined;
  /**
   * The last planner write a route made, so each lands after the ones made
   * before it: a switch still waiting for its catalog must not write over a
   * pick made while it waited (ADR-0040).
   */
  private plannerWrites: Promise<unknown> = Promise.resolve();
  private runner: IRunner;
  /** One probe per daemon, asked again whenever the runner list is refreshed (ADR-0033). */
  private codexSandbox: Pick<CodexSandboxAvailability, 'ensure' | 'refresh'>;
  private readonly leaseHost: LeaseHost | undefined;
  private readonly isolationPreview: IIsolationPreview;

  constructor(deps: OrchestratorPoolDeps = {}) {
    const pluginNotice = removedPluginNotice();
    if (pluginNotice) console.warn(pluginNotice);
    this.runner = deps.runner ?? new StructuredRunner();
    // The login probe must ask the account the planner will use (ADR-0016).
    // This installation is the daemon's own cwd for detection; a runner list
    // request naming a workspace is judged by that workspace's own probe.
    this.suppliedRunnerInstallation = deps.runnerInstallation;
    this.runnerInstallation = deps.runnerInstallation
      ?? new RunnerInstallation(this.registry, undefined, undefined, {
        env: () => workspaceEnvOf(process.cwd()),
        workspace: () => process.cwd(),
      });
    // Read from the account the runners use, as the login probe above is.
    this.suppliedModelResolver = deps.modelResolver !== undefined;
    this.modelResolver = deps.modelResolver ?? new ModelResolver(this.registry, new WebConfig(), {
      env: async () => ({ ...process.env, ...(await workspaceEnvOf(process.cwd())) }),
    });
    this.codexSandbox = deps.codexSandbox
      ?? new CodexSandboxAvailability(this.registry, { spawn: nodeSpawn, fetch: globalThis.fetch }, { cwd: process.cwd(), env: process.env });
    this.leaseHost = deps.leaseHost;
    // What worktreeIsolation and workspaceRepos mean here, which is the config
    // the sessions plan with: the daemon's own environment, not a guess from
    // the workspace a request happens to name.
    this.isolationPreview = deps.isolationPreview ?? createIsolationPreview({ config: new WebConfig() });
    this.accountLimitCollectors = deps.accountLimitCollectors ?? ((workspace) => {
      const workspaceRoot = () => workspace;
      const isInstalled = (runner: string) => async () => (await this.runnerInstallation.filterInstalled([runner])).includes(runner);
      const server = this.registry.getManifest('codex')?.modelDiscovery.appServer;
      return [
        claudeAccountLimitCollector({ workspaceRoot, isInstalled: isInstalled('claude-code') }),
        codexAccountLimitCollector({ workspaceRoot, isInstalled: isInstalled('codex'), command: server?.command, args: server?.args }),
        openCodeGoAccountLimitCollector({ workspaceRoot, isInstalled: isInstalled('opencode') }),
      ];
    });
  }

  /**
   * Not awaited: planning must start at once, and the daemon already warms the
   * probe at startup through the catalog. This only covers a daemon that was
   * asked to plan before that finished.
   */
  private warmCodexSandbox(): void {
    this.codexSandbox.ensure().catch((err) => console.error(`[web] codex sandbox probe failed: ${err instanceof Error ? err.message : err}`));
  }

  /**
   * Find the coding agent that plans when the user has chosen no planner and
   * set no vendor key (ADR-0009), for the daemon to start as it starts. Every
   * planner turn waits on it, so a goal typed the instant the TUI opens
   * does not plan with an openrouter key nobody set.
   */
  detectInstalledPlanner(): Promise<PlannerBackendId | null> {
    return detectInstalledPlanner(this.runnerInstallation);
  }

  /**
   * A read-only look at the repositories and branches a run would isolate in
   * `workspace`. Free of side effects on purpose: a first screen may ask before
   * any plan or run exists, and asking must not create one.
   */
  previewIsolation(workspace: string): Promise<IsolationPreview> {
    assertWorkspaceExists(workspace);
    return this.isolationPreview.preview(workspace);
  }

  /**
   * A new session's first planner turn. It waits for that probe at the
   * session's own planner gate, where a reply sent meanwhile queues behind
   * it, and a Stop or the session closing or being replaced ends the wait.
   */
  private async firstTurn<T>(sessionId: string, session: Session, turn: () => Promise<T>): Promise<T> {
    try {
      return await turn();
    } catch (err) {
      // Judged once the probe answered: a refused session is never left
      // addressable, as when it is judged before it is registered.
      if (err instanceof PlannerNotReadyError && this.sessions.get(sessionId) === session) this.destroy(sessionId);
      // Stopped before it opened, the session holds no conversation for a
      // reply to continue: for the client its goal was discarded.
      if (err instanceof PlannerTurnStoppedError && !session.planState) throw new PlannerTurnDiscardedError();
      throw err;
    }
  }

  subscribe(sessionId: string, ws: WebSocket): void {
    if (!this.clients.has(sessionId)) this.clients.set(sessionId, new Set());
    this.clients.get(sessionId)!.add(ws);
    this.connectAccountLimits(sessionId, ws);
  }

  unsubscribe(sessionId: string, ws: WebSocket): void {
    this.clients.get(sessionId)?.delete(ws);
    if (this.clients.get(sessionId)?.size === 0) this.clients.delete(sessionId);
    this.releaseUnusedAccountLimits();
  }

  private connectAccountLimits(sessionId: string, ws: WebSocket): void {
    const workspace = this.sessionWorkspaces.get(sessionId);
    if (!workspace) {
      this.sendAccountLimits(sessionId, ws, []);
      return;
    }
    let monitor = this.accountLimits.get(workspace);
    if (!monitor) {
      monitor = new AccountLimitMonitor({ collectors: this.accountLimitCollectors(workspace) });
      this.accountLimits.set(workspace, monitor);
      monitor.subscribe((limits) => {
        for (const [id, clients] of this.clients) {
          if (this.sessionWorkspaces.get(id) !== workspace) continue;
          for (const client of clients) this.sendAccountLimits(id, client, limits);
        }
      });
    }
    this.sendAccountLimits(sessionId, ws, monitor.snapshots());
    monitor.setForeground(true);
    monitor.surfaceConnected();
  }

  private sendAccountLimits(sessionId: string, ws: WebSocket, limits: AccountLimitsFrame['limits']): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'account_limits', sessionId, limits, stream: this.stream, revision: ++this.limitsRevision } satisfies AccountLimitsFrame));
  }

  private releaseUnusedAccountLimits(): void {
    for (const [workspace, monitor] of this.accountLimits) {
      if ([...this.clients.keys()].some((id) => this.sessionWorkspaces.get(id) === workspace)) continue;
      monitor.dispose();
      this.accountLimits.delete(workspace);
    }
  }

  private registerSession(sessionId: string, workspace: string, session: Session): void {
    this.sessions.set(sessionId, session);
    this.sessionWorkspaces.set(sessionId, workspace);
    for (const ws of this.clients.get(sessionId) ?? []) this.connectAccountLimits(sessionId, ws);
  }

  private broadcast(sessionId: string, msg: SessionMessage | SessionNotice): void {
    const workspace = this.sessionWorkspaces.get(sessionId);
    const monitor = workspace ? this.accountLimits.get(workspace) : undefined;
    if (msg.type === 'planner_usage') monitor?.invalidate();
    else if (msg.type === 'task_log' && msg.events.some((event) => event.type === 'turn_end')) {
      const task = flattenTasks(this.sessions.get(sessionId)?.planTasks ?? []).find((task) => task.id === msg.taskId);
      const runner = task && assignedRunnerOf(task);
      if (runner) monitor?.invalidate(runner);
    }
    const seq = (this.sequence.get(sessionId) ?? 0) + 1;
    this.sequence.set(sessionId, seq);
    const payload = JSON.stringify({ ...msg, stream: this.stream, seq } satisfies SessionFrame);
    for (const ws of this.clients.get(sessionId) ?? []) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  hasSession(sessionId: string): boolean { return this.sessions.has(sessionId); }

  /** Answer an approval prompt, the planner's or a task runner's. False means the id was unknown or already settled. */
  resolveApproval(sessionId: string, approvalId: string, answer: ApprovalAnswer): boolean {
    return this.sessions.get(sessionId)?.resolveApproval(approvalId, answer) ?? false;
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
  /** Null for a session this process is not holding: there is no run to describe. */
  runSnapshot(sessionId: string): RunView | null { return this.sessions.get(sessionId)?.runSnapshot() ?? null; }
  /** The planner turn answering in a session this process holds, if one is. */
  plannerTurnId(sessionId: string): string | undefined { return this.sessions.get(sessionId)?.plannerTurnId; }
  /** The planner compaction running in a session this process holds, as its start was announced; it has no turn to name. */
  plannerCompaction(sessionId: string): ReturnType<Session['plannerCompaction']> { return this.sessions.get(sessionId)?.plannerCompaction(); }
  plannerDetection(sessionId: string): ReturnType<Session['plannerDetection']> | undefined { return this.sessions.get(sessionId)?.plannerDetection(); }
  /** The planner's approval requests still waiting, as they were announced. */
  announcedApprovals(sessionId: string): ApprovalRequestMessage[] { return this.sessions.get(sessionId)?.announcedApprovals() ?? []; }
  /** The last broadcast of the session so far: a snapshot taken now accounts for it and everything before. */
  streamPosition(sessionId: string): StreamStamp { return { stream: this.stream, seq: this.sequence.get(sessionId) ?? 0 }; }

  private runtimeSettings(): SessionRuntimeSettings {
    return sessionRuntimeSettings(this.settingsService.getAll());
  }

  private createSessionFor(sessionId: string, workspace: string, modelOverride?: string, options: { allowInit?: boolean } = {}): Session {
    // Rejected here rather than left to the planner: a non-existent workspace
    // otherwise reaches the harness adapter's `spawn` as an ENOENT that reads
    // as a missing agent binary, not a missing directory.
    assertWorkspaceExists(workspace);
    // Rejected here too: without a project marker, the filesystem root or an
    // arbitrary system directory becomes the confinement boundary for every
    // read, search and permitted command the planner runs. `allowInit` only
    // ever arrives here on the retry of a call the user already saw and
    // explicitly confirmed (the TUI's "initialize this as a new workspace?"
    // prompt) — never as a default, so an unmarked directory is still never
    // admitted silently.
    try {
      assertWorkspaceIsProject(workspace);
    } catch (err) {
      if (!(err instanceof WorkspaceNotAProjectError) || !options.allowInit) throw err;
      ensureStateDirIgnored(workspace);
      assertWorkspaceIsProject(workspace);
    }
    const config = this.plannerConfig(modelOverride, workspace);
    const fsAdapter = new PoolFileSystem(workspace);
    const broadcast = (msg: SessionMessage) => this.broadcast(sessionId, msg);
    const runner = new PoolAwareRunner(sessionId, broadcast, this.runner);
    return createSession({
      config,
      notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
      runner,
      registry: this.registry,
      workspaceRoot: () => workspace,
      fsAdapter,
      broadcast,
      // The notification channel above is silent here; this is how a client hears how the run isolates.
      onNotice: (notice) => this.broadcast(sessionId, notice),
      modelResolver: this.resolverFor(workspace),
      settings: () => this.runtimeSettings(),
      sessionId,
      ...(this.leaseHost ? { leaseHost: this.leaseHost } : {}),
    });
  }

  /**
   * The one way the pool builds a config that answers "who plans": sessions,
   * the settings response and the switch judgement all route through it, so
   * what the settings route reports is what the next turn plans with. The
   * lists are handed over as a reader, not a snapshot, so a credential change
   * reaches a session that is already open.
   */
  private plannerConfig(
    modelOverride?: string,
    workspace?: string,
    catalog: (provider: PlannerBackendId) => PlannerModelCandidate[] = (provider) => this.plannerCatalogFor(provider, workspace),
  ): WebConfig {
    return new WebConfig({
      enabledRunners: this.enabledRunnerOverride(),
      modelOverride,
      providerModelLists: () => this.cachedProviderLists,
      pickedModel: () => (this.pickedModel?.workspace === workspaceKey(workspace) ? this.pickedModel : undefined),
      agentCatalog: (provider) => catalog(provider).map((model) => model.id),
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
    // Worked out from the file as it is when written, not from an earlier read.
    this.settingsService.updateEnabledRunners((saved) => {
      const current = saved ?? new WebConfig().enabledRunners;
      return enabled
        ? (current.includes(id) ? current : [...current, id])
        : current.filter((r) => r !== id);
    });
  }

  /**
   * What `sessionId`, or a client in `workspace`, plans with: the planner's
   * model is judged against that workspace's runner catalog (see
   * {@link settingsWorkspace}).
   */
  getSettings(sessionId?: string, workspace?: string): SettingsResponse {
    const config = this.plannerConfig(undefined, this.settingsWorkspace(sessionId, workspace));
    const userSettings = this.settingsService.getAll();
    const live = sessionId ? this.sessions.get(sessionId) : undefined;
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
      maxParallel: config.maxParallelSessions,
      modelAllowlist: userSettings.modelAllowlist,
      // The model remembered per planner backend (this task), so a surface can
      // render what's remembered without a second round-trip.
      plannerModels: userSettings.plannerModels,
      // An open session shows what it was opened with; a closed or unknown id
      // falls back to the file, which is what a new session starts from (ADR-0030).
      run: live?.runSettings() ?? this.settingsService.getRunSettings(),
    };
  }

  /**
   * Save the user's run settings, and apply them at once to `sessionId`'s run
   * when that session is open here (ADR-0030). Other sessions keep the values
   * they were opened with. Throws a {@link RunSettingsError}, saving nothing,
   * for a value out of range.
   */
  updateRunSettings(changes: Partial<GlobalRunSettings>, sessionId?: string, workspace?: string): SettingsResponse {
    this.settingsService.updateRunSettings(changes);
    if (sessionId) this.sessions.get(sessionId)?.applyRunSettings(changes);
    return this.getSettings(sessionId, workspace);
  }

  /**
   * The workspace whose runner catalog a settings read or write is judged
   * against: an open session's own, else the one the client says it is in.
   * Without either the daemon's cwd stands in. One daemon serves several
   * workspaces, and each may name another Claude account in its environment.
   */
  private settingsWorkspace(sessionId: string | undefined, workspace: string | undefined): string | undefined {
    return (sessionId ? this.sessions.get(sessionId)?.workspaceRoot : undefined) ?? workspace;
  }

  /**
   * The catalog `selectPlanner` should judge `provider`'s
   * remembered model against — a harness planner's own runner catalog, or the
   * cross-provider picker list for a vendor (ADR-0009), same split as
   * `plannerModelItems` in the TUI reducer. Read from whatever the resolver
   * has already cached so this stays synchronous; the routes discover it
   * first where it decides the answer ({@link discoverPlannerCatalogs},
   * {@link writeSettings}), and a catalog still cold degrades to an empty one
   * rather than kicking off discovery mid-settings-write.
   */
  private plannerCatalogFor(provider: PlannerBackendId, workspace?: string): PlannerModelCandidate[] {
    return this.resolverFor(workspace).cachedPlannerCatalog(provider);
  }

  /**
   * Discover the runner catalog a settings read for `workspace` is judged
   * against, when the read consults one not yet held. Most reads consult
   * none — a vendor planner, a model picked in that workspace, an agent's
   * alias or remembered pick — and answer at once, however slow the runner
   * is to list its models (ADR-0040). Only a configured model whose owner
   * only the catalog can tell waits: a cold one would report the wrong model.
   * Never throws: a catalog that cannot be discovered stays empty.
   */
  async discoverPlannerCatalogs(sessionId: string | undefined, requestWorkspace: string | undefined): Promise<void> {
    const workspace = this.settingsWorkspace(sessionId, requestWorkspace);
    const consulted: PlannerBackendId[] = [];
    void this.plannerConfig(undefined, workspace, (provider) => {
      consulted.push(provider);
      return this.plannerCatalogFor(provider, workspace);
    }).planner;
    await this.discoverUnheld(workspace, consulted);
  }

  /**
   * {@link updateSettings} as a route makes it. A write that changes who plans
   * lands after the planner writes made before it and, where its judgement
   * reads a catalog not yet held, waits for that one; every other write — a
   * key, an allowlist, a limit — lands at once (ADR-0040).
   */
  async writeSettings(changes: Record<string, unknown>, sessionId?: string, requestWorkspace?: string): Promise<SettingsUpdateResponse> {
    const change = plannerChangeOf(changes, admittedEnv(changes)?.accepted);
    if (!changesPlanner(change)) return this.updateSettings(changes, sessionId, requestWorkspace);
    const turn = this.plannerWrites.then(async () => {
      // Judged once the writes before it have landed: one may have switched.
      const workspace = this.settingsWorkspace(sessionId, requestWorkspace);
      const judging = this.catalogJudging(change, workspace);
      await this.discoverUnheld(workspace, judging ? [judging] : []);
      return this.updateSettings(changes, sessionId, requestWorkspace);
    });
    this.plannerWrites = turn.catch(() => undefined);
    return turn;
  }

  /**
   * The provider whose catalog `selectPlanner` reads to judge `change`: a
   * switch with no model of its own restores the remembered pick only from
   * the incoming catalog, and an agent's effort alone survives only where its
   * model in effect offers it. An explicit model is the user's word whatever
   * the catalog lists, and a cold catalog refuses no effort, so it reads none.
   */
  private catalogJudging(change: PlannerSelectionChange, workspace: string | undefined): PlannerBackendId | undefined {
    const current = this.plannerProviderInEffect(workspace);
    const provider = change.provider ?? current;
    const model = change.model?.trim();
    if (provider !== current) return model ? undefined : provider;
    return model === undefined && change.effort !== undefined && runnerForProvider(provider) ? provider : undefined;
  }

  /**
   * Discover the catalogs of `providers` that `workspace`'s resolver does not
   * hold yet; a held one, or a degraded one discovery still remembers,
   * answers at once. Never throws.
   */
  private async discoverUnheld(workspace: string | undefined, providers: PlannerBackendId[]): Promise<void> {
    const resolver = this.resolverFor(workspace);
    await Promise.all([...new Set(providers)].map((provider) => resolver.plannerCatalog(provider)));
  }

  /**
   * The provider planning right now. A vendor planner is resolved from its
   * model id, so this is read again after a write rather than carried over.
   */
  private plannerProviderInEffect(workspace: string | undefined): PlannerBackendId {
    return this.plannerConfig(undefined, workspace).aiProvider;
  }

  updateSettings(changes: Record<string, unknown>, sessionId?: string, requestWorkspace?: string): SettingsUpdateResponse {
    const workspace = this.settingsWorkspace(sessionId, requestWorkspace);
    // Read before any of this call's changes land, so a switch is judged
    // against what was actually in effect a moment ago. The model and effort
    // too, with where they came from: a detected agent does not plan with a
    // vendor model left in the environment, and judging against it would
    // remember that model as the agent's own pick.
    const current: PlannerSelectionCurrent = this.plannerConfig(undefined, workspace).planner;

    // Only allowlisted keys reach `process.env`, and everything else comes back
    // to the caller by name — the daemon's environment is inherited by every
    // runner it spawns, so this write is the whole of `admitSettingsEnv`'s
    // reason to exist. All downstream reads below use `envChanges`, which is
    // the admitted subset, never the raw body.
    const admission = admittedEnv(changes);
    const envChanges = admission ? admission.accepted : undefined;

    const plannerChange = plannerChangeOf(changes, envChanges);
    // Judged against the incoming provider's catalog as already discovered —
    // before the credential refresh below clears the resolver's cache — so
    // the write itself never waits on (async) discovery.
    const selection = changesPlanner(plannerChange)
      ? selectPlanner(current, plannerChange, this.plannerModelMemory, this.plannerCatalogFor(plannerChange.provider ?? current.provider, workspace))
      : undefined;

    if (envChanges) {
      let touched = false;
      for (const [key, value] of Object.entries(envChanges)) {
        process.env[key] = value;
        // Only a credential or endpoint change touches what a catalog
        // contains. A planner, model or effort pick does not, and invalidating
        // on one would wipe the very cache `plannerCatalogFor` reads
        // synchronously, right before the next call's switch needs it.
        if (PROVIDER_CREDENTIAL_ENV.has(key)) touched = true;
      }
      // The scheduler reads the limit on every tick, but a raised one would
      // only be seen at the next verdict; the runs waiting for a slot start now.
      if (envChanges.ORDEWELL_MAX_PARALLEL !== undefined) {
        for (const [id, session] of this.sessions) {
          session.reschedule().catch((err) => {
            console.error(`[web] reschedule failed for session ${id}: ${err instanceof Error ? err.message : err}`);
          });
        }
      }
      // A new/changed provider key or base URL must re-probe the catalog, every
      // workspace's included; without this the picker keeps serving the
      // pre-key cache until restart.
      if (touched) {
        this.modelResolver.invalidate();
        this.dropUnkeyedProviderLists();
      }
    }

    if (selection) {
      // An effort on its own leaves the configured model as it was: a
      // detected agent's model in effect can be its remembered one, which a
      // key added later must not find written over the configured model.
      if (plannerChange.provider !== undefined || plannerChange.model !== undefined) process.env.ORCHESTRATOR_MODEL = selection.next.model;
      process.env.ORDEWELL_PLANNER_EFFORT = selection.next.effort;
      // Read once the env above is written: the pick is for whoever that
      // routes to, which a switch or the model's own catalog may have changed.
      if (plannerChange.model !== undefined) {
        this.pickedModel = { model: selection.next.model, provider: this.plannerProviderInEffect(workspace), workspace: workspaceKey(workspace) };
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

    if (envChanges) for (const monitor of this.accountLimits.values()) monitor.refresh();

    if (selection?.remember) {
      const { provider, model, effort } = selection.remember;
      // Without a switch a vendor pick is keyed by the provider its model id
      // resolves to now, which the env written above already reflects.
      const switched = provider !== current.provider;
      this.plannerModelMemory.remember(switched ? provider : this.plannerProviderInEffect(workspace), model, effort);
    }

    // Refused keys are named back rather than dropped: a client that sent one
    // wrote it to `.env` on the strength of this response, and would otherwise
    // reinstate the refusal as the next daemon's startup environment.
    const rejectedEnvKeys = admission?.rejected ?? [];
    const settings: SettingsUpdateResponse = this.getSettings(sessionId, workspace);
    if (rejectedEnvKeys.length > 0) settings.rejectedEnvKeys = rejectedEnvKeys;
    if (selection?.recall) settings.switchRecall = selection.recall;
    return settings;
  }

  /**
   * A vendor whose credential is gone keeps no list to route a model to it,
   * or the next turn would be sent to a planner the settings response no
   * longer names. Pruned rather than cleared: the vendors that still hold a
   * key keep routing their models until the catalog is discovered again, so
   * adding a second key does not move the planner off the first.
   */
  private dropUnkeyedProviderLists(): void {
    if (!this.cachedProviderLists) return;
    const keyed = new Set<string>(configuredProviders(new WebConfig()));
    this.cachedProviderLists = Object.fromEntries(
      Object.entries(this.cachedProviderLists).filter(([provider]) => keyed.has(provider)),
    );
  }

  setOrchestratorModel(model: string): string {
    process.env.ORCHESTRATOR_MODEL = model;
    return model;
  }

  /**
   * The catalog as `workspace`'s runners see it: Claude Code's picker lineup
   * follows the `CLAUDE_CONFIG_DIR` that workspace's environment sets.
   * Without a workspace the daemon's cwd stands in.
   */
  async getProviderModels(workspace?: string): Promise<ModelsResponse> {
    const config = new WebConfig();
    const resolver = this.resolverFor(workspace);

    const runnerIds = this.registry.list().map((p) => p.manifest.name);
    const [runnerModels, providerLists] = await Promise.all([
      resolver.modelsForRunners(runnerIds),
      resolver.refresh(),
      this.codexSandbox.ensure(),
    ]);

    // `refresh()` populates the picker cache, so this is the same fetch — no
    // second network round-trip. Errors are whatever that fetch recorded.
    const orchestratorModels = await resolver.pickerOptions();
    const providerErrors = resolver.getDiscoveryErrors();

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

    const providers = configuredProviders(config);

    return {
      models: allModels,
      modelsByRunner,
      modesByRunner: runnerModesFrom(this.registry, runnerIds),
      orchestratorModel: this.plannerConfig(undefined, workspace).orchestratorModel,
      providers,
      orchestratorModels,
      providerErrors,
    };
  }

  getRunnerState(workspace?: string): { enabledRunners: RunnerId[]; orchestratorModel: string } {
    const config = this.plannerConfig(undefined, workspace);
    return { enabledRunners: config.enabledRunners, orchestratorModel: config.orchestratorModel };
  }

  /**
   * The resolver whose runner catalogs are discovered under `workspace`'s
   * environment, the one its tasks are launched with. Kept per workspace,
   * since one daemon serves several and a catalog is cached until refreshed;
   * the vendor catalogs are shared by all of them.
   */
  private resolverFor(workspace: string | undefined): ModelResolver {
    if (this.suppliedModelResolver || !workspace) return this.modelResolver;
    const key = workspaceKey(workspace);
    if (key === workspaceKey(undefined)) return this.modelResolver;
    return this.modelResolver.withRunnerEnv(key, async () => ({ ...process.env, ...(await workspaceEnvOf(key)) }));
  }

  /**
   * The probe that judges a login for `workspace`, cached so its install and
   * auth verdicts survive between runner-list refreshes. Without a workspace
   * the daemon's cwd is what the request would plan with anyway.
   */
  private installationFor(workspace: string | undefined): RunnerInstall {
    if (this.suppliedRunnerInstallation) return this.suppliedRunnerInstallation;
    if (!workspace) return this.runnerInstallation;
    const key = resolve(workspace);
    let installation = this.workspaceInstallations.get(key);
    if (!installation) {
      installation = new RunnerInstallation(this.registry, undefined, undefined, {
        env: () => workspaceEnvOf(key),
        workspace: () => key,
      });
      this.workspaceInstallations.set(key, installation);
    }
    return installation;
  }

  /**
   * Runners whose CLI is actually installed on the host, with display name and
   * enabled state. Only these should be offered for selection — an uninstalled
   * runner can't be spawned. `workspace` names whose account the auth verdict
   * is about; without it the daemon's cwd stands in.
   */
  async getInstalledRunners(workspace?: string): Promise<RunnersResponse['runners']> {
    // The runner list is the one place a user who just fixed their host looks
    // again, so every cached answer is asked afresh: the Codex sandbox, the
    // install verdicts, and the agent detection behind the no-choice defaults.
    await this.codexSandbox.refresh();
    const installation = this.installationFor(workspace);
    installation.refresh?.();
    await this.detectInstalledPlanner();

    const config = new WebConfig({ enabledRunners: this.enabledRunnerOverride() });
    const enabled = new Set(config.enabledRunners);
    const runners = this.registry.list();
    const installedIds = new Set(
      await installation.filterInstalled(runners.map((p) => p.manifest.name)),
    );
    // The auth verdict rides along, never gating the list: a signed-out agent
    // is installed and offered, and a surface flags it. The probe was just
    // asked above and its answer is cached, so this costs no second spawn.
    // Its `usable` does gate: an installed CLI that cannot be spawned (a
    // Windows `.cmd` shim) must not be offered (ADR-0009).
    const rows = await Promise.all(
      runners
        .filter((p) => installedIds.has(p.manifest.name))
        .map(async (p): Promise<RunnersResponse['runners'][number] | null> => {
          const { usable, auth } = await installation.plannerUsability(p.manifest.name);
          if (!usable) return null;
          return {
            id: p.manifest.name,
            name: p.manifest.displayName,
            enabled: enabled.has(p.manifest.name),
            ...(auth ? { auth } : {}),
          };
        }),
    );
    return rows.filter((row): row is RunnersResponse['runners'][number] => row !== null);
  }

  async generatePlan(sessionId: string, goal: string, runners: RunnerId[] | undefined, workspace: string, modelOverride?: string, options?: { allowInit?: boolean }): Promise<PlanState> {
    const recheck = this.recheckSignedOutPlanner(workspace, this.plannerConfig(modelOverride).aiProvider);
    if (recheck) await recheck;
    const session = this.openPlanningSession(sessionId, runners, workspace, modelOverride, options);
    return migratePlanState(await this.firstTurn(sessionId, session, () => session.generatePlan(goal, runners)));
  }

  /**
   * Judge the planner as the workspace's account is now, not as it was when the
   * list was last read: the signed-out refusal itself offers the runner's own
   * `auth login` as a way back, and that happens in another process. Only a
   * recorded signed-out verdict is asked again — unknown never blocks, and a
   * signed-in one is the runner's own failure to report. Null when there is
   * nothing to ask, so the turn registers at once as it always did.
   */
  private recheckSignedOutPlanner(workspace: string, provider: PlannerBackendId): Promise<void> | null {
    const runner = runnerForProvider(provider);
    if (!runner || recordedRunnerAuth(runner, workspace)?.state !== 'signed-out') return null;
    const installation = this.installationFor(workspace);
    installation.refresh?.();
    return installation.plannerUsability(runner).then(() => undefined);
  }

  /**
   * Build the session a new planning conversation runs in and register it in
   * place of any live one, for {@link firstTurn} to run its first turn on.
   */
  private openPlanningSession(sessionId: string, runners: RunnerId[] | undefined, workspace: string, modelOverride?: string, options?: { allowInit?: boolean }): Session {
    const session = this.createSessionFor(sessionId, workspace, modelOverride, options);
    // Judged on the new session's config (which carries the request's model)
    // and before the old session is destroyed, so a refusal leaves it alone.
    // Not while the installed-planner probe is out: its answer can be the
    // planner, and judging the openrouter fallback now would refuse the very
    // keyless first run the probe exists for, so that judgement is the first
    // turn's own gate. The runners are judged on the same terms: before the
    // probe answers, the enabled set is a guess a refusal must not rest on.
    if (installedPlannerAnswered()) {
      session.assertPlannerReady();
      session.assertRunnersEnabled(runners);
    }
    // After the new session is built, so a refusal above leaves the live one
    // alone; before the set, so its runners and planner turn stop broadcasting.
    this.destroy(sessionId);
    // Registered before the blocking call, not after: research inside
    // the first planner turn can raise an approval and await the answer, and
    // that answer arrives over POST /api/approvals/:sessionId — which 404s
    // until the session is in this map. Registering only on return made the
    // first approval of every session unanswerable until its 5-minute timeout.
    this.registerSession(sessionId, workspace, session);
    this.warmCodexSandbox();
    return session;
  }

  /**
   * Conversational planning (ADR-0002): start the planner dialogue for a
   * session. Returns the current plan state — a committed plan when the
   * planner had enough context, otherwise the dialogue so far (last
   * assistant message lives in conversationHistory).
   */
  async startPlanning(sessionId: string, goal: string, runners: RunnerId[] | undefined, workspace: string, modelOverride?: string, options?: { allowInit?: boolean }): Promise<LegacyPlanState> {
    const recheck = this.recheckSignedOutPlanner(workspace, this.plannerConfig(modelOverride).aiProvider);
    if (recheck) await recheck;
    const session = this.openPlanningSession(sessionId, runners, workspace, modelOverride, options);
    return this.firstTurn(sessionId, session, () => session.startPlanning(goal, runners));
  }

  /**
   * Continue the planner dialogue with the user's reply: queued behind the
   * first turn, even while it waits for the installed-planner probe, and
   * refused only while a turn of another kind holds the conversation. The
   * session's own planner gate waits for the probe and judges the planner, as
   * it does for every turn.
   */
  async continuePlanning(sessionId: string, message: string): Promise<LegacyPlanState> {
    const session = this.session(sessionId);
    // A reply is a planner turn like any other: the signed-out refusal offers
    // the runner's own login, which runs outside this process, so ask the
    // workspace's account again before the session's synchronous gate judges.
    const recheck = this.recheckSignedOutPlanner(session.workspaceRoot, session.plannerProvider);
    if (recheck) await recheck;
    return session.continueConversation(message);
  }

  /** Condense a session's conversation. The summary turn is a planner turn, so `cancelPlanning` stops it. */
  async compactConversation(sessionId: string): Promise<ConversationCompaction & { plan: LegacyPlanState }> {
    const session = this.session(sessionId);
    const recheck = this.recheckSignedOutPlanner(session.workspaceRoot, session.plannerProvider);
    if (recheck) await recheck;
    const compaction = await session.compactConversation();
    return { ...compaction, plan: session.planState! };
  }

  /**
   * Send now (ADR-0023): the Session stops the planner turn in flight and
   * answers this message in the turn that replaces it, ahead of anything
   * waiting. The recheck is the one a reply does before the gate: a login done
   * with the runner's own command is seen here too.
   */
  async forceSendPrompt(sessionId: string, message: string): Promise<LegacyPlanState> {
    const session = this.session(sessionId);
    const recheck = this.recheckSignedOutPlanner(session.workspaceRoot, session.plannerProvider);
    if (recheck) await recheck;
    return session.forceSendPrompt(message);
  }

  /** Retry a compaction paused on the planner's context: a planner turn, and gated as one. */
  async retryPlannerCompaction(sessionId: string): Promise<LegacyPlanState> {
    const session = this.session(sessionId);
    const recheck = this.recheckSignedOutPlanner(session.workspaceRoot, session.plannerProvider);
    if (recheck) await recheck;
    return session.retryPlannerCompaction();
  }

  /**
   * Abort the planner turn in flight for a session, if any. Answers whether
   * there was one to cancel — the route reports that rather than 404ing a
   * session that simply is not planning right now.
   */
  cancelPlanning(sessionId: string): boolean {
    // A first turn still waiting for the probe is the session's to stop too.
    return this.sessions.get(sessionId)?.abortPlannerTurn() ?? false;
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
    if (!saved) throw new SessionNotFoundError();

    const session = this.createSessionFor(sessionId, workspace);
    // The saved id is adopted too, so later persists rewrite the same file
    // instead of forking the session under a fresh identity. Refused while
    // another live host runs the session (ADR-0049); the session built for
    // it is let go, and the one live here, if any, keeps running.
    try {
      session.loadPlan(saved.plan, saved.meta.goal, workspace, { sessionId: saved.meta.id });
    } catch (err) {
      session.destroy();
      throw err;
    }
    // A live session with no plan yet is mid-planning; replacing it must stop that turn.
    this.destroy(sessionId);
    this.registerSession(sessionId, workspace, session);

    return session.planState ?? saved.plan;
  }

  /**
   * Fork a session's conversation into a new session and adopt it, so the
   * fork is addressable at once — through the same path a saved session is
   * adopted by, reading back the file the fork was written to. The original
   * keeps running, or planning, untouched.
   */
  forkConversation(sessionId: string): AdoptedFork {
    return this.adoptFork(this.session(sessionId).forkConversation());
  }

  /** A rewind is a fork from an earlier point, so it is adopted the same way. */
  rewindConversation(sessionId: string, index: number): AdoptedFork & { rewoundMessage: string } {
    const fork = this.session(sessionId).rewindConversation(index);
    return { ...this.adoptFork(fork), rewoundMessage: fork.rewoundMessage };
  }

  private adoptFork(fork: ConversationFork): AdoptedFork {
    return { sessionId: fork.sessionId, goal: fork.goal, plan: this.adoptSavedSession(fork.sessionId, fork.workspace) };
  }

  /**
   * Direct access to a session's interface — routes call the Session; the
   * pool only registers sessions and fans broadcasts out to WS clients.
   */
  session(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError();
    return session;
  }

  /**
   * Stop a session and drop it. A replacement under the same id (re-planning,
   * adopting) keeps its subscribers: they are watching the id, and the new
   * session's broadcasts continue on the same socket. An explicit delete or
   * close is different — the surface must stop drawing a session that no
   * longer exists — so those pass `notifyClients`.
   */
  destroy(sessionId: string, options?: { notifyClients?: boolean }): void {
    this.sessions.get(sessionId)?.destroy();
    this.sessions.delete(sessionId);
    this.sessionWorkspaces.delete(sessionId);
    this.releaseUnusedAccountLimits();
    if (!options?.notifyClients) return;
    const clients = this.clients.get(sessionId);
    if (!clients) return;
    this.broadcast(sessionId, { type: 'notice', level: 'info', message: 'Session closed.' });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.close(1001, 'Session closed');
    }
    this.clients.delete(sessionId);
  }

  destroyAll(): void { for (const id of this.sessions.keys()) this.destroy(id); }
}

export const scanWorkspaces = scanWorkspacesImpl;

export function getSessionList(workspace: string) { return listSessions(workspace); }
export function getSession(sessionId: string, workspace: string) { return loadSession(sessionId, workspace); }
export function removeSession(sessionId: string, workspace: string) { return deleteSession(sessionId, workspace); }

/** A write's `env`, split into what may reach `process.env` and what may not. */
function admittedEnv(changes: Record<string, unknown>): ReturnType<typeof admitSettingsEnv> | undefined {
  const raw = changes.env;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? admitSettingsEnv(raw as Record<string, unknown>) : undefined;
}

/**
 * What a settings write asks of who plans. A pick arrives either as a
 * top-level field (a vendor model, `ordewell model set`) or through env
 * (`ordewell planner-effort`, the TUI's pickers); env wins, as it did when
 * both were written in that order. The provider is the name the client sent,
 * never re-derived from the model: a switch may have just cleared that model.
 * An `inherited` write is no pick at all: it is the environment a client was
 * started under, which the daemon would have inherited had the client spawned
 * it, so it is written as it stands and nothing in it is remembered.
 */
function plannerChangeOf(changes: Record<string, unknown>, envChanges: Record<string, string> | undefined): PlannerSelectionChange {
  return changes.inherited === true ? {} : {
    provider: envChanges?.AI_PROVIDER,
    model: envChanges?.ORCHESTRATOR_MODEL ?? stringField(changes.orchestratorModel),
    effort: envChanges?.ORDEWELL_PLANNER_EFFORT ?? stringField(changes.plannerThinkingEffort),
  };
}

function changesPlanner(change: PlannerSelectionChange): boolean {
  return Object.values(change).some((v) => v !== undefined);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** One spelling per workspace; a request that names none is the daemon's cwd's. */
function workspaceKey(workspace: string | undefined): string {
  return resolve(workspace ?? process.cwd());
}
