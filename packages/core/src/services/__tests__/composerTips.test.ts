import { describe, it, expect } from 'vitest';
import { COMPOSER_TIPS, composerTip, keyTipContext, tipCycle, type ComposerTip } from '../composerTips';

// The tips every surface may show whatever it knows; the key tip waits on a fact.
const ALWAYS = COMPOSER_TIPS.filter((tip) => !tip.when);

const TUI = new Set(['allowlist', 'planner', 'runners', 'settings', 'help']);
const WEBVIEW = new Set(['allowlist', 'planner', 'settings', 'help']);

const commandsOf = (cycle: readonly ComposerTip[]): string[] => cycle.map((tip) => tip.command);
const counts = (cycle: readonly ComposerTip[]): Record<string, number> =>
  Object.fromEntries(ALWAYS.map((tip) => [tip.command, cycle.filter((t) => t.command === tip.command).length]));
/** A cycle laid end to end with itself, as the composer meets it seq after seq. */
const followsItself = (cycle: readonly ComposerTip[]): boolean =>
  cycle.some((tip, i) => tip.command === cycle[(i + 1) % cycle.length].command);
/** Adjacent equal tips, counting the wrap from the last seq to the first. */
const adjacencies = (cycle: readonly ComposerTip[]): number =>
  cycle.reduce((n, tip, i) => n + (tip.command === cycle[(i + 1) % cycle.length].command ? 1 : 0), 0);
/** The longest run of one tip, counting a run that crosses the wrap. */
const longestRun = (cycle: readonly ComposerTip[]): number => {
  const doubled = [...cycle, ...cycle];
  let longest = 0;
  let run = 1;
  for (let i = 1; i < doubled.length; i++) {
    run = doubled[i].command === doubled[i - 1].command ? run + 1 : 1;
    longest = Math.max(longest, Math.min(run, cycle.length));
  }
  return longest;
};

describe('tipCycle', () => {
  it('shows each tip exactly its weight times, so /allowlist comes round more often than any other', () => {
    const tally = counts(tipCycle(ALWAYS));
    expect(tally).toEqual({ allowlist: 3, planner: 1, runners: 1, settings: 1, help: 1 });
    for (const [command, n] of Object.entries(tally)) {
      if (command !== 'allowlist') expect(tally.allowlist).toBeGreaterThan(n);
    }
  });

  it('spreads /allowlist out, never twice running, across the wrap included, on both surfaces', () => {
    for (const answers of [TUI, WEBVIEW]) {
      const cycle = tipCycle(ALWAYS.filter((tip) => answers.has(tip.command)));
      expect(followsItself(cycle)).toBe(false);
    }
    expect(commandsOf(tipCycle(ALWAYS))).toEqual(['allowlist', 'runners', 'allowlist', 'planner', 'allowlist', 'settings', 'help']);
  });

  it('still gives every tip its weight once a weight outgrows the rest, repeating only what it must', () => {
    const heavy = ALWAYS.map((tip) => (tip.command === 'allowlist' ? { ...tip, weight: 6 } : tip));
    const cycle = tipCycle(heavy);
    expect(cycle).toHaveLength(10);
    expect(counts(cycle).allowlist).toBe(6);
    // Six /allowlist tips to four others: two touches are forced, and the two
    // that are forced must not gather into a run of three at the wrap.
    expect(adjacencies(cycle)).toBe(2);
    expect(longestRun(cycle)).toBe(2);
    expect(commandsOf(cycle)).toEqual(['allowlist', 'help', 'allowlist', 'runners', 'allowlist', 'allowlist', 'planner', 'allowlist', 'settings', 'allowlist']);
  });

  it('keeps the forced repetition to its minimum at every adjustable weight', () => {
    const others = ALWAYS.length - 1;
    for (let weight = 1; weight <= 10; weight++) {
      const heavy = ALWAYS.map((tip) => (tip.command === 'allowlist' ? { ...tip, weight } : tip));
      const cycle = tipCycle(heavy);
      expect(counts(cycle).allowlist).toBe(weight);
      // A cycle of `weight` /allowlist tips and `others` separators has
      // max(0, weight - others) forced touches, and no run may be longer than
      // an even share of the separators allows.
      expect(adjacencies(cycle)).toBe(Math.max(0, weight - others));
      expect(longestRun(cycle)).toBe(Math.max(1, Math.ceil(weight / Math.min(weight, others))));
    }
  });
});

describe('composerTip', () => {
  it('gives the same tip for the same seq, and the next one for the next', () => {
    expect(composerTip(0, TUI)).toBe(composerTip(0, TUI));
    expect(composerTip(0, TUI)).toBe('Tip: Use /allowlist to limit which models the planner assigns per runner.');
    expect(composerTip(1, TUI)).toBe('Tip: Use /runners to turn runners on or off.');
  });

  it('wraps past the end of a cycle', () => {
    expect(composerTip(7, TUI)).toBe(composerTip(0, TUI));
    expect(composerTip(6, WEBVIEW)).toBe(composerTip(0, WEBVIEW));
  });

  it('offers only the tips for the commands a surface answers', () => {
    const seen = new Set(Array.from({ length: 12 }, (_, seq) => composerTip(seq, WEBVIEW)));
    expect([...seen].some((tip) => tip?.includes('/runners'))).toBe(false);
    expect(seen.size).toBe(4);
  });

  it('is null when a surface answers none of the commands', () => {
    expect(composerTip(0, new Set(['quit']))).toBeNull();
  });

  it('fits every tip after the prompt and caret of an 80-column terminal', () => {
    for (const tip of COMPOSER_TIPS) expect(tip.text.length).toBeLessThanOrEqual(73);
  });
});

describe('the /key-set tip', () => {
  const KEYED = new Set([...TUI, 'key-set']);
  const KEY_TIP = 'Tip: Add an API key with /key-set to run tasks on the built-in runner.';
  const tipsOver = (context: Parameters<typeof composerTip>[2]): Set<string | null> =>
    new Set(Array.from({ length: 20 }, (_, seq) => composerTip(seq, KEYED, context)));

  it('names the command and the built-in runner, as heavily as /allowlist', () => {
    const tip = COMPOSER_TIPS.find((t) => t.command === 'key-set');
    expect(tip?.text).toBe(KEY_TIP);
    expect(tip?.weight).toBe(3);
  });

  it('shows only where the surface says no provider is configured', () => {
    expect(tipsOver({ providerKeySet: false }).has(KEY_TIP)).toBe(true);
    expect(tipsOver({ providerKeySet: true }).has(KEY_TIP)).toBe(false);
    // A surface that does not say is not told about something it may have.
    expect(tipsOver({}).has(KEY_TIP)).toBe(false);
    expect(new Set(Array.from({ length: 20 }, (_, seq) => composerTip(seq, KEYED))).has(KEY_TIP)).toBe(false);
  });

  it('shows only where the surface answers /key-set', () => {
    expect(new Set(Array.from({ length: 20 }, (_, seq) => composerTip(seq, TUI, { providerKeySet: false }))).has(KEY_TIP)).toBe(false);
  });

  it('leaves the cycle as it was once a key is set', () => {
    for (let seq = 0; seq < 14; seq++) expect(composerTip(seq, KEYED, { providerKeySet: true })).toBe(composerTip(seq, TUI));
  });

  it('comes round three times a cycle beside /allowlist, neither following itself', () => {
    const cycle = tipCycle(COMPOSER_TIPS.filter((tip) => KEYED.has(tip.command)));
    expect(cycle.filter((tip) => tip.command === 'key-set')).toHaveLength(3);
    expect(cycle.filter((tip) => tip.command === 'allowlist')).toHaveLength(3);
    expect(followsItself(cycle)).toBe(false);
  });
});

describe('the key tip\'s fact, one rule for every surface (ADR-0070)', () => {
  const known = (ids: string[]) => ({ ids, known: true });
  const unknown = { ids: [], known: false };

  it('is set by a configured provider with a runner, or a provider runner listed, whichever answers first', () => {
    expect(keyTipContext(known(['openrouter']), unknown)).toEqual({ providerKeySet: true });
    expect(keyTipContext(unknown, known(['claude-code', 'anthropic']))).toEqual({ providerKeySet: true });
  });

  it('is not set by a key that serves the planner alone, once both lists have answered', () => {
    expect(keyTipContext(known(['perplexity']), known(['claude-code']))).toEqual({ providerKeySet: false });
  });

  it('is unknown until both lists have answered', () => {
    expect(keyTipContext(known([]), unknown)).toEqual({});
    expect(keyTipContext(unknown, known([]))).toEqual({});
    expect(keyTipContext(known(['perplexity']), unknown)).toEqual({});
  });
});
