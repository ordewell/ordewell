import { describe, expect, it } from 'vitest';
import { AGENT_SIGN_IN_NOTE, agentInstallRoutes } from '../plannerNotices';

// The commands and pages are the vendors' own, as their setup pages printed
// them on 2026-11-21: code.claude.com/docs/en/setup and github.com/openai/codex.
describe('agentInstallRoutes: how a first screen with nothing to plan says to get a coding agent', () => {
  it('gives Claude Code and Codex, each with its own one-line installer and page, on macOS and Linux', () => {
    expect(agentInstallRoutes('posix')).toEqual([
      { runner: 'claude-code', label: 'Claude Code', command: 'curl -fsSL https://claude.ai/install.sh | bash', docs: 'https://code.claude.com/docs/en/setup' },
      { runner: 'codex', label: 'Codex', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', docs: 'https://github.com/openai/codex' },
    ]);
  });

  it('gives the PowerShell installers on Windows', () => {
    expect(agentInstallRoutes('windows').map((route) => route.command)).toEqual([
      'irm https://claude.ai/install.ps1 | iex',
      'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    ]);
  });

  it('says that signing in is done in the agent, not in Ordewell', () => {
    expect(AGENT_SIGN_IN_NOTE).toBe('Signing in happens in the agent itself: run claude or codex once in a terminal and follow its sign-in prompt.');
  });
});
