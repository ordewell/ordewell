import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  handleContinueConversation, handleSendMessageNow, plannerPreflightError, recheckSignedOutPlanner, type PlanManagerDeps,
} from '../PlanManager';
import {
  getProviderMeta, PROVIDER_DETECT_PRIORITY, PlannerNotReadyError, recordRunnerAuth, recordedRunnerAuth, resetRunnerAuth,
  type LegacyPlanState, type PlannerBackendId,
} from '@ordewell/core';
import { VsCodeConfig } from '../../adapters/VsCodeConfig';
import { SecretStore } from '../../adapters/SecretStore';
import { __setConfig, __resetConfig } from '../../test/vscode.mock';

function config(aiProvider: PlannerBackendId, apiKey: string, planningModel: string, openaiCompatibleBaseUrl = ''): VsCodeConfig {
  return { aiProvider, getProviderApiKey: () => apiKey, planningModel, orchestratorModel: '', openaiCompatibleBaseUrl } as unknown as VsCodeConfig;
}

/**
 * ADR-0009: a harness planner is authenticated by the user's own coding-agent
 * subscription, so the API-key gate must not fire for it. The reported bug was
 * exactly this — Claude Code selected as planner, no key set, and the chat
 * answered "API key not configured" instead of planning.
 */
describe('plannerPreflightError', () => {
  for (const provider of ['claude-code', 'codex', 'opencode', 'copilot-cli']) {
    it(`lets ${provider} plan with no API key`, () => {
      expect(plannerPreflightError(config(provider, '', 'sonnet'), '/repo')).toBeNull();
    });

    it(`lets ${provider} plan with no model — the agent's default applies`, () => {
      expect(plannerPreflightError(config(provider, '', ''), '/repo')).toBeNull();
    });
  }

  it('sends a vendor planner with no key to /planner first, then offers /key', () => {
    expect(plannerPreflightError(config('openrouter', '', 'openai/gpt-5'), '/repo')).toBe(
      'No planner is ready. Pick one with /planner: Claude Code, Codex, OpenCode and GitHub Copilot CLI plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with /key.',
    );
  });

  it('asks an openai_compatible planner for its base URL, not a key', () => {
    expect(plannerPreflightError(config('openai_compatible', '', 'llama3'), '/repo')).toContain('OPENAI_COMPATIBLE_BASE_URL');
  });

  it('still demands a model from a keyed vendor planner, in the chat\'s /planner spelling', () => {
    expect(plannerPreflightError(config('openrouter', 'sk-or', ''), '/repo'))
      .toBe('No planner model selected for OpenRouter. Pick one with /planner.');
  });

  it('passes a fully configured vendor planner', () => {
    expect(plannerPreflightError(config('openrouter', 'sk-or', 'openai/gpt-5'), '/repo')).toBeNull();
  });
});

/**
 * The preflight reads the signed-out verdict per workspace (ADR-0016): a
 * future caller handed one workspace's refusal because another surface
 * recorded its verdict unscoped — or another workspace recorded its own —
 * would block a planner that can plan.
 */
describe('plannerPreflightError scopes the signed-out verdict to the workspace', () => {
  const SIGNED_OUT = { state: 'signed-out' as const, loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' };

  afterEach(() => resetRunnerAuth());

  it('does not read a signed-out verdict recorded without a workspace', () => {
    recordRunnerAuth('claude-code', SIGNED_OUT);

    expect(plannerPreflightError(config('claude-code', '', 'sonnet'), '/repo')).toBeNull();
  });

  it('does not read another workspace\'s signed-out verdict', () => {
    recordRunnerAuth('claude-code', SIGNED_OUT, '/elsewhere');

    expect(plannerPreflightError(config('claude-code', '', 'sonnet'), '/repo')).toBeNull();
  });

  it('refuses on this workspace\'s own signed-out verdict', () => {
    recordRunnerAuth('claude-code', SIGNED_OUT, '/repo');

    expect(plannerPreflightError(config('claude-code', '', 'sonnet'), '/repo')).toContain('Claude Code not logged in');
  });
});

/**
 * The preflight must check the key the selected planner's transport will
 * read. A key held for another vendor passed it, and the turn then failed deep
 * in the transport with "OpenAI API key not configured" instead of the
 * /planner-first refusal.
 */
describe('plannerPreflightError on the extension\'s own config', () => {
  const vars = PROVIDER_DETECT_PRIORITY.flatMap((p) => {
    const meta = getProviderMeta(p);
    return [meta.apiKeyEnvVar, ...meta.detectEnvVars, ...(meta.baseUrlEnvVar ? [meta.baseUrlEnvVar] : [])];
  });
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of vars) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of vars) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    __resetConfig();
  });

  async function store(initial: Record<string, string>): Promise<SecretStore> {
    const map = new Map(Object.entries(initial));
    const s = new SecretStore({
      async get(k: string) { return map.get(k); },
      async store(k: string, v: string) { map.set(k, v); },
      async delete(k: string) { map.delete(k); },
      onDidChange() { return { dispose() {} }; },
    } as never);
    await s.load();
    return s;
  }

  it('refuses an OpenAI planner with no OpenAI key even when an OpenRouter key is stored', async () => {
    __setConfig({ aiProvider: 'openai', orchestratorModel: 'gpt-4o' });
    const config = new VsCodeConfig(await store({ openrouterKey: 'sk-or-secret' }));

    expect(plannerPreflightError(config, '/repo')).toBe(
      'No planner is ready. Pick one with /planner: Claude Code, Codex, OpenCode and GitHub Copilot CLI plan with no API key. ' +
      'To plan with OpenAI instead, add OPENAI_API_KEY with /key.',
    );
  });

  it('refuses a Gemini planner with no Gemini key even when an OpenRouter key is stored', async () => {
    __setConfig({ aiProvider: 'google', orchestratorModel: 'gemini-2.5-pro' });
    const config = new VsCodeConfig(await store({ openrouterKey: 'sk-or-secret' }));

    expect(plannerPreflightError(config, '/repo')).toContain('GEMINI_API_KEY');
    expect(config.apiKey).toBe('');
  });

  it('passes a planner whose own key is in the legacy setting', async () => {
    __setConfig({ aiProvider: 'google', orchestratorModel: 'gemini-2.5-pro', apiKey: 'g-legacy' });
    const config = new VsCodeConfig(await store({}));

    expect(plannerPreflightError(config, '/repo')).toBeNull();
    expect(config.apiKey).toBe('g-legacy');
  });
});

/**
 * A signed-out refusal offers the runner's own login as a way back, and that
 * runs outside the extension host. The turn must ask the workspace's account
 * again rather than keep the verdict the last runner list read.
 */
describe('recheckSignedOutPlanner', () => {
  afterEach(() => resetRunnerAuth());

  function host(auth?: { state: 'signed-in' | 'signed-out' | 'unknown'; loginCommand?: string[] }) {
    const plannerUsability = vi.fn(async () => ({ usable: true }));
    const installation = { refresh: vi.fn(), plannerUsability };
    if (auth) recordRunnerAuth('claude-code', auth, '/repo');
    return {
      plannerUsability,
      installation,
      deps: {
        config: config('claude-code', '', 'sonnet'),
        fsAdapter: { getWorkspaceRoot: () => '/repo' } as unknown as PlanManagerDeps['fsAdapter'],
        runnerInstallation: installation,
      },
    };
  }

  it('asks the workspace account again after a signed-out verdict', async () => {
    const h = host({ state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] });

    await recheckSignedOutPlanner(h.deps);

    expect(h.installation.refresh).toHaveBeenCalledTimes(1);
    expect(h.plannerUsability).toHaveBeenCalledWith('claude-code');
  });

  it('asks nothing when the verdict is signed in or unknown', async () => {
    for (const state of ['signed-in', 'unknown'] as const) {
      resetRunnerAuth();
      const h = host({ state });

      await recheckSignedOutPlanner(h.deps);

      expect(h.plannerUsability).not.toHaveBeenCalled();
    }
  });

  it('does not read another workspace\'s signed-out verdict', async () => {
    const h = host();
    recordRunnerAuth('claude-code', { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] }, '/elsewhere');

    await recheckSignedOutPlanner(h.deps);

    expect(h.plannerUsability).not.toHaveBeenCalled();
  });
});

/**
 * The reply and the force send are planner turns too, and the signed-out
 * refusal's own way back — the runner's login — runs outside the extension
 * host. Both must ask the workspace's account again before the session gate
 * judges, or the user who just logged in stays refused until a runner list.
 */
describe('a turn after a login done outside the extension', () => {
  const SIGNED_OUT = { state: 'signed-out' as const, loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' };
  const SIGNED_IN = { state: 'signed-in' as const, loginCommand: ['claude', 'auth', 'login'] };
  let workspace: string;

  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'ordewell-vscode-recheck-')); });
  afterEach(() => {
    resetRunnerAuth();
    rmSync(workspace, { recursive: true, force: true });
  });

  function emptyPlan(): LegacyPlanState {
    const now = new Date().toISOString();
    return { tasks: [], generatedAt: now, status: 'draft', runners: ['claude-code'], lastUpdated: now };
  }

  function turnHost(options: { signsIn: boolean }) {
    const installation = {
      refresh: vi.fn(),
      plannerUsability: vi.fn(async () => {
        // What the re-probe records when the account was signed in since.
        if (options.signsIn) recordRunnerAuth('claude-code', SIGNED_IN, workspace);
        return { usable: true };
      }),
    };
    // The Session's own gate, synchronous and reading the recorded verdict.
    const gate = (): void => {
      if (recordedRunnerAuth('claude-code', workspace)?.state !== 'signed-out') return;
      throw new PlannerNotReadyError({
        code: 'signed_out', provider: 'claude-code', label: 'Claude Code', runner: 'claude-code',
        loginCommand: ['claude', 'auth', 'login'],
      });
    };
    const session = {
      sessionId: 's1',
      continueConversation: vi.fn(async () => { gate(); return emptyPlan(); }),
      forceSendPrompt: vi.fn(async () => { gate(); return emptyPlan(); }),
    };
    const chatProvider = { showError: vi.fn(), showPlan: vi.fn(), setState: vi.fn() };
    const deps = {
      session,
      chatProvider,
      config: config('claude-code', '', 'sonnet'),
      fsAdapter: { getWorkspaceRoot: () => workspace },
      runnerInstallation: installation,
      getCurrentPlan: emptyPlan,
      setCurrentPlan: vi.fn(),
      getCurrentGoal: () => '',
      setCurrentGoal: vi.fn(),
      isGeneratingPlan: () => false,
      persistState: vi.fn(),
      saveCurrentSession: vi.fn(),
      log: vi.fn(),
    } as unknown as PlanManagerDeps;
    return { installation, session, chatProvider, deps };
  }

  it('re-probes before a reply, so a login made with the runner\'s own command starts it', async () => {
    recordRunnerAuth('claude-code', SIGNED_OUT, workspace);
    const h = turnHost({ signsIn: true });

    await handleContinueConversation('Use Postgres', h.deps);

    expect(h.installation.refresh).toHaveBeenCalledTimes(1);
    expect(h.installation.plannerUsability).toHaveBeenCalledWith('claude-code');
    expect(h.session.continueConversation).toHaveBeenCalledWith('Use Postgres');
    expect(h.chatProvider.showError).not.toHaveBeenCalled();
  });

  it('re-probes before a force send too', async () => {
    recordRunnerAuth('claude-code', SIGNED_OUT, workspace);
    const h = turnHost({ signsIn: true });

    await handleSendMessageNow('Use SQLite instead', h.deps);

    expect(h.installation.refresh).toHaveBeenCalledTimes(1);
    expect(h.session.forceSendPrompt).toHaveBeenCalledWith('Use SQLite instead');
    expect(h.chatProvider.showError).not.toHaveBeenCalled();
  });

  it('still refuses both when the account is genuinely signed out', async () => {
    recordRunnerAuth('claude-code', SIGNED_OUT, workspace);
    const h = turnHost({ signsIn: false });

    await handleContinueConversation('Use Postgres', h.deps);
    await handleSendMessageNow('Use SQLite instead', h.deps);

    expect(h.chatProvider.showError).toHaveBeenCalledTimes(2);
    expect(h.chatProvider.showError.mock.calls[0][0]).toContain('Claude Code not logged in');
    expect(h.chatProvider.showError.mock.calls[1][0]).toContain('Claude Code not logged in');
  });
});
