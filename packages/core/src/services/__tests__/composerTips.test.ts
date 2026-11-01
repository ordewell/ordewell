import { describe, it, expect } from 'vitest';
import { COMPOSER_TIPS, composerTip, tipCycle, type ComposerTip } from '../composerTips';

const TUI = new Set(['allowlist', 'planner', 'runners', 'settings', 'help']);
const WEBVIEW = new Set(['allowlist', 'planner', 'settings', 'help']);

const commandsOf = (cycle: readonly ComposerTip[]): string[] => cycle.map((tip) => tip.command);
const counts = (cycle: readonly ComposerTip[]): Record<string, number> =>
  Object.fromEntries(COMPOSER_TIPS.map((tip) => [tip.command, cycle.filter((t) => t.command === tip.command).length]));
/** A cycle laid end to end with itself, as the composer meets it seq after seq. */
const followsItself = (cycle: readonly ComposerTip[]): boolean =>
  cycle.some((tip, i) => tip.command === cycle[(i + 1) % cycle.length].command);

describe('tipCycle', () => {
  it('shows each tip exactly its weight times, so /allowlist comes round more often than any other', () => {
    const tally = counts(tipCycle(COMPOSER_TIPS));
    expect(tally).toEqual({ allowlist: 3, planner: 1, runners: 1, settings: 1, help: 1 });
    for (const [command, n] of Object.entries(tally)) {
      if (command !== 'allowlist') expect(tally.allowlist).toBeGreaterThan(n);
    }
  });

  it('spreads /allowlist out, never twice running, across the wrap included, on both surfaces', () => {
    for (const answers of [TUI, WEBVIEW]) {
      const cycle = tipCycle(COMPOSER_TIPS.filter((tip) => answers.has(tip.command)));
      expect(followsItself(cycle)).toBe(false);
    }
    expect(commandsOf(tipCycle(COMPOSER_TIPS))).toEqual(['allowlist', 'planner', 'allowlist', 'runners', 'allowlist', 'settings', 'help']);
  });

  it('still gives every tip its weight once a weight outgrows the rest, repeating only what it must', () => {
    const heavy = COMPOSER_TIPS.map((tip) => (tip.command === 'allowlist' ? { ...tip, weight: 6 } : tip));
    const cycle = tipCycle(heavy);
    expect(cycle).toHaveLength(10);
    expect(counts(cycle).allowlist).toBe(6);
    expect(commandsOf(cycle).slice(0, 8)).toEqual(['allowlist', 'planner', 'allowlist', 'runners', 'allowlist', 'settings', 'allowlist', 'help']);
  });
});

describe('composerTip', () => {
  it('gives the same tip for the same seq, and the next one for the next', () => {
    expect(composerTip(0, TUI)).toBe(composerTip(0, TUI));
    expect(composerTip(0, TUI)).toBe('Tip: Use /allowlist to limit which models the planner assigns per runner.');
    expect(composerTip(1, TUI)).toBe("Tip: Use /planner to pick the planner's harness, model and effort.");
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
