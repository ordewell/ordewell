import { describe, expect, it } from 'vitest';
import { macWordChord } from '../wordKeys';

const key = (key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent => ({
  key, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...overrides,
} as KeyboardEvent);

describe('macWordChord', () => {
  it('names the direction of the exact macOS Option arrow chord, and nothing else', () => {
    expect(macWordChord(key('ArrowLeft'), true)).toBe('left');
    expect(macWordChord(key('ArrowRight'), true)).toBe('right');
    for (const event of [key('ArrowUp'), key('b'), key('ArrowLeft', { altKey: false }),
      key('ArrowLeft', { ctrlKey: true }), key('ArrowLeft', { metaKey: true }),
      key('ArrowLeft', { shiftKey: true }), key('ArrowLeft', { isComposing: true })]) {
      expect(macWordChord(event, true)).toBeUndefined();
    }
    expect(macWordChord(key('ArrowLeft'), false)).toBeUndefined();
  });
});
