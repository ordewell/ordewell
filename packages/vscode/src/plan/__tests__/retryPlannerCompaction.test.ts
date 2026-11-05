import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConversationEditError, PlannerNotReadyError, PlannerTurnStoppedError, recordRunnerAuth, recordedRunnerAuth, resetRunnerAuth } from '@ordewell/core';
import { handleSystemCommand, type PlanManagerDeps } from '../PlanManager';

/** Retry compaction from the bar above the composer: a planner turn, which fails or stops as one does. */
function deps(retry: () => Promise<unknown>) {
  const plan = { status: 'draft', tasks: [] };
  const session = { retryPlannerCompaction: vi.fn(retry) };
  const chatProvider = { showPlan: vi.fn(), showError: vi.fn() };
  const d = { session, chatProvider, getCurrentPlan: () => plan, persistState: vi.fn(), log: vi.fn() } as unknown as PlanManagerDeps;
  return { d, session, chatProvider, plan };
}

describe('Retry compaction in VS Code', () => {
  it('retries the paused turn on the session, then shows the plan it landed and saves it', async () => {
    const { d, session, chatProvider, plan } = deps(async () => ({}));

    await handleSystemCommand('retryPlannerCompaction', '', d);

    expect(session.retryPlannerCompaction).toHaveBeenCalledOnce();
    expect(chatProvider.showError).not.toHaveBeenCalled();
    expect(chatProvider.showPlan).toHaveBeenCalledWith(plan);
    expect(d.persistState).toHaveBeenCalled();
  });

  it('says in the chat why a retry was refused', async () => {
    const { d, chatProvider } = deps(async () => { throw new ConversationEditError('The planner is not paused on its context: there is nothing to retry.'); });

    await handleSystemCommand('retryPlannerCompaction', '', d);

    expect(chatProvider.showError).toHaveBeenCalledWith('Planner failed: The planner is not paused on its context: there is nothing to retry.');
  });

  it('says nothing of a retry the user stopped: the stop ended it on screen', async () => {
    const { d, chatProvider } = deps(async () => { throw new PlannerTurnStoppedError(); });

    await handleSystemCommand('retryPlannerCompaction', '', d);

    expect(chatProvider.showError).not.toHaveBeenCalled();
  });
});

/**
 * A retry is a planner turn too, and the signed-out refusal's own way back —
 * the runner's login — runs outside the extension host. The turn must ask the
 * workspace's account again before the session gate judges, or the user who
 * just logged in stays refused until a runner-list refresh.
 */
describe('a retry compaction after a login done outside the extension', () => {
  const SIGNED_OUT = { state: 'signed-out' as const, loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' };
  const SIGNED_IN = { state: 'signed-in' as const, loginCommand: ['claude', 'auth', 'login'] };

  afterEach(() => resetRunnerAuth());

  function host(signsIn: boolean) {
    const installation = {
      refresh: vi.fn(),
      plannerUsability: vi.fn(async () => {
        // What the re-probe records when the account was signed in since.
        if (signsIn) recordRunnerAuth('claude-code', SIGNED_IN, '/ws');
        return { usable: true };
      }),
    };
    // The Session's own gate, synchronous and reading the recorded verdict.
    const retry = async (): Promise<unknown> => {
      if (recordedRunnerAuth('claude-code', '/ws')?.state === 'signed-out') {
        throw new PlannerNotReadyError({
          code: 'signed_out', provider: 'claude-code', label: 'Claude Code', runner: 'claude-code',
          signIn: { runner: 'claude-code', label: 'Claude Code', login: ['claude', 'auth', 'login'] },
        });
      }
      return {};
    };
    const { d, session, chatProvider } = deps(retry);
    d.config = { aiProvider: 'claude-code' } as PlanManagerDeps['config'];
    d.fsAdapter = { getWorkspaceRoot: () => '/ws' } as PlanManagerDeps['fsAdapter'];
    d.runnerInstallation = installation;
    return { d, session, chatProvider, installation };
  }

  it('re-probes before retrying, so a login made with the runner\'s own command starts it', async () => {
    recordRunnerAuth('claude-code', SIGNED_OUT, '/ws');
    const h = host(true);

    await handleSystemCommand('retryPlannerCompaction', '', h.d);

    expect(h.installation.refresh).toHaveBeenCalledTimes(1);
    expect(h.installation.plannerUsability).toHaveBeenCalledWith('claude-code');
    expect(h.session.retryPlannerCompaction).toHaveBeenCalledTimes(1);
    expect(h.chatProvider.showError).not.toHaveBeenCalled();
  });

  it('still refuses to retry when the account is genuinely signed out', async () => {
    recordRunnerAuth('claude-code', SIGNED_OUT, '/ws');
    const h = host(false);

    await handleSystemCommand('retryPlannerCompaction', '', h.d);

    expect(h.installation.refresh).toHaveBeenCalledTimes(1);
    expect(h.installation.plannerUsability).toHaveBeenCalledWith('claude-code');
    expect(h.session.retryPlannerCompaction).toHaveBeenCalledTimes(1);
    expect(h.chatProvider.showError).toHaveBeenCalledWith(expect.stringContaining('Claude Code is not signed in. Sign in with /login claude-code, or run claude auth login. Then try again.'));
  });
});
