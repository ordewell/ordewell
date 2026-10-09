import { describe, it, expect } from 'vitest';
import { DEFAULT_PLANNER_MODES, plannerModesFrom } from '../plannerModes';
import { buildResearchPrompt } from '../PlanPrompts';
import { sessionRuntimeSettings } from '../createSession';

describe('planner modes', () => {
  it('carries what a host reads off disk for a Session', () => {
    expect(sessionRuntimeSettings({ modelAllowlist: { opencode: ['a/b'] }, enabledRunners: ['codex'] })).toEqual({
      modelAllowlist: { opencode: ['a/b'] },
      enabledRunners: ['codex'],
    });
  });

  it('starts from the defaults before the run\'s isolation is known', () => {
    expect(plannerModesFrom(true)).toEqual(DEFAULT_PLANNER_MODES);
  });
});

describe('one-shot planner prompt', () => {
  it('tells the model there is nobody to ask', () => {
    const research = buildResearchPrompt('goal', '', {}, ['claude-code'], undefined, DEFAULT_PLANNER_MODES);

    expect(research).toContain('ONE-SHOT run');
  });
});
