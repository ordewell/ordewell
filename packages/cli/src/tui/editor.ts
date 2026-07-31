import { wrapLines, type WrapLine } from './ansi';
import type { Key } from './keys';

export interface EditorState {
  text: string;
  cursor: number;
  /** Submitted lines, oldest first. Browsed with up/down. */
  history: string[];
  /** `history.length` means "not browsing" — the live draft is showing. */
  historyIndex: number;
  /** The draft parked while browsing history, restored on the way back down. */
  draft: string;
}

export function emptyEditor(): EditorState {
  return { text: '', cursor: 0, history: [], historyIndex: 0, draft: '' };
}

/**
 * `cols` is only needed to move the cursor a visual line at a time through
 * wrapped multi-line text; single-line keys ignore it.
 */
export function applyKey(state: EditorState, key: Key, cols?: number): EditorState {
  const { text, cursor } = state;

  switch (key.name) {
    case 'char': {
      const char = key.char ?? '';
      return { ...state, text: text.slice(0, cursor) + char + text.slice(cursor), cursor: cursor + char.length };
    }
    case 'paste': {
      const pasted = key.text ?? '';
      if (!pasted) return state;
      return { ...state, text: text.slice(0, cursor) + pasted + text.slice(cursor), cursor: cursor + pasted.length };
    }
    case 'shift-enter':
    case 'alt-enter':
      return { ...state, text: text.slice(0, cursor) + '\n' + text.slice(cursor), cursor: cursor + 1 };
    case 'backspace':
      if (cursor === 0) return state;
      return { ...state, text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
    case 'delete':
      if (cursor >= text.length) return state;
      return { ...state, text: text.slice(0, cursor) + text.slice(cursor + 1) };
    case 'left':
      return { ...state, cursor: Math.max(0, cursor - 1) };
    case 'right':
      return { ...state, cursor: Math.min(text.length, cursor + 1) };
    case 'alt-left':
      return { ...state, cursor: previousWordStart(text, cursor) };
    case 'alt-right':
      return { ...state, cursor: nextWordStart(text, cursor) };
    case 'home':
    case 'ctrl-a':
      return { ...state, cursor: 0 };
    case 'end':
    case 'ctrl-e':
      return { ...state, cursor: text.length };
    case 'ctrl-u':
      return { ...state, text: text.slice(cursor), cursor: 0 };
    case 'ctrl-k':
      return { ...state, text: text.slice(0, cursor) };
    case 'ctrl-w':
    case 'alt-backspace': {
      const start = previousWordStart(text, cursor);
      return { ...state, text: text.slice(0, start) + text.slice(cursor), cursor: start };
    }
    case 'alt-delete': {
      const end = nextWordEnd(text, cursor);
      return { ...state, text: text.slice(0, cursor) + text.slice(end) };
    }
    case 'up':
      // `cols` only arrives when the caller wants in-text cursor movement,
      // not history recall (reducer.ts intercepts up/down itself otherwise).
      if (cols !== undefined) {
        return { ...state, cursor: moveCursorVertical(text, cursor, cols, -1) };
      }
      return recall(state, -1);
    case 'down':
      if (cols !== undefined) {
        return { ...state, cursor: moveCursorVertical(text, cursor, cols, 1) };
      }
      return recall(state, 1);
    default:
      return state;
  }
}

export interface CursorPosition {
  line: number;
  col: number;
}

/**
 * Map an offset into `text` onto (line, col) in `text` wrapped to `cols`.
 *
 * A space or newline that `wrapLines` broke on consumes exactly one source
 * character, but a hard split of an over-long word consumes none — so the
 * caret's column is read from each wrapped line's source `start` rather than
 * by assuming `len + 1` at every boundary, which drifted the caret one column
 * per chop on a pasted URL or file path.
 */
export function cursorPosition(text: string, cursor: number, cols: number): CursorPosition {
  return cursorInLines(wrapLines(text, cols), cursor, text.length);
}

/**
 * Same as `cursorPosition` but from precomputed wrapped lines, so a renderer
 * that already wrapped the text for painting does not pay for a second wrap
 * just to place the caret.
 */
export function cursorInLines(lines: WrapLine[], cursor: number, textLen: number): CursorPosition {
  for (let i = 0; i < lines.length; i++) {
    const { line, start } = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1].start : textLen + 1;
    if (cursor < next) {
      let col = cursor - start;
      if (col < 0) col = 0;
      if (col > line.length) col = line.length;
      return { line: i, col };
    }
  }
  const last = lines[lines.length - 1];
  return { line: lines.length - 1, col: last.line.length };
}

/** Move the cursor up or down one visual (wrapped) line, keeping it at approximately the same column. */
export function moveCursorVertical(text: string, cursor: number, cols: number, direction: 1 | -1): number {
  const lines = wrapLines(text, cols);
  const { line, col } = cursorPosition(text, cursor, cols);

  const targetIndex = line + direction;
  if (targetIndex < 0 || targetIndex >= lines.length) return cursor;

  const target = lines[targetIndex];
  return target.start + Math.min(col, target.line.length);
}

/** Start of the previous whitespace-delimited word, including trailing space. */
function previousWordStart(text: string, cursor: number): number {
  let at = cursor;
  while (at > 0 && /\s/.test(text[at - 1])) at -= 1;
  while (at > 0 && !/\s/.test(text[at - 1])) at -= 1;
  return at;
}

/** Start of the next whitespace-delimited word, or the end of the input. */
function nextWordStart(text: string, cursor: number): number {
  let at = cursor;
  while (at < text.length && !/\s/.test(text[at])) at += 1;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}

/** End of the next word plus adjacent space, for forward word deletion. */
function nextWordEnd(text: string, cursor: number): number {
  let at = cursor;
  if (at < text.length && /\s/.test(text[at])) {
    while (at < text.length && /\s/.test(text[at])) at += 1;
    while (at < text.length && !/\s/.test(text[at])) at += 1;
  } else {
    while (at < text.length && !/\s/.test(text[at])) at += 1;
    while (at < text.length && /\s/.test(text[at])) at += 1;
  }
  return at;
}

/**
 * Move through history by `step`. Index `history.length` is the live draft, so
 * stepping back down past the newest entry restores whatever the user was
 * typing before they started browsing.
 */
function recall(state: EditorState, step: number): EditorState {
  const { history, historyIndex } = state;
  if (history.length === 0) return state;

  const target = Math.max(0, Math.min(history.length, historyIndex + step));
  if (target === historyIndex) return state;

  // Park the draft on the way out so `down` can bring it back.
  const draft = historyIndex === history.length ? state.text : state.draft;
  const text = target === history.length ? draft : history[target];

  return { ...state, text, cursor: text.length, historyIndex: target, draft };
}

/**
 * Accept the current line: it joins the history and the editor resets. Blank
 * lines and immediate repeats are not recorded — they only pad the history.
 */
export function commit(state: EditorState): EditorState {
  const line = state.text.trim();
  const history =
    line && line !== state.history[state.history.length - 1]
      ? [...state.history, line]
      : state.history;

  return { text: '', cursor: 0, history, historyIndex: history.length, draft: '' };
}
