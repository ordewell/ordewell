import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_SETTINGS_DEFAULTS, type RunnerReadiness } from '@ordewell/core';
import { DaemonHost } from '../DaemonHost';
import { ChatSurface } from '../useSession';
import { fakeDaemon, ok } from './fakeDaemon';
import type { RouteParams } from '../../../shared/routes';

/*
 * The desktop's pickers on its daemon (ADR-0052): the rows carry the daemon's
 * own readiness, a blocked one says so beside it with its way back, and a
 * pick the list offered but the daemon refused (a stale list) gets the same
 * Sign in as any refusal that names a signed-out agent.
 */

const WORKSPACE = '/work/acme';
const CURSOR_SIGN_IN = { runner: 'cursor-agent', label: 'Cursor', login: ['cursor-agent', 'login'] };
const MODELS = ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [], providerErrors: {} });
const SETTINGS = ok({ orchestratorModel: '', aiProvider: 'claude-code', plannerThinkingEffort: '', autonomousMode: false, maxParallel: 3, modelAllowlist: {}, run: { ...RUN_SETTINGS_DEFAULTS } });

const BLOCKED: RunnerReadiness = { kind: 'blocked', why: 'signed-out', signIn: CURSOR_SIGN_IN };
const claude = { id: 'claude-code', name: 'Claude Code', enabled: true, plans: true, auth: { state: 'signed-in' }, readiness: { kind: 'ready' } };
function cursor(state: 'signed-out' | 'signed-in' | 'unknown', enabled = false) {
  const readiness: RunnerReadiness = state === 'signed-out' ? BLOCKED : state === 'signed-in' ? { kind: 'ready' } : { kind: 'sign-in-unknown' };
  return { id: 'cursor-agent', name: 'Cursor', enabled, plans: true, auth: { state, loginCommand: CURSOR_SIGN_IN.login, ...(state === 'signed-out' ? { signIn: CURSOR_SIGN_IN } : {}) }, readiness };
}

let hosts: DaemonHost[] = [];
afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts = [];
});

function mount(options: ConstructorParameters<typeof DaemonHost>[2] = {}) {
  const host = new DaemonHost(WORKSPACE, async () => null, { pollMs: 60_000, ...options });
  hosts.push(host);
  render(<ChatSurface host={host} layout="conversation" />);
  return host;
}

const rechecked = (params: RouteParams | undefined) => (params as { recheck?: string } | undefined)?.recheck;
const item = (selector: string, label: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.querySelector('button')?.textContent?.includes(label));
const plannerItem = (label: string) => item('.planner-pill-item', label);
const runnerItem = (label: string) => item('.runner-pill-item', label);
const status = (el: HTMLElement | undefined) => el?.querySelector('.runner-choice-status')?.textContent;
const recovery = (el: HTMLElement | undefined) => el?.querySelector<HTMLButtonElement>('.runner-choice-recovery') ?? null;
const banner = () => document.querySelector<HTMLElement>('.error-state');
const bannerSignIn = () => banner()?.querySelector<HTMLButtonElement>('.error-sign-in') ?? null;

describe("the desktop's pickers, from the daemon's readiness", () => {
  it('shows a blocked agent after the ready one, with Sign in, and its login re-picks nothing', async () => {
    // A recheck forgets the recorded sign-out, and every list after it says so.
    let forgotten = false;
    const opencode = { id: 'opencode', name: 'OpenCode', enabled: true, plans: true, auth: { state: 'unknown' }, readiness: { kind: 'pending' } };
    const daemon = fakeDaemon({
      'runners.list': (params) => {
        if (rechecked(params)) forgotten = true;
        return ok({ runners: [cursor(forgotten ? 'unknown' : 'signed-out'), claude, opencode], orchestratorModel: '' });
      },
      'models.list': MODELS,
      'settings.get': SETTINGS,
    });
    const openLogin = vi.fn(async () => ({ ended: Promise.resolve(0) }));
    mount({ openLogin });
    await waitFor(() => expect(status(plannerItem('Cursor'))).toBe('Signed out'));

    expect([...document.querySelectorAll('.planner-pill')].map((p) => p.textContent).filter((l) => l === 'Claude Code' || l === 'Cursor' || l === 'OpenCode'))
      .toEqual(['Claude Code', 'OpenCode', 'Cursor']);
    // The daemon's readiness, not the sign-in alone: OpenCode's models are still being asked for.
    expect(status(plannerItem('OpenCode'))).toBe('Checking models…');
    expect(status(runnerItem('OpenCode'))).toBe('Checking models…');
    expect(plannerItem('Cursor')!.querySelector('.planner-pill')!.getAttribute('aria-disabled')).toBe('true');
    expect(status(runnerItem('Cursor'))).toBe('Signed out');
    expect(runnerItem('Cursor')!.querySelector('.runner-pill')!.getAttribute('aria-disabled')).toBe('true');

    await act(async () => { fireEvent.click(plannerItem('Cursor')!.querySelector('.planner-pill')!); });
    expect(daemon.calls('settings.update')).toHaveLength(0);

    await act(async () => { fireEvent.click(recovery(plannerItem('Cursor'))!); });
    expect(openLogin).toHaveBeenCalledWith('cursor-agent', 'Cursor');
    // The login's recheck redraws both rows from one list; the planner is where it was.
    await waitFor(() => expect(status(plannerItem('Cursor'))).toBe('Sign-in not checked'));
    expect(status(runnerItem('Cursor'))).toBe('Sign-in not checked');
    expect(plannerItem('Cursor')!.querySelector('.planner-pill')!.getAttribute('aria-disabled')).toBeNull();
    expect(daemon.calls('settings.update')).toHaveLength(0);
    expect(daemon.calls('runners.setEnabled')).toHaveLength(0);
  });

  it('offers Sign in for a pick a stale list allowed and the daemon refused', async () => {
    let signedOut = false;
    const daemon = fakeDaemon({
      'runners.list': () => ok({ runners: [claude, cursor(signedOut ? 'signed-out' : 'signed-in')], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': SETTINGS,
      'settings.update': () => {
        signedOut = true;
        return {
          ok: false, status: 409, error: 'Conflict',
          data: { error: 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login. Then pick it again.', code: 'runner_not_ready', runnerNotReady: { runner: 'cursor-agent', readiness: BLOCKED } },
        };
      },
    });
    const openLogin = vi.fn(async () => ({ ended: new Promise<number>(() => undefined) }));
    mount({ openLogin, sleep: () => new Promise(() => undefined) });
    await waitFor(() => expect(plannerItem('Cursor')).toBeDefined());
    expect(status(plannerItem('Cursor'))).toBeUndefined();

    await act(async () => { fireEvent.click(plannerItem('Cursor')!.querySelector('.planner-pill')!); });

    await waitFor(() => expect(bannerSignIn()).not.toBeNull());
    expect(bannerSignIn()!.getAttribute('aria-label')).toBe('Sign in to Cursor');
    // The list the refusal sent for again says the same, and the planner stayed.
    await waitFor(() => expect(status(plannerItem('Cursor'))).toBe('Signed out'));
    expect(plannerItem('Claude Code')!.querySelector('.planner-pill')!.className).toContain('active');

    await act(async () => { fireEvent.click(bannerSignIn()!); });
    expect(openLogin).toHaveBeenCalledWith('cursor-agent', 'Cursor');
    expect(daemon.calls('settings.update')).toHaveLength(1);
  });

  it("switches a runner on in this window's workspace, which the daemon judges", async () => {
    const daemon = fakeDaemon({
      'runners.list': () => ok({ runners: [claude, cursor('unknown')], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': SETTINGS,
    });
    mount();
    await waitFor(() => expect(status(runnerItem('Cursor'))).toBe('Sign-in not checked'));

    await act(async () => { fireEvent.click(runnerItem('Cursor')!.querySelector('.runner-pill')!); });

    await waitFor(() => expect(daemon.calls('runners.setEnabled')).toHaveLength(1));
    expect(daemon.calls('runners.setEnabled')[0]).toEqual([{ id: 'cursor-agent', workspace: WORKSPACE }, { enabled: true }]);
  });
});
