import { describe, expect, it } from 'vitest';
import { formatChord, matchesChord, parseChord, type KeyEventLike } from '../keys';

const key = (init: Partial<KeyEventLike> & Pick<KeyEventLike, 'key'>): KeyEventLike =>
  ({ code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init });

describe('keys', () => {
  it('reads Mod as Command on macOS and Control elsewhere', () => {
    const chord = parseChord('Mod+K');
    expect(matchesChord(chord, key({ key: 'k', metaKey: true }), true)).toBe(true);
    expect(matchesChord(chord, key({ key: 'k', ctrlKey: true }), true)).toBe(false);
    expect(matchesChord(chord, key({ key: 'k', ctrlKey: true }), false)).toBe(true);
    expect(matchesChord(chord, key({ key: 'k', metaKey: true }), false)).toBe(false);
  });

  it('keeps Ctrl as Control on a Mac', () => {
    expect(matchesChord(parseChord('Ctrl+`'), key({ key: '`', code: 'Backquote', ctrlKey: true }), true)).toBe(true);
  });

  it('matches by the physical key when Shift or a layout changes what it types', () => {
    expect(matchesChord(parseChord('Mod+Shift+A'), key({ key: 'A', shiftKey: true, metaKey: true }), true)).toBe(true);
    expect(matchesChord(parseChord('Ctrl+`'), key({ key: 'Dead', code: 'Backquote', ctrlKey: true }), false)).toBe(true);
    expect(matchesChord(parseChord('Mod+1'), key({ key: '&', code: 'Digit1', ctrlKey: true }), false)).toBe(true);
  });

  it('wants every modifier exactly', () => {
    expect(matchesChord(parseChord('Mod+K'), key({ key: 'k', metaKey: true, shiftKey: true }), true)).toBe(false);
  });

  it('writes a chord as each platform does', () => {
    expect(formatChord(parseChord('Mod+Shift+A'), true)).toBe('⇧⌘A');
    expect(formatChord(parseChord('Mod+Shift+A'), false)).toBe('Ctrl+Shift+A');
    expect(formatChord(parseChord('Mod+Shift+Enter'), true)).toBe('⇧⌘⏎');
    expect(formatChord(parseChord('Ctrl+Tab'), false)).toBe('Ctrl+Tab');
  });
});
