import { approvalScopes, type IApproval, type ApprovalKind, type ApprovalRequest, type StandingDecision } from '../interfaces/IApproval';
import { parseAllowlist, scopeAllowed, scopeExcluded, toolAllowed, type PlannerAllowlist } from './plannerAllowlist';
import type { PolicyInputs } from './commandPolicy';

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
 * Web reads are the exception at both levels.
 */
export type ApprovalModeSetting = ApprovalMode | 'auto';

/**
 * Web reads change nothing, the tasks the planner plans already have the
 * network, and the guards that matter (SSRF, secret check, exclusions,
 * budget) hold without a person, so `auto` lets the planner read without
 * asking at either level (ADR-0027). An explicit `ask` still asks, and an
 * explicit `allowlist` keeps web reads refused.
 */
const AUTO_ALLOWS: ReadonlySet<ApprovalKind> = new Set(['url_fetch', 'web_search']);

export function effectiveApprovalMode(setting: ApprovalModeSetting, autonomous: boolean, kind?: ApprovalKind): ApprovalMode {
  if (setting !== 'auto') return setting;
  if (kind !== undefined && AUTO_ALLOWS.has(kind)) return 'allow';
  return autonomous ? 'deny' : 'ask';
}

/** A configured mode as written: `allowlist` is the user-facing name of `deny`, and anything unknown is `auto`. */
export function parseApprovalModeSetting(raw: string | undefined): ApprovalModeSetting {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'allowlist') return 'deny';
  return value === 'ask' || value === 'allow' || value === 'deny' ? value : 'auto';
}

export interface ApprovalPolicyOptions {
  /** Read per request, for the kind being asked about. */
  mode?: ApprovalMode | ((kind: ApprovalKind) => ApprovalMode);
  autonomous?: () => boolean;
  /** Allowlist entries granted up front from config (ADR-0026). */
  preApproved?: readonly string[] | (() => readonly string[]);
  /** The human channel. Absent means there is nobody to ask. */
  ask?: (req: ApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  /** Called whenever a decision is reached, for surfacing in a UI or a log. */
  onDecision?: (req: ApprovalRequest, granted: boolean, source: ApprovalSource) => void;
}

/**
 * Why a request was decided as it was. The next four are refusals reached
 * before the policy itself is consulted (ADR-0027's web-read guards), handed
 * to {@link ApprovalPolicy.record} so they surface like any other decision:
 * an `!` allowlist exclusion, the scheme and SSRF guard, the outbound secret
 * check, and the per-turn web-read budget. `unsupported` comes after: an
 * approved project MCP server the planner's runner version cannot give the
 * planner as tools of their own (ADR-0028).
 */
export type ApprovalSource = 'pre-approved' | 'remembered' | 'mode' | 'asked' | 'no-channel'
  | 'excluded' | 'guard' | 'secret' | 'budget' | 'unsupported';

export class ApprovalPolicy implements IApproval {
  private readonly modeOf: (kind: ApprovalKind) => ApprovalMode;
  private readonly autonomousOf: () => boolean;
  private readonly entriesOf: () => readonly string[];
  private parsed: { key: string; list: PlannerAllowlist } | null = null;
  private readonly asker?: (req: ApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  private readonly onDecision?: ApprovalPolicyOptions['onDecision'];

  private readonly granted = new Set<string>();
  private readonly refused = new Set<string>();
  /**
   * One in-flight ask per scope: a parallel tool round must not prompt twice for the same thing.
   * It is withdrawn only once every caller waiting on it has withdrawn.
   */
  private readonly inFlight = new Map<string, { answer: Promise<boolean>; waiting: number; withdraw: AbortController }>();
  // Bumped on reset so an in-flight ask whose promise settles AFTER reset
  // cannot re-populate granted/refused — the continuation checks the
  // generation it was started under and bails if reset has intervened.
  private generation = 0;

  constructor(opts: ApprovalPolicyOptions = {}) {
    const { mode = 'ask', preApproved = [] } = opts;
    this.modeOf = typeof mode === 'function' ? mode : () => mode;
    this.autonomousOf = opts.autonomous ?? (() => false);
    this.entriesOf = typeof preApproved === 'function' ? preApproved : () => preApproved;
    this.asker = opts.ask;
    this.onDecision = opts.onDecision;
  }

  async request(req: ApprovalRequest, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
    const decide = (granted: boolean, source: ApprovalSource) => {
      this.onDecision?.(req, granted, source);
      return granted;
    };

    const list = this.allowlist();
    if (approvalScopes(req).some((scope) => scopeExcluded(list, scope))) return decide(false, 'excluded');

    if (req.perInvocation) {
      if (this.modeOf(req.kind) === 'deny' || this.autonomousOf()) return decide(false, 'mode');
      if (!this.asker) return decide(false, 'no-channel');
      return decide(await this.asker(req, opts.signal).catch(() => false), 'asked');
    }
    const { scopes, key, open } = this.standing(req);
    if (open.length === 0) {
      return decide(true, scopes.every((s) => this.granted.has(s)) ? 'remembered' : 'pre-approved');
    }
    // After the allowlist, so an entry added since a "no" is honoured.
    if (scopes.some((s) => this.refused.has(s)) || this.refused.has(key)) return decide(false, 'remembered');

    const mode = this.modeOf(req.kind);
    // Neither is remembered: it is the mode's answer, not a person's, and the
    // mode can change — a Full grant must not outlive a switch to Guarded.
    if (mode === 'allow') return decide(true, 'mode');
    if (mode === 'deny') return decide(false, 'mode');
    if (!this.asker) return decide(false, 'no-channel');

    const openKey = open.join('\n');
    const gen = this.generation;
    let flight = this.inFlight.get(openKey);
    if (!flight) {
      const withdraw = new AbortController();
      const asked: ApprovalRequest = { ...req, scope: open[0], scopes: open.length > 1 ? open : undefined };
      const answer = this.asker(asked, withdraw.signal)
        .catch(() => false)
        .finally(() => { if (this.generation === gen) this.inFlight.delete(openKey); });
      flight = { answer, waiting: 0, withdraw };
      this.inFlight.set(openKey, flight);
    }
    const shared = flight;
    shared.waiting++;
    const leave = () => { if (--shared.waiting === 0) shared.withdraw.abort(); };
    // Every waiter leaves once, and the ask goes with the last one.
    if (opts.signal?.aborted) leave();
    else opts.signal?.addEventListener('abort', leave, { once: true });
    const answer = await shared.answer;
    opts.signal?.removeEventListener('abort', leave);

    // A denial is remembered too, so a model that retries the same blocked
    // lookup burns one tool round instead of re-prompting the user each time.
    // A withdrawn ask was never answered, so it is not.
    if (this.generation === gen && !shared.withdraw.signal.aborted) {
      if (answer) open.forEach((s) => this.granted.add(s));
      else this.refused.add(key);
    }
    return decide(answer, 'asked');
  }

  commandPolicy(): Pick<PolicyInputs, 'autonomous' | 'approvalMode'> {
    return { autonomous: this.autonomousOf(), approvalMode: this.modeOf('shell_command') };
  }

  /**
   * What `request` would answer without a person, for a caller that may never
   * prompt (a research subagent): the same standing grants, remembered
   * refusals and mode the interactive path uses, stopping at `ask`.
   */
  peek(req: ApprovalRequest): StandingDecision {
    const list = this.allowlist();
    if (approvalScopes(req).some((scope) => scopeExcluded(list, scope))) return { decision: 'deny', source: 'excluded' };
    const { scopes, key, open } = this.standing(req);
    if (open.length === 0) return { decision: 'allow', source: scopes.every((s) => this.granted.has(s)) ? 'remembered' : 'pre-approved' };
    if (scopes.some((s) => this.refused.has(s)) || this.refused.has(key)) return { decision: 'deny', source: 'remembered' };
    const mode = this.modeOf(req.kind);
    if (mode === 'allow') return { decision: 'allow', source: 'mode' };
    if (mode === 'deny') return { decision: 'deny', source: 'mode' };
    return { decision: 'ask', source: 'no-channel' };
  }

  private standing(req: ApprovalRequest): { scopes: string[]; key: string; open: string[] } {
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
    return { scopes, key, open };
  }

  /** Report a decision a guard reached before this policy was asked. */
  record(req: ApprovalRequest, granted: boolean, source: ApprovalSource): void {
    this.onDecision?.(req, granted, source);
  }

  grantsUnasked({ kind, scope }: Pick<ApprovalRequest, 'kind' | 'scope'>): boolean {
    const list = this.allowlist();
    if (scopeExcluded(list, scope)) return false;
    if (this.granted.has(scope) || scopeAllowed(list, scope)) return true;
    if (this.refused.has(scope)) return false;
    return this.modeOf(kind) === 'allow';
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
