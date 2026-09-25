import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { ConversationEditError } from '@ordewell/core';
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

function setup(overrides: { generating?: boolean; executing?: boolean } = {}) {
  const rewound = { status: 'draft', tasks: [], conversationHistory: HISTORY };
  const session = {
    sessionId: 'sess-original',
    isExecuting: overrides.executing ?? false,
    planState: rewound,
    forkConversation: vi.fn(() => ({ sessionId: 'sess-fork', goal: 'the goal', workspace: '/ws' })),
    rewindTargets: vi.fn(() => [
      { index: 2, preview: 'first follow-up', timestamp: 't2' },
      { index: 4, preview: 'second follow-up', timestamp: 't4' },
    ]),
    rewindConversation: vi.fn(() => rewound),
    compactConversation: vi.fn(async () => ({ summary: 'the summary', keptMessages: 4 })),
  };
  const chatProvider = {
    showError: vi.fn(),
    replaceConversation: vi.fn(),
    setConversationBusy: vi.fn(),
  };
  const setCurrentPlan = vi.fn();
  const persistState = vi.fn();
  const deps = {
    session,
    chatProvider,
    setCurrentPlan,
    persistState,
    isGeneratingPlan: () => overrides.generating ?? false,
  } as unknown as ConversationDeps;
  return { deps, session, chatProvider, setCurrentPlan, persistState, rewound };
}

beforeEach(() => {
  for (const fn of [showQuickPick, showInformationMessage, showWarningMessage, withProgress, executeCommand]) fn.mockReset();
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

  it('rewinds to the picked message and rehydrates the chat and persisted state', async () => {
    showQuickPick.mockImplementation(async (items: { index: number }[]) => items.find((i) => i.index === 2));
    const { deps, session, chatProvider, setCurrentPlan, persistState, rewound } = setup();
    await rewindConversation(deps);

    expect(session.rewindConversation).toHaveBeenCalledWith(2);
    expect(setCurrentPlan).toHaveBeenCalledWith(rewound);
    expect(chatProvider.replaceConversation).toHaveBeenCalledWith(HISTORY, false);
    expect(persistState).toHaveBeenCalledTimes(1);
  });

  it('skips the picker when given a number', async () => {
    const { deps, session } = setup();
    await rewindConversation(deps, '4');

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(session.rewindConversation).toHaveBeenCalledWith(4);
  });

  it('changes nothing when the picker is cancelled', async () => {
    showQuickPick.mockResolvedValue(undefined);
    const { deps, session, chatProvider, persistState } = setup();
    await rewindConversation(deps);

    expect(session.rewindConversation).not.toHaveBeenCalled();
    expect(chatProvider.replaceConversation).not.toHaveBeenCalled();
    expect(persistState).not.toHaveBeenCalled();
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

  it('surfaces a refused rewind through the chat error and leaves the chat alone', async () => {
    const { deps, session, chatProvider, persistState } = setup();
    session.rewindConversation.mockImplementation(() => { throw new ConversationEditError('No user message at position 9 to rewind to.'); });
    await rewindConversation(deps, '9');

    expect(chatProvider.showError).toHaveBeenCalledWith(expect.stringContaining('No user message at position 9'));
    expect(chatProvider.replaceConversation).not.toHaveBeenCalled();
    expect(persistState).not.toHaveBeenCalled();
  });

  it('is allowed while a run is executing', async () => {
    const { deps, session } = setup({ executing: true });
    await rewindConversation(deps, '2');

    expect(session.rewindConversation).toHaveBeenCalledWith(2);
  });
});

describe('compact', () => {
  type Token = { onCancellationRequested: (cb: () => void) => void };
  let pressCancel: () => void;

  beforeEach(() => {
    pressCancel = () => undefined;
    withProgress.mockImplementation(async (_opts: unknown, task: (p: unknown, t: Token) => Promise<unknown>) =>
      task({}, { onCancellationRequested: (cb) => { pressCancel = cb; } }));
  });

  it('runs cancellably under a progress notification, blocking the webview input meanwhile', async () => {
    const { deps, session, chatProvider } = setup();
    let busyDuringRun: unknown;
    session.compactConversation.mockImplementation((async () => {
      busyDuringRun = chatProvider.setConversationBusy.mock.calls.at(-1)?.[0];
      return { summary: 's', keptMessages: 4 };
    }) as never);
    await compactConversation(deps);

    expect(withProgress.mock.calls[0][0]).toMatchObject({ cancellable: true });
    expect(busyDuringRun).toBe(true);
    expect(chatProvider.setConversationBusy.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it('redraws the transcript with the summary entry and persists it', async () => {
    const { deps, session, chatProvider, setCurrentPlan, persistState } = setup();
    const summarised = [{ role: 'assistant', content: 'Conversation condensed…\n\nthe summary', timestamp: 't', kind: 'compaction' }];
    session.planState = { status: 'draft', tasks: [], conversationHistory: summarised } as never;
    await compactConversation(deps);

    expect(setCurrentPlan).toHaveBeenCalledWith(session.planState);
    expect(chatProvider.replaceConversation).toHaveBeenCalledWith(summarised, false);
    expect(persistState).toHaveBeenCalledTimes(1);
    expect(showInformationMessage.mock.calls[0][0]).toContain('4');
  });

  it('wires the progress cancel button to the abort signal, and changes nothing when cancelled', async () => {
    const { deps, session, chatProvider, persistState } = setup();
    session.compactConversation.mockImplementation((async (signal: AbortSignal) => {
      pressCancel();
      expect(signal.aborted).toBe(true);
      throw new Error('aborted');
    }) as never);
    await compactConversation(deps);

    expect(chatProvider.replaceConversation).not.toHaveBeenCalled();
    expect(persistState).not.toHaveBeenCalled();
    expect(chatProvider.showError).not.toHaveBeenCalled();
    expect(showInformationMessage.mock.calls[0][0]).toMatch(/cancel.*nothing (was )?changed/i);
    expect(chatProvider.setConversationBusy).toHaveBeenLastCalledWith(false);
  });

  it('says nothing changed when the planner turn fails', async () => {
    const { deps, session, chatProvider, persistState } = setup();
    session.compactConversation.mockRejectedValue(new Error('rate limited'));
    await compactConversation(deps);

    expect(chatProvider.showError).toHaveBeenCalledWith(expect.stringMatching(/rate limited.*nothing was changed/i));
    expect(chatProvider.replaceConversation).not.toHaveBeenCalled();
    expect(persistState).not.toHaveBeenCalled();
    expect(chatProvider.setConversationBusy).toHaveBeenLastCalledWith(false);
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

describe('while a planner turn is generating', () => {
  const refused = (name: string, run: (deps: ConversationDeps) => Promise<void>, touched: (s: ReturnType<typeof setup>['session']) => ReturnType<typeof vi.fn>) =>
    it(`refuses ${name} without touching the conversation`, async () => {
      const { deps, session, chatProvider } = setup({ generating: true });
      await run(deps);

      expect(showWarningMessage).toHaveBeenCalledWith('The planner is still answering — wait for its reply, or stop it first.');
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
