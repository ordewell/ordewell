import { describe, expect, it } from 'vitest';
import { clampThinkingEffort } from '../ModelAllowlistResolver';

const variants = (...ids: string[]) => ids.map((id) => ({ id }));

// PlanPrompts' DEFAULT_EFFORT: "a model with no medium goes to the next variant up, not down".
describe('a planned medium on a model with no medium', () => {
  it('settles on the next variant up', () => {
    expect(clampThinkingEffort('medium', variants('low', 'high'))).toBe('high');
    expect(clampThinkingEffort('medium', variants('minimal', 'low', 'high', 'xhigh'))).toBe('high');
  });
});
