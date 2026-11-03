import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import App from '../../test/ChatApp';
import { api, post } from './webview';
import type { PlannerBackend } from '../../shared/protocol';

const signedOutClaude: PlannerBackend = {
  id: 'claude-code',
  label: 'Claude Code',
  kind: 'harness',
  runner: 'claude-code',
  usable: true,
  reason: 'not logged in',
  auth: { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' },
};

const signedInClaude: PlannerBackend = {
  ...signedOutClaude,
  reason: 'coding agent · no API key needed',
  auth: { state: 'signed-in', loginCommand: ['claude', 'auth', 'login'] },
};

const signedOutCodex: PlannerBackend = {
  id: 'codex',
  label: 'Codex',
  kind: 'harness',
  runner: 'codex',
  usable: true,
  auth: { state: 'signed-out', loginCommand: ['codex', 'login'] },
};

const pill = (label?: string): HTMLButtonElement => label
  ? [...document.querySelectorAll<HTMLButtonElement>('.planner-pill')].find((p) => p.textContent === label)!
  : document.querySelector<HTMLButtonElement>('.planner-pill')!;
const plannerLogin = (label: string) =>
  pill(label)?.closest('.planner-pill-group')?.querySelector<HTMLButtonElement>('.planner-pill-login') ?? undefined;
const pillFailure = (label: string) => pill(label)?.closest('.planner-pill-item')?.querySelector('.planner-pill-login-failure');
const authRows = () => [...document.querySelectorAll<HTMLElement>('.planner-auth-row')];
const authRow = (runner: string) => document.querySelector<HTMLElement>(`.planner-auth-row[data-runner="${runner}"]`);
const rowLogin = (runner: string) => authRow(runner)?.querySelector<HTMLButtonElement>('.planner-login-btn');
const runnerPill = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.runner-pill')].find((p) => p.textContent?.includes(name))!;
const runnerLogin = (name: string) =>
  runnerPill(name)?.closest('.runner-pill-group')?.querySelector<HTMLButtonElement>('.runner-pill-login');

/**
 * A signed-out agent is still a working choice — the login is the fix — so it
 * stays offered, and the surface only says what is wrong.
 */
describe('a signed-out planner', () => {
  beforeEach(() => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
  });

  it('flags its pill with a red dot and a title', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });

    expect(pill().className).toContain('signed-out');
    expect(pill().className).toContain('active');
    expect(pill().querySelector('.planner-auth-dot')).toBeTruthy();
    expect(pill().title).toContain('Not logged in');
  });

  it('keeps a signed-out agent pickable', () => {
    post({
      type: 'setPlannerBackends',
      backends: [signedOutClaude, { id: 'openrouter', label: 'OpenRouter', kind: 'vendor', usable: true }],
      provider: 'openrouter',
    });
    api.post.mockClear();

    fireEvent.click(pill());

    expect(api.post).toHaveBeenCalledWith({ type: 'setPlanner', provider: 'claude-code' });
  });

  it('does not flag a signed-in pill', () => {
    post({ type: 'setPlannerBackends', backends: [signedInClaude], provider: 'claude-code', runner: 'claude-code' });

    expect(pill().className).not.toContain('signed-out');
    expect(pill().querySelector('.planner-auth-dot')).toBeNull();
    expect(pill().title).toBe('coding agent · no API key needed');
  });

  it('lists a signed-out agent in the empty state, naming its own login', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });

    const region = document.querySelector('.planner-auth-rows');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(authRow('claude-code')?.querySelector('.planner-auth-warning-text')?.textContent).toBe('Claude Code not logged in.');
    expect(rowLogin('claude-code')?.textContent).toBe('Log in');
    expect(rowLogin('claude-code')?.getAttribute('aria-label')).toBe('Log in to Claude Code');
  });

  it('lists every signed-out agent, active planner first and then in list order', () => {
    const opencode: PlannerBackend = {
      id: 'opencode',
      label: 'OpenCode',
      kind: 'harness',
      runner: 'opencode',
      usable: true,
      auth: { state: 'signed-out', loginCommand: ['opencode', 'auth', 'login'] },
    };
    post({ type: 'setPlannerBackends', backends: [signedInClaude, signedOutCodex, opencode], provider: 'opencode', runner: 'opencode' });

    expect(authRows().map((r) => r.dataset.runner)).toEqual(['opencode', 'codex']);
    expect(authRow('opencode')?.querySelector('.planner-auth-warning-text')?.textContent).toBe('OpenCode not logged in.');
    expect(authRow('codex')?.querySelector('.planner-auth-warning-text')?.textContent).toBe('Codex not logged in.');
  });

  it('gives a signed-out agent with no login command a row but no button', () => {
    const noCommand: PlannerBackend = { ...signedOutCodex, auth: { state: 'signed-out' } };
    post({ type: 'setPlannerBackends', backends: [signedInClaude, noCommand], provider: 'claude-code', runner: 'claude-code' });

    expect(authRow('codex')?.querySelector('.planner-auth-warning-text')?.textContent).toBe('Codex not logged in.');
    expect(rowLogin('codex')).toBeNull();
    expect(plannerLogin('Codex')).toBeUndefined();
  });

  it('signs the active planner in from the empty state, and waits on that button alone', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });
    api.post.mockClear();

    fireEvent.click(rowLogin('claude-code')!);

    // Named, so a pending planner switch cannot sign in the previous agent.
    expect(api.post).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'claude-code' });
    expect(rowLogin('claude-code')).toBeDisabled();
    expect(rowLogin('claude-code')?.getAttribute('aria-busy')).toBe('true');
    expect(rowLogin('claude-code')?.textContent).toContain('Signing in…');

    post({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });

    expect(rowLogin('claude-code')).not.toBeDisabled();
    expect(rowLogin('claude-code')?.getAttribute('aria-busy')).toBeNull();
  });

  it('names the agent a pending planner switch lands on, first in the list', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude, signedOutCodex], provider: 'claude-code', runner: 'claude-code' });
    // The host has not answered the switch yet: the empty state already names
    // Codex, while the saved config still points at Claude Code.
    fireEvent.click(pill('Codex'));
    expect(authRows()[0].dataset.runner).toBe('codex');
    expect(authRow('codex')?.querySelector('.planner-auth-warning-text')?.textContent).toBe('Codex not logged in.');
    api.post.mockClear();

    fireEvent.click(rowLogin('codex')!);

    expect(api.post).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'codex' });
  });

  it('keeps the name and its login in one capsule, the name first', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });

    const group = pill().closest('.planner-pill-group')!;
    const segments = [...group.querySelectorAll<HTMLButtonElement>('button')];
    expect(segments).toHaveLength(2);
    expect(segments[0].className).toContain('planner-pill');
    expect(segments[1].className).toContain('planner-pill-login');
    // The shared class is what gives both placements one look.
    expect(segments[1].className).toContain('planner-login');
    expect(segments[0].textContent).toBe('Claude Code');
    expect(segments[1].textContent).toBe('Log in');
    // The login is still the agent's own action, not a second way to select it.
    expect(segments[1].getAttribute('aria-label')).toBe('Log in to Claude Code');
  });

  it('keeps the capsule login to the "Log in" width and spins alone while pending', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    document.head.append(style);

    const login = plannerLogin('Claude Code')!;
    expect(getComputedStyle(login).paddingLeft).toBe('8px');
    expect(getComputedStyle(login).paddingRight).toBe('8px');

    fireEvent.click(login);

    const capsuleLabel = login.querySelector('.planner-login-pending-label')!;
    const rowLabel = rowLogin('claude-code')!.querySelector('.planner-login-pending-label')!;
    expect(getComputedStyle(capsuleLabel).display).toBe('none');
    expect(getComputedStyle(rowLabel).display).not.toBe('none');
    expect(login.querySelector('.planner-login-spinner')).not.toBeNull();
    expect(login.getAttribute('aria-busy')).toBe('true');
    expect(login.getAttribute('aria-label')).toBe('Signing in to Claude Code');
    expect(login.title).toBe('Signing in to Claude Code');
  });

  it('flags the signed-out active planner inline in the collapsed Settings row, with no summary line', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });
    const toggle = [...document.querySelectorAll<HTMLButtonElement>('.setup-panel-toggle')]
      .find((b) => b.textContent?.includes('Settings'))!;

    fireEvent.click(toggle);

    expect(toggle.textContent).not.toMatch(/\d+ runners?/);
    expect(toggle.querySelector('.setup-panel-summary')).toBeNull();
    const dot = toggle.querySelector('.setup-panel-toggle-row .planner-auth-dot');
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
    expect(toggle.querySelector('.setup-panel-toggle-row .visually-hidden')?.textContent)
      .toBe('not logged in: Claude Code');
    expect(toggle.title).toBe('Claude Code is not logged in — open Settings to sign in');
  });

  it('keeps the collapsed Settings row to its label when the planner is signed in', () => {
    post({ type: 'setPlannerBackends', backends: [signedInClaude], provider: 'claude-code', runner: 'claude-code' });
    const toggle = [...document.querySelectorAll<HTMLButtonElement>('.setup-panel-toggle')]
      .find((b) => b.textContent?.includes('Settings'))!;

    fireEvent.click(toggle);

    expect(toggle.textContent).not.toMatch(/\d+ runners?/);
    expect(toggle.querySelector('.planner-auth-dot')).toBeNull();
    expect(toggle.querySelector('.setup-panel-summary')).toBeNull();
    expect(toggle.querySelector('.visually-hidden')).toBeNull();
    expect(toggle.title).toBe('Expand settings');
  });

  it('signs in a signed-out pill without switching the planner to it', () => {
    post({ type: 'setPlannerBackends', backends: [signedInClaude, signedOutCodex], provider: 'claude-code', runner: 'claude-code' });
    api.post.mockClear();

    const login = plannerLogin('Codex')!;
    expect(login).toBeTruthy();
    fireEvent.click(login);

    expect(api.post).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'codex' });
    expect(api.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlanner' }));
    expect(plannerLogin('Codex')).toBeDisabled();
    expect(plannerLogin('Codex')?.getAttribute('aria-busy')).toBe('true');
    expect(plannerLogin('Codex')?.getAttribute('aria-label')).toBe('Signing in to Codex');
    // Only that agent's action waits: the pill bar stays usable.
    for (const p of document.querySelectorAll<HTMLButtonElement>('.planner-pill')) expect(p).not.toBeDisabled();
    expect(pill().className).toContain('active');
  });

  it('keeps each agent\'s login pending while another agent\'s starts', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude, signedOutCodex], provider: 'claude-code', runner: 'claude-code' });

    fireEvent.click(plannerLogin('Claude Code')!);
    expect(plannerLogin('Claude Code')).toBeDisabled();

    fireEvent.click(plannerLogin('Codex')!);
    expect(plannerLogin('Claude Code')).toBeDisabled();
    expect(plannerLogin('Codex')).toBeDisabled();

    // Only the agent whose login ended comes back.
    post({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });
    expect(plannerLogin('Claude Code')).not.toBeDisabled();
    expect(plannerLogin('Codex')).toBeDisabled();
  });

  it('offers the agent login in the menu while the empty state shows and after, posting the same runner', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });
    expect(authRow('claude-code')).not.toBeNull();
    expect(plannerLogin('Claude Code')).toBeTruthy();

    api.post.mockClear();
    fireEvent.click(rowLogin('claude-code')!);
    expect(api.post).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'claude-code' });
    post({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });

    api.post.mockClear();
    fireEvent.click(plannerLogin('Claude Code')!);
    expect(api.post).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'claude-code' });
    expect(api.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlanner' }));
    post({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });

    // A planner turn in flight: there is a conversation now, so the first
    // screen with its rows is not drawn. The menu login stays.
    post({ type: 'plannerTurn', active: true });
    expect(authRows()).toHaveLength(0);
    api.post.mockClear();
    fireEvent.click(plannerLogin('Claude Code')!);
    expect(api.post).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'claude-code' });
  });

  it('shows a login failure on the row and the pill that asked, for that agent alone', () => {
    post({ type: 'setPlannerBackends', backends: [signedInClaude, signedOutCodex], provider: 'claude-code', runner: 'claude-code' });
    fireEvent.click(plannerLogin('Codex')!);

    post({ type: 'plannerLoginEnded', runner: 'codex', ok: false, message: 'Sign-in did not finish in time.' });

    expect(authRow('codex')?.querySelector('.planner-auth-failure')?.textContent).toBe('Sign-in did not finish in time.');
    expect(pillFailure('Codex')?.textContent).toBe('Sign-in did not finish in time.');
    expect(plannerLogin('Codex')).not.toBeDisabled();
    // The failure belongs to Codex, not to the planner this session uses.
    expect(authRow('claude-code')).toBeNull();
    expect(pillFailure('Claude Code')).toBeNull();
  });

  it('shows why a login did not finish, inline, and lets the button be tried again', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });
    fireEvent.click(rowLogin('claude-code')!);

    post({ type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'The terminal closed before sign-in finished.' });

    expect(authRow('claude-code')?.querySelector('.planner-auth-failure')?.textContent).toBe('The terminal closed before sign-in finished.');
    // The reason replaces the state sentence in that row; the menu repeats the
    // same result for the same agent.
    expect(authRow('claude-code')?.querySelector('.planner-auth-warning-text')).toBeNull();
    expect(pillFailure('Claude Code')?.textContent).toBe('The terminal closed before sign-in finished.');
    expect(rowLogin('claude-code')).not.toBeDisabled();
    expect(rowLogin('claude-code')?.getAttribute('aria-busy')).toBeNull();
  });
});

/** The runners block uses the same verdict, keyed by the runner the planner list names. */
describe('a signed-out runner', () => {
  beforeEach(() => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
    post({
      type: 'setRunners',
      runners: [
        { id: 'claude-code', displayName: 'Claude Code', enabled: true },
        { id: 'codex', displayName: 'Codex', enabled: true },
      ],
    });
  });

  it('flags its pill with a red dot and its own login, which never switches it', () => {
    post({ type: 'setPlannerBackends', backends: [signedInClaude, signedOutCodex], provider: 'claude-code', runner: 'claude-code' });
    const codex = runnerPill('Codex');
    expect(codex.className).toContain('signed-out');
    expect(codex.querySelector('.planner-auth-dot')).not.toBeNull();
    expect(codex.title).toBe('Not logged in');
    expect(runnerLogin('Codex')?.getAttribute('aria-label')).toBe('Log in to Codex');
    api.post.mockClear();

    fireEvent.click(runnerLogin('Codex')!);

    expect(api.post).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'codex' });
    expect(api.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setRunnerEnabled' }));
    expect(api.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlanner' }));
    expect(codex.className).toContain('on');
    expect(codex.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps today\'s look for a signed-in or unknown runner', () => {
    post({ type: 'setPlannerBackends', backends: [signedInClaude], provider: 'claude-code', runner: 'claude-code' });

    expect(runnerPill('Claude Code').className).not.toContain('signed-out');
    expect(runnerPill('Claude Code').querySelector('.planner-auth-dot')).toBeNull();
    expect(runnerLogin('Claude Code')).toBeNull();
    expect(runnerPill('Codex').className).not.toContain('signed-out');
    expect(runnerPill('Codex').querySelector('.planner-auth-dot')).toBeNull();
    expect(runnerLogin('Codex')).toBeNull();
    expect(runnerPill('Codex').title).toContain('Codex');
  });

  it('gives a signed-out runner with no login command the flag but no login segment', () => {
    const noCommand: PlannerBackend = { ...signedOutCodex, auth: { state: 'signed-out' } };
    post({ type: 'setPlannerBackends', backends: [signedInClaude, noCommand], provider: 'claude-code', runner: 'claude-code' });

    expect(runnerPill('Codex').className).toContain('signed-out');
    expect(runnerPill('Codex').title).toBe('Not logged in');
    expect(runnerLogin('Codex')).toBeNull();
  });
});
