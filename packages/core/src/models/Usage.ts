/** How the runner says this session is paid for; absent means it has not said. */
export interface SessionBilling {
  type: 'subscription' | 'api-key';
  plan?: string;
}

export interface CostProvenance {
  kind: 'estimate' | 'billed' | 'unknown';
  billing: SessionBilling['type'] | 'unknown' | 'mixed';
  basis?: 'list' | 'managed';
}

/**
 * What one model call consumed, as its provider or runner reported it. Shared
 * by the planner's usage line (#49) and per-attempt task usage (#26): a record
 * says nothing about who asked for the call, so either can hold a list of them.
 *
 * Every measure is optional because backends report different subsets. An
 * absent field means "not reported" — never zero — so a total can tell the two
 * apart.
 */
export interface UsageRecord {
  /** The provider or runner id that reported the call — `openai`, `claude-code`, … */
  source: string;
  model?: string;
  /** A session breakdown can name a model without identifying the current context. */
  aggregate?: true;
  inputTokens?: number;
  outputTokens?: number;
  /** The share of `inputTokens` served from the provider's prompt cache. */
  cachedInputTokens?: number;
  /**
   * Filled only from a provider's or runner's own report, never from a price
   * table kept in Ordewell: prices go stale, and a subscription runner has no
   * per-token price at all. No report means no cost, not a guessed one.
   */
  reportedCost?: { amount: number; currency: string; kind?: 'estimate' | 'billed'; basis?: 'list' | 'managed' };
  sessionBilling?: SessionBilling;
  /**
   * The model's context window: as the runner or provider reported it, or,
   * when it reported none, from that runner's or provider's own model listing
   * (`ContextWindowFill`). Never from a table kept in Ordewell.
   */
  contextWindow?: number;
  /**
   * What the main model's context holds once this call is done, counted the
   * way its runner's own UI counts it, so the meter reads what the user would
   * see there. Runners differ, and no sum of the measures above can tell.
   * A measure of the meter only: no total adds it. Absent, the meter reads the
   * prompt.
   */
  contextTokens?: number;
  /**
   * The runner reset the main model's context outside a call — a compaction,
   * or a `/clear`: no call, so the record measures nothing but `contextTokens`,
   * the size it reported the context left at, if it did. It may name the model
   * the new context belongs to; a record that names none is about whichever
   * runs now.
   */
  compacted?: true;
  /** Set when a subagent made the call; its usage still counts toward the total. */
  subagentId?: string;
}

/** A model's window as its reporter stated it: what a plan saves of its session's windows (`SessionWindows`). */
export interface ReportedWindow {
  source: string;
  model: string;
  contextWindow: number;
}

/**
 * A running sum of {@link UsageRecord}s. A measure stays absent until some
 * record reports it. Cost is kept per currency: two runners may bill in
 * different ones, and there is no honest exchange rate to fold them together.
 */
export interface UsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reportedCost?: Record<string, number>;
  costProvenance?: Record<string, CostProvenance>;
}

/**
 * The input side of a call whose provider reports its prompt in parts — the
 * uncached tail, with cache reads and cache writes beside it rather than inside
 * it (Anthropic, and OpenCode after it). The prompt the model saw is all three;
 * only the reads were served from cache, since a write is billed as fresh
 * input. A part left unreported adds nothing, and with no part reported there
 * is no measure at all.
 */
export function partedPromptUsage(parts: { uncached?: number; cacheRead?: number; cacheWrite?: number }): Pick<UsageRecord, 'inputTokens' | 'cachedInputTokens'> {
  const reported = [parts.uncached, parts.cacheRead, parts.cacheWrite].filter((n): n is number => n !== undefined);
  return {
    ...(reported.length > 0 ? { inputTokens: reported.reduce((a, b) => a + b, 0) } : {}),
    ...(parts.cacheRead !== undefined ? { cachedInputTokens: parts.cacheRead } : {}),
  };
}

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const;

/**
 * What a budget counts (ADR-0056 M5), of a record or of totals alike: the same
 * tokens a total holds, input and output. `cachedInputTokens` is a share of the
 * input, so cache reads count, once.
 */
export function spentTokens({ inputTokens, outputTokens }: Pick<UsageTotals, 'inputTokens' | 'outputTokens'>): number {
  return (inputTokens ?? 0) + (outputTokens ?? 0);
}

export function addUsage(totals: UsageTotals, record: UsageRecord): UsageTotals {
  const next: UsageTotals = { ...totals };
  for (const field of TOKEN_FIELDS) {
    const reported = record[field];
    if (reported !== undefined) next[field] = (totals[field] ?? 0) + reported;
  }
  if (record.reportedCost) {
    const { amount, currency } = record.reportedCost;
    const provenance: CostProvenance | undefined = record.reportedCost.kind || record.sessionBilling ? {
      kind: record.reportedCost.kind ?? 'unknown', billing: record.sessionBilling?.type ?? 'unknown',
      ...(record.reportedCost.basis ? { basis: record.reportedCost.basis } : {}),
    } : undefined;
    addCost(next, currency, amount, provenance);
  }
  return next;
}

function addCost(totals: UsageTotals, currency: string, amount: number, provenance?: CostProvenance): void {
  const hadCost = totals.reportedCost?.[currency] !== undefined;
  const previous = totals.costProvenance?.[currency];
  totals.reportedCost = { ...totals.reportedCost, [currency]: (totals.reportedCost?.[currency] ?? 0) + amount };
  if (!previous && !provenance) return;
  const unknown: CostProvenance = { kind: 'unknown', billing: 'unknown' };
  const a = previous ?? unknown;
  const b = provenance ?? unknown;
  const merged: CostProvenance = !hadCost ? b : {
    kind: a.kind === 'estimate' || b.kind === 'estimate' ? 'estimate' : a.kind === 'billed' && b.kind === 'billed' ? 'billed' : 'unknown',
    billing: a.billing === b.billing ? a.billing : 'mixed',
    ...(a.basis && a.basis === b.basis ? { basis: a.basis } : {}),
  };
  totals.costProvenance = { ...totals.costProvenance, [currency]: merged };
}

/**
 * What the planner has consumed over a session (#49). `totals` includes every
 * `bySubagent` entry. `lastPromptTokens` and `contextWindow` track the
 * planner's own calls only — a subagent runs its own model, whose window says
 * nothing about the planner's. `lastPromptTokens` is the context the last call
 * left (its `contextTokens`, else its prompt), under the name saved sessions
 * already hold it by.
 */
export interface PlannerUsage {
  sessionBilling?: SessionBilling;
  totals: UsageTotals;
  bySubagent?: Record<string, UsageTotals>;
  byModel?: ModelUsage[];
  source?: string;
  model?: string;
  lastPromptTokens?: number;
  contextWindow?: number;
}

export function addPlannerUsage(usage: PlannerUsage, record: UsageRecord): PlannerUsage {
  // The size before a compaction is gone, so the meter shows the size after
  // or none until the next call — never the old one, which reads as full. The
  // record may name the model the new context now belongs to: that is a switch
  // of its own, and the old model's window does not measure it.
  if (record.compacted) {
    // A subagent's compaction says nothing about the main model, and a
    // breakdown measures no prompt of its own.
    if (record.subagentId || record.aggregate) return usage;
    const next: PlannerUsage = { ...usage };
    if (record.source !== undefined) next.source = record.source;
    if (record.model !== undefined) {
      if (record.source !== usage.source || record.model !== usage.model) delete next.contextWindow;
      next.model = record.model;
    }
    if (record.contextTokens !== undefined) next.lastPromptTokens = record.contextTokens;
    else delete next.lastPromptTokens;
    if (record.contextWindow !== undefined) next.contextWindow = record.contextWindow > 0 ? record.contextWindow : undefined;
    return next;
  }
  if (record.sessionBilling && !record.reportedCost && record.inputTokens === undefined && record.outputTokens === undefined && record.cachedInputTokens === undefined && record.contextWindow === undefined) {
    // The fact belongs to the source that stated it: kept with no source, it
    // would be lent to whichever backend reports a cost next.
    return record.subagentId ? usage : { ...usage, sessionBilling: record.sessionBilling, source: record.source };
  }
  record = { ...record, sessionBilling: record.sessionBilling ?? (usage.source === undefined || record.source === usage.source ? usage.sessionBilling : undefined) };
  const next: PlannerUsage = { ...usage, ...(!record.subagentId && record.sessionBilling ? { sessionBilling: record.sessionBilling } : {}), totals: addUsage(usage.totals, record), byModel: addModelUsage(usage.byModel ?? [], record) };
  if (record.subagentId) {
    next.bySubagent = { ...usage.bySubagent, [record.subagentId]: addUsage(usage.bySubagent?.[record.subagentId] ?? {}, record) };
    return next;
  }
  // A session breakdown names a model without measuring any call's prompt, so
  // it never moves the meter. It still comes from a source, though: a billing
  // fact belonging to another backend does not outlive it.
  if (record.aggregate) {
    if (record.source !== usage.source && !record.sessionBilling) delete next.sessionBilling;
    return next;
  }
  if (record.source !== usage.source || record.model !== usage.model) {
    delete next.lastPromptTokens;
    delete next.contextWindow;
  }
  if (record.source !== usage.source && !record.sessionBilling) delete next.sessionBilling;
  next.source = record.source;
  next.model = record.model;
  const used = record.contextTokens ?? record.inputTokens;
  if (used !== undefined) next.lastPromptTokens = used;
  // A reported window of 0 means "not known", not "no room": keep it out so the
  // meter shows no share rather than one against a guessed zero.
  if (record.contextWindow !== undefined) next.contextWindow = record.contextWindow > 0 ? record.contextWindow : undefined;
  return next;
}

/** Whether any measure was reported: a usage line of nothing but blanks says nothing. */
export function isMeasured(totals: UsageTotals): boolean {
  return totals.inputTokens !== undefined || totals.outputTokens !== undefined || totals.cachedInputTokens !== undefined
    || Object.keys(totals.reportedCost ?? {}).length > 0;
}

/**
 * The main model's context: what its last call left in it, against its window
 * when that is known. A window of 0 is not known.
 */
export interface ContextFill {
  usedTokens: number;
  windowTokens?: number;
  /**
   * Why an API planner's automatic compaction (ADR-0002) is not running for
   * its model, as it stood when the meter was sent: the settings file turns it
   * off, or no catalog states the model's window. Absent while it runs, and on
   * a harness planner, whose agent compacts its own context.
   */
  autoCompaction?: { off: 'settings' } | { off: 'unknown_window'; model: string };
}

/** What the usage line draws of a ledger — live from its broadcast, or reloaded from the saved one. */
export interface UsageLine {
  sessionBilling?: SessionBilling;
  byModel?: ModelUsage[];
  model?: string;
  totals: UsageTotals;
  bySubagent?: Record<string, UsageTotals>;
  contextFill?: ContextFill;
}

export function usageLine(usage: PlannerUsage): UsageLine {
  const contextFill = plannerContextFill(usage);
  return {
    totals: usage.totals,
    ...(usage.sessionBilling ? { sessionBilling: usage.sessionBilling } : {}),
    ...(usage.byModel ? { byModel: usage.byModel } : {}),
    ...(usage.model ? { model: usage.model } : {}),
    ...(usage.bySubagent ? { bySubagent: usage.bySubagent } : {}),
    ...(contextFill ? { contextFill } : {}),
  };
}

/**
 * The main model's context as its last call left it, or undefined before one
 * was measured and after a compaction that reported no size. `usedTokens` is
 * what that call stated as its context, else its prompt total, cached tokens
 * included: a cached token still occupies the window, so subtracting the
 * cached share would understate how full the context is. The window rides
 * along only when known; a window of 0 is treated as unknown — never guessed.
 */
export function plannerContextFill(usage: PlannerUsage): ContextFill | undefined {
  if (usage.lastPromptTokens === undefined) return undefined;
  return { usedTokens: usage.lastPromptTokens, ...(usage.contextWindow !== undefined && usage.contextWindow > 0 ? { windowTokens: usage.contextWindow } : {}) };
}

export interface ModelUsage {
  source: string;
  model?: string;
  totals: UsageTotals;
}

export function addModelUsage(models: readonly ModelUsage[], record: UsageRecord): ModelUsage[] {
  const index = models.findIndex((m) => m.source === record.source && m.model === record.model);
  if (index < 0) return [...models, { source: record.source, ...(record.model ? { model: record.model } : {}), totals: addUsage({}, record) }];
  return models.map((m, i) => i === index ? { ...m, totals: addUsage(m.totals, record) } : m);
}

/**
 * What Ordewell has counted of a runner's own session that reports its cost
 * as a running total: that total and each model's share, in USD, as of its
 * last report. A resume of that session counts its first report's growth
 * over this; with no count kept for it, that report only sets the baseline.
 */
export interface RunnerSessionCost {
  sessionId: string;
  usd: number;
  modelUsd: Record<string, number>;
}

export interface AttemptUsage extends PlannerUsage {
  attempt: number;
  runner: string;
  /** The runner session this attempt ran in, as its runner reported it: what a later Continue of it resumes. */
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  wallTimeMs: number;
  /** What was counted of its runner session's running cost as it ended: a continue of that session counts on from it. */
  runnerSessionCost?: RunnerSessionCost;
}

export function startAttemptUsage(attempt: number, runner: string, startedAt: string): AttemptUsage {
  return { attempt, runner, startedAt, wallTimeMs: 0, totals: {}, byModel: [] };
}

/** What its runner reports as it winds down after the attempt ended is added without moving its end. */
export function addAttemptUsage(usage: AttemptUsage, record: UsageRecord, now: string): AttemptUsage {
  const folded = addPlannerUsage(usage, record);
  return { ...usage, ...folded, lastPromptTokens: folded.lastPromptTokens, contextWindow: folded.contextWindow, wallTimeMs: Math.max(0, Date.parse(usage.endedAt ?? now) - Date.parse(usage.startedAt)) };
}

/** An attempt ends once; ended again once its runner wound down, it only takes the count that runner ended on. */
export function endAttemptUsage(usage: AttemptUsage, now: string, runnerSessionCost?: RunnerSessionCost, sessionId?: string): AttemptUsage {
  const endedAt = usage.endedAt ?? now;
  return {
    ...usage,
    endedAt,
    wallTimeMs: Math.max(0, Date.parse(endedAt) - Date.parse(usage.startedAt)),
    ...(sessionId ? { sessionId } : {}),
    ...(runnerSessionCost ? { runnerSessionCost } : {}),
  };
}

/** The count a continue of `sessionId` starts from: the one its latest attempt in that session ended with. */
export function countedSessionCost(attempts: readonly AttemptUsage[] | undefined, sessionId: string): RunnerSessionCost | undefined {
  return [...attempts ?? []].reverse().find((usage) => usage.runnerSessionCost?.sessionId === sessionId)?.runnerSessionCost;
}

/**
 * The model a continue's session last ran on and the window it was measured
 * against: the latest earlier attempt of that same runner session that
 * reported one. An attempt that measured nothing is skipped — a continuation
 * does not undo what its session was last measured against — and a window is
 * never borrowed from another session: a fresh attempt starts one.
 */
export function resumedSessionWindow(attempts: readonly AttemptUsage[] | undefined, runner: string, attempt: number, sessionId: string): Pick<PlannerUsage, 'source' | 'model' | 'contextWindow'> | undefined {
  const last = [...attempts ?? []].reverse().find((usage) => usage.attempt !== attempt && usage.runner === runner && usage.sessionId === sessionId && usage.contextWindow !== undefined);
  return last ? { source: last.source, model: last.model, contextWindow: last.contextWindow } : undefined;
}

export interface PlanUsage {
  totals: UsageTotals;
  byModel: ModelUsage[];
  wallTimeMs: number;
  attempts: number;
}

export function addUsageTotals(totals: UsageTotals, addition: UsageTotals): UsageTotals {
  const next = addUsage(totals, { source: '', inputTokens: addition.inputTokens, outputTokens: addition.outputTokens, cachedInputTokens: addition.cachedInputTokens });
  for (const [currency, amount] of Object.entries(addition.reportedCost ?? {})) addCost(next, currency, amount, addition.costProvenance?.[currency]);
  return next;
}

interface UsageTask { type?: string; attemptUsage?: readonly AttemptUsage[]; subtasks?: readonly UsageTask[] }

export function planUsage(tasks: readonly UsageTask[]): PlanUsage {
  const result: PlanUsage = { totals: {}, byModel: [], wallTimeMs: 0, attempts: 0 };
  for (const task of tasks) {
    const child = planUsage(task.subtasks ?? []);
    result.totals = addUsageTotals(result.totals, child.totals);
    result.wallTimeMs += child.wallTimeMs;
    result.attempts += child.attempts;
    const models = [...child.byModel];
    for (const usage of task.attemptUsage ?? []) {
      result.totals = addUsageTotals(result.totals, usage.totals);
      result.wallTimeMs += usage.wallTimeMs;
      result.attempts++;
      models.push(...usage.byModel ?? []);
    }
    for (const model of models) {
      const existing = result.byModel.find((m) => m.source === model.source && m.model === model.model);
      if (existing) existing.totals = addUsageTotals(existing.totals, model.totals);
      else result.byModel.push({ ...model, totals: addUsageTotals({}, model.totals) });
    }
  }
  return result;
}

/**
 * What one task spent across every attempt and every model it ran on, so a
 * stop, a model change and a continue never makes the earlier spend vanish. The
 * context meter is the exception: it reads the latest attempt, because only the
 * current model's window says how full the next prompt is.
 */
export interface TaskUsageSummary {
  totals: UsageTotals;
  attempts: number;
  contextFill?: ContextFill;
}

export function taskUsageSummary(task: Pick<UsageTask, 'attemptUsage' | 'type'>): TaskUsageSummary {
  const attempts = task.attemptUsage ?? [];
  const latest = attempts.at(-1);
  // A delegated task's usage is its whole subtree's (ADR-0055 D20): no one session's context, so it has no meter.
  const contextFill = latest && task.type !== 'delegated' ? plannerContextFill(latest) : undefined;
  return {
    totals: attempts.reduce((sum, attempt) => addUsageTotals(sum, attempt.totals), {} as UsageTotals),
    attempts: attempts.length,
    ...(contextFill ? { contextFill } : {}),
  };
}

// ── The text surfaces draw ───────────────────────────────────────────────────
// Surfaces draw the main model's context and the money its runner reported,
// never a token count, and word them here so none can disagree (ADR-0017 U1).

/** `950`, `1.5k`, `61k`, `261k`, `1.2M`. */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Two decimals from 1 up and up to four below it: a call can cost a fraction of a cent, a session several dollars. */
export function formatCost(currency: string, amount: number): string {
  const value = amount >= 1 ? amount.toFixed(2) : (([whole, frac = '']) => `${whole}.${frac.padEnd(2, '0')}`)(amount.toFixed(4).replace(/0+$/, '').split('.'));
  return currency.toLowerCase() === 'usd' ? `$${value}` : `${value} ${currency.toUpperCase()}`;
}

/** `ctx 61k (6%)`, `ctx 61k` while the window is unknown, nothing before a call was measured; `· no auto-compact` when automatic compaction is not running. */
export function contextMeterText(fill: ContextFill | undefined): string | null {
  if (!fill) return null;
  const used = `ctx ${formatTokenCount(fill.usedTokens)}`;
  const share = fill.windowTokens ? fill.usedTokens / fill.windowTokens * 100 : undefined;
  const meter = share === undefined ? used : `${used} (${share < 1 ? '<1' : Math.round(share)}%)`;
  return fill.autoCompaction ? `${meter} · no auto-compact` : meter;
}

/** Exact counts for the meter's hover, and why automatic compaction is not running, where it is not. */
export function contextMeterTitle(fill: ContextFill): string {
  const used = fill.usedTokens.toLocaleString('en-US');
  const counts = fill.windowTokens ? `${used} of ${fill.windowTokens.toLocaleString('en-US')} tokens` : `${used} tokens`;
  const off = fill.autoCompaction;
  if (!off) return counts;
  const why = off.off === 'settings'
    ? 'Automatic compaction is off in the settings file'
    : off.model
      ? `Automatic compaction is off: no catalog Ordewell holds states ${off.model}'s window`
      : 'Automatic compaction is off: no planner model is selected';
  return `${counts}. ${why}; /compact still condenses the conversation.`;
}

/** USD first, then the others by code, so a sum reads the same whichever attempt reported first. */
function costParts(totals: UsageTotals): string[] {
  const rank = (currency: string): string => (currency.toLowerCase() === 'usd' ? '' : currency.toUpperCase());
  return Object.entries(totals.reportedCost ?? {}).sort(([a], [b]) => rank(a).localeCompare(rank(b))).map(([currency, amount]) => {
    const provenance = totals.costProvenance?.[currency];
    const equivalent = provenance?.billing === 'subscription';
    return `${provenance?.kind === 'estimate' || equivalent ? '≈' : ''}${formatCost(currency, amount)}${equivalent ? ' API-equivalent' : ''}`;
  });
}

/** The cost per currency as reported, joined by ` · `; null when none was reported. */
export function costText(totals: UsageTotals): string | null {
  const parts = costParts(totals);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** The meter, then the cost, joined by ` · `; null when neither is known. */
export function usageText(usage: { totals: UsageTotals; contextFill?: ContextFill }): string | null {
  const parts = [contextMeterText(usage.contextFill), costText(usage.totals)].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Each runner/model's reported cost for the cost's hover, leaving out models with none. */
export function modelCostTitle(byModel: readonly ModelUsage[]): string | undefined {
  const lines = byModel.flatMap((m) => {
    const cost = costParts(m.totals);
    const descriptions = [...new Set(Object.values(m.totals.costProvenance ?? {}).map((p) => {
      const source = m.source === 'claude-code' ? 'Claude Code' : m.source === 'opencode' ? 'OpenCode' : m.source === 'openrouter' ? 'OpenRouter' : m.source;
      const basis = p.basis === 'list' ? ' at list price' : p.basis === 'managed' ? ' at managed price' : '';
      const kind = p.kind === 'estimate' ? `${source}'s estimate${basis}` : p.kind === 'billed' ? `Amount billed by ${source}` : 'Reported cost';
      return `${kind}${p.billing === 'subscription' ? '; not billed on a subscription' : ''}`;
    }))];
    return cost.length > 0 ? [`${m.source} / ${m.model ?? 'unattributed'}: ${cost.join(' · ')}${descriptions.length ? ` — ${descriptions.join('; ')}` : ''}`] : [];
  });
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** Each subagent's reported cost for the subagent count's hover, or that it reported none. */
export function subagentCostTitle(bySubagent: Readonly<Record<string, UsageTotals>>): string {
  return Object.entries(bySubagent)
    .map(([id, totals]) => `${id}: ${costParts(totals).join(' · ') || 'reported no cost'}`)
    .join('\n');
}

function runnersOf(tasks: readonly UsageTask[]): AttemptUsage[] {
  return tasks.flatMap((task) => [...task.attemptUsage ?? [], ...runnersOf(task.subtasks ?? [])]);
}

/**
 * `Tasks total: $3.20 · codex reports no cost`: the cost over every attempt,
 * then the runners none of whose attempts reported one — codex reports no
 * price, and a price table is not Ordewell's to keep (ADR-0017 U1). A runner is
 * named only once an attempt of it has ended having reported usage: Claude
 * Code states a cost only on a turn's last line, so a first attempt still in
 * its turn has not said yet, and one that never ran said nothing. A total has
 * no meter: each task's own model holds its own window.
 */
export function tasksTotalText(tasks: readonly UsageTask[]): string | null {
  const attempts = runnersOf(tasks);
  if (attempts.length === 0) return null;
  const costed = (a: AttemptUsage): boolean => Object.keys(a.totals.reportedCost ?? {}).length > 0;
  const costless = [...new Set(attempts.filter((a) => a.endedAt !== undefined && isMeasured(a.totals)).map((a) => a.runner))]
    .filter((runner) => !attempts.some((a) => a.runner === runner && costed(a)));
  const note = costless.length === 0 ? [] : [`${costless.length === 1 ? costless[0] : `${costless.slice(0, -1).join(', ')} and ${costless.at(-1)}`} ${costless.length === 1 ? 'reports' : 'report'} no cost`];
  const parts = [...costParts(planUsage(tasks).totals), ...note];
  return parts.length > 0 ? `Tasks total: ${parts.join(' · ')}` : null;
}
