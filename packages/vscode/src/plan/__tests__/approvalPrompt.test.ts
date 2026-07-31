import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { handleSessionMessage } from '../PlanManager';
import type { PlanManagerDeps } from '../PlanManager';
import type { SessionMessage } from '@ordewell/core';

// The vscode mock declares showQuickPick as `vi.fn() as never`; cast it to a
// real vi.Mock so mockImplementation/mock.calls typecheck against our usage.
const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;

const SHELL_REQUEST: Extract<SessionMessage, { type: 'approval_request' }> = {
  type: 'approval_request',
  id: 'ap-1',
  kind: 'shell_command',
  subject: 'npm test',
  scope: 'npm test',
  detail: 'Planner research wants to run: npm test',
};

function minimalDeps(): PlanManagerDeps {
  return {
    session: { resolveApproval: vi.fn().mockReturnValue(true) } as unknown as PlanManagerDeps['session'],
    chatProvider: { sendNewMessage: vi.fn() } as unknown as PlanManagerDeps['chatProvider'],
    isGeneratingPlan: () => false,
  } as unknown as PlanManagerDeps;
}

describe('VS Code approval prompt retirement (T5/T4)', () => {
  beforeEach(() => {
    showQuickPick.mockReset();
  });

  it('opens a cancellable prompt for approval_request', () => {
    showQuickPick.mockResolvedValue(undefined);
    handleSessionMessage(SHELL_REQUEST, minimalDeps());
    expect(showQuickPick).toHaveBeenCalledTimes(1);
    // The QuickPick was given the Allow/Deny choices and a CancellationToken.
    const call = showQuickPick.mock.calls[0] as unknown as [string[], { placeHolder: string }, vscode.CancellationToken];
    expect(call[0]).toEqual(['Allow', 'Deny']);
    expect(call[1]).toMatchObject({ placeHolder: expect.stringContaining('run a command') });
    expect(call[2]).toHaveProperty('isCancellationRequested');
  });

  // A QuickPick closes on focus loss by default, and `approvals.ts` treats a
  // dismissal as a denial — so clicking into the editor would silently answer no.
  it('does not let focus loss answer for the user', () => {
    showQuickPick.mockResolvedValue(undefined);
    handleSessionMessage(SHELL_REQUEST, minimalDeps());
    expect(showQuickPick.mock.calls[0][1]).toMatchObject({ ignoreFocusOut: true });
  });

  // A placeHolder is one line; the subject has to be in it or the user is
  // approving something the prompt never named.
  it('names the subject in the one line the prompt actually shows', () => {
    showQuickPick.mockResolvedValue(undefined);
    handleSessionMessage(SHELL_REQUEST, minimalDeps());
    const options = showQuickPick.mock.calls[0][1] as { placeHolder: string; title: string };
    expect(options.placeHolder).toContain('npm test');
    expect(options.title).toContain('rest of this session');
  });

  it('cancels the open prompt when approval_settled arrives for the same id', async () => {
    // Hold the QuickPick open so the prompt is still pending when settled fires.
    let resolvePick: (v: string | undefined) => void = () => {};
    showQuickPick.mockImplementation(() => new Promise<string | undefined>((r) => { resolvePick = r; }));
    const deps = minimalDeps();
    handleSessionMessage(SHELL_REQUEST, deps); // opens the prompt, records CTS
    await Promise.resolve();

    // Inspect the token handed to showQuickPick to observe cancellation.
    const token = (showQuickPick.mock.calls[0] as unknown as unknown[])[2] as vscode.CancellationToken;
    const cancelled = vi.fn();
    token.onCancellationRequested(() => cancelled());

    handleSessionMessage(
      { type: 'approval_settled', id: 'ap-1', granted: false } as SessionMessage,
      deps,
    );
    await Promise.resolve();

    expect(cancelled).toHaveBeenCalled();
    resolvePick(undefined);
    await Promise.resolve();
  });

  it('leaves a future prompt untouched when settled arrives for an unknown id', () => {
    showQuickPick.mockResolvedValue(undefined);
    handleSessionMessage(SHELL_REQUEST, minimalDeps());
    handleSessionMessage(
      { type: 'approval_settled', id: 'no-such-prompt', granted: false } as SessionMessage,
      minimalDeps(),
    );
    expect(showQuickPick).toHaveBeenCalledTimes(1);
  });

  it('latesive click after settled reports "no longer actionable" rather than "Approved"', async () => {
    let resolvePick: (v: string | undefined) => void = () => {};
    showQuickPick.mockImplementation(() => new Promise<string | undefined>((r) => { resolvePick = r; }));
    const resolveApproval = vi.fn().mockReturnValue(false); // already settled
    const deps = minimalDeps();
    (deps.session as unknown as { resolveApproval: typeof resolveApproval }).resolveApproval = resolveApproval;
    handleSessionMessage(SHELL_REQUEST, deps);
    await Promise.resolve();

    handleSessionMessage(
      { type: 'approval_settled', id: 'ap-1', granted: false } as SessionMessage,
      deps,
    );

    // The user clicks Allow AFTER the prompt was already settled.
    resolvePick('Allow');
    await new Promise((r) => setTimeout(r, 10)); // flush microtasks for handleApprovalMessage to resume

    expect(resolveApproval).toHaveBeenCalledWith('ap-1', true);
    const notify = vi.mocked((deps.chatProvider as unknown as { sendNewMessage: (t: string) => void }).sendNewMessage);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/no longer actionable/i), expect.any(String));
  });
});