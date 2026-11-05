import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Adversarial check of the sweeping progress ring's stylesheet, as text: the
 * ring is CSS-only, so the place a regression can hide is a rule that stops
 * sweeping, starts moving a stalled or completed ring, or loses the
 * prefers-reduced-motion fallback. `.task-check`'s geometry is pinned too: the
 * sweep must never change the box pending, running and done share.
 */
const css = readFileSync(fileURLToPath(new URL('../../../styles.css', import.meta.url)), 'utf8');

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The declaration block of the first rule with this exact selector prefix. */
function block(selector: string): string {
  const match = new RegExp(`${escape(selector)}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `no rule for ${selector}`).not.toBeNull();
  return match![1];
}

/** The body of the first at-rule whose prelude contains `prelude`. */
function atBlock(prelude: string): string {
  const start = css.indexOf(prelude);
  expect(start, `no at-rule for ${prelude}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated at-rule for ${prelude}`);
}

describe('the sweeping ring stylesheet', () => {
  it("keeps the 14px ring box, a row's status shape, that the pending, running and done states share", () => {
    const base = block('.task-check');
    expect(base).toContain('width: 14px;');
    expect(base).toContain('height: 14px;');
  });

  it('moves the running ring on the pseudo-element, not the ring box', () => {
    const running = block('.task-check.running');
    expect(running).not.toContain('animation');
    expect(running).toContain('var(--accent)');
    expect(running).toContain('position: relative;');

    const arc = block('.task-check.running::before');
    expect(arc).toContain('animation: task-check-sweep');
    expect(arc).toMatch(/mask:\s*radial-gradient/);
    expect(arc).toContain('-webkit-mask: radial-gradient');
  });

  it('has one documented sweep: the fill, the tail catching up, and the empty start', () => {
    const frames = atBlock('@keyframes task-check-sweep');
    expect(frames).toContain('0%');
    expect(frames).toContain('50%');
    expect(frames).toContain('100%');
    expect(frames).toContain('--check-arc-start');
    expect(frames).toContain('--check-arc-end');
  });

  it('has retired the old glow keyframes', () => {
    expect(css).not.toContain('task-check-pulse');
  });

  it('has a reduced-motion fallback that stops the ring dead', () => {
    const reduce = atBlock('@media (prefers-reduced-motion: reduce)');
    expect(reduce).toContain('.task-check.running');
    expect(reduce).toContain('animation: none;');
    expect(reduce).toMatch(/\.task-check\.running::before\s*\{[^}]*background: var\(--accent\)/s);
    expect(reduce).toContain('-webkit-mask: none;');
    expect(reduce).toContain('mask: none;');
    expect(reduce).toContain('width: 5px;');
  });

  it('leaves the stalled ring still and purple', () => {
    const stalled = block('.task-check.stalled');
    expect(stalled).toContain('border-color: var(--purple);');
    expect(stalled).not.toContain('animation');
  });

  it('keeps the done pop and draw', () => {
    expect(block('.task-check.done')).toContain('animation: task-check-pop');
    expect(block('.task-check.done svg path')).toContain('animation: task-check-draw');
  });
});
