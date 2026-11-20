import { describe, expect, it } from 'vitest';
import { plannerIdChoice, plannerIdList, plannerNamesOr, runnerIdList } from '../runnerNames';

// Text about planning names the runners whose connector plans; text about
// runners names every runner.
describe('runner names, for runners and for planners', () => {
  // The built-in runner is one runner per provider (ADR-0070): naming each of
  // them would bury the coding agents, so the list says what they are instead.
  it('names every coding agent, then the provider runners as one, where the text is about runners', () => {
    expect(runnerIdList()).toBe('claude-code, codex, opencode, pi, copilot-cli, qwen-code, cline, gemini-cli, cursor-agent, and each API provider with a key');
    expect(runnerIdList()).not.toMatch(/ordewell|openrouter/);
  });

  it('names only the runners that can plan where the text is about planning', () => {
    expect(plannerIdList()).toBe('claude-code, codex, opencode, pi, copilot-cli, qwen-code, cline, gemini-cli, cursor-agent');
    expect(plannerIdChoice()).toBe('claude-code|codex|opencode|pi|copilot-cli|qwen-code|cline|gemini-cli|cursor-agent');
    expect(plannerNamesOr()).toBe('Claude Code, Codex, OpenCode, Pi, GitHub Copilot CLI, Qwen Code, Cline, Gemini CLI or Cursor');
  });
});
