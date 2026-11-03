import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { handleSessionMessage } from '../PlanManager';
import type { PlanManagerDeps } from '../PlanManager';
import type { SessionMessage } from '@ordewell/core';
import { SessionView } from '@ordewell/ui/host';

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
    chatProvider: { view: new SessionView(vi.fn()), reveal: vi.fn() } as unknown as PlanManagerDeps['chatProvider'],
    isGeneratingPlan: () => false,
  } as unknown as PlanManagerDeps;
}

describe('approval requests in the VS Code chat (#53)', () => {
  beforeEach(() => {
    showQuickPick.mockReset();
  });

  it('asks in the chat, never through a QuickPick', () => {
    handleSessionMessage(SHELL_REQUEST, minimalDeps());

    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('reveals the chat, so a request that arrives behind a hidden view is never missed', () => {
    const deps = minimalDeps();
    handleSessionMessage(SHELL_REQUEST, deps);

    expect((deps.chatProvider as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal).toHaveBeenCalledTimes(1);
  });

  it('draws the request into the conversation view, where the card answers it', () => {
    const deps = minimalDeps();
    const receive = vi.spyOn(deps.chatProvider.view.conversation, 'receive');
    handleSessionMessage(SHELL_REQUEST, deps);

    expect(receive).toHaveBeenCalledWith(SHELL_REQUEST);
  });
});
