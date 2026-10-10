import { approvalScopes, type IApproval, type ApprovalRequest } from '../interfaces/IApproval';
import { parseAllowlist, scopeAllowed, toolAllowed, type PlannerAllowlist } from './plannerAllowlist';

/**
 * Decides whether one out-of-envelope capability may run, and remembers the
 * answer for the rest of the session.
 *
 * Grants are keyed on {@link ApprovalRequest.scope}, never on the concrete
 * subject: approving a read of `/tmp/foo/a.log` grants `/tmp/foo/*`, and
 * approving `az group list` grants `az group list`. Without that, a planner
 * doing real research would prompt on every single call and the feature would
 * be unusable.
 *
 * `mode` is the policy floor:
 *   ask     consult the human channel; no channel means deny (headless, web)
 *   allow   grant everything the tier system did not already refuse
 *   deny    grant nothing beyond `preApproved` — the allowlist-only mode
 *
 * Note the ordering: `preApproved` is honored under every mode including
 * `deny`, because it is an explicit operator decision rather than a default.
 * Its entries are allowlist rules (see `plannerAllowlist.ts`), and both it and
 * `mode` may be read afresh on every request, so a settings change applies to
 * the next call.
 */
export type ApprovalMode = 'ask' | 'allow' | 'deny';

/**
 * The configured mode. `auto` follows the autonomy level (ADR-0026): Guarded
 * asks, Full runs the allowlist alone and asks nobody, so a planner in Full
 * never waits on a person and never acts outside its standing approvals.
 */
export type ApprovalModeSetting = ApprovalMode | 'auto';

export function effectiveApprovalMode(setting: ApprovalModeSetting, autonomous: boolean): ApprovalMode {
  if (setting !== 'auto') return setting;
  return autonomous ? 'deny' : 'ask';
}

/** A configured mode as written: `allowlist` is the user-facing name of `deny`, and anything unknown is `auto`. */
export function parseApprovalModeSetting(raw: string | undefined): ApprovalModeSetting {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'allowlist') return 'deny';
  return value === 'ask' || value === 'allow' || value === 'deny' ? value : 'auto';
}

export interface ApprovalPolicyOptions {
  mode?: ApprovalMode | (() => ApprovalMode);
  /** Allowlist entries granted up front from config (ADR-0026). */
  preApproved?: readonly string[] | (() => readonly string[]);
  /** The human channel. Absent means there is nobody to ask. */
  ask?: (req: ApprovalRequest) => Promise<boolean>;
  /** Called whenever a decision is reached, for surfacing in a UI or a log. */
  onDecision?: (req: ApprovalRequest, granted: boolean, source: ApprovalSource) => void;
}

export type ApprovalSource = 'pre-approved' | 'remembered' | 'mode' | 'asked' | 'no-channel';

export class ApprovalPolicy implements IApproval {
  private readonly modeOf: () => ApprovalMode;
  private readonly entriesOf: () => readonly string[];
  private parsed: { key: string; list: PlannerAllowlist } | null = null;
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
    const { mode = 'ask', preApproved = [] } = opts;
    this.modeOf = typeof mode === 'function' ? mode : () => mode;
    this.entriesOf = typeof preApproved === 'function' ? preApproved : () => preApproved;
    this.asker = opts.ask;
    this.onDecision = opts.onDecision;
  }

  async request(req: ApprovalRequest): Promise<boolean> {
    const decide = (granted: boolean, source: ApprovalSource) => {
      this.onDecision?.(req, granted, source);
      return granted;
    };

    const scopes = approvalScopes(req);
    // A denial of several scopes is keyed on all of them together: the "no"
    // may have been about any one, so it refuses none of them on its own.
    const key = scopes.join('\n');
    const list = this.allowlist();
    // The first scope is the command's or tool's own: an allowlist rule covers it, never an outside directory.
    const preApproved = (scope: string, i: number) => scopeAllowed(list, scope) || (i === 0 && (
      (req.kind === 'shell_command' && req.allowedBy !== undefined)
      || (req.kind === 'mcp_tool' && req.tool !== undefined && toolAllowed(list, req.tool))));
    const open = scopes.filter((s, i) => !this.granted.has(s) && !preApproved(s, i));
    if (open.length === 0) {
      return decide(true, scopes.every((s) => this.granted.has(s)) ? 'remembered' : 'pre-approved');
    }
    // After the allowlist, so an entry added since a "no" is honoured.
    if (scopes.some((s) => this.refused.has(s)) || this.refused.has(key)) return decide(false, 'remembered');

    const mode = this.modeOf();
    if (mode === 'allow') { open.forEach((s) => this.granted.add(s)); return decide(true, 'mode'); }
    // Not remembered: it is the mode's answer, not a person's, and the mode can change.
    if (mode === 'deny') return decide(false, 'mode');
    if (!this.asker) return decide(false, 'no-channel');

    const openKey = open.join('\n');
    const existing = this.inFlight.get(openKey);
    if (existing) return decide(await existing, 'asked');

    const gen = this.generation;
    const asked: ApprovalRequest = { ...req, scope: open[0], scopes: open.length > 1 ? open : undefined };
    const pending = this.asker(asked)
      .catch(() => false)
      .finally(() => { if (this.generation === gen) this.inFlight.delete(openKey); });
    this.inFlight.set(openKey, pending);

    const answer = await pending;
    // A denial is remembered too, so a model that retries the same blocked
    // lookup burns one tool round instead of re-prompting the user each time.
    if (this.generation === gen) {
      if (answer) open.forEach((s) => this.granted.add(s));
      else this.refused.add(key);
    }
    return decide(answer, 'asked');
  }

  /** The standing approvals, parsed from the entries in force now. */
  allowlist(): PlannerAllowlist {
    const entries = this.entriesOf();
    const key = entries.join('\n');
    if (this.parsed?.key !== key) this.parsed = { key, list: parseAllowlist(entries) };
    return this.parsed.list;
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
