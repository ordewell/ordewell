import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __setConfig, __resetConfig } from '../../test/vscode.mock';
import { VsCodeConfig } from '../VsCodeConfig';
import { SecretStore } from '../SecretStore';

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

const ENV_KEYS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ORCHESTRATOR_MODEL', 'AI_PROVIDER'];
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

describe('VsCodeConfig.autonomousMode', () => {
  it('defaults to true when the setting is unset', async () => {
    const store = await makeStore({});
    __setConfig({});
    expect(new VsCodeConfig(store).autonomousMode).toBe(true);
  });

  it('reflects the ordewell.autonomousMode setting when explicitly false', async () => {
    const store = await makeStore({});
    __setConfig({ autonomousMode: false });
    expect(new VsCodeConfig(store).autonomousMode).toBe(false);
  });

  it('reflects the ordewell.autonomousMode setting when explicitly true', async () => {
    const store = await makeStore({});
    __setConfig({ autonomousMode: true });
    expect(new VsCodeConfig(store).autonomousMode).toBe(true);
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
  it('uses the OpenRouter key when the active provider is openrouter', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or', geminiKey: 'g' });
    // no orchestrator model + no env override → detectProvider falls back to openrouter
    expect(new VsCodeConfig(store).apiKey).toBe('sk-or');
  });

  it('resolves the Gemini key from the orchestrator model provider', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or', geminiKey: 'g-key' });
    __setConfig({ orchestratorModel: 'gemini-2.5-pro' });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: ['gemini-2.5-pro'], openai_compatible: [] });

    expect(config.apiKey).toBe('g-key');
  });

  it('falls back to the other provider key when the active provider has none', async () => {
    // active provider resolves to google, but only an OpenRouter key is set
    const store = await makeStore({ openrouterKey: 'sk-or' });
    __setConfig({ orchestratorModel: 'gemini-2.5-pro' });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: ['gemini-2.5-pro'], openai_compatible: [] });

    expect(config.apiKey).toBe('sk-or');
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
