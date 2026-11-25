import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import { DaemonHost, type DaemonHostOptions } from '../DaemonHost';
import { ChatSurface } from '../useSession';
import { fakeDaemon, ok } from './fakeDaemon';
import type { RouteParams } from '../../../shared/routes';

const WORKSPACE = '/work/acme';
const DRAFT = 'Add a parser';
const CURSOR_SIGN_IN = { runner: 'cursor-agent', label: 'Cursor', login: ['cursor-agent', 'login'] };
const REFUSED = 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login. Then try again.';
const MODELS = ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [], providerErrors: {} });
// The planner the window is on now is Claude Code: the refusal names Cursor, which planned the turn.
const SETTINGS = ok({ orchestratorModel: '', aiProvider: 'claude-code', plannerThinkingEffort: '', autonomousMode: false, maxParallel: 3, modelAllowlist: {}, run: { ...RUN_SETTINGS_DEFAULTS } });

let hosts: DaemonHost[] = [];
afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts = [];
});

function hostWithOptions(options: DaemonHostOptions): DaemonHost {
  const host = new DaemonHost(WORKSPACE, async () => null, options);
  hosts.push(host);
  return host;
}

/** Cursor has no status command: until a recheck answers, the daemon lists the sign-out a refusal recorded. */
function cursor(state: 'signed-out' | 'signed-in' | 'unknown') {
  return { id: 'cursor-agent', name: 'Cursor', enabled: true, auth: { state, loginCommand: CURSOR_SIGN_IN.login, signIn: CURSOR_SIGN_IN } };
}
const claude = { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in', loginCommand: ['claude', 'auth', 'login'] } };

const rechecked = (params: RouteParams | undefined) => (params as { recheck?: string } | undefined)?.recheck;
const banner = () => document.querySelector<HTMLElement>('.error-state');
const signIn = () => banner()?.querySelector<HTMLButtonElement>('.error-sign-in') ?? null;
const outcome = () => banner()?.querySelector('.error-sign-in-outcome')?.textContent;
const composer = () => document.querySelector<HTMLTextAreaElement>('.chat-input-wrapper textarea')!;

async function send(text: string): Promise<void> {
  fireEvent.change(composer(), { target: { value: text } });
  await act(async () => { fireEvent.keyDown(composer(), { key: 'Enter' }); });
}

/** The desktop's chat on its daemon: a refusal that names a signed-out agent offers that agent's sign-in (ADR-0052). */
describe('a planner refusal the desktop shows for a signed-out agent', () => {
  function daemonRefusing(refusal: { status: number; data: Record<string, unknown> }, recheckAnswer: 'signed-in' | 'signed-out' | 'unknown' = 'signed-in') {
    return fakeDaemon({
      'runners.list': (params) => ok({ runners: [claude, cursor(rechecked(params) ? recheckAnswer : 'signed-out')], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': SETTINGS,
      'plans.converseStart': { ok: false, status: refusal.status, error: 'Conflict', data: refusal.data },
    });
  }
  const preflight = { status: 409, data: { error: REFUSED, code: 'planner_not_ready', plannerNotReady: { code: 'signed_out', provider: 'cursor-agent', label: 'Cursor', runner: 'cursor-agent', signIn: CURSOR_SIGN_IN } } };
  const refusedStart = { status: 409, data: { error: 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login.', code: 'runner_signed_out', signIn: CURSOR_SIGN_IN } };

  it.each([
    ['refused before the turn', preflight],
    ['refused by the agent as it started', refusedStart],
  ])('signs in the agent the refusal names, and a forgotten status-less agent recovers: %s', async (_case, refusal) => {
    const daemon = daemonRefusing(refusal);
    const openLogin = vi.fn(async () => ({ ended: Promise.resolve(0) }));
    const host = hostWithOptions({ openLogin, pollMs: 60_000 });
    render(<ChatSurface host={host} layout="conversation" />);
    await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));

    await send(DRAFT);
    await waitFor(() => expect(signIn()).not.toBeNull());
    expect(signIn()!.textContent).toBe('Sign in');
    expect(signIn()!.getAttribute('aria-label')).toBe('Sign in to Cursor');

    await act(async () => { fireEvent.click(signIn()!); });

    expect(openLogin).toHaveBeenCalledTimes(1);
    expect(openLogin).toHaveBeenCalledWith('cursor-agent', 'Cursor');
    await waitFor(() => expect(outcome()).toBe('Signed in to Cursor. Send your message again.'));
    // The login exited cleanly, so the daemon was asked once to recheck Cursor, and its answer redrew the lists.
    expect(daemon.calls('runners.list').filter(([params]) => rechecked(params) === 'cursor-agent')).toHaveLength(1);
    // Nothing was sent again for the person.
    expect(daemon.calls('plans.converseStart')).toHaveLength(1);
  });

  it('keeps the refused message in the composer through the refusal and the sign-in', async () => {
    daemonRefusing(preflight);
    const host = hostWithOptions({ openLogin: async () => ({ ended: Promise.resolve(0) }), pollMs: 60_000 });
    render(<ChatSurface host={host} layout="conversation" />);
    await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));

    await send(DRAFT);
    await waitFor(() => expect(signIn()).not.toBeNull());
    expect(composer().value).toBe(DRAFT);

    await act(async () => { fireEvent.click(signIn()!); });
    await waitFor(() => expect(outcome()).toBe('Signed in to Cursor. Send your message again.'));
    expect(composer().value).toBe(DRAFT);
  });

  it('says a cancelled login did not finish, and keeps the sign-in offered', async () => {
    const daemon = daemonRefusing(preflight);
    const openLogin = vi.fn(async () => ({ ended: Promise.resolve(130) }));
    const host = hostWithOptions({ openLogin, pollMs: 60_000 });
    render(<ChatSurface host={host} layout="conversation" />);
    await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));
    await send(DRAFT);
    await waitFor(() => expect(signIn()).not.toBeNull());

    await act(async () => { fireEvent.click(signIn()!); });

    await waitFor(() => expect(outcome()).toBe('The terminal closed before sign-in finished.'));
    expect(signIn()).not.toBeDisabled();
    expect(daemon.calls('runners.list').some(([params]) => rechecked(params))).toBe(false);
  });

  it('starts one login while one is in flight', async () => {
    daemonRefusing(preflight);
    const openLogin = vi.fn(async () => ({ ended: new Promise<number>(() => undefined) }));
    const host = hostWithOptions({ openLogin, pollMs: 60_000, sleep: () => new Promise(() => undefined) });
    render(<ChatSurface host={host} layout="conversation" />);
    await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));
    await send(DRAFT);
    await waitFor(() => expect(signIn()).not.toBeNull());

    await act(async () => { fireEvent.click(signIn()!); });
    await act(async () => { fireEvent.click(signIn()!); });

    expect(signIn()).toBeDisabled();
    expect(openLogin).toHaveBeenCalledTimes(1);
  });

  it('offers no sign-in for a refusal that names no agent', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [claude], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': SETTINGS,
      'plans.converseStart': { ok: false, status: 500, error: 'Internal Server Error', data: { error: 'the planner crashed' } },
    });
    const host = hostWithOptions({});
    render(<ChatSurface host={host} layout="conversation" />);
    await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));

    await send(DRAFT);

    await screen.findByRole('button', { name: 'Try Again' });
    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull();
  });
});

