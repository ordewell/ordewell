import type { ApprovalRequest } from '../interfaces/IApproval';

/**
 * The bridge between "core needs an answer" and "a human somewhere is looking
 * at a UI". Core cannot prompt: the human may be at a browser, a TUI, a CLI
 * stream, or a VS Code webview, and on the web server they are on the far end
 * of a socket. So the Session parks a promise here, announces the request
 * through the normal broadcast seam, and every surface answers through the
 * same `resolve(id, granted)` call.
 *
 * Timeouts are load-bearing rather than defensive: a planner turn that blocks
 * forever on an unanswered prompt would hang the whole research loop with no
 * visible cause. On expiry the request resolves to denied and the model gets a
 * normal, actionable tool result.
 */

export interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  createdAt: string;
}

export interface PendingApprovalsOptions {
  /** Denies and resolves after this long with no answer. Default 5 minutes. */
  timeoutMs?: number;
  /** Announce a new request to the surfaces. */
  onRequest?: (pending: PendingApproval) => void;
  /** Announce that a request is no longer actionable (answered or expired). */
  onSettled?: (id: string, granted: boolean) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

let counter = 0;

export class PendingApprovals {
  private readonly entries = new Map<string, {
    pending: PendingApproval;
    settle: (granted: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly opts: PendingApprovalsOptions = {}) {}

  /** Park a request and return the promise the approval policy awaits. */
  ask(request: ApprovalRequest): Promise<boolean> {
    const id = `ap-${Date.now()}-${counter++}`;
    const pending: PendingApproval = { id, request, createdAt: new Date().toISOString() };

    return new Promise<boolean>((resolve) => {
      const settle = (granted: boolean) => {
        const entry = this.entries.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.entries.delete(id);
        this.opts.onSettled?.(id, granted);
        resolve(granted);
      };

      const timer = setTimeout(() => settle(false), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      // Never hold the process open on a prompt nobody is watching.
      (timer as unknown as { unref?: () => void }).unref?.();

      this.entries.set(id, { pending, settle, timer });
      this.opts.onRequest?.(pending);
    });
  }

  /** Answer one request. Returns false when the id is unknown or already settled. */
  resolve(id: string, granted: boolean): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.settle(granted);
    return true;
  }

  /** Everything still awaiting an answer — replayed to a surface that connects late. */
  outstanding(): PendingApproval[] {
    return [...this.entries.values()].map((e) => e.pending);
  }

  /** Deny everything in flight. Called on abort and on session reset. */
  clear(): void {
    for (const id of [...this.entries.keys()]) this.resolve(id, false);
  }
}
