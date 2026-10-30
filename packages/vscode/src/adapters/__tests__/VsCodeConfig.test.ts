import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { __setConfig, __setWorkspaceConfig, __resetConfig, configUpdates } from '../../test/vscode.mock';
import { VsCodeConfig, moveAutonomyFromVsCodeSetting, moveEnabledRunnersFromVsCodeSetting } from '../VsCodeConfig';
import { SecretStore } from '../SecretStore';
import { DEFAULT_WEB_READ_BUDGET, getProviderMeta, PROVIDER_DETECT_PRIORITY, recordInstalledPlanner, resetInstalledPlanner, SettingsService } from '@ordewell/core';

/** Build a loaded SecretStore backed by an in-memory map. */
async function makeStore(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const store = new SecretStore({
    async get(k: string) {
      return map.get(k);
    },
    async store(k: string, v: string) {
      map.set(k, v);
    },
    async delete(k: string) {
      map.delete(k);
    },
    onDidChange() {
      return { dispose() {} };
    },
  } as never);
  await store.load();
  return store;
}

// Every ORDEWELL_* var BaseConfig or VsCodeConfig reads, so a developer shell
// (the local .envrc exports several) cannot leak in and move a default.
const ENV_KEYS = ['ORDEWELL_WORKTREE_ISOLATION', 'ORDEWELL_WORKTREE_SETUP', 'ORDEWELL_CONFLICT_REPAIR_ATTEMPTS', 'ORDEWELL_WORKSPACE_REPOS', 'ORDEWELL_WORKTREE_LINKS', 'ORDEWELL_MAX_PARALLEL', 'ORDEWELL_RESEARCH_ENABLED', 'ORDEWELL_RESEARCH_MAX_STEPS', 'ORDEWELL_RESEARCH_MAX_FILE_SIZE', 'ORDEWELL_PLAN_MAP_ENABLED', 'ORDEWELL_AUTONOMOUS_MODE', 'ORDEWELL_APPROVAL_MODE', 'ORDEWELL_APPROVAL_ALLOW', 'ORDEWELL_EFFECT_ALLOW', 'ORDEWELL_NOTIFY_COMMAND', 'ORDEWELL_WEB_READ_BUDGET', 'ORDEWELL_PLANNER_NATIVE_SHELL', 'ORDEWELL_SUBAGENT_MODEL', 'ORDEWELL_PLANNER_EFFORT', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ORCHESTRATOR_MODEL', 'AI_PROVIDER'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetConfig();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __resetConfig();
});

describe('VsCodeConfig.worktreeIsolation', () => {
  it('defaults to on with no setup command', async () => {
    const store = await makeStore({});
    __setConfig({});
    const cfg = new VsCodeConfig(store);
    expect(cfg.worktreeIsolation).toBe(true);
    expect(cfg.worktreeSetupCommand).toBeUndefined();
  });

  it('reflects the ordewell settings', async () => {
    const store = await makeStore({});
    __setConfig({ worktreeIsolation: false, worktreeSetupCommand: 'pnpm i' });
    const cfg = new VsCodeConfig(store);
    expect(cfg.worktreeIsolation).toBe(false);
    expect(cfg.worktreeSetupCommand).toBe('pnpm i');
  });

  it('reads workspace repos and worktree links, trimming blanks', async () => {
    const store = await makeStore({});
    __setConfig({ workspaceRepos: ['libs/core', ' '], worktreeLinks: ['*.tfstate'] });
    const cfg = new VsCodeConfig(store);
    expect(cfg.workspaceRepos).toEqual(['libs/core']);
    expect(cfg.worktreeLinks).toEqual(['*.tfstate']);
  });

  it('falls back to the environment when the lists are not set', async () => {
    const store = await makeStore({});
    __setConfig({});
    process.env.ORDEWELL_WORKSPACE_REPOS = 'a/b';
    process.env.ORDEWELL_WORKTREE_LINKS = '.terraform/';
    const cfg = new VsCodeConfig(store);
    expect(cfg.workspaceRepos).toEqual(['a/b']);
    expect(cfg.worktreeLinks).toEqual(['.terraform/']);
  });

  it('lets ORDEWELL_WORKTREE_ISOLATION override the setting', async () => {
    const store = await makeStore({});
    __setConfig({ worktreeIsolation: true });
    process.env.ORDEWELL_WORKTREE_ISOLATION = 'false';
    expect(new VsCodeConfig(store).worktreeIsolation).toBe(false);
  });
});

describe('VsCodeConfig.conflictRepairAttempts', () => {
  it('allows two repairs by default', async () => {
    __setConfig({});
    expect(new VsCodeConfig(await makeStore({})).conflictRepairAttempts).toBe(2);
  });

  it('reads the setting, where 0 turns repair off', async () => {
    __setConfig({ conflictRepairAttempts: 0 });
    expect(new VsCodeConfig(await makeStore({})).conflictRepairAttempts).toBe(0);
  });

  it('keeps the default for a setting that is not a non-negative integer', async () => {
    __setConfig({ conflictRepairAttempts: -1 });
    expect(new VsCodeConfig(await makeStore({})).conflictRepairAttempts).toBe(2);
  });

  it('lets ORDEWELL_CONFLICT_REPAIR_ATTEMPTS override the setting', async () => {
    __setConfig({ conflictRepairAttempts: 3 });
    process.env.ORDEWELL_CONFLICT_REPAIR_ATTEMPTS = '0';
    expect(new VsCodeConfig(await makeStore({})).conflictRepairAttempts).toBe(0);
  });
});

describe('VsCodeConfig.webReadBudget', () => {
  it('reads the setting, and keeps the default for one that is not a non-negative integer', async () => {
    __setConfig({ plannerWebReadBudget: 12 });
    expect(new VsCodeConfig(await makeStore({})).webReadBudget).toBe(12);
    __setConfig({ plannerWebReadBudget: -3 });
    expect(new VsCodeConfig(await makeStore({})).webReadBudget).toBe(DEFAULT_WEB_READ_BUDGET);
  });

  it('lets ORDEWELL_WEB_READ_BUDGET override the setting', async () => {
    __setConfig({ plannerWebReadBudget: 12 });
    process.env.ORDEWELL_WEB_READ_BUDGET = '0';
    expect(new VsCodeConfig(await makeStore({})).webReadBudget).toBe(0);
  });
});

describe('VsCodeConfig.plannerNativeShell (ADR-0036 N1)', () => {
  it('is off by default', async () => {
    __setConfig({});
    expect(new VsCodeConfig(await makeStore({})).plannerNativeShell).toBe(false);
  });

  it('reads the setting', async () => {
    __setConfig({ plannerNativeShell: true });
    expect(new VsCodeConfig(await makeStore({})).plannerNativeShell).toBe(true);
  });

  it('lets ORDEWELL_PLANNER_NATIVE_SHELL override the setting', async () => {
    __setConfig({ plannerNativeShell: false });
    process.env.ORDEWELL_PLANNER_NATIVE_SHELL = 'true';
    expect(new VsCodeConfig(await makeStore({})).plannerNativeShell).toBe(true);
  });
});

describe('VsCodeConfig.notifyCommand (ADR-0053)', () => {
  it('is empty by default', async () => {
    expect(new VsCodeConfig(await makeStore({})).notifyCommand).toEqual([]);
  });

  it("reads the user's setting word for word", async () => {
    __setConfig({ notifyCommand: ['notify-send', ' Ordewell run '] });
    expect(new VsCodeConfig(await makeStore({})).notifyCommand).toEqual(['notify-send', ' Ordewell run ']);
  });

  it('refuses a workspace value: a repository must not run a command on the machine', async () => {
    __setWorkspaceConfig({ notifyCommand: ['sh', '-c', 'evil'] });
    expect(new VsCodeConfig(await makeStore({})).notifyCommand).toEqual([]);
  });

  it('falls back to ORDEWELL_NOTIFY_COMMAND, the setting winning', async () => {
    process.env.ORDEWELL_NOTIFY_COMMAND = '["notify-send", "from the shell"]';
    expect(new VsCodeConfig(await makeStore({})).notifyCommand).toEqual(['notify-send', 'from the shell']);

    __setConfig({ notifyCommand: ['notify-send', 'from the setting'] });
    expect(new VsCodeConfig(await makeStore({})).notifyCommand).toEqual(['notify-send', 'from the setting']);
  });
});

describe('VsCodeConfig.effectAllowlist (ADR-0035)', () => {
  it('has no rules unless the user writes some', async () => {
    expect(new VsCodeConfig(await makeStore({})).effectAllowlist).toEqual([]);
  });

  it('reads the setting, trimming blanks, beside ORDEWELL_EFFECT_ALLOW', async () => {
    __setConfig({ effectAllowlist: [' git push origin feature/* ', ''] });
    process.env.ORDEWELL_EFFECT_ALLOW = 'gh pr merge *, make release';
    expect(new VsCodeConfig(await makeStore({})).effectAllowlist).toEqual(['git push origin feature/*', 'gh pr merge *', 'make release']);
  });
});

describe('the autonomy level (ADR-0030)', () => {
  const savedPath = process.env.ORDEWELL_SETTINGS_PATH;
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-vscode-autonomy-'));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is the level saved in the user\'s settings, which every surface shares', async () => {
    const config = new VsCodeConfig(await makeStore({}));
    expect(config.autonomousMode).toBe(false);

    new SettingsService().setAutonomousMode(true);

    expect(config.autonomousMode).toBe(true);
  });

  it('copies a level set in the old VS Code setting once, then clears that setting', async () => {
    __setConfig({ autonomousMode: false });

    await moveAutonomyFromVsCodeSetting(new SettingsService());

    expect(new SettingsService().getAll().autonomousMode).toBe(false);
    expect(configUpdates).toContainEqual({ key: 'autonomousMode', value: undefined });
  });

  it('keeps a level already saved over the old VS Code setting', async () => {
    new SettingsService().setAutonomousMode(true);
    __setConfig({ autonomousMode: false });

    await moveAutonomyFromVsCodeSetting(new SettingsService());

    expect(new SettingsService().autonomousMode()).toBe(true);
  });
});

describe('the enabled runners (one store with every other surface)', () => {
  const savedPath = process.env.ORDEWELL_SETTINGS_PATH;
  const savedRunners = process.env.ORDEWELL_RUNNERS;
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-vscode-runners-'));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    delete process.env.ORDEWELL_RUNNERS;
    resetInstalledPlanner();
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = savedPath;
    if (savedRunners === undefined) delete process.env.ORDEWELL_RUNNERS;
    else process.env.ORDEWELL_RUNNERS = savedRunners;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('are the list saved in the user\'s settings, which every surface shares', async () => {
    const config = new VsCodeConfig(await makeStore({}));

    new SettingsService().setEnabledRunners(['codex', 'opencode']);

    expect(config.enabledRunners).toEqual(['codex', 'opencode']);
  });

  it('ignore the old VS Code setting once the file has a choice, whichever scope set it', async () => {
    new SettingsService().setEnabledRunners(['codex']);
    __setConfig({ enabledRunners: ['opencode'] });
    __setWorkspaceConfig({ enabledRunners: ['claude-code'] });

    expect(new VsCodeConfig(await makeStore({})).enabledRunners).toEqual(['codex']);
  });

  it('keep a saved empty choice distinct from never having chosen', async () => {
    new SettingsService().setEnabledRunners([]);

    expect(new VsCodeConfig(await makeStore({})).enabledRunners).toEqual([]);
  });

  describe('moving the old VS Code setting', () => {
    it('copies the user\'s value once, then clears it', async () => {
      __setConfig({ enabledRunners: ['opencode', 'codex'] });

      await moveEnabledRunnersFromVsCodeSetting(new SettingsService());

      expect(new SettingsService().getEnabledRunners()).toEqual(['opencode', 'codex']);
      expect(configUpdates).toContainEqual({ key: 'enabledRunners', value: undefined });
      expect(new VsCodeConfig(await makeStore({})).enabledRunners).toEqual(['opencode', 'codex']);
    });

    it('takes the workspace\'s value over the user\'s, as VS Code itself does, and clears both', async () => {
      __setConfig({ enabledRunners: ['codex'] });
      __setWorkspaceConfig({ enabledRunners: ['opencode'] });

      await moveEnabledRunnersFromVsCodeSetting(new SettingsService());

      expect(new SettingsService().getEnabledRunners()).toEqual(['opencode']);
      expect(configUpdates.filter((u) => u.key === 'enabledRunners')).toHaveLength(2);
    });

    it('takes a workspace value when the user set none', async () => {
      __setWorkspaceConfig({ enabledRunners: ['opencode'] });

      await moveEnabledRunnersFromVsCodeSetting(new SettingsService());

      expect(new SettingsService().getEnabledRunners()).toEqual(['opencode']);
    });

    it('does not make an empty list a machine-wide choice, but still clears it', async () => {
      __setConfig({ enabledRunners: [] });

      await moveEnabledRunnersFromVsCodeSetting(new SettingsService());

      expect(new SettingsService().getEnabledRunners()).toBeUndefined();
      expect(configUpdates).toContainEqual({ key: 'enabledRunners', value: undefined });
    });

    it('passes over an empty workspace list for the user\'s real choice', async () => {
      __setConfig({ enabledRunners: ['codex'] });
      __setWorkspaceConfig({ enabledRunners: [] });

      await moveEnabledRunnersFromVsCodeSetting(new SettingsService());

      expect(new SettingsService().getEnabledRunners()).toEqual(['codex']);
    });

    it('keeps a choice already saved over the old setting, and still clears the old one', async () => {
      new SettingsService().setEnabledRunners(['claude-code']);
      __setConfig({ enabledRunners: ['opencode'] });

      await moveEnabledRunnersFromVsCodeSetting(new SettingsService());

      expect(new SettingsService().getEnabledRunners()).toEqual(['claude-code']);
      expect(configUpdates).toContainEqual({ key: 'enabledRunners', value: undefined });
    });

    it('does nothing when the old setting was never set', async () => {
      await moveEnabledRunnersFromVsCodeSetting(new SettingsService());

      expect(new SettingsService().getEnabledRunners()).toBeUndefined();
      expect(configUpdates).toEqual([]);
    });
  });
});

describe('VsCodeConfig.openrouterKey resolution chain', () => {
  it('prefers the SecretStore value over VS Config and env', async () => {
    const store = await makeStore({ openrouterKey: 'sk-secret' });
    __setConfig({ openAiApiKey: 'sk-config' });
    process.env.OPENROUTER_API_KEY = 'sk-env';

    const config = new VsCodeConfig(store);

    expect(config.openrouterKey).toBe('sk-secret');
  });

  it('falls back to VS Config when SecretStore has no key', async () => {
    const store = await makeStore({});
    __setConfig({ openAiApiKey: 'sk-config' });
    process.env.OPENROUTER_API_KEY = 'sk-env';

    expect(new VsCodeConfig(store).openrouterKey).toBe('sk-config');
  });

  it('falls back to env when neither SecretStore nor VS Config is set', async () => {
    const store = await makeStore({});
    process.env.OPENROUTER_API_KEY = 'sk-env';

    expect(new VsCodeConfig(store).openrouterKey).toBe('sk-env');
  });
});

describe('VsCodeConfig.geminiKey resolution chain', () => {
  it('prefers SecretStore, then VS Config (apiKey), then env', async () => {
    const secret = await makeStore({ geminiKey: 'g-secret' });
    __setConfig({ apiKey: 'g-config' });
    process.env.GEMINI_API_KEY = 'g-env';
    expect(new VsCodeConfig(secret).geminiKey).toBe('g-secret');

    const noSecret = await makeStore({});
    __setConfig({ apiKey: 'g-config' });
    expect(new VsCodeConfig(noSecret).geminiKey).toBe('g-config');

    __setConfig({});
    expect(new VsCodeConfig(noSecret).geminiKey).toBe('g-env');
  });
});

describe('VsCodeConfig.configuredProviders', () => {
  it('reflects which keys resolve to a non-empty value', async () => {
    expect(new VsCodeConfig(await makeStore({})).configuredProviders).toEqual([]);
    expect(new VsCodeConfig(await makeStore({ openrouterKey: 'sk' })).configuredProviders).toEqual(['openrouter']);
    expect(new VsCodeConfig(await makeStore({ geminiKey: 'g' })).configuredProviders).toEqual(['google']);
    expect(new VsCodeConfig(await makeStore({ openrouterKey: 'sk', geminiKey: 'g' })).configuredProviders).toEqual(['openrouter', 'google']);

    // openai_compatible is detected from its base URL config setting, not just key
    __setConfig({ openaiCompatibleBaseUrl: 'http://localhost:11434/v1' });
    expect(new VsCodeConfig(await makeStore({})).configuredProviders).toEqual(['openai_compatible']);
    __setConfig({});
  });
});

describe('VsCodeConfig.planningModel fallback chain', () => {
  it('falls back to orchestratorModel config key (not just env ORCHESTRATOR_MODEL)', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or' });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: [], openai_compatible: [] });

    // planningModel should be empty when nothing is set
    expect(config.planningModel).toBe('');

    // Set orchestratorModel via /model set path
    __setConfig({ orchestratorModel: 'openai/gpt-5' });
    expect(config.planningModel).toBe('openai/gpt-5');
  });

  it('still prefers explicit planningModel over orchestratorModel', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or' });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: [], openai_compatible: [] });

    __setConfig({ planningModel: 'openai/gpt-5-plan', orchestratorModel: 'openai/gpt-5-orch' });
    expect(config.planningModel).toBe('openai/gpt-5-plan');
  });
});

describe('VsCodeConfig.openAiApiKey resolution', () => {
  it('checks SecretStore in addition to VS Config and env', async () => {
    const store = await makeStore({ openrouterKey: 'sk-secret' });
    const config = new VsCodeConfig(store);

    // empty when nothing is set
    expect(config.openAiApiKey).toBe('sk-secret');

    // prefers SecretStore over VS Config
    __setConfig({ openAiApiKey: 'sk-config' });
    expect(config.openAiApiKey).toBe('sk-secret');
  });

  it('falls back to VS Config when SecretStore is empty', async () => {
    const store = await makeStore({});
    const config = new VsCodeConfig(store);
    __setConfig({ openAiApiKey: 'sk-config' });
    expect(config.openAiApiKey).toBe('sk-config');
  });

  it('falls back to env when neither SecretStore nor Config is set', async () => {
    const store = await makeStore({});
    const config = new VsCodeConfig(store);
    process.env.OPENROUTER_API_KEY = 'sk-env';
    expect(config.openAiApiKey).toBe('sk-env');
    delete process.env.OPENROUTER_API_KEY;
  });
});

describe('VsCodeConfig.apiKey', () => {
  afterEach(() => resetInstalledPlanner());

  it('uses the OpenRouter key when the active provider is openrouter', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or' });
    // A stored key is a vendor key, so even with an agent installed nothing moves the planner off openrouter.
    recordInstalledPlanner('claude-code');
    const config = new VsCodeConfig(store);
    expect(config.aiProvider).toBe('openrouter');
    expect(config.apiKey).toBe('sk-or');
  });

  it('with several stored keys, picks the vendor first in detection order, as the environment does', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or', geminiKey: 'g' });
    recordInstalledPlanner('claude-code');
    const config = new VsCodeConfig(store);
    expect(config.aiProvider).toBe('google');
    expect(config.apiKey).toBe('g');
  });

  it('resolves the Gemini key from the orchestrator model provider', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or', geminiKey: 'g-key' });
    __setConfig({ orchestratorModel: 'gemini-2.5-pro' });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: ['gemini-2.5-pro'], openai_compatible: [] });

    expect(config.apiKey).toBe('g-key');
  });

  it('never hands a vendor planner another vendor\'s key', async () => {
    // Google is chosen, but only an OpenRouter key is set: Google would reject
    // it as a bad credential, where no key lets the preflight name the gap.
    const store = await makeStore({ openrouterKey: 'sk-or' });
    __setConfig({ aiProvider: 'google', orchestratorModel: 'gemini-2.5-pro' });
    const config = new VsCodeConfig(store);

    expect(config.apiKey).toBe('');
  });
});

describe('Full user workflow: SecretStore + /model set + planningModel + openAiApiKey', () => {
  it('end-to-end: key in SecretStore, model set via config.update, both getters resolve', async () => {
    // Simulate user having configured an API key via "Ordewell: Configure API Key"
    const realKey = 'sk-or-v1-test-key-do-not-use';
    const store = await makeStore({ openrouterKey: realKey });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: [], openai_compatible: [] });

    // Phase 1: user has NOT set a model yet
    // openAiApiKey resolves from SecretStore (Bug 2 fix verified)
    expect(config.openAiApiKey).toBe(realKey);
    // apiKey also resolves (early guard in handleGeneratePlan / handleModifyPlan)
    expect(config.apiKey).toBe(realKey);
    // planningModel is empty — would trigger "No orchestrator model selected" (Bug 1)
    expect(config.planningModel).toBe('');

    // Phase 2: user runs /model set openai/gpt-5 (writes to orchestratorModel config key)
    __setConfig({ orchestratorModel: 'openai/gpt-5' });

    // After /model set: planningModel now falls back to orchestratorModel (Bug 1 fix verified)
    expect(config.planningModel).toBe('openai/gpt-5');
    // openAiApiKey still resolves (would fail in OpenAiService without Bug 2 fix)
    expect(config.openAiApiKey).toBe(realKey);
    // apiKey still resolves
    expect(config.apiKey).toBe(realKey);

    // Phase 3: switched to google provider with orchestratorModel still set
    __setConfig({ orchestratorModel: '', planningModel: 'gemini-2.5-pro' });
    config.setProviderModelLists({ openrouter: [], google: ['gemini-2.5-pro'], openai_compatible: [] });
    // With Google provider, planningModel falls back through the Google-specific chain
    expect(config.planningModel).toBe('gemini-2.5-pro');
  });

  it('no key configured → both guards fail', async () => {
    const store = await makeStore({});
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: [], openai_compatible: [] });

    expect(config.apiKey).toBe('');
    expect(config.openAiApiKey).toBe('');
    expect(config.planningModel).toBe('');
  });
});

describe('VsCodeConfig.aiProvider with an installed coding agent (ADR-0009)', () => {
  const saved: Record<string, string | undefined> = {};
  // Every variable detection reads, so a key in the developer's own shell cannot decide a case.
  const keys = PROVIDER_DETECT_PRIORITY.flatMap((p) => {
    const meta = getProviderMeta(p);
    return [...meta.detectEnvVars, ...(meta.baseUrlEnvVar ? [meta.baseUrlEnvVar] : [])];
  });
  beforeEach(() => { for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    resetInstalledPlanner();
  });

  it('plans with the installed agent when no key is held anywhere', async () => {
    recordInstalledPlanner('claude-code');
    expect(new VsCodeConfig(await makeStore({})).aiProvider).toBe('claude-code');
  });

  it('does not keep an openrouter answer read before the activation probe recorded the agent', async () => {
    const config = new VsCodeConfig(await makeStore({}));
    expect(config.aiProvider).toBe('openrouter');

    recordInstalledPlanner('claude-code');

    expect(config.aiProvider).toBe('claude-code');
  });

  it('the aiProvider setting wins over the installed agent', async () => {
    recordInstalledPlanner('claude-code');
    __setConfig({ aiProvider: 'codex' });
    expect(new VsCodeConfig(await makeStore({})).aiProvider).toBe('codex');
  });

  it('keeps an explicit OpenRouter choice even without its key', async () => {
    recordInstalledPlanner('claude-code');
    __setConfig({ aiProvider: 'openrouter' });
    const config = new VsCodeConfig(await makeStore({}));
    expect(config.aiProvider).toBe('openrouter');
    expect(config.apiKey).toBe('');
  });

  it('uses a vendor environment key before the detected agent', async () => {
    recordInstalledPlanner('claude-code');
    process.env.GEMINI_API_KEY = 'g-test';
    expect(new VsCodeConfig(await makeStore({})).aiProvider).toBe('google');
  });

  it('keeps the detected agent with a stale vendor model and no key', async () => {
    recordInstalledPlanner('claude-code');
    __setConfig({ orchestratorModel: 'openai/gpt-4o' });
    const config = new VsCodeConfig(await makeStore({}));
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] });
    expect(config.aiProvider).toBe('claude-code');
  });

  it('a stale vendor model with that vendor\'s stored key still picks the vendor', async () => {
    recordInstalledPlanner('claude-code');
    __setConfig({ orchestratorModel: 'gemini-2.5-pro' });
    const config = new VsCodeConfig(await makeStore({ geminiKey: 'g-secret' }));
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: ['gemini-2.5-pro'], openai_compatible: [] });
    expect(config.aiProvider).toBe('google');
  });

  it('the aiProvider setting wins over a stale vendor model and the installed agent', async () => {
    recordInstalledPlanner('claude-code');
    __setConfig({ aiProvider: 'codex', orchestratorModel: 'openai/gpt-4o' });
    const config = new VsCodeConfig(await makeStore({}));
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] });
    expect(config.aiProvider).toBe('codex');
  });

  it('a stored vendor key with no model still wins over the installed agent', async () => {
    recordInstalledPlanner('claude-code');
    const config = new VsCodeConfig(await makeStore({ openrouterKey: 'sk-secret' }));
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] });
    expect(config.aiProvider).toBe('openrouter');
  });

  it('with no installed agent a keyless vendor model still names its vendor', async () => {
    __setConfig({ orchestratorModel: 'gemini-2.5-pro' });
    const config = new VsCodeConfig(await makeStore({}));
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: ['gemini-2.5-pro'], openai_compatible: [] });
    expect(config.aiProvider).toBe('google');
  });

  it('moves to the model\'s vendor when its key is stored after a read', async () => {
    recordInstalledPlanner('claude-code');
    __setConfig({ orchestratorModel: 'openai/gpt-4o' });
    const store = await makeStore({});
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] });
    expect(config.aiProvider).toBe('claude-code');

    await store.set('openrouterKey', 'sk-secret');

    expect(config.aiProvider).toBe('openrouter');
  });

  it('an explicit AI_PROVIDER in the environment wins over a keyed vendor list that holds the model', async () => {
    process.env.AI_PROVIDER = 'google';
    __setConfig({ orchestratorModel: 'openai/gpt-4o' });
    const config = new VsCodeConfig(await makeStore({ openrouterKey: 'sk-secret', geminiKey: 'g-secret' }));
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] });
    expect(config.aiProvider).toBe('google');
  });

  // The same instance must answer what a fresh one would: the extension keeps
  // one config for its whole life, so a stale memo outlives the change.
  it('the same instance follows an AI_PROVIDER set in the environment after a read', async () => {
    recordInstalledPlanner('claude-code');
    const config = new VsCodeConfig(await makeStore({}));
    expect(config.aiProvider).toBe('claude-code');

    process.env.AI_PROVIDER = 'codex';

    expect(config.aiProvider).toBe('codex');
  });

  it('the same instance goes back to the agent when the last stored key is removed', async () => {
    recordInstalledPlanner('claude-code');
    __setConfig({ orchestratorModel: 'openai/gpt-4o' });
    const store = await makeStore({ openrouterKey: 'sk-secret' });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] });
    expect(config.aiProvider).toBe('openrouter');

    await store.set('openrouterKey', '');

    expect(config.aiProvider).toBe('claude-code');
  });

  it('the same instance follows an orchestratorModel edited outside update()', async () => {
    const config = new VsCodeConfig(await makeStore({ openrouterKey: 'sk-secret', geminiKey: 'g-secret' }));
    config.setProviderModelLists({ openrouter: ['openai/gpt-4o'], google: ['gemini-2.5-pro'], openai_compatible: [] });
    __setConfig({ orchestratorModel: 'openai/gpt-4o' });
    expect(config.aiProvider).toBe('openrouter');

    __setConfig({ orchestratorModel: 'gemini-2.5-pro' });

    expect(config.aiProvider).toBe('google');
  });

});
