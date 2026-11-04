import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCopilotModels } from '../builtin/copilotModels';
import { COPILOT_CLI_MANIFEST } from '../builtin/copilot-cli.manifest';

const HELP_CONFIG = readFileSync(path.join(__dirname, '../../services/__tests__/fixtures/acp/copilot-cli/help-config.txt'), 'utf8');

describe('parseCopilotModels', () => {
  it('reads the model catalog from `copilot help config`, in its order', () => {
    const models = parseCopilotModels(HELP_CONFIG, COPILOT_CLI_MANIFEST);

    expect(models[0]).toEqual({ modelId: 'claude-sonnet-5.5', modelLabel: 'claude-sonnet-5.5', variants: [] });
    expect(models.map((m) => m.modelId)).toContain('gpt-6-luna');
    expect(models.at(-1)?.modelId).toBe('kimi-k3');
    expect(models).toHaveLength(31);
  });

  it('stops at the end of the model setting, so a later setting\'s values are not models', () => {
    const text = '  `model`: AI model to use.\n    - "a"\n    - "b"\n\n  `theme`: colours.\n    - "dark"\n';

    expect(parseCopilotModels(text, COPILOT_CLI_MANIFEST).map((m) => m.modelId)).toEqual(['a', 'b']);
  });

  it('finds no models in text without the model setting', () => {
    expect(parseCopilotModels('error: unknown command\n', COPILOT_CLI_MANIFEST)).toEqual([]);
  });
});
