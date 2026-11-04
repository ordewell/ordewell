import { afterEach, describe, it, expect } from 'vitest';
import { plannerNotReady, plannerNotReadyFor, describePlannerNotReady, TERMINAL_UI_COMMANDS, CHAT_COMMANDS, HEADLESS_CLI_COMMANDS, type PlannerNotReady, type PlannerReadinessConfig } from '../plannerReadiness';
import { recordRunnerAuth, resetRunnerAuth, type RunnerAuth } from '../runnerAuth';

function config(over: Partial<PlannerReadinessConfig> & { key?: string }): PlannerReadinessConfig {
  const { key = '', ...rest } = over;
  return {
    aiProvider: 'openrouter',
    planningModel: 'openai/gpt-5',
    openaiCompatibleBaseUrl: '',
    getProviderApiKey: () => key,
    ...rest,
  };
}

/** The same choices as a host hands the preflight: it adds the orchestrator model the vendor transports read. */
function hostConfig(over: Partial<PlannerReadinessConfig> & { key?: string }) {
  return { ...config(over), orchestratorModel: '' };
}

const signedOutClaude: RunnerAuth = {
  state: 'signed-out',
  loginCommand: ['claude', 'auth', 'login'],
  detail: 'not logged in',
};

afterEach(() => resetRunnerAuth());

describe('plannerNotReady', () => {
  for (const provider of ['claude-code', 'codex', 'opencode']) {
    it(`lets ${provider} plan with no key and no model — its subscription is the credential`, () => {
      expect(plannerNotReady(config({ aiProvider: provider, planningModel: '' }))).toBeNull();
    });
  }

  it('refuses a vendor with no key, naming the provider and its key variable', () => {
    expect(plannerNotReady(config({ aiProvider: 'openrouter' }))).toEqual({
      code: 'no_key',
      provider: 'openrouter',
      label: 'OpenRouter',
      keyEnvVar: 'OPENROUTER_API_KEY',
    });
  });

  it('refuses openai_compatible with no base URL even when a key is set', () => {
    expect(plannerNotReady(config({ aiProvider: 'openai_compatible', key: 'k' }))).toMatchObject({
      code: 'no_base_url',
      provider: 'openai_compatible',
      baseUrlEnvVar: 'OPENAI_COMPATIBLE_BASE_URL',
    });
  });

  it('lets a keyless openai_compatible endpoint plan once it has a base URL and a model', () => {
    expect(plannerNotReady(config({ aiProvider: 'openai_compatible', openaiCompatibleBaseUrl: 'http://localhost:11434/v1' }))).toBeNull();
  });

  it('refuses a keyed vendor with no model', () => {
    expect(plannerNotReady(config({ key: 'sk', planningModel: '' }))).toMatchObject({ code: 'no_model', provider: 'openrouter' });
  });

  it('passes a fully configured vendor', () => {
    expect(plannerNotReady(config({ key: 'sk' }))).toBeNull();
  });
});

describe('plannerNotReady — a signed-out coding agent', () => {
  it('refuses a harness planner whose recorded verdict is signed out, with its own login command', () => {
    recordRunnerAuth('claude-code', signedOutClaude);

    expect(plannerNotReadyFor(hostConfig({ aiProvider: 'claude-code', planningModel: '' }))).toEqual({
      code: 'signed_out',
      provider: 'claude-code',
      label: 'Claude Code',
      runner: 'claude-code',
      loginCommand: ['claude', 'auth', 'login'],
    });
  });

  it('asks the lookup it is given rather than the recorded verdict', () => {
    recordRunnerAuth('codex', { state: 'signed-in', loginCommand: ['codex', 'login'] });
    const asked: string[] = [];
    expect(plannerNotReady(config({ aiProvider: 'codex' }), (runner) => {
      asked.push(runner);
      return { state: 'signed-out', loginCommand: ['codex', 'login'] };
    })).toMatchObject({ code: 'signed_out', runner: 'codex', loginCommand: ['codex', 'login'] });
    expect(asked).toEqual(['codex']);
  });

  it('lets a signed-in or unknown agent plan — only the runner can say the user is out', () => {
    recordRunnerAuth('claude-code', { state: 'signed-in', loginCommand: ['claude', 'auth', 'login'] });
    expect(plannerNotReadyFor(hostConfig({ aiProvider: 'claude-code', planningModel: '' }))).toBeNull();

    recordRunnerAuth('claude-code', { state: 'unknown', loginCommand: ['claude', 'auth', 'login'] });
    expect(plannerNotReadyFor(hostConfig({ aiProvider: 'claude-code', planningModel: '' }))).toBeNull();

    resetRunnerAuth();
    expect(plannerNotReadyFor(hostConfig({ aiProvider: 'claude-code', planningModel: '' }))).toBeNull();
  });

  it('leaves a vendor planner judged by its key, whatever the agent verdict says', () => {
    recordRunnerAuth('claude-code', signedOutClaude);

    expect(plannerNotReadyFor(hostConfig({ aiProvider: 'openrouter' }))).toMatchObject({ code: 'no_key' });
    expect(plannerNotReadyFor(hostConfig({ aiProvider: 'openrouter', key: 'sk' }))).toBeNull();
  });
});

describe('describePlannerNotReady', () => {
  const noKey = plannerNotReady(config({ aiProvider: 'openrouter' }))!;

  it('leads a terminal user to /planner, naming the agents from the registry, and offers /key for the vendor', () => {
    expect(describePlannerNotReady(noKey, TERMINAL_UI_COMMANDS)).toBe(
      'No planner is ready. Pick one with /planner: Claude Code, Codex, OpenCode, GitHub Copilot CLI, Qwen Code, Gemini CLI and Cursor plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with /key.',
    );
  });

  it('spells the same message with the headless CLI commands', () => {
    expect(describePlannerNotReady(noKey, HEADLESS_CLI_COMMANDS)).toBe(
      'No planner is ready. Pick one with ordewell planner <id>: Claude Code, Codex, OpenCode, GitHub Copilot CLI, Qwen Code, Gemini CLI and Cursor plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with ordewell key set openrouter <key>.',
    );
  });

  it('points a missing base URL at the same escape hatch', () => {
    const reason = plannerNotReady(config({ aiProvider: 'openai_compatible' }))!;
    const text = describePlannerNotReady(reason, TERMINAL_UI_COMMANDS);
    expect(text).toContain('/planner');
    expect(text).toContain('OPENAI_COMPATIBLE_BASE_URL');
  });

  it('tells a model-less vendor to pick a model, in the surface\'s spelling', () => {
    const reason = plannerNotReady(config({ key: 'sk', planningModel: '' }))!;
    expect(describePlannerNotReady(reason, TERMINAL_UI_COMMANDS)).toBe('No planner model selected for OpenRouter. Pick one with /planner.');
    expect(describePlannerNotReady(reason, CHAT_COMMANDS)).toBe('No planner model selected for OpenRouter. Pick one with /planner.');
    expect(describePlannerNotReady(reason, HEADLESS_CLI_COMMANDS)).toContain('ordewell model set <id>');
  });

  it('gives a signed-out agent\'s two ways back in: the chat\'s /login, or its own command', () => {
    const reason: PlannerNotReady = {
      code: 'signed_out', provider: 'claude-code', label: 'Claude Code', runner: 'claude-code',
      loginCommand: ['claude', 'auth', 'login'],
    };

    expect(describePlannerNotReady(reason, TERMINAL_UI_COMMANDS)).toBe(
      'Claude Code not logged in. Sign in with /login, or run claude auth login and try again.',
    );
    expect(describePlannerNotReady(reason, CHAT_COMMANDS)).toBe(
      'Claude Code not logged in. Sign in with /login, or run claude auth login and try again.',
    );
  });

  it('says the same thing once when the surface\'s own login is the runner\'s command', () => {
    const reason: PlannerNotReady = {
      code: 'signed_out', provider: 'claude-code', label: 'Claude Code', runner: 'claude-code',
      loginCommand: ['claude', 'auth', 'login'],
    };

    expect(describePlannerNotReady(reason, HEADLESS_CLI_COMMANDS)).toBe(
      'Claude Code not logged in. Run claude auth login to sign in, then try again.',
    );
  });
});
