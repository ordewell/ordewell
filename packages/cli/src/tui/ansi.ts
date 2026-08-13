import stringWidth from 'string-width';

/**
 * Any escape sequence, not just the colour ones this file writes. The
 * alternatives are ordered longest-form first because `]`, `P`, `^`, `_` and
 * `[` all also match the catch-all tail:
 *
 * - `ESC ] … BEL|ST` — OSC (window title, OSC 52 clipboard). An unterminated
 *   one runs to the end of the text, which is what a real terminal does with it.
 * - `ESC P|^|_ … ST` — DCS, PM and APC strings.
 * - `ESC [ … final` — CSI: cursor moves, erases, colour.
 * - anything else — two-character forms (`ESC ( B`, `ESC =`) and a lone ESC.
 */
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\|$)|[P^_][\s\S]*?(?:\x1b\\|$)|\[[0-?]*[ -/]*[@-~]?|[ -/]*[0-~]?)/g;

/** The same, capturing, so `split` hands the escapes back alongside the text. */
const ESCAPE_SPLIT = new RegExp(`(${ESCAPE.source})`);

/**
 * Every C0 control except tab and newline, DEL, and the C1 block — which a
 * terminal in an 8-bit mode reads as escape sequence introducers.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** As above but tab and newline too: neither has a meaning inside a painted row. */
// eslint-disable-next-line no-control-regex
const CONTROL_IN_ROW = /[\x00-\x1f\x7f-\x9f]/g;
/** Untainted by `lastIndex`, so it can answer `paintOnly`'s fast path. */
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/** The escapes a painted frame is allowed to carry — see `paintOnly`. */
// eslint-disable-next-line no-control-regex
const PAINT_ESCAPE = /^\x1b\[[0-9;]*[mGK]$/;

export function stripAnsi(text: string): string {
  return text.replace(ESCAPE, '');
}

/**
 * Text from anywhere but this package, made safe to lay out and paint.
 *
 * Everything the TUI shows that it did not write itself — a planner turn, a
 * research result, a task title, a runner's error — reaches it as whatever the
 * coding agent or model emitted, and that routinely carries terminal control
 * codes: a BEL, a progress bar's carriage returns, an unclosed colour, the
 * cursor moves and erases a spinner redraws itself with.
 *
 * Left in, none of it is text. `width()` measures it as zero columns because
 * the terminal does not *print* it — it *acts* on it: `ESC [ 10 C` shifts the
 * rest of the row (the pane divider with it) ten columns right, `ESC [ 2 K`
 * wipes the row the plan pane was about to be painted on, a lone `ESC [ 31 m`
 * bleeds red over every row below, and a BEL rings the terminal — once per
 * frame, which during a run is every 120ms.
 *
 * So it is dropped at the door rather than fought with downstream: tabs and CR
 * normalize (a tab is eight columns wide on screen and zero to `width()`),
 * newlines survive because wrapping is built on them, and nothing else that
 * isn't a printable character gets through.
 */
export function sanitize(text: string): string {
  return text
    .replace(ESCAPE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '');
}

/**
 * One painted row with everything but this package's own paint removed: the
 * colour it wrote, and the two escapes the pane split is anchored with.
 *
 * `sanitize` is the fix; this is the belt. It sits at the one point every byte
 * bound for the tty passes through, so a field that grows a new source of
 * untrusted text later cannot ring the bell or move the cursor — it can only
 * paint the wrong-looking row.
 */
export function paintOnly(line: string): string {
  if (!HAS_CONTROL.test(line)) return line;
  return line
    .split(ESCAPE_SPLIT)
    .map((piece) =>
      piece.startsWith('\x1b')
        ? (PAINT_ESCAPE.test(piece) ? piece : '')
        : piece.replace(CONTROL_IN_ROW, ''))
    .join('');
}

/**
 * Terminals render CJK, emoji and similar glyphs two columns wide. Getting this
 * wrong shifts every column to the right of it, so layout measures with this
 * rather than `String.length`.
 */
export function width(text: string): number {
  return stringWidth(stripAnsi(text));
}

/** Cut to `max` visible columns, marking the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (width(text) <= max) return text;

  let out = '';
  let used = 0;
  for (const char of stripAnsi(text)) {
    const w = stringWidth(char);
    if (used + w > max - 1) break;
    out += char;
    used += w;
  }
  return out + '…';
}

export function pad(text: string, target: number): string {
  const current = width(text);
  if (current > target) return truncate(text, target);
  return text + ' '.repeat(target - current);
}

export interface WrapLine {
  line: string;
  /** Source-text offset where this wrapped line's first character came from. */
  start: number;
}

/**
 * Split an over-long word into `max`-width pieces in a single left-to-right
 * pass. A glyph wider than `max` (some emoji) stands as its own chunk so the
 * loop always makes progress — the earlier `truncate`-then-`slice` loop
 * re-measured the whole remainder on every step and was O(n²) on a pasted
 * blob, which froze the editor for seconds per keystroke.
 */
function chopWord(piece: string, max: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  let curWidth = 0;
  for (const ch of piece) {
    const w = stringWidth(ch);
    if (cur && curWidth + w > max) {
      chunks.push(cur);
      cur = ch;
      curWidth = w;
    } else {
      cur += ch;
      curWidth += w;
    }
  }
  chunks.push(cur);
  return chunks;
}

/**
 * Word-wrap to `max` columns, hard-splitting words that cannot fit, while
 * tracking the source offset where each emitted line begins. A space or
 * newline break consumes one source character; a hard split consumes none —
 * `cursorPosition` needs that distinction to place the caret after a chop.
 *
 * A small LRU cache collapses redundant wraps within a frame and across
 * spinner ticks. A single render wraps 6+ different texts (each task title,
 * the chat editor, the expanded prompt); the old single-slot memo evicted
 * each on the next call, so nothing was ever reused. Task titles and the
 * prompt editor text are immutable across a spinner tick, so a modest Map
 * lets every wrap hit the cache between frames — which is what makes
 * scrolling an expanded task feel instant.
 */
const wrapMemo = new Map<string, WrapLine[]>();
const WRAP_MEMO_MAX = 64;

export function wrapLines(text: string, max: number): WrapLine[] {
  const key = `${max}\u0000${text}`;
  const cached = wrapMemo.get(key);
  if (cached) {
    // Move to most-recently-used position (Map preserves insertion order).
    wrapMemo.delete(key);
    wrapMemo.set(key, cached);
    return cached;
  }
  const result = computeWrapLines(text, max);
  if (wrapMemo.size >= WRAP_MEMO_MAX) {
    const oldest = wrapMemo.keys().next().value;
    if (oldest !== undefined) wrapMemo.delete(oldest);
  }
  wrapMemo.set(key, result);
  return result;
}

function computeWrapLines(text: string, max: number): WrapLine[] {
  if (max <= 0) return [{ line: '', start: 0 }];

  const out: WrapLine[] = [];
  let pos = 0; // source offset of the current paragraph's first character
  for (const paragraph of text.split('\n')) {
    let current = '';
    let currentStart = pos;
    let first = true;
    let wordPos = pos; // source offset of the current word's first character
    for (const word of paragraph.split(' ')) {
      let piece = word;
      let pieceStart = wordPos;
      if (width(piece) > max) {
        const chunks = chopWord(piece, max);
        for (let ci = 0; ci < chunks.length - 1; ci++) {
          const head = chunks[ci];
          if (!first) { out.push({ line: current, start: currentStart }); current = ''; }
          out.push({ line: head, start: pieceStart });
          pieceStart += head.length;
          first = true;
        }
        piece = chunks[chunks.length - 1];
      }
      const candidate = first ? piece : `${current} ${piece}`;
      const candidateStart = first ? pieceStart : currentStart;
      first = false;
      if (width(candidate) > max) {
        out.push({ line: current, start: currentStart });
        current = piece;
        currentStart = pieceStart;
      } else {
        current = candidate;
        currentStart = candidateStart;
      }
      wordPos += word.length + 1;
    }
    out.push({ line: current, start: currentStart });
    pos += paragraph.length + 1;
  }
  return out.length > 0 ? out : [{ line: '', start: 0 }];
}

/** Word-wrap to `max` columns, hard-splitting words that cannot fit. */
export function wrap(text: string, max: number): string[] {
  return wrapLines(text, max).map((l) => l.line);
}

function colour(open: string): (text: string) => string {
  return (text: string) => (style.enabled ? `\x1b[${open}m${text}\x1b[0m` : text);
}

export const style = {
  /** Set false when the output is piped or the terminal has no colour. */
  enabled: true,
  bold: colour('1'),
  dim: colour('2'),
  italic: colour('3'),
  underline: colour('4'),
  inverse: colour('7'),
  red: colour('31'),
  green: colour('32'),
  yellow: colour('33'),
  blue: colour('34'),
  magenta: colour('35'),
  cyan: colour('36'),
  grey: colour('90'),
};
