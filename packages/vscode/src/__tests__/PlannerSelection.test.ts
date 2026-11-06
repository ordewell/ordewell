import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlannerModelMemory, recordInstalledPlanner, resetInstalledPlanner, runnerForProvider, type PlannerBackendId, type PlannerModelStore, type PlannerUsability, type RunnerAuth } from '@ordewell/core';
import { __resetConfig, __setConfig, configUpdates } from '../test/vscode.mock';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { PlannerSelection } from '../PlannerSelection';

function setup(
  runnerModels: Record<string, { modelId: string; variants: { id: string }[] }[]> = {},
  auth?: RunnerAuth,
  usability?: PlannerUsability,
) {
  const stored: Record<string, { model: string; effort?: string }> = {};
  const store: PlannerModelStore = {
    getPlannerModel: (p) => stored[p],
    setPlannerModel: (p, e) => { if (e) stored[p] = e; else delete stored[p]; },
  };
  const memory = new PlannerModelMemory(store);
  const sendModelConfig = vi.fn();
  const setPlannerBackends = vi.fn();
  const selection = new PlannerSelection({
    config: new VsCodeConfig(),
    modelResolver: { plannerCatalog: async (provider: PlannerBackendId) => (runnerModels[runnerForProvider(provider) ?? ''] ?? []).map((m) => ({ id: m.modelId, variants: m.variants })) } as never,
    plannerModelMemory: memory,
    runnerInstallation: { plannerUsability: async () => usability ?? { usable: true, ...(auth ? { auth } : {}) } } as never,
    chatProvider: { setPlannerBackends } as never,
    sendModelConfig,
    log: () => {},
  });
  return { selection, memory, sendModelConfig, setPlannerBackends };
}

describe('PlannerSelection.applyChoice', () => {
  beforeEach(() => {
    __resetConfig();
    __setConfig({ aiProvider: 'openrouter', orchestratorModel: 'z-ai/glm-4.6', plannerThinkingEffort: '' });
  });

  it('writes provider, model and effort, remembers the pick, and tells the webview once', async () => {
    const { selection, memory, sendModelConfig, setPlannerBackends } = setup();

    await selection.applyChoice('claude-code', 'claude-opus-5-5', 'high');

    expect(configUpdates).toEqual([
      { key: 'aiProvider', value: 'claude-code' },
      { key: 'orchestratorModel', value: 'claude-opus-5-5' },
      { key: 'plannerThinkingEffort', value: 'high' },
    ]);
    expect(memory.recall('claude-code', [{ id: 'claude-opus-5-5', variants: [{ id: 'high' }] }])).toEqual({
      model: 'claude-opus-5-5', effort: 'high', source: 'remembered',
    });
    expect(sendModelConfig).toHaveBeenCalledOnce();
    expect(setPlannerBackends).toHaveBeenCalledOnce();
    expect(setPlannerBackends.mock.calls[0].slice(1)).toEqual(['claude-code', 'claude-code', 'high']);
  });
});

describe('PlannerSelection.setModel', () => {
  beforeEach(() => {
    __resetConfig();
    __setConfig({ aiProvider: 'claude-code', orchestratorModel: 'claude-a', plannerThinkingEffort: 'high' });
  });

  it('drops an effort the model was not picked with when the pick names none', async () => {
    const { selection, memory } = setup();

    await selection.setModel('claude-b');

    expect(configUpdates).toEqual([
      { key: 'orchestratorModel', value: 'claude-b' },
      { key: 'plannerThinkingEffort', value: '' },
    ]);
    expect(memory.getPlannerModel('claude-code')).toEqual({ model: 'claude-b' });
  });
});

describe('PlannerSelection.apply', () => {
  beforeEach(() => {
    __resetConfig();
    __setConfig({ aiProvider: 'claude-code', orchestratorModel: 'claude-a', plannerThinkingEffort: '' });
  });

  it('still tells the webview where the planner stands when the switch fails', async () => {
    // The webview lights the pick before the host answers; a failure that sent
    // nothing would leave that pill lit for a planner that never changed.
    const { selection, setPlannerBackends } = setup();
    const failing = selection as unknown as { change: () => Promise<never> };
    failing.change = async () => { throw new Error('config write failed'); };

    await expect(selection.apply('codex')).rejects.toThrow('config write failed');

    expect(setPlannerBackends).toHaveBeenCalledOnce();
    expect(setPlannerBackends.mock.calls[0][1]).toBe('claude-code');
  });

  it('restores what the new backend remembers', async () => {
    const { selection, memory } = setup({ codex: [{ modelId: 'gpt-5-codex', variants: [{ id: 'high' }] }] });
    memory.remember('codex', 'gpt-5-codex', 'high');

    await selection.apply('codex');

    expect(configUpdates).toEqual([
      { key: 'aiProvider', value: 'codex' },
      { key: 'orchestratorModel', value: 'gpt-5-codex' },
      { key: 'plannerThinkingEffort', value: 'high' },
    ]);
  });

  it('keeps the model of the planner already in use rather than re-recalling it', async () => {
    const { selection, memory } = setup({ 'claude-code': [{ modelId: 'claude-b', variants: [] }] });
    memory.remember('claude-code', 'claude-b');

    await selection.apply('claude-code');

    expect(configUpdates).toEqual([]);
  });
});

describe('PlannerSelection.backends', () => {
  beforeEach(() => {
    __resetConfig();
    __setConfig({ aiProvider: 'claude-code', orchestratorModel: 'claude-a', plannerThinkingEffort: '' });
  });

  it('carries the runner login verdict to a signed-out agent without making it unusable', async () => {
    const auth: RunnerAuth = { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' };
    const { selection } = setup({}, auth);

    const claude = (await selection.backends()).find((b) => b.id === 'claude-code');

    expect(claude?.auth).toEqual(auth);
    expect(claude?.usable).toBe(true);
  });

  it('lists an agent the preflight refuses with the reason it cannot start', async () => {
    const reason = 'GitHub Copilot CLI is too old for Ordewell: found 1.0.104, needs 1.0.105 or later.';
    const { selection } = setup({}, undefined, { usable: false, reason });

    const backends = await selection.backends();
    const copilot = backends.find((b) => b.id === 'copilot-cli');

    expect(copilot).toMatchObject({ kind: 'harness', usable: false, reason });
  });
});

describe('PlannerSelection with a detected default planner', () => {
  beforeEach(() => {
    __resetConfig();
    // Nothing chosen: Codex is the effective planner only because it is the one installed agent.
    __setConfig({ aiProvider: '', orchestratorModel: '', plannerThinkingEffort: '' });
    recordInstalledPlanner('codex');
  });
  afterEach(() => resetInstalledPlanner());

  it('saves the provider when the user explicitly picks the detected agent', async () => {
    const { selection } = setup({ codex: [{ modelId: 'gpt-5-codex', variants: [] }] });

    await selection.applyChoice('codex', 'gpt-5-codex', '');

    expect(configUpdates).toContainEqual({ key: 'aiProvider', value: 'codex' });
  });

  it('keeps the explicit pick when a later activation detects another agent', async () => {
    const { selection } = setup({ codex: [{ modelId: 'gpt-5-codex', variants: [] }] });
    await selection.applyChoice('codex', 'gpt-5-codex', '');

    // Claude Code is installed afterwards, so the next activation detects it.
    resetInstalledPlanner();
    recordInstalledPlanner('claude-code');

    const next = new VsCodeConfig();
    expect(next.aiProvider).toBe('codex');
    expect(next.orchestratorModel).toBe('gpt-5-codex');
  });

  it('saves the provider for a bare pick of the detected agent', async () => {
    const { selection, memory } = setup({ codex: [{ modelId: 'gpt-5-codex', variants: [] }] });
    memory.remember('codex', 'gpt-5-codex');

    await selection.apply('codex');

    expect(configUpdates).toContainEqual({ key: 'aiProvider', value: 'codex' });
  });

  it('leaves the provider unsaved when only the model changes', async () => {
    const { selection } = setup();

    await selection.setModel('gpt-5-codex');

    expect(configUpdates.map((u) => u.key)).not.toContain('aiProvider');
  });
});
