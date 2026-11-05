import { describe, expect, it } from 'vitest';
import { geminiCredentials } from '../geminiCredentials';
import { fakeSecret } from '../../__tests__/fakeSecret';

const KEY = fakeSecret('google');

const read = (env: Record<string, string | undefined>, kind: 'planner' | 'task' = 'task') =>
  geminiCredentials({ env, kind });

describe('geminiCredentials', () => {
  it('hands the Google key Ordewell holds as the variable Gemini CLI signs in from', async () => {
    expect(await read({ GEMINI_API_KEY: KEY })).toEqual({ GEMINI_API_KEY: KEY });
    expect(await read({ GEMINI_API_KEY: ` ${KEY} ` })).toEqual({ GEMINI_API_KEY: KEY });
  });

  it('adds nothing when Ordewell holds no Google key, whatever other vendors it has', async () => {
    expect(await read({})).toBeNull();
    expect(await read({ OPENROUTER_API_KEY: KEY, AI_PROVIDER: 'openrouter' })).toBeNull();
    expect(await read({ OPENAI_API_KEY: KEY, DEEPSEEK_API_KEY: KEY })).toBeNull();
  });

  it('leaves a key of the user\'s own in GOOGLE_API_KEY alone, which is their own route', async () => {
    expect(await read({ GEMINI_API_KEY: KEY, GOOGLE_API_KEY: 'the-users-own-google-key' })).toBeNull();
    expect(await read({ GOOGLE_API_KEY: 'the-users-own-google-key' })).toBeNull();
  });

  it('leaves a Vertex or Google-account route alone', async () => {
    for (const env of [
      { GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'a-project', GOOGLE_CLOUD_LOCATION: 'europe-west1' },
      { GOOGLE_CLOUD_PROJECT: 'a-project', GOOGLE_CLOUD_LOCATION: 'europe-west1' },
      { GOOGLE_GENAI_USE_GCA: 'true' },
      { GEMINI_CLI_USE_COMPUTE_ADC: 'true' },
      { CLOUD_SHELL: 'true' },
      { GOOGLE_APPLICATION_CREDENTIALS: '/home/person/service-account.json' },
      { GEMINI_CLI_AUTH_OVERRIDE: 'oauth-personal' },
      { GOOGLE_GEMINI_BASE_URL: 'https://gateway.example/v1' },
    ]) {
      expect(await read({ GEMINI_API_KEY: KEY, ...env }), JSON.stringify(Object.keys(env))).toBeNull();
    }
    // A Vertex switch alone, without the project and location Gemini needs for it, is no route.
    expect(await read({ GEMINI_API_KEY: KEY, GOOGLE_GENAI_USE_VERTEXAI: 'false' })).toEqual({ GEMINI_API_KEY: KEY });
    expect(await read({ GEMINI_API_KEY: KEY, GOOGLE_CLOUD_PROJECT: 'a-project' })).toEqual({ GEMINI_API_KEY: KEY });
  });

  it('hands the same key to a planner and to a task', async () => {
    expect(await read({ GEMINI_API_KEY: KEY }, 'planner')).toEqual({ GEMINI_API_KEY: KEY });
    expect(await read({ GEMINI_API_KEY: KEY }, 'task')).toEqual({ GEMINI_API_KEY: KEY });
  });
});
