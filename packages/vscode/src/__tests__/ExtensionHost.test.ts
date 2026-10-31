import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RUN_SETTINGS_DEFAULTS,
  createTask, defaultEnabledRunners, saveState, RunnerRegistry, recordedInstalledPlanner, resetInstalledPlanner,
  type AiProvider, type DiscoveredModel, type GlobalRunSettings, type IRunner, type LegacyPlanState, type PlannerUsability,
  type ModelResolver, type PlannerModelMemory, type RunnerInstallation,
  type RunView, type Session, type SessionDeps, SettingsService, createSession, sessionRuntimeSettings,
  type ConversationRequest, type ConversationTurn,
  PendingApprovals, approvalScopes, type ApprovalRequestMessage,
  AccountLimitMonitor, type AccountLimitCollector, type AccountLimitReading,
  type IIsolationPreview, type IsolationPreview,
} from '@ordewell/core';
// Delegation is not offered yet (ADR-0055 D21); the two tests that follow
// flip the switch to cover it both ways.
const delegation = vi.hoisted(() => ({ offered: false }));
vi.mock('@ordewell/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ordewell/core')>(),
  get DELEGATION_OFFERED() { return delegation.offered; },
}));

import { ChatViewProvider as RealChatViewProvider } from '../providers/ChatViewProvider';
import { createExtension, type ExtensionServices } from '../ExtensionHost';
import type { ChatViewProvider } from '../providers/ChatViewProvider';
import type { SecretStore, ApiProvider } from '../adapters/SecretStore';
import type { VsCodeConfig } from '../adapters/VsCodeConfig';
import type { VsCodeFileSystem } from '../adapters/VsCodeFileSystem';
import type { VsCodeNotification } from '../adapters/VsCodeNotification';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { __panels, __resetPanels, commands, createFakeWebviewPanel, window } from '../test/vscode.mock';

const models: DiscoveredModel[] = [
  { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [], runnerProvider: 'anthropic' },
];

function planWithOneTask(goal: string): LegacyPlanState {
  const at = '2026-01-01T00:00:00Z';
  return {
    tasks: [createTask({ id: 't1', order: 1, title: goal, prompt: goal, assignedRunner: 'claude-code', taskMode: 'default', attempted: true })],
    generatedAt: at,
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: at,
  };
}

function fakeChat() {
  const messages = new vscode.EventEmitter<WebviewToHost>();
  const provider = {
    onMessage: messages.event,
    conversation: {
      receive: vi.fn(), note: vi.fn(), holdPrompt: vi.fn(), unsendPrompt: vi.fn(),
      nextPrompt: vi.fn(() => undefined), stop: vi.fn(), reset: vi.fn(), reload: vi.fn(), resync: vi.fn(), waiting: vi.fn(),
    },
    run: { receive: vi.fn(), adopt: vi.fn(), reset: vi.fn(), clearIsolation: vi.fn() },
    resendAllState: vi.fn(),
    restoreChat: vi.fn(),
    replaceConversation: vi.fn(),
    setState: vi.fn(),
    showError: vi.fn(),
    showPlan: vi.fn(),
    adoptRun: vi.fn(),
    planApproved: vi.fn(),
    setPlanDockHeight: vi.fn(),
    setRunSettings: vi.fn(),
    setSkills: vi.fn(),
    setTaskSkills: vi.fn(),
    setModels: vi.fn(),
    setModelsByRunner: vi.fn(),
    setRunnerList: vi.fn(),
    setEnabledRunnerIds: vi.fn(),
    setModelAllowlist: vi.fn(),
    setModesByRunner: vi.fn(),
    sendConfiguredProviders: vi.fn(),
    setModelConfig: vi.fn(),
    setModelOptions: vi.fn(),
    setModelDiscoveryErrors: vi.fn(),
    setPlannerBackends: vi.fn(),
    clearIsolationHandoff: vi.fn(),
    sendTaskOutput: vi.fn(),
    reveal: vi.fn(),
    setAccountLimits: vi.fn(),
    postMessage: vi.fn(),
    setIsolationPreview: vi.fn(),
  };
  return { messages, provider };
}

function fakeVscodeApi() {
  const showWarningMessage = vi.fn();
  const showInformationMessage = vi.fn();
  const windowStateListeners: Array<(state: { focused: boolean }) => void> = [];
  const folderListeners: Array<() => void> = [];
  const api = {
    window: {
      state: { focused: true },
      onDidChangeWindowState: vi.fn((listener: (state: { focused: boolean }) => void) => {
        windowStateListeners.push(listener);
        return { dispose: vi.fn() };
      }),
      registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
      registerWebviewPanelSerializer: vi.fn(() => ({ dispose: vi.fn() })),
      showWarningMessage,
      showInformationMessage,
      showErrorMessage: vi.fn(),
      showInputBox: vi.fn(),
      createQuickPick: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    },
    workspace: {
      onDidChangeWorkspaceFolders: vi.fn((listener: () => void) => { folderListeners.push(listener); return { dispose: vi.fn() }; }),
    },
    QuickInputButtons: { Back: {} },
    ProgressLocation: { Notification: 15 },
  };
  return {
    api: api as unknown as typeof vscode,
    showWarningMessage,
    showInformationMessage,
    /** The window gained or lost focus. */
    focus: (focused: boolean) => { for (const listener of windowStateListeners) listener({ focused }); },
    /** A folder was added to or removed from the window's workspace. */
    foldersChanged: () => { for (const listener of folderListeners) listener(); },
  };
}

function fakeConfig() {
  const listeners: Array<() => void> = [];
  const values: Record<string, unknown> = {
    aiProvider: 'openrouter',
    rawAiProvider: '',
    apiKey: 'sk-test',
    planningModel: 'vendor/model',
    orchestratorModel: 'vendor/model',
    rawOrchestratorModel: 'vendor/model',
    plannerThinkingEffort: '',
    enabledRunners: ['claude-code'],
    autonomousMode: true,
    openAiBaseUrl: '',
    openaiCompatibleBaseUrl: '',
    configuredProviders: ['openrouter'] as ApiProvider[],
    maxParallelSessions: 2,
  };
  const config = {
    get aiProvider() { return values.aiProvider as AiProvider; },
    get rawAiProvider() { return values.rawAiProvider as string; },
    get apiKey() { return values.apiKey as string; },
    getProviderApiKey: () => values.apiKey as string,
    get planningModel() { return values.planningModel as string; },
    get orchestratorModel() { return values.orchestratorModel as string; },
    get rawOrchestratorModel() { return values.rawOrchestratorModel as string; },
    get plannerThinkingEffort() { return values.plannerThinkingEffort as string; },
    get enabledRunners() { return values.enabledRunners as string[]; },
    get autonomousMode() { return values.autonomousMode as boolean; },
    get openAiBaseUrl() { return values.openAiBaseUrl as string; },
    get openaiCompatibleBaseUrl() { return values.openaiCompatibleBaseUrl as string; },
    get configuredProviders() { return values.configuredProviders as ApiProvider[]; },
    get maxParallelSessions() { return values.maxParallelSessions as number; },
    update: vi.fn(async (key: string, value: unknown) => { values[key] = value; }),
    onDidChange: vi.fn((listener: () => void) => { listeners.push(listener); return { dispose: vi.fn() }; }),
  };
  return { config: config as unknown as VsCodeConfig, listeners, values };
}

function fakeSession() {
  let runSettingsValue: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS };
  const spies = {
    sessionId: 's1',
    plannerSettingsChanged: vi.fn(),
    reschedule: vi.fn(async () => {}),
    applyRunSettings: vi.fn((changes: Partial<GlobalRunSettings>) => {
      runSettingsValue = { ...runSettingsValue, ...changes };
    }),
    /** This window's session copy, which its panel shows (ADR-0030). */
    runSettings: vi.fn(() => ({ ...runSettingsValue })),
    isExecuting: false,
    isConversationActive: false,
    isPlannerBusy: false,
    status: 'draft',
    planState: null as LegacyPlanState | null,
    planTasks: [],
    runSnapshot: vi.fn(() => ({ tasks: [], runMerge: null, handoff: null, mergeResult: null })),
    taskLogAttempts: vi.fn(() => []),
    taskLog: vi.fn(() => []),
    invokeTaskCommand: vi.fn(() => ''),
    outstandingApprovals: vi.fn(() => []),
    isolationView: vi.fn(() => null),
    removeQueuedMessage: vi.fn(),
    reset: vi.fn(),
    abortPlannerTurn: vi.fn(() => false),
    loadPlan: vi.fn(),
    destroy: vi.fn(),
    heldElsewhere: vi.fn(() => null),
    execute: vi.fn(async () => ({ ok: true, message: 'done' })),
    executePlan: vi.fn(async () => {}),
    stopExecution: vi.fn(),
    startPlanning: vi.fn(async (goal: string) => planWithOneTask(goal)),
    continueConversation: vi.fn(async () => planWithOneTask('continued')),
    compactConversation: vi.fn(async (): Promise<unknown> => ({ summary: 'the summary', keptMessages: 4 })),
    cancelTask: vi.fn(async () => {}),
    retryTask: vi.fn(async () => {}),
    markTaskComplete: vi.fn(async () => {}),
    markTaskIncomplete: vi.fn(async () => {}),
    forceStartTask: vi.fn(async () => {}),
    runTask: vi.fn(async () => {}),
    announcedApprovals: vi.fn((): ApprovalRequestMessage[] => []),
  };
  return {
    session: spies as unknown as Session,
    spies,
    /** The copy this window's session opened with, or took from a change (ADR-0030). */
    setRunSettings: (value: GlobalRunSettings) => { runSettingsValue = { ...value }; },
  };
}

function fakeResolver(modelsByRunner: Partial<Record<string, DiscoveredModel[]>> = { 'claude-code': models }) {
  return {
    refreshRunnerModels: vi.fn(),
    modelsForRunners: vi.fn(async (runners: string[]) => {
      const out: Partial<Record<string, DiscoveredModel[]>> = {};
      for (const r of runners) out[r] = modelsByRunner[r] ?? [];
      return out;
    }),
    pickerOptions: vi.fn(async () => []),
    refresh: vi.fn(async () => {}),
    invalidate: vi.fn(),
    getDiscoveryErrors: vi.fn(() => ({})),
    getCachedRunnerModels: vi.fn((runner: string) => modelsByRunner[runner] ?? []),
    getCachedPickerOptions: vi.fn(() => []),
    plannerCatalog: vi.fn(async () => []),
    cachedPlannerCatalog: vi.fn(() => []),
    contextWindowFor: vi.fn(() => undefined),
    maxOutputTokensFor: vi.fn(() => undefined),
    warmPickerOptions: vi.fn(),
    withRunnerEnv: vi.fn(),
  } satisfies Record<keyof ModelResolver, unknown>;
}

function fakeRunnerInstallation(installed: string[]) {
  return {
    filterInstalled: vi.fn(async (runners: string[]) => runners.filter((r) => installed.includes(r))),
    plannerUsability: vi.fn(async (_runner?: string): Promise<PlannerUsability> => ({ usable: true, reason: undefined })),
    // A discovery refresh asks again; the fake keeps no verdicts, so it is a no-op.
    refresh: vi.fn(),
  };
}

function fakeSettings() {
  let run = { ...RUN_SETTINGS_DEFAULTS };
  const watchers: Array<() => void> = [];
  return {
    watchers,
    /** Another surface saved the file. */
    saved: () => { for (const listener of watchers) listener(); },
    watch: vi.fn((listener: () => void) => { watchers.push(listener); return { dispose: vi.fn() }; }),
    getAll: vi.fn(() => ({})),
    getRunSettings: vi.fn(() => ({ ...run })),
    updateRunSettings: vi.fn((changes: Partial<typeof run>) => { run = { ...run, ...changes }; }),
    setAutonomousMode: vi.fn(),
  };
}

function harness(overrides: {
  modelResolver?: ReturnType<typeof fakeResolver>;
  runnerInstallation?: ReturnType<typeof fakeRunnerInstallation>;
  chatProvider?: ChatViewProvider;
  accountLimits?: AccountLimitMonitor;
  /** A settings file of the test's own, in place of the fake that holds nothing. */
  settingsService?: SettingsService;
  sessionFactory?: ExtensionServices['sessionFactory'];
  isolationPreview?: IIsolationPreview;
} = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-host-'));
  const vscodeApi = fakeVscodeApi();
  const chat = fakeChat();
  const config = fakeConfig();
  const session = fakeSession();
  const settings = fakeSettings();
  const sessionDeps: { current?: SessionDeps } = {};
  const resolver = overrides.modelResolver ?? fakeResolver();
  const installation = overrides.runnerInstallation ?? fakeRunnerInstallation(['claude-code']);
  const runnerRegistry = new RunnerRegistry();
  const stored = new Map<string, unknown>();
  const globalState = {
    get: (key: string) => stored.get(key),
    update: vi.fn(async (key: string, value: unknown) => { stored.set(key, value); }),
  };

  const notifications = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn() };

  const services: ExtensionServices = {
    context: { subscriptions: [], extensionUri: { toString: () => 'file:///ext' }, globalState } as unknown as vscode.ExtensionContext,
    outputChannel: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    secretStore: { set: vi.fn(), get: vi.fn() } as unknown as SecretStore,
    config: config.config,
    runnerRegistry,
    runnerInstallation: installation as unknown as RunnerInstallation,
    fsAdapter: { getWorkspaceRoot: () => workspace } as unknown as VsCodeFileSystem,
    notifications: notifications as unknown as VsCodeNotification,
    runner: { stopAll: vi.fn() } as unknown as IRunner,
    settingsService: overrides.settingsService ?? settings as unknown as SettingsService,
    plannerModelMemory: { remember: vi.fn(), recall: vi.fn(() => ({ model: '', effort: '', source: 'default' })) } as unknown as PlannerModelMemory,
    modelResolver: resolver as unknown as ModelResolver,
    chatProvider: overrides.chatProvider ?? chat.provider as unknown as ChatViewProvider,
    sessionFactory: (deps) => { sessionDeps.current = deps; return overrides.sessionFactory?.(deps) ?? session.session; },
    ...(overrides.accountLimits ? { accountLimits: overrides.accountLimits } : {}),
    ...(overrides.isolationPreview ? { isolationPreview: overrides.isolationPreview } : {}),
  };

  return {
    host: createExtension(services, vscodeApi.api),
    workspace,
    vscodeApi,
    chat,
    config,
    session,
    settings,
    resolver,
    installation,
    notifications,
    services,
    sessionDeps,
  };
}

describe('the extension host wires one state, one deps bag and one lifecycle', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  it('hands the session the shared settings as they are, enabled runners included, read at each call', () => {
    h.settings.getAll.mockReturnValue({ enabledRunners: ['opencode'] });
    expect(h.sessionDeps.current?.settings().enabledRunners).toEqual(['opencode']);

    h.settings.getAll.mockReturnValue({ enabledRunners: ['claude-code', 'codex'] });
    expect(h.sessionDeps.current?.settings().enabledRunners).toEqual(['claude-code', 'codex']);
  });

  it('leaves the session to the config\'s defaults while the user has chosen no runners', () => {
    h.settings.getAll.mockReturnValue({});

    expect(h.sessionDeps.current?.settings().enabledRunners).toBeUndefined();
  });

  it('draws the runner header again when another surface changes the settings file', async () => {
    await h.host.start();
    h.chat.provider.setEnabledRunnerIds.mockClear();
    h.config.values.enabledRunners = ['claude-code', 'codex'];
    h.installation.filterInstalled.mockImplementation(async (runners: string[]) => runners);

    h.settings.saved();

    await vi.waitFor(() => expect(h.chat.provider.setEnabledRunnerIds).toHaveBeenCalledWith(['claude-code', 'codex']));
  });

  it('does not rediscover models for a save that leaves the enabled runners as they were', async () => {
    await h.host.start();
    h.resolver.refreshRunnerModels.mockClear();

    h.settings.saved();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.resolver.refreshRunnerModels).not.toHaveBeenCalled();
  });

  it('draws the allowlist another surface saved, though the enabled runners are as they were', async () => {
    await h.host.start();
    h.resolver.refreshRunnerModels.mockClear();
    h.chat.provider.setModelAllowlist.mockClear();
    h.settings.getAll.mockReturnValue({ modelAllowlist: { codex: ['gpt-5'] } });

    h.settings.saved();

    expect(h.chat.provider.setModelAllowlist).toHaveBeenCalledWith({ codex: ['gpt-5'] });
    expect(h.resolver.refreshRunnerModels).not.toHaveBeenCalled();
  });

  it('shows the run settings another surface saved', async () => {
    await h.host.start();
    h.chat.provider.setRunSettings.mockClear();

    h.settings.saved();

    expect(h.chat.provider.setRunSettings).toHaveBeenCalled();
  });

  it('registers the webview, the host commands and the webview listener through the given vscode api', async () => {
    await h.host.start();

    expect(h.vscodeApi.api.window.registerWebviewViewProvider).toHaveBeenCalledWith('ordewellChatView', h.chat.provider, expect.anything());
    // Task-log panels are created through the `vscode` module itself, so their
    // serializer registers there rather than on this injected api.
    expect(window.registerWebviewPanelSerializer).toHaveBeenCalledWith('ordewellTaskLog', expect.anything());
    expect(h.vscodeApi.api.commands.registerCommand).toHaveBeenCalledWith('ordewell.setPlanner', expect.any(Function));
  });

  it('replays plan, planner state and models when the webview reconnects', async () => {
    await h.host.start();

    h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
    await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalled());

    h.chat.provider.resendAllState.mockClear();
    h.chat.provider.showPlan.mockClear();
    h.chat.provider.setModels.mockClear();

    h.chat.messages.fire({ type: 'ready' });

    await vi.waitFor(() => expect(h.chat.provider.resendAllState).toHaveBeenCalled());
    expect(h.session.spies.startPlanning).toHaveBeenCalledWith('build a parser', ['claude-code']);
    expect(h.chat.provider.showPlan).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 't1' })],
    }));
    await vi.waitFor(() => expect(h.chat.provider.setModels).toHaveBeenCalledWith(models));
    expect(h.chat.provider.setRunSettings).toHaveBeenCalledWith(expect.any(Boolean), RUN_SETTINGS_DEFAULTS, 2);
    await vi.waitFor(() => expect(h.chat.provider.setPlannerBackends).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'claude-code', usable: true })]),
      'openrouter', undefined, '',
    ));
  });

  it('seeds the run view when the webview reconnects, so a task waiting on a runner approval keeps its badge', async () => {
    await h.host.start();
    h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
    await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalled());

    // A run is going and a task is blocked on a runner approval: nothing on the
    // wire will say so again until the user answers, so a recreated webview has
    // to be told now.
    (h.session.spies as unknown as { planState: unknown }).planState = {};
    const view: RunView = {
      tasks: [{
        id: 't1', order: 1, title: 'Parse JSON', type: 'ai', status: 'in_progress', description: '', dependencies: [],
        assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: 'do it', subtasks: [],
        userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined,
        verdict: null, awaitingApproval: 2,
      }],
      runMerge: null, handoff: null, mergeResult: null,
    };
    h.session.spies.runSnapshot = vi.fn(() => view);

    h.chat.messages.fire({ type: 'ready' });

    await vi.waitFor(() => expect(h.chat.provider.adoptRun).toHaveBeenCalledWith(view));
  });

  it('signs a planner in through the router, and tells the chat when there is no login to run', async () => {
    await h.host.start();
    // This fake installation reports no auth verdict, so the module has no
    // login command: the one path that answers without a terminal or a poll.
    h.chat.messages.fire({ type: 'loginPlanner', runner: 'codex' });

    await vi.waitFor(() => expect(h.notifications.info).toHaveBeenCalledWith('Ordewell has no login for Codex.'));
    expect(h.chat.provider.postMessage).toHaveBeenCalledWith({
      type: 'plannerLoginEnded', runner: 'codex', ok: false, message: 'Ordewell has no login for Codex.',
    });
    expect(h.installation.plannerUsability).toHaveBeenCalledWith('codex');
  });

  it('remembers the dragged plan dock height for the next webview to open', async () => {
    await h.host.start();
    h.chat.messages.fire({ type: 'ready' });
    await vi.waitFor(() => expect(h.chat.provider.setPlanDockHeight).toHaveBeenCalledWith(undefined));

    h.chat.messages.fire({ type: 'setPlanDockHeight', height: 340 });
    h.chat.provider.setPlanDockHeight.mockClear();
    h.chat.messages.fire({ type: 'ready' });

    await vi.waitFor(() => expect(h.chat.provider.setPlanDockHeight).toHaveBeenCalledWith(340));
  });

  it('tells the session its planner settings changed, invalidates the resolver and reschedules on a config change', async () => {
    await h.host.start();
    h.resolver.invalidate.mockClear();
    h.resolver.refreshRunnerModels.mockClear();

    for (const listener of h.config.listeners) listener();

    expect(h.session.spies.reschedule).toHaveBeenCalled();
    expect(h.session.spies.plannerSettingsChanged).toHaveBeenCalled();
    expect(h.resolver.invalidate).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.resolver.refreshRunnerModels).toHaveBeenCalled());
  });

  it('logs a failed reschedule on a config change instead of leaving the rejection unhandled', async () => {
    await h.host.start();
    h.session.spies.reschedule.mockRejectedValueOnce(new Error('tick exploded'));

    for (const listener of h.config.listeners) listener();

    const appendLine = h.services.outputChannel.appendLine as unknown as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('Reschedule failed: tick exploded')));
  });

  describe('the planner setting has no static enum, so the host checks it', () => {
    it('names an unknown value and the choices, once, at start and again only when the value changes', async () => {
      await h.config.config.update('rawAiProvider', 'nonesuch');
      await h.host.start();

      expect(h.vscodeApi.showWarningMessage).toHaveBeenCalledTimes(1);
      const message = h.vscodeApi.showWarningMessage.mock.calls[0][0] as string;
      expect(message).toContain('"nonesuch"');
      expect(message).toContain('ordewell.aiProvider');
      for (const id of ['claude-code', 'codex', 'opencode', 'openrouter']) expect(message).toContain(id);

      for (const listener of h.config.listeners) listener();
      expect(h.vscodeApi.showWarningMessage).toHaveBeenCalledTimes(1);

      await h.config.config.update('rawAiProvider', 'other');
      for (const listener of h.config.listeners) listener();
      expect(h.vscodeApi.showWarningMessage).toHaveBeenCalledTimes(2);
      expect(h.vscodeApi.showWarningMessage.mock.calls[1][0]).toContain('"other"');
    });

    it('says nothing for a blank value, a vendor or a runner that can plan', async () => {
      for (const value of ['', 'google', 'codex']) {
        await h.config.config.update('rawAiProvider', value);
        await h.host.start();
      }
      expect(h.vscodeApi.showWarningMessage).not.toHaveBeenCalled();
    });
  });

  it('warns once when an installed runner discovers no models, and throttles repeats', async () => {
    const resolver = fakeResolver({});
    const local = harness({ modelResolver: resolver });
    try {
      await local.host.start();

      expect(local.vscodeApi.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(local.vscodeApi.showWarningMessage.mock.calls[0][0]).toContain('claude-code');

      local.chat.messages.fire({ type: 'refreshModels' });
      await vi.waitFor(() => expect(local.chat.provider.setModels).toHaveBeenCalledTimes(2));

      expect(local.vscodeApi.showWarningMessage).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(local.workspace, { recursive: true, force: true });
    }
  });

  it('routes approve-plan, send-message and system commands to the Session', async () => {
    await h.host.start();

    h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
    await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalled());

    h.chat.messages.fire({ type: 'sendSystemCommand', command: 'executePlan' });
    await vi.waitFor(() => expect(h.session.spies.execute).toHaveBeenCalledWith({ command: 'run_plan' }, { kind: 'user' }));
    // The plan's own status is not the host's to set: the run_plan above is the approval, and the Session keeps it.
    expect(h.session.spies.loadPlan).toHaveBeenCalledWith(
      expect.objectContaining({ tasks: [expect.not.objectContaining({ status: 'approved' })] }),
      'build a parser',
      h.services.fsAdapter.getWorkspaceRoot(),
    );

    h.chat.messages.fire({ type: 'sendSystemCommand', command: 'cancel', taskId: 't1' });
    await vi.waitFor(() => expect(h.session.spies.execute).toHaveBeenCalledWith({ command: 'stop_task', task: 't1' }, { kind: 'user' }));
  });

  describe('a prompt held during a compaction from the Command Palette', () => {
    const registered = (id: string) => (commands.registerCommand as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([name]) => name === id).at(-1)![1] as () => Promise<void>;
    const nextPrompt = () => h.chat.provider.conversation.nextPrompt as unknown as ReturnType<typeof vi.fn>;
    /** The planner takes the turn a released prompt opens, and is busy with it from then on. */
    const plannerTakesTheTurn = () => h.session.spies.startPlanning.mockImplementation(() => {
      h.session.spies.isPlannerBusy = true;
      return new Promise(() => {});
    });

    it.each([
      ['it lands', () => Promise.resolve({ summary: 'the summary', keptMessages: 4 })],
      ['it fails', () => Promise.reject(new Error('rate limited'))],
    ])('is sent once when %s', async (_case, compact) => {
      h.session.spies.compactConversation.mockImplementation(compact);
      await h.host.start();
      nextPrompt().mockReturnValueOnce('typed during the compaction');

      await registered('ordewell.compactConversation')();

      expect(h.session.spies.startPlanning).toHaveBeenCalledTimes(1);
      expect(h.session.spies.startPlanning).toHaveBeenCalledWith('typed during the compaction', ['claude-code']);
    });

    it('stays held while the planner is still busy', async () => {
      await h.host.start();
      h.session.spies.isPlannerBusy = true;
      nextPrompt().mockReturnValueOnce('typed during the compaction');

      await registered('ordewell.compactConversation')();

      expect(nextPrompt()).not.toHaveBeenCalled();
      expect(h.session.spies.startPlanning).not.toHaveBeenCalled();
    });

    // `/compact` runs the same command, then the chat's own drain runs after it:
    // the second finds the planner busy with the first prompt and sends nothing.
    it('sends one prompt, not two, when /compact releases it from both the command and the chat', async () => {
      await h.host.start();
      (commands.executeCommand as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce((id: string) => registered(id)());
      plannerTakesTheTurn();
      nextPrompt().mockReturnValueOnce('first').mockReturnValueOnce('second');

      h.chat.messages.fire({ type: 'sendMessage', text: '/compact', typed: true });

      await vi.waitFor(() => expect(h.session.spies.compactConversation).toHaveBeenCalled());
      await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalledWith('first', ['claude-code']));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.session.spies.startPlanning).toHaveBeenCalledTimes(1);
      expect(nextPrompt()).toHaveBeenCalledTimes(1);
    });
  });

  it('persists and stops runners on dispose', async () => {
    const stopAll = h.services.runner.stopAll as unknown as ReturnType<typeof vi.fn>;
    await h.host.start();
    h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
    await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalled());

    h.host.dispose();

    expect(stopAll).toHaveBeenCalled();
    // A goal still waiting for the probe is stopped with the host's runners.
    expect(h.session.spies.abortPlannerTurn).toHaveBeenCalled();
    // Closed with the window, so another host may open it (ADR-0049).
    expect(h.session.spies.destroy).toHaveBeenCalled();
  });

  it('opens a task log tab on request, through the one registry', async () => {
    await h.host.start();
    __resetPanels();
    (h.session.spies as unknown as { planTasks: unknown[] }).planTasks = [
      createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'claude-code', attempted: true }),
    ];

    h.chat.messages.fire({ type: 'openTaskLog', taskId: 't1' });

    await vi.waitFor(() => expect(__panels).toHaveLength(1));
    expect(__panels[0].viewType).toBe('ordewellTaskLog');
    expect(__panels[0].title).toBe('Task 1 · Parse JSON');
  });

  it('has the plan loaded before VS Code asks it to restore a task-log tab', async () => {
    saveState(planWithOneTask('build a parser'), h.workspace);
    h.session.spies.loadPlan.mockImplementation((plan: LegacyPlanState) => {
      (h.session.spies as unknown as { planTasks: LegacyPlanState['tasks'] }).planTasks = plan.tasks;
    });
    const register = window.registerWebviewPanelSerializer as unknown as ReturnType<typeof vi.fn>;
    const panel = createFakeWebviewPanel('ordewellTaskLog', 'Task log');
    // VS Code revives the tab while activation is still running, so the
    // serializer must already see the task the reloaded plan holds.
    register.mockImplementation((_viewType: string, serializer: { deserializeWebviewPanel: (p: unknown, state: unknown) => Promise<void> }) => {
      void serializer.deserializeWebviewPanel(panel, { taskId: 't1' });
      return { dispose: vi.fn() };
    });

    try {
      await h.host.start();
    } finally {
      register.mockImplementation(() => ({ dispose: vi.fn() }));
    }

    expect(panel.dispose).not.toHaveBeenCalled();
  });
});

describe('the planner with no planner chosen and no API key (ADR-0009)', () => {
  afterEach(() => { resetInstalledPlanner(); delegation.offered = false; });

  // The wait itself is the session's planner gate, so a prompt typed during it
  // is held as one typed during the turn (plannerStartWait.test.ts).
  it('a goal typed before the activation probe answers goes to the session at once, unrefused, and plans with the agent found', async () => {
    let answer!: (value: PlannerUsability) => void;
    const gate = new Promise<PlannerUsability>((resolve) => { answer = resolve; });
    const installation = fakeRunnerInstallation(['claude-code']);
    installation.plannerUsability.mockImplementation(() => gate);
    const h = harness({ runnerInstallation: installation });
    try {
      // Not awaited: activation's own model discovery asks the same gated
      // installation. The webview listener is registered before that.
      const starting = h.host.start();

      h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
      // No runners yet: which are enabled by default is the probe's answer, so
      // the session reads them once its gate opens.
      await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalledWith('build a parser', undefined));
      expect(h.chat.provider.showError.mock.calls).toEqual([]);

      answer({ usable: true });
      await vi.waitFor(() => expect(recordedInstalledPlanner()).toBe('claude-code'));
      expect(h.chat.provider.showError.mock.calls).toEqual([]);
      await starting;
    } finally {
      fs.rmSync(h.workspace, { recursive: true, force: true });
    }
  });
});

describe('the runner header with no saved runner choice', () => {
  afterEach(() => resetInstalledPlanner());

  it('waits for the activation probe, then shows the installed agent enabled', async () => {
    let answer!: () => void;
    const gate = new Promise<void>((resolve) => { answer = resolve; });
    const installation = fakeRunnerInstallation(['codex']);
    installation.plannerUsability.mockImplementation(async (runner?: string) => { await gate; return { usable: runner === 'codex' }; });
    const h = harness({ runnerInstallation: installation });
    // As VsCodeConfig answers when nothing is saved.
    Object.defineProperty(h.config.config, 'enabledRunners', { get: () => defaultEnabledRunners() });
    try {
      const starting = h.host.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.chat.provider.setEnabledRunnerIds).not.toHaveBeenCalled();

      answer();
      await starting;
      await vi.waitFor(() => expect(h.chat.provider.setEnabledRunnerIds).toHaveBeenCalled());
      expect(h.chat.provider.setEnabledRunnerIds.mock.calls).toEqual([[['codex']]]);
    } finally {
      fs.rmSync(h.workspace, { recursive: true, force: true });
    }
  });
});

describe("the Settings panel's Run block", () => {
  let h: ReturnType<typeof harness>;
  const warning = window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
  const lastPush = () => h.chat.provider.setRunSettings.mock.calls.at(-1);

  beforeEach(async () => {
    h = harness();
    await h.host.start();
    warning.mockReset();
    h.chat.provider.setRunSettings.mockClear();
  });
  afterEach(() => {
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  it('saves Full or Guarded and pushes the settings back', async () => {
    h.chat.messages.fire({ type: 'changeSettings', change: { autonomous: false } });

    await vi.waitFor(() => expect(h.settings.setAutonomousMode).toHaveBeenCalledWith(false));
    expect(h.chat.provider.setRunSettings).toHaveBeenCalled();
  });

  it('saves a run setting, applies it to this window\'s run and pushes it back', async () => {
    h.chat.messages.fire({ type: 'changeSettings', change: { run: { wakeUpReadBudget: 20 } } });

    await vi.waitFor(() => expect(h.settings.updateRunSettings).toHaveBeenCalledWith({ wakeUpReadBudget: 20 }));
    expect(h.session.spies.applyRunSettings).toHaveBeenCalledWith({ wakeUpReadBudget: 20 });
    expect(lastPush()).toEqual([true, { ...RUN_SETTINGS_DEFAULTS, wakeUpReadBudget: 20 }, 2]);
  });

  it('keeps a manually configured read budget when another run setting is saved', async () => {
    h.settings.updateRunSettings({ wakeUpReadBudget: 30 });

    h.chat.messages.fire({ type: 'changeSettings', change: { run: { supervisorLevel: 'off' } } });

    await vi.waitFor(() => expect(h.settings.updateRunSettings).toHaveBeenCalledWith({ supervisorLevel: 'off' }));
    expect(h.settings.getRunSettings().wakeUpReadBudget).toBe(30);
    expect(lastPush()).toEqual([true, { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', wakeUpReadBudget: 30 }, 2]);
  });

  it.each([
    [{ supervisorLevel: 'act' as const }, /ops tasks included/],
    [{ autorun: true }, /without review/],
  ])('%j asks first; declined, it saves nothing and pushes the unchanged value', async (run, risk) => {
    warning.mockResolvedValue(undefined);
    h.chat.messages.fire({ type: 'changeSettings', change: { run } });

    await vi.waitFor(() => expect(h.chat.provider.setRunSettings).toHaveBeenCalled());
    expect(JSON.stringify(warning.mock.calls[0])).toMatch(risk);
    expect(h.settings.updateRunSettings).not.toHaveBeenCalled();
    expect(lastPush()).toEqual([true, RUN_SETTINGS_DEFAULTS, 2]);

    warning.mockReset().mockImplementation(async (...args: unknown[]) => args.at(-1));
    h.chat.messages.fire({ type: 'changeSettings', change: { run } });
    await vi.waitFor(() => expect(h.settings.updateRunSettings).toHaveBeenCalledWith(run));
  });

  it('asks before turning delegation on, once it is offered', async () => {
    delegation.offered = true;
    const run = { delegationTokens: 5000000 };
    warning.mockResolvedValue(undefined);
    h.chat.messages.fire({ type: 'changeSettings', change: { run } });

    await vi.waitFor(() => expect(h.chat.provider.setRunSettings).toHaveBeenCalled());
    expect(JSON.stringify(warning.mock.calls[0])).toMatch(/a plan nobody read/);
    expect(h.settings.updateRunSettings).not.toHaveBeenCalled();

    warning.mockReset().mockImplementation(async (...args: unknown[]) => args.at(-1));
    h.chat.messages.fire({ type: 'changeSettings', change: { run } });
    await vi.waitFor(() => expect(h.settings.updateRunSettings).toHaveBeenCalledWith(run));
  });

  it('does not accept a delegation budget while delegation is not offered, and saves the rest of the change', async () => {
    delegation.offered = false;
    h.chat.messages.fire({ type: 'changeSettings', change: { run: { delegationTokens: 5000000, supervisorLevel: 'off' } } });

    await vi.waitFor(() => expect(h.settings.updateRunSettings).toHaveBeenCalledWith({ supervisorLevel: 'off' }));
    expect(warning).not.toHaveBeenCalled();
    expect(h.settings.getRunSettings().delegationTokens).toBe(0);
  });

  it('saves the parallel limit, and refuses one below 1', async () => {
    h.chat.messages.fire({ type: 'changeSettings', change: { maxParallel: 0 } });
    await vi.waitFor(() => expect(h.chat.provider.setRunSettings).toHaveBeenCalled());
    expect(h.config.config.update).not.toHaveBeenCalledWith('maxParallelSessions', expect.anything());

    h.chat.messages.fire({ type: 'changeSettings', change: { maxParallel: 17 } });
    await vi.waitFor(() => expect(h.config.config.update).toHaveBeenCalledWith('maxParallelSessions', 17));
  });

  it('pushes the parallel limit whenever the configuration changes (the Settings panel, settings.json)', async () => {
    await h.config.config.update('maxParallelSessions', 9);
    for (const listener of h.config.listeners) listener();

    expect(lastPush()).toEqual([true, RUN_SETTINGS_DEFAULTS, 9]);
  });
});

/**
 * The Run block speaks for the window's own session (ADR-0030), not for the
 * settings file another window may have just saved.
 */
describe("the Run block speaks for this window's session", () => {
  let h: ReturnType<typeof harness>;
  const lastPush = () => h.chat.provider.setRunSettings.mock.calls.at(-1);

  afterEach(() => {
    h.host.dispose();
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  it("shows the session's own run settings, not a later save another window made to the file", async () => {
    h = harness();
    h.session.setRunSettings({ ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'watch', autorun: false });
    h.session.spies.planState = planWithOneTask('build it');
    await h.host.start();
    // Another window turned the supervisor to Act; this one keeps what it opened with.
    h.settings.getRunSettings.mockReturnValue({ ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act', autorun: true });
    h.chat.provider.setRunSettings.mockClear();

    h.chat.messages.fire({ type: 'ready' });

    expect(lastPush()).toEqual([true, { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'watch', autorun: false }, 2]);
  });

  it("pushes the restored session's values as soon as the window starts", async () => {
    h = harness();
    h.session.setRunSettings({ ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act' });
    h.session.spies.planState = planWithOneTask('restore me');

    await h.host.start();

    expect(lastPush()).toEqual([true, { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act' }, 2]);
  });

  it('shows the file while no session is open, which is what the next one opens with', async () => {
    h = harness();
    // The session this window would open keeps the values it was seeded with,
    // but no plan has been adopted yet.
    h.session.setRunSettings({ ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act', autorun: true });
    await h.host.start();
    h.settings.getRunSettings.mockReturnValue({ ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', mergeAtGatesAutomatically: true });
    h.chat.provider.setRunSettings.mockClear();

    h.chat.messages.fire({ type: 'ready' });

    expect(lastPush()).toEqual([true, { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', mergeAtGatesAutomatically: true }, 2]);
  });

  it("starts the next session from the file values the bare welcome showed", async () => {
    h = harness();
    await h.host.start();
    // Another window saved these while this one had no session open.
    h.settings.getRunSettings.mockReturnValue({ ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act', autorun: true });
    h.chat.messages.fire({ type: 'ready' });

    // The same window starts its first plan: the Run block and the session agree.
    h.session.spies.planState = planWithOneTask('build it');
    h.chat.provider.setRunSettings.mockClear();
    h.chat.messages.fire({ type: 'ready' });

    expect(lastPush()).toEqual([true, { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act', autorun: true }, 2]);
  });

  it("keeps another window's session on its own values when this one saves a change", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-run-settings-'));
    const file = new SettingsService(path.join(dir, 'settings.json'));
    const other = harness({ settingsService: file });
    h = harness({ settingsService: file });
    try {
      h.session.setRunSettings({ ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'watch', autorun: false });
      h.session.spies.planState = planWithOneTask('build a parser');
      other.session.setRunSettings({ ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act', autorun: true });
      other.session.spies.planState = planWithOneTask('build a ledger');
      await h.host.start();
      await other.host.start();
      h.chat.provider.setRunSettings.mockClear();
      other.chat.provider.setRunSettings.mockClear();

      h.chat.messages.fire({ type: 'changeSettings', change: { run: { supervisorLevel: 'off' } } });
      await vi.waitFor(() => expect(h.chat.provider.setRunSettings).toHaveBeenCalled());

      expect(lastPush()).toEqual([true, { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, 2]);
      // The change is the file's too, so the next session opened anywhere starts from it.
      expect(new SettingsService(path.join(dir, 'settings.json')).getRunSettings().supervisorLevel).toBe('off');

      // The other window did not change: it shows its own session, and its own
      // copy is unchanged even though the file moved under it.
      other.chat.messages.fire({ type: 'ready' });
      expect(other.chat.provider.setRunSettings.mock.calls.at(-1)).toEqual([
        true, { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act', autorun: true }, 2,
      ]);
      expect(other.session.spies.applyRunSettings).not.toHaveBeenCalled();
    } finally {
      other.host.dispose();
      fs.rmSync(other.workspace, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the task skill chips in a repo group', () => {
  let h: ReturnType<typeof harness>;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-host-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    h = harness();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(h.workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('offers a task skill committed inside a repo of the group, as a spawn there reads it', async () => {
    const skill = path.join(h.workspace, 'api', '.ordewell', 'skills', 'api-check');
    fs.mkdirSync(path.join(h.workspace, 'api', '.git'), { recursive: true });
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: api-check\ndescription: Checks the API\napplies-to: task\n---\n\nbody');

    await h.host.start();

    expect(h.chat.provider.setTaskSkills).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ name: 'api-check', description: 'Checks the API' }]),
    );
  });
});

/** The chat as VS Code hosts it, on a webview that can be reloaded: what it was sent, and a way to talk back. */
function liveChat() {
  const provider = new RealChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  const posted: HostToWebview[] = [];
  let receive: (msg: WebviewToHost) => void = () => {};
  const open = (): void => {
    provider.resolveWebviewView({
      show: vi.fn(),
      onDidDispose: () => ({ dispose() {} }),
      webview: {
        options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u: unknown) => u,
        onDidReceiveMessage: (fn: (msg: WebviewToHost) => void) => { receive = fn; return { dispose() {} }; },
        postMessage: (msg: HostToWebview) => { posted.push(msg); return Promise.resolve(true); },
      },
    } as unknown as vscode.WebviewView, {} as never, {} as never);
  };
  open();
  return {
    provider,
    /** Everything the host has posted to the webview, in order. */
    posted,
    /** The webview is torn down and comes back, as on a window reload: it says `ready`. */
    reload: () => { open(); receive({ type: 'ready' }); },
    send: (msg: WebviewToHost) => receive(msg),
    cards: () => provider.conversation.blocks.flatMap((b) => (b.type === 'approval' ? [[b.approvalId, b.status]] : [])),
  };
}

describe('a chat webview reloaded while the planner waits for an answer', () => {
  let h: ReturnType<typeof harness>;
  let chat: ReturnType<typeof liveChat>;
  let approvals: PendingApprovals;
  let announced: Map<string, ApprovalRequestMessage>;
  let resolveApproval: ReturnType<typeof vi.fn<(id: string, granted: boolean) => boolean>>;

  beforeEach(async () => {
    chat = liveChat();
    h = harness({ chatProvider: chat.provider });
    await h.host.start();
    // The Session's own approval record, announcing on the broadcast seam the host listens to.
    announced = new Map();
    approvals = new PendingApprovals({
      onRequest: ({ id, request }) => {
        const message: ApprovalRequestMessage = { type: 'approval_request', id, kind: request.kind, subject: request.subject, scope: approvalScopes(request).join(', ') };
        announced.set(id, message);
        h.sessionDeps.current!.broadcast(message);
      },
      onSettled: (id, granted) => {
        announced.delete(id);
        h.sessionDeps.current!.broadcast({ type: 'approval_settled', id, granted });
      },
    });
    resolveApproval = vi.fn((id: string, granted: boolean) => approvals.resolve(id, granted));
    Object.assign(h.session.spies, {
      outstandingApprovals: () => approvals.outstanding(),
      resolveApproval,
      announcedApprovals: () => [...announced.values()],
    });
  });
  afterEach(() => {
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  const startAsked = () => approvals.ask({ kind: 'task_start', subject: 'Start #3 "Add a cache"', scope: 'task_start', detail: 'Approves #3' } as never, { noTimeout: true });

  it('keeps the card of a request still waiting, answerable from the new webview', async () => {
    const answer = startAsked();
    const [{ id }] = approvals.outstanding();
    expect(chat.cards()).toEqual([[id, 'pending']]);

    chat.reload();

    expect(chat.cards()).toEqual([[id, 'pending']]);
    chat.send({ type: 'resolveApproval', id, granted: true });
    await expect(answer).resolves.toBe(true);
  });

  it('drops the card of a request answered elsewhere while the webview was away, and does not answer it again', async () => {
    const answer = startAsked();
    const [{ id }] = approvals.outstanding();
    approvals.resolve(id, false);

    chat.reload();
    expect(chat.cards()).toEqual([]);
    // A click the old webview still sent arrives late: the request is already settled.
    chat.send({ type: 'resolveApproval', id, granted: true });

    await expect(answer).resolves.toBe(false);
    expect(resolveApproval).toHaveReturnedWith(false);
    expect(chat.cards()).toEqual([]);
  });
});

describe('the host\'s one account-limit monitor', () => {
  let h: ReturnType<typeof harness>;
  let reads: number;
  let monitor: AccountLimitMonitor;
  const reading: AccountLimitReading = {
    kind: 'limits', owner: 'alice', plan: 'plus',
    buckets: [{ id: 'codex', windows: [{ slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: null }] }],
  };

  beforeEach(() => {
    reads = 0;
    const codex: AccountLimitCollector = {
      harness: 'codex', label: 'Codex', scope: () => 'home',
      acquire: async () => { reads++; return reading; },
    };
    monitor = new AccountLimitMonitor({ collectors: [codex] });
    h = harness({ accountLimits: monitor });
  });
  afterEach(() => {
    h.host.dispose();
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  it('reads the account at start, before any planner call, and draws it in the planner footer', async () => {
    await h.host.start();

    await vi.waitFor(() => expect(h.chat.provider.setAccountLimits).toHaveBeenCalledWith([
      expect.objectContaining({ harness: 'codex', status: 'fresh', plan: 'plus' }),
    ]));
    expect(reads).toBe(1);
    expect(h.session.spies.startPlanning).not.toHaveBeenCalled();
  });

  it('asks again when the webview connects, the configuration changes and the window regains focus, and folds model calls into the next poll', async () => {
    const refresh = vi.spyOn(monitor, 'refresh');
    const connected = vi.spyOn(monitor, 'surfaceConnected');
    const invalidate = vi.spyOn(monitor, 'invalidate');
    const foreground = vi.spyOn(monitor, 'setForeground');
    await h.host.start();
    refresh.mockClear();

    h.chat.messages.fire({ type: 'ready' });
    expect(connected).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    for (const listener of h.config.listeners) listener();
    expect(refresh).toHaveBeenCalledTimes(1);
    h.sessionDeps.current?.broadcast({ type: 'planner_usage', turnId: 't', totals: { inputTokens: 1 } });
    expect(invalidate).toHaveBeenLastCalledWith();
    Object.assign(h.session.spies, { planTasks: [createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'codex' })] });
    h.sessionDeps.current?.broadcast({ type: 'task_log', taskId: 't1', attempt: 1, events: [{ type: 'turn_end', reason: 'completed' }] });
    expect(invalidate).toHaveBeenLastCalledWith('codex');
    expect(refresh).toHaveBeenCalledTimes(1);

    h.vscodeApi.focus(false);
    expect(foreground).toHaveBeenLastCalledWith(false);
    h.vscodeApi.focus(true);
    expect(foreground).toHaveBeenLastCalledWith(true);
  });

  it('gives an open task log only its runner\'s limits, from the same monitor', async () => {
    await h.host.start();
    await vi.waitFor(() => expect(monitor.snapshots()[0].status).toBe('fresh'));
    __resetPanels();
    const task = createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'codex', attempted: true });
    Object.assign(h.session.spies, { planTasks: [task], taskLogAttempts: () => [], taskLog: () => [], outstandingApprovals: () => [] });

    h.chat.messages.fire({ type: 'openTaskLog', taskId: 't1' });
    await vi.waitFor(() => expect(__panels).toHaveLength(1));
    __panels[0].__receive({ type: 'ready' });

    const sent = __panels[0].webview.postMessage.mock.calls.map((call) => call[0] as { type: string; limits?: unknown });
    expect(sent.filter((m) => m.type === 'accountLimits')).toEqual([
      { type: 'accountLimits', limits: [expect.objectContaining({ harness: 'codex', status: 'fresh' })] },
    ]);
  });

  it('closes the monitor with the host, so nothing reads or draws after', async () => {
    await h.host.start();
    await vi.waitFor(() => expect(h.chat.provider.setAccountLimits).toHaveBeenCalled());
    const dispose = vi.spyOn(monitor, 'dispose');

    h.host.dispose();
    monitor.refresh();

    expect(dispose).toHaveBeenCalled();
    expect(reads).toBe(1);
  });
});


/**
 * A pill click in the chat header is the user's choice of runners, so it has to
 * reach the one saved list every surface and every planner turn reads
 * (ADR-0043). Driven from the webview's message through the real router, host,
 * settings file and Session; only the planner's model is a fake.
 */
describe('a runner pill click persists to the one saved list', () => {
  const ALL = ['claude-code', 'codex', 'opencode'];
  const ALLOWED = ['claude-code', 'opencode'];
  const ctx = { signal: new AbortController().signal };
  const dirs: string[] = [];
  const hosts: Array<ReturnType<typeof harness>> = [];

  afterEach(() => {
    for (const h of hosts.splice(0)) { h.host.dispose(); fs.rmSync(h.workspace, { recursive: true, force: true }); }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A planner whose turns answer at once, keeping the tools its latest turn was handed. */
  function plannerModel() {
    let live = false;
    let handler: NonNullable<ConversationRequest['plannerTools']>['handler'] | undefined;
    const reply: ConversationTurn = { kind: 'message', text: 'ok', researchLog: [] };
    const service = {
      startConversation: vi.fn(async (req: ConversationRequest) => { live = true; handler = req.plannerTools?.handler; return reply; }),
      continueConversation: vi.fn(async () => reply),
      hasActiveConversation: () => live,
      plannerToolsAttached: () => true,
      reset: vi.fn(() => { live = false; }),
      restart: vi.fn(),
    };
    const tools = () => handler!;
    return {
      service,
      listRunners: async () => (JSON.parse((await tools().listRunners!({}, ctx)).text) as { runners: Array<{ id: string }> }).runners.map((r) => r.id),
      listModels: (runner: string) => tools().listModels!({ runner }, ctx),
    };
  }

  /** A Session over `deps` that reads `settings` as a window of the host would, with `planner` as its model. */
  const sessionOver = (deps: SessionDeps, settings: SettingsService, planner: ReturnType<typeof plannerModel>) => createSession({
    ...deps,
    // The host's fake config knows no repositories; the Session lists them to lay out skills.
    config: Object.assign(Object.create(deps.config) as SessionDeps['config'], { workspaceRepos: [], worktreeIsolation: false }),
    settings: () => sessionRuntimeSettings(settings.getAll()),
    aiService: planner.service as never,
    saveSession: vi.fn(),
  });

  /** The host with three runners installed and all three saved on, over a temporary settings file. */
  function pillHost(options: { discovery?: Promise<void> } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pills-'));
    dirs.push(dir);
    const file = new SettingsService(path.join(dir, 'settings.json'));
    file.setEnabledRunners(ALL);
    const planner = plannerModel();
    const installation = fakeRunnerInstallation(ALL);
    if (options.discovery) {
      installation.filterInstalled.mockImplementation(async (runners: string[]) => { await options.discovery; return runners; });
    }
    const chat = liveChat();
    const h = harness({
      settingsService: file,
      chatProvider: chat.provider,
      runnerInstallation: installation,
      modelResolver: fakeResolver({ 'claude-code': models, codex: models, opencode: models }),
      sessionFactory: (deps) => sessionOver(deps, file, planner),
    });
    hosts.push(h);
    // A failed request is reported to the user through the host's notifications.
    Object.assign(h.services.notifications, { error: vi.fn() });
    Object.defineProperty(h.config.config, 'enabledRunners', { get: () => file.getEnabledRunners() ?? defaultEnabledRunners() });
    const posted = vi.spyOn(chat.provider, 'postMessage');
    let requestCount = 0;
    /** What the webview was last told about the runners: the ids it draws on. */
    const shown = (): string[] | undefined => {
      const lists = posted.mock.calls.flatMap(([msg]) => (msg.type === 'setRunners' ? [msg.runners] : []));
      return lists.at(-1)?.filter((r) => r.enabled).map((r) => r.id);
    };
    return {
      h, chat, file, planner, posted, shown,
      /** What another process reading the same file would find. */
      saved: () => new SettingsService(path.join(dir, 'settings.json')).getEnabledRunners(),
      settingsPath: path.join(dir, 'settings.json'),
      /** The webview asks for `runnerId` on or off, under a request id of its own; returns the id. */
      setRunnerEnabled: (runnerId: string, enabled: boolean, requestId = `req-${++requestCount}`): string => {
        chat.send({ type: 'setRunnerEnabled', runnerId, enabled, requestId });
        return requestId;
      },
      /** Every save acknowledgement the webview was sent, in order: the one message that settles a pill click. */
      acks: (): unknown[] => posted.mock.calls.flatMap(([msg]) => ((msg as { type: string }).type === 'runnerChoiceSaved' ? [msg] : [])),
      send: (text: string, runners: string[]) => chat.send({ type: 'sendMessage', text, runners, typed: true }),
    };
  }

  it('saves Codex off as exactly the two allowed runners, and tells the webview the list it now holds', async () => {
    const p = pillHost();
    await p.h.host.start();
    expect(p.shown()).toEqual(ALL);

    p.setRunnerEnabled('codex', false);

    await vi.waitFor(() => expect(p.saved()).toEqual(ALLOWED));
    await vi.waitFor(() => expect(p.shown()).toEqual(ALLOWED));
  });

  it('keeps Codex out of the first planning turn: list_runners drops it and list_models refuses it', async () => {
    const p = pillHost();
    await p.h.host.start();

    p.setRunnerEnabled('codex', false);
    await vi.waitFor(() => expect(p.saved()).toEqual(ALLOWED));
    p.send('build it', ALLOWED);
    await vi.waitFor(() => expect(p.planner.service.startConversation).toHaveBeenCalled());

    expect(await p.planner.listRunners()).toEqual(ALLOWED);
    expect(await p.planner.listModels('codex')).toMatchObject({ isError: true, text: expect.stringContaining('"codex" is not enabled') });
    expect(await p.planner.listModels('opencode')).not.toMatchObject({ isError: true });
  });

  it('keeps Codex out of a follow-up turn of a conversation that began with all three', async () => {
    const p = pillHost();
    await p.h.host.start();
    p.send('build it', ALL);
    await vi.waitFor(() => expect(p.planner.service.startConversation).toHaveBeenCalled());
    expect(await p.planner.listRunners()).toEqual(ALL);

    p.setRunnerEnabled('codex', false);
    await vi.waitFor(() => expect(p.saved()).toEqual(ALLOWED));
    p.send('add a follow-up task', ALLOWED);
    await vi.waitFor(() => expect(p.planner.service.continueConversation).toHaveBeenCalled());

    expect(await p.planner.listRunners()).toEqual(ALLOWED);
    expect(await p.planner.listModels('codex')).toMatchObject({ isError: true });
  });

  it('is read by a second consumer of the same workspace\'s settings file, a Session of its own', async () => {
    const p = pillHost();
    await p.h.host.start();
    const second = plannerModel();
    const secondSession = sessionOver(p.h.sessionDeps.current!, new SettingsService(p.settingsPath), second);
    await secondSession.startPlanning('goal', ALL);
    expect(await second.listRunners()).toEqual(ALL);

    p.setRunnerEnabled('codex', false);

    await vi.waitFor(async () => expect(await second.listRunners()).toEqual(ALLOWED));
    expect(await second.listModels('codex')).toMatchObject({ isError: true });
  });

  it('says the same thing twice with the same result: the request names a state, it does not flip one', async () => {
    const p = pillHost();
    await p.h.host.start();

    p.setRunnerEnabled('codex', false);
    p.setRunnerEnabled('codex', false);

    await vi.waitFor(() => expect(p.saved()).toEqual(ALLOWED));
    p.setRunnerEnabled('codex', false);
    p.setRunnerEnabled('opencode', true);
    await vi.waitFor(() => expect(p.shown()).toEqual(ALLOWED));
    expect(p.saved()).toEqual(ALLOWED);
  });

  it('does not bring back a runner another surface switched off since the webview last drew', async () => {
    const p = pillHost();
    await p.h.host.start();
    // The terminal UI switched Codex off; this webview has not heard yet and asks for the same.
    p.file.updateEnabledRunners((saved) => (saved ?? ALL).filter((r) => r !== 'codex'));

    p.setRunnerEnabled('codex', false);
    p.setRunnerEnabled('opencode', false);

    await vi.waitFor(() => expect(p.saved()).toEqual(['claude-code']));
  });

  it('refuses to switch off the last saved runner, whatever the webview thought it held', async () => {
    const p = pillHost();
    await p.h.host.start();
    p.file.setEnabledRunners(['claude-code']);
    p.posted.mockClear();

    p.setRunnerEnabled('claude-code', false);

    await vi.waitFor(() => expect(p.shown()).toEqual(['claude-code']));
    expect(p.saved()).toEqual(['claude-code']);
  });

  it('writes no id that is not a runner into the shared file', async () => {
    const p = pillHost();
    await p.h.host.start();

    p.setRunnerEnabled('no-such-agent', true);
    p.setRunnerEnabled('no-such-agent', false);
    p.setRunnerEnabled('codex', false);

    await vi.waitFor(() => expect(p.saved()).toEqual(ALLOWED));
    expect(p.saved()).not.toContain('no-such-agent');
  });

  it('survives discovery that finishes after the click: the saved choice stands and the late list shows it', async () => {
    let finishDiscovery!: () => void;
    const p = pillHost({ discovery: new Promise<void>((resolve) => { finishDiscovery = resolve; }) });
    const starting = p.h.host.start();

    p.setRunnerEnabled('codex', false);
    finishDiscovery();
    await starting;

    await vi.waitFor(() => expect(p.saved()).toEqual(ALLOWED));
    await vi.waitFor(() => expect(p.shown()).toEqual(ALLOWED));
  });

  it('puts the webview back on the saved list when the save is rejected, leaving the file as it was', async () => {
    const p = pillHost();
    await p.h.host.start();
    vi.spyOn(p.file, 'updateEnabledRunners').mockImplementation(() => { throw new Error('EACCES: settings file is read-only'); });
    p.posted.mockClear();

    p.setRunnerEnabled('codex', false);

    await vi.waitFor(() => expect(p.shown()).toEqual(ALL));
    expect(p.saved()).toEqual(ALL);
  });

  // The webview keeps a pill click until the host answers that request by id,
  // so a runner list alone, however late, can neither settle it nor undo it.
  describe('acknowledges each request by its id with the saved state of that runner', () => {
    it('answers a saved click with the request id, the runner, and the state the file now holds', async () => {
      const p = pillHost();
      await p.h.host.start();

      const id = p.setRunnerEnabled('codex', false);

      await vi.waitFor(() => expect(p.acks()).toEqual([{ type: 'runnerChoiceSaved', requestId: id, runnerId: 'codex', enabled: false }]));
      expect(p.saved()).toEqual(ALLOWED);
    });

    it('answers a rejected save with the state the file still holds, so the pill can go back', async () => {
      const p = pillHost();
      await p.h.host.start();
      vi.spyOn(p.file, 'updateEnabledRunners').mockImplementation(() => { throw new Error('EACCES: settings file is read-only'); });

      const id = p.setRunnerEnabled('codex', false);

      await vi.waitFor(() => expect(p.acks()).toEqual([{ type: 'runnerChoiceSaved', requestId: id, runnerId: 'codex', enabled: true }]));
      expect(p.saved()).toEqual(ALL);
    });

    it('answers a refused switch-off of the last saved runner with that runner still on', async () => {
      const p = pillHost();
      await p.h.host.start();
      p.file.setEnabledRunners(['claude-code']);

      const id = p.setRunnerEnabled('claude-code', false);

      await vi.waitFor(() => expect(p.acks()).toEqual([{ type: 'runnerChoiceSaved', requestId: id, runnerId: 'claude-code', enabled: true }]));
    });

    it('answers an id that names no runner with it off, and writes nothing', async () => {
      const p = pillHost();
      await p.h.host.start();

      const id = p.setRunnerEnabled('no-such-agent', true);

      await vi.waitFor(() => expect(p.acks()).toEqual([{ type: 'runnerChoiceSaved', requestId: id, runnerId: 'no-such-agent', enabled: false }]));
      expect(p.saved()).toEqual(ALL);
    });

    it('answers a repeated request with an acknowledgement of its own, not the first one\'s', async () => {
      const p = pillHost();
      await p.h.host.start();

      const first = p.setRunnerEnabled('codex', false);
      const again = p.setRunnerEnabled('codex', false);

      await vi.waitFor(() => expect(p.acks()).toHaveLength(2));
      expect(p.acks()).toEqual([
        { type: 'runnerChoiceSaved', requestId: first, runnerId: 'codex', enabled: false },
        { type: 'runnerChoiceSaved', requestId: again, runnerId: 'codex', enabled: false },
      ]);
    });

    it('answers two runners\' requests each under its own id', async () => {
      const p = pillHost();
      await p.h.host.start();

      const codex = p.setRunnerEnabled('codex', false);
      const opencode = p.setRunnerEnabled('opencode', false);

      await vi.waitFor(() => expect(p.acks()).toHaveLength(2));
      expect(p.acks()).toEqual([
        { type: 'runnerChoiceSaved', requestId: codex, runnerId: 'codex', enabled: false },
        { type: 'runnerChoiceSaved', requestId: opencode, runnerId: 'opencode', enabled: false },
      ]);
      expect(p.saved()).toEqual(['claude-code']);
    });
  });
});


describe('the repositories and branches the startup view shows', () => {
  let h: ReturnType<typeof harness>;
  let reads: Array<{ root: string; answer: (preview: IsolationPreview) => void }>;
  const ready = (branch: string): IsolationPreview => ({
    status: 'ready', shared: [], repos: [{ path: '.', head: { kind: 'branch', branch, commit: 'a1b2c3d' }, dirty: false }],
  });
  const sent = () => h.chat.provider.setIsolationPreview.mock.calls.map(([preview]) => preview);

  beforeEach(() => {
    reads = [];
    h = harness({
      isolationPreview: { preview: (root) => new Promise((resolve) => { reads.push({ root, answer: resolve }); }) },
    });
  });
  afterEach(() => {
    h.host.dispose();
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  it('is read for the workspace at start without holding the start up, and sent once git has answered', async () => {
    await h.host.start();

    expect(reads.map((r) => r.root)).toEqual([h.workspace]);
    expect(sent()).toEqual([]);

    reads[0].answer(ready('main'));
    await vi.waitFor(() => expect(sent()).toEqual([ready('main')]));
  });

  it('does not hold the model discovery or the composer behind git either', async () => {
    await h.host.start();

    // Discovery has finished and the first screen's other state is out, with git still unanswered.
    expect(h.chat.provider.setModelsByRunner).toHaveBeenCalled();
    expect(reads).toHaveLength(1);
  });

  it('starts over when the webview connects: the old answer is cleared, then the current one sent', async () => {
    await h.host.start();
    reads[0].answer(ready('main'));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));

    h.chat.messages.fire({ type: 'ready' });

    expect(sent()).toEqual([ready('main'), null]);
    expect(reads).toHaveLength(2);
    reads[1].answer(ready('feature'));
    await vi.waitFor(() => expect(sent()).toEqual([ready('main'), null, ready('feature')]));
  });

  it.each([
    ['the configuration changes', (hh: typeof h) => { for (const listener of hh.config.listeners) listener(); }],
    ['the window regains focus', (hh: typeof h) => { hh.vscodeApi.focus(false); hh.vscodeApi.focus(true); }],
  ])('is read again when %s, replacing the branch shown without blanking it first', async (_when, trigger) => {
    await h.host.start();
    reads[0].answer(ready('main'));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));

    trigger(h);

    expect(reads).toHaveLength(2);
    reads[1].answer(ready('feature'));
    await vi.waitFor(() => expect(sent()).toEqual([ready('main'), ready('feature')]));
  });

  it('does not read when the window loses focus', async () => {
    await h.host.start();

    h.vscodeApi.focus(false);

    expect(reads).toHaveLength(1);
  });

  it('drops the previous workspace\'s answer when the folders change, and a late reply from it never shows', async () => {
    await h.host.start();
    reads[0].answer(ready('main'));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-host-other-'));
    try {
      // The first read is still out when the folders change.
      h.vscodeApi.foldersChanged();
      expect(sent()).toEqual([ready('main'), null]);
      vi.spyOn(h.services.fsAdapter, 'getWorkspaceRoot').mockReturnValue(other);
      h.vscodeApi.foldersChanged();
      expect(reads.map((r) => r.root)).toEqual([h.workspace, h.workspace, other]);

      reads[1].answer(ready('old-workspace-branch'));
      await Promise.resolve();
      expect(sent()).toEqual([ready('main'), null, null]);
      reads[2].answer(ready('other-branch'));
      await vi.waitFor(() => expect(sent()).toEqual([ready('main'), null, null, ready('other-branch')]));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('shows the newest read when an older one answers last', async () => {
    await h.host.start();
    h.vscodeApi.focus(true);
    expect(reads).toHaveLength(2);

    reads[1].answer(ready('newer'));
    await vi.waitFor(() => expect(sent()).toEqual([ready('newer')]));
    reads[0].answer(ready('older'));
    await Promise.resolve();

    expect(sent()).toEqual([ready('newer')]);
  });

  it('is sent as a failed read, never as no repository, when the look itself rejects', async () => {
    h.host.dispose();
    h = harness({ isolationPreview: { preview: () => Promise.reject(new Error('git exploded')) } });

    await h.host.start();

    await vi.waitFor(() => expect(sent()).toEqual([{ status: 'failed', repos: [], shared: [], error: 'git exploded' }]));
  });

  it('is not asked for when the host has no isolation look to give', async () => {
    const plain = harness();

    await plain.host.start();

    expect(plain.chat.provider.setIsolationPreview).not.toHaveBeenCalled();
    plain.host.dispose();
    fs.rmSync(plain.workspace, { recursive: true, force: true });
  });
});

describe('the repositories notice on a webview that is reloaded', () => {
  it('reaches the reloaded webview as null, then the current answer', async () => {
    const chat = liveChat();
    const answers: Array<(p: IsolationPreview) => void> = [];
    const h = harness({ chatProvider: chat.provider, isolationPreview: { preview: () => new Promise((resolve) => { answers.push(resolve); }) } });
    try {
      await h.host.start();
      const preview: IsolationPreview = { status: 'no-repo', repos: [], shared: [] };
      answers[0](preview);
      await vi.waitFor(() => expect(chat.posted).toContainEqual({ type: 'isolationPreview', preview }));
      chat.posted.length = 0;

      chat.reload();
      answers[1]({ status: 'disabled', repos: [], shared: [] });

      await vi.waitFor(() => expect(chat.posted.filter((m) => m.type === 'isolationPreview')).toEqual([
        { type: 'isolationPreview', preview: null },
        { type: 'isolationPreview', preview: { status: 'disabled', repos: [], shared: [] } },
      ]));
    } finally {
      h.host.dispose();
      fs.rmSync(h.workspace, { recursive: true, force: true });
    }
  });
});
