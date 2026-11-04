import { describe, expect, it } from 'vitest';
import { plannerIdChoice, plannerIdList, plannerNamesOr, runnerIdList } from '../runnerNames';

// Text about planning names the runners whose connector plans; text about
// runners names every runner.
describe('runner names, for runners and for planners', () => {
  it('names every runner where the text is about runners', () => {
    expect(runnerIdList()).toBe('claude-code, codex, opencode, copilot-cli, qwen-code, cline, gemini-cli, cursor-agent');
  });

  it('names only the runners that can plan where the text is about planning', () => {
    expect(plannerIdList()).toBe('claude-code, codex, opencode, copilot-cli, qwen-code');
    expect(plannerIdChoice()).toBe('claude-code|codex|opencode|copilot-cli|qwen-code');
    expect(plannerNamesOr()).toBe('Claude Code, Codex, OpenCode, GitHub Copilot CLI or Qwen Code');
  });
});
