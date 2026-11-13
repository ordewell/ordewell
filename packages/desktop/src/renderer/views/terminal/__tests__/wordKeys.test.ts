import type { IBufferCell, IBufferLine } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { cursorLine, wordMove, wordSteps, type WordScreen } from '../wordKeys';

type Mods = Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing', boolean>>;
const key = (k: string, m: Mods = {}) =>
  ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...m });
const option = (k: string) => key(k, { altKey: true });

const chars = (text: string) => [...text];
const shown = (text: string, cursor: number, rest: Partial<WordScreen> = {}) =>
  (): WordScreen => ({ cursorVisible: true, applicationCursorKeys: false, line: chars(text), cursor, ...rest });

describe('wordMove', () => {
  it('sends as many plain arrows as the word on screen is long', () => {
    expect(wordMove(option('ArrowLeft'), true, shown('$ echo one two', 14))).toBe('\x1b[D'.repeat(3));
    expect(wordMove(option('ArrowRight'), true, shown('$ echo one two', 7))).toBe('\x1b[C'.repeat(3));
  });

  it('sends ESC O x arrows under application cursor keys', () => {
    expect(wordMove(option('ArrowLeft'), true, shown('one two', 7, { applicationCursorKeys: true }))).toBe('\x1bOD'.repeat(3));
  });

  it('swallows the chord when there is no word to move to', () => {
    expect(wordMove(option('ArrowRight'), true, shown('$ echo one', 10))).toBe('');
    expect(wordMove(option('ArrowLeft'), true, shown('', 0))).toBe('');
  });

  it('sends Meta+B / Meta+F when the program hides the cursor, without reading the screen for a word', () => {
    const hidden = shown('', 0, { cursorVisible: false });
    expect(wordMove(option('ArrowLeft'), true, hidden)).toBe('\x1bb');
    expect(wordMove(option('ArrowRight'), true, hidden)).toBe('\x1bf');
  });

  it('leaves every other chord to xterm, and does not read the screen for it', () => {
    const screen = () => { throw new Error('read the screen for a chord it does not rewrite'); };
    expect(wordMove(key('ArrowLeft'), true, screen)).toBeUndefined();
    expect(wordMove(option('ArrowUp'), true, screen)).toBeUndefined();
    expect(wordMove(key('ArrowLeft', { altKey: true, shiftKey: true }), true, screen)).toBeUndefined();
    expect(wordMove(key('ArrowLeft', { altKey: true, metaKey: true }), true, screen)).toBeUndefined();
    expect(wordMove(key('ArrowLeft', { altKey: true, ctrlKey: true }), true, screen)).toBeUndefined();
    expect(wordMove(key('c', { ctrlKey: true }), true, screen)).toBeUndefined();
    expect(wordMove(option('b'), true, screen)).toBeUndefined();
    expect(wordMove(key('ArrowLeft', { altKey: true, isComposing: true }), true, screen)).toBeUndefined();
  });

  it('rewrites nothing off macOS, where Ctrl+Left/Right is the word chord', () => {
    const screen = shown('one two', 7);
    expect(wordMove(option('ArrowLeft'), false, screen)).toBeUndefined();
    expect(wordMove(option('ArrowRight'), false, screen)).toBeUndefined();
    expect(wordMove(key('ArrowLeft', { ctrlKey: true }), false, screen)).toBeUndefined();
  });
});

describe('wordSteps', () => {
  const line = chars('ls foo-bar  été_2');
  it('goes back to the start of the word before the cursor, from inside it or past blanks', () => {
    expect(wordSteps(line, 17, true)).toBe(5);
    expect(wordSteps(line, 12, true)).toBe(5);
    expect(wordSteps(line, 9, true)).toBe(2);
    expect(wordSteps(line, 0, true)).toBe(0);
  });

  it('goes forward to the end of the word after the cursor', () => {
    expect(wordSteps(line, 0, false)).toBe(2);
    expect(wordSteps(line, 2, false)).toBe(4);
    expect(wordSteps(line, 10, false)).toBe(7);
    expect(wordSteps(line, 17, false)).toBe(0);
  });

  it('counts back from the end of the text when the cursor is past it', () => {
    expect(wordSteps(chars('one'), 6, true)).toBe(6);
  });
});

describe('cursorLine', () => {
  /** Rows of a buffer `cols` wide; `|` marks a row xterm wrapped from the one before, `.` a cell never written to, and a CJK character is wide. */
  function buffer(cols: number, rows: string[], cursor: { x: number; y: number }, baseY = 0) {
    const lines = rows.map((row) => {
      const isWrapped = row.startsWith('|');
      const cells: Array<{ chars: string; width: number }> = [];
      for (const char of isWrapped ? row.slice(1) : row) {
        if (char >= '\u2e80') cells.push({ chars: char, width: 2 }, { chars: '', width: 0 });
        else cells.push({ chars: char === '.' ? '' : char, width: 1 });
      }
      const cell = (x: number) => cells[x] ?? { chars: '', width: 1 };
      return {
        isWrapped,
        getCell: (x: number) => (x < cols ? { getChars: () => cell(x).chars, getWidth: () => cell(x).width } as IBufferCell : undefined),
      } as IBufferLine;
    });
    return { baseY, cursorX: cursor.x, cursorY: cursor.y, getLine: (y: number) => lines[y] };
  }

  it('reads the cursor row alone, blanks past the text trimmed', () => {
    expect(cursorLine(buffer(10, ['$ ls', '$ one two.', '$'], { x: 9, y: 1 }), 10))
      .toEqual({ line: chars('$ one two'), cursor: 9 });
  });

  it('joins rows xterm marked as wrapped', () => {
    expect(cursorLine(buffer(4, ['$ ab', '|cd e', '|f'], { x: 1, y: 2 }), 4))
      .toEqual({ line: chars('$ abcd ef'), cursor: 9 });
  });

  it('joins a full row into the next when the program moved down itself, as zsh does', () => {
    expect(cursorLine(buffer(4, ['$ ab', 'cd e', 'f'], { x: 0, y: 1 }), 4))
      .toEqual({ line: chars('$ abcd ef'), cursor: 4 });
    // A row that stops short of the edge is a line of its own.
    expect(cursorLine(buffer(4, ['$ a.', 'cd'], { x: 2, y: 1 }), 4)).toEqual({ line: chars('cd'), cursor: 2 });
  });

  it('counts a wide character once, as the shell does', () => {
    expect(cursorLine(buffer(8, ['$ 漢字 x'], { x: 7, y: 0 }), 8))
      .toEqual({ line: chars('$ 漢字 x'), cursor: 5 });
  });

  it('puts a cursor waiting to wrap after the last cell of its row', () => {
    expect(cursorLine(buffer(4, ['$ ab'], { x: 4, y: 0 }), 4)).toEqual({ line: chars('$ ab'), cursor: 4 });
  });

  it('reads the row the cursor is on below the scrollback', () => {
    expect(cursorLine(buffer(4, ['old', '$ ab'], { x: 4, y: 0 }, 1), 4)).toEqual({ line: chars('$ ab'), cursor: 4 });
  });
});
