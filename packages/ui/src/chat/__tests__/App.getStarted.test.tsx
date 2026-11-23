import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import App from '../../test/ChatApp';
import { api, post } from './webview';

const CLAUDE = { id: 'claude-code', label: 'Claude Code', kind: 'harness' as const, runner: 'claude-code', usable: false };
const CODEX = { id: 'codex', label: 'Codex', kind: 'harness' as const, runner: 'codex', usable: false };

/** What the host says when it found no coding agent and no key. */
function nothingCanPlan(): void {
  post({ type: 'setConfiguredProviders', providers: [] });
  post({ type: 'setPlannerBackends', backends: [CLAUDE, CODEX], provider: 'openrouter' });
}

const sent = () => api.post.mock.calls.map(([message]) => message as { type: string; text?: string; url?: string });
const card = () => document.querySelector<HTMLElement>('.get-started')!;

/**
 * First-run audit F2: with no coding agent and no key the first screen of the
 * desktop app and of VS Code is the only way on, so it says exactly how to get
 * a planner and lets the user check again without leaving it.
 */
describe('the first screen when nothing can plan', () => {
  beforeEach(() => {
    api.post.mockClear();
    render(<App />);
    nothingCanPlan();
  });

  it('gives the install command and the install page for Claude Code and for Codex', () => {
    const text = card().textContent ?? '';
    expect(text).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(text).toContain('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
    expect(within(card()).getByRole('link', { name: 'Claude Code install guide' }).getAttribute('href')).toBe('https://code.claude.com/docs/en/setup');
    expect(within(card()).getByRole('link', { name: 'Codex install guide' }).getAttribute('href')).toBe('https://github.com/openai/codex');
  });

  it('asks the host to open an install page, since a desktop window does not follow links itself', () => {
    fireEvent.click(within(card()).getByRole('link', { name: 'Codex install guide' }));
    expect(sent()).toContainEqual({ type: 'openLink', url: 'https://github.com/openai/codex' });
  });

  it('says that signing in happens in the agent itself', () => {
    expect(card().textContent).toContain('Signing in happens in the agent itself: run claude or codex once in a terminal and follow its sign-in prompt.');
  });

  it('offers Detect again first and Add API key as the second route', () => {
    const buttons = within(card()).getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Detect again', 'Add API key']);
  });

  it('runs detection again on Detect again, and says so until the host answers', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Detect again' }));
    expect(sent()).toContainEqual({ type: 'refreshModels' });
    expect(screen.getByRole('button', { name: 'Detecting…' })).toBeDisabled();

    nothingCanPlan();
    expect(screen.getByRole('button', { name: 'Detect again' })).toBeEnabled();
    expect(card().textContent).toContain('Still no coding agent found.');
  });

  it('leaves the first screen once detection finds an agent', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Detect again' }));
    post({ type: 'setPlannerBackends', backends: [{ ...CLAUDE, usable: true }, CODEX], provider: 'claude-code', runner: 'claude-code' });
    expect(document.querySelector('.get-started')).toBeNull();
    expect(screen.getByText('What would you like to build?')).toBeInTheDocument();
  });

  it('opens the key entry on Add API key', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add API key' }));
    expect(sent()).toContainEqual(expect.objectContaining({ type: 'sendMessage', text: '/key-set' }));
  });
});

/**
 * The refusal of a goal when no planner is ready names the way out, which
 * often happens outside the window (an agent installed, a sign-in): its Try
 * Again asks the host to look again, not only clears the box.
 */
describe('Try Again on a no-planner error', () => {
  beforeEach(() => {
    api.post.mockClear();
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setPlannerBackends', backends: [{ ...CLAUDE, usable: true }], provider: 'claude-code', runner: 'claude-code' });
  });

  it('runs agent detection again and clears the error', () => {
    post({ type: 'showError', error: 'No planner is ready. Pick one with /planner.', code: 'planner_not_ready' });
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(sent()).toContainEqual({ type: 'refreshModels' });
    expect(screen.queryByText('No planner is ready. Pick one with /planner.')).toBeNull();
  });

  it('only clears any other error', () => {
    post({ type: 'showError', error: 'Planner failed: socket hang up' });
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(sent()).not.toContainEqual({ type: 'refreshModels' });
    expect(screen.queryByText('Planner failed: socket hang up')).toBeNull();
  });
});
