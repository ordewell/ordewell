/**
 * Monaco's colours, taken from the same `--ow-*` tokens the rest of the window
 * uses (design: Design tokens), so the editor never carries a palette of its
 * own. Pure: it reads tokens through a function, so a test can read theme.css
 * and the editor can read the live document.
 */

export interface MonacoThemeData {
  base: 'vs' | 'vs-dark';
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; fontStyle?: string }>;
  colors: Record<string, string>;
}

/** What the editor draws in. Falls back through the family the way the rest of the UI does. */
export const EDITOR_FONT = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
/** type.code is 12.5/19 (design: Type). */
export const EDITOR_FONT_SIZE = 12.5;
export const EDITOR_LINE_HEIGHT = 19;

/** `#rrggbb`, which Monaco takes, from a token's value; undefined when the token is unset or not a hex colour. */
function hex(value: string): string | undefined {
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : undefined;
}

/** A hex colour with an alpha byte: Monaco reads `#rrggbbaa`. */
function withAlpha(color: string, alpha: number): string {
  return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

export const THEME_NAME = 'ordewell';

export function buildTheme(read: (token: string) => string, dark: boolean): MonacoThemeData {
  const token = (name: string, fallback: string): string => hex(read(`--ow-${name}`)) ?? fallback;
  const bg = token('bg', dark ? '#1c1f23' : '#ffffff');
  const fg = token('fg', dark ? '#e6e8eb' : '#1a1c1f');
  const muted = token('fg-secondary', fg);
  const placeholder = token('fg-placeholder', muted);
  const accent = token('accent', '#1393b3');
  const colors: Record<string, string> = {
    'editor.background': bg,
    'editor.foreground': fg,
    'editorLineNumber.foreground': placeholder,
    'editorLineNumber.activeForeground': fg,
    'editorCursor.foreground': accent,
    'editor.selectionBackground': token('bg-selected', withAlpha(accent, 0.25)),
    'editor.inactiveSelectionBackground': token('bg-hover', withAlpha(accent, 0.12)),
    'editor.lineHighlightBackground': token('bg-hover', bg),
    'editor.lineHighlightBorder': bg,
    'editorIndentGuide.background1': token('border', muted),
    'editorWhitespace.foreground': token('border', muted),
    'editorWidget.background': token('bg-widget', bg),
    'editorWidget.border': token('border-widget', muted),
    'editorSuggestWidget.background': token('bg-overlay', bg),
    'editorSuggestWidget.selectedBackground': token('bg-selected', bg),
    'editorHoverWidget.background': token('bg-overlay', bg),
    'editorHoverWidget.border': token('border-widget', muted),
    'input.background': token('bg-input', bg),
    'input.foreground': fg,
    'input.border': token('border-widget', muted),
    focusBorder: token('focus-ring', accent),
    'scrollbarSlider.background': withAlpha(muted, 0.25),
    'scrollbarSlider.hoverBackground': withAlpha(muted, 0.4),
    'scrollbarSlider.activeBackground': withAlpha(muted, 0.55),
    'diffEditor.insertedLineBackground': token('diff-inserted', bg),
    'diffEditor.removedLineBackground': token('diff-removed', bg),
    'diffEditor.insertedTextBackground': token('diff-inserted-word', bg),
    'diffEditor.removedTextBackground': token('diff-removed-word', bg),
    // The statuses by their own tokens: `status-error` and `status-warning` are aliases a theme may leave to resolve late.
    'editorError.foreground': token('status-failed', fg),
    'editorWarning.foreground': token('status-attention', fg),
    'editorGutter.background': bg,
    'diffEditor.border': token('border', muted),
    'diffEditor.diagonalFill': token('border', muted),
    'diffEditorGutter.insertedLineBackground': token('diff-inserted-word', bg),
    'diffEditorGutter.removedLineBackground': token('diff-removed-word', bg),
    'editorOverviewRuler.border': bg,
  };
  return { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors };
}
