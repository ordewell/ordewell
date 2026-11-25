import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import { DaemonHost, type DaemonHostOptions } from '../DaemonHost';
import { ChatSurface } from '../useSession';
import { fakeDaemon, ok, surfacePlan } from './fakeDaemon';

const WORKSPACE = '/work/acme';
const GOAL = 'Add a parser';
const CLAUDE_SIGN_IN = { runner: 'claude-code', label: 'Claude Code', login: ['claude', 'auth', 'login'] };
const FAILED = 'Claude Code is not signed in. Sign in with /login claude-code, or run claude auth login. Then try again.\n\nNot logged in · Please run /login';
const MODELS = ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [], providerErrors: {} });
const SETTINGS = ok({ orchestratorModel: '', aiProvider: 'claude-code', plannerThinkingEffort: '', autonomousMode: false, maxParallel: 3, modelAllowlist: {}, run: { ...RUN_SETTINGS_DEFAULTS } });
// The probe still said signed in when the turn started: the agent signed out mid-session.
const claude = { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in', loginCommand: CLAUDE_SIGN_IN.login } };

let hosts: DaemonHost[] = [];
afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts = [];
});

const failure = () => document.querySelector<HTMLElement>('.chat-msg-error');
const signIn = () => failure()?.querySelector<HTMLButtonElement>('.error-sign-in') ?? null;
const composer = () => document.querySelector<HTMLTextAreaElement>('.chat-input-wrapper textarea')!;

/**
 * A daemon whose planner turn starts, and then its runner says its user is
 * signed out: the session keeps the failure as the turn's reply, broadcast
 * with that agent's sign-in, and the call answers the turn as landed.
 */
function signedOutMidTurn(reply: { content: string; signIn?: typeof CLAUDE_SIGN_IN }) {
  let seq = 0;
  const turn = (params: unknown) => {
    const { sessionId } = params as { sessionId: string };
    const frame = (fields: Record<string, unknown>) => ({ ...fields, sessionId, stream: 'd1', seq: ++seq });
    daemon.push(sessionId,
      frame({ type: 'planner_turn_started', turnId: 't1', prompt: GOAL, startedAt: '2026-11-25T10:00:00.000Z' }),
      frame({ type: 'planner_message', turnId: 't1', timestamp: '2026-11-25T10:00:05.000Z', ...reply }),
      frame({ type: 'planner_turn_ended', turnId: 't1', outcome: 'message' }));
    return ok({ plan: surfacePlan([], 'draft') });
  };
  const daemon = fakeDaemon({
    'runners.list': ok({ runners: [claude], orchestratorModel: '' }),
    'models.list': MODELS,
    'settings.get': SETTINGS,
    'plans.converseStart': turn,
    'sessions.get': ok({ id: 'kept' }),
  });
  return daemon;
}

async function started(options: DaemonHostOptions) {
  const host = new DaemonHost(WORKSPACE, async () => null, options);
  hosts.push(host);
  render(<ChatSurface host={host} layout="conversation" />);
  await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));
  fireEvent.change(composer(), { target: { value: GOAL } });
  await act(async () => { fireEvent.keyDown(composer(), { key: 'Enter' }); });
  return host;
}

/** The desktop's chat on its daemon: a turn its runner ended signed out offers that agent's sign-in where it failed (ADR-0052). */
describe('a planner turn the desktop shows ended signed out', () => {
  it('draws the failure once, with that agent\'s sign-in, and runs its login without sending again', async () => {
    const daemon = signedOutMidTurn({ content: FAILED, signIn: CLAUDE_SIGN_IN });
    const openLogin = vi.fn(async () => ({ ended: Promise.resolve(0) }));
    await started({ openLogin, pollMs: 60_000 });

    await waitFor(() => expect(signIn()).not.toBeNull());
    expect(failure()!.textContent).toContain('Not logged in · Please run /login');
    expect(document.querySelectorAll('.chat-msg-error')).toHaveLength(1);
    expect(document.querySelector('.error-state')).toBeNull();
    expect(signIn()!.getAttribute('aria-label')).toBe('Sign in to Claude Code');

    await act(async () => { fireEvent.click(signIn()!); });

    expect(openLogin).toHaveBeenCalledWith('claude-code', 'Claude Code');
    await waitFor(() => expect(failure()!.querySelector('.error-sign-in-outcome')?.textContent).toBe('Signed in to Claude Code. Send your message again.'));
    expect(daemon.calls('plans.converseStart')).toHaveLength(1);
    expect(daemon.calls('plans.converseMessage')).toHaveLength(0);
  });

  it('draws an ordinary reply about signing in as the planner\'s, with no sign-in', async () => {
    signedOutMidTurn({ content: 'Run claude auth login if you are not logged in.' });
    await started({ pollMs: 60_000 });

    await waitFor(() => expect(document.querySelector('.chat-msg-planner, .chat-msg-assistant')?.textContent ?? document.body.textContent).toContain('Run claude auth login'));
    expect(failure()).toBeNull();
    expect(document.querySelector('.error-sign-in')).toBeNull();
  });
});
