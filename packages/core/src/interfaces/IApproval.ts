/**
 * The planner's single approval seam. Every capability that reaches beyond the
 * default read-only, in-workspace envelope — a path outside the workspace root,
 * a shell command outside the auto-allowed set, a URL fetch — routes through
 * one `request()` so the policy has exactly one owner (the same "one repair
 * owner" shape as PlanRepair).
 *
 * Surfaces supply the human channel. VS Code answers with a modal; the web
 * server currently has no prompt UI, so it denies unless the scope was
 * pre-approved through config. Denial is always a visible, actionable tool
 * result — never a silent success.
 */

export type ApprovalKind = 'external_path' | 'shell_command' | 'url_fetch';

export interface ApprovalRequest {
  kind: ApprovalKind;
  /** The concrete thing being asked about: an absolute path, a command line, a URL. */
  subject: string;
  /**
   * What a grant covers. Approving remembers this, not `subject`, so reading a
   * second file from an already-approved directory does not prompt again.
   */
  scope: string;
  /** One-line context for the prompt. */
  detail?: string;
}

export interface IApproval {
  request(req: ApprovalRequest): Promise<boolean>;
}

/** Denies everything. The safe default when a surface wires no approval channel. */
export const DENY_ALL: IApproval = {
  async request() { return false; },
};
