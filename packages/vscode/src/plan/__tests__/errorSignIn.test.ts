import { describe, expect, it, vi } from 'vitest';
import { PlannerNotReadyError, RunnerRegistry, RunnerSignedOutError, type RunnerSignIn } from '@ordewell/core';
import type { HostToWebview } from '@ordewell/ui/protocol';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import { reportPlannerError, type PlanManagerDeps } from '../PlanManager';
import { loginPlanner, type PlannerLoginDeps } from '../PlannerLogin';
import { wrappedCommand } from '../loginTerminal';

const CURSOR: RunnerSignIn = { runner: 'cursor-agent', label: 'Cursor', login: ['cursor-agent', 'login'] };

/** What VS Code's chat is sent for a failed planner turn, through the provider the webview listens to. */
function chat() {
  const messages: HostToWebview[] = [];
  const chatProvider = new ChatViewProvider({ toString: () => 'file:///extension' } as never);
  chatProvider.postMessage = (message) => { messages.push(message); };
  const deps = { chatProvider } as unknown as PlanManagerDeps;
  const errors = () => messages.filter((m): m is Extract<HostToWebview, { type: 'showError' }> => m.type === 'showError');
  return { deps, errors };
}

/** A refusal that names a signed-out agent carries that agent to the chat's error, for its Sign in (ADR-0052). */
describe('a planner error VS Code shows for a signed-out agent', () => {
  it('carries the agent a preflight refusal names', () => {
    const h = chat();

    reportPlannerError(new PlannerNotReadyError({ code: 'signed_out', provider: 'cursor-agent', label: 'Cursor', runner: 'cursor-agent', signIn: CURSOR }), h.deps);

    expect(h.errors()).toEqual([{
      type: 'showError',
      error: 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login. Then try again.',
      code: 'planner_not_ready',
      signIn: CURSOR,
    }]);
  });

  it('carries the agent that refused to start, worded as its own sign-in hint', () => {
    const h = chat();
    const hint = 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login.';

    reportPlannerError(new RunnerSignedOutError(CURSOR, hint), h.deps);

    expect(h.errors()).toEqual([{ type: 'showError', error: hint, signIn: CURSOR }]);
  });

  it('carries no agent for a failure that names none, or a missing key', () => {
    const h = chat();

    reportPlannerError(new Error('runner exited'), h.deps);
    reportPlannerError(new PlannerNotReadyError({ code: 'no_key', provider: 'openrouter', label: 'OpenRouter', keyEnvVar: 'OPENROUTER_API_KEY' }), h.deps);

    expect(h.errors().map((m) => m.signIn)).toEqual([undefined, undefined]);
  });
});

/** The error's Sign in names its runner, so the login is that agent's even while another planner is picked. */
describe('the sign-in an error asks for', () => {
  it('signs in the refused status-less agent, not the planner picked now, and rechecks it once the terminal closes', async () => {
    let rechecked = false;
    const closeListeners: Array<(t: unknown) => void> = [];
    const terminal = {
      exitStatus: undefined as { code: number } | undefined,
      // The login is the terminal's own process, and it exits once in view.
      show: vi.fn(() => {
        terminal.exitStatus = { code: 0 };
        for (const cb of closeListeners) cb(terminal);
      }),
    };
    const post = vi.fn();
    const recheck = vi.fn(async () => { rechecked = true; return { usable: true, auth: { state: 'signed-in' as const } }; });
    let launched: { shellPath?: string; shellArgs?: string[] | string } | undefined;
    const deps = {
      runnerInstallation: {
        runnerUsability: vi.fn(async (runner: string) => {
          return { usable: true, auth: { state: rechecked ? 'signed-in' : 'signed-out', loginCommand: runner === 'cursor-agent' ? CURSOR.login : ['claude', 'auth', 'login'] } };
        }),
        refresh: vi.fn(),
        recheck,
      },
      runnerRegistry: new RunnerRegistry(),
      launch: { resolvePath: async () => '/fake/bin', exists: (file: string) => file === '/fake/bin/cursor-agent' },
      config: { aiProvider: 'claude-code' },
      workspaceRoot: () => '/ws',
      env: async () => ({}),
      sendState: vi.fn(async () => {}),
      post,
      notifications: { info: vi.fn(), warn: vi.fn() },
      window: {
        createTerminal: vi.fn((o: { shellPath?: string; shellArgs?: string[] | string }) => { launched = o; return terminal; }),
        onDidCloseTerminal: vi.fn((cb: (t: unknown) => void) => { closeListeners.push(cb); return { dispose: vi.fn() }; }),
      },
      sleep: async () => undefined,
      now: () => 0,
      platform: 'linux',
    } as unknown as PlannerLoginDeps;

    await loginPlanner(deps, CURSOR.runner);

    expect(launched?.shellPath).toBe('/bin/sh');
    expect(wrappedCommand(launched ?? {})).toEqual(['/fake/bin/cursor-agent', 'login']);
    expect(recheck).toHaveBeenCalledWith('cursor-agent');
    expect(post).toHaveBeenLastCalledWith({ type: 'plannerLoginEnded', runner: 'cursor-agent', ok: true });
  });
});
