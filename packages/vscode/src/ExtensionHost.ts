import * as vscode from 'vscode';
import * as path from 'path';
import {
  AccountLimitMonitor, assignedRunnerOf, createSession, createSkillsService, detectInstalledPlanner, createEmptyPlan, flattenTasks, parseMaxParallel, sessionRuntimeSettings, taskRefOf,
  type IIsolationPreview, type PlannerBackendId, type GlobalRunSettings, type LegacyPlanState, type RunnerId, type Session, type SessionDeps,
} from '@ordewell/core';
import { registerCommands, type CommandDeps } from './commands/CommandRegistry';
import { setRunnerEnabled } from './commands/enabledRunners';
import { handleSlashCommand, type SlashDeps } from './commands/SlashParser';
import { confirmRisks } from './commands/runSettings';
import { handleApprovePlan, handleSessionMessage, handleStartPlanning, type PlanManagerDeps } from './plan/PlanManager';
import { routeWebviewMessage, sendNextHeldPrompt, type WebviewRouterDeps } from './plan/webviewRouter';
import { loginPlanner } from './plan/PlannerLogin';
import { saveCurrentSession, restoreState, persistState, type PersistenceDeps } from './state/StatePersistence';
import { ModelDiscovery, sendModelConfig } from './ModelDiscovery';
import { PlannerSelection } from './PlannerSelection';
import { recallPlannerModel } from './plan/PlannerModelSwitch';
import type { ChatViewProvider } from './providers/ChatViewProvider';
import type { SettingsChange } from './shared/protocol';
import { TaskLogRegistry } from './providers/TaskLogRegistry';
import { SecretStore } from './adapters/SecretStore';
import type { VsCodeConfig } from './adapters/VsCodeConfig';
import type { VsCodeFileSystem } from './adapters/VsCodeFileSystem';
import type { VsCodeNotification } from './adapters/VsCodeNotification';
import type { CodexSandboxAvailability, IRunner, RunnerInstallation, RunnerRegistry, ModelResolver, SettingsService, PlannerModelMemory } from '@ordewell/core';
import { plannerSettingProblem } from './plannerSetting';

// A VS Code layout preference, not a run setting: it lives in globalState rather
// than SettingsService, whose file the CLI and web surfaces also read.
const PLAN_DOCK_HEIGHT_KEY = 'ordewell.planDockHeight';

/**
 * What one extension window holds between webview messages. The host owns this
 * alone; the command, router and slash layers read it through the one
 * {@link PlanManagerDeps} the host builds, rather than each other's copies.
 */
export interface HostState {
  plan: LegacyPlanState;
  goal: string;
  /** The runner set the webview last planned with, for the next plan started from chat. */
  pendingRunners: RunnerId[] | undefined;
}

/**
 * Everything `activate` constructs for real: the adapters, the services and the
 * webview. The host wires them and owns the lifecycle; the optional session
 * factory is the seam the host tests build a fake Session through.
 */
export interface ExtensionServices {
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  secretStore: SecretStore;
  config: VsCodeConfig;
  runnerRegistry: RunnerRegistry;
  runnerInstallation: RunnerInstallation;
  /** Probes whether Codex's sandbox starts on this host; absent in tests that must not start `codex`. */
  codexSandbox?: Pick<CodexSandboxAvailability, 'refresh'>;
  fsAdapter: VsCodeFileSystem;
  notifications: VsCodeNotification;
  runner: IRunner;
  settingsService: SettingsService;
  plannerModelMemory: PlannerModelMemory;
  modelResolver: ModelResolver;
  chatProvider: ChatViewProvider;
  sessionFactory?: (deps: SessionDeps) => Session;
  /**
   * The one owner of every runner account's limits in this window, read by the
   * planner footer and each task log alike; absent, the host watches none.
   * The host starts, focuses and disposes it.
   */
  accountLimits?: AccountLimitMonitor;
  /** Reads the workspace's repositories and branches for the startup view (ADR-0013); absent, the view shows none. */
  isolationPreview?: IIsolationPreview;
}

export interface ExtensionHost {
  start(): Promise<void>;
  dispose(): void;
}

/**
 * Build the testable extension host from real adapters. `vscodeApi` is the
 * module itself in production and a fake in tests, so the host never reaches
 * for a global it did not receive.
 */
export function createExtension(services: ExtensionServices, vscodeApi: typeof vscode): ExtensionHost {
  const log = (msg: string): void => {
    services.outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
    console.log(`[Ordewell] ${msg}`);
  };

  /**
   * A workspace-relative file Ordewell kept, such as a handoff's saved patch
   * (ADR-0050), opened in an editor tab. The path comes from a webview, so it
   * is refused unless it stays inside the workspace; a saved patch is under
   * `.ordewell/`, never outside it.
   */
  const openWorkspaceFile = async (file: string): Promise<void> => {
    const root = services.fsAdapter.getWorkspaceRoot();
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || relative.startsWith('..') || path.isAbsolute(relative)) {
      void vscodeApi.window.showErrorMessage(`Ordewell: cannot open ${JSON.stringify(file)}: it is not a workspace path.`);
      return;
    }
    try {
      const doc = await vscodeApi.workspace.openTextDocument(vscodeApi.Uri.file(absolute));
      await vscodeApi.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      void vscodeApi.window.showErrorMessage(`Ordewell: ${file} could not be opened: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const state: HostState = {
    plan: createEmptyPlan(),
    goal: '',
    pendingRunners: undefined,
  };

  // The session's contract is circular — the broadcast handler needs the deps,
  // and the deps need the session being built — so the deps read it through
  // this cell, filled before anything can broadcast.
  const sessionCell: { current?: Session } = {};
  const requireSession = (): Session => {
    if (!sessionCell.current) throw new Error('The extension session is not built yet');
    return sessionCell.current;
  };

  const persistenceDeps = (): PersistenceDeps => ({
    session: requireSession(),
    chatProvider: services.chatProvider,
    getCurrentPlan: () => state.plan,
    setCurrentPlan: (plan) => { state.plan = plan; },
    getCurrentGoal: () => state.goal,
    setCurrentGoal: (goal) => { state.goal = goal; },
    workspaceRoot: () => services.fsAdapter.getWorkspaceRoot(),
    log,
    warn: (msg) => { void vscodeApi.window.showWarningMessage(msg); },
  });
  const persist = (): void => persistState(persistenceDeps());
  const saveSession = (): string | null => saveCurrentSession(persistenceDeps());

  const managerDeps: PlanManagerDeps = {
    get session(): Session { return requireSession(); },
    chatProvider: services.chatProvider,
    modelResolver: services.modelResolver,
    runnerRegistry: services.runnerRegistry,
    config: services.config,
    fsAdapter: services.fsAdapter,
    runner: services.runner,
    runnerInstallation: services.runnerInstallation,
    notifications: services.notifications,
    getCurrentPlan: () => state.plan,
    setCurrentPlan: (plan) => { state.plan = plan; },
    getCurrentGoal: () => state.goal,
    setCurrentGoal: (goal) => { state.goal = goal; },
    isGeneratingPlan: () => requireSession().isPlannerBusy,
    persistState: persist,
    saveCurrentSession: saveSession,
    sendRunSettings,
    refreshPlannerState: () => planner.sendState(),
    log,
  };

  const accountLimits = services.accountLimits ?? new AccountLimitMonitor({ collectors: [] });
  const findTask = (taskId: string) => flattenTasks(requireSession().planTasks).find((t) => t.id === taskId);

  // The open task-log tabs (ADR-0018, V1), keyed by task. Built before the
  // session so the broadcast handler below can hand it every event; the
  // session getter is filled before anything can broadcast. A task is read
  // from the Session — the plan's owner — not the host's cached copy.
  const taskLogs = new TaskLogRegistry({
    extensionUri: services.context.extensionUri,
    session: () => requireSession(),
    getTask: findTask,
    accountLimits: () => accountLimits.snapshots(),
    orderLabel: (taskId) => taskRefOf(requireSession().planTasks, taskId)?.replace(/^#/, ''),
    openFile: (path) => { void openWorkspaceFile(path); },
    idleSince: (taskId) => requireSession().runSnapshot().tasks.find((t) => t.id === taskId)?.idleSince ?? null,
    log,
  });

  sessionCell.current = (services.sessionFactory ?? createSession)({
    config: services.config,
    notifications: services.notifications,
    runner: services.runner,
    registry: services.runnerRegistry,
    workspaceRoot: () => services.fsAdapter.getWorkspaceRoot(),
    fsAdapter: services.fsAdapter,
    // A panel is a second surface on the same session: it sees the event first
    // and filters to its own task, the chat handler then draws it as before.
    broadcast: (msg) => {
      taskLogs.receive(msg);
      handleSessionMessage(msg, managerDeps);
      // A model call spent from some account — the planner's, or the task's
      // runner's — so the monitor's next poll reads it, however many calls.
      if (msg.type === 'planner_usage') accountLimits.invalidate();
      else if (msg.type === 'task_log' && msg.events.some((event) => event.type === 'turn_end')) {
        const task = findTask(msg.taskId);
        const runner = task && assignedRunnerOf(task);
        if (runner) accountLimits.invalidate(runner);
      }
    },
    modelResolver: services.modelResolver,
    settings: () => sessionRuntimeSettings(services.settingsService.getAll()),
  });

  const planner = new PlannerSelection({
    config: services.config,
    modelResolver: services.modelResolver,
    plannerModelMemory: services.plannerModelMemory,
    runnerInstallation: services.runnerInstallation,
    chatProvider: services.chatProvider,
    sendModelConfig: () => sendModelConfig(services.config, services.chatProvider, services.modelResolver),
    log,
  });
  const discovery = new ModelDiscovery({
    vscodeApi,
    config: services.config,
    runnerRegistry: services.runnerRegistry,
    runnerInstallation: services.runnerInstallation,
    codexSandbox: services.codexSandbox,
    modelResolver: services.modelResolver,
    chatProvider: services.chatProvider,
    modelAllowlist: () => services.settingsService.getAll().modelAllowlist ?? {},
    secretStore: services.secretStore,
    log,
    refreshPlannerState: () => planner.sendState(),
    onApiKeySaved: async () => {
      managerDeps.session.plannerSettingsChanged();
      services.modelResolver.invalidate();
    },
  });

  // Command, router and slash layers derive from the one managerDeps rather
  // than rebuilding their own bags over the same state.
  const commandDeps: CommandDeps = {
    ...managerDeps,
    settingsService: services.settingsService,
    secretStore: services.secretStore,
    handleApprovePlan: () => handleApprovePlan(managerDeps),
    handleStartPlanning: (text) => handleStartPlanning(text, managerDeps, state.pendingRunners),
    sendRunnerAndModels: () => discovery.refresh(),
    runApiKeyWizard: (provider) => discovery.runApiKeyWizard(provider),
    sendNextHeldPrompt: () => sendNextHeldPrompt(routerDeps),
  };

  /**
   * One login path for the webview's Log in buttons and the chat's `/login`:
   * the runner's own status command alone decides it worked, and an omitted
   * runner is the planner the config currently names.
   */
  function runPlannerLogin(runner?: string): Promise<void> {
    return loginPlanner({
      runnerInstallation: services.runnerInstallation,
      runnerRegistry: services.runnerRegistry,
      config: services.config,
      workspaceRoot: () => services.fsAdapter.getWorkspaceRoot(),
      // The fresh probe is what redraws the pill and the empty state; signing
      // in some other agent leaves who plans exactly where it was.
      sendState: () => planner.sendState(),
      post: (msg) => services.chatProvider.postMessage(msg),
      notifications: services.notifications,
      window: vscodeApi.window,
      log,
    }, runner);
  }

  const routerDeps: WebviewRouterDeps = {
    ...managerDeps,
    extension: {
      ready: onWebviewReady,
      refreshModels: () => { void discovery.refresh().catch((err) => log(`Model dropdown refresh failed: ${err}`)); },
      runSlashCommand: (text) => handleSlashCommand(text, slashDeps()),
      setPlanner: (provider) => planner.apply(provider),
      setPlannerModel: (modelId, effort) => planner.setModel(modelId, effort),
      openTaskLog: (taskId) => taskLogs.open(taskId),
      openFile: (path) => { void openWorkspaceFile(path); },
      setPlanDockHeight: (height) => { void services.context.globalState.update(PLAN_DOCK_HEIGHT_KEY, height); },
      changeSettings,
      loginPlanner: runPlannerLogin,
      setRunnerEnabled: async (runnerId, enabled, requestId) => {
        try {
          const saved = await setRunnerEnabled(
            {
              runnerRegistry: services.runnerRegistry,
              settingsService: services.settingsService,
              config: services.config,
              // Not awaited: the pill waits on the answer sent below, and a cold
              // runner CLI can hold discovery up for tens of seconds.
              sendRunnerAndModels: async () => {
                discovery.refresh().catch((err) => log(`Model discovery refresh failed: ${err instanceof Error ? err.message : String(err)}`));
              },
            },
            runnerId,
            enabled,
          );
          // An id nothing names is a stale click or a hand-made message: no
          // manifest owns it, so there is nothing to save.
          if (!saved) log(`Ignored a request to switch the unknown runner "${runnerId}" ${enabled ? 'on' : 'off'}.`);
        } finally {
          // The pill shows the click until this request is answered, so the
          // answer goes out whatever happened: the runner as saved now, which
          // after a refused or failed save puts the pill back.
          const savedList = services.config.enabledRunners;
          services.chatProvider.acknowledgeRunnerChoice(requestId, runnerId, savedList.includes(runnerId));
          services.chatProvider.setEnabledRunnerIds(savedList);
        }
      },
    },
    getPendingRunners: () => state.pendingRunners,
    setPendingRunners: (runners) => { state.pendingRunners = runners; },
  };

  function slashDeps(): SlashDeps {
    return {
      config: {
        orchestratorModel: services.config.orchestratorModel,
        aiProvider: services.config.aiProvider,
        plannerThinkingEffort: services.config.plannerThinkingEffort,
      },
      modelResolver: {
        pickerOptions: () => services.modelResolver.pickerOptions(),
        refresh: () => services.modelResolver.refresh(),
        invalidate: () => services.modelResolver.invalidate(),
        refreshRunnerModels: () => services.modelResolver.refreshRunnerModels(),
        modelsForRunners: (runners: string[]) => services.modelResolver.modelsForRunners(runners),
      },
      runnerRegistry: {
        list: () => services.runnerRegistry.list(),
      },
      chatProvider: services.chatProvider,
      settingsService: services.settingsService,
      plannerBackends: () => planner.backends(),
      refreshPlannerState: () => planner.sendState(),
      loginPlanner: runPlannerLogin,
      sendRunnerAndModels: () => discovery.refresh(),
      runApiKeyWizard: (provider) => discovery.runApiKeyWizard(provider),
      recallPlannerModel: (provider, harnessModels, vendorOptions) => recallPlannerModel(services.plannerModelMemory, provider, harnessModels, vendorOptions),
      applyPlannerChoice: (provider, modelId, effort) => planner.applyChoice(provider, modelId, effort),
      log,
    };
  }

  /** What the Run block shows: the window's own session holds the copy, and the bare welcome shows the file (ADR-0030). */
  function shownRunSettings(): GlobalRunSettings {
    return managerDeps.session.planState ? managerDeps.session.runSettings() : services.settingsService.getRunSettings();
  }

  function sendRunSettings(): void {
    const run = shownRunSettings();
    // A session started next opens with the file, and with no plan open there is no run this can move.
    if (!managerDeps.session.planState) managerDeps.session.applyRunSettings(run);
    services.chatProvider.setRunSettings(services.config.autonomousMode, run, services.config.maxParallelSessions);
  }

  function saveAutonomy(enabled: boolean): void {
    services.settingsService.setAutonomousMode(enabled);
    sendRunSettings();
  }

  function changeRunSettings(changes: Partial<GlobalRunSettings>): void {
    services.settingsService.updateRunSettings(changes);
    managerDeps.session.applyRunSettings(changes);
    sendRunSettings();
    const plan = managerDeps.session.planState;
    if (plan) services.chatProvider.showPlan(plan);
  }

  /**
   * A click in the Settings panel's Run block. Pushed back whatever happens, so
   * a declined Act, autorun or delegation, or a refused number, shows its old
   * value again.
   */
  async function changeSettings(change: SettingsChange): Promise<void> {
    if (change.autonomous !== undefined) saveAutonomy(change.autonomous);
    if (change.run && await confirmRisks(change.run, shownRunSettings().delegationTokens)) changeRunSettings(change.run);
    const limit = change.maxParallel === undefined ? null : parseMaxParallel(change.maxParallel);
    if (limit !== null) await services.config.update('maxParallelSessions', limit);
    sendRunSettings();
  }

  // The startup view's repositories, read in the background: a newer read
  // supersedes an older one, and an answer for a workspace that is no longer
  // the window's is dropped, so a slow read never shows an old branch.
  let previewRead = 0;
  function refreshIsolationPreview(opts: { clear?: boolean } = {}): void {
    const reader = services.isolationPreview;
    if (!reader) return;
    const root = services.fsAdapter.getWorkspaceRoot();
    const read = ++previewRead;
    if (opts.clear) services.chatProvider.setIsolationPreview(null);
    const current = (): boolean => read === previewRead && root === services.fsAdapter.getWorkspaceRoot();
    reader.preview(root).then(
      (preview) => { if (current()) services.chatProvider.setIsolationPreview(preview); },
      (err) => {
        const error = err instanceof Error ? err.message : String(err);
        log(`Repository preview failed: ${error}`);
        if (current()) services.chatProvider.setIsolationPreview({ status: 'failed', repos: [], shared: [], error });
      },
    );
  }

  function onWebviewReady(): void {
    refreshIsolationPreview({ clear: true });
    services.chatProvider.resendAllState();
    services.chatProvider.setPlanDockHeight(services.context.globalState.get<number>(PLAN_DOCK_HEIGHT_KEY));
    sendRunSettings();
    sendSkills();
    accountLimits.surfaceConnected();
    // Activation-time discovery can catch a runner CLI cold (server spawn,
    // catalog fetch, auth store still loading) and cache a degraded model
    // list. Re-discover in the background whenever a webview (re)connects
    // so the list self-heals without a manual /refresh.
    void discovery.refresh().catch((err) => log(`Background model refresh failed: ${err}`));
    // Replay the persisted dialogue so a reloaded webview shows the full
    // chat, not just the plan. restoreChat goes first: it clears any stale
    // stopped/busy state before the plan message arrives. A turn still
    // streaming has not been saved yet, so its live view is sent instead.
    if (managerDeps.isGeneratingPlan()) services.chatProvider.conversation.resync();
    else services.chatProvider.restoreChat(state.plan);
    services.chatProvider.conversation.waiting(managerDeps.session.announcedApprovals());
    if (state.plan.tasks.length > 0) {
      services.chatProvider.showPlan(state.plan);
      // The run view is the one thing the plan does not carry: task approvals,
      // idle marks, isolation and an open checkpoint would otherwise be missing
      // until the next update — which a task blocked on a runner approval never
      // sends. Seed it from the session, not from a replay of the stream.
      if (managerDeps.session.planState) services.chatProvider.adoptRun(managerDeps.session.runSnapshot());
    } else {
      services.chatProvider.setState('empty');
    }
  }

  /**
   * Push the merged skill list (global ~/.ordewell/skills/ shadows the
   * workspace's .ordewell/skills/ folders) to the webview for the /skill-name
   * suggestion dropdown and the task skill chips.
   * Re-read on every call rather than cached: SkillsService reads straight off
   * disk and a fresh instance per call picks up whichever workspace folder is
   * current after a folder add/remove.
   */
  function sendSkills(): void {
    try {
      const skills = createSkillsService(services.fsAdapter.getWorkspaceRoot(), services.config.workspaceRepos).listSkills();
      services.chatProvider.setSkills(skills.filter((s) => s.userInvocable).map((s) => ({ name: s.name, description: s.description, appliesTo: s.appliesTo })));
      // Attaching by hand is a user invocation, so user-only skills are offered too.
      services.chatProvider.setTaskSkills(
        skills.filter((s) => s.appliesTo === 'task').map((s) => ({ name: s.name, description: s.description })),
      );
    } catch (err) {
      log(`Failed to list skills: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Warned once per value: a config change fires for every setting, and the
  // same typo would otherwise re-raise the toast on each one.
  let warnedPlannerSetting: string | undefined;
  function checkPlannerSetting(): void {
    const value = services.config.rawAiProvider;
    if (value === warnedPlannerSetting) return;
    const problem = plannerSettingProblem(value);
    warnedPlannerSetting = problem ? value : undefined;
    if (problem) vscodeApi.window.showWarningMessage(problem);
  }

  async function start(): Promise<void> {
    // Read before the planner's first call, whichever runner plans: every
    // installed account, enabled for tasks or not. Polling follows the
    // window's focus; a focused start reads at once through it.
    services.context.subscriptions.push(
      { dispose: accountLimits.subscribe((limits) => {
        services.chatProvider.setAccountLimits(limits);
        taskLogs.accountLimitsChanged();
      }) },
      vscodeApi.window.onDidChangeWindowState((windowState) => {
        accountLimits.setForeground(windowState.focused);
        // A branch is switched outside the window as often as in it.
        if (windowState.focused) refreshIsolationPreview();
      }),
    );
    if (vscodeApi.window.state.focused) accountLimits.setForeground(true);
    else accountLimits.refresh();

    // Who plans when no planner is chosen and no key is held (ADR-0009). Not
    // awaited: the preflight and every planner turn wait on it instead, and
    // the pills are drawn again once it answers.
    void detectInstalledPlanner(services.runnerInstallation)
      .then(async () => {
        sendModelConfig(services.config, services.chatProvider, services.modelResolver);
        await planner.sendState();
      })
      .catch((err) => log(`Planner state refresh failed: ${err instanceof Error ? err.message : String(err)}`));

    services.context.subscriptions.push(
      vscodeApi.window.registerWebviewViewProvider('ordewellChatView', services.chatProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    );

    registerCommands(services.context, commandDeps);
    services.context.subscriptions.push(
      vscodeApi.commands.registerCommand('ordewell.setPlanner', (provider: PlannerBackendId) => planner.apply(provider)),
    );

    services.context.subscriptions.push(
      services.chatProvider.onMessage((msg) => routeWebviewMessage(msg, routerDeps)),
    );

    restoreState(persistenceDeps());
    // A restored plan is this window's session: its Run block shows that copy.
    sendRunSettings();
    // Open task-log tabs survive a window reload or an extension update. VS Code
    // asks the serializer during activation, so the plan must be restored first
    // or a restored tab would find no task and close itself.
    services.context.subscriptions.push(taskLogs.register());
    checkPlannerSetting();

    refreshIsolationPreview();

    services.context.subscriptions.push(services.config.onDidChange(() => {
      checkPlannerSetting();
      // worktreeIsolation and workspaceRepos decide what the view says.
      refreshIsolationPreview();
      sendRunSettings();
      // A raised parallel limit would otherwise wait for the next verdict to
      // be seen; a no-op while nothing runs.
      managerDeps.session.reschedule().catch((err) => log(`Reschedule failed: ${err instanceof Error ? err.message : String(err)}`));
      // A planner, model or effort picked writes these keys too: the session
      // lets the backend go only once the planner turn in flight has ended.
      managerDeps.session.plannerSettingsChanged();
      services.modelResolver.invalidate();
      // The monitor drops what it read when the auth scope moved.
      accountLimits.refresh();
      discovery.refresh().catch((err) => log(`Model discovery refresh failed: ${err instanceof Error ? err.message : String(err)}`));
      log('Configuration changed, reset services');
    }));

    // The settings file is shared with the TUI and the daemon: what another
    // surface saves (the enabled runners, the run settings) is drawn here too.
    let shownRunners = JSON.stringify(services.config.enabledRunners);
    const watchingSettings = services.settingsService.watch(() => {
      sendRunSettings();
      // Discovery re-pushes it too, but only when the runners changed; an
      // allowlist saved alone would otherwise never reach the webview.
      services.chatProvider.setModelAllowlist(services.settingsService.getAll().modelAllowlist ?? {});
      // Discovery spawns the runners' CLIs, so only a change to the list asks for it.
      const runners = JSON.stringify(services.config.enabledRunners);
      if (runners === shownRunners) return;
      shownRunners = runners;
      discovery.refresh().catch((err) => log(`Model discovery refresh failed: ${err instanceof Error ? err.message : String(err)}`));
    });
    services.context.subscriptions.push({ dispose: () => watchingSettings.dispose() });

    services.context.subscriptions.push(vscodeApi.workspace.onDidChangeWorkspaceFolders(() => {
      sendSkills();
      refreshIsolationPreview({ clear: true });
      // The new folder can select another account (ADR-0016): ask again and
      // redraw the flags rather than keep the previous folder's verdict.
      services.runnerInstallation.refresh();
      void planner.sendState().catch((err) => log(`Planner state refresh failed: ${err instanceof Error ? err.message : String(err)}`));
    }));

    await discovery.refresh();
    sendSkills();
    log('Ordewell extension activated: caches populated, models discovered');
    log('Ordewell extension activated successfully');
  }

  function dispose(): void {
    log('Ordewell deactivating...');
    // A goal still waiting for the activation probe must not start planner
    // turns once the host has stopped its runners.
    sessionCell.current?.abortPlannerTurn();
    taskLogs.dispose();
    accountLimits.dispose();
    persistState(persistenceDeps());
    services.runner.stopAll();
    // The session closes with the window, and with it its lease (ADR-0049).
    sessionCell.current?.destroy();
    log('Ordewell deactivated');
  }

  return { start, dispose };
}
