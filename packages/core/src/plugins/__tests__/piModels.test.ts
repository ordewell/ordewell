import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePiModels } from '../builtin/piModels';
import { PI_MANIFEST } from '../builtin/pi.manifest';

// `pi --list-models` from Pi 1.5.2, with Ollama's qwen3:8b configured, and with no provider at all.
const FIXTURES = path.join(__dirname, '../../services/__tests__/fixtures/pi');
const LIST = readFileSync(path.join(FIXTURES, 'list-models.txt'), 'utf8');
const NONE = readFileSync(path.join(FIXTURES, 'list-models-none.txt'), 'utf8');

describe('parsePiModels', () => {
  it('reads a recorded catalog as provider/model ids', () => {
    expect(parsePiModels(LIST, PI_MANIFEST)).toEqual([
      { modelId: 'ollama/qwen3:8b', modelLabel: 'qwen3:8b', runnerProvider: 'ollama', variants: [], contextWindow: 32_800, maxOutputTokens: 4_100 },
    ]);
  });

  it('offers the thinking levels on a model that thinks, and reads K and M sizes', () => {
    const table = [
      'provider   model              context  max-out  thinking  images',
      'anthropic  claude-sonnet-5.5  1M       64K      yes       yes',
      'openai     gpt-6-luna         400K     128K     yes       yes',
      'ollama     qwen3:8b           32.8K    4.1K     no        no',
    ].join('\n');
    const models = parsePiModels(table, PI_MANIFEST);

    expect(models.map((m) => m.modelId)).toEqual(['anthropic/claude-sonnet-5.5', 'openai/gpt-6-luna', 'ollama/qwen3:8b']);
    expect(models[0]).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 64_000 });
    expect(models[0].variants.map((v) => v.id)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(models[2].variants).toEqual([]);
  });

  it('finds no models when Pi has no provider signed in', () => {
    expect(NONE).toMatch(/^No models available/);
    expect(parsePiModels(NONE, PI_MANIFEST)).toEqual([]);
  });

  it('skips a duplicate row and a row too short to be a model', () => {
    const table = 'provider  model  context  max-out  thinking  images\nollama  a  1K  1K  no  no\nollama  a  1K  1K  no  no\nbroken\n';
    expect(parsePiModels(table, PI_MANIFEST).map((m) => m.modelId)).toEqual(['ollama/a']);
  });
});
