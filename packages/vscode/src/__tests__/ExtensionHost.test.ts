import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  createTask, RunnerRegistry,
  type AiProvider, type DiscoveredModel, type LegacyPlanState,
  type ModelResolver, type PlannerModelMemory, type RunnerInstallation,
  type Session, type SessionDeps, type SettingsService,
} from '@ordewell/core';
import { createExtension, type ExtensionServices } from '../ExtensionHost';
import type { ChatViewProvider } from '../providers/ChatViewProvider';
import type { SecretStore, ApiProvider } from '../adapters/SecretStore';
import type { VsCodeConfig } from '../adapters/VsCodeConfig';
import type { VsCodeFileSystem } from '../adapters/VsCodeFileSystem';
import type { VsCodeNotification } from '../adapters/VsCodeNotification';
import type { VsCodeTerminalRunner } from '../adapters/VsCodeTerminalRunner';
import type { WebviewToHost } from '../shared/protocol';
import { __panels, __resetPanels } from '../test/vscode.mock';

const models: DiscoveredModel[] = [
  { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [], runnerProvider: 'anthropic' },
];

function planWithOneTask(goal: string): LegacyPlanState {
  const at = '2026-01-01T00:00:00Z';
  return {
    tasks: [createTask({ id: 't1', order: 1, title: goal, prompt: goal, assignedRunner: 'claude-code', taskMode: 'default' })],
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
      nextPrompt: vi.fn(() => undefined), stop: vi.fn(), reset: vi.fn(), reload: vi.fn(), resync: vi.fn(),
    },
    resendAllState: vi.fn(),
    restoreChat: vi.fn(),
    replaceConversation: vi.fn(),
    setState: vi.fn(),
    showError: vi.fn(),
    showPlan: vi.fn(),
    planGenerated: vi.fn(),
    planApproved: vi.fn(),
    setPlanDockHeight: vi.fn(),
    setSkills: vi.fn(),
    setTaskSkills: vi.fn(),
    setModels: vi.fn(),
    setModelsByRunner: vi.fn(),
    setRunnerList: vi.fn(),
    setEnabledRunnerIds: vi.fn(),
    setModesByRunner: vi.fn(),
    sendConfiguredProviders: vi.fn(),
    setModelConfig: vi.fn(),
    setModelOptions: vi.fn(),
    setModelDiscoveryErrors: vi.fn(),
    setPlannerBackends: vi.fn(),
    showPendingPlanEdits: vi.fn(),
    clearIsolationHandoff: vi.fn(),
    sendTaskIdle: vi.fn(),
    sendTaskIsolation: vi.fn(),
    sendTaskOutput: vi.fn(),
    showCheckpoint: vi.fn(),
    showIsolationHandoff: vi.fn(),
    showIsolationMergeResult: vi.fn(),
    reveal: vi.fn(),
  };
  return { messages, provider };
}

function fakeVscodeApi() {
  const showWarningMessage = vi.fn();
  const api = {
    window: {
      registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
      showWarningMessage,
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showInputBox: vi.fn(),
      createQuickPick: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    },
    workspace: {
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
    },
    QuickInputButtons: { Back: {} },
    ProgressLocation: { Notification: 15 },
  };
  return { api: api as unknown as typeof vscode, showWarningMessage };
}

function fakeConfig() {
  const listeners: Array<() => void> = [];
  const values: Record<string, unknown> = {
    aiProvider: 'openrouter',
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
    get apiKey() { return values.apiKey as string; },
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
  return { config: config as unknown as VsCodeConfig, listeners };
}

function fakeSession() {
  const spies = {
    sessionId: 's1',
    aiServiceInstance: { reset: vi.fn() },
    reschedule: vi.fn(async () => {}),
    isExecuting: false,
    isConversationActive: false,
    isPlannerBusy: false,
    status: 'draft',
    planState: null,
    planTasks: [],
    isolationView: vi.fn(() => null),
    getQueuedMessages: vi.fn(() => []),
    setQueuedMessages: vi.fn(),
    removeQueuedMessage: vi.fn(),
    reset: vi.fn(),
    loadPlan: vi.fn(),
    executePlan: vi.fn(async () => {}),
    stopExecution: vi.fn(),
    startPlanning: vi.fn(async (goal: string) => planWithOneTask(goal)),
    continueConversation: vi.fn(async () => planWithOneTask('continued')),
    cancelTask: vi.fn(async () => {}),
    retryTask: vi.fn(async () => {}),
    markTaskComplete: vi.fn(async () => {}),
    markTaskIncomplete: vi.fn(async () => {}),
    forceStartTask: vi.fn(async () => {}),
    runTask: vi.fn(async () => {}),
  };
  return { session: spies as unknown as Session, spies };
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
  };
}

function fakeRunnerInstallation(installed: string[]) {
  return {
    filterInstalled: vi.fn(async (runners: string[]) => runners.filter((r) => installed.includes(r))),
    plannerUsability: vi.fn(async () => ({ usable: true, reason: undefined })),
  };
}

function fakeSettings() {
  return {
    getAll: vi.fn(() => ({})),
  };
}

function harness(overrides: {
  modelResolver?: ReturnType<typeof fakeResolver>;
  runnerInstallation?: ReturnType<typeof fakeRunnerInstallation>;
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

  const services: ExtensionServices = {
    context: { subscriptions: [], extensionUri: { toString: () => 'file:///ext' }, globalState } as unknown as vscode.ExtensionContext,
    outputChannel: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    secretStore: { set: vi.fn(), get: vi.fn() } as unknown as SecretStore,
    config: config.config,
    runnerRegistry,
    runnerInstallation: installation as unknown as RunnerInstallation,
    fsAdapter: { getWorkspaceRoot: () => workspace } as unknown as VsCodeFileSystem,
    notifications: {} as unknown as VsCodeNotification,
    terminalRunner: { stopAll: vi.fn() } as unknown as VsCodeTerminalRunner,
    settingsService: settings as unknown as SettingsService,
    plannerModelMemory: { remember: vi.fn(), recall: vi.fn(() => ({ model: '', effort: '', source: 'default' })) } as unknown as PlannerModelMemory,
    modelResolver: resolver as unknown as ModelResolver,
    chatProvider: chat.provider as unknown as ChatViewProvider,
    sessionFactory: (deps) => { sessionDeps.current = deps; return session.session; },
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

  it("hands the session this window's enabled runners, read at each call", async () => {
    h.settings.getAll.mockReturnValue({ enabledRunners: ['opencode'] });
    await h.config.config.update('enabledRunners', ['claude-code', 'codex']);

    expect(h.sessionDeps.current?.settings().enabledRunners).toEqual(['claude-code', 'codex']);
  });

  it('registers the webview, the host commands and the webview listener through the given vscode api', async () => {
    await h.host.start();

    expect(h.vscodeApi.api.window.registerWebviewViewProvider).toHaveBeenCalledWith('ordewellChatView', h.chat.provider, expect.anything());
    expect(h.vscodeApi.api.commands.registerCommand).toHaveBeenCalledWith('ordewell.setPlanner', expect.any(Function));
    expect(h.vscodeApi.api.commands.registerCommand).toHaveBeenCalledWith('ordewell.setMaxParallel', expect.any(Function));
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
    await vi.waitFor(() => expect(h.chat.provider.setPlannerBackends).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'claude-code', usable: true })]),
      'openrouter', undefined, '',
    ));
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

  it('resets the AI service, invalidates the resolver and reschedules on a config change', async () => {
    await h.host.start();
    h.resolver.invalidate.mockClear();
    h.resolver.refreshRunnerModels.mockClear();

    for (const listener of h.config.listeners) listener();

    expect(h.session.spies.reschedule).toHaveBeenCalled();
    expect(h.session.spies.aiServiceInstance.reset).toHaveBeenCalled();
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
    await vi.waitFor(() => expect(h.session.spies.executePlan).toHaveBeenCalled());
    expect(h.session.spies.loadPlan).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
      'build a parser',
      h.services.fsAdapter.getWorkspaceRoot(),
    );

    h.chat.messages.fire({ type: 'sendSystemCommand', command: 'cancel', taskId: 't1' });
    await vi.waitFor(() => expect(h.session.spies.cancelTask).toHaveBeenCalledWith('t1'));
  });

  it('persists and stops runners on dispose', async () => {
    const stopAll = h.services.terminalRunner.stopAll as unknown as ReturnType<typeof vi.fn>;
    await h.host.start();
    h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
    await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalled());

    h.host.dispose();

    expect(stopAll).toHaveBeenCalled();
  });

  it('opens a task log tab on request, through the one registry', async () => {
    await h.host.start();
    __resetPanels();
    (h.session.spies as unknown as { planTasks: unknown[] }).planTasks = [
      createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'claude-code' }),
    ];

    h.chat.messages.fire({ type: 'openTaskLog', taskId: 't1' });

    await vi.waitFor(() => expect(__panels).toHaveLength(1));
    expect(__panels[0].viewType).toBe('ordewellTaskLog');
    expect(__panels[0].title).toBe('Task 1 · Parse JSON');
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
