import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Pixels are the e2e tour's; this keeps each tab kind tied to the hue the design names for it (design, Main area). */
const css = readFileSync(fileURLToPath(new URL('../frame.css', import.meta.url)), 'utf8');

function declared(selector: string): string | undefined {
  for (const [, head, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (head!.split(',').some((part) => part.trim() === selector)) return /(?:^|;)\s*(?:color|background):\s*([^;]+)/.exec(body!)?.[1]?.trim();
  }
  return undefined;
}

// Teal (the accent) for the planner, task and plan graph tabs; indigo for files, mint for diffs, slate for the commit graph and commit tabs.
const HUES: ReadonlyArray<[kind: string, area: string]> = [
  ['file', 'explorer'],
  ['diff', 'changes'],
  ['commit-diff', 'changes'],
  ['commits', 'git'],
  ['commit', 'git'],
];

describe("the frame's tab hues", () => {
  it.each(HUES)('draws a %s tab\'s icon and its focused marker in --ow-area-%s', (kind, area) => {
    expect(declared(`.frame-tab[data-tab-kind='${kind}'] > .ow-icon`)).toBe(`var(--ow-area-${area})`);
    expect(declared(`.frame-group-focused .frame-tab-active[data-tab-kind='${kind}']::before`)).toBe(`var(--ow-area-${area})`);
  });

  it('keeps an unfocused group\'s marker quiet, whatever its kind', () => {
    expect(declared('.frame-group:not(.frame-group-focused) .frame-tab-active::before')).toBe('var(--ow-border-contrast)');
  });
});
