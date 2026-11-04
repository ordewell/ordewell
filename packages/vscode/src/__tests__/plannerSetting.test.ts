import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { plannerSettingProblem } from '../plannerSetting';

describe('plannerSettingProblem', () => {
  it('accepts blank, a vendor and a runner that can plan', () => {
    for (const value of ['', 'google', 'openai_compatible', 'claude-code', 'codex', 'opencode', 'gemini-cli']) {
      expect(plannerSettingProblem(value)).toBeUndefined();
    }
  });

  it('names an unknown value and every choice', () => {
    // `gemini` is the vendor's name, never a runner's: Gemini CLI's id is `gemini-cli`.
    const problem = plannerSettingProblem('gemini');
    expect(problem).toContain('"gemini"');
    for (const id of ['claude-code', 'codex', 'opencode', 'gemini-cli', 'google', 'openrouter']) expect(problem).toContain(id);
  });

  it('is not shadowed by a static enum in package.json, which would go stale with the registry', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { enum?: unknown; enumDescriptions?: unknown }> } };
    };
    const setting = manifest.contributes.configuration.properties['ordewell.aiProvider'];
    expect(setting.enum).toBeUndefined();
    expect(setting.enumDescriptions).toBeUndefined();
  });
});
