import { describe, expect, it } from 'vitest';
import { plannerIdChoice, plannerIdList, plannerNamesOr, runnerIdList } from '../runnerNames';

// copilot-cli runs tasks but has no harness planner yet, so text about
// planning must not offer it while text about runners must.
describe('runner names, for runners and for planners', () => {
  it('names every runner where the text is about runners', () => {
    expect(runnerIdList()).toBe('claude-code, codex, opencode, copilot-cli');
  });

  it('names only the runners that can plan where the text is about planning', () => {
    expect(plannerIdList()).toBe('claude-code, codex, opencode');
    expect(plannerIdChoice()).toBe('claude-code|codex|opencode');
    expect(plannerNamesOr()).toBe('Claude Code, Codex or OpenCode');
  });
});
