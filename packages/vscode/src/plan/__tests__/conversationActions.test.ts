import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ConversationEditError, PlannerNotReadyError, PlannerTurnDiscardedError, PlannerTurnStoppedError, recordRunnerAuth, recordedRunnerAuth, resetRunnerAuth } from '@ordewell/core';
import { forkConversation, rewindConversation, compactConversation, type ConversationDeps } from '../conversation';

const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
const showInformationMessage = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
const withProgress = vscode.window.withProgress as unknown as ReturnType<typeof vi.fn>;
const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;

const HISTORY = [
  { role: 'user', content: 'the goal', timestamp: '2026-01-01T00:00:00Z' },
  { role: 'assistant', content: 'a reply', timestamp: '2026-01-01T00:00:01Z' },
];

function setup(overrides: {
  generating?: boolean;
  executing?: boolean;
  runnerInstallation?: ConversationDeps['runnerInstallation'];
} = {}) {
  const current = { status: 'draft', tasks: [], conversationHistory: HISTORY };
  const session = {
    sessionId: 'sess-original',
    isExecuting: overrides.executing ?? false,
    planState: current,
    forkConversation: vi.fn(() => ({ sessionId: 'sess-fork', goal: 'the goal', workspace: '/ws' })),
    rewindTargets: vi.fn(() => [
      { index: 2, preview: 'first follow-up', content: 'first follow-up', timestamp: 't2' },
      { index: 4, preview: 'second follow-up', content: 'second follow-up', timestamp: 't4' },
    ]),
    rewindConversation: vi.fn(() => ({ sessionId: 'sess-rewound', goal: 'the goal', workspace: '/ws', rewoundMessage: 'first follow-up\nin full' })),
    compactConversation: vi.fn(async () => ({ summary: 'the summary', keptMessages: 4 })),
  };
  const chatProvider = {
    showError: vi.fn(),
  };
  const setCurrentPlan = vi.fn();
  const persistState = vi.fn();
  const deps = {
    session,
    chatProvider,
    setCurrentPlan,
    persistState,
    isGeneratingPlan: () => overrides.generating ?? false,
    config: { aiProvider: 'claude-code' },
    fsAdapter: { getWorkspaceRoot: () => '/ws' },
    runnerInstallation: overrides.runnerInstallation,
  } as unknown as ConversationDeps;
  return { deps, session, chatProvider, setCurrentPlan, persistState };
}

beforeEach(() => {
  for (const fn of [showQuickPick, showInformationMessage, showWarningMessage, withProgress, executeCommand]) fn.mockReset();
});

describe('a fork that could not be opened', () => {
  it('is not said to be where the user is now', async () => {
    executeCommand.mockResolvedValue(false);
    const { deps } = setup();

    await forkConversation(deps);

    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('is not said to be where a rewind put them', async () => {
    executeCommand.mockResolvedValue(false);
    const { deps } = setup();

    await rewindConversation(deps, '2');

    expect(showInformationMessage).not.toHaveBeenCalled();
  });
});

describe('fork', () => {
  it('switches the extension to the fork and says the original is kept', async () => {
    const { deps, session } = setup();
    await forkConversation(deps);

    expect(session.forkConversation).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith('ordewell.loadSessionById', 'sess-fork');
    const notice = showInformationMessage.mock.calls[0][0] as string;
    expect(notice).toContain('sess-original');
    expect(notice).toContain('sess-fork');
    expect(notice).toMatch(/original.*kept/i);
  });

  it('asks before switching away from a run in progress, and forks nothing if declined', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { deps, session } = setup({ executing: true });
    await forkConversation(deps);

    expect(showWarningMessage.mock.calls[0][1]).toMatchObject({ modal: true });
    expect(session.forkConversation).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('forks when the user accepts stopping the run', async () => {
    showWarningMessage.mockResolvedValue('Fork and stop the run');
    const { deps } = setup({ executing: true });
    await forkConversation(deps);

    expect(executeCommand).toHaveBeenCalledWith('ordewell.loadSessionById', 'sess-fork');
  });

  it('reports a conversation-less session through the chat error', async () => {
    const { deps, session, chatProvider } = setup();
    session.forkConversation.mockImplementation(() => { throw new ConversationEditError('No planning conversation to fork'); });
    await forkConversation(deps);

    expect(chatProvider.showError).toHaveBeenCalledWith(expect.stringContaining('No planning conversation to fork'));
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

describe('rewind', () => {
  it('offers the user messages most recent first, numbered with their preview', async () => {
    showQuickPick.mockResolvedValue(undefined);
    const { deps } = setup();
    await rewindConversation(deps);

    const items = showQuickPick.mock.calls[0][0] as { label: string }[];
    expect(items.map((i) => i.label)).toEqual(['4  second follow-up', '2  first follow-up']);
  });

  it('forks from just before the picked message, switches to the fork, and says the original is kept', async () => {
    showQuickPick.mockImplementation(async (items: { index: number }[]) => items.find((i) => i.index === 2));
    const { deps, session } = setup();
    await rewindConversation(deps);

    expect(session.rewindConversation).toHaveBeenCalledWith(2);
    expect(executeCommand).toHaveBeenCalledWith('ordewell.loadSessionById', 'sess-rewound');
    const notice = showInformationMessage.mock.calls[0][0] as string;
    expect(notice).toContain('sess-original');
    expect(notice).toContain('sess-rewound');
    expect(notice).toMatch(/original.*kept/i);
  });

  it('skips the picker when given a number', async () => {
    const { deps, session } = setup();
    await rewindConversation(deps, '4');

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(session.rewindConversation).toHaveBeenCalledWith(4);
  });

  it('changes nothing when the picker is cancelled', async () => {
    showQuickPick.mockResolvedValue(undefined);
    const { deps, session } = setup();
    await rewindConversation(deps);

    expect(session.rewindConversation).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('says so when the goal is the only message', async () => {
    const { deps, session } = setup();
    session.rewindTargets.mockReturnValue([]);
    await rewindConversation(deps);

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showInformationMessage.mock.calls[0][0]).toMatch(/nothing to rewind/i);
  });

  it('rejects an argument that is not a message number', async () => {
    const { deps, session } = setup();
    await rewindConversation(deps, 'two');

    expect(session.rewindConversation).not.toHaveBeenCalled();
    expect(showWarningMessage.mock.calls[0][0]).toContain('Usage: /rewind');
  });

  it('surfaces a refused rewind through the chat error and stays in the session', async () => {
    const { deps, session, chatProvider } = setup();
    session.rewindConversation.mockImplementation(() => { throw new ConversationEditError('No user message at position 9 to rewind to.'); });
    await rewindConversation(deps, '9');

    expect(chatProvider.showError).toHaveBeenCalledWith(expect.stringContaining('No user message at position 9'));
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('asks before switching away from a run in progress, and forks nothing if declined', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { deps, session } = setup({ executing: true });
    await rewindConversation(deps, '2');

    expect(showWarningMessage.mock.calls[0][1]).toMatchObject({ modal: true });
    expect(session.rewindConversation).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('rewinds mid-run when the user accepts stopping the run', async () => {
    showWarningMessage.mockResolvedValue('Fork and stop the run');
    const { deps, session } = setup({ executing: true });
    await rewindConversation(deps, '2');

    expect(session.rewindConversation).toHaveBeenCalledWith(2);
    expect(executeCommand).toHaveBeenCalledWith('ordewell.loadSessionById', 'sess-rewound');
  });
});

describe('compact', () => {
  // The session's own events draw it: a status while it runs, a quiet marker after (ADR-0017).
  it('runs with no notification and no popup, and persists what it condensed', async () => {
    const { deps, session, setCurrentPlan, persistState } = setup();
    await compactConversation(deps);

    expect(session.compactConversation).toHaveBeenCalledTimes(1);
    expect(withProgress).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(setCurrentPlan).toHaveBeenCalledWith(session.planState);
    expect(persistState).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stopped', new PlannerTurnStoppedError()],
    ['dropped with its plan', new PlannerTurnDiscardedError()],
  ])('says nothing more when %s: nothing changed, and the marker says so', async (_case, err) => {
    const { deps, session, chatProvider, persistState } = setup();
    session.compactConversation.mockRejectedValue(err);
    await compactConversation(deps);

    expect(chatProvider.showError).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(persistState).not.toHaveBeenCalled();
  });

  it('says nothing changed when the planner turn fails', async () => {
    const { deps, session, chatProvider, persistState } = setup();
    session.compactConversation.mockRejectedValue(new Error('rate limited'));
    await compactConversation(deps);

    expect(chatProvider.showError).toHaveBeenCalledWith(expect.stringMatching(/rate limited.*nothing was changed/i));
    expect(persistState).not.toHaveBeenCalled();
  });

  it('words a planner the session refused with the chat\'s own commands', async () => {
    const { deps, session, chatProvider } = setup();
    session.compactConversation.mockRejectedValue(new PlannerNotReadyError({ code: 'no_model', provider: 'openrouter', label: 'OpenRouter' }));
    await compactConversation(deps);

    expect(chatProvider.showError).toHaveBeenCalledWith(
      'Could not condense the conversation: No planner model selected for OpenRouter. Pick one with /planner. Nothing was changed.',
    );
  });

  it('reports a session with no conversation through the chat error', async () => {
    const { deps, session, chatProvider } = setup();
    session.compactConversation.mockRejectedValue(new ConversationEditError('No planning conversation to condense'));
    await compactConversation(deps);

    expect(chatProvider.showError).toHaveBeenCalledWith(expect.stringContaining('No planning conversation to condense'));
  });

  it('is allowed while a run is executing', async () => {
    const { deps, session } = setup({ executing: true });
    await compactConversation(deps);

    expect(session.compactConversation).toHaveBeenCalledTimes(1);
  });
});

/**
 * A compaction is a planner turn too, and the signed-out refusal's own way
 * back — the runner's login — runs outside the extension host. The turn must
 * ask the workspace's account again before the session gate judges, or the
 * user who just logged in stays refused until a runner-list refresh.
 */
describe('a compaction after a login done outside the extension', () => {
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
    const { deps, session, chatProvider, persistState } = setup({ runnerInstallation: installation });
    const refreshPlannerState = vi.fn(async () => {});
    deps.refreshPlannerState = refreshPlannerState;
    // The Session's own gate, synchronous and reading the recorded verdict.
    session.compactConversation.mockImplementation(async () => {
      if (recordedRunnerAuth('claude-code', '/ws')?.state === 'signed-out') {
        throw new PlannerNotReadyError({
          code: 'signed_out', provider: 'claude-code', label: 'Claude Code', runner: 'claude-code',
          loginCommand: ['claude', 'auth', 'login'],
        });
      }
      return { summary: 'the summary', keptMessages: 4 };
    });
    return { deps, session, chatProvider, persistState, installation, refreshPlannerState };
  }

  it('re-probes before condensing, so a login made with the runner\'s own command starts it', async () => {
    recordRunnerAuth('claude-code', SIGNED_OUT, '/ws');
    const h = host(true);

    await compactConversation(h.deps);

    expect(h.installation.refresh).toHaveBeenCalledTimes(1);
    expect(h.installation.plannerUsability).toHaveBeenCalledWith('claude-code');
    expect(h.session.compactConversation).toHaveBeenCalledTimes(1);
    expect(h.chatProvider.showError).not.toHaveBeenCalled();
    expect(h.persistState).toHaveBeenCalledTimes(1);
    // The pill and empty state stop offering a login the gate just accepted.
    expect(h.refreshPlannerState).toHaveBeenCalledTimes(1);
  });

  it('still refuses to condense when the account is genuinely signed out', async () => {
    recordRunnerAuth('claude-code', SIGNED_OUT, '/ws');
    const h = host(false);

    await compactConversation(h.deps);

    expect(h.installation.refresh).toHaveBeenCalledTimes(1);
    expect(h.installation.plannerUsability).toHaveBeenCalledWith('claude-code');
    expect(h.session.compactConversation).toHaveBeenCalledTimes(1);
    expect(h.chatProvider.showError).toHaveBeenCalledWith(expect.stringContaining('Claude Code not logged in'));
    expect(h.persistState).not.toHaveBeenCalled();
    expect(h.refreshPlannerState).not.toHaveBeenCalled();
  });
});

describe('while a planner turn is generating', () => {
  const refused = (name: string, run: (deps: ConversationDeps) => Promise<void>, touched: (s: ReturnType<typeof setup>['session']) => ReturnType<typeof vi.fn>) =>
    it(`refuses ${name} without touching the conversation`, async () => {
      const { deps, session, chatProvider } = setup({ generating: true });
      await run(deps);

      expect(showWarningMessage).toHaveBeenCalledWith('The planner is still answering: wait for its reply, or stop it first.');
      expect(touched(session)).not.toHaveBeenCalled();
      expect(showQuickPick).not.toHaveBeenCalled();
      expect(withProgress).not.toHaveBeenCalled();
      expect(chatProvider.showError).not.toHaveBeenCalled();
    });

  refused('fork', forkConversation, (s) => s.forkConversation);
  refused('rewind', (d) => rewindConversation(d), (s) => s.rewindConversation);
  refused('rewind <n>', (d) => rewindConversation(d, '2'), (s) => s.rewindConversation);
  refused('compact', compactConversation, (s) => s.compactConversation);
});
