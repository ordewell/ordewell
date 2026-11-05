import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The desktop's conversation uses its tab's full width once it has messages.
 * Layout is the browser's, so the e2e tour measures it; this reads the rules
 * that once capped the column, so one cannot come back unnoticed.
 */
const css = readFileSync(fileURLToPath(new URL('../../styles.css', import.meta.url)), 'utf8');

/** Every rule whose selector mentions `selector`, with its block. */
function rulesFor(source: string, selector: string): string[] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes(selector)).map((m) => m[0]);
}

describe('the conversation layout stylesheet', () => {
  it('caps no conversation rule at a column width', () => {
    const rules = rulesFor(css, '.chat-layout-conversation');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule, rule).not.toMatch(/max-width\s*:\s*\d/);
      expect(rule, rule).not.toMatch(/calc\(\(100%\s*-\s*\d+px\)\s*\/\s*2\)/);
    }
  });

  it("keeps the empty first screen's centred column", () => {
    expect(css).toMatch(/\.empty-state-hero\s*\{[^}]*max-width: var\(--first-screen-column\)/);
  });

  it("scrolls a code block and a table inside their message instead of widening the page", () => {
    expect(css).toMatch(/\.chat-msg-content pre\s*\{[^}]*overflow-x: auto/);
    expect(css).toMatch(/\.chat-msg-content \.md-table\s*\{[^}]*overflow-x: auto/);
  });
});
