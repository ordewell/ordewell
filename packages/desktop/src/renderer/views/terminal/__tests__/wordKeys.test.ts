import { describe, expect, it } from 'vitest';
import { unavailableWordChord } from '../wordKeys';

const key = (key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent => ({
  key, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...overrides,
} as KeyboardEvent);

describe('unavailableWordChord', () => {
  it('swallows only the exact macOS Option arrow chord', () => {
    expect(unavailableWordChord(key('ArrowLeft'), true)).toBe(true);
    expect(unavailableWordChord(key('ArrowRight'), true)).toBe(true);
    for (const event of [key('ArrowUp'), key('b'), key('ArrowLeft', { altKey: false }),
      key('ArrowLeft', { ctrlKey: true }), key('ArrowLeft', { metaKey: true }),
      key('ArrowLeft', { shiftKey: true }), key('ArrowLeft', { isComposing: true })]) {
      expect(unavailableWordChord(event, true)).toBe(false);
    }
    expect(unavailableWordChord(key('ArrowLeft'), false)).toBe(false);
  });
});
