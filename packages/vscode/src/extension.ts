import * as vscode from 'vscode';
import { Session, RunnerRegistry, ModelResolver, RunnerInstallation, SettingsService, PlannerModelMemory, sessionRuntimeSettings, createEmptyPlan, LegacyPlanState, getProviderMeta, isCliProvider, CLI_PROVIDERS, runnerForProvider, PROVIDER_LABEL, PROVIDER_SHORT_LABEL, PROVIDER_PRIORITY, type AiProvider } from '@ordewell/core';
import { ChatViewProvider, type PlannerBackend } from './providers/ChatViewProvider';
import { VsCodeConfig } from './adapters/VsCodeConfig';
import { VsCodeFileSystem } from './adapters/VsCodeFileSystem';
import { SecretStore, type ApiProvider, type SecretKey } from './adapters/SecretStore';
import { VsCodeNotification } from './adapters/VsCodeNotification';
import { VsCodeTerminalRunner } from './adapters/VsCodeTerminalRunner';
import { registerCommands } from './commands/CommandRegistry';
import { handleSlashCommand } from './commands/SlashParser';
import { handleStartPlanning, handleContinueConversation, handleModifyPlan, handleApprovePlan, handleSendMessage, handleSystemCommand, handleSessionMessage, findTask, handleMergePlan, handleSplitPlan } from './plan/PlanManager';
import { classifyTaskEdit, parseTaskDraft, removalPrompt } from './plan/taskEdit';
import { recallPlannerModel } from './plan/PlannerModelSwitch';
import { saveCurrentSession, restoreState, persistState } from './state/StatePersistence';

let chatProvider: ChatViewProvider;
let session: Session;
let modelResolver: ModelResolver;
let pluginRegistry: RunnerRegistry;
let runnerInstallation: RunnerInstallation;
let fsAdapter: VsCodeFileSystem;
let config: VsCodeConfig;
let secretStore: SecretStore;
let notifications: VsCodeNotification;
let terminalRunner: VsCodeTerminalRunner;
let settingsService: SettingsService;
let plannerModelMemory: PlannerModelMemory;
let currentPlan: LegacyPlanState = createEmptyPlan();
let currentGoal: string = '';
let isGeneratingPlan = false;
let currentResearchAbort: AbortController | null = null;
let lastPlannerContent: string | null = null;
let outputChannel: vscode.OutputChannel;
let pendingRunners: import('@ordewell/core').RunnerId[] | undefined;

function log(msg: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  console.log(`[Ordewell] ${msg}`);
}

/**
 * Toggles that mean nothing for the current planner backend (ADR-0009, T8).
 * A harness planner owns its own subagent mechanism, so Ordewell's
 * `spawn_research_agent` has nothing to declare it to — the toggle is hidden
 * rather than left on screen doing nothing.
 */
function unavailableSkills(): string[] {
  return isCliProvider(config.aiProvider) ? ['research-subagents'] : [];
}

/**
 * Every planner the user could pick, ready or not (ADR-0009). Harness planners
 * come first and are always listed — an uninstalled agent is shown greyed with
 * the reason, because discovering a missing CLI after typing a goal is the
 * failure the preflight exists to prevent. Vendor providers follow, gated on a
 * configured key exactly as `configuredProviders` defines it.
 */
async function plannerBackendList(): Promise<PlannerBackend[]> {
  const harness = await Promise.all(CLI_PROVIDERS.map(async (id) => {
    const runner = runnerForProvider(id)!;
    const { usable, reason } = await runnerInstallation.plannerUsability(runner);
    return {
      id, label: getProviderMeta(id).label, kind: 'harness' as const,
      runner, usable, reason: reason ?? 'coding agent · no API key needed',
    };
  }));
  const configured = config.configuredProviders;
  const vendors: PlannerBackend[] = PROVIDER_PRIORITY
    .filter((id) => configured.includes(id as ApiProvider))
    .map((id) => ({
      id, label: getProviderMeta(id).label, kind: 'vendor' as const,
      usable: true, reason: getProviderMeta(id).apiKeyEnvVar,
    }));
  return [...harness, ...vendors];
}

/**
 * Switch who plans. The one owner of that transition, shared by the webview
 * pills and the `/planner` command, so neither can half-apply it.
 */
async function applyPlanner(provider: AiProvider): Promise<void> {
  if (!getProviderMeta(provider)) return;
  await config.update('aiProvider', provider);
  // A model id from the old backend is meaningless to the new one — an
  // OpenRouter slug handed to Claude Code, or the reverse. `recallPlannerModel`
  // restores what the user last picked *for this provider*, falling back to
  // the catalog default, or blank when discovery has nothing yet.
  const runner = runnerForProvider(provider);
  const harnessModels = runner ? ((await modelResolver.modelsForRunners([runner]))[runner] ?? []) : undefined;
  const vendorOptions = runner ? undefined : await modelResolver.pickerOptions();
  const { model, effort } = recallPlannerModel(plannerModelMemory, provider, harnessModels, vendorOptions);
  await config.update('orchestratorModel', model);
  await config.update('plannerThinkingEffort', effort);
  sendModelConfig();
  await sendPlannerState();
  chatProvider.setSkillToggles(settingsService.getGrillMe(), settingsService.getTdd(), settingsService.getPrd(), settingsService.getVerification(), settingsService.getResearchSubagents(), unavailableSkills());
  log(`Planner set to ${provider}`);
}

async function sendPlannerState(): Promise<void> {
  const provider = config.aiProvider;
  chatProvider.setPlannerBackends(
    await plannerBackendList(),
    provider,
    runnerForProvider(provider) ?? undefined,
    config.plannerThinkingEffort,
  );
}

function getPlan(): LegacyPlanState { return currentPlan; }
function setPlan(p: LegacyPlanState) { currentPlan = p; }
function getGoal(): string { return currentGoal; }
function setGoal(g: string) { currentGoal = g; }
function getGenPlan(): boolean { return isGeneratingPlan; }
function setGenPlan(v: boolean) { isGeneratingPlan = v; }
function getAbort(): AbortController | null { return currentResearchAbort; }
function setAbort(c: AbortController | null) { currentResearchAbort = c; }
function getPlannerContent(): string | null { return lastPlannerContent; }
function setPlannerContent(c: string | null) { lastPlannerContent = c; }

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Ordewell');
  log('Ordewell extension activating...');

  try {
    secretStore = new SecretStore(context.secrets);
    await secretStore.load();
    config = new VsCodeConfig(secretStore);
    pluginRegistry = new RunnerRegistry();
    pluginRegistry.loadUserPlugins();
    runnerInstallation = new RunnerInstallation(pluginRegistry);
    fsAdapter = new VsCodeFileSystem();
    notifications = new VsCodeNotification();
    terminalRunner = new VsCodeTerminalRunner();
    settingsService = new SettingsService();
    plannerModelMemory = new PlannerModelMemory(settingsService);
    modelResolver = new ModelResolver(pluginRegistry, config);
    chatProvider = new ChatViewProvider(context.extensionUri);
    session = new Session({
      config,
      notifications,
      runner: terminalRunner,
      registry: pluginRegistry,
      workspaceRoot: () => fsAdapter.getWorkspaceRoot(),
      fsAdapter,
      broadcast: (msg) => handleSessionMessage(msg, {
        session, chatProvider, modelResolver, pluginRegistry, config, fsAdapter, terminalRunner, notifications,
        settingsService, getCurrentPlan: getPlan, setCurrentPlan: setPlan, getCurrentGoal: getGoal,
        setCurrentGoal: setGoal, isGeneratingPlan: getGenPlan, setGeneratingPlan: setGenPlan,
        getResearchAbort: getAbort, setResearchAbort: setAbort,
        getLastPlannerContent: getPlannerContent, setLastPlannerContent: setPlannerContent,
        persistState: () => persistState(persistDeps()), saveCurrentSession: () => saveCurrentSession(persistDeps()), log,
      }),
      modelResolver,
      settings: () => sessionRuntimeSettings(settingsService.getAll()),
    });

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('ordewellChatView', chatProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    );

    const cmdDeps = commandDeps();
    registerCommands(context, cmdDeps);
    context.subscriptions.push(
      vscode.commands.registerCommand('ordewell.setPlanner', (provider: AiProvider) => applyPlanner(provider)),
    );

    setupChatListener(context);

    const persistDepsVal = persistDeps();
    restoreState(persistDepsVal);

    context.subscriptions.push(config.onDidChange(() => {
      session.aiServiceInstance.reset();
      modelResolver.invalidate();
      sendRunnerAndModels();
      log('Configuration changed, reset services');
    }));

    await sendRunnerAndModels();
    log('Ordewell extension activated — caches populated, models discovered');
    log('Ordewell extension activated successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`ACTIVATION ERROR: ${message}`);
    vscode.window.showErrorMessage(`Ordewell failed to activate: ${message}`);
  }
}

export function deactivate(): void {
  log('Ordewell deactivating...');
  persistState(persistDeps());
  terminalRunner.stopAll();
  log('Ordewell deactivated');
}

// --- DI builders ---

function persistDeps() {
  return {
    session, chatProvider,
    getCurrentPlan: getPlan, setCurrentPlan: setPlan,
    getCurrentGoal: getGoal, setCurrentGoal: setGoal,
    workspaceRoot: () => fsAdapter.getWorkspaceRoot(), log,
  };
}

function planDeps() {
  return {
    session, chatProvider, modelResolver, pluginRegistry, config, fsAdapter, terminalRunner, notifications,
    settingsService,
    getCurrentPlan: getPlan, setCurrentPlan: setPlan,
    getCurrentGoal: getGoal, setCurrentGoal: setGoal,
    isGeneratingPlan: getGenPlan, setGeneratingPlan: setGenPlan,
    getResearchAbort: getAbort, setResearchAbort: setAbort,
    getLastPlannerContent: getPlannerContent, setLastPlannerContent: setPlannerContent,
    persistState: () => persistState(persistDeps()),
    saveCurrentSession: () => saveCurrentSession(persistDeps()),
    log,
  };
}

function commandDeps() {
  return {
    session, chatProvider, pluginRegistry, modelResolver, config, fsAdapter, terminalRunner,
    settingsService, secretStore,
    getCurrentPlan: getPlan, setCurrentPlan: setPlan,
    getCurrentGoal: getGoal, setCurrentGoal: setGoal,
    isGeneratingPlan: getGenPlan, setGeneratingPlan: setGenPlan,
    getResearchAbort: getAbort, setResearchAbort: setAbort,
    setLastPlannerContent: setPlannerContent,
    handleApprovePlan: () => handleApprovePlan(planDeps()),
    handleStartPlanning: (text: string) => handleStartPlanning(text, planDeps(), pendingRunners),
    sendRunnerAndModels,
    runApiKeyWizard,
    discoverOrchestratorModelOptions,
    pickModelWithProvider,
    persistState: () => persistState(persistDeps()),
    saveCurrentSession: () => saveCurrentSession(persistDeps()),
    log,
  };
}

// --- Model discovery & helpers ---

let modelsRefreshInFlight: Promise<void> | null = null;

// Throttle the degraded-discovery toast so a repeated refresh (each ready
// message, each runner toggle) can't spam it. One warning per ~2 minutes.
let lastDegradedWarnAt = 0;
const DEGRADED_WARN_COOLDOWN_MS = 2 * 60 * 1000;

function maybeWarnDegradedDiscovery(degradedRunners: string[]): void {
  if (degradedRunners.length === 0) return;
  if (Date.now() - lastDegradedWarnAt < DEGRADED_WARN_COOLDOWN_MS) return;
  lastDegradedWarnAt = Date.now();
  const names = degradedRunners.join(', ');
  vscode.window.showWarningMessage(
    `Ordewell discovered no models for installed runner${degradedRunners.length > 1 ? 's' : ''}: ${names}. ` +
    `The CLI may be cold (try again in a moment) or the core build may be stale (run "npm run build:core"). ` +
    `The model picker will be incomplete until discovery succeeds.`,
  );
}

// Throttle the provider-catalog failure toast the same way, keyed separately so
// it never suppresses (or is suppressed by) the runner-discovery warning above.
let lastProviderErrorWarnAt = 0;

function maybeWarnProviderDiscoveryErrors(errors: Record<string, string>): void {
  const failed = Object.keys(errors);
  if (failed.length === 0) return;
  if (Date.now() - lastProviderErrorWarnAt < DEGRADED_WARN_COOLDOWN_MS) return;
  lastProviderErrorWarnAt = Date.now();
  const detail = failed
    .map((p) => `${PROVIDER_SHORT_LABEL[p as ApiProvider] ?? p} (${errors[p]})`)
    .join('; ');
  vscode.window.showWarningMessage(
    `Ordewell could not load the model catalog for ${failed.length > 1 ? 'these providers' : 'this provider'}: ${detail}. ` +
    `Check the API key and base URL. Their models are omitted from the picker.`,
  );
}

/** Re-discover runner models and push them to the webview. Concurrent calls share one discovery run. */
function sendRunnerAndModels(): Promise<void> {
  if (!modelsRefreshInFlight) {
    modelsRefreshInFlight = doSendRunnerAndModels().finally(() => { modelsRefreshInFlight = null; });
  }
  return modelsRefreshInFlight;
}

async function doSendRunnerAndModels(): Promise<void> {
  modelResolver.refreshRunnerModels();
  const enabled = config.enabledRunners;
  // Resolve installed runners up front so a discovery that returns nothing for
  // an *installed* runner can be surfaced as a real failure (see below).
  const allPlugins = pluginRegistry.list();
  const installedIds = new Set(
    await runnerInstallation.filterInstalled(allPlugins.map((p) => p.manifest.name)),
  );

  const allModels: import('@ordewell/core').DiscoveredModel[] = [];
  const byRunner = await modelResolver.modelsForRunners(enabled);
  const degraded: string[] = [];
  for (const r of enabled) {
    const models = byRunner[r] ?? [];
    for (const m of models) {
      if (!allModels.find((x) => x.modelId === m.modelId)) allModels.push(m);
    }
    // Provider breakdown in the output channel — a shrunken list here (e.g.
    // only the runner's free tier) means the runner CLI couldn't see its own
    // auth/config from this process, not a Ordewell-side filter.
    const byProvider: Record<string, number> = {};
    for (const m of models) {
      const p = m.runnerProvider ?? m.modelId.split('/')[0];
      byProvider[p] = (byProvider[p] ?? 0) + 1;
    }
    log(`Model discovery [${r}]: ${models.length} models (${Object.entries(byProvider).map(([p, n]) => `${p}: ${n}`).join(', ') || 'none'})`);
    // An installed runner that discovers zero models means discovery degraded
    // (cold CLI timeout, or a stale `@ordewell/core` build the extension
    // requires at runtime) — NOT an empty catalog. Left silent, the model
    // picker just looks short. Surface it so the user knows to retry/rebuild.
    if (models.length === 0 && installedIds.has(r)) degraded.push(r);
  }
  chatProvider.setModels(allModels);
  chatProvider.setModelsByRunner(byRunner);
  maybeWarnDegradedDiscovery(degraded);

  const installedPlugins = allPlugins.filter((p) => installedIds.has(p.manifest.name));
  const runnerList = installedPlugins.map((p) => ({
    id: p.manifest.name,
    displayName: p.manifest.displayName,
  }));
  chatProvider.setRunnerList(runnerList);
  chatProvider.setEnabledRunnerIds(enabled.filter((r) => installedIds.has(r)));

  const modesByRunner: Record<string, { id: string; label: string; description: string; cliValue?: string; autonomous?: boolean }[]> = {};
  for (const plugin of installedPlugins) {
    modesByRunner[plugin.manifest.name] = (plugin.manifest.modes ?? []).map((m) => ({
      id: m.id, label: m.label, description: m.description, cliValue: m.cliValue, autonomous: m.autonomous,
    }));
  }
  chatProvider.setModesByRunner(modesByRunner);
  chatProvider.sendConfiguredProviders(config.configuredProviders);
  sendModelConfig();
  void sendPlannerState().catch((err) => log(`Planner state refresh failed: ${err}`));
  chatProvider.setModelOptions(ModelResolver.builtinOptions());

  const discoveredModelIds = allModels.map((m) => m.modelId);
  discoverOrchestratorModelOptions().then((opts) => {
    chatProvider.setModelOptions(opts);
    const mapping = modelApiMappingFromOptions(discoveredModelIds, opts);
    chatProvider.setModelApiMapping(mapping);
    // Flag any configured provider whose catalog fetch failed — both in the
    // webview (persistent banner) and as a one-shot toast.
    const errors = modelResolver.getDiscoveryErrors();
    chatProvider.setModelDiscoveryErrors(errors);
    maybeWarnProviderDiscoveryErrors(errors);
  }).catch((err) => log(`Model options discovery error: ${err}`));
}

function sendModelConfig(): void {
  chatProvider.setModelConfig({
    orchestrator: config.orchestratorModel,
    orchestratorProvider: providerLabelForId(config.rawOrchestratorModel),
  });
}

function providerLabelForId(id: string): string {
  if (!id) return '';
  for (const provider of PROVIDER_PRIORITY) {
    const meta = getProviderMeta(provider);
    if (meta?.modelPrefix && id.startsWith(meta.modelPrefix)) return meta.shortLabel;
  }
  return 'OpenRouter';
}

async function discoverOrchestratorModelOptions(): Promise<{ id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[]> {
  const options = await modelResolver.pickerOptions();
  await modelResolver.refresh();
  return options;
}

function modelApiMappingFromOptions(
  modelIds: string[],
  options: { id: string; apiProvider?: AiProvider }[],
): Record<string, AiProvider[]> {
  const byId = new Map<string, AiProvider>();
  for (const o of options) if (o.apiProvider) byId.set(o.id, o.apiProvider);
  const mapping: Record<string, AiProvider[]> = {};
  for (const id of modelIds) {
    mapping[id] = byId.get(id) ? [byId.get(id)!] : [];
  }
  return mapping;
}

type PickerOption = { id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string };
type ExtraPick = { label: string; detail?: string; modelId: string };

function modelQuickPickItem(o: PickerOption): vscode.QuickPickItem & { modelId: string } {
  const via = o.apiProvider ? ` · via ${PROVIDER_SHORT_LABEL[o.apiProvider] ?? o.apiProvider}` : '';
  return {
    label: o.label,
    description: o.id,
    detail: `${o.description ?? ''}${o.pricing ? ' · $' + o.pricing + '/MTok' : ''}${via}`.trim(),
    modelId: o.id,
  };
}

function pickModelWithProvider(
  options: PickerOption[],
  configuredProviders: ApiProvider[],
  placeHolder: string,
  extraItems: ExtraPick[] = [],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (configuredProviders.length === 0) {
      vscode.window.showWarningMessage('No API keys configured. Run "Ordewell: Configure API Key" first.');
      resolve(undefined);
      return;
    }
    type Item = vscode.QuickPickItem & { modelId?: string; providerId?: ApiProvider };
    const qp = vscode.window.createQuickPick<Item>();
    qp.ignoreFocusOut = true;
    let settled = false;
    const finish = (val?: string) => { settled = true; resolve(val); qp.hide(); };
    const extras: Item[] = extraItems.map((e) => ({ label: e.label, detail: e.detail, modelId: e.modelId }));

    const showProviderStep = () => {
      qp.title = 'Select a provider';
      qp.placeholder = "Which provider's models?";
      qp.buttons = [];
      qp.items = [
        ...extras,
        ...configuredProviders.map<Item>((p) => ({
          label: `Use ${PROVIDER_SHORT_LABEL[p] ?? p} models`,
          detail: p === 'openrouter' ? '200+ models via OpenRouter' : p === 'google' ? 'Native Gemini models' : `${PROVIDER_LABEL[p] ?? p} models`,
          providerId: p,
        })),
      ];
    };

    const showModelStep = (provider: ApiProvider, withExtras = false) => {
      qp.title = `Select a model — ${PROVIDER_SHORT_LABEL[provider] ?? provider}`;
      qp.placeholder = placeHolder;
      qp.buttons = configuredProviders.length >= 2 ? [vscode.QuickInputButtons.Back] : [];
      qp.items = [
        ...(withExtras ? extras : []),
        ...options.filter((o) => o.apiProvider === provider).map(modelQuickPickItem),
      ];
    };

    qp.onDidTriggerButton((btn) => {
      if (btn === vscode.QuickInputButtons.Back) showProviderStep();
    });
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (!sel) return;
      if (sel.providerId) { showModelStep(sel.providerId); return; }
      if (sel.modelId) finish(sel.modelId);
    });
    qp.onDidHide(() => { if (!settled) resolve(undefined); qp.dispose(); });

    if (configuredProviders.length === 1) showModelStep(configuredProviders[0], true);
    else showProviderStep();
    qp.show();
  });
}

async function runApiKeyWizard(preselected?: ApiProvider): Promise<void> {
  const { validateApiKey } = await import('./adapters/ApiKeyValidator');
  let provider = preselected;
  if (!provider) {
    const items = PROVIDER_PRIORITY.map((p) => {
      const meta = getProviderMeta(p);
      return { label: meta?.shortLabel ?? p, value: p as ApiProvider, detail: meta?.label ?? p };
    });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Which AI provider are you configuring?' });
    if (!picked) return;
    provider = picked.value;
  }

  const meta = getProviderMeta(provider);
  const providerLabel = meta?.shortLabel ?? 'OpenRouter';
  const secretKey: SecretKey = (meta?.secretStoreKey as SecretKey) || 'openrouterKey';
  const placeHolder = provider === 'google' ? 'AIza…' : 'sk-…';

  for (;;) {
    const key = await vscode.window.showInputBox({
      password: true, placeHolder,
      prompt: `Enter your ${providerLabel} API key`,
      ignoreFocusOut: true,
    });
    if (!key) return;

    const validation = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Validating ${providerLabel} key…` },
      () => validateApiKey(provider!, key, {
        openrouterBaseUrl: config.openAiBaseUrl,
        openaiCompatibleBaseUrl: config.openaiCompatibleBaseUrl,
      }),
    );

    if (validation.status === 'invalid') {
      await vscode.window.showErrorMessage(`Invalid API key: ${validation.message}`);
      continue;
    }
    if (validation.status === 'network') {
      vscode.window.showWarningMessage('Could not reach the API — saved the key anyway.');
    }

    await secretStore.set(secretKey, key);
    session.aiServiceInstance.reset();
    modelResolver.invalidate();
    await sendRunnerAndModels();
    vscode.window.showInformationMessage(`API key configured for ${providerLabel}.`);
    return;
  }
}

// --- Chat listener ---

function setupChatListener(context: vscode.ExtensionContext): void {
  context.subscriptions.push(chatProvider.onMessage(async (msg) => {
    switch (msg.type) {
      case 'ready': {
        chatProvider.resendAllState();
        chatProvider.setSkillToggles(settingsService.getGrillMe(), settingsService.getTdd(), settingsService.getPrd(), settingsService.getVerification(), settingsService.getResearchSubagents(), unavailableSkills());
        // Activation-time discovery can catch a runner CLI cold (server spawn,
        // catalog fetch, auth store still loading) and cache a degraded model
        // list. Re-discover in the background whenever a webview (re)connects
        // so the list self-heals without a manual /refresh.
        void sendRunnerAndModels().catch((err) => log(`Background model refresh failed: ${err}`));
        // Replay the persisted dialogue so a reloaded webview shows the full
        // chat, not just the plan. restoreChat goes first: it clears any stale
        // stopped/busy state before the plan message arrives.
        const history = currentPlan.conversationHistory ?? [];
        if (history.length > 0 || currentPlan.tasks.length > 0) {
          chatProvider.restoreChat(history, currentPlan.tasks.length > 0);
        }
        if (currentPlan.tasks.length > 0) {
          chatProvider.showPlan(currentPlan);
          if (currentGoal) chatProvider.setGoal(currentGoal);
        } else {
          chatProvider.setState('empty');
        }
        break;
      }

      case 'sendMessage': {
        const text = msg.text ?? '';
        const ctx = msg.actionContext;
        const incomingRunners = msg.runners;

        if (ctx) {
          switch (ctx.type) {
            case 'approve':
              if (ctx.taskId) {
                session.approveCheckpoint(ctx.taskId);
              } else {
                await handleApprovePlan(planDeps());
              }
              break;
            case 'retry':
              if (ctx.taskId) {
                await session.retryTask(ctx.taskId);
                chatProvider.showPlan(currentPlan);
                persistState(persistDeps());
              } else {
                chatProvider.setState('researching');
                if (currentPlan.tasks.length > 0) {
                  await handleModifyPlan(text || 'Regenerate the plan', planDeps());
                } else if (session.isConversationActive) {
                  await handleContinueConversation(text || 'Regenerate the plan', planDeps());
                } else {
                  await handleStartPlanning(text || 'Regenerate the plan', planDeps(), incomingRunners ?? pendingRunners);
                }
              }
              break;
            case 'skip':
              if (ctx.taskId) {
                const task = findTask(currentPlan, ctx.taskId);
                if (task) { task.status = 'completed'; }
                chatProvider.showPlan(currentPlan);
                await session.tick();
                persistState(persistDeps());
              }
              break;
            case 'merge': {
              const mergeData = text ? JSON.parse(text) as { taskIds?: string[] } : null;
              if (mergeData?.taskIds && mergeData.taskIds.length >= 2) {
                await handleMergePlan(mergeData.taskIds, planDeps());
              }
              break;
            }
            case 'split': {
              if (ctx.taskId) {
                await handleSplitPlan(ctx.taskId, planDeps());
              }
              break;
            }
            case 'addTask': {
              const draft = parseTaskDraft(text);
              if (!draft) break;
              await session.addTask(draft);
              if (session.planState) currentPlan = session.planState;
              chatProvider.showPlan(currentPlan);
              persistState(persistDeps());
              saveCurrentSession(persistDeps());
              break;
            }
            case 'cancel':
              if (ctx.taskId) {
                await session.cancelTask(ctx.taskId);
              } else {
                chatProvider.setState('planDraft');
                chatProvider.showPlan(currentPlan);
              }
              chatProvider.showPlan(currentPlan);
              persistState(persistDeps());
              break;
            case 'execute': {
              if (!ctx.taskId) break;
              const edit = classifyTaskEdit(text);
              if (edit.kind === 'runner') {
                // A runner change re-derives the task's model, effort and mode
                // from the new runner's catalog, so it goes through the session
                // (which owns that retarget) and the plan is re-shown — the
                // webview only echoed the runner itself.
                await session.setTaskRunner(ctx.taskId, edit.runner);
                if (session.planState) currentPlan = session.planState;
                chatProvider.showPlan(currentPlan);
                persistState(persistDeps());
                saveCurrentSession(persistDeps());
              } else if (edit.kind === 'model') {
                const task = findTask(currentPlan, ctx.taskId);
                if (task) {
                  task.assignedModel = edit.assignment;
                  persistState(persistDeps());
                }
              } else if (edit.kind === 'mode') {
                const task = findTask(currentPlan, ctx.taskId);
                if (task) { task.taskMode = edit.mode; persistState(persistDeps()); }
              } else if (edit.kind === 'prompt') {
                await session.updateTask(ctx.taskId, { prompt: edit.prompt, description: edit.prompt || undefined });
                chatProvider.showPlan(currentPlan);
                persistState(persistDeps());
                saveCurrentSession(persistDeps());
              } else if (edit.kind === 'dependencies') {
                try {
                  await session.setTaskDependencies(ctx.taskId, edit.dependencies);
                } catch (err) {
                  vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
                }
                // Re-shown either way: the webview's checkboxes must end up
                // showing what was accepted, not what was attempted.
                if (session.planState) currentPlan = session.planState;
                chatProvider.showPlan(currentPlan);
                persistState(persistDeps());
                saveCurrentSession(persistDeps());
              } else {
                const confirm = await vscode.window.showWarningMessage(
                  removalPrompt(currentPlan.tasks, ctx.taskId), { modal: true }, 'Remove',
                );
                if (confirm !== 'Remove') break;
                await session.removeTask(ctx.taskId);
                if (session.planState) currentPlan = session.planState;
                if (session.planTasks.length === 0) {
                  chatProvider.setState('empty');
                  const { clearState } = await import('@ordewell/core');
                  clearState(fsAdapter.getWorkspaceRoot());
                } else {
                  chatProvider.showPlan(currentPlan);
                }
                persistState(persistDeps());
              }
              break;
            }
          }
        } else if (text.startsWith('/')) {
          try {
            const slashDeps = {
              config: {
                orchestratorModel: config.orchestratorModel,
                planningModel: config.planningModel,
                enabledRunners: config.enabledRunners,
                autonomousMode: config.autonomousMode,
                apiKey: config.apiKey,
                openAiBaseUrl: config.openAiBaseUrl,
                configuredProviders: config.configuredProviders,
                aiProvider: config.aiProvider,
                plannerThinkingEffort: config.plannerThinkingEffort,
              },
              modelResolver: {
                pickerOptions: () => modelResolver.pickerOptions(),
                refresh: () => modelResolver.refresh(),
                invalidate: () => modelResolver.invalidate(),
                refreshRunnerModels: () => modelResolver.refreshRunnerModels(),
                modelsForRunners: (runners: string[]) => modelResolver.modelsForRunners(runners),
              },
              pluginRegistry: {
                get: (id: string) => pluginRegistry.get(id),
                getManifest: (id: string) => pluginRegistry.getManifest(id),
                list: () => pluginRegistry.list(),
              },
              chatProvider,
              settingsService,
              plannerBackends: plannerBackendList,
              refreshPlannerState: sendPlannerState,
              sendRunnerAndModels,
              runApiKeyWizard,
              discoverOrchestratorModelOptions,
              pickModelWithProvider,
              updateConfig: async (key: string, value: unknown) => config.update(key, value),
              recordPlannerModel: (model: string, effort?: string) => plannerModelMemory.remember(config.aiProvider, model, effort),
              log,
            };
            await handleSlashCommand(text, slashDeps);
          } catch (err) {
            log(`[ERROR] slash command "${text}" failed: ${err instanceof Error ? err.message : String(err)}`);
            vscode.window.showErrorMessage(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          await handleSendMessage(text, planDeps(), incomingRunners ?? pendingRunners, (r) => { pendingRunners = r; });
        }
        break;
      }

      case 'sendSystemCommand':
        await handleSystemCommand(msg.command, msg.taskId ?? '', planDeps());
        break;

      case 'toggleSkill':
        if (msg.skillId === 'grill-me') settingsService.setGrillMe(msg.enabled);
        else if (msg.skillId === 'tdd') settingsService.setTdd(msg.enabled);
        else if (msg.skillId === 'prd') settingsService.setPrd(msg.enabled);
        else if (msg.skillId === 'verify') settingsService.setVerification(msg.enabled);
        else if (msg.skillId === 'research-subagents') settingsService.setResearchSubagents(msg.enabled);
        chatProvider.setSkillToggles(settingsService.getGrillMe(), settingsService.getTdd(), settingsService.getPrd(), settingsService.getVerification(), settingsService.getResearchSubagents(), unavailableSkills());
        break;

      case 'setPlanner':
        await applyPlanner(msg.provider as AiProvider);
        break;

      case 'setPlannerModel': {
        await config.update('orchestratorModel', msg.modelId);
        await config.update('plannerThinkingEffort', msg.effort ?? '');
        plannerModelMemory.remember(config.aiProvider, msg.modelId, msg.effort);
        sendModelConfig();
        await sendPlannerState();
        break;
      }

      case 'stopResearch':
        // Stop aborts the current planner turn only. It must never clear the
        // plan, the dialogue, or the persisted state — that's newSession.
        isGeneratingPlan = false;
        currentResearchAbort?.abort();
        session.aiServiceInstance.reset();
        if (lastPlannerContent) {
          chatProvider.sendPlannerInterrupted(lastPlannerContent);
          chatProvider.setState('planDraft');
        }
        lastPlannerContent = null;
        log('Research stopped');
        break;

      case 'newSession': {
        isGeneratingPlan = false;
        currentResearchAbort?.abort();
        session.aiServiceInstance.reset();
        lastPlannerContent = null;
        // Full core reset — not just the AI service. Anything short of this
        // leaves the previous session's tasks in the Session's PlanStore, and
        // the planner presents them as the current plan in the next chat.
        session.reset();
        terminalRunner.stopAll();
        currentPlan = createEmptyPlan();
        currentGoal = '';
        chatProvider.setState('empty');
        chatProvider.setGoal('');
        const { clearState } = await import('@ordewell/core');
        clearState(fsAdapter.getWorkspaceRoot());
        log('New session started');
        break;
      }
    }
  }));
}
