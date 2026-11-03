import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const fromUi = (path: string) => readFileSync(createRequire(import.meta.url).resolve(`@ordewell/ui/${path}`), 'utf8');
const tokens = fromUi('tokens.css');
const styles = fromUi('styles.css');
const mapping = readFileSync(resolve(__dirname, '../vscode-tokens.css'), 'utf8');

const declared = (css: string) => new Set([...css.matchAll(/(--ow-[a-z-]+)\s*:/g)].map((m) => m[1]));

describe('the VS Code theme behind the ui tokens', () => {
  it('maps every token the package declares, and nothing else', () => {
    expect([...declared(mapping)].sort()).toEqual([...declared(tokens)].sort());
  });

  it('declares every token the stylesheet reads', () => {
    const read = new Set([...styles.matchAll(/var\((--ow-[a-z-]+)/g)].map((m) => m[1]));
    expect([...read].filter((token) => !declared(tokens).has(token))).toEqual([]);
  });

  // A token left unset by the theme must stay invalid, so each rule's own
  // fallback applies as it did when the rule read the --vscode-* variable.
  it('points each token at a VS Code variable with no fallback of its own', () => {
    const values = [...mapping.matchAll(/--ow-[a-z-]+\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(values.filter((value) => !/^var\(--vscode-[A-Za-z-]+\)$/.test(value))).toEqual([]);
  });

  it('leaves no VS Code variable in the package stylesheet', () => {
    expect(styles).not.toMatch(/--vscode-/);
  });
});
