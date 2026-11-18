import { describe, it, expect } from 'vitest';
import { TokenGauge, callBudget, largestReplyTokens } from '../plannerContextBudget';

// A chain review cut off at the usual allowance is asked once more for the longest reply the model serves.
describe('largestReplyTokens', () => {
  it.each([
    [{ contextWindow: 1_048_576, maxOutputTokens: 128_000 }, 32_000, 128_000],
    [{ inputTokenLimit: 1_048_576, maxOutputTokens: 65_536 }, 16_384, 65_536],
    // The window's share still bounds it, and a model that states no cap keeps the usual allowance.
    [{ contextWindow: 200_000, maxOutputTokens: 128_000 }, 32_000, 50_000],
    [{ contextWindow: 1_048_576 }, 32_000, 32_000],
    [undefined, 32_000, 32_000],
    [{ contextWindow: 200_000, maxOutputTokens: 8_192 }, 32_000, 8_192],
  ])('asks %o, usually %d, for %d', (limits, wanted, expected) => {
    expect(largestReplyTokens(limits, wanted)).toBe(expected);
  });
});

describe('callBudget', () => {
  // Worked by hand: ceiling = min(90% of W, W less the reply); the reply is
  // min(32,000, the provider's cap, a quarter of W).
  it.each([
    [{ contextWindow: 131_072 }, { maxOutputTokens: 32_000, ceiling: 99_072 }],
    [{ contextWindow: 1_048_576 }, { maxOutputTokens: 32_000, ceiling: 943_718 }],
    [{ contextWindow: 32_768 }, { maxOutputTokens: 8_192, ceiling: 24_576 }],
    [{ contextWindow: 16_384 }, { maxOutputTokens: 4_096, ceiling: 12_288 }],
    [{ contextWindow: 200_000, maxOutputTokens: 8_192 }, { maxOutputTokens: 8_192, ceiling: 180_000 }],
  ])('budgets %o as %o', (limits, expected) => {
    expect(callBudget(limits)).toMatchObject(expected);
  });

  it('prunes, once it must, down to three quarters of the ceiling', () => {
    expect(callBudget({ contextWindow: 131_072 })?.lowWater).toBe(74_304);
  });

  // Gemini states the prompt's limit apart from the reply's: the reply takes
  // nothing out of it, and no share of it caps the reply.
  it.each([
    [{ inputTokenLimit: 1_048_576, maxOutputTokens: 65_536 }, 16_384, { maxOutputTokens: 16_384, ceiling: 943_718, promptLimit: 1_048_576, lowWater: 707_788 }],
    [{ inputTokenLimit: 32_768, maxOutputTokens: 8_192 }, 16_384, { maxOutputTokens: 8_192, ceiling: 29_491, promptLimit: 32_768 }],
    [{ inputTokenLimit: 16_384 }, 16_384, { maxOutputTokens: 16_384, ceiling: 14_745, promptLimit: 16_384 }],
  ])('budgets an input-only limit %o, asking for at most %d, as %o', (limits, wanted, expected) => {
    expect(callBudget(limits, wanted)).toMatchObject({ contextWindow: limits.inputTokenLimit, ...expected });
  });

  it('refuses a call outright only past what the prompt may hold: the window less the reply', () => {
    expect(callBudget({ contextWindow: 131_072 })?.promptLimit).toBe(99_072);
  });

  it('budgets nothing on a window it does not know', () => {
    expect(callBudget(undefined)).toBeUndefined();
    expect(callBudget({ maxOutputTokens: 4_096 })).toBeUndefined();
    expect(callBudget({ contextWindow: 0 })).toBeUndefined();
  });
});

describe('TokenGauge', () => {
  it('estimates high before any measurement, and refuses nothing on that guess alone', () => {
    const gauge = new TokenGauge();
    expect(gauge.charsPerToken('a')).toBe(3);
    expect(gauge.plainCharsPerToken('a')).toBeUndefined();
  });

  it('takes a model\'s own measurement with a margin, and another model\'s with a wider one until its own arrives', () => {
    const gauge = new TokenGauge();
    gauge.record('a', 44_000, 10_000);
    expect(gauge.charsPerToken('a')).toBeCloseTo(4.4 / 1.1);
    expect(gauge.charsPerToken('b')).toBeCloseTo(4.4 / 1.25);
    // Another tokenizer's ratio estimates; it never refuses a call outright.
    expect(gauge.plainCharsPerToken('b')).toBeUndefined();

    gauge.record('b', 30_000, 10_000);
    expect(gauge.charsPerToken('b')).toBeCloseTo(3 / 1.1);
    expect(gauge.charsPerToken('a')).toBeCloseTo(4.4 / 1.1);
  });

  it('takes a refusal of a model never measured as no sparser than any tokenizer', () => {
    const gauge = new TokenGauge();
    // 330,000 characters refused as more than 10,000 tokens: true of every tokenizer, so it says nothing past six to a token.
    gauge.refused('a', 330_000, 10_000);
    expect(gauge.plainCharsPerToken('a')).toBe(6);
    gauge.refused('a', 20_000, 10_000);
    expect(gauge.plainCharsPerToken('a')).toBe(2);
  });

  it('ignores a report of no tokens, and caps a ratio no tokenizer produces', () => {
    const gauge = new TokenGauge();
    gauge.record('a', 1_000, 0);
    expect(gauge.plainCharsPerToken('a')).toBeUndefined();
    gauge.record('a', 1_000_000, 10);
    expect(gauge.plainCharsPerToken('a')).toBe(6);
  });
});
