import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The chat column's fit, as stylesheet text, since jsdom has no layout: what is
 * measured in a real browser (composer, usage line and Settings bar inside the
 * panel with the dock and a list open) rests on these few rules, and each one
 * was the reason a measurement failed.
 */
const css = readFileSync(fileURLToPath(new URL('../../styles.css', import.meta.url)), 'utf8');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function block(selector: string): string {
  const match = new RegExp(`(?:^|\\n)${escape(selector)}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `no rule for ${selector}`).not.toBeNull();
  return match![1];
}
const declared = (selector: string, property: string): string | undefined =>
  new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(block(selector))?.[1].trim();

describe('the chat column keeps the composer in the panel', () => {
  it('never squeezes the composer or the usage line', () => {
    expect(declared('.chat-input', 'flex-shrink')).toBe('0');
    expect(declared('.usage-line', 'flex-shrink')).toBe('0');
  });

  it('lets the plan dock take a whole shortfall: a shrink factor under one takes only that share of it', () => {
    expect(Number(declared('.plan-dock', 'flex-shrink'))).toBeGreaterThanOrEqual(1);
    expect(Number(declared('.setup-panel', 'flex-shrink'))).toBeGreaterThan(Number(declared('.plan-dock', 'flex-shrink')));
  });

  it('keeps the Settings toggle and the dock bar from being squeezed out', () => {
    expect(parseInt(declared('.setup-panel', 'min-height') ?? '0', 10)).toBeGreaterThanOrEqual(28);
    expect(parseInt(declared('.plan-dock', 'min-height') ?? '0', 10)).toBeGreaterThanOrEqual(30);
  });

  it('opens the inbox list over the conversation, taking no height from the column', () => {
    expect(declared('.escalation-inbox-body', 'position')).toBe('absolute');
    expect(declared('.escalation-inbox-body', 'bottom')).toBe('100%');
    expect(declared('.usage-line', 'position')).toBe('relative');
    expect(declared('.usage-line', 'overflow')).toBeUndefined();
  });

  it('keeps the control at the end of the line and the usage text the one that shrinks', () => {
    expect(declared('.escalation-inbox', 'flex-shrink')).toBe('0');
    expect(declared('.escalation-inbox', 'margin-left')).toBe('auto');
    expect(declared('.usage-line-measures', 'overflow')).toBe('hidden');
  });
});
