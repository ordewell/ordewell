import { isGranted, toApprovalDecision, type ApprovalAnswer, type ApprovalDecision, type ApprovalRequest } from '../interfaces/IApproval';

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
 * normal, actionable tool result. A task runner's request is the exception
 * (ADR-0018, A1): the runner is parked on it rather than a research loop, and
 * it waits for a person — or the supervisor — however long that takes.
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
  onSettled?: (id: string, granted: boolean, settled: { request: ApprovalRequest; decision: ApprovalDecision }) => void;
}

export interface AskOptions {
  /**
   * An id the caller already announced the request under. One still in use is
   * refused — denied at once — rather than overwriting the request that has it.
   */
  id?: string;
  /** Wait for an answer however long it takes. */
  noTimeout?: boolean;
  /**
   * Given the answer as the request settles, before anything awaiting the
   * promise runs: a caller about to tear down what asked (a runner being
   * stopped) must deliver the answer before it goes.
   */
  onDecision?: (decision: ApprovalDecision) => void;
  /** Aborting it withdraws the request: it settles as a denial, which takes its card off every surface. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

let counter = 0;

export class PendingApprovals {
  private readonly entries = new Map<string, {
    pending: PendingApproval;
    settle: (decision: ApprovalDecision) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  private readonly listeners = new Set<(pending: PendingApproval) => void>();

  constructor(private readonly opts: PendingApprovalsOptions = {}) {}

  /** Hear each new request once it is announced — the supervisor wakes on a runner's (ADR-0029). */
  listen(listener: (pending: PendingApproval) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Park a request and return the promise the approval policy awaits. */
  ask(request: ApprovalRequest, options: AskOptions = {}): Promise<boolean> {
    return this.decide(request, options).then(isGranted);
  }

  /** Park a request whose answer is more than yes or no. */
  decide(request: ApprovalRequest, options: AskOptions = {}): Promise<ApprovalDecision> {
    const id = options.id ?? `ap-${Date.now()}-${counter++}`;
    if (this.entries.has(id) || options.signal?.aborted) {
      const refused: ApprovalDecision = { decision: 'deny' };
      options.onDecision?.(refused);
      return Promise.resolve(refused);
    }
    const pending: PendingApproval = { id, request, createdAt: new Date().toISOString() };

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (decision: ApprovalDecision) => {
        const entry = this.entries.get(id);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        this.entries.delete(id);
        options.onDecision?.(decision);
        this.opts.onSettled?.(id, isGranted(decision), { request, decision });
        resolve(decision);
      };

      let timer: ReturnType<typeof setTimeout> | null = null;
      if (!options.noTimeout) {
        timer = setTimeout(() => settle({ decision: 'deny' }), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        // Never hold the process open on a prompt nobody is watching.
        (timer as unknown as { unref?: () => void }).unref?.();
      }

      this.entries.set(id, { pending, settle, timer });
      options.signal?.addEventListener('abort', () => settle({ decision: 'deny' }), { once: true });
      this.opts.onRequest?.(pending);
      for (const listener of this.listeners) listener(pending);
    });
  }

  /**
   * Answer one request. Returns false when the id is unknown or already
   * settled. "Allow for this task" on a request that did not offer it is a
   * plain allow: no grant is made that the requester never proposed.
   */
  resolve(id: string, answer: ApprovalAnswer): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const decision = toApprovalDecision(answer);
    entry.settle(decision.decision === 'allowForTask' && !entry.pending.request.allowForTask ? { decision: 'allow' } : decision);
    return true;
  }

  /** Everything still awaiting an answer — replayed to a surface that connects late. */
  outstanding(): PendingApproval[] {
    return [...this.entries.values()].map((e) => e.pending);
  }

  /**
   * Deny everything in flight, or only the requests `which` picks. Called on
   * abort and on session reset.
   */
  clear(which: (request: ApprovalRequest) => boolean = () => true, note?: string): void {
    for (const [id, entry] of [...this.entries]) {
      if (which(entry.pending.request)) this.resolve(id, { decision: 'deny', ...(note ? { note } : {}) });
    }
  }
}
