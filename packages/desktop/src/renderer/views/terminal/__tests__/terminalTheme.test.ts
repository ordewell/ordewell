import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTerminalTheme } from '../terminalTheme';

const css = readFileSync(join(__dirname, '../../../theme.css'), 'utf8');

function scheme(name: 'light' | 'dark'): Map<string, string> {
  const block = new RegExp(`prefers-color-scheme: ${name}\\)\\s*\\{\\s*:root\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (!block) throw new Error(`theme.css has no ${name} block`);
  return new Map([...block.matchAll(/(--ow-[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1] as string, m[2] as string]));
}

describe('buildTerminalTheme', () => {
  it('paints the terminal in the page colours of each scheme, and the two schemes differ', () => {
    const light = scheme('light');
    const dark = scheme('dark');
    const lightTheme = buildTerminalTheme((token) => light.get(token) ?? '', false);
    const darkTheme = buildTerminalTheme((token) => dark.get(token) ?? '', true);

    expect(lightTheme.background).toBe(light.get('--ow-bg'));
    expect(darkTheme.background).toBe(dark.get('--ow-bg'));
    expect(lightTheme.background).not.toBe(darkTheme.background);
    expect(lightTheme.foreground).not.toBe(darkTheme.foreground);
    expect(lightTheme.black).not.toBe(darkTheme.black);
  });

  it('falls back to a palette per scheme when a token is missing', () => {
    const light = buildTerminalTheme(() => '', false);
    const dark = buildTerminalTheme(() => '', true);
    expect(light.background).not.toBe(dark.background);
    expect(light.foreground).not.toBe(dark.foreground);
  });
});
