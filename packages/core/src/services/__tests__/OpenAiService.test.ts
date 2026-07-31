import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';

const createSpy = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createSpy } };
  },
}));

import { OpenAiService } from '../OpenAiService';

function streamOf(chunks: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function cfg(over: Partial<IConfig> = {}): IConfig {
  return {
    aiProvider: 'openai',
    orchestratorModel: 'openai:gpt-4o',
    getProviderBaseUrl: () => 'https://api.openai.com/v1',
    getProviderApiKey: () => 'sk-test',
    ...over,
  } as unknown as IConfig;
}

/** Invoke the protected streamPlanText and return the model sent to the API. */
async function modelSentFor(config: IConfig): Promise<string> {
  createSpy.mockReturnValue(streamOf([{ choices: [{ delta: { content: 'ok' } }] }]));
  const service = new OpenAiService(config);
  await (service as unknown as {
    streamPlanText(p: string, h: string | undefined, onToken: (t: string) => void): Promise<string>;
  }).streamPlanText('prompt', undefined, () => {});
  return (createSpy.mock.calls[0][0] as { model: string }).model;
}

describe('OpenAiService model-id prefix stripping', () => {
  beforeEach(() => createSpy.mockClear());

  it('strips the provider prefix before sending the model to the API', async () => {
    expect(await modelSentFor(cfg())).toBe('gpt-4o');
  });

  it('passes openai_compat: models through as the bare id', async () => {
    const model = await modelSentFor(cfg({
      aiProvider: 'openai_compatible',
      orchestratorModel: 'openai_compat:llama3',
    } as Partial<IConfig>));
    expect(model).toBe('llama3');
  });

  it('leaves an unprefixed OpenRouter id untouched', async () => {
    const model = await modelSentFor(cfg({
      aiProvider: 'openrouter',
      orchestratorModel: 'openai/gpt-4o',
    } as Partial<IConfig>));
    expect(model).toBe('openai/gpt-4o');
  });
});
