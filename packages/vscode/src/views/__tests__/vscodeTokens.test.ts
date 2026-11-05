import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const fromUi = (path: string) => readFileSync(createRequire(import.meta.url).resolve(`@ordewell/ui/${path}`), 'utf8');
const tokens = fromUi('tokens.css');
const styles = fromUi('styles.css');
const scale = fromUi('scale.css');
const design = fromUi('design.css');
const mapping = readFileSync(resolve(__dirname, '../vscode-tokens.css'), 'utf8');

const declared = (css: string) => new Set([...css.matchAll(/(--ow-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const reads = (css: string) => new Set([...css.matchAll(/var\((--ow-[a-z0-9-]+)/g)].map((m) => m[1]));
const RUNNER = /^--ow-runner-/;
const SURFACE = /^--ow-surface-/;

describe('the VS Code theme behind the ui tokens', () => {
  it('maps every token the package declares, and nothing else', () => {
    expect([...declared(mapping)].sort()).toEqual([...declared(tokens)].sort());
  });

  // Sizes are no theme's to set, so scale.css declares them and the mapping leaves them alone.
  it('declares every token the stylesheets read, as a colour or a size', () => {
    const known = new Set([...declared(tokens), ...declared(scale)]);
    expect([...reads(styles), ...reads(design)].filter((token) => !known.has(token))).toEqual([]);
    expect([...declared(mapping)].filter((token) => declared(scale).has(token))).toEqual([]);
  });

  // A token left unset by the theme must stay invalid, so each rule's own
  // fallback applies as it did when the rule read the --vscode-* variable.
  // The runner colours are the exception: no theme has one, so they keep the design's values.
  // A surface no theme names is mixed from the theme's own colours, or drawn
  // as nothing, never as a colour of ours (docs/desktop/design.md, Surfaces).
  it('points each token at a VS Code variable with no fallback of its own', () => {
    const vscodeVar = String.raw`var\(--vscode-[A-Za-z0-9-]+\)`;
    const theme = new RegExp(`^${vscodeVar}$`);
    const mixed = new RegExp(`^color-mix\\(in srgb, ${vscodeVar} \\d+%, (${vscodeVar}|transparent)\\)$`);
    const values = [...mapping.matchAll(/(--ow-[a-z0-9-]+)\s*:\s*([^;]+);/g)].filter((m) => !RUNNER.test(m[1]));
    const offTheme = values.filter(([, token, raw]) => {
      const value = raw.trim();
      return !theme.test(value) && !(SURFACE.test(token) && (mixed.test(value) || value === 'transparent'));
    });
    expect(offTheme.map(([, token, value]) => `${token}: ${value}`)).toEqual([]);
  });

  it('draws no surface of its own colour', () => {
    const surfaces = [...mapping.matchAll(/(--ow-surface-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => m[2]);
    expect(surfaces.length).toBeGreaterThan(0);
    expect(surfaces.filter((value) => /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i.test(value))).toEqual([]);
  });

  it('draws high-contrast cards as edges, not tints', () => {
    const hc = /:root:has\(> body\.vscode-high-contrast\),\s*:root:has\(> body\.vscode-high-contrast-light\)\s*\{([^}]*)\}/.exec(mapping)?.[1] ?? '';
    for (const fill of ['card', 'card-hover', 'card-selected', 'inset', 'card-shadow']) {
      expect(hc).toMatch(new RegExp(`--ow-surface-${fill}:\\s*transparent;`));
    }
    expect(hc).toMatch(/--ow-surface-card-border:\s*var\(--vscode-contrastBorder\);/);
  });

  it('gives every runner colour a value for light themes as well as dark', () => {
    const runners = [...declared(tokens)].filter((token) => RUNNER.test(token)).sort();
    const light = /body\.vscode-light[^{]*\{([^}]*)\}/.exec(mapping)?.[1] ?? '';
    expect([...declared(light)].sort()).toEqual(runners);
  });

  it('leaves no VS Code variable in the package stylesheets', () => {
    expect(styles).not.toMatch(/--vscode-/);
    expect(design).not.toMatch(/--vscode-/);
  });
});
