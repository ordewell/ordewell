import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ModelResolver, OpenAiService, PlannerNotReadyError, type IConfig, type ConversationTurn } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

function inertResolver(): ModelResolver {
  const registry = { getManifest: () => undefined } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  return new ModelResolver(registry, {} as IConfig);
}

const turn: ConversationTurn = { kind: 'message', text: 'hi', researchLog: [] };
const KEY_VARS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'];

/**
 * The bug report: no API key, a goal typed into the TUI, and the answer was
 * "OpenRouter API key not configured" — from deep inside the vendor transport.
 * The daemon now refuses first, with the way out (ADR-0009: a coding agent
 * plans with no key), and never reaches the transport.
 */
describe('OrchestratorPool planner readiness', () => {
  let dir: string;
  let workspace: string;
  let pool: OrchestratorPool;
  let transport: MockInstance<typeof OpenAiService.prototype.startConversation>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    transport = vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(turn);
    dir = mkdtempSync(join(tmpdir(), 'ordewell-pool-readiness-'));
    workspace = join(dir, 'ws');
    mkdirSync(workspace);
    mkdirSync(join(workspace, '.git'));
    for (const key of ['ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', ...KEY_VARS]) savedEnv[key] = process.env[key];
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    for (const key of KEY_VARS) delete process.env[key];
    process.env.AI_PROVIDER = 'openrouter';
    process.env.ORCHESTRATOR_MODEL = 'openrouter/auto';
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

  it('refuses startPlanning with no key, pointing at /planner, before any transport call', async () => {
    const refusal = pool.startPlanning('s1', 'Add a limiter', ['claude-code'], workspace);

    await expect(refusal).rejects.toBeInstanceOf(PlannerNotReadyError);
    await expect(refusal).rejects.toThrow(
      'No planner is ready. Pick one with /planner: Claude Code, Codex, OpenCode, GitHub Copilot CLI, Qwen Code, Cline, Gemini CLI and Cursor plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with /key.',
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses generatePlan the same way', async () => {
    await expect(pool.generatePlan('s2', 'Add a limiter', ['claude-code'], workspace)).rejects.toBeInstanceOf(PlannerNotReadyError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a reply in a live session once the key is gone, and leaves the session in place', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    await pool.startPlanning('s3', 'Add a limiter', ['claude-code'], workspace);
    delete process.env.OPENROUTER_API_KEY;

    await expect(pool.continuePlanning('s3', 'go on', undefined)).rejects.toBeInstanceOf(PlannerNotReadyError);
    expect(pool.session('s3', undefined)).toBeDefined();
  });

  it('refuses what reaches the session past the pool once the key is gone: a force send, a merge, a compaction', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    await pool.startPlanning('s5', 'Add a limiter', ['claude-code'], workspace);
    const continued = vi.spyOn(OpenAiService.prototype, 'continueConversation');
    transport.mockClear();
    delete process.env.OPENROUTER_API_KEY;

    await expect(pool.session('s5', undefined).forceSendPrompt('go on')).rejects.toBeInstanceOf(PlannerNotReadyError);
    await expect(pool.session('s5', undefined).continueConversation('merge #1 and #2')).rejects.toBeInstanceOf(PlannerNotReadyError);
    await expect(pool.compactConversation('s5', undefined)).rejects.toBeInstanceOf(PlannerNotReadyError);
    expect(transport).not.toHaveBeenCalled();
    expect(continued).not.toHaveBeenCalled();
  });

  it('keeps the live session when a restart is refused', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    await pool.startPlanning('s4', 'Add a limiter', ['claude-code'], workspace);
    const live = pool.session('s4', undefined);
    delete process.env.OPENROUTER_API_KEY;

    await expect(pool.startPlanning('s4', 'Another goal', ['claude-code'], workspace)).rejects.toBeInstanceOf(PlannerNotReadyError);
    expect(pool.session('s4', undefined)).toBe(live);
  });
});
