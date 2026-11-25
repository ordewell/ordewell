import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { RunnerSignIn } from '@ordewell/core';
import App from '../../test/ChatApp';
import type { PlannerBackend } from '../../shared/protocol';
import { api, post } from './webview';

const CURSOR: RunnerSignIn = { runner: 'cursor-agent', label: 'Cursor', login: ['cursor-agent', 'login'] };
const REFUSED = 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login. Then try again.';
const DRAFT = 'Add a parser';

// The planner the person has picked since the refusal: the error's sign-in must not follow it.
const claude: PlannerBackend = {
  id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true,
  auth: { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] },
};

const sent = () => api.post.mock.calls.map(([message]) => message as { type: string; runner?: string; text?: string });
const signIn = () => screen.queryByRole('button', { name: /^(Sign in to|Signing in to) Cursor$/ });
const composer = () => document.querySelector<HTMLTextAreaElement>('.chat-input-wrapper textarea')!;

/** A planner error caused by a signed-out agent offers that agent's own sign-in (ADR-0052). */
describe('a planner error that names a signed-out agent', () => {
  beforeEach(() => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setPlannerBackends', backends: [claude], provider: 'claude-code', runner: 'claude-code' });
    // The refused message, given back to the composer as the host does for a preflight refusal.
    post({ type: 'promptUnsent', text: DRAFT });
    post({ type: 'showError', error: REFUSED, code: 'planner_not_ready', signIn: CURSOR });
    api.post.mockClear();
  });

  it('signs in the agent the failure names, not the planner picked now', () => {
    expect(screen.getByText(REFUSED)).toBeInTheDocument();
    expect(signIn()?.textContent).toBe('Sign in');

    fireEvent.click(signIn()!);

    expect(sent()).toContainEqual({ type: 'loginPlanner', runner: 'cursor-agent' });
    expect(sent()).not.toContainEqual(expect.objectContaining({ type: 'loginPlanner', runner: 'claude-code' }));
  });

  it('starts one login at a time, and ends it as the host reports, keeping the draft', () => {
    fireEvent.click(signIn()!);
    fireEvent.click(signIn()!);

    expect(sent().filter((m) => m.type === 'loginPlanner')).toHaveLength(1);
    expect(signIn()).toBeDisabled();
    expect(signIn()?.getAttribute('aria-busy')).toBe('true');

    post({ type: 'plannerLoginEnded', runner: 'cursor-agent', ok: true });

    expect(screen.getByRole('status').textContent).toBe('Signed in to Cursor. Send your message again.');
    expect(signIn()).toBeNull();
    // Nothing is sent for the person: the message waits in the composer.
    expect(sent().filter((m) => m.type === 'sendMessage')).toEqual([]);
    expect(composer().value).toBe(DRAFT);
  });

  it('says why a cancelled login did not finish, and offers it again', () => {
    fireEvent.click(signIn()!);

    post({ type: 'plannerLoginEnded', runner: 'cursor-agent', ok: false, message: 'The terminal closed before sign-in finished.' });

    expect(screen.getByRole('status').textContent).toBe('The terminal closed before sign-in finished.');
    expect(signIn()).not.toBeDisabled();
    expect(composer().value).toBe(DRAFT);
  });

  it('offers the sign-in again when the next send is refused again', () => {
    fireEvent.click(signIn()!);
    post({ type: 'plannerLoginEnded', runner: 'cursor-agent', ok: true });

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    post({ type: 'showError', error: REFUSED, code: 'planner_not_ready', signIn: CURSOR });

    expect(signIn()).not.toBeDisabled();
    expect(screen.queryByText('Signed in to Cursor. Send your message again.')).toBeNull();
  });

  it('ignores another agent\'s login ending', () => {
    fireEvent.click(signIn()!);

    post({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });

    expect(signIn()).toBeDisabled();
    expect(screen.queryByText('Signed in to Cursor. Send your message again.')).toBeNull();
  });
});

describe('a planner error with no interactive sign-in', () => {
  beforeEach(() => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
    api.post.mockClear();
  });

  it('keeps the words alone for an agent Ordewell cannot sign in', () => {
    const byHand: RunnerSignIn = { runner: 'gemini-cli', label: 'Gemini CLI', byHand: 'run gemini and choose how it signs in' };
    post({ type: 'showError', error: 'Gemini CLI is not signed in. Run gemini and choose how it signs in. Then try again.', code: 'planner_not_ready', signIn: byHand });

    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });

  it('opens the key entry for an agent signed in by a key, and waits on nothing', () => {
    const qwen: RunnerSignIn = { runner: 'qwen-code', label: 'Qwen Code', key: { provider: 'openrouter', label: 'OpenRouter' } };
    post({ type: 'showError', error: 'Qwen Code is not signed in.', code: 'planner_not_ready', signIn: qwen });

    fireEvent.click(screen.getByRole('button', { name: 'Add a key for Qwen Code' }));

    expect(sent()).toContainEqual(expect.objectContaining({ type: 'sendMessage', text: '/key-set openrouter' }));
    expect(sent()).not.toContainEqual(expect.objectContaining({ type: 'loginPlanner' }));
  });

  it('keeps a missing key\'s refusal and a generic failure to Try Again', () => {
    post({ type: 'showError', error: 'No planner is ready.', code: 'planner_not_ready' });
    expect(screen.queryByRole('button', { name: /Sign in|Add a key/ })).toBeNull();

    post({ type: 'showError', error: 'the planner crashed', resend: DRAFT });
    expect(screen.queryByRole('button', { name: /Sign in|Add a key/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });
});
