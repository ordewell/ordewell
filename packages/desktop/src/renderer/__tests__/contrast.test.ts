import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG AA for theme.css's values: 4.5:1 for text, 3:1 for what is not text
 * (status marks, the accent's strokes and pills, the focus ring), each on
 * every surface it is drawn on.
 */
const css = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');

function scheme(name: 'light' | 'dark'): Map<string, string> {
  const block = new RegExp(`prefers-color-scheme: ${name}\\)\\s*\\{\\s*:root\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (!block) throw new Error(`theme.css has no ${name} block`);
  return new Map([...block.matchAll(/--ow-([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1], match[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['bg', 'bg-sidebar', 'bg-widget', 'bg-overlay', 'bg-hover', 'bg-selected'];
const TEXT: Array<[string, string[]]> = [
  ['fg', [...SURFACES, 'bg-input', 'bg-code', 'diff-inserted', 'diff-removed', 'diff-inserted-word', 'diff-removed-word']],
  ['fg-secondary', [...SURFACES, 'bg-input', 'bg-code']],
  ['fg-placeholder', ['bg-input', 'bg-overlay']],
  ['fg-link', SURFACES],
  ['status-warning-text', SURFACES],
  ['accent-on', ['accent-emphasis']],
];
const MARKS: Array<[string, string[]]> = [
  ...['idle', 'running', 'attention', 'passed', 'failed', 'blocked', 'merge', 'warning', 'error']
    .map((status): [string, string[]] => [`status-${status}`, SURFACES]),
  ['accent', [...SURFACES, 'accent-tint']],
  ['focus-ring', [...SURFACES, 'bg-input']],
];

describe.each(['light', 'dark'] as const)('the %s theme', (name) => {
  const tokens = scheme(name);
  const value = (token: string): string => {
    const found = tokens.get(token);
    if (!found) throw new Error(`theme.css's ${name} block has no --ow-${token}`);
    return found;
  };

  it.each(TEXT.flatMap(([fg, on]) => on.map((bg) => [fg, bg])))('reads %s on %s at 4.5:1', (fg, bg) => {
    expect(contrast(value(fg), value(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MARKS.flatMap(([fg, on]) => on.map((bg) => [fg, bg])))('sees %s on %s at 3:1', (fg, bg) => {
    expect(contrast(value(fg), value(bg))).toBeGreaterThanOrEqual(3);
  });
});

it('measures contrast as WCAG does', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
});
