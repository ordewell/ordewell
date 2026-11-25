import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import App from '../../test/ChatApp';
import { api, post } from './webview';
import type { PlannerBackend } from '../../shared/protocol';

/*
 * The graphical pickers read one readiness-to-choice rule (ADR-0052, core's
 * `runnerEntryChoice`): a confirmed blocker keeps its row, says so beside it
 * with one way back, and refuses a new pick; everything else stays choosable.
 */

const claude: PlannerBackend = {
  id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true,
  auth: { state: 'signed-in', loginCommand: ['claude', 'auth', 'login'] },
  readiness: { kind: 'ready' },
};

const cursorSignedOut: PlannerBackend = {
  id: 'cursor-agent', label: 'Cursor', kind: 'harness', runner: 'cursor-agent', usable: true,
  auth: { state: 'signed-out', loginCommand: ['cursor-agent', 'login'] },
  readiness: { kind: 'blocked', why: 'signed-out', signIn: { runner: 'cursor-agent', label: 'Cursor', login: ['cursor-agent', 'login'] } },
};

/**
 * Cline as a host lists it when its credential hook found no provider key: the
 * verdict and readiness discovery records (`signedOutAuth` with `needsKey`),
 * and the hook's own refusal as the runner's discovery error.
 */
const CLINE_SIGN_IN = { runner: 'cline', label: 'Cline', login: ['cline', 'auth'], needsKey: true as const };
const clineNoKey: PlannerBackend = {
  id: 'cline', label: 'Cline', kind: 'harness', runner: 'cline', usable: true,
  auth: { state: 'signed-out', loginCommand: ['cline', 'auth'], detail: 'no provider key', signIn: CLINE_SIGN_IN },
  readiness: { kind: 'blocked', why: 'no-credential', signIn: CLINE_SIGN_IN },
};
const CLINE_REFUSAL = 'Cline has no provider key Ordewell can hand it: Ordewell holds none for a provider Cline offers, and `/home/u/.cline/data/settings/providers.json` is missing. Run `cline auth` and choose a provider with its API key (a Cline or ClinePass account sign-in leaves no key Ordewell can read), or save the key of a provider Cline offers, such as OpenRouter, with `/key-set` in the terminal or the Desktop app, or set CLINE_PROVIDER and CLINE_API_KEY in Ordewell\'s environment.';
const CLINE_SET_UP = 'Cline has no provider API key Ordewell can hand it. Set it up with /login cline, or run cline auth, and choose an API provider and enter its key; an account sign-in alone is not enough.';

const plannerItem = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('.planner-pill-item')].find((item) => item.querySelector('.planner-pill')?.textContent === label);
const plannerPill = (label: string) => plannerItem(label)?.querySelector<HTMLButtonElement>('.planner-pill') ?? null;
const choiceStatus = (item: HTMLElement | undefined) => item?.querySelector<HTMLElement>('.runner-choice-status') ?? null;
const recovery = (item: HTMLElement | undefined) => item?.querySelector<HTMLButtonElement>('.runner-choice-recovery') ?? null;

describe('a blocked planner choice', () => {
  beforeEach(() => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
  });

  it('says Signed out beside the row, offers Sign in, and refuses a new pick', () => {
    post({ type: 'setPlannerBackends', backends: [claude, cursorSignedOut], provider: 'claude-code', runner: 'claude-code' });
    const cursor = plannerItem('Cursor');

    expect(choiceStatus(cursor)?.textContent).toBe('Signed out');
    expect(choiceStatus(cursor)?.className).toContain('tone-error');
    expect(recovery(cursor)?.textContent).toBe('Sign in');
    const pill = plannerPill('Cursor')!;
    expect(pill.getAttribute('aria-disabled')).toBe('true');
    // The status is the pill's description, so a screen reader hears why.
    expect(pill.getAttribute('aria-describedby')).toBe(choiceStatus(cursor)?.id);

    api.post.mockClear();
    fireEvent.click(pill);
    expect(api.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlanner' }));

    fireEvent.click(recovery(cursor)!);
    expect(api.post).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'cursor-agent' });
    expect(api.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlanner' }));
  });
});

const runnerItem = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('.runner-pill-item')].find((item) => item.querySelector('.runner-pill')?.textContent?.includes(name));
const runnerPill = (name: string) => runnerItem(name)?.querySelector<HTMLButtonElement>('.runner-pill') ?? null;

describe('a blocked runner choice', () => {
  beforeEach(() => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
  });

  it('lists ready runners first, says why beside a blocked one, and refuses switching it on', () => {
    post({
      type: 'setRunners',
      runners: [
        { id: 'cursor-agent', displayName: 'Cursor', enabled: false, readiness: cursorSignedOut.readiness },
        { id: 'claude-code', displayName: 'Claude Code', enabled: true, readiness: { kind: 'ready' } },
      ],
    });
    const cursor = runnerItem('Cursor');

    expect([...document.querySelectorAll('.runner-pill')].map((p) => p.textContent?.trim())).toEqual(['Claude Code', 'Cursor']);
    expect(choiceStatus(cursor)?.textContent).toBe('Signed out');
    expect(choiceStatus(cursor)?.className).toContain('tone-error');
    expect(runnerPill('Cursor')!.getAttribute('aria-disabled')).toBe('true');
    expect(runnerPill('Cursor')!.getAttribute('aria-describedby')).toBe(choiceStatus(cursor)?.id);
    expect(choiceStatus(runnerItem('Claude Code'))).toBeNull();

    api.post.mockClear();
    fireEvent.click(runnerPill('Cursor')!);
    expect(api.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setRunnerEnabled' }));
  });

  it('keeps a blocked runner that is already on, flagged, and lets it be switched off', () => {
    post({
      type: 'setRunners',
      runners: [
        { id: 'claude-code', displayName: 'Claude Code', enabled: true, readiness: { kind: 'ready' } },
        { id: 'cursor-agent', displayName: 'Cursor', enabled: true, readiness: cursorSignedOut.readiness },
      ],
    });
    post({ type: 'setPlannerBackends', backends: [claude, cursorSignedOut], provider: 'claude-code', runner: 'claude-code' });

    expect(choiceStatus(runnerItem('Cursor'))?.textContent).toBe('Signed out');
    expect(recovery(runnerItem('Cursor'))?.textContent).toBe('Sign in');
    expect(runnerPill('Cursor')!.getAttribute('aria-disabled')).toBeNull();
    api.post.mockClear();

    fireEvent.click(runnerPill('Cursor')!);
    expect(api.post).toHaveBeenCalledWith({ type: 'setRunnerEnabled', runnerId: 'cursor-agent', enabled: false, requestId: expect.any(String) });

    fireEvent.click(recovery(runnerItem('Cursor'))!);
    expect(api.post).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'cursor-agent' });
  });
});

const harness = (id: string, label: string, readiness: PlannerBackend['readiness'], auth: PlannerBackend['auth'] = { state: 'unknown' }): PlannerBackend =>
  ({ id, label, kind: 'harness', runner: id, usable: true, auth, readiness });

describe('every planner status, in the shared words', () => {
  beforeEach(() => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
  });

  it('words pending, unknown sign-in and agent default neutrally, with nothing to press and the row still choosable', () => {
    post({
      type: 'setPlannerBackends',
      backends: [
        claude,
        harness('opencode', 'OpenCode', { kind: 'pending' }),
        harness('copilot-cli', 'Copilot CLI', { kind: 'sign-in-unknown' }),
        harness('qwen-code', 'Qwen Code', { kind: 'agent-default' }),
      ],
      provider: 'claude-code', runner: 'claude-code',
    });

    for (const [label, text] of [['OpenCode', 'Checking models…'], ['Copilot CLI', 'Sign-in not checked'], ['Qwen Code', 'Uses agent default']] as const) {
      expect(choiceStatus(plannerItem(label))?.textContent).toBe(text);
      expect(choiceStatus(plannerItem(label))?.className).toContain('tone-muted');
      expect(recovery(plannerItem(label))).toBeNull();
      expect(plannerPill(label)!.getAttribute('aria-disabled')).toBeNull();
    }
    expect(choiceStatus(plannerItem('Claude Code'))).toBeNull();
    api.post.mockClear();
    fireEvent.click(plannerPill('Copilot CLI')!);
    expect(api.post).toHaveBeenCalledWith({ type: 'setPlanner', provider: 'copilot-cli', requestId: expect.any(String) });
  });

  it('keeps a failed model load choosable with Retry, and blocks a real empty catalog with Refresh models', () => {
    post({
      type: 'setPlannerBackends',
      backends: [
        claude,
        harness('opencode', 'OpenCode', { kind: 'no-usable-model' }, { state: 'signed-in' }),
        harness('pi', 'Pi', { kind: 'discovery-failed' }),
      ],
      provider: 'claude-code', runner: 'claude-code',
    });

    expect([...document.querySelectorAll('.planner-pill')].map((p) => p.textContent)).toEqual(['Claude Code', 'Pi', 'OpenCode']);
    expect(choiceStatus(plannerItem('Pi'))?.textContent).toBe("Couldn't load models");
    expect(choiceStatus(plannerItem('Pi'))?.className).toContain('tone-warning');
    expect(plannerPill('Pi')!.getAttribute('aria-disabled')).toBeNull();
    expect(choiceStatus(plannerItem('OpenCode'))?.textContent).toBe('No usable model');
    expect(plannerPill('OpenCode')!.getAttribute('aria-disabled')).toBe('true');

    for (const [label, words] of [['Pi', 'Retry'], ['OpenCode', 'Refresh models']] as const) {
      api.post.mockClear();
      expect(recovery(plannerItem(label))?.textContent).toBe(words);
      fireEvent.click(recovery(plannerItem(label))!);
      expect(api.post).toHaveBeenCalledWith({ type: 'refreshModels' });
      expect(api.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlanner' }));
    }
  });

  it("says API key needed for Cline and offers Set up Cline, which runs its setup and never a key entry that cannot reach it", () => {
    post({ type: 'setPlannerBackends', backends: [claude, clineNoKey], provider: 'claude-code', runner: 'claude-code' });
    post({ type: 'setModelDiscoveryErrors', errors: {}, runnerErrors: { cline: CLINE_REFUSAL } });
    const cline = plannerItem('Cline');

    expect(choiceStatus(cline)?.textContent).toBe('API key needed');
    expect(choiceStatus(cline)?.title).toBe(CLINE_SET_UP);
    expect(plannerPill('Cline')!.title).toBe(CLINE_SET_UP);
    expect(recovery(cline)?.textContent).toBe('Set up Cline');
    expect(recovery(cline)?.getAttribute('aria-label')).toBe('Set up Cline with a provider API key');
    api.post.mockClear();
    fireEvent.click(recovery(cline)!);
    expect(api.post.mock.calls).toEqual([[{ type: 'loginPlanner', runner: 'cline' }]]);
    // While it runs the button says what it is doing, not that Cline is signing in.
    expect(recovery(plannerItem('Cline'))?.getAttribute('aria-label')).toBe('Setting up Cline');
    expect(recovery(plannerItem('Cline'))?.textContent).toBe('Setting up…');
  });

  it('offers the same Set up Cline on the Runners pill, refusing to switch it on', () => {
    post({ type: 'setPlannerBackends', backends: [claude, clineNoKey], provider: 'claude-code', runner: 'claude-code' });
    post({
      type: 'setRunners',
      runners: [
        { id: 'cline', displayName: 'Cline', enabled: false, readiness: clineNoKey.readiness },
        { id: 'claude-code', displayName: 'Claude Code', enabled: true, readiness: { kind: 'ready' } },
      ],
    });
    const cline = runnerItem('Cline');

    expect(choiceStatus(cline)?.textContent).toBe('API key needed');
    expect(recovery(cline)?.textContent).toBe('Set up Cline');
    api.post.mockClear();
    fireEvent.click(runnerPill('Cline')!);
    expect(api.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setRunnerEnabled' }));
    fireEvent.click(recovery(cline)!);
    expect(api.post.mock.calls).toEqual([[{ type: 'loginPlanner', runner: 'cline' }]]);
  });

  it('keeps Add key for an agent Ordewell hands a key, opening the key entry on its vendor', () => {
    const qwenSignIn = { runner: 'qwen-code', label: 'Qwen Code', key: { provider: 'openrouter' as const, label: 'OpenRouter', others: 'any OpenAI-compatible provider' }, byHand: 'run qwen and sign in there', needsKey: true as const };
    post({
      type: 'setPlannerBackends',
      backends: [claude, harness('qwen-code', 'Qwen Code', { kind: 'blocked', why: 'no-credential', signIn: qwenSignIn }, { state: 'signed-out', detail: 'no provider key', signIn: qwenSignIn })],
      provider: 'claude-code', runner: 'claude-code',
    });
    const qwen = plannerItem('Qwen Code');

    expect(choiceStatus(qwen)?.textContent).toBe('API key needed');
    expect(recovery(qwen)?.textContent).toBe('Add key');
    expect(recovery(qwen)?.getAttribute('aria-label')).toBe('Add a key for Qwen Code');
    api.post.mockClear();
    fireEvent.click(recovery(qwen)!);
    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendMessage', text: '/key-set openrouter' }));
  });

  it('says Signed out with Sign in for Cline when Cline itself refused as signed out', () => {
    const signIn = { runner: 'cline', label: 'Cline', login: ['cline', 'auth'] };
    post({
      type: 'setPlannerBackends',
      backends: [claude, harness('cline', 'Cline', { kind: 'blocked', why: 'signed-out', signIn }, { state: 'signed-out', loginCommand: ['cline', 'auth'], detail: 'not logged in', signIn })],
      provider: 'claude-code', runner: 'claude-code',
    });
    expect(choiceStatus(plannerItem('Cline'))?.textContent).toBe('Signed out');
    expect(recovery(plannerItem('Cline'))?.textContent).toBe('Sign in');
  });

  it('keeps the planner in effect selected and flagged when it is blocked, with its way back', () => {
    post({ type: 'setPlannerBackends', backends: [claude, cursorSignedOut], provider: 'cursor-agent', runner: 'cursor-agent' });
    const cursor = plannerItem('Cursor');

    expect(plannerPill('Cursor')!.className).toContain('active');
    expect(plannerPill('Cursor')!.getAttribute('aria-disabled')).toBeNull();
    expect(choiceStatus(cursor)?.textContent).toBe('Signed out');
    expect(recovery(cursor)?.textContent).toBe('Sign in');
    // Signing in never re-picks or sends: the host's next list redraws it.
    api.post.mockClear();
    fireEvent.click(recovery(cursor)!);
    post({ type: 'plannerLoginEnded', runner: 'cursor-agent', ok: true });
    post({ type: 'setPlannerBackends', backends: [claude, { ...cursorSignedOut, auth: { state: 'unknown' }, readiness: { kind: 'sign-in-unknown' } }], provider: 'cursor-agent', runner: 'cursor-agent' });
    expect(api.post.mock.calls.map(([m]) => (m as { type: string }).type)).toEqual(['loginPlanner']);
    expect(choiceStatus(plannerItem('Cursor'))?.textContent).toBe('Sign-in not checked');
    expect(plannerPill('Cursor')!.className).toContain('active');
  });
});

describe("the planner's model list, by why it is empty", () => {
  const alerts = () => [...document.querySelectorAll<HTMLElement>('.model-discovery-error')];
  const planOn = (backend: PlannerBackend) =>
    post({ type: 'setPlannerBackends', backends: [claude, backend], provider: backend.id, runner: backend.runner });

  beforeEach(() => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setModelsByRunner', modelsByRunner: {} });
  });

  it('raises no alarm while the models are still being asked for, or when the agent runs on its own default', () => {
    planOn(harness('opencode', 'OpenCode', { kind: 'pending' }));
    expect(alerts()).toEqual([]);
    planOn(harness('qwen-code', 'Qwen Code', { kind: 'agent-default' }));
    expect(alerts()).toEqual([]);
  });

  it('says a failed load from a real empty catalog, each with its own way back', () => {
    planOn(harness('pi', 'Pi', { kind: 'discovery-failed' }));
    expect(alerts().map((a) => a.textContent)).toEqual(["Couldn't load models for Pi. Retry"]);
    api.post.mockClear();
    fireEvent.click(alerts()[0].querySelector('button')!);
    expect(api.post).toHaveBeenCalledWith({ type: 'refreshModels' });

    planOn(harness('opencode', 'OpenCode', { kind: 'no-usable-model' }, { state: 'signed-in' }));
    expect(alerts().map((a) => a.textContent)).toEqual(['OpenCode lists no usable model. Refresh models']);
  });

  it("keeps Cline's own credential hint for a planner that has no key", () => {
    const hint = 'Cline has no provider key Ordewell can hand it. Add one with /key-set, or sign in with `cline auth`.';
    post({ type: 'setModelDiscoveryErrors', errors: {}, runnerErrors: { cline: hint } });
    planOn(harness('cline', 'Cline', { kind: 'blocked', why: 'no-credential' }, { state: 'signed-out' }));
    expect(alerts().map((a) => a.textContent)).toEqual([hint]);
  });
});

describe('an installed runner that cannot plan', () => {
  it('is no blocker in the Runners block: it stays switchable, refused only at its start as before', () => {
    render(<App />);
    post({ type: 'setRunners', runners: [
      { id: 'claude-code', displayName: 'Claude Code', enabled: true, readiness: { kind: 'ready' } },
      { id: 'opencode', displayName: 'OpenCode', enabled: false },
    ] });
    post({ type: 'setPlannerBackends', backends: [claude, { id: 'opencode', label: 'OpenCode', kind: 'harness', runner: 'opencode', usable: false, reason: 'OpenCode 0.1 is too old' }], provider: 'claude-code', runner: 'claude-code' });
    api.post.mockClear();

    expect(runnerPill('OpenCode')!.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(runnerPill('OpenCode')!);
    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'setRunnerEnabled', runnerId: 'opencode', enabled: true }));
  });
});
