/**
 * xterm's colours, taken from the same `--ow-*` tokens the rest of the window
 * uses (design: Design tokens) so the terminal never carries a palette of its
 * own. Pure: it reads tokens through a function, as the Monaco theme does.
 */

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

/** The terminal draws in the editor's font and size, so code looks the same in both. */
export { EDITOR_FONT as TERMINAL_FONT, EDITOR_FONT_SIZE as TERMINAL_FONT_SIZE } from '../../monaco/theme';

function hex(value: string): string | undefined {
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : undefined;
}

function withAlpha(color: string, alpha: number): string {
  return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

export function buildTerminalTheme(read: (token: string) => string, dark: boolean): TerminalTheme {
  const token = (name: string, fallback: string): string => hex(read(`--ow-${name}`)) ?? fallback;
  const bg = token('bg', dark ? '#1c1f23' : '#ffffff');
  const fg = token('fg', dark ? '#e6e8eb' : '#1a1c1f');
  const muted = token('fg-secondary', fg);
  const accent = token('accent', '#1393b3');
  const red = token('status-failed', '#d1453b');
  const green = token('status-passed', '#2e9d5b');
  const yellow = token('status-attention', '#c08a1a');
  const blue = token('status-running', accent);
  const magenta = token('status-merge', '#8b5cc6');
  const cyan = accent;
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: token('bg-selected', withAlpha(accent, 0.25)),
    selectionInactiveBackground: token('bg-hover', withAlpha(accent, 0.12)),
    black: dark ? token('border', '#3a3d42') : fg,
    red, green, yellow, blue, magenta, cyan,
    white: muted,
    brightBlack: token('fg-placeholder', muted),
    brightRed: red, brightGreen: green, brightYellow: yellow, brightBlue: blue, brightMagenta: magenta, brightCyan: cyan,
    brightWhite: fg,
  };
}
