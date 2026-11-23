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

  // An agent planner with no model is a working state, so the setting must not read as one left unset (F6).
  it('does not call the planner model required: an agent plans with its own default', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { description?: string }> } };
    };
    const description = manifest.contributes.configuration.properties['ordewell.orchestratorModel'].description ?? '';
    expect(description).not.toMatch(/required/i);
    expect(description).toContain("the agent's own default");
  });
});
