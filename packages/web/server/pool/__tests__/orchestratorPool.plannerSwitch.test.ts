import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ModelResolver, OpenAiService, GeminiService, createTask, type IConfig, type ConversationTurn } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

/**
 * A resolver whose discovery never spawns a CLI or hits the network: the fake
 * registry answers `undefined` for every runner, which `modelsForRunners`
 * reads as an empty catalog, and the picker cache is never populated.
 */
function inertResolver(): ModelResolver {
  const registry = { getManifest: () => undefined } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  return new ModelResolver(registry, {} as IConfig);
}

// The real `createAiService` stays in play — patching only the two vendor
// transports' `startConversation` keeps every layer above them real (WebConfig,
// Session's aiService getter, the pool) while sparing the network. The spy
// therefore doubles as the record of which transport served each turn.
const turn: ConversationTurn = { kind: 'message', text: 'hi', researchLog: [] };

describe('OrchestratorPool mid-session planner switch', () => {
  let dir: string;
  let workspace: string;
  let pool: OrchestratorPool;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(turn);
    vi.spyOn(GeminiService.prototype, 'startConversation').mockResolvedValue(turn);

    dir = mkdtempSync(join(tmpdir(), 'ordewell-pool-planner-switch-'));
    workspace = join(dir, 'ws');
    mkdirSync(workspace);
    mkdirSync(join(workspace, '.git'));
    for (const key of ['ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL']) {
      savedEnv[key] = process.env[key];
    }
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    pool = new OrchestratorPool({ modelResolver: inertResolver() });
  });

  afterEach(() => {
    pool.destroyAll();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rebuilds the AI transport when the planner provider switches mid-session', async () => {
    process.env.AI_PROVIDER = 'openrouter';
    process.env.ORCHESTRATOR_MODEL = 'openrouter/auto';

    await pool.startPlanning('session-switch', 'Add a limiter', ['claude-code'], workspace);

    expect(OpenAiService.prototype.startConversation).toHaveBeenCalledTimes(1);

    pool.updateSettings({ env: { AI_PROVIDER: 'google', ORCHESTRATOR_MODEL: 'gemini-2.5-pro' } });

    await pool.continuePlanning('session-switch', 'Use a token bucket');

    // Pre-fix, the stale WebConfig.aiProvider kept the OpenAiService for google
    // too; the switch would never have reached the Gemini transport.
    expect(GeminiService.prototype.startConversation).toHaveBeenCalledTimes(1);
    expect(OpenAiService.prototype.startConversation).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the AI transport when the switch happens after a plan with tasks exists', async () => {
    // First turn lands a real plan (a `plan` turn), so the session holds tasks
    // — the "after a plan has been generated" variant of the bug report. The
    // per-task runner/model assignment never reads config.aiProvider, but the
    // *planner* transport does on the next turn, so the stale-memo failure
    // must be exercised here too, not only pre-plan.
    const planTurn: ConversationTurn = {
      kind: 'plan',
      text: 'Plan generated.',
      researchLog: [],
      tasks: [createTask({ id: 'a', order: 1, title: 'Add limiter', prompt: 'p', status: 'pending' })],
    };
    const messageTurn: ConversationTurn = { kind: 'message', text: 'ok', researchLog: [] };
    const openAi = vi.mocked(OpenAiService.prototype.startConversation);
    const gemini = vi.mocked(GeminiService.prototype.startConversation);
    openAi.mockResolvedValueOnce(planTurn);
    gemini.mockResolvedValueOnce(planTurn);
    openAi.mockResolvedValue(messageTurn);
    gemini.mockResolvedValue(messageTurn);

    process.env.AI_PROVIDER = 'openrouter';
    process.env.ORCHESTRATOR_MODEL = 'openrouter/auto';

    await pool.startPlanning('session-with-plan', 'Add a limiter', ['claude-code'], workspace);
    expect(pool.getPlan('session-with-plan')?.tasks).toHaveLength(1);

    pool.updateSettings({ env: { AI_PROVIDER: 'google', ORCHESTRATOR_MODEL: 'gemini-2.5-pro' } });

    await pool.continuePlanning('session-with-plan', 'Use a token bucket');

    expect(GeminiService.prototype.startConversation).toHaveBeenCalledTimes(1);
    expect(OpenAiService.prototype.startConversation).toHaveBeenCalledTimes(1);
  });
});
