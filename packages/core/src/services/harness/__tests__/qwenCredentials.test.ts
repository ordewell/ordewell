import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalog } from '../../ModelCatalog';
import { qwenCredentials } from '../qwenCredentials';

const KEY = 'sk-or-v1-ordewell-own-key-never-shown';

const read = (env: Record<string, string | undefined>, kind: 'planner' | 'task' = 'task') => qwenCredentials({ env, kind });

const OPENROUTER = 'https://openrouter.ai/api/v1';

/** The catalog OpenRouter answers this key with, fetched and held the way the daemon's model list holds it. */
async function holdCatalog(models: Array<{ id: string; supported_parameters?: string[] }>): Promise<void> {
  ModelCatalog.clearCache(OPENROUTER);
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: models.map((m) => ({ name: m.id, ...m })) })));
  await ModelCatalog.fetchModels(KEY, OPENROUTER);
}

describe('qwenCredentials', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    ModelCatalog.clearCache(OPENROUTER);
  });

  it('hands Qwen the OpenRouter key Ordewell holds as its OpenAI-compatible key, at OpenRouter\'s endpoint, on Qwen\'s own default model', async () => {
    // Qwen 0.26.6 signs in from these variables only with a model among them.
    // Its default, qwen3.7-max, is qwen/qwen3.7-max in OpenRouter's catalog.
    expect(await read({ OPENROUTER_API_KEY: KEY })).toEqual({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', OPENAI_MODEL: 'qwen/qwen3.7-max' });
  });

  it('hands a Qwen model the account is served when the catalog Ordewell fetched with the key leaves out Qwen\'s default', async () => {
    // OpenRouter lists to a key only what the account's privacy settings let it
    // reach: one that requires zero data retention is not served qwen3.7-max.
    await holdCatalog([{ id: 'openai/gpt-5.2' }, { id: 'qwen/qwen3.8-27b' }, { id: 'qwen/qwen3.6-27b' }]);
    expect(await read({ OPENROUTER_API_KEY: KEY })).toMatchObject({ OPENAI_MODEL: 'qwen/qwen3.8-27b' });
    await holdCatalog([{ id: 'qwen/qwen3.8-27b' }, { id: 'qwen/qwen3.7-max' }]);
    expect(await read({ OPENROUTER_API_KEY: KEY })).toMatchObject({ OPENAI_MODEL: 'qwen/qwen3.7-max' });
  });

  it('passes over a model of Qwen\'s family the catalog says takes no tools, as Qwen works by calling them', async () => {
    await holdCatalog([
      { id: 'qwen/qwen-2.5-coder-32b-instruct', supported_parameters: ['temperature', 'max_tokens'] },
      { id: 'qwen/qwen3.8-27b', supported_parameters: ['temperature', 'tools'] },
    ]);
    expect(await read({ OPENROUTER_API_KEY: KEY })).toMatchObject({ OPENAI_MODEL: 'qwen/qwen3.8-27b' });
  });

  it('hands the vendor\'s own id of the model a start names in Qwen\'s runtime form, over the planner\'s', async () => {
    const env = { DEEPSEEK_API_KEY: KEY, AI_PROVIDER: 'deepseek', ORCHESTRATOR_MODEL: 'deepseek:deepseek-chat' };
    expect(await qwenCredentials({ env, kind: 'task', model: '$runtime|openai|deepseek-reasoner(openai)' }))
      .toMatchObject({ OPENAI_MODEL: 'deepseek-reasoner' });
    // The form Qwen lists a model of its own settings in is not the vendor's id.
    expect(await qwenCredentials({ env, kind: 'task', model: 'deepseek-reasoner(openai)' })).toMatchObject({ OPENAI_MODEL: 'deepseek-chat' });
  });

  it('hands no model for a vendor whose name for Qwen\'s default is not known, where no planner model is that vendor\'s', async () => {
    expect(await read({ GROQ_API_KEY: KEY })).toEqual({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://api.groq.com/openai/v1' });
  });

  it('hands the vendor AI_PROVIDER names, with the planner\'s model as Qwen\'s unless the user chose one', async () => {
    const env = { OPENROUTER_API_KEY: 'sk-or-v1-not-chosen', DEEPSEEK_API_KEY: KEY, AI_PROVIDER: 'deepseek', ORCHESTRATOR_MODEL: 'deepseek:deepseek-chat' };
    expect(await read(env)).toEqual({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://api.deepseek.com/v1', OPENAI_MODEL: 'deepseek-chat' });
    expect(await read({ ...env, OPENAI_MODEL: 'deepseek-reasoner' })).toEqual({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://api.deepseek.com/v1' });
  });

  it('adds nothing when the user pointed Qwen at an endpoint of their own, which their key belongs to', async () => {
    expect(await read({ OPENAI_API_KEY: 'sk-the-users-own', OPENAI_BASE_URL: 'https://llm.example/v1', OPENROUTER_API_KEY: KEY })).toBeNull();
  });

  it('adds nothing when Ordewell holds no OpenAI-compatible key, so Qwen signs in from its own settings', async () => {
    expect(await read({})).toBeNull();
    expect(await read({ GEMINI_API_KEY: KEY, AI_PROVIDER: 'google', OPENAI_COMPATIBLE_API_KEY: KEY })).toBeNull();
  });
});
