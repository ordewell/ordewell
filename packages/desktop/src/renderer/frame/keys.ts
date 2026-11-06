/**
 * Shortcuts written once for every platform: `Mod` is ⌘ on macOS and Ctrl
 * elsewhere, as docs/desktop/design.md's keyboard table writes them. `Ctrl`
 * is the Control key everywhere, for the two shortcuts that are Control on a
 * Mac too (Ctrl+` and Ctrl+Tab).
 */
export interface Chord {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Lower case, as `KeyboardEvent.key` names it: "k", "1", "`", "\\", "enter", "tab". */
  key: string;
}

export function parseChord(text: string): Chord {
  const parts = text.split('+');
  // "Mod++" would be a plus; no shortcut here uses one, so the last part is the key.
  const key = (parts.pop() ?? '').toLowerCase();
  const mods = new Set(parts.map((part) => part.toLowerCase()));
  return { mod: mods.has('mod'), ctrl: mods.has('ctrl'), shift: mods.has('shift'), alt: mods.has('alt'), key };
}

/** The key a layout-independent code stands for, where Shift or a dead key would change `key`. */
const CODES: Readonly<Record<string, string>> = {
  Backquote: '`',
  Backslash: '\\',
  Comma: ',',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
};

function keyOf(event: Pick<KeyboardEvent, 'key' | 'code'>): string[] {
  const keys = [event.key.toLowerCase()];
  const coded = CODES[event.code] ?? /^Digit(\d)$/.exec(event.code)?.[1] ?? /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase();
  if (coded) keys.push(coded);
  return keys;
}

export type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

export function matchesChord(chord: Chord, event: KeyEventLike, mac: boolean): boolean {
  const meta = mac && chord.mod;
  const ctrl = chord.ctrl || (!mac && chord.mod);
  if (event.metaKey !== meta || event.ctrlKey !== ctrl || event.shiftKey !== chord.shift || event.altKey !== chord.alt) return false;
  return keyOf(event).includes(chord.key);
}

const MAC_GLYPHS: Readonly<Record<string, string>> = { enter: '⏎', tab: '⇥' };

/** A shortcut as the platform writes it: "⌘⇧A" on macOS, "Ctrl+Shift+A" elsewhere. */
export function formatChord(chord: Chord, mac: boolean): string {
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key[0].toUpperCase() + chord.key.slice(1);
  if (mac) {
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${MAC_GLYPHS[chord.key] ?? key}`;
  }
  return [chord.ctrl || chord.mod ? 'Ctrl' : '', chord.alt ? 'Alt' : '', chord.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

export function isMac(platform: string): boolean {
  return platform === 'darwin';
}
