import { describe, it, expect } from 'vitest';
import {
  addAttemptUsage, addPlannerUsage, endAttemptUsage, startAttemptUsage, plannerContextFill, usageLine, usageText, contextMeterText, contextMeterTitle,
  formatCost, formatTokenCount, costText, tasksTotalText, modelCostTitle, subagentCostTitle, taskUsageSummary, type UsageRecord,
} from '../Usage';
import { createTask } from '../Task';

const at = '2026-10-11T10:00:00Z';
const attempt = (n: number, runner: string, ...records: UsageRecord[]) =>
  records.reduce((usage, record) => addAttemptUsage(usage, record, at), startAttemptUsage(n, runner, at));

describe('formatTokenCount', () => {
  it('writes counts compactly', () => {
    expect([0, 950, 1500, 9999, 10_000, 61_143, 261_000, 999_499, 999_500, 1_200_000, 1_000_000].map(formatTokenCount))
      .toEqual(['0', '950', '1.5k', '10k', '10k', '61k', '261k', '999k', '1M', '1.2M', '1M']);
  });
});

describe('formatCost', () => {
  it('uses $ for USD and the currency code otherwise, with two decimals from 1 up and up to four below', () => {
    expect(formatCost('USD', 7.8912)).toBe('$7.89');
    expect(formatCost('usd', 1)).toBe('$1.00');
    expect(formatCost('USD', 0.0017)).toBe('$0.0017');
    expect(formatCost('USD', 0.42)).toBe('$0.42');
    expect(formatCost('USD', 0)).toBe('$0.00');
    expect(formatCost('eur', 3)).toBe('3.00 EUR');
  });
});

describe('the context meter', () => {
  it('shows the used tokens with the share of the window when it is known', () => {
    expect(contextMeterText({ usedTokens: 61_143, windowTokens: 1_000_000 })).toBe('ctx 61k (6%)');
  });

  it('shows the used tokens alone when the window is unknown', () => {
    expect(contextMeterText({ usedTokens: 61_143 })).toBe('ctx 61k');
  });

  it('reads a share under 1% as <1%', () => {
    expect(contextMeterText({ usedTokens: 950, windowTokens: 1_000_000 })).toBe('ctx 950 (<1%)');
  });

  it('shows a fill past the window as it is, never clamped', () => {
    expect(contextMeterText({ usedTokens: 1_050_000, windowTokens: 1_000_000 })).toBe('ctx 1.1M (105%)');
  });

  it('is nothing before any call was measured', () => {
    expect(contextMeterText(undefined)).toBeNull();
  });

  it('gives exact counts on hover', () => {
    expect(contextMeterTitle({ usedTokens: 61_143, windowTokens: 1_000_000 })).toBe('61,143 of 1,000,000 tokens');
    expect(contextMeterTitle({ usedTokens: 61_143 })).toBe('61,143 tokens');
  });

  it('says quietly when an API planner\'s automatic compaction is not running, and why on hover', () => {
    const unknown = { usedTokens: 61_143, autoCompaction: { off: 'unknown_window' as const, model: 'vendor/model' } };
    expect(contextMeterText(unknown)).toBe('ctx 61k · no auto-compact');
    expect(contextMeterTitle(unknown)).toBe('61,143 tokens. Automatic compaction is off: no catalog Ordewell holds states vendor/model\'s window; /compact still condenses the conversation.');
    const off = { usedTokens: 61_143, windowTokens: 1_000_000, autoCompaction: { off: 'settings' as const } };
    expect(contextMeterText(off)).toBe('ctx 61k (6%) · no auto-compact');
    expect(contextMeterTitle(off)).toBe('61,143 of 1,000,000 tokens. Automatic compaction is off in the settings file; /compact still condenses the conversation.');
  });

  it('says no planner model is selected, rather than naming none, when the window is unknown for want of one', () => {
    const none = { usedTokens: 100, windowTokens: 200_000, autoCompaction: { off: 'unknown_window' as const, model: '' } };
    expect(contextMeterTitle(none)).toBe('100 of 200,000 tokens. Automatic compaction is off: no planner model is selected; /compact still condenses the conversation.');
  });

  it('reads against where compaction starts when a compaction window is in force', () => {
    const fill = { usedTokens: 61_143, windowTokens: 200_000, compaction: { windowTokens: 150_000, startsAtTokens: 118_000 } };
    expect(contextMeterText(fill)).toBe('ctx 61k (52% · compacts at 118k)');
    expect(contextMeterTitle(fill)).toBe('61,143 of 118,000 tokens before its runner compacts, under a compaction window of 150,000 tokens; the model\'s window is 200,000 tokens');
    const unknown = { usedTokens: 61_143, compaction: { windowTokens: 150_000, startsAtTokens: 118_000 } };
    expect(contextMeterTitle(unknown)).toBe('61,143 of 118,000 tokens before its runner compacts, under a compaction window of 150,000 tokens');
  });
});

describe('the usage line', () => {
  it('is the meter, then the cost', () => {
    expect(usageText({ totals: { inputTokens: 1_190_000, reportedCost: { USD: 7.89 } }, contextFill: { usedTokens: 61_143, windowTokens: 1_000_000 } }))
      .toBe('ctx 61k (6%) · $7.89');
  });

  it('draws no token count', () => {
    expect(usageText({ totals: { inputTokens: 5, outputTokens: 6, cachedInputTokens: 7 } })).toBeNull();
  });

  it('is the cost alone before a call was measured, and the meter alone without a cost', () => {
    expect(usageText({ totals: { reportedCost: { USD: 0.0017 } } })).toBe('$0.0017');
    expect(usageText({ totals: { inputTokens: 3 }, contextFill: { usedTokens: 3 } })).toBe('ctx 3');
  });

  it('is nothing at all when neither is known', () => {
    expect(usageText({ totals: {} })).toBeNull();
  });

  it('keeps each currency as reported', () => {
    expect(usageText({ totals: { reportedCost: { USD: 1.5, EUR: 2 } } })).toBe('$1.50 · 2.00 EUR');
  });
});

describe('the meter follows the main model only', () => {
  it('carries the used tokens without a window, and a window of 0 is unknown', () => {
    const unknown = addPlannerUsage({ totals: {} }, { source: 'codex', model: 'a', inputTokens: 40 });
    expect(plannerContextFill(unknown)).toEqual({ usedTokens: 40 });
    const zero = addPlannerUsage({ totals: {} }, { source: 'codex', model: 'a', inputTokens: 40, contextWindow: 0 });
    expect(usageLine(zero).contextFill).toEqual({ usedTokens: 40 });
  });

  it('is absent before any call was measured', () => {
    expect(usageLine({ totals: {} }).contextFill).toBeUndefined();
    expect(usageLine(addPlannerUsage({ totals: {} }, { source: 'codex', reportedCost: { amount: 1, currency: 'USD' } })).contextFill).toBeUndefined();
  });

  it('ignores a subagent that is the only one to report', () => {
    const usage = addPlannerUsage({ totals: {} }, { source: 'openai', model: 'b', inputTokens: 900, contextWindow: 200, subagentId: 'child' });
    expect(usageLine(usage).contextFill).toBeUndefined();
    expect(usageText(usageLine(usage))).toBeNull();
  });

  it('ignores a session breakdown that carries tokens', () => {
    const first = addPlannerUsage({ totals: {} }, { source: 'runner', model: 'a', inputTokens: 80, contextWindow: 100 });
    const after = addPlannerUsage(first, { source: 'runner', model: 'b', aggregate: true, inputTokens: 9000, contextWindow: 5 });
    expect(usageLine(after).contextFill).toEqual({ usedTokens: 80, windowTokens: 100 });
    const alone = addPlannerUsage({ totals: {} }, { source: 'runner', aggregate: true, inputTokens: 9000 });
    expect(usageLine(alone).contextFill).toBeUndefined();
  });
});

describe('Tasks total', () => {
  const usd = (amount: number) => ({ amount, currency: 'USD' });
  const ended = (n: number, runner: string, ...records: UsageRecord[]) => endAttemptUsage(attempt(n, runner, ...records), at);

  it('sums the cost per currency over every attempt, subtasks included', () => {
    const tasks = [createTask({
      attemptUsage: [attempt(1, 'claude-code', { source: 'claude-code', reportedCost: usd(1) }), attempt(2, 'claude-code', { source: 'claude-code', reportedCost: usd(0.5) })],
      subtasks: [createTask({ attemptUsage: [attempt(1, 'opencode', { source: 'opencode', reportedCost: { amount: 2, currency: 'EUR' } })] })],
    })];
    expect(tasksTotalText(tasks)).toBe('Tasks total: $1.50 · 2.00 EUR');
  });

  it('names the runners whose attempts reported no cost at all', () => {
    const tasks = [
      createTask({ attemptUsage: [attempt(1, 'claude-code', { source: 'claude-code', reportedCost: usd(3.2) })] }),
      createTask({ attemptUsage: [ended(1, 'codex', { source: 'codex', inputTokens: 10 })] }),
    ];
    expect(tasksTotalText(tasks)).toBe('Tasks total: $3.20 · codex reports no cost');
  });

  it('does not name a runner when any of its attempts reported a cost', () => {
    const tasks = [createTask({ attemptUsage: [ended(1, 'opencode', { source: 'opencode', inputTokens: 1 }), attempt(2, 'opencode', { source: 'opencode', reportedCost: usd(0.1) })] })];
    expect(tasksTotalText(tasks)).toBe('Tasks total: $0.10');
  });

  it('names several runners and carries no meter', () => {
    const tasks = [
      createTask({ attemptUsage: [ended(1, 'codex', { source: 'codex', inputTokens: 10, contextWindow: 100 })] }),
      createTask({ attemptUsage: [ended(1, 'opencode', { source: 'opencode', inputTokens: 10 })] }),
    ];
    expect(tasksTotalText(tasks)).toBe('Tasks total: codex and opencode report no cost');
  });

  it('is nothing before any attempt ran', () => {
    expect(tasksTotalText([createTask({})])).toBeNull();
  });

  it('does not say a runner reports no cost before an attempt of it has ended having reported usage', () => {
    // Claude Code states a cost only on a turn's last line: its first attempt's
    // calls report tokens for as long as that turn runs.
    const running = attempt(1, 'claude-code', { source: 'claude-code', model: 'opus', inputTokens: 40_000, contextTokens: 41_000 });
    const tasks = [
      createTask({ attemptUsage: [running] }),
      createTask({ attemptUsage: [ended(1, 'opencode', { source: 'opencode', reportedCost: usd(0.4) })] }),
    ];
    expect(tasksTotalText(tasks)).toBe('Tasks total: $0.40');
    // An attempt that never ran (its runner failed to start) says nothing about cost either.
    const unstarted = endAttemptUsage(startAttemptUsage(1, 'codex', at), at);
    expect(tasksTotalText([createTask({ attemptUsage: [unstarted] })])).toBeNull();

    expect(tasksTotalText([...tasks, createTask({ attemptUsage: [ended(1, 'codex', { source: 'codex', inputTokens: 10 })] })])).toBe('Tasks total: $0.40 · codex reports no cost');
  });
});

describe('a task', () => {
  it('shows its cost over every attempt with the latest attempt’s meter', () => {
    const first = attempt(1, 'claude-code', { source: 'claude-code', model: 'opus', inputTokens: 100, reportedCost: { amount: 1.5, currency: 'USD' }, contextWindow: 1000 });
    const second = attempt(2, 'claude-code', { source: 'claude-code', model: 'sonnet', inputTokens: 50, reportedCost: { amount: 0.25, currency: 'USD' } });
    expect(usageText(taskUsageSummary(createTask({ attemptUsage: [first, second] })))).toBe('ctx 50 · $1.75');
  });

  it('carries the compaction start of a window in force below its model\'s, and reads as before without one', () => {
    const used = attempt(1, 'claude-code', { source: 'claude-code', model: 'sonnet', inputTokens: 61_143, contextWindow: 200_000 });
    const under = (windowTokens: number) => taskUsageSummary(createTask({ attemptUsage: [{ ...used, compaction: { windowTokens, startsAtTokens: windowTokens - 32_000 } }] }));
    expect(usageText(under(150_000))).toBe('ctx 61k (52% · compacts at 118k)');
    // A window at or past the model's own is not the one it compacts under.
    expect(usageText(under(200_000))).toBe('ctx 61k (31%)');
    expect(usageText(taskUsageSummary(createTask({ attemptUsage: [used] })))).toBe('ctx 61k (31%)');
  });
});

describe('hovers', () => {
  it('lists the cost of each runner/model, leaving out models with none', () => {
    expect(modelCostTitle([
      { source: 'claude-code', model: 'opus', totals: { reportedCost: { USD: 1.5 } } },
      { source: 'codex', model: 'gpt', totals: { inputTokens: 4 } },
      { source: 'claude-code', totals: { reportedCost: { USD: 0.25, EUR: 1 } } },
    ])).toBe('claude-code / opus: $1.50\nclaude-code / unattributed: $0.25 · 1.00 EUR');
    expect(modelCostTitle([{ source: 'codex', totals: { inputTokens: 4 } }])).toBeUndefined();
  });

  it('gives each subagent’s reported cost or says it reported none', () => {
    expect(subagentCostTitle({ a: { reportedCost: { USD: 0.01 } }, b: { inputTokens: 5 } })).toBe('a: $0.01\nb: reported no cost');
  });
});

describe('the cost alone', () => {
  it('does not lend a subscription to another source after the planner switches backends', () => {
    const first = addPlannerUsage({ totals: {} }, { source: 'claude-code', model: 'opus', sessionBilling: { type: 'subscription' }, reportedCost: { amount: 1, currency: 'USD', kind: 'estimate' } });
    const switched = addPlannerUsage(first, { source: 'openrouter', model: 'gpt', reportedCost: { amount: 2, currency: 'USD', kind: 'billed' } });
    const next = addPlannerUsage(switched, { source: 'openrouter', model: 'gpt', reportedCost: { amount: 3, currency: 'USD', kind: 'billed' } });
    expect(costText(next.totals)).toBe('≈$6.00');
    expect(costText(next.byModel![1].totals)).toBe('$5.00');
    expect(next.sessionBilling).toBeUndefined();
  });

  it.each([false, true])('does not lend a subscription reported before any cost to another backend (aggregate: %s)', (aggregate) => {
    // Claude Code states its login at init, before its first call. A planner
    // switched before that call must not wear its subscription as a hat.
    const billingOnly = addPlannerUsage({ totals: {} }, { source: 'claude-code', aggregate: true, sessionBilling: { type: 'subscription', plan: 'max' } });
    const billed = addPlannerUsage(billingOnly, { source: 'openrouter', model: 'gpt', ...(aggregate ? { aggregate: true as const } : {}), reportedCost: { amount: 2, currency: 'USD', kind: 'billed' } });
    expect(costText(billed.totals)).toBe('$2.00');
    expect(billed.totals.costProvenance).toEqual({ USD: { kind: 'billed', billing: 'unknown' } });
    expect(billed.sessionBilling).toBeUndefined();
  });

  it('marks estimates and subscription equivalents through task and model totals', () => {
    const subscription = attempt(1, 'claude-code',
      { source: 'claude-code', aggregate: true, sessionBilling: { type: 'subscription', plan: 'max' } },
      { source: 'claude-code', aggregate: true, model: 'opus', reportedCost: { amount: 7.89, currency: 'USD', kind: 'estimate', basis: 'list' } });
    expect(usageText(subscription)).toBe('≈$7.89 API-equivalent');
    expect(tasksTotalText([{ attemptUsage: [subscription] }])).toBe('Tasks total: ≈$7.89 API-equivalent');
    expect(modelCostTitle(subscription.byModel ?? [])).toBe("claude-code / opus: ≈$7.89 API-equivalent — Claude Code's estimate at list price; not billed on a subscription");
    const mixed = attempt(2, 'opencode', { source: 'opencode', reportedCost: { amount: 1, currency: 'USD', kind: 'estimate' } });
    expect(tasksTotalText([{ attemptUsage: [subscription, mixed] }])).toBe('Tasks total: ≈$8.89');
    expect(usageText(mixed)).toBe('≈$1.00');
    expect(usageText(attempt(3, 'openrouter', { source: 'openrouter', reportedCost: { amount: 7.89, currency: 'USD', kind: 'billed' } }))).toBe('$7.89');
  });

  it('never calls an API-key session API-equivalent', () => {
    const apiKey = attempt(1, 'claude-code',
      { source: 'claude-code', aggregate: true, sessionBilling: { type: 'api-key' } },
      { source: 'claude-code', model: 'opus', reportedCost: { amount: 7.89, currency: 'USD', kind: 'estimate', basis: 'list' } });
    expect(usageText(apiKey)).toBe('≈$7.89');
    expect(modelCostTitle(apiKey.byModel ?? [])).toBe("claude-code / opus: ≈$7.89 — Claude Code's estimate at list price");
  });

  it('is each currency as reported, or nothing', () => {
    expect(costText({ reportedCost: { USD: 7.89 } })).toBe('$7.89');
    expect(costText({ inputTokens: 5 })).toBeNull();
  });
});
