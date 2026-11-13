import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '../../../models/Usage';
import { UsageRecordBuilder, type CallUsage } from '../usageBuilder';

const builder = () => new UsageRecordBuilder('r');

describe('UsageRecordBuilder.call', () => {
  it.each<[string, CallUsage, UsageRecord | null]>([
    ['a main-thread call with its context and window',
      { model: 'm', inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, contextTokens: 15, contextWindow: 200 },
      { source: 'r', model: 'm', inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, contextTokens: 15, contextWindow: 200 }],
    ['a subagent call, which measures no main context',
      { inputTokens: 10, outputTokens: 5, contextTokens: 15, contextWindow: 200, subagentId: 'a1' },
      { source: 'r', inputTokens: 10, outputTokens: 5, subagentId: 'a1' }],
    ['a call made for a purpose, as an aggregate that names no subagent',
      { inputTokens: 10, outputTokens: 5, contextTokens: 15, subagentId: 'a1', purpose: 'title' },
      { source: 'r', inputTokens: 10, outputTokens: 5, aggregate: true, purpose: 'title' }],
    ['all zeros as nothing, whatever its cost', { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: { amount: 0.1 } }, null],
    ['no counts as nothing', { model: 'm' }, null],
    ['a cached count alone as nothing: it is part of the prompt, not beside it', { cachedInputTokens: 9 }, null],
    ['a window of 0 as unknown', { inputTokens: 1, contextWindow: 0 }, { source: 'r', inputTokens: 1 }],
    ['a context of 0 as unmeasured', { outputTokens: 1, contextTokens: 0 }, { source: 'r', outputTokens: 1 }],
    ['a zero on one side beside a measure on the other', { inputTokens: 3, outputTokens: 0 }, { source: 'r', inputTokens: 3, outputTokens: 0 }],
    ['a cost of 0 as no claim', { inputTokens: 1, cost: { amount: 0 } }, { source: 'r', inputTokens: 1 }],
    ['a cost in USD unless it names its currency',
      { inputTokens: 1, cost: { amount: 0.5, kind: 'estimate', basis: 'list' } },
      { source: 'r', inputTokens: 1, reportedCost: { amount: 0.5, currency: 'USD', kind: 'estimate', basis: 'list' } }],
    ['a named currency', { inputTokens: 1, cost: { amount: 2, currency: 'EUR' } }, { source: 'r', inputTokens: 1, reportedCost: { amount: 2, currency: 'EUR' } }],
  ])('builds %s', (_name, call, record) => {
    expect(builder().call(call)).toEqual(record);
  });

  it('counts a call with an id once', () => {
    const usage = builder();
    expect(usage.call({ inputTokens: 1 }, 'm1')).toEqual({ source: 'r', inputTokens: 1 });
    expect(usage.call({ inputTokens: 2 }, 'm1')).toBeNull();
    expect(usage.has('m1')).toBe(true);
    expect(usage.call({ inputTokens: 2 }, 'm2')).toEqual({ source: 'r', inputTokens: 2 });
  });

  it('counts every call that has no id', () => {
    const usage = builder();
    expect(usage.call({ inputTokens: 1 })).not.toBeNull();
    expect(usage.call({ inputTokens: 1 })).not.toBeNull();
  });

  it('leaves an id open while its call reports nothing, and closes it on a report of zeros', () => {
    const usage = builder();
    expect(usage.call(undefined, 'm1')).toBeNull();
    expect(usage.has('m1')).toBe(false);
    expect(usage.call({ inputTokens: 4 }, 'm1')).toEqual({ source: 'r', inputTokens: 4 });

    expect(usage.call({ inputTokens: 0, outputTokens: 0 }, 'm2')).toBeNull();
    expect(usage.call({ inputTokens: 4 }, 'm2')).toBeNull();
  });
});

describe('UsageRecordBuilder.turnTotal', () => {
  it('reports a turn whose calls did not stream in full, as an aggregate', () => {
    expect(builder().turnTotal({ model: 'm', inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 })).toEqual({
      source: 'r', model: 'm', aggregate: true, inputTokens: 10, cachedInputTokens: 4, outputTokens: 3,
    });
  });

  it('adds only what the main thread\'s calls did not report', () => {
    const usage = builder();
    usage.call({ inputTokens: 6, cachedInputTokens: 4, outputTokens: 3 });
    usage.call({ inputTokens: 50, outputTokens: 50, subagentId: 'a1' });
    usage.call({ inputTokens: 50, outputTokens: 50, purpose: 'title' });
    expect(usage.turnTotal({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 })).toEqual({ source: 'r', aggregate: true, inputTokens: 4 });
  });

  it('reports nothing when every call streamed, and starts the next turn from nothing', () => {
    const usage = builder();
    usage.call({ inputTokens: 10, outputTokens: 3 });
    expect(usage.turnTotal({ inputTokens: 10, outputTokens: 3 })).toBeNull();
    expect(usage.turnTotal({ inputTokens: 2 })).toEqual({ source: 'r', aggregate: true, inputTokens: 2 });
  });

  it('closes the turn even when it reports no sum', () => {
    const usage = builder();
    usage.call({ inputTokens: 10 });
    expect(usage.turnTotal(undefined)).toBeNull();
    expect(usage.turnTotal({ inputTokens: 10 })).toEqual({ source: 'r', aggregate: true, inputTokens: 10 });
  });

  it('claims no cached share of a prompt it does not add', () => {
    const usage = builder();
    usage.call({ inputTokens: 10 });
    expect(usage.turnTotal({ inputTokens: 10, cachedInputTokens: 8, outputTokens: 2 })).toEqual({ source: 'r', aggregate: true, outputTokens: 2 });
  });
});

describe('UsageRecordBuilder.cost', () => {
  it('reports spend as an aggregate carrying the login it was spent on', () => {
    const usage = builder();
    expect(usage.cost({ amount: 0.2, kind: 'estimate' })).toEqual({ source: 'r', aggregate: true, reportedCost: { amount: 0.2, currency: 'USD', kind: 'estimate' } });
    usage.billing({ type: 'subscription', plan: 'max' });
    expect(usage.cost({ model: 'm', amount: 0.2, basis: 'managed' })).toEqual({
      source: 'r', model: 'm', aggregate: true, sessionBilling: { type: 'subscription', plan: 'max' }, reportedCost: { amount: 0.2, currency: 'USD', basis: 'managed' },
    });
  });

  it.each([0, -1, Number.NaN])('reports nothing for %s', (amount) => {
    expect(builder().cost({ amount })).toBeNull();
  });
});

describe('UsageRecordBuilder.billing', () => {
  it('keeps a known plan when a later report of the same login names none', () => {
    const usage = builder();
    expect(usage.billing({ type: 'subscription', plan: 'pro' })).toEqual({ source: 'r', aggregate: true, sessionBilling: { type: 'subscription', plan: 'pro' } });
    expect(usage.billing({ type: 'subscription' })).toEqual({ source: 'r', aggregate: true, sessionBilling: { type: 'subscription', plan: 'pro' } });
    expect(usage.billing({ type: 'subscription', plan: 'max' }).sessionBilling).toEqual({ type: 'subscription', plan: 'max' });
  });

  it('forgets the plan when the login changes', () => {
    const usage = builder();
    usage.billing({ type: 'subscription', plan: 'pro' });
    expect(usage.billing({ type: 'api-key' }).sessionBilling).toEqual({ type: 'api-key' });
    expect(usage.billing({ type: 'subscription' }).sessionBilling).toEqual({ type: 'subscription' });
  });
});

describe('UsageRecordBuilder.compacted and meter', () => {
  it('marks a reset, with the size after it when the runner states one', () => {
    expect(builder().compacted()).toEqual({ source: 'r', compacted: true });
    expect(builder().compacted({ model: 'm', contextTokens: 900 })).toEqual({ source: 'r', model: 'm', compacted: true, contextTokens: 900 });
    expect(builder().compacted({ contextTokens: 0 })).toEqual({ source: 'r', compacted: true, contextTokens: 0 });
  });

  it('states a meter, a window of 0 being unknown', () => {
    expect(builder().meter({ model: 'm', contextTokens: 5, contextWindow: 100 })).toEqual({ source: 'r', model: 'm', contextTokens: 5, contextWindow: 100 });
    expect(builder().meter({ contextWindow: 100 })).toEqual({ source: 'r', contextWindow: 100 });
    expect(builder().meter({ contextTokens: 5, contextWindow: 0 })).toEqual({ source: 'r', contextTokens: 5 });
    expect(builder().meter({ model: 'm', contextWindow: 0 })).toBeNull();
  });
});
