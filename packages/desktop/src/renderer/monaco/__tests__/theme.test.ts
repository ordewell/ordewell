import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTheme } from '../theme';

const css = readFileSync(join(__dirname, '../../theme.css'), 'utf8');

/** The `--ow-*` values theme.css declares for a scheme. */
function scheme(name: 'light' | 'dark'): Map<string, string> {
  const block = new RegExp(`prefers-color-scheme: ${name}\\)\\s*\\{\\s*:root\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (!block) throw new Error(`theme.css has no ${name} block`);
  return new Map([...block.matchAll(/(--ow-[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1] as string, m[2] as string]));
}

describe('buildTheme', () => {
  it('takes the editor\'s colours from the design tokens, so a retheme moves it too', () => {
    const read = (name: string): string => `#${name.length.toString(16).padStart(2, '0')}0000`;
    const theme = buildTheme(read, false);
    expect(theme.base).toBe('vs');
    expect(theme.colors['editor.background']).toBe(read('--ow-bg'));
    expect(theme.colors['editor.foreground']).toBe(read('--ow-fg'));
  });

  it('is dark on a dark scheme', () => {
    expect(buildTheme(() => '#101010', true).base).toBe('vs-dark');
  });

  it('falls back when a token is not defined, rather than leaving the editor unstyled', () => {
    const theme = buildTheme(() => '', false);
    for (const value of Object.values(theme.colors)) expect(value).toMatch(/^#[0-9a-fA-F]{6,8}$/);
  });

  it('draws each scheme in the colours theme.css gives it', () => {
    for (const name of ['light', 'dark'] as const) {
      const values = scheme(name);
      const theme = buildTheme((token) => values.get(token) ?? '', name === 'dark');
      expect(theme.colors['editor.background']).toBe(values.get('--ow-bg'));
      expect(theme.colors['editor.foreground']).toBe(values.get('--ow-fg'));
      expect(theme.colors['editorCursor.foreground']).toBe(values.get('--ow-accent'));
    }
  });
});
