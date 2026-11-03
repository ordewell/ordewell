import { afterEach, beforeEach, describe, expect, vi, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import http from 'http';
import https from 'https';
import type { AddressInfo } from 'net';
import { basename, delimiter, join } from 'path';
import type { SpawnFn } from '@ordewell/core';
import type { ChildProcess } from 'child_process';

// Load the source at runtime so the real adapter uses the process fake, while
// keeping the extension's TypeScript root limited to its own src directory.
vi.mock('@ordewell/core', () => import('../../../../core/src/' + 'index'));
const boundary = vi.hoisted(() => ({ spawn: null as SpawnFn | null }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const spawn = ((command: string, args: string[], options: Parameters<SpawnFn>[2]) =>
    boundary.spawn && basename(command) === 'claude'
      ? boundary.spawn(command, args, options)
      : actual.spawn(command, args, options)) as typeof actual.spawn;
  return { ...actual, spawn, default: { ...actual, spawn } };
});

import {
  BufferedTaskOutputSource, clearAugmentedPathCache, createEmptyPlan, createSession, createTask,
  detectInstalledPlanner, getProviderMeta, PROVIDER_DETECT_PRIORITY, recordInstalledPlanner, resetInstalledPlanner,
  RUN_SETTINGS_DEFAULTS, RunnerRegistry, SettingsService, PlannerModelMemory, type LegacyPlanState, type ModelResolver, type PlannerUsability, type IRunner,
} from '@ordewell/core';
import { fakeFileSystem, flushMicrotasks } from '@ordewell/core/testing';
import { __resetConfig, __setConfig } from '../../test/vscode.mock';
import { VsCodeConfig } from '../../adapters/VsCodeConfig';
import { SecretStore } from '../../adapters/SecretStore';
import { PlannerSelection } from '../../PlannerSelection';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import type { HostToWebview } from '@ordewell/ui/protocol';
import { handleStartPlanning, handleContinueConversation, handleStopPlanning, handleSendMessageNow, type PlanManagerDeps } from '../PlanManager';

interface FakeAgentProcess extends ChildProcess { emitStdout(chunk: string): void }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((answer) => { resolve = answer; });
  return { promise, resolve };
}

// The extension's actual config and PlanManager drive a real Session and
// Claude adapter. Only host APIs, discovery, persistence and processes are fake.
describe('VS Code keyless first-run process boundary', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let argvs: string[][];
  let prompts: string[];
  let sessions: ReturnType<typeof createSession>[];
  let networks: ReturnType<typeof vi.fn>;

  let provider: http.Server;
  let providerBase: string;
  let vendorRequests: { authorization: string | undefined; body: string }[];

  beforeEach(async () => {
    env = { ...process.env };
    dir = mkdtempSync(join(tmpdir(), 'ordewell-vscode-keyless-'));
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'claude'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(dir, 'bin', 'claude'), 0o755);
    process.env.HOME = dir;
    process.env.PATH = `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? ''}`;
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    delete process.env.AI_PROVIDER;
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.ORDEWELL_PLANNER_EFFORT;
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
    }
    __resetConfig();
    vendorRequests = [];
    provider = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      vendorRequests.push({ authorization: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Which database?' }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    providerBase = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
    setConfig({});
    vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected external HTTPS request'); });
    resetInstalledPlanner();
    clearAugmentedPathCache();
    sessions = [];
    argvs = [];
    prompts = [];
    const { fakeSpawn } = await import('../../../../core/src/services/__tests__/' + 'harnessTestKit') as { fakeSpawn(replies: []): { spawn: SpawnFn } };
    const fake = fakeSpawn([]);
    boundary.spawn = (command, args, options) => {
      argvs.push(args);
      const proc = fake.spawn(command, args, options) as unknown as FakeAgentProcess;
      proc.on('__written', (chunk: string) => {
        if (!chunk.includes('"type":"user"')) return;
        prompts.push(chunk);
        const text = 'Which database?';
        proc.emitStdout([
          { type: 'assistant', session_id: 'keyless', message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text }] } },
          { type: 'result', subtype: 'success', session_id: 'keyless', is_error: false, result: text },
        ].map((frame) => JSON.stringify(frame)).join('\n') + '\n');
      });
      return proc;
    };
    const localFetch = globalThis.fetch;
    networks = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).startsWith('http://127.0.0.1:')) return localFetch(input, init);
      throw new Error(`Unexpected external request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', networks);
  });

  afterEach(async () => {
    for (const session of sessions) session.destroy();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    boundary.spawn = null;
    resetInstalledPlanner();
    clearAugmentedPathCache();
    __resetConfig();
    process.env = env;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function setConfig(values: Record<string, unknown>) {
    __setConfig({ enabledRunners: ['claude-code'], claudeCodeEnabled: true, openAiBaseUrl: providerBase, openaiBaseUrl: providerBase, ...values });
  }

  function harness(config = new VsCodeConfig()) {
    const messages: HostToWebview[] = [];
    const chatProvider = new ChatViewProvider({ toString: () => 'file:///extension' } as never);
    chatProvider.postMessage = (message) => { messages.push(message); };
    const runner: IRunner = { activeCount: 0, spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn() };
    const registry = new RunnerRegistry();
    const modelResolver = { getCachedRunnerModels: () => [], modelsForRunners: async () => ({}), plannerCatalog: async () => [] } as unknown as ModelResolver;
    const session = createSession({
      config, runner, registry, modelResolver,
      notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: async () => undefined },
      workspaceRoot: () => dir, fsAdapter: fakeFileSystem(),
      broadcast: (message) => chatProvider.conversation.receive(message),
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, autorun: true, supervisorLevel: 'off' } }),
      taskOutput: new BufferedTaskOutputSource(), saveSession: () => {},
    });
    sessions.push(session);
    let plan = createEmptyPlan();
    let goal = '';
    const deps: PlanManagerDeps = {
      session, chatProvider, modelResolver, runnerRegistry: registry, config, runner,
      fsAdapter: { getWorkspaceRoot: () => dir } as PlanManagerDeps['fsAdapter'],
      notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: async () => undefined },
      getCurrentPlan: () => plan, setCurrentPlan: (value) => { plan = value; },
      getCurrentGoal: () => goal, setCurrentGoal: (value) => { goal = value; },
      isGeneratingPlan: () => session.isPlannerBusy, persistState: () => {}, saveCurrentSession: () => null, sendRunSettings: () => {}, log: () => {},
    };
    return { deps, session, runner, messages, config };
  }

  function probe() {
    const gate = deferred<PlannerUsability>();
    const done = detectInstalledPlanner({ plannerUsability: () => gate.promise });
    return { done, answer: () => gate.resolve({ usable: true }) };
  }

  it('a goal typed before detection reaches Claude stdin with no inherited vendor model', async () => {
    setConfig({ orchestratorModel: 'openai/gpt-4o' });
    const h = harness();
    const detection = probe();
    const started = handleStartPlanning('Build a ledger', h.deps);
    expect(argvs).toEqual([]);
    detection.answer();
    await started;
    expect(h.messages.filter((m) => m.type === 'showError')).toEqual([]);
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).not.toContain('--model');
    expect(prompts[0]).toContain('Build a ledger');
    expect(h.messages.filter((m) => m.type === 'showError')).toEqual([]);
    expect(networks).not.toHaveBeenCalled();
    expect(vendorRequests).toEqual([]);
  });

  it('restores the remembered model and effort with a blank configured model', async () => {
    recordInstalledPlanner('claude-code');
    setConfig({ orchestratorModel: '', plannerThinkingEffort: 'low' });
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'high' });
    const h = harness();
    await handleStartPlanning('Build a ledger', h.deps);
    expect(h.messages.filter((m) => m.type === 'showError')).toEqual([]);
    expect(argvs).toHaveLength(1);
    expect(argvs[0][argvs[0].indexOf('--model') + 1]).toBe('sonnet');
    expect(argvs[0][argvs[0].indexOf('--effort') + 1]).toBe('high');
  });

  it('Stop cancels the waiting first goal before a process or autorun task starts', async () => {
    const h = harness();
    const detection = probe();
    const started = handleStartPlanning('Do not run this', h.deps);
    handleStopPlanning(h.deps);
    await started;
    detection.answer();
    await detection.done;
    await flushMicrotasks(100);
    expect(argvs).toEqual([]);
    expect(h.runner.spawn).not.toHaveBeenCalled();
    await handleStartPlanning('Build a ledger', h.deps);
    expect(h.messages.filter((m) => m.type === 'showError')).toEqual([]);
    expect(argvs).toHaveLength(1);
    expect(prompts[0]).toContain('Build a ledger');
    expect(prompts[0]).not.toContain('Do not run this');
  });

  function restored(): LegacyPlanState {
    const timestamp = '2026-10-10T10:00:00.000Z';
    return {
      tasks: [1, 2].map((n) => createTask({ id: `t${n}`, order: n, title: `Task ${n}`, prompt: `Implement ${n}`, assignedRunner: 'claude-code' })),
      generatedAt: timestamp, lastUpdated: timestamp, status: 'draft', runners: ['claude-code'],
      conversationHistory: [{ role: 'user', content: 'Build a ledger', timestamp }, { role: 'assistant', content: 'Which database?', timestamp }],
    };
  }

  it('Stop also cancels restored input waiting at the core gate without a host start', async () => {
    const h = harness();
    const detection = probe();
    const plan = restored();
    plan.pendingTurns = [{ id: 'pending', source: 'user', text: 'Use Postgres', timestamp: plan.lastUpdated }];
    h.session.loadPlan(plan, 'Build a ledger', dir);
    handleStopPlanning(h.deps);
    detection.answer();
    await detection.done;
    await flushMicrotasks(100);
    expect(argvs).toEqual([]);
    expect(h.runner.spawn).not.toHaveBeenCalled();
  });

  for (const action of ['start', 'force-send'] as const) {
    it(`${action} checks the selected provider's own key through PlanManager and never calls a transport`, async () => {
      setConfig({ aiProvider: 'openai', orchestratorModel: 'gpt-4o' });
      const secrets = new SecretStore({
        get: async (key: string) => key === 'openrouterKey' ? 'other-provider-key' : undefined,
        store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }),
      } as never);
      await secrets.load();
      const h = harness(new VsCodeConfig(secrets));
      if (action !== 'start') {
        const plan = restored();
        h.session.loadPlan(plan, 'Build a ledger', dir);
        h.deps.setCurrentPlan(plan);
      }
      if (action === 'start') await handleStartPlanning('Build a ledger', h.deps);
      else await handleSendMessageNow('Use Postgres', h.deps);
      expect(h.messages).toContainEqual({ type: 'showError', error: expect.stringContaining('OPENAI_API_KEY') });
      expect(argvs).toEqual([]);
      expect(networks).not.toHaveBeenCalled();
    expect(vendorRequests).toEqual([]);
      expect(h.runner.spawn).not.toHaveBeenCalled();
    });
  }
  it('credential changes reroute the same config despite its cached vendor lists', async () => {
    recordInstalledPlanner('claude-code');
    setConfig({ orchestratorModel: 'shared-model' });
    process.env.OPENROUTER_API_KEY = 'router-key';
    const h = harness();
    h.config.setProviderModelLists({ openrouter: ['shared-model'] });
    await handleStartPlanning('Build a ledger', h.deps);
    expect(h.messages.filter((m) => m.type === 'showError')).toEqual([]);
    expect(vendorRequests).toHaveLength(1);
    expect(vendorRequests[0].authorization).toBe('Bearer router-key');
    expect(argvs).toEqual([]);

    delete process.env.OPENROUTER_API_KEY;
    await handleContinueConversation('Use Postgres', h.deps);
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).not.toContain('--model');
    expect(prompts[0]).toContain('Use Postgres');
    expect(vendorRequests).toHaveLength(1);

    process.env.OPENAI_API_KEY = 'openai-key';
    await handleContinueConversation('Keep the ledger append-only', h.deps);
    expect(vendorRequests).toHaveLength(2);
    expect(vendorRequests[1].authorization).toBe('Bearer openai-key');
    expect(vendorRequests[1].body).toContain('Keep the ledger append-only');
    expect(h.messages.filter((m) => m.type === 'showError')).toEqual([]);
  });

  it('an explicit /planner pick equal to the detected agent is saved and still wins after a key appears', async () => {
    recordInstalledPlanner('claude-code');
    const h = harness();
    const selection = new PlannerSelection({
      config: h.config, modelResolver: h.deps.modelResolver,
      plannerModelMemory: new PlannerModelMemory(new SettingsService()),
      runnerInstallation: { plannerUsability: async () => ({ usable: true }) } as never,
      chatProvider: h.deps.chatProvider, sendModelConfig: () => {}, log: () => {},
    });
    await selection.apply('claude-code');
    process.env.OPENROUTER_API_KEY = 'later-key';
    await handleStartPlanning('Build a ledger', h.deps);
    expect(h.config.rawAiProvider).toBe('claude-code');
    expect(argvs).toHaveLength(1);
    expect(prompts[0]).toContain('Build a ledger');
    expect(vendorRequests).toEqual([]);
  });

  function selectionFor(h: ReturnType<typeof harness>) {
    const modelResolver = { plannerCatalog: async () => [] } as unknown as ModelResolver;
    return new PlannerSelection({
      config: h.config, modelResolver,
      plannerModelMemory: new PlannerModelMemory(new SettingsService()),
      runnerInstallation: { plannerUsability: async () => ({ usable: true }) } as never,
      chatProvider: h.deps.chatProvider, sendModelConfig: () => {}, log: () => {},
    });
  }

  it('a vendor model picked while its key was set never reaches the detected agent, and returns with the key', async () => {
    recordInstalledPlanner('claude-code');
    process.env.OPENROUTER_API_KEY = 'test-key';
    const h = harness();
    const selection = selectionFor(h);
    await selection.setModel('openai/gpt-4o');
    delete process.env.OPENROUTER_API_KEY;
    expect(h.config.aiProvider).toBe('claude-code');
    expect(h.config.orchestratorModel).toBe('');

    await handleStartPlanning('Build a ledger', h.deps);
    expect(h.messages.filter((m) => m.type === 'showError')).toEqual([]);
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).not.toContain('--model');

    await selection.pick({ effort: 'high' });
    expect(new SettingsService().getPlannerModel('claude-code')).toBeUndefined();

    process.env.OPENROUTER_API_KEY = 'test-key';
    await handleContinueConversation('Use Postgres', h.deps);
    expect(vendorRequests).toHaveLength(1);
    expect(JSON.parse(vendorRequests[0].body)).toMatchObject({ model: 'openai/gpt-4o' });
    expect(vendorRequests[0].body).toContain('Use Postgres');
  });

  for (const leftover of ['openai/gpt-4o', 'deepseek/deepseek-v4-flash']) {
    it(`a named Claude Code planner is spawned without the configured vendor model ${leftover}`, async () => {
      recordInstalledPlanner('claude-code');
      setConfig({ aiProvider: 'claude-code', orchestratorModel: leftover });
      const h = harness();
      await handleStartPlanning('Build a ledger', h.deps);
      expect(h.messages.filter((m) => m.type === 'showError')).toEqual([]);
      expect(argvs).toHaveLength(1);
      expect(argvs[0]).not.toContain('--model');
      expect(new SettingsService().getAll().plannerModels).toBeUndefined();
    });
  }

  it('a model picked for the detected agent is not sent to a vendor whose key is added later', async () => {
    recordInstalledPlanner('claude-code');
    const h = harness();
    await selectionFor(h).setModel('sonnet');
    process.env.OPENROUTER_API_KEY = 'test-key';
    expect(h.config.aiProvider).toBe('openrouter');
    expect(h.config.orchestratorModel).toBe('');

    await handleStartPlanning('Build a ledger', h.deps);
    expect(h.messages).toContainEqual({ type: 'showError', error: expect.stringContaining('No planner model selected') });
    expect(vendorRequests).toEqual([]);
    expect(argvs).toEqual([]);
  });

  it('a model picked for OpenRouter is not sent to Google when the key is swapped for a Gemini one', async () => {
    recordInstalledPlanner('claude-code');
    process.env.OPENROUTER_API_KEY = 'test-key';
    const h = harness();
    await selectionFor(h).setModel('openai/gpt-4o');
    delete process.env.OPENROUTER_API_KEY;
    process.env.GEMINI_API_KEY = 'gemini-key';
    expect(h.config.aiProvider).toBe('google');
    expect([h.config.orchestratorModel, h.config.planningModel]).toEqual(['', '']);

    await handleStartPlanning('Build a ledger', h.deps);
    expect(h.messages).toContainEqual({ type: 'showError', error: expect.stringContaining('No planner model selected') });
    expect(networks).not.toHaveBeenCalled();
  });

  for (const leftover of ['OPENROUTER_BASE_URL', 'GEMINI_BASE_URL']) {
    it(`a leftover ${leftover} without its key does not take planning from the detected agent`, async () => {
      recordInstalledPlanner('claude-code');
      process.env[leftover] = providerBase;
      const h = harness();
      await handleStartPlanning('Build a ledger', h.deps);
      expect(h.messages.filter((m) => m.type === 'showError')).toEqual([]);
      expect(argvs).toHaveLength(1);
      expect(prompts[0]).toContain('Build a ledger');
      expect(vendorRequests).toEqual([]);
    });
  }

  for (const held of ['secret store', 'settings'] as const) {
    it(`a Google key kept only in the VS Code ${held} plans with Google, not OpenRouter`, async () => {
      recordInstalledPlanner('claude-code');
      setConfig({ orchestratorModel: 'gemini-2.5-pro', ...(held === 'settings' ? { apiKey: 'gemini-key' } : {}) });
      const secrets = new SecretStore({
        get: async (key: string) => held === 'secret store' && key === 'geminiKey' ? 'gemini-key' : undefined,
        store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }),
      } as never);
      await secrets.load();
      const h = harness(new VsCodeConfig(secrets));
      expect(h.config.configuredProviders).toEqual(['google']);
      expect(h.config.aiProvider).toBe('google');
      await handleStartPlanning('Build a ledger', h.deps);
      expect(h.messages).not.toContainEqual({ type: 'showError', error: expect.stringContaining('OPENROUTER_API_KEY') });
      expect(argvs).toEqual([]);
      // The Gemini SDK has no endpoint override, so its call is read where it leaves.
      const [url, init] = networks.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain('generativelanguage.googleapis.com');
      expect(new Headers(init.headers).get('x-goog-api-key')).toBe('gemini-key');
      expect(String(init.body)).toContain('Build a ledger');
    });
  }

});
