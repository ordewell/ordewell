import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AGENT_SETTINGS_HINT, AgentSettingsBadge } from '../agentSettings';

afterEach(cleanup);

describe('the agent settings badge', () => {
  it('labels a file agents load when they start, the reason in its tooltip', () => {
    const { container } = render(<AgentSettingsBadge path=".claude/settings.json" />);
    const badge = container.querySelector('.ow-badge');
    expect(badge?.textContent).toBe('agent settings');
    expect(badge?.getAttribute('title')).toBe('Agents load this file when they start. Review it before you merge.');
    expect(badge?.getAttribute('aria-description')).toBe(AGENT_SETTINGS_HINT);
    expect(badge?.className).toContain('ow-badge-neutral');
  });

  it('draws nothing for an ordinary file or a look-alike', () => {
    for (const path of ['src/index.ts', 'docs/.claude-notes.md', 'src/claude/settings.json', 'my.mcp.json']) {
      expect(render(<AgentSettingsBadge path={path} />).container.innerHTML, path).toBe('');
    }
  });

  it('reads a path from the top against the workspace it names', () => {
    expect(render(<AgentSettingsBadge path="packages/app/.mcp.json" workspace="packages/app" />).container.textContent).toBe('agent settings');
    expect(render(<AgentSettingsBadge path="packages/app/.mcp.json" />).container.innerHTML).toBe('');
  });
});
