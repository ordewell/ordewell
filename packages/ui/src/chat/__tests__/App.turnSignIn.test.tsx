import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DisplayBlock, RunnerSignIn } from '@ordewell/core';
import App from '../../test/ChatApp';
import type { PlannerBackend } from '../../shared/protocol';
import { api, post } from './webview';

const CLAUDE: RunnerSignIn = { runner: 'claude-code', label: 'Claude Code', login: ['claude', 'auth', 'login'] };
const FAILED = 'Claude Code is not signed in. Sign in with /login claude-code, or run claude auth login. Then try again.\n\nNot logged in · Please run /login';

// The planner picked since the turn failed: the failure's sign-in stays the agent that refused.
const codex: PlannerBackend = { id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true, auth: { state: 'signed-in' } };

const sent = () => api.post.mock.calls.map(([message]) => message as { type: string; runner?: string; text?: string });
const signIn = () => screen.queryByRole('button', { name: /^(Sign in to|Signing in to) Claude Code$/ });

function conversation(blocks: DisplayBlock[]): void {
  post({ type: 'conversationPatch', order: blocks.map((b) => b.id), changed: blocks });
}

/** A planner turn its runner ended signed out, as the conversation keeps it (ADR-0052). */
describe('a planner turn that ended signed out', () => {
  beforeEach(() => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setPlannerBackends', backends: [codex], provider: 'codex', runner: 'codex' });
    conversation([
      { type: 'message', id: 'm1', role: 'user', text: 'Add a parser', streaming: false },
      { type: 'message', id: 'm2', role: 'error', text: FAILED, streaming: false, signIn: CLAUDE },
    ]);
    api.post.mockClear();
  });

  it('shows its failure once, as an error offering that agent\'s own sign-in', () => {
    expect(screen.getAllByText(/Not logged in · Please run \/login/)).toHaveLength(1);
    expect(document.querySelector('.error-state')).toBeNull();
    expect(signIn()?.textContent).toBe('Sign in');
    expect(signIn()?.closest('.chat-msg-error')).not.toBeNull();

    fireEvent.click(signIn()!);

    expect(sent()).toEqual([{ type: 'loginPlanner', runner: 'claude-code' }]);
  });

  it('ends the login as the host reports it, and sends nothing again for the person', () => {
    fireEvent.click(signIn()!);
    expect(signIn()).toBeDisabled();

    post({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });

    expect(screen.getByRole('status').textContent).toBe('Signed in to Claude Code. Send your message again.');
    expect(sent().filter((m) => m.type === 'sendMessage')).toEqual([]);
  });

  it('offers no sign-in on an ordinary error, nor on a planner reply about signing in', () => {
    conversation([
      { type: 'message', id: 'm1', role: 'user', text: 'how do I sign in?', streaming: false },
      { type: 'message', id: 'm2', role: 'planner', text: 'Run claude auth login if you are not logged in.', streaming: false },
      { type: 'message', id: 'm3', role: 'error', text: 'The planner crashed.', streaming: false },
    ]);

    expect(screen.queryByRole('button', { name: /Sign in|Add a key/ })).toBeNull();
  });
});
