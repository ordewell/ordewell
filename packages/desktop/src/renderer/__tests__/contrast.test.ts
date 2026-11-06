import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG AA for theme.css's values: 4.5:1 for text, 3:1 for what is not text
 * (status marks, the accent's strokes and pills, the focus ring, a control's
 * border), each on every surface it is drawn on (docs/desktop/design.md,
 * Colour roles).
 */
const css = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');

function scheme(name: 'light' | 'dark'): Map<string, string> {
  const block = new RegExp(`prefers-color-scheme: ${name}\\)\\s*\\{\\s*:root\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (!block) throw new Error(`theme.css has no ${name} block`);
  const values = new Map([...block.matchAll(/--ow-([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1], match[2]]));
  // An alias the doc names is a var() of the token it aliases, so it is checked at that token's value.
  for (const [, alias, target] of block.matchAll(/--ow-([\w-]+):\s*var\(--ow-([\w-]+)\)\s*;/g)) {
    const resolved = values.get(target);
    if (resolved) values.set(alias, resolved);
  }
  return values;
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

// The surface ladder's fills carry the same text as the rest (the overlay is bg-overlay, by alias).
const CARDS = ['surface-card', 'surface-card-hover', 'surface-card-selected'];
const SURFACES = ['bg-chrome', 'bg', 'bg-sidebar', 'bg-widget', 'bg-overlay', 'bg-hover', 'bg-selected', ...CARDS];
const INSETS = ['bg-input', 'bg-code', 'surface-inset'];
const STATUSES = ['idle', 'running', 'attention', 'passed', 'failed', 'blocked', 'merge', 'warning', 'warning-text', 'error'];
const AREAS = ['planner', 'sessions', 'explorer', 'changes', 'git'];
const RUNNERS = ['claude-code', 'codex', 'opencode', 'copilot-cli', 'qwen-code', 'cline', 'gemini-cli', 'cursor-agent'];

const TEXT: Array<[string, string[]]> = [
  ['fg', [...SURFACES, ...INSETS, 'accent-tint', 'diff-inserted', 'diff-removed', 'diff-inserted-word', 'diff-removed-word']],
  ['fg-secondary', [...SURFACES, ...INSETS]],
  ['fg-muted', [...SURFACES, ...INSETS]],
  ['fg-placeholder', ['bg-input', 'bg-overlay']],
  ['fg-link', SURFACES],
  // A status is a word as well as a shape, so each one is text on every surface.
  ...STATUSES.map((status): [string, string[]] => [`status-${status}`, SURFACES]),
  // An area hue is legible on the chrome and the surface it is drawn on.
  ...AREAS.map((area): [string, string[]] => [`area-${area}`, ['bg-chrome', 'bg-sidebar']]),
  // A runner badge is its colour as text on its own tint.
  ...RUNNERS.map((runner): [string, string[]] => [`runner-${runner}`, [`runner-${runner}-tint`]]),
  // The primary button's label, at rest and hovered: the fill is the accent on dark, its emphasis on light.
  ['accent-on', ['accent-fill', 'accent-fill-hover']],
];
const MARKS: Array<[string, string[]]> = [
  ['accent', [...SURFACES, 'accent-tint']],
  ['focus-ring', [...SURFACES, 'bg-input']],
  ['border-control', [...SURFACES, 'bg-input']],
  ...AREAS.map((area): [string, string[]] => [`area-${area}`, SURFACES]),
  // The runner's mark (the colour as a graphic) is seen on every surface a badge sits on.
  ...RUNNERS.map((runner): [string, string[]] => [`runner-${runner}`, SURFACES]),
];

/**
 * A card is seen by its fill, not only by its hairline: each step of the
 * ladder stands off what it sits on by at least this much, in either theme
 * (docs/desktop/design.md, Surfaces). The tour measures the same thing on the
 * rendered cards (e2e/surfaces.ts).
 */
const LIFT = 1.05;
const LIFTS: Array<[string, string]> = [
  ['surface-card', 'surface-canvas'],
  ['surface-card', 'surface-panel'],
  ['surface-card-hover', 'surface-canvas'],
  ['surface-card-selected', 'surface-canvas'],
  ['surface-card-selected', 'surface-panel'],
  ['surface-inset', 'surface-card'],
  ['surface-inset', 'surface-card-selected'],
  ['surface-overlay', 'surface-card'],
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

  it.each(LIFTS)(`lifts %s off %s by ${LIFT}:1`, (surface, behind) => {
    expect(contrast(value(surface), value(behind))).toBeGreaterThanOrEqual(LIFT);
  });

  it.each(MARKS.flatMap(([fg, on]) => on.map((bg) => [fg, bg])))('sees %s on %s at 3:1', (fg, bg) => {
    expect(contrast(value(fg), value(bg))).toBeGreaterThanOrEqual(3);
  });
});

/** Distance in OKLab, x100: about 5 is two colours that read as different hues at a glance. */
function distance(a: string, b: string): number {
  const lab = (hex: string): number[] => {
    const [r, g, b2] = [1, 3, 5].map((at) => {
      const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b2);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b2);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b2);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(...x.map((value, at) => value - y[at])) * 100;
}

describe.each(['light', 'dark'] as const)('the %s theme\'s runner colours', (name) => {
  const tokens = scheme(name);
  const hex = (token: string): string => tokens.get(token)!;
  const pairs = RUNNERS.flatMap((runner, at) => RUNNERS.slice(at + 1).map((other): [string, string] => [runner, other]));

  it.each(pairs)('tells %s from %s', (runner, other) => {
    expect(distance(hex(`runner-${runner}`), hex(`runner-${other}`))).toBeGreaterThanOrEqual(5);
  });

  // Claude Code's clay predates this check and sits near blocked's orange; the five newer runners keep clear of every status.
  it.each(RUNNERS.slice(3).flatMap((runner) => STATUSES.map((status): [string, string] => [runner, status])))('tells %s from status %s', (runner, status) => {
    expect(distance(hex(`runner-${runner}`), hex(`status-${status}`))).toBeGreaterThanOrEqual(5);
  });
});

it('measures contrast as WCAG does', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
});
