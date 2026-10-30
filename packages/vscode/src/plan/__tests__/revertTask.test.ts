import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import type { TaskRevertPreview } from '@ordewell/core';
import { handleSystemCommand, revertTaskByHand } from '../PlanManager';

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

const one = { taskId: 't1', order: 1, title: 'Parse JSON', repos: ['.'], dependent: false };
const dependent = { taskId: 't2', order: 2, title: 'Wire it up', repos: ['.'], dependent: true };

function deps(preview: TaskRevertPreview, outcome: { ok: boolean; message: string } = { ok: true, message: 'done' }) {
  const session = {
    revertPreview: vi.fn().mockResolvedValue(preview),
    execute: vi.fn().mockResolvedValue(outcome),
  };
  return { session };
}

/**
 * Revert from the task card (ADR-0054): the host asks core what would go, shows
 * it in a real modal, and sends the yes with the ids the user was shown. The
 * host decides nothing: every refusal is core's words.
 */
describe('Revert from the host', () => {
  beforeEach(() => showWarningMessage.mockReset());

  it('lists the task and every dependent that goes with it, newest first, in the modal', async () => {
    const { session } = deps({ revertible: true, tasks: [dependent, one] });
    showWarningMessage.mockResolvedValue(undefined);

    await revertTaskByHand('t1', { session: session as never });

    expect(session.revertPreview).toHaveBeenCalledWith('t1');
    const [message, options, yes] = showWarningMessage.mock.calls[0];
    expect(message).toContain('Revert task #1 Parse JSON?');
    expect(options).toMatchObject({ modal: true });
    expect(options.detail.indexOf('#2 Wire it up')).toBeGreaterThanOrEqual(0);
    expect(options.detail.indexOf('#2 Wire it up')).toBeLessThan(options.detail.indexOf('#1 Parse JSON'));
    expect(options.detail).toContain('goes with it');
    expect(yes).toBe('Revert');
  });

  it('sends nothing when the modal is dismissed', async () => {
    const { session } = deps({ revertible: true, tasks: [dependent, one] });
    showWarningMessage.mockResolvedValue(undefined);

    await revertTaskByHand('t1', { session: session as never });

    expect(session.execute).not.toHaveBeenCalled();
  });

  it('sends the yes with the ids the user was shown', async () => {
    const { session } = deps({ revertible: true, tasks: [dependent, one] });
    showWarningMessage.mockResolvedValue('Revert');

    await revertTaskByHand('t1', { session: session as never });

    expect(session.execute).toHaveBeenCalledWith({ command: 'revert_task', task: 't1', confirmed: true, seen: ['t2', 't1'] }, { kind: 'user' });
  });

  it.each([
    ['a live dependent', { revertible: false, reason: 'live-dependent', message: 'Task "Wire it up" depends on it and is still running. Nothing was reverted. Let it finish, or stop it, first.', tasks: [{ taskId: 't2', order: 2, title: 'Wire it up' }] }],
    ['a conflict with its files', { revertible: false, reason: 'git', message: 'Reverting task "Parse JSON" conflicts with what landed after it: src/a.ts. Nothing was reverted, and the integration branch is as it was.' }],
    ['work already merged, with the command', { revertible: false, reason: 'in-branch', message: 'This work is already merged into your branch, which Ordewell never writes to. To undo it there, run this: git revert -m 1 abc1234', commands: [] }],
    ['a loop still running', { revertible: false, reason: 'in-a-loop', message: 'Task "Parse JSON" is in the loop of task "Check", which has not ended. Nothing was reverted. Let the loop end first.' }],
  ] as [string, TaskRevertPreview][])('shows a refusal for %s in core\'s words and asks nothing', async (_name, preview) => {
    const { session } = deps(preview);

    await revertTaskByHand('t1', { session: session as never });

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(showWarningMessage.mock.calls[0]).toEqual([(preview as { message: string }).message]);
    expect(session.execute).not.toHaveBeenCalled();
  });

  it('shows what the seam refuses once the user said yes', async () => {
    const { session } = deps({ revertible: true, tasks: [one] }, { ok: false, message: 'What reverting task #1 takes has changed since you were asked.' });
    showWarningMessage.mockResolvedValueOnce('Revert');

    await handleSystemCommand('revertTask', 't1', { session, chatProvider: { showPlan: vi.fn() }, getCurrentPlan: vi.fn(), persistState: vi.fn() } as never);

    expect(showWarningMessage).toHaveBeenLastCalledWith('What reverting task #1 takes has changed since you were asked.');
  });

  it('names a repo only when the work went beyond the workspace\'s own', async () => {
    const { session } = deps({ revertible: true, tasks: [{ ...one, repos: ['api', 'web'] }] });
    showWarningMessage.mockResolvedValue(undefined);

    await revertTaskByHand('t1', { session: session as never });

    expect(showWarningMessage.mock.calls[0][1].detail).toContain('api, web');
  });
});
