import type { SessionMessage } from '@ordewell/core';

/**
 * The VS Code side of a planner approval prompt.
 *
 * Unlike the CLI and TUI, this surface hosts the Session in-process, so there
 * is no socket and no HTTP round trip — `resolve` calls straight back into the
 * Session. The modal itself comes in as a capability so this module stays
 * testable without a window.
 */

export const ALLOW_LABEL = 'Allow';
export const DENY_LABEL = 'Deny';

export interface ApprovalUiDeps {
  /** A modal with the given choices. Resolves undefined when dismissed. */
  confirm: (message: string, options: string[]) => Promise<string | undefined>;
  /** Returns true only when the answer reached a still-actionable prompt. */
  resolve: (approvalId: string, granted: boolean) => boolean;
  /** Writes a line into the chat timeline so the decision is visible after the modal closes. */
  notifyWebview: (message: string) => void;
}

type ApprovalRequest = Extract<SessionMessage, { type: 'approval_request' }>;

/**
 * Paragraphs, not lines: the first is the question (subject included, so it
 * stands alone in a single-line affordance like a QuickPick placeholder) and
 * the rest is supporting context a surface can place separately.
 */
export function approvalPromptText(msg: ApprovalRequest): string {
  const headline = msg.kind === 'shell_command'
    ? `The planner wants to run a command: ${msg.subject}`
    : msg.kind === 'url_fetch'
      ? `The planner wants to fetch a URL: ${msg.subject}`
      : `The planner wants to read a path outside the workspace: ${msg.subject}`;

  // `detail` disambiguates the `external_path` case in particular: an
  // auto-tier command like `cat` touching an outside path reads identically
  // to a plain `read_file` without it.
  const detailLine = msg.detail ? `\n\n${msg.detail}` : '';

  // A grant covers the scope, not just this call — say so before the click,
  // not when the next call silently does not prompt.
  return `${headline}${detailLine}\n\nApproving also allows ${msg.scope} for the rest of this session.`;
}

export async function handleApprovalMessage(msg: SessionMessage, deps: ApprovalUiDeps): Promise<void> {
  if (msg.type !== 'approval_request') return;

  let granted = false;
  try {
    granted = (await deps.confirm(approvalPromptText(msg), [ALLOW_LABEL, DENY_LABEL])) === ALLOW_LABEL;
  } catch {
    // No window, or the modal failed. Denying keeps the planner moving; hanging
    // would block the research loop until its timeout with nothing on screen.
    granted = false;
  }

  let delivered = false;
  try {
    delivered = deps.resolve(msg.id, granted);
  } catch {
    // Session disposed mid-modal: the planner denies via timeout. Swallow so
    // the broadcast seam doesn't surface an unhandled rejection.
  }
  // If this answer arrived late (timeout already denied the prompt), `resolve`
  // returned false — report what actually happened rather than the click.
  deps.notifyWebview(delivered ? `${granted ? 'Approved' : 'Denied'}: ${msg.subject}` : `Approval no longer actionable (timed out or answered elsewhere): ${msg.subject}`);
}

type ApprovalDecided = Extract<SessionMessage, { type: 'approval_decided' }>;

/**
 * A decision reached with no round-trip prompt (pre-approved, remembered from
 * earlier this session, or the operator's mode floor) previously appeared
 * nowhere in the webview — indistinguishable from the model never having
 * needed approval in the first place. No modal, no resolve: the decision is
 * already final by the time this arrives.
 */
export function approvalDecisionText(msg: ApprovalDecided): string {
  const label = msg.source === 'pre-approved' ? 'pre-approved'
    : msg.source === 'remembered' ? 'remembered'
    : msg.source === 'mode' ? 'policy'
    : 'no approval channel';
  return `${msg.granted ? 'Auto-approved' : 'Auto-denied'} (${label}): ${msg.subject}`;
}

export function handleApprovalDecidedMessage(msg: SessionMessage, notifyWebview: (message: string) => void): void {
  if (msg.type !== 'approval_decided') return;
  notifyWebview(approvalDecisionText(msg));
}
