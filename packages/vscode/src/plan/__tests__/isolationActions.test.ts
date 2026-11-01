import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { handleIsolationAction, handleIsolationBlocked } from '../isolation';
import type { PlanManagerDeps } from '../PlanManager';

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
const openTextDocument = (vscode.workspace as unknown as { openTextDocument: ReturnType<typeof vi.fn> }).openTextDocument;
const showTextDocument = vscode.window.showTextDocument as unknown as ReturnType<typeof vi.fn>;

function deps() {
  const plan = { status: 'draft', tasks: [] };
  const session = {
    continueWithStash: vi.fn().mockResolvedValue(undefined),
    continueWithoutIsolation: vi.fn().mockResolvedValue(undefined),
    reviewRunDiff: vi.fn().mockResolvedValue('diff --git a/x b/x'),
    execute: vi.fn().mockResolvedValue({ ok: true, message: 'Merged the run\'s landed work into your branch. Tasks waiting at a merge gate for it can start.', payload: { kind: 'merge', result: { outcome: 'merged' } } }),
    discardRun: vi.fn().mockResolvedValue(undefined),
    cleanupRun: vi.fn().mockResolvedValue(undefined),
    resolveConflictAsTask: vi.fn().mockResolvedValue({ status: 'draft', tasks: [] }),
    planState: null,
    isExecuting: false,
    isolationView: vi.fn().mockReturnValue(null),
  };
  const chatProvider = {
    showError: vi.fn(),
    showPlan: vi.fn(),
    clearIsolationHandoff: vi.fn(),
  };
  const d = {
    session,
    chatProvider,
    getCurrentPlan: () => plan,
    setCurrentPlan: vi.fn(),
    persistState: vi.fn(),
    log: vi.fn(),
  } as unknown as PlanManagerDeps;
  return { d, session, chatProvider };
}

describe('isolation_blocked host modal (ADR-0013)', () => {
  beforeEach(() => showWarningMessage.mockReset());

  it('offers stash, run-without-isolation and cancel in one modal', () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { d } = deps();
    handleIsolationBlocked('Tracked files have uncommitted changes.', d);

    const [message, options, ...choices] = showWarningMessage.mock.calls[0] as unknown as [string, { modal?: boolean }, ...string[]];
    expect(message).toContain('uncommitted changes');
    expect(options).toMatchObject({ modal: true });
    expect(choices).toEqual(['Stash and continue', 'Run without isolation', 'Cancel']);
  });

  it('stashes and replays the parked run when asked', async () => {
    showWarningMessage.mockResolvedValue('Stash and continue');
    const { d, session } = deps();
    handleIsolationBlocked('blocked', d);
    await Promise.resolve();
    await Promise.resolve();

    expect(session.continueWithStash).toHaveBeenCalledTimes(1);
    expect(session.continueWithoutIsolation).not.toHaveBeenCalled();
  });

  it('runs in the shared root when the user declines isolation', async () => {
    showWarningMessage.mockResolvedValue('Run without isolation');
    const { d, session } = deps();
    handleIsolationBlocked('blocked', d);
    await Promise.resolve();
    await Promise.resolve();

    expect(session.continueWithoutIsolation).toHaveBeenCalledTimes(1);
    expect(session.continueWithStash).not.toHaveBeenCalled();
  });

  it('does nothing when the modal is dismissed', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { d, session } = deps();
    handleIsolationBlocked('blocked', d);
    await Promise.resolve();
    await Promise.resolve();

    expect(session.continueWithStash).not.toHaveBeenCalled();
    expect(session.continueWithoutIsolation).not.toHaveBeenCalled();
  });

  it('names a dirty group in the modal and stashes every repo when asked', async () => {
    showWarningMessage.mockResolvedValue('Stash and continue');
    const { d, session } = deps();
    const message = 'Tracked files have uncommitted changes in api, web, so tasks cannot run in isolated worktrees. Stash them, or run this plan without isolation.';
    handleIsolationBlocked(message, d);
    await Promise.resolve();
    await Promise.resolve();

    const [shown] = showWarningMessage.mock.calls[0] as unknown as [string];
    expect(shown).toContain('api, web');
    expect(session.continueWithStash).toHaveBeenCalledTimes(1);
    expect(session.continueWithoutIsolation).not.toHaveBeenCalled();
  });
});

describe('handoff actions (ADR-0013)', () => {
  beforeEach(() => {
    showWarningMessage.mockReset();
    openTextDocument.mockReset();
    showTextDocument.mockReset();
  });

  it('opens the run diff in an editor', async () => {
    const { d, session } = deps();
    await handleIsolationAction('reviewDiff', undefined, d);

    expect(session.reviewRunDiff).toHaveBeenCalledTimes(1);
    expect(openTextDocument).toHaveBeenCalledWith({ content: 'diff --git a/x b/x', language: 'diff' });
    expect(showTextDocument).toHaveBeenCalledTimes(1);
  });

  it('does not merge without an explicit confirmation', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { d, session } = deps();
    await handleIsolationAction('merge', undefined, d);

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(session.execute).not.toHaveBeenCalled();
  });

  it('merges only after the host confirms', async () => {
    showWarningMessage.mockResolvedValue('Merge');
    const { d, session } = deps();
    await handleIsolationAction('merge', undefined, d);

    expect(session.execute).toHaveBeenCalledTimes(1);
    expect(session.execute).toHaveBeenCalledWith({ command: 'merge_all' }, { kind: 'user' });
  });

  describe('past a check that has not passed (ADR-0055 D9)', () => {
    const ASKED = 'This merges work no check has passed: #2 "Check the subtree" has not.';
    const held = { ok: false, outcome: 'refused', message: ASKED, payload: { kind: 'merge_hold', checks: ['#2 "Check the subtree"'] } };
    const merged = { ok: true, message: 'Merged.', payload: { kind: 'merge', result: { outcome: 'merged' } } };

    it('asks again, naming the check, and sends the yes with the merge', async () => {
      showWarningMessage.mockResolvedValueOnce('Merge').mockResolvedValueOnce('Merge anyway');
      const { d, session } = deps();
      session.execute.mockResolvedValueOnce(held).mockResolvedValueOnce(merged);
      await handleIsolationAction('merge', undefined, d);

      expect(showWarningMessage).toHaveBeenCalledTimes(2);
      const [message, options, choice] = showWarningMessage.mock.calls[1] as unknown as [string, { modal?: boolean }, string];
      expect(message).toContain(ASKED);
      expect(options).toMatchObject({ modal: true });
      expect(choice).toBe('Merge anyway');
      expect(session.execute.mock.calls).toEqual([
        [{ command: 'merge_all' }, { kind: 'user' }],
        [{ command: 'merge_all', pastChecks: true }, { kind: 'user' }],
      ]);
    });

    it('merges nothing when the second question is dismissed, and shows no error', async () => {
      showWarningMessage.mockResolvedValueOnce('Merge').mockResolvedValueOnce(undefined);
      const { d, session, chatProvider } = deps();
      session.execute.mockResolvedValueOnce(held);
      await handleIsolationAction('merge', undefined, d);

      expect(session.execute).toHaveBeenCalledTimes(1);
      expect(chatProvider.showError).not.toHaveBeenCalled();
    });
  });

  const handoffOn = (...repos: [string, string | undefined][]) => ({
    tasks: {},
    handoff: {
      repos: repos.map(([path, baseBranch]) => ({ path, integrationBranch: 'ordewell/r1/integration', baseRef: 'aaa', ...(baseBranch ? { baseBranch } : {}), landed: [{ taskId: 't1', order: 1, title: 'One' }] })),
      landed: [{ taskId: 't1', order: 1, title: 'One' }],
    },
  });

  it('names the branch it lands on and the rule that it must be checked out, as the terminal does', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { d, session } = deps();
    session.isolationView.mockReturnValue(handoffOn(['.', 'main']));
    await handleIsolationAction('merge', undefined, d);

    const [message] = showWarningMessage.mock.calls[0] as unknown as [string];
    expect(message).toContain('into main.');
    expect(message).toContain('Nothing is merged unless main is checked out.');
  });

  it('names each repo of a group, mid-run as well', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { d, session } = deps();
    session.isolationView.mockReturnValue(handoffOn(['api', 'main'], ['web', 'develop']));
    session.isExecuting = true;
    await handleIsolationAction('merge', undefined, d);

    const [message] = showWarningMessage.mock.calls[0] as unknown as [string];
    expect(message).toContain('into each of api (main), web (develop).');
    expect(message).toContain('Nothing is merged unless each repository is on the branch it started on.');
  });

  it('keeps saying the checked-out branch when the run holds no handoff to read it from', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { d } = deps();
    await handleIsolationAction('merge', undefined, d);

    const [message] = showWarningMessage.mock.calls[0] as unknown as [string];
    expect(message).toContain('into the branch you have checked out.');
  });

  it('does not discard without an explicit confirmation', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { d, session } = deps();
    await handleIsolationAction('discard', undefined, d);

    expect(session.discardRun).not.toHaveBeenCalled();
  });

  it('discards after confirmation, and leaves the handoff to the run_closed the Session sends', async () => {
    showWarningMessage.mockResolvedValue('Discard');
    const { d, session, chatProvider } = deps();
    await handleIsolationAction('discard', undefined, d);

    expect(session.discardRun).toHaveBeenCalledTimes(1);
    expect(chatProvider.clearIsolationHandoff).not.toHaveBeenCalled();
  });

  it('cleans up the run worktrees while keeping the integration branch', async () => {
    const { d, session } = deps();
    await handleIsolationAction('cleanup', undefined, d);

    expect(session.cleanupRun).toHaveBeenCalledTimes(1);
  });

  it('resolves a conflict as an opt-in task and re-shows the plan', async () => {
    const { d, session, chatProvider } = deps();
    await handleIsolationAction('resolveConflict', 't1', d);

    expect(session.resolveConflictAsTask).toHaveBeenCalledWith('t1');
    expect(chatProvider.showPlan).toHaveBeenCalled();
  });
});
