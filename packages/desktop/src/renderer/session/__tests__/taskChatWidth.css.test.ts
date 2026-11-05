import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The task chat's width is the browser's, measured by the e2e tour; this keeps the old column cap from returning. */
const css = readFileSync(fileURLToPath(new URL('../session.css', import.meta.url)), 'utf8');

describe("the desktop's task chat stylesheet", () => {
  it('uses the tab\'s full width, with a gutter from the spacing scale', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes('.session-task-chat')).map((m) => m[0]);
    expect(rules.some((rule) => /padding-inline: var\(--ow-space-\d+\)/.test(rule))).toBe(true);
    for (const rule of rules) expect(rule, rule).not.toMatch(/calc\(\(100%\s*-\s*\d+px\)\s*\/\s*2\)/);
  });
});
