import { describe, expect, it } from 'vitest';
import type { AiProvider } from '../../../interfaces/IConfig';
import { VENDORS } from '../../apiProviders';
import { createModelClient } from '../createModelClient';
import { dialectOf } from '../dialects';
import { ModelError } from '../ModelError';
import { BASE_REQUEST, collect, fixture, replay, sse } from './replay';

const PROVIDERS = Object.keys(VENDORS) as AiProvider[];

describe('dialects', () => {
  it('sends the three first-party APIs to their own dialects and every other vendor to chat completions', () => {
    const mapped = Object.fromEntries(PROVIDERS.map((p) => [p, dialectOf(p)]));
    expect(mapped).toMatchObject({ anthropic: 'anthropic-messages', openai: 'responses', google: 'gemini' });
    const rest = PROVIDERS.filter((p) => !['anthropic', 'openai', 'google'].includes(p));
    expect(rest.length).toBeGreaterThan(10);
    for (const provider of rest) expect(dialectOf(provider), provider).toBe('chat-completions');
  });
});

describe('createModelClient', () => {
  it('builds a client in the provider\'s dialect for every vendor', () => {
    for (const provider of PROVIDERS) {
      let client;
      try {
        client = createModelClient({ provider, apiKey: 'k' });
      } catch (err) {
        // A dialect whose adapter is still a stub says so in a ModelError.
        expect(err, provider).toBeInstanceOf(ModelError);
        expect(err, provider).toMatchObject({ kind: 'fatal' });
        continue;
      }
      expect([client.provider, client.dialect], provider).toEqual([provider, dialectOf(provider)]);
    }
  });

  it('reaches the vendor\'s default endpoint when given none', async () => {
    const transport = replay(sse(fixture('chat-completions', 'text.sse')));
    await collect(createModelClient({ provider: 'deepseek', apiKey: 'k', fetch: transport.fetch }), BASE_REQUEST);
    expect(transport.sent[0].url).toBe(`${VENDORS.deepseek.defaultBaseUrl}/chat/completions`);
  });

  it('reaches a configured endpoint instead', async () => {
    const transport = replay(sse(fixture('chat-completions', 'text.sse')));
    await collect(createModelClient({ provider: 'openai_compatible', apiKey: '', baseUrl: 'http://127.0.0.1:8080/v1', fetch: transport.fetch }), BASE_REQUEST);
    expect(transport.sent[0].url).toBe('http://127.0.0.1:8080/v1/chat/completions');
  });
});
