import type { IApproval, ApprovalRequest } from '../interfaces/IApproval';

/**
 * Decides whether one out-of-envelope capability may run, and remembers the
 * answer for the rest of the session.
 *
 * Grants are keyed on {@link ApprovalRequest.scope}, never on the concrete
 * subject: approving a read of `/tmp/foo/a.log` grants `/tmp/foo/*`, and
 * approving `az group list` grants `az group`. Without that, a planner doing
 * real research would prompt on every single call and the feature would be
 * unusable.
 *
 * `mode` is the policy floor:
 *   ask     consult the human channel; no channel means deny (headless, web)
 *   allow   grant everything the tier system did not already refuse
 *   deny    grant nothing beyond `preApproved`
 *
 * Note the ordering: `preApproved` is honored under every mode including
 * `deny`, because it is an explicit operator decision rather than a default.
 */
export type ApprovalMode = 'ask' | 'allow' | 'deny';

export interface ApprovalPolicyOptions {
  mode?: ApprovalMode;
  /** Scopes granted up front from config. A trailing `*` matches by prefix. */
  preApproved?: string[];
  /** The human channel. Absent means there is nobody to ask. */
  ask?: (req: ApprovalRequest) => Promise<boolean>;
  /** Called whenever a decision is reached, for surfacing in a UI or a log. */
  onDecision?: (req: ApprovalRequest, granted: boolean, source: ApprovalSource) => void;
}

export type ApprovalSource = 'pre-approved' | 'remembered' | 'mode' | 'asked' | 'no-channel';

function scopeMatches(pattern: string, scope: string): boolean {
  if (pattern === scope) return true;
  if (pattern.endsWith('*')) return scope.startsWith(pattern.slice(0, -1));
  return false;
}

export class ApprovalPolicy implements IApproval {
  private readonly mode: ApprovalMode;
  private readonly preApproved: string[];
  private readonly asker?: (req: ApprovalRequest) => Promise<boolean>;
  private readonly onDecision?: ApprovalPolicyOptions['onDecision'];

  private readonly granted = new Set<string>();
  private readonly refused = new Set<string>();
  /** One in-flight ask per scope: a parallel tool round must not prompt twice for the same thing. */
  private readonly inFlight = new Map<string, Promise<boolean>>();
  // Bumped on reset so an in-flight ask whose promise settles AFTER reset
  // cannot re-populate granted/refused — the continuation checks the
  // generation it was started under and bails if reset has intervened.
  private generation = 0;

  constructor(opts: ApprovalPolicyOptions = {}) {
    this.mode = opts.mode ?? 'ask';
    this.preApproved = opts.preApproved ?? [];
    this.asker = opts.ask;
    this.onDecision = opts.onDecision;
  }

  async request(req: ApprovalRequest): Promise<boolean> {
    const decide = (granted: boolean, source: ApprovalSource) => {
      this.onDecision?.(req, granted, source);
      return granted;
    };

    if (this.preApproved.some((p) => scopeMatches(p, req.scope))) return decide(true, 'pre-approved');
    if (this.granted.has(req.scope)) return decide(true, 'remembered');
    if (this.refused.has(req.scope)) return decide(false, 'remembered');

    if (this.mode === 'allow') { this.granted.add(req.scope); return decide(true, 'mode'); }
    if (this.mode === 'deny') { this.refused.add(req.scope); return decide(false, 'mode'); }
    if (!this.asker) return decide(false, 'no-channel');

    const existing = this.inFlight.get(req.scope);
    if (existing) return decide(await existing, 'asked');

    const gen = this.generation;
    const pending = this.asker(req)
      .catch(() => false)
      .finally(() => { if (this.generation === gen) this.inFlight.delete(req.scope); });
    this.inFlight.set(req.scope, pending);

    const answer = await pending;
    // A denial is remembered too, so a model that retries the same blocked
    // lookup burns one tool round instead of re-prompting the user each time.
    if (this.generation === gen) (answer ? this.granted : this.refused).add(req.scope);
    return decide(answer, 'asked');
  }

  /** Scopes the user has granted this session — for display and for persistence. */
  grantedScopes(): string[] { return [...this.granted]; }

  /** Drop every session-scoped decision. Called on session reset. */
  reset(): void {
    this.generation++;
    this.granted.clear();
    this.refused.clear();
    this.inFlight.clear();
  }
}
