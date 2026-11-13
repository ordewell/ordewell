import type { SessionBilling, UsageRecord } from '../../models/Usage';

/**
 * What a runner's protocol said of one model call, already in a usage
 * record's terms: each adapter maps its own fields here, and the rules of what
 * a record may claim live in {@link UsageRecordBuilder} alone.
 */
export interface CallUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** What the call left in the main context, counted the way the runner's own UI counts it. */
  contextTokens?: number;
  contextWindow?: number;
  /** The runner's own price for the call, in USD unless it names a currency. */
  cost?: { amount: number; currency?: string; kind?: 'estimate' | 'billed'; basis?: 'list' | 'managed' };
  subagentId?: string;
  /** What a call outside the agent's own turns was for (OpenCode's `title`, `compaction`): it measures no context the agent works in. */
  purpose?: string;
}

/**
 * The usage records one runner session reports (ADR-0017 U1), built by one set
 * of rules every adapter shares:
 *
 * - **Context comes from the main thread's own calls.** A subagent runs its
 *   own model, a sum over calls measures no prompt, and a call made for a
 *   `purpose` is not the context the agent works in: none of them carries
 *   `contextTokens` or a window, so none can move the meter.
 * - **A zero is not a measurement.** A call that failed before the provider
 *   answered reports all zeros; recorded, it would read as an empty context.
 *   A window of 0 means "not known", and a cost of 0 cannot tell a free model
 *   from one the runner has no price for, so neither is claimed.
 * - **Each call is counted once.** Runners restate a call — a message as one
 *   line per content block, a tool part at every status change, a replayed
 *   frame — so a call with an id is built the first time and never again.
 * - **A turn's own sum adds only what did not stream**, once, as an
 *   aggregate: a call whose usage streamed has already been counted.
 *
 * It lives as long as the adapter, not the turn: ids are unique to their
 * session, and a call restated in a later turn is still the same call.
 */
export class UsageRecordBuilder {
  private readonly counted = new Set<string>();
  private streamed = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  private sessionBilling: SessionBilling | undefined;

  constructor(readonly source: string) {}

  /** Whether the call with this id has been counted already. */
  has(id: string): boolean {
    return this.counted.has(id);
  }

  /**
   * One call's record, or null when it measured nothing or was counted
   * already. A call with no report leaves its id open, so a later restatement
   * that carries the counts is still counted; one that reported zeros closes it.
   */
  call(call: CallUsage | undefined, id?: string): UsageRecord | null {
    if (!call || (id !== undefined && this.counted.has(id))) return null;
    if (id !== undefined) this.counted.add(id);
    if ((call.inputTokens ?? 0) + (call.outputTokens ?? 0) === 0) return null;
    const record: UsageRecord = { source: this.source };
    if (call.model) record.model = call.model;
    if (call.inputTokens !== undefined) record.inputTokens = call.inputTokens;
    if (call.outputTokens !== undefined) record.outputTokens = call.outputTokens;
    if (call.cachedInputTokens !== undefined) record.cachedInputTokens = call.cachedInputTokens;
    if (call.cost && call.cost.amount > 0) record.reportedCost = reportedCost(call.cost);
    if (call.purpose) {
      record.aggregate = true;
      record.purpose = call.purpose;
    } else if (call.subagentId) {
      record.subagentId = call.subagentId;
    } else {
      if (call.contextTokens !== undefined && call.contextTokens > 0) record.contextTokens = call.contextTokens;
      if (call.contextWindow !== undefined && call.contextWindow > 0) record.contextWindow = call.contextWindow;
      this.streamed.inputTokens += record.inputTokens ?? 0;
      this.streamed.cachedInputTokens += record.cachedInputTokens ?? 0;
      this.streamed.outputTokens += record.outputTokens ?? 0;
    }
    return record;
  }

  /**
   * A turn's own token sum for its main thread, less what that thread's calls
   * reported since the last one: all of it when no call streamed its usage,
   * else only a lost call's share, as an aggregate that moves no meter. Every
   * call of the turn closes here, so the next turn's sum starts from nothing.
   */
  turnTotal(total: Pick<CallUsage, 'model' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens'> | undefined): UsageRecord | null {
    const streamed = this.streamed;
    this.streamed = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    if (!total) return null;
    const inputTokens = (total.inputTokens ?? 0) - streamed.inputTokens;
    const cachedInputTokens = (total.cachedInputTokens ?? 0) - streamed.cachedInputTokens;
    const outputTokens = (total.outputTokens ?? 0) - streamed.outputTokens;
    if (inputTokens <= 0 && outputTokens <= 0) return null;
    return {
      source: this.source,
      ...(total.model ? { model: total.model } : {}),
      aggregate: true,
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(inputTokens > 0 && cachedInputTokens > 0 ? { cachedInputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
    };
  }

  /**
   * Spend the runner states for the session rather than for one call — a
   * running total's growth, a model's share of it — carrying the login it was
   * spent on. Nothing when the amount is no spend.
   */
  cost(spend: NonNullable<CallUsage['cost']> & { model?: string }): UsageRecord | null {
    if (!(spend.amount > 0)) return null;
    return {
      source: this.source,
      ...(spend.model ? { model: spend.model } : {}),
      aggregate: true,
      ...(this.sessionBilling ? { sessionBilling: this.sessionBilling } : {}),
      reportedCost: reportedCost(spend),
    };
  }

  /**
   * The runner reset the main context — a compaction, or a `/clear`. A
   * subagent's own reset says nothing of it, so an adapter reports only the
   * main thread's. With no size stated the meter shows nothing until the next
   * call measures one.
   */
  compacted(after: { model?: string; contextTokens?: number } = {}): UsageRecord {
    return {
      source: this.source,
      ...(after.model ? { model: after.model } : {}),
      compacted: true,
      ...(after.contextTokens !== undefined ? { contextTokens: after.contextTokens } : {}),
    };
  }

  /**
   * What the runner states of the main context outside any call: a window it
   * names at a turn's end, or a meter it reports on its own. Adds to no total.
   */
  meter(state: { model?: string; contextTokens?: number; contextWindow?: number }): UsageRecord | null {
    const window = state.contextWindow !== undefined && state.contextWindow > 0 ? state.contextWindow : undefined;
    if (state.contextTokens === undefined && window === undefined) return null;
    return {
      source: this.source,
      ...(state.model ? { model: state.model } : {}),
      ...(state.contextTokens !== undefined ? { contextTokens: state.contextTokens } : {}),
      ...(window !== undefined ? { contextWindow: window } : {}),
    };
  }

  /**
   * How the runner says the session is paid for. A report that names no plan
   * keeps the one already stated for the same kind of login: a later notice
   * that only confirms the login does not forget the plan.
   */
  billing(billing: SessionBilling): UsageRecord {
    const plan = billing.plan ?? (this.sessionBilling?.type === billing.type ? this.sessionBilling.plan : undefined);
    this.sessionBilling = { type: billing.type, ...(plan ? { plan } : {}) };
    return { source: this.source, aggregate: true, sessionBilling: this.sessionBilling };
  }
}

function reportedCost(cost: NonNullable<CallUsage['cost']>): NonNullable<UsageRecord['reportedCost']> {
  return { amount: cost.amount, currency: cost.currency ?? 'USD', ...(cost.kind ? { kind: cost.kind } : {}), ...(cost.basis ? { basis: cost.basis } : {}) };
}
