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
 *
 * It answers as string-width does, but asks it only about what is not plain
 * text: a frame measures every row it paints, and string-width walks each one
 * grapheme by grapheme through its emoji and east-asian tables.
 */
export function width(text: string): number {
  const plain = text.includes('\x1b') ? stripAnsi(text) : text;
  if (NARROW_RUN.test(plain)) return plain.length;
  // string-width strips a C1 CSI and what follows it; counted by length, that would be columns.
  if (plain.includes('\x9b')) return stringWidth(plain);
  return mixedWidth(plain);
}

/**
 * Code points string-width measures as one column that never join a neighbour
 * into a grapheme cluster: printable ASCII, Latin-1 and general punctuation,
 * less the few it measures otherwise (soft hyphen, ©, ®, ‼, ⁉).
 */
const NARROW = '\x20-\x7e\u00a0-\u00a8\u00aa-\u00ac\u00af-\u00ff\u2010-\u2027\u2030-\u203b\u203d-\u2048\u204a-\u205e';
const NARROW_RUN = new RegExp(`^[${NARROW}]*$`);
const NARROW_RUNS = new RegExp(`[${NARROW}]{3,}`, 'g');

/**
 * Plain runs counted by their length, the rest measured by string-width. Each
 * measured piece keeps the plain character on either side of it: a keycap's
 * `#`, a letter under a combining mark, or one after a prepended mark belongs
 * to the cluster beside it, while two plain characters in a row never share one.
 */
function mixedWidth(plain: string): number {
  let total = 0;
  let from = 0;
  for (const run of plain.matchAll(NARROW_RUNS)) {
    const start = run.index === 0 ? 0 : run.index + 1;
    const end = run.index + run[0].length === plain.length ? plain.length : run.index + run[0].length - 1;
    if (end <= start) continue;
    total += pieceWidth(plain.slice(from, start)) + end - start;
    from = end;
  }
  return total + pieceWidth(plain.slice(from));
}

/**
 * The pieces left between plain runs are few and short (a status glyph and its
 * spaces, the pane divider), and string-width costs more to call than to run
 * on them: it builds its emoji pattern afresh on every call.
 */
const pieceWidths = new Map<string, number>();
const PIECE_MAX = 16;
const PIECES_HELD = 2048;

function pieceWidth(piece: string): number {
  if (piece === '') return 0;
  if (piece.length > PIECE_MAX || !measureCache.enabled) return stringWidth(piece);
  let known = pieceWidths.get(piece);
  if (known === undefined) {
    if (pieceWidths.size >= PIECES_HELD) pieceWidths.clear();
    known = stringWidth(piece);
    pieceWidths.set(piece, known);
  }
  return known;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Printable ASCII is one column per code unit and never joins a neighbour, so
// the common case skips the segmenter entirely.
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * The grapheme clusters of `text`. A terminal draws `⚠️`, `👨‍👩‍👧` and `é` as a
 * unit, so anything that measures or cuts a row has to treat them as one:
 * walking code points measures `⚠` + VS16 as 1 column and splits a ZWJ emoji.
 */
export function graphemes(text: string): string[] {
  if (PRINTABLE_ASCII.test(text)) return text.split('');
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** The first grapheme cluster of `text`, '' when it is empty. */
export function firstGrapheme(text: string): string {
  if (text === '') return '';
  const code = text.charCodeAt(0);
  if (code < 0x300 && (text.length === 1 || text.charCodeAt(1) < 0x300) && code !== 0x0d) return text[0];
  return segmenter.segment(text).containing(0)?.segment ?? text[0];
}

/** The offset of the cluster boundary before `offset` (0 at the start). */
export function previousBoundary(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const code = text.charCodeAt(offset - 1);
  const before = offset >= 2 ? text.charCodeAt(offset - 2) : 0;
  if (code < 0x300 && before < 0x300 && code !== 0x0a) return offset - 1;
  return segmenter.segment(text.slice(0, offset)).containing(offset - 1)?.index ?? offset - 1;
}

/** The offset of the cluster boundary after `offset` (`text.length` at the end). */
export function nextBoundary(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  return offset + firstGrapheme(text.slice(offset)).length;
}

/** SGR paint: the only escapes a row may carry through a cut. */
// eslint-disable-next-line no-control-regex
const SGR = /^\x1b\[([0-9;]*)m$/;

/** Cut to `max` visible columns, marking the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (width(text) <= max) return text;

  let out = '';
  let used = 0;
  // Whether the retained text ends inside a style. The cut closes it, so a
  // caller appending to the row does not inherit the colour of what was cut.
  let painted = false;
  for (const part of text.split(ESCAPE_SPLIT)) {
    if (part.startsWith('\x1b')) {
      const sgr = SGR.exec(part);
      if (!sgr) continue;
      out += part;
      const codes = sgr[1].split(';').filter(Boolean);
      painted = !(codes.length === 0 || codes.includes('0'));
      continue;
    }
    for (const char of graphemes(part)) {
      const w = stringWidth(char);
      if (used + w > max - 1) return `${out}…${painted ? '\x1b[0m' : ''}`;
      out += char;
      used += w;
    }
  }
  return `${out}…${painted ? '\x1b[0m' : ''}`;
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
  // The SGR sequences in force when the current chunk began. A chunk cut out
  // of a painted word has to carry them again: rows are diffed and written
  // independently, so a continuation row cannot rely on the colour the row
  // above it opened. Escape sequences are measured as zero width — measured
  // like text, a chunk boundary could fall inside `\x1b[0m`, leaving a
  // truncated sequence on one row and its tail printed as text on the next.
  let active: string[] = [];
  const startChunk = (ch: string, w: number): void => {
    chunks.push(cur);
    cur = active.join('') + ch;
    curWidth = w;
  };
  for (const part of piece.split(ESCAPE_SPLIT)) {
    if (part.startsWith('\x1b')) {
      // eslint-disable-next-line no-control-regex
      const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (sgr) {
        const codes = sgr[1].split(';').filter(Boolean);
        if (codes.length === 0 || codes.includes('0')) active = [];
        const opens = codes.filter((code) => code !== '0');
        if (opens.length > 0) active.push(`\x1b[${opens.join(';')}m`);
      }
      cur += part;
      continue;
    }
    for (const ch of graphemes(part)) {
      // Printable ASCII is one column per code unit. A pasted single-line blob
      // is the worst case for this loop, and asking string-width once per
      // character of it costs an order of magnitude more than measuring it.
      const w = PRINTABLE_ASCII.test(ch) ? 1 : stringWidth(ch);
      if (curWidth > 0 && curWidth + w > max) {
        startChunk(ch, w);
      } else {
        cur += ch;
        curWidth += w;
      }
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
 * A memo collapses redundant wraps within a frame and across frames: every
 * task title, status line and chat block is wrapped again on each paint, and
 * the text rarely changed. It is bounded by the text it holds rather than by a
 * count of entries: a plan of hundreds of tasks wraps hundreds of short titles,
 * which a count small enough to bound a pasted blob evicted on every frame.
 * Least recently used goes first (a `Map` keeps insertion order).
 */
const wrapped = new Map<string, WrapLine[]>();
/** UTF-16 units of source text held, each counted twice: once in its key, once in its lines. */
const WRAP_MEMO_UNITS = 1 << 20;
let wrappedUnits = 0;

/** Switches for tests that compare frames with the measuring memos cold, warm and off. */
export const measureCache = {
  enabled: true,
  clear(): void {
    wrapped.clear();
    wrappedUnits = 0;
    pieceWidths.clear();
  },
};

export function wrapLines(text: string, max: number): WrapLine[] {
  if (!measureCache.enabled) return computeWrapLines(text, max);
  const key = `${max}\u0000${text}`;
  const cached = wrapped.get(key);
  if (cached) {
    wrapped.delete(key);
    wrapped.set(key, cached);
    return cached;
  }
  const result = computeWrapLines(text, max);
  const units = 2 * key.length;
  if (units > WRAP_MEMO_UNITS) return result;
  wrappedUnits += units;
  for (const oldest of wrapped.keys()) {
    if (wrappedUnits <= WRAP_MEMO_UNITS) break;
    wrapped.delete(oldest);
    wrappedUnits -= 2 * oldest.length;
  }
  wrapped.set(key, result);
  return result;
}

/**
 * Whether a code unit at a word's edge keeps to its own grapheme cluster when a
 * space is set beside it, so the joined line measures the two widths plus one.
 * A mark or a joiner at a word's start would join the space before it, and a
 * prepended mark (U+0600) at its end the space after it; these ranges hold
 * neither: Latin, CJK ideographs, kana, Hangul syllables, fullwidth forms.
 * Anything else is measured whole, which is never wrong, only slower.
 */
const plainEdge = (code: number): boolean =>
  code < 0x300
  || (code >= 0x3041 && code <= 0x3096)
  || (code >= 0x30a1 && code <= 0x30fa)
  || (code >= 0x4e00 && code <= 0x9fff)
  || (code >= 0xac00 && code <= 0xd7a3)
  || (code >= 0xff01 && code <= 0xff5e);

function computeWrapLines(text: string, max: number): WrapLine[] {
  if (max <= 0) return [{ line: '', start: 0 }];

  const out: WrapLine[] = [];
  let pos = 0; // source offset of the current paragraph's first character
  for (const paragraph of text.split('\n')) {
    // The running width answers for the line only while its end and the next
    // word's start are plain (see `plainEdge`). An escape is measured by
    // stripping, and a cut-off one swallows what follows it, so a painted
    // paragraph is measured whole.
    const painted = paragraph.includes('\x1b');
    // A line of plain text is the source between its first and last word, so
    // it is cut out once as it is emitted rather than grown word by word: a
    // line built of joins is held in the memo as a chain of every word in it.
    // A painted one is built, since a hard split re-opens its colour.
    let current = '';
    let currentStart = pos;
    let currentEnd = pos;
    let currentWidth = 0;
    const line = (): string => (painted ? current : text.slice(currentStart, currentEnd));
    let first = true;
    let plainEnd = true;
    let wordPos = pos; // source offset of the current word's first character
    for (const word of paragraph.split(' ')) {
      let piece = word;
      let pieceStart = wordPos;
      let pieceWidth = width(piece);
      if (pieceWidth > max) {
        const chunks = chopWord(piece, max);
        for (let ci = 0; ci < chunks.length - 1; ci++) {
          const head = chunks[ci];
          if (!first) {
            out.push({ line: line(), start: currentStart });
            current = '';
            currentEnd = currentStart;
          }
          out.push({ line: head, start: pieceStart });
          pieceStart += head.length;
          first = true;
        }
        piece = chunks[chunks.length - 1];
        pieceWidth = width(piece);
      }
      const pieceEnd = wordPos + word.length;
      const candidateWidth = first
        ? pieceWidth
        : !painted && plainEnd && (piece === '' || plainEdge(piece.charCodeAt(0)))
          ? currentWidth + 1 + pieceWidth
          : width(painted ? `${current} ${piece}` : text.slice(currentStart, pieceEnd));
      if (piece !== '') plainEnd = plainEdge(piece.charCodeAt(piece.length - 1));
      if (candidateWidth > max) {
        out.push({ line: line(), start: currentStart });
        current = piece;
        currentStart = pieceStart;
        currentWidth = pieceWidth;
      } else {
        if (painted) current = first ? piece : `${current} ${piece}`;
        if (first) currentStart = pieceStart;
        currentWidth = candidateWidth;
      }
      currentEnd = pieceEnd;
      first = false;
      wordPos = pieceEnd + 1;
    }
    out.push({ line: line(), start: currentStart });
    pos += paragraph.length + 1;
  }
  return out.length > 0 ? out : [{ line: '', start: 0 }];
}

/** Word-wrap to `max` columns, hard-splitting words that cannot fit. */
export function wrap(text: string, max: number): string[] {
  return wrapLines(text, max).map((l) => l.line);
}

/**
 * `text` inside `seq`, with the style re-opened after every reset inside it, so
 * a nested colour or attribute ends only itself and the outer text keeps its
 * own paint. The final reset closes the style once.
 */
function restoring(seq: string, text: string): string {
  return `${seq}${text.split('\x1b[0m').join(`\x1b[0m${seq}`)}\x1b[0m`;
}

function colour(open: string | (() => string)): (text: string) => string {
  return (text: string) => {
    if (!style.enabled) return text;
    return restoring(`\x1b[${typeof open === 'string' ? open : open()}m`, text);
  };
}

/**
 * An SGR attribute that carries state rather than colour — inverse video for
 * a caret or a selected row. `NO_COLOR` asks for no colour, not for these:
 * with the hardware cursor hidden, dropping them leaves nothing marking the
 * insertion point. They are off only when the output is not a terminal at all.
 */
function attribute(open: string): (text: string) => string {
  return (text: string) => (style.attributes ? restoring(`\x1b[${open}m`, text) : text);
}

export interface Rgb { r: number; g: number; b: number }

/** The logo's teal (assets/readme/logo-*.png), and its nearest xterm-256 slot. */
const BRAND: Rgb = { r: 8, g: 145, b: 178 };
const BRAND_256 = 31;

/**
 * What the terminal can paint. Truecolor is read from `COLORTERM`, the only
 * signal terminals agree on; the background is asked of the terminal itself
 * (see terminal.ts) and stays null where it never answers.
 */
export const palette: { truecolor: boolean; background: Rgb | null } = {
  truecolor: /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? ''),
  background: null,
};

const luminance = ({ r, g, b }: Rgb): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** The nearest of xterm-256's 24-step grey ramp, which every 256-colour terminal draws the same. */
const greyRamp = ({ r, g, b }: Rgb): number =>
  232 + Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));

/**
 * The band: the terminal's own background lifted a step toward its text, so it
 * reads as a surface of the theme rather than a fixed grey laid over it — 234
 * was a near-black slab on a light theme and a different hue on a tinted one.
 * Unknown background, the old 234: dark terminals are the common case.
 */
function bandBg(): string {
  const bg = palette.background;
  if (!bg) return '48;5;234';
  const dark = luminance(bg) < 0.5;
  const toward = dark ? 255 : 0;
  const amount = dark ? 0.07 : 0.05;
  const mix = (c: number) => Math.round(c + (toward - c) * amount);
  const lifted = { r: mix(bg.r), g: mix(bg.g), b: mix(bg.b) };
  return palette.truecolor ? `48;2;${lifted.r};${lifted.g};${lifted.b}` : `48;5;${greyRamp(lifted)}`;
}

/** SGR 0 inside banded text, re-opening the band after it so a reset mid-row does not end the band. */
const reBand = (text: string): string => {
  const bg = `\x1b[${bandBg()}m`;
  return `${bg}${text.split('\x1b[0m').join(`\x1b[0m${bg}`)}\x1b[0m`;
};

export const style = {
  /** Set false when the output is piped or the terminal has no colour. */
  enabled: true,
  /** Set false only when the output is not a terminal; see `attribute`. */
  attributes: true,
  bold: colour('1'),
  dim: colour('2'),
  italic: colour('3'),
  underline: colour('4'),
  strike: colour('9'),
  inverse: attribute('7'),
  red: colour('31'),
  green: colour('32'),
  yellow: colour('33'),
  blue: colour('34'),
  magenta: colour('35'),
  cyan: colour('36'),
  grey: colour('90'),
  /**
   * The task view's accent: a bright blue, separate from the planner chat's
   * cyan and magenta. Bright rather than the plain 34, which reads as black on
   * a dark background.
   */
  accent: colour('94'),
  /** Ordewell's one accent, the logo's teal: marks, carets and headings — never a status. */
  brand: colour(() => (palette.truecolor ? `38;2;${BRAND.r};${BRAND.g};${BRAND.b}` : `38;5;${BRAND_256}`)),
  /**
   * A list's active row, drawn as a bar. Inverse is re-asserted after every
   * reset inside, or the first painted word in the row would end the bar.
   */
  highlight: (text: string): string =>
    (style.attributes ? `\x1b[7m${text.split('\x1b[0m').join('\x1b[0m\x1b[7m')}\x1b[0m` : text),
  /**
   * The band the user's own messages and the composer sit on (see `bandBg`).
   * The background is re-asserted after every reset inside, or the `❯` and a
   * skill token would end the band partway along the row.
   */
  band: (text: string): string => (style.enabled ? reBand(text) : text),
  /**
   * Quiet text for use on the band. Bright black (`grey`) is a theme's own
   * background in some palettes and sits close to the band's, so hints and the
   * blurred prompt would sink into it; a fixed mid grey stays readable on both.
   */
  bandGrey: colour('38;5;245'),
};
