import { describe, expect, it } from 'vitest';
import { wordMove } from '../wordKeys';

type Mods = Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing', boolean>>;
const key = (k: string, m: Mods = {}) =>
  ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...m });

describe('wordMove', () => {
  it('sends Meta+B / Meta+F for Option+Left/Right on macOS', () => {
    expect(wordMove(key('ArrowLeft', { altKey: true }), true)).toBe('\x1bb');
    expect(wordMove(key('ArrowRight', { altKey: true }), true)).toBe('\x1bf');
  });

  it('leaves every other chord to xterm', () => {
    expect(wordMove(key('ArrowLeft'), true)).toBeUndefined();
    expect(wordMove(key('ArrowUp', { altKey: true }), true)).toBeUndefined();
    expect(wordMove(key('ArrowLeft', { altKey: true, shiftKey: true }), true)).toBeUndefined();
    expect(wordMove(key('ArrowLeft', { altKey: true, metaKey: true }), true)).toBeUndefined();
    expect(wordMove(key('ArrowLeft', { altKey: true, ctrlKey: true }), true)).toBeUndefined();
    expect(wordMove(key('c', { ctrlKey: true }), true)).toBeUndefined();
    expect(wordMove(key('b', { altKey: true }), true)).toBeUndefined();
  });

  it('leaves an input method composing text alone', () => {
    expect(wordMove(key('ArrowLeft', { altKey: true, isComposing: true }), true)).toBeUndefined();
  });

  it('rewrites nothing off macOS, where Ctrl+Left/Right is the word chord', () => {
    expect(wordMove(key('ArrowLeft', { altKey: true }), false)).toBeUndefined();
    expect(wordMove(key('ArrowRight', { altKey: true }), false)).toBeUndefined();
    expect(wordMove(key('ArrowLeft', { ctrlKey: true }), false)).toBeUndefined();
  });
});
