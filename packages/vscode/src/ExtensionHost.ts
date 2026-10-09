import * as vscode from 'vscode';
import {
  createSession, createSkillsService, createEmptyPlan, flattenTasks, parseMaxParallel, sessionRuntimeSettings,
  type AiProvider, type LegacyPlanState, type RunnerId, type Session, type SessionDeps,
} from '@ordewell/core';
import { registerCommands, type CommandDeps } from './commands/CommandRegistry';
import { handleSlashCommand, type SlashDeps } from './commands/SlashParser';
import { handleApprovePlan, handleSessionMessage, handleStartPlanning, type PlanManagerDeps } from './plan/PlanManager';
import { replayIsolation } from './plan/isolation';
import { routeWebviewMessage, type WebviewRouterDeps } from './plan/webviewRouter';
import { saveCurrentSession, restoreState, persistState, type PersistenceDeps } from './state/StatePersistence';
import { ModelDiscovery, sendModelConfig } from './ModelDiscovery';
import { PlannerSelection } from './PlannerSelection';
import type { ChatViewProvider } from './providers/ChatViewProvider';
import { TaskLogRegistry } from './providers/TaskLogRegistry';
import { SecretStore } from './adapters/SecretStore';
import type { VsCodeConfig } from './adapters/VsCodeConfig';
import type { VsCodeFileSystem } from './adapters/VsCodeFileSystem';
import type { VsCodeNotification } from './adapters/VsCodeNotification';
import type { ITerminalRunner, RunnerInstallation, RunnerRegistry, ModelResolver, SettingsService, PlannerModelMemory } from '@ordewell/core';

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
  pluginRegistry: RunnerRegistry;
  runnerInstallation: RunnerInstallation;
  fsAdapter: VsCodeFileSystem;
  notifications: VsCodeNotification;
  terminalRunner: ITerminalRunner;
  settingsService: SettingsService;
  plannerModelMemory: PlannerModelMemory;
  modelResolver: ModelResolver;
  chatProvider: ChatViewProvider;
  sessionFactory?: (deps: SessionDeps) => Session;
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
  });
  const persist = (): void => persistState(persistenceDeps());
  const saveSession = (): void => saveCurrentSession(persistenceDeps());

  const managerDeps: PlanManagerDeps = {
    get session(): Session { return requireSession(); },
    chatProvider: services.chatProvider,
    modelResolver: services.modelResolver,
    pluginRegistry: services.pluginRegistry,
    config: services.config,
    fsAdapter: services.fsAdapter,
    terminalRunner: services.terminalRunner,
    notifications: services.notifications,
    getCurrentPlan: () => state.plan,
    setCurrentPlan: (plan) => { state.plan = plan; },
    getCurrentGoal: () => state.goal,
    setCurrentGoal: (goal) => { state.goal = goal; },
    isGeneratingPlan: () => requireSession().isPlannerBusy,
    persistState: persist,
    saveCurrentSession: saveSession,
    log,
  };

  // The open task-log tabs (ADR-0018, V1), keyed by task. Built before the
  // session so the broadcast handler below can hand it every event; the
  // session getter is filled before anything can broadcast. A task is read
  // from the Session — the plan's owner — not the host's cached copy.
  const taskLogs = new TaskLogRegistry({
    extensionUri: services.context.extensionUri,
    session: () => requireSession(),
    getTask: (taskId) => flattenTasks(requireSession().planTasks).find((t) => t.id === taskId),
    log,
  });

  sessionCell.current = (services.sessionFactory ?? createSession)({
    config: services.config,
    notifications: services.notifications,
    runner: services.terminalRunner,
    registry: services.pluginRegistry,
    workspaceRoot: () => services.fsAdapter.getWorkspaceRoot(),
    fsAdapter: services.fsAdapter,
    // A panel is a second surface on the same session: it sees the event first
    // and filters to its own task, the chat handler then draws it as before.
    broadcast: (msg) => {
      taskLogs.receive(msg);
      handleSessionMessage(msg, managerDeps);
    },
    modelResolver: services.modelResolver,
    // The settings file's runner list is the daemon's; this window's lives in VS Code's own configuration.
    settings: () => ({ ...sessionRuntimeSettings(services.settingsService.getAll()), enabledRunners: services.config.enabledRunners }),
  });

  const planner = new PlannerSelection({
    config: services.config,
    modelResolver: services.modelResolver,
    plannerModelMemory: services.plannerModelMemory,
    runnerInstallation: services.runnerInstallation,
    chatProvider: services.chatProvider,
    sendModelConfig: () => sendModelConfig(services.config, services.chatProvider),
    log,
  });
  const discovery = new ModelDiscovery({
    vscodeApi,
    config: services.config,
    pluginRegistry: services.pluginRegistry,
    runnerInstallation: services.runnerInstallation,
    modelResolver: services.modelResolver,
    chatProvider: services.chatProvider,
    secretStore: services.secretStore,
    log,
    refreshPlannerState: () => planner.sendState(),
    onApiKeySaved: async () => {
      managerDeps.session.aiServiceInstance.reset();
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
    discoverOrchestratorModelOptions: () => discovery.options(),
    pickModelWithProvider: (...args) => discovery.pickModelWithProvider(...args),
  };

  const routerDeps: WebviewRouterDeps = {
    ...managerDeps,
    extension: {
      ready: onWebviewReady,
      refreshModels: () => { void discovery.refresh().catch((err) => log(`Model dropdown refresh failed: ${err}`)); },
      runSlashCommand: (text) => handleSlashCommand(text, slashDeps()),
      setPlanner: (provider) => planner.apply(provider as AiProvider),
      setPlannerModel: (modelId, effort) => planner.setModel(modelId, effort),
      openTaskLog: (taskId) => taskLogs.open(taskId),
      setPlanDockHeight: (height) => { void services.context.globalState.update(PLAN_DOCK_HEIGHT_KEY, height); },
    },
    getPendingRunners: () => state.pendingRunners,
    setPendingRunners: (runners) => { state.pendingRunners = runners; },
  };

  function slashDeps(): SlashDeps {
    return {
      config: {
        orchestratorModel: services.config.orchestratorModel,
        planningModel: services.config.planningModel,
        enabledRunners: services.config.enabledRunners,
        autonomousMode: services.config.autonomousMode,
        apiKey: services.config.apiKey,
        openAiBaseUrl: services.config.openAiBaseUrl,
        configuredProviders: services.config.configuredProviders,
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
      pluginRegistry: {
        get: (id: string) => services.pluginRegistry.get(id),
        getManifest: (id: string) => services.pluginRegistry.getManifest(id),
        list: () => services.pluginRegistry.list(),
      },
      chatProvider: services.chatProvider,
      settingsService: services.settingsService,
      plannerBackends: () => planner.backends(),
      refreshPlannerState: () => planner.sendState(),
      sendRunnerAndModels: () => discovery.refresh(),
      runApiKeyWizard: (provider) => discovery.runApiKeyWizard(provider),
      discoverOrchestratorModelOptions: () => discovery.options(),
      pickModelWithProvider: (...args) => discovery.pickModelWithProvider(...args),
      updateConfig: async (key, value) => services.config.update(key, value),
      recordPlannerModel: (model, effort) => services.plannerModelMemory.remember(services.config.aiProvider, model, effort),
      log,
    };
  }

  function onWebviewReady(): void {
    services.chatProvider.resendAllState();
    services.chatProvider.setPlanDockHeight(services.context.globalState.get<number>(PLAN_DOCK_HEIGHT_KEY));
    sendSkills();
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
    // Pending plan edits outlive a webview reload: an edit parked at a batch
    // boundary must still be listed, and withdrawable, when the view returns.
    services.chatProvider.showPendingPlanEdits(managerDeps.session.getQueuedMessages());
    if (state.plan.tasks.length > 0) {
      services.chatProvider.showPlan(state.plan);
      replayIsolation(managerDeps.session, services.chatProvider);
    } else {
      services.chatProvider.setState('empty');
    }
  }

  /**
   * Push the merged skill list (workspace .ordewell/skills/ shadows global
   * ~/.ordewell/skills/) to the webview for the /skill-name suggestion dropdown.
   * Re-read on every call rather than cached: SkillsService reads straight off
   * disk and a fresh instance per call picks up whichever workspace folder is
   * current after a folder add/remove.
   */
  function sendSkills(): void {
    try {
      const skills = createSkillsService(services.fsAdapter.getWorkspaceRoot()).listSkills();
      services.chatProvider.setSkills(skills.filter((s) => s.userInvocable).map((s) => ({ name: s.name, description: s.description, appliesTo: s.appliesTo })));
    } catch (err) {
      log(`Failed to list skills: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** `/parallel [n]` and "Ordewell: Set Parallel Tasks": how many AI tasks run at once, with no ceiling. */
  async function setMaxParallel(value?: string): Promise<void> {
    const current = services.config.maxParallelSessions;
    const typed = value ?? await vscodeApi.window.showInputBox({
      title: 'Ordewell: how many AI tasks run at once',
      prompt: 'Any whole number of 1 or more. Applies to a run already going.',
      value: String(current),
      validateInput: (text) => (parseMaxParallel(text) === null ? 'Enter a whole number of 1 or more.' : undefined),
    });
    if (typed === undefined) return;
    const limit = parseMaxParallel(typed);
    if (limit === null) {
      vscodeApi.window.showWarningMessage(`"${typed}" is not a number of tasks (1 or more).`);
      return;
    }
    await services.config.update('maxParallelSessions', limit);
    vscodeApi.window.showInformationMessage(`Up to ${limit} AI task${limit === 1 ? '' : 's'} now run at once.`);
  }

  async function start(): Promise<void> {
    services.context.subscriptions.push(
      vscodeApi.window.registerWebviewViewProvider('ordewellChatView', services.chatProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    );

    registerCommands(services.context, commandDeps);
    services.context.subscriptions.push(
      vscodeApi.commands.registerCommand('ordewell.setPlanner', (provider: AiProvider) => planner.apply(provider)),
      vscodeApi.commands.registerCommand('ordewell.setMaxParallel', (value?: string) => setMaxParallel(value)),
    );

    services.context.subscriptions.push(
      services.chatProvider.onMessage((msg) => routeWebviewMessage(msg, routerDeps)),
    );

    restoreState(persistenceDeps());

    services.context.subscriptions.push(services.config.onDidChange(() => {
      // A raised parallel limit would otherwise wait for the next verdict to
      // be seen; a no-op while nothing runs.
      managerDeps.session.reschedule().catch((err) => log(`Reschedule failed: ${err instanceof Error ? err.message : String(err)}`));
      managerDeps.session.aiServiceInstance.reset();
      services.modelResolver.invalidate();
      discovery.refresh().catch((err) => log(`Model discovery refresh failed: ${err instanceof Error ? err.message : String(err)}`));
      log('Configuration changed, reset services');
    }));

    services.context.subscriptions.push(vscodeApi.workspace.onDidChangeWorkspaceFolders(() => sendSkills()));

    await discovery.refresh();
    sendSkills();
    log('Ordewell extension activated — caches populated, models discovered');
    log('Ordewell extension activated successfully');
  }

  function dispose(): void {
    log('Ordewell deactivating...');
    taskLogs.dispose();
    persistState(persistenceDeps());
    services.terminalRunner.stopAll();
    log('Ordewell deactivated');
  }

  return { start, dispose };
}
