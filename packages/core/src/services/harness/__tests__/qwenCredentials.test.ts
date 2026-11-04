import { describe, expect, it } from 'vitest';
import { qwenCredentials } from '../qwenCredentials';

const KEY = 'sk-or-v1-ordewell-own-key-never-shown';

const read = (env: Record<string, string | undefined>, kind: 'planner' | 'task' = 'task') => qwenCredentials({ env, kind });

describe('qwenCredentials', () => {
  it('hands Qwen the OpenRouter key Ordewell holds as its OpenAI-compatible key, at OpenRouter\'s endpoint', async () => {
    expect(await read({ OPENROUTER_API_KEY: KEY })).toEqual({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' });
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
