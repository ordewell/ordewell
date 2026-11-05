import { afterEach, beforeEach, describe, expect, vi, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import https from 'https';
import { basename, delimiter, join } from 'path';
import type { SpawnFn } from '@ordewell/core';

// Load the source at runtime so the real adapter uses the process fake, while
// keeping the extension's TypeScript root limited to its own src directory.
vi.mock('@ordewell/core', () => import('../../../../core/src/' + 'index'));
const boundary = vi.hoisted(() => ({ spawned: [] as string[] }));
const AGENTS = ['claude', 'codex', 'opencode'];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const spawn = ((command: string, args: string[], options: Parameters<SpawnFn>[2]) => {
    const agent = basename(command, '.exe');
    if (!AGENTS.includes(agent)) return actual.spawn(command, args, options);
    boundary.spawned.push(agent);
    throw new Error('stopped at the process boundary');
  }) as typeof actual.spawn;
  return { ...actual, spawn, default: { ...actual, spawn } };
});

import {
  BufferedTaskOutputSource, clearAugmentedPathCache, createEmptyPlan, createSession, detectInstalledPlanner, getProviderMeta,
  PROVIDER_DETECT_PRIORITY, resetInstalledPlanner, RUN_SETTINGS_DEFAULTS, RunnerRegistry, SettingsService,
  type ModelResolver, type IRunner, type RunnerId,
} from '@ordewell/core';
import { fakeFileSystem, homeEnv, setEnv, writeStandIn } from '@ordewell/core/testing';
import { __resetConfig, __setConfig, configUpdates } from '../../test/vscode.mock';
import { VsCodeConfig } from '../../adapters/VsCodeConfig';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import type { HostToWebview } from '../../shared/protocol';
import { handleStartPlanning, type PlanManagerDeps } from '../PlanManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((answer) => { resolve = answer; });
  return { promise, resolve };
}

// The extension's own config and PlanManager drive a real Session down to the
// planner agent's spawn; only host APIs, discovery and processes are fake.
describe('VS Code with no saved runner choice enables the installed agents', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let restoreHome: () => void;

  beforeEach(() => {
    env = { ...process.env };
    dir = mkdtempSync(join(tmpdir(), 'ordewell-vscode-installed-runners-'));
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'bin'));
    for (const agent of AGENTS) writeStandIn(join(dir, 'bin'), agent);
    restoreHome = setEnv(homeEnv(dir));
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
    vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected external HTTPS request'); });
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => { throw new Error(`Unexpected request: ${String(input)}`); }));
    resetInstalledPlanner();
    clearAugmentedPathCache();
    boundary.spawned = [];
  });

  afterEach(() => {
    resetInstalledPlanner();
    clearAugmentedPathCache();
    __resetConfig();
    // First, on the environment it was set on, which the copy below replaces.
    restoreHome();
    process.env = env;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function harness() {
    const config = new VsCodeConfig();
    const messages: HostToWebview[] = [];
    const chatProvider = new ChatViewProvider({ toString: () => 'file:///extension' } as never);
    chatProvider.postMessage = (message) => { messages.push(message); };
    const runner: IRunner = { activeCount: 0, spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn() };
    const registry = new RunnerRegistry();
    const modelResolver = { getCachedRunnerModels: () => [], modelsForRunners: async () => ({}) } as unknown as ModelResolver;
    const session = createSession({
      config, runner, registry, modelResolver,
      notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: async () => undefined },
      workspaceRoot: () => dir, fsAdapter: fakeFileSystem(),
      broadcast: (message) => chatProvider.conversation.receive(message),
      // As the extension host hands it over: the saved choice, read live; with none the config's defaults decide.
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, autorun: false }, enabledRunners: new SettingsService().getEnabledRunners() }),
      taskOutput: new BufferedTaskOutputSource(), saveSession: () => {},
    });
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
    return { deps, session, messages, config, errors: () => messages.filter((m) => m.type === 'showError') };
  }

  const only = (...agents: RunnerId[]) => ({ plannerUsability: async (id: string) => ({ usable: agents.includes(id) }) });

  function savedRunners(): unknown {
    const file = process.env.ORDEWELL_SETTINGS_PATH!;
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { enabledRunners?: unknown }).enabledRunners : undefined;
  }

  it('a Codex-only first goal typed before detection plans with Codex', async () => {
    const h = harness();
    const gate = deferred<void>();
    const detection = detectInstalledPlanner({ plannerUsability: async (id) => { await gate.promise; return { usable: id === 'codex' }; } });
    const started = handleStartPlanning('Build a ledger', h.deps);
    gate.resolve();
    await detection;
    await started;

    expect(h.config.enabledRunners).toEqual(['codex']);
    expect(h.errors().map((m) => JSON.stringify(m))).not.toContainEqual(expect.stringContaining('None of the requested runners are enabled'));
    expect(boundary.spawned).toEqual(['codex']);
    expect(h.session.planState?.runners).toEqual(['codex']);
    expect(configUpdates).toEqual([]);
    expect(savedRunners()).toBeUndefined();
  });

  it('a Codex-only goal typed after detection plans with Codex', async () => {
    await detectInstalledPlanner(only('codex'));
    const h = harness();
    expect(h.config.enabledRunners).toEqual(['codex']);
    await handleStartPlanning('Build a ledger', h.deps);
    expect(boundary.spawned).toEqual(['codex']);
    expect(h.session.planState?.runners).toEqual(['codex']);
  });

  it('a Claude-only host is unchanged', async () => {
    await detectInstalledPlanner(only('claude-code'));
    const h = harness();
    expect(h.config.enabledRunners).toEqual(['claude-code']);
    await handleStartPlanning('Build a ledger', h.deps);
    expect(boundary.spawned).toEqual(['claude']);
    expect(h.session.planState?.runners).toEqual(['claude-code']);
  });

  it('keeps a saved selection, and a saved empty one', async () => {
    await detectInstalledPlanner(only('codex', 'opencode'));
    new SettingsService().setEnabledRunners(['opencode']);
    expect(new VsCodeConfig().enabledRunners).toEqual(['opencode']);
    new SettingsService().setEnabledRunners([]);
    const h = harness();
    expect(h.config.enabledRunners).toEqual([]);
    await handleStartPlanning('Build a ledger', h.deps);
    expect(boundary.spawned).toEqual([]);
    expect(h.errors()).toContainEqual({ type: 'showError', error: expect.stringContaining('No runner is enabled') });
    expect(configUpdates).toEqual([]);
  });

  it('a legacy toggle the user set is still a choice', async () => {
    await detectInstalledPlanner(only('codex'));
    __setConfig({ 'claudeCode.enabled': true });
    expect(new VsCodeConfig().enabledRunners).toEqual(['claude-code']);
    __setConfig({ 'claudeCode.enabled': false, 'codex.enabled': true });
    expect(new VsCodeConfig().enabledRunners).toEqual(['codex']);
  });
});
