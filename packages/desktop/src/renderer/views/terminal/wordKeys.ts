import type { IBuffer } from '@xterm/xterm';

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing'>;

/** What the word chord needs to know about the terminal at the moment it is pressed. */
export interface WordScreen {
  /** The program shows the terminal's own cursor, so the cursor is its caret. */
  cursorVisible: boolean;
  /** DECCKM: the program asked for arrows as ESC O x rather than ESC [ x. */
  applicationCursorKeys: boolean;
  /** The cursor's line, wrapped rows joined, one entry per character on screen. */
  line: readonly string[];
  /** The cursor's index into `line`. */
  cursor: number;
}

/**
 * Option+Left/Right on macOS: a word back or forward. xterm.js 6 sends
 * ESC[1;3D / ESC[1;3C, which no stock shell binds. The usual rewrite, ESC b /
 * ESC f, is a word move only in emacs mode. A vi-mode line editor reads the ESC
 * as "leave insert mode", and the letter after it as a command that waits for
 * the next key. ESC[1;3C there ends in C (change to end of line) and deletes.
 *
 * So while the program shows the terminal's cursor, as every line editor does,
 * the chord reads the word boundary off the screen and sends that many plain
 * arrows. Every keymap of zsh and bash (emacs, vi insert, vi command) and every
 * full-screen editor binds a plain arrow to one character and no mode change.
 * A program that hides the cursor draws its own caret elsewhere, as Ink-based
 * agent TUIs do, so the screen says nothing about where it is. Those programs
 * get Meta+B / Meta+F, which they read as a word move.
 *
 * Returns undefined to leave the key to xterm, and '' to swallow it (no word to move to).
 * Elsewhere the convention is Ctrl+Left/Right, whose ESC[1;5D / ESC[1;5C xterm
 * already sends, so nothing is rewritten.
 */
export function wordMove(event: KeyLike, mac: boolean, screen: () => WordScreen): string | undefined {
  if (!mac || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  const back = event.key === 'ArrowLeft';
  if (!back && event.key !== 'ArrowRight') return undefined;
  const view = screen();
  if (!view.cursorVisible) return back ? '\x1bb' : '\x1bf';
  const steps = wordSteps(view.line, view.cursor, back);
  return `\x1b${view.applicationCursorKeys ? 'O' : '['}${back ? 'D' : 'C'}`.repeat(steps);
}

const WORD = /^[\p{L}\p{N}\p{M}_]+$/u;
const isWord = (char: string | undefined): boolean => char !== undefined && WORD.test(char);

/**
 * Characters from `cursor` to the start of the word before it (back) or the end
 * of the word after it, as a macOS text field moves. Blank cells past the last
 * text on the line are not a word to move into.
 */
export function wordSteps(line: readonly string[], cursor: number, back: boolean): number {
  if (back) {
    let i = Math.min(cursor, line.length);
    while (i > 0 && !isWord(line[i - 1])) i--;
    while (i > 0 && isWord(line[i - 1])) i--;
    return Math.max(0, cursor - i);
  }
  let i = cursor;
  while (i < line.length && !isWord(line[i])) i++;
  if (i >= line.length) return 0;
  while (i < line.length && isWord(line[i])) i++;
  return i - cursor;
}

/**
 * The cursor's line in `buffer`: its rows joined, a wide character's trailing
 * cell dropped so each entry is one character, as the shell counts them, and
 * trailing blanks trimmed. A row runs on into the next when xterm wrapped it,
 * or when the program wrote to its last column and moved down itself, which is
 * how zsh draws a long command line (its rows are not marked as wrapped).
 */
export function cursorLine(buffer: Pick<IBuffer, 'baseY' | 'cursorX' | 'cursorY' | 'getLine'>, cols: number): { line: string[]; cursor: number } {
  const row = buffer.baseY + buffer.cursorY;
  const runsOn = (y: number): boolean =>
    buffer.getLine(y + 1) !== undefined
    && (buffer.getLine(y + 1)?.isWrapped === true || (buffer.getLine(y)?.getCell(cols - 1)?.getChars() ?? '') !== '');
  let first = row;
  while (first > 0 && runsOn(first - 1)) first--;
  let last = row;
  while (runsOn(last)) last++;

  const line: string[] = [];
  let cursor = -1;
  for (let y = first; y <= last; y++) {
    const cells = buffer.getLine(y);
    for (let x = 0; x < cols; x++) {
      if (y === row && x === buffer.cursorX) cursor = line.length;
      const cell = cells?.getCell(x);
      if (cell?.getWidth() === 0) continue;
      line.push(cell?.getChars() || ' ');
    }
    // Past the last column: the cursor waits to wrap, after every cell of its row.
    if (y === row && cursor < 0) cursor = line.length;
  }
  let end = line.length;
  while (end > 0 && line[end - 1].trim() === '') end--;
  return { line: line.slice(0, end), cursor };
}
