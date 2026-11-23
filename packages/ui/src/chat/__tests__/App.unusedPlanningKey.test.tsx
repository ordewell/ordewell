import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../../test/ChatApp';
import { post } from './webview';

const CLAUDE = { id: 'claude-code', label: 'Claude Code', kind: 'harness' as const, runner: 'claude-code', usable: true };
const LINE = 'Planning with Claude Code. An OpenAI key was found and is not used for planning; /planner changes that.';

/**
 * A key in the shell or saved in Ordewell does not take planning from the
 * detected agent (ADR-0076), so the first screen of the desktop app and of
 * VS Code says, once, who plans and why.
 */
describe('the first screen when a found key is not used for planning', () => {
  it('says which agent plans and which key it plans past, once', () => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: ['openai'] });
    post({ type: 'setPlannerBackends', backends: [CLAUDE], provider: 'claude-code', runner: 'claude-code', unusedPlanningKey: 'openai' });

    expect(screen.getAllByText(LINE)).toHaveLength(1);
  });

  it('says nothing when the host reports no key passed over', () => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: ['openai'] });
    post({ type: 'setPlannerBackends', backends: [CLAUDE], provider: 'claude-code', runner: 'claude-code' });

    expect(screen.getByText('What would you like to build?')).toBeInTheDocument();

    expect(screen.queryByText(/not used for planning/)).toBeNull();
  });
});
