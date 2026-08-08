import { stripTabs } from './ansi';

export interface Key {
  name: string;
  /** Only set for `name: 'char'` — the literal text the user typed. */
  char?: string;
  /** Only set for `name: 'paste'` — a whole bracketed paste, line endings normalized. */
  text?: string;
  /** Only set for wheel keys — the 1-based cell the pointer was over. */
  col?: number;
  row?: number;
}

const CONTROL: Record<string, string> = {
  '\r': 'enter',
  '\n': 'enter',
  '\t': 'tab',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\x1b': 'escape',
  '\x01': 'ctrl-a',
  '\x03': 'ctrl-c',
  '\x04': 'ctrl-d',
  '\x05': 'ctrl-e',
  '\x0b': 'ctrl-k',
  '\x0c': 'ctrl-l',
  '\x0e': 'ctrl-n',
  '\x10': 'ctrl-p',
  '\x15': 'ctrl-u',
  '\x17': 'ctrl-w',
};

const ESCAPES: Record<string, string> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1bOH': 'home',
  '\x1bOF': 'end',
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[3~': 'delete',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[Z': 'shift-tab',
  // xterm-style Alt modifier (3), used by most Linux terminals.
  '\x1b[1;3C': 'alt-right',
  '\x1b[1;3D': 'alt-left',
  '\x1b[3;3~': 'alt-delete',
  // Common rxvt/macOS configurations.
  '\x1b[3C': 'alt-right',
  '\x1b[3D': 'alt-left',
  '\x1bf': 'alt-right',
  '\x1bb': 'alt-left',
  '\x1bd': 'alt-delete',
  '\x1b\x7f': 'alt-backspace',
  '\x1b\b': 'alt-backspace',
  '\x1b\x1b[C': 'alt-right',
  '\x1b\x1b[D': 'alt-left',
  // Shift+Enter: SS3 form used by many terminfo entries, and the CSI form
  // xterm sends under modifyOtherKeys=2 or the Kitty keyboard protocol
  // (see terminal.ts). Plain VTE-based terminals (GNOME Terminal, Konsole,
  // xterm, Terminator) support neither, so Shift+Enter there is byte-for-byte
  // identical to Enter — Alt+Enter below is the one that actually works
  // everywhere, since "Meta sends escape" is universal.
  '\x1bOM': 'shift-enter',
  '\x1b[2;2~': 'shift-enter',
  '\x1b[13;2u': 'shift-enter',
  '\x1b[13;2~': 'shift-enter',
  // Alt+Enter: ESC followed by the plain Enter byte.
  '\x1b\r': 'alt-enter',
  '\x1b\n': 'alt-enter',
};

// Decode wheel reports. Only arrive while mouse capture is on — see terminal.ts.
//
// A button byte is a bit field, not an enum: 64 marks the wheel, the low two
// bits pick the direction, and shift (4), alt (8), ctrl (16) and the motion
// flag (32) ride on top. Comparing the whole number against 64/65 therefore
// dropped every Shift/Alt/Ctrl+wheel notch and every report a terminal chose to
// tag as motion — masking is what makes the wheel work regardless of which
// modifiers happen to be held.
const WHEEL_FLAG = 64;
const BUTTON_MASK = 0b11;
const MOUSE_MODIFIERS = 4 | 8 | 16 | 32;

function wheelKey(button: number, col: number, row: number): Key {
  if ((button & WHEEL_FLAG) === 0) return { name: 'unknown' };
  switch (button & ~MOUSE_MODIFIERS & (WHEEL_FLAG | BUTTON_MASK)) {
    case WHEEL_FLAG: return { name: 'scrollup', col, row };
    case WHEEL_FLAG | 1: return { name: 'scrolldown', col, row };
    // 66/67 are the horizontal wheel. Nothing here scrolls sideways, so they
    // are dropped on purpose rather than falling through to `unknown`, which
    // the overlays treat as "some key" and would use to close themselves.
    default: return { name: 'wheelignored' };
  }
}

// The three encodings a terminal might use, in the order they are worth
// trying: SGR (1006) is what terminal.ts asks for, urxvt (1015) is what some
// builds answer with instead, and X10 is the unnegotiated fallback every
// terminal understands — tmux forwards it verbatim when 1006 is not honored.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/;
// eslint-disable-next-line no-control-regex
const URXVT_MOUSE = /^\x1b\[(\d+);(\d+);(\d+)M$/;
const X10_PREFIX = '\x1b[M';
/** X10 packs button, column and row as single bytes biased by 32. */
const X10_BIAS = 32;

function decodeMouse(seq: string): Key | undefined {
  const sgr = SGR_MOUSE.exec(seq);
  if (sgr) return wheelKey(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]));

  const urxvt = URXVT_MOUSE.exec(seq);
  if (urxvt) return wheelKey(Number(urxvt[1]) - X10_BIAS, Number(urxvt[2]), Number(urxvt[3]));

  if (seq.startsWith(X10_PREFIX) && seq.length === X10_PREFIX.length + 3) {
    const bytes = [0, 1, 2].map((n) => seq.charCodeAt(X10_PREFIX.length + n) - X10_BIAS);
    return wheelKey(bytes[0], bytes[1], bytes[2]);
  }

  return undefined;
}

/**
 * One raw stdin chunk to one key event. Unrecognised escape sequences become
 * `unknown` rather than `char` so stray terminal reports (bracketed paste,
 * mouse, cursor position) never leak into the input buffer as garbage text.
 */
export function decodeKey(seq: string): Key {
  const escaped = ESCAPES[seq];
  if (escaped) return { name: escaped };

  const control = CONTROL[seq];
  if (control) return { name: control };

  if (seq.startsWith('\x1b[')) {
    const mouse = decodeMouse(seq);
    if (mouse) return mouse;
  }

  if (seq.startsWith('\x1b')) return { name: 'unknown' };

  return { name: 'char', char: seq };
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Everything between the bracketed-paste markers is data, never keystrokes —
 * that is the whole point of the mode: a pasted newline must not act as enter.
 * Line endings are normalized and remaining control characters dropped so a
 * malicious paste cannot smuggle escape sequences into the editor either. Tabs
 * are normalized rather than dropped with the rest — see `stripTabs` — since a
 * dropped tab still glues the words on either side of it together.
 */
function pasteKey(raw: string): Key {
  // eslint-disable-next-line no-control-regex
  const text = stripTabs(raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''));
  return { name: 'paste', text };
}

/**
 * A stateful chunk decoder: like `splitKeys`, but aware of bracketed paste,
 * which can span many stdin chunks — the state is the paste collected so far,
 * carried until the end marker arrives (even split across two chunks).
 */
export function createKeyDecoder(): (chunk: string) => Key[] {
  let paste: string | null = null;
  let pending = '';

  return (chunk) => {
    const keys: Key[] = [];
    let rest = pending + chunk;
    pending = '';

    while (rest.length > 0) {
      if (paste !== null) {
        const combined = paste + rest;
        const end = combined.indexOf(PASTE_END);
        if (end === -1) {
          paste = combined;
          return keys;
        }
        keys.push(pasteKey(combined.slice(0, end)));
        paste = null;
        rest = combined.slice(end + PASTE_END.length);
        continue;
      }

      const start = rest.indexOf(PASTE_START);
      if (start === -1) {
        const split = splitPending(rest);
        keys.push(...split.keys);
        pending = split.pending;
        return keys;
      }
      if (start > 0) keys.push(...splitKeys(rest.slice(0, start)));
      paste = '';
      rest = rest.slice(start + PASTE_START.length);
    }

    return keys;
  };
}

/** Meta-letter, Meta-Backspace and Meta-Enter are two-byte sequences. */
const TWO_BYTE_META = new Set(['b', 'd', 'f', '\x7f', '\b', '\r', '\n']);

/** Parameter and intermediate bytes of a CSI, everything before its final byte. */
// eslint-disable-next-line no-control-regex
const CSI_BODY = /[\x20-\x3f]/;
const CSI_FINAL = /[@-~]/;

/**
 * How far a partial sequence is worth waiting for. A lone ESC the user pressed
 * looks exactly like the start of one, so an unbounded wait would swallow the
 * escape key until the next keystroke arrived to flush it.
 */
const MAX_PENDING = 32;

/** Sentinel from `sequenceEnd`: the chunk ran out mid-sequence. */
const INCOMPLETE = -1;

function csiEnd(chars: string[], start: number, from: number): number {
  let end = from;
  while (end < chars.length && !CSI_FINAL.test(chars[end])) {
    // A byte outside the parameter range cannot belong to this sequence, so
    // there is no final byte coming: stop here rather than wait for one.
    if (!CSI_BODY.test(chars[end])) return end;
    end += 1;
  }
  if (end >= chars.length) return end - start >= MAX_PENDING ? end : INCOMPLETE;
  return end + 1;
}

/**
 * Where the escape sequence starting at `i` ends, or `INCOMPLETE` when the
 * chunk stops partway through one. CSI/SS3 sequences run until a final byte in
 * the @–~ range; anything else after ESC is a lone escape key.
 */
function sequenceEnd(chars: string[], i: number): number {
  const next = chars[i + 1];
  if (next === undefined) return i + 1;

  if (next === '[' && chars[i + 2] === 'M') {
    // The one CSI whose length is not delimited: `M` is its final byte, and
    // the three coordinate bytes after it are data, not keystrokes. Ending
    // the sequence at `M` typed them into the editor instead.
    return i + X10_PREFIX.length + 3 <= chars.length ? i + X10_PREFIX.length + 3 : INCOMPLETE;
  }
  if (next === '[' || next === 'O') return csiEnd(chars, i, i + 2);
  if (TWO_BYTE_META.has(next)) return i + 2;
  // Some terminals encode Alt+Arrow as ESC followed by a normal arrow.
  if (next === '\x1b' && (chars[i + 2] === '[' || chars[i + 2] === 'O')) return csiEnd(chars, i, i + 3);
  return i + 1;
}

/**
 * The shared scan behind both `splitKeys` and the stateful decoder: keys, plus
 * whatever trailing bytes are the start of a sequence the chunk cut short.
 */
function splitPending(chunk: string): { keys: Key[]; pending: string } {
  const keys: Key[] = [];
  const chars = [...chunk];
  let i = 0;

  while (i < chars.length) {
    if (chars[i] !== '\x1b') {
      keys.push(decodeKey(chars[i]));
      i += 1;
      continue;
    }

    const end = sequenceEnd(chars, i);
    if (end === INCOMPLETE) return { keys, pending: chars.slice(i).join('') };
    keys.push(decodeKey(chars.slice(i, end).join('')));
    i = end;
  }

  return { keys, pending: '' };
}

/**
 * Split one raw stdin chunk into keys. A chunk can hold several keystrokes — a
 * fast typist, a held arrow key, or a paste — and an escape sequence must stay
 * whole or its letters would be typed into the input as `[A`.
 *
 * Stateless, so a chunk that ends mid-sequence has no next chunk to wait for:
 * the truncated tail is decoded now, which makes it `unknown` rather than
 * letters in the editor. `createKeyDecoder` is the one that can wait.
 */
export function splitKeys(chunk: string): Key[] {
  const { keys, pending } = splitPending(chunk);
  if (pending) keys.push(decodeKey(pending));
  return keys;
}
