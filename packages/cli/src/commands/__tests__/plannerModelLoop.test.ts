import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { PlannerModelMemory, type PlannerModelCandidate } from '@ordewell/core';
import { ApiClient } from '../../apiClient';

/**
 * A stand-in daemon whose `/api/settings` PATCH handler reimplements the
 * memory-relevant slice of `OrchestratorPool.updateSettings` (packages/web) —
 * using the real `PlannerModelMemory` for the actual recall/remember
 * decisions, not a re-derived copy of them. `settings-commands.test.ts`
 * already proves the CLI reads a *given* daemon response correctly;
 * `orchestratorPool.plannerModel.test.ts` already proves the real daemon
 * resolves a switch correctly in isolation. What neither of those covers is
 * this file's purpose: that the real `handlePlanner`/`handleModel`/
 * `handlePlannerEffort` — driving a memory that behaves like the daemon's —
 * carry a model through a switch-A → pick → switch-B → pick → switch-back-A
 * loop into `.env`, with two planners never clobbering each other's memory.
 */
function fakeMemoryDaemon(opts: {
  aiProvider: string;
  catalogFor: (provider: string) => PlannerModelCandidate[];
  modelsByRunner: Record<string, { modelId: string; variants?: { id: string; label: string }[] }[]>;
}): Promise<{ port: number; close: () => void }> {
  const store = new Map<string, { model: string; effort?: string }>();
  const memory = new PlannerModelMemory({
    getPlannerModel: (p) => store.get(p),
    setPlannerModel: (p, entry) => { if (entry) store.set(p, entry); else store.delete(p); },
  });
  let aiProvider = opts.aiProvider;
  let orchestratorModel = '';
  let plannerThinkingEffort = '';

  function currentSettings() {
    return {
      orchestratorModel,
      aiProvider,
      plannerThinkingEffort,
      plannerModels: Object.fromEntries(store),
      modelAllowlist: {},
    };
  }

  // Mirrors OrchestratorPool.updateSettings's memory-relevant branches: a
  // switch (env.AI_PROVIDER changing) resolves through `memory.recall`; an
  // explicit pick — top-level fields, or the env-only shape
  // `ordewell planner-effort`/the TUI's effort picker actually send — is
  // captured through `memory.remember`, keyed to whichever provider is in
  // effect once the switch (if any) in this same call has landed.
  function patch(body: Record<string, unknown>) {
    const providerBefore = aiProvider;
    const env = body.env && typeof body.env === 'object' ? (body.env as Record<string, unknown>) : undefined;
    const incomingProvider = typeof env?.AI_PROVIDER === 'string' ? (env.AI_PROVIDER as string) : undefined;
    const switchedTo = incomingProvider && incomingProvider !== providerBefore ? incomingProvider : undefined;
    const switchRecall = switchedTo ? memory.recall(switchedTo, opts.catalogFor(switchedTo)) : undefined;

    if (typeof body.orchestratorModel === 'string') orchestratorModel = body.orchestratorModel;
    if (typeof body.plannerThinkingEffort === 'string') plannerThinkingEffort = body.plannerThinkingEffort;
    if (env) {
      if (typeof env.AI_PROVIDER === 'string') aiProvider = env.AI_PROVIDER as string;
      if (typeof env.ORCHESTRATOR_MODEL === 'string') orchestratorModel = env.ORCHESTRATOR_MODEL as string;
      if (typeof env.ORDEWELL_PLANNER_EFFORT === 'string') plannerThinkingEffort = env.ORDEWELL_PLANNER_EFFORT as string;
    }
    if (switchRecall) {
      orchestratorModel = switchRecall.model;
      plannerThinkingEffort = switchRecall.effort;
    }

    const envCarriesModelOrEffort = env?.AI_PROVIDER === undefined &&
      (typeof env?.ORCHESTRATOR_MODEL === 'string' || typeof env?.ORDEWELL_PLANNER_EFFORT === 'string');
    if (typeof body.orchestratorModel === 'string' || typeof body.plannerThinkingEffort === 'string' || envCarriesModelOrEffort) {
      memory.remember(switchedTo ?? aiProvider, orchestratorModel, plannerThinkingEffort);
    }
    return currentSettings();
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const json = (data: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url?.startsWith('/api/settings')) {
        return json(req.method === 'PATCH' ? patch(body ?? {}) : currentSettings());
      }
      if (req.url?.startsWith('/api/models')) {
        const modelsByRunner = opts.modelsByRunner;
        const models = Object.entries(modelsByRunner).flatMap(([runner, entries]) =>
          entries.map((e) => ({ ...e, runnerProvider: runner })));
        return json({ models, modelsByRunner, providers: [], orchestratorModels: [], modesByRunner: {} });
      }
      return json({ ok: true });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close() });
    });
  });
}

let envDir: string;
beforeEach(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  envDir = mkdtempSync(join(tmpdir(), 'ordewell-cli-loop-test-'));
  vi.stubEnv('HOME', envDir);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('planner model memory — CLI round trip', () => {
  it('keeps each planner\'s own model+effort across switch-A, pick, switch-B, pick, switch-back-A', async () => {
    const d = await fakeMemoryDaemon({
      aiProvider: 'openrouter',
      modelsByRunner: {
        'claude-code': [{ modelId: 'claude-a' }, { modelId: 'claude-b' }],
        opencode: [{ modelId: 'opencode-x' }, { modelId: 'opencode-y', variants: [{ id: 'high', label: 'High' }] }],
      },
      catalogFor: (provider) => {
        const byRunner: Record<string, { modelId: string; variants?: { id: string }[] }[]> = {
          'claude-code': [{ modelId: 'claude-a' }, { modelId: 'claude-b' }],
          opencode: [{ modelId: 'opencode-x' }, { modelId: 'opencode-y', variants: [{ id: 'high' }] }],
        };
        return (byRunner[provider] ?? []).map((m) => ({ id: m.modelId, variants: m.variants?.map((v) => ({ id: v.id })) }));
      },
    });
    const api = new ApiClient(d.port);
    const { handlePlanner, handlePlannerEffort } = await import('../planner');
    const { handleModel } = await import('../model');
    const { readFileSync } = await import('fs');
    const { findEnvFile } = await import('../../utils/env');
    const readEnv = () => readFileSync(findEnvFile(), 'utf8');

    await handlePlanner(['claude-code'], api);
    await handleModel(['set', 'claude-b'], api);
    expect(readEnv()).toContain('ORCHESTRATOR_MODEL=claude-b');

    await handlePlanner(['opencode'], api);
    await handleModel(['set', 'opencode-y'], api);
    await handlePlannerEffort(['high'], api);
    expect(readEnv()).toContain('ORCHESTRATOR_MODEL=opencode-y');
    expect(readEnv()).toContain('ORDEWELL_PLANNER_EFFORT=high');

    // Switching back to claude-code must restore claude-b — its own memory —
    // not opencode's, and not a blank/re-defaulted model.
    await handlePlanner(['claude-code'], api);
    expect(readEnv()).toContain('ORCHESTRATOR_MODEL=claude-b');
    const backToClaudeCode = await api.getSettings();
    expect(backToClaudeCode.orchestratorModel).toBe('claude-b');

    // And opencode's memory (model + effort) survived the round trip too.
    await handlePlanner(['opencode'], api);
    const backToOpencode = await api.getSettings();
    expect(backToOpencode.orchestratorModel).toBe('opencode-y');
    expect(backToOpencode.plannerThinkingEffort).toBe('high');

    d.close();
  });
});
