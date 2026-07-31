import { describe, it, expect, vi } from 'vitest';
import { approvalPromptText, handleApprovalMessage, approvalDecisionText, handleApprovalDecidedMessage, ALLOW_LABEL, DENY_LABEL, type ApprovalUiDeps } from '../approvals';
import type { SessionMessage } from '@ordewell/core';

const SHELL: SessionMessage = {
  type: 'approval_request',
  id: 'ap-1',
  kind: 'shell_command',
  subject: 'npm test',
  scope: 'npm test',
  detail: 'Planner research wants to run: npm test',
};

const PATH: SessionMessage = {
  type: 'approval_request',
  id: 'ap-2',
  kind: 'external_path',
  subject: '/tmp/dump/a.log',
  scope: '/tmp/dump/*',
};

function deps(overrides: Partial<ApprovalUiDeps> = {}): ApprovalUiDeps {
  return {
    confirm: vi.fn().mockResolvedValue(ALLOW_LABEL),
    resolve: vi.fn().mockReturnValue(true),
    notifyWebview: vi.fn(),
    ...overrides,
  };
}

describe('approvalPromptText', () => {
  it('leads with the command for a shell request', () => {
    const text = approvalPromptText(SHELL);
    expect(text).toContain('npm test');
    expect(text).toMatch(/run/i);
  });

  it('names the workspace escape for a path request', () => {
    expect(approvalPromptText(PATH)).toMatch(/outside the workspace/i);
    expect(approvalPromptText(PATH)).toContain('/tmp/dump/a.log');
  });

  it('discloses the wider grant, since one yes covers the whole scope', () => {
    expect(approvalPromptText(PATH)).toContain('/tmp/dump/*');
  });

  it('surfaces detail, since an auto-tier command touching an outside path otherwise reads identically to a plain read', () => {
    expect(approvalPromptText(SHELL)).toContain('Planner research wants to run: npm test');
  });

  it('omits the detail line entirely when the message carries none', () => {
    expect(approvalPromptText(PATH)).not.toMatch(/\n\s*undefined/);
  });
});

describe('handleApprovalMessage', () => {
  it('ignores messages that are not approval requests', async () => {
    const d = deps();
    await handleApprovalMessage({ type: 'queue_ready' } as SessionMessage, d);

    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.resolve).not.toHaveBeenCalled();
  });

  it('grants when the user picks allow', async () => {
    const d = deps();
    await handleApprovalMessage(SHELL, d);

    expect(d.resolve).toHaveBeenCalledWith('ap-1', true);
  });

  it('denies when the user picks deny', async () => {
    const d = deps({ confirm: vi.fn().mockResolvedValue(DENY_LABEL) });
    await handleApprovalMessage(SHELL, d);

    expect(d.resolve).toHaveBeenCalledWith('ap-1', false);
  });

  // Dismissing a VS Code modal returns undefined; that must not read as consent.
  it('denies when the modal is dismissed', async () => {
    const d = deps({ confirm: vi.fn().mockResolvedValue(undefined) });
    await handleApprovalMessage(SHELL, d);

    expect(d.resolve).toHaveBeenCalledWith('ap-1', false);
  });

  it('offers allow and deny as the two choices', async () => {
    const d = deps();
    await handleApprovalMessage(SHELL, d);

    expect(d.confirm).toHaveBeenCalledWith(expect.stringContaining('npm test'), [ALLOW_LABEL, DENY_LABEL]);
  });

  it('records the decision in the chat timeline so the webview shows what happened', async () => {
    const d = deps();
    await handleApprovalMessage(SHELL, d);

    expect(d.notifyWebview).toHaveBeenCalledWith(expect.stringMatching(/approved/i));
  });

  it('records a denial too', async () => {
    const d = deps({ confirm: vi.fn().mockResolvedValue(DENY_LABEL) });
    await handleApprovalMessage(SHELL, d);

    expect(d.notifyWebview).toHaveBeenCalledWith(expect.stringMatching(/denied/i));
  });

  it('denies rather than hanging when the modal itself fails', async () => {
    const d = deps({ confirm: vi.fn().mockRejectedValue(new Error('no window')) });
    await handleApprovalMessage(SHELL, d);

    expect(d.resolve).toHaveBeenCalledWith('ap-1', false);
  });

  it('does not surface an unhandled rejection when resolve throws on a disposed session', async () => {
    const d = deps({ resolve: vi.fn().mockImplementation(() => { throw new Error('session disposed'); }) });
    await expect(handleApprovalMessage(SHELL, d)).resolves.toBeUndefined();
    expect(d.notifyWebview).toHaveBeenCalledWith(expect.stringMatching(/no longer actionable|denied/i));
  });

  // T5: an answer that arrives after the prompt already timed out (or was
  // answered elsewhere) must report what actually happened, not the click.
  it('reports the prompt is no longer actionable when resolve returns false', async () => {
    const d = deps({ confirm: vi.fn().mockResolvedValue(ALLOW_LABEL), resolve: vi.fn().mockReturnValue(false) });
    await handleApprovalMessage(SHELL, d);

    expect(d.notifyWebview).toHaveBeenCalledWith(expect.stringMatching(/no longer actionable/i));
  });

  it('retires the prompt when the request is settled elsewhere', async () => {
    const d = deps();
    await handleApprovalMessage({ type: 'approval_settled', id: 'ap-1', granted: true } as SessionMessage, d);

    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.resolve).not.toHaveBeenCalled();
  });

  it('ignores a silent decision — that is handleApprovalDecidedMessage\'s job, not this one\'s', async () => {
    const d = deps();
    await handleApprovalMessage(
      { type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: true, source: 'pre-approved' } as SessionMessage,
      d,
    );

    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.resolve).not.toHaveBeenCalled();
  });
});

const DECIDED_GRANT: Extract<SessionMessage, { type: 'approval_decided' }> = {
  type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: true, source: 'pre-approved',
};
const DECIDED_DENY: Extract<SessionMessage, { type: 'approval_decided' }> = {
  type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: false, source: 'mode',
};

describe('approvalDecisionText', () => {
  it('labels a pre-approved grant', () => {
    expect(approvalDecisionText(DECIDED_GRANT)).toMatch(/auto-approved/i);
    expect(approvalDecisionText(DECIDED_GRANT)).toContain('pre-approved');
  });

  it('labels a mode-floor denial', () => {
    expect(approvalDecisionText(DECIDED_DENY)).toMatch(/auto-denied/i);
    expect(approvalDecisionText(DECIDED_DENY)).toContain('policy');
  });
});

describe('handleApprovalDecidedMessage', () => {
  it('notifies the webview — no modal, no resolve: the decision is already final', () => {
    const notify = vi.fn();
    handleApprovalDecidedMessage(DECIDED_GRANT, notify);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('npm test'));
  });

  it('ignores messages that are not silent decisions', () => {
    const notify = vi.fn();
    handleApprovalDecidedMessage(SHELL, notify);

    expect(notify).not.toHaveBeenCalled();
  });
});
