import { afterEach, describe, it, expect } from 'vitest';
import { plannerNotReady, plannerNotReadyFor, describePlannerNotReady, TERMINAL_UI_COMMANDS, CHAT_COMMANDS, HEADLESS_CLI_COMMANDS, type PlannerNotReady, type PlannerReadinessConfig } from '../plannerReadiness';
import { recordRunnerAuth, resetRunnerAuth, runnerSignIn, type RunnerAuth } from '../runnerAuth';

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
      signIn: { runner: 'claude-code', label: 'Claude Code', login: ['claude', 'auth', 'login'] },
    });
  });

  it('asks the lookup it is given rather than the recorded verdict', () => {
    recordRunnerAuth('codex', { state: 'signed-in', loginCommand: ['codex', 'login'] });
    const asked: string[] = [];
    expect(plannerNotReady(config({ aiProvider: 'codex' }), (runner) => {
      asked.push(runner);
      return { state: 'signed-out', loginCommand: ['codex', 'login'] };
    })).toMatchObject({ code: 'signed_out', runner: 'codex', signIn: { login: ['codex', 'login'] } });
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
      'No planner is ready. Pick one with /planner: Claude Code, Codex, OpenCode, GitHub Copilot CLI, Qwen Code, Cline, Gemini CLI and Cursor plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with /key.',
    );
  });

  it('spells the same message with the headless CLI commands', () => {
    expect(describePlannerNotReady(noKey, HEADLESS_CLI_COMMANDS)).toBe(
      'No planner is ready. Pick one with ordewell planner <id>: Claude Code, Codex, OpenCode, GitHub Copilot CLI, Qwen Code, Cline, Gemini CLI and Cursor plan with no API key. ' +
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

  // The planner path: every built-in's hint, as the readiness gate words it.
  const PLANNER_TERMINAL: Record<string, string> = {
    'claude-code': 'Claude Code is not signed in. Sign in with /login claude-code, or run claude auth login. Then try again.',
    codex: 'Codex is not signed in. Sign in with /login codex, or run codex login. Then try again.',
    opencode: 'OpenCode is not signed in. Run opencode auth login and choose a provider. Then try again.',
    'copilot-cli': 'GitHub Copilot CLI is not signed in. Sign in with /login copilot-cli, or run copilot login. Then try again.',
    'cursor-agent': 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login. Then try again.',
    cline: 'Cline is not signed in. Sign in with /login cline, or run cline auth. Then try again.',
    'qwen-code': 'Qwen Code is not signed in. Run /key and choose OpenRouter (or any OpenAI-compatible provider) to hand it a key, or run qwen and sign in there. Then try again.',
    'gemini-cli': 'Gemini CLI is not signed in. Run gemini and choose how it signs in. Then try again.',
  };

  it.each(Object.keys(PLANNER_TERMINAL))('gives signed-out %s every way back in, in the chat\'s spelling', (runner) => {
    const signIn = runnerSignIn(runner)!;
    const reason: PlannerNotReady = { code: 'signed_out', provider: runner, label: signIn.label, runner, signIn };

    expect(describePlannerNotReady(reason, TERMINAL_UI_COMMANDS)).toBe(PLANNER_TERMINAL[runner]);
    expect(describePlannerNotReady(reason, CHAT_COMMANDS)).toBe(PLANNER_TERMINAL[runner]);
  });

  it('says the same thing once when the surface\'s own login is the runner\'s command', () => {
    const signIn = runnerSignIn('claude-code')!;
    const reason: PlannerNotReady = { code: 'signed_out', provider: 'claude-code', label: 'Claude Code', runner: 'claude-code', signIn };

    expect(describePlannerNotReady(reason, HEADLESS_CLI_COMMANDS)).toBe(
      'Claude Code is not signed in. Run claude auth login to sign in. Then try again.',
    );
  });
});
