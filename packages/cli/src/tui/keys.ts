export interface Key {
  name: string;
  /** Only set for `name: 'char'` — the literal text the user typed. */
  char?: string;
  /** Only set for `name: 'paste'` — a whole bracketed paste, line endings normalized. */
  text?: string;
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

// Decode SGR wheel reports (see terminal.ts for why mouse tracking is on).
const MOUSE_WHEEL_UP = 64;
const MOUSE_WHEEL_DOWN = 65;
// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

function decodeMouse(seq: string): Key | undefined {
  const match = SGR_MOUSE.exec(seq);
  if (!match) return undefined;
  const button = Number(match[1]);
  if (button === MOUSE_WHEEL_UP) return { name: 'scrollup' };
  if (button === MOUSE_WHEEL_DOWN) return { name: 'scrolldown' };
  return { name: 'unknown' };
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

  if (seq.startsWith('\x1b[<')) return decodeMouse(seq) ?? { name: 'unknown' };

  if (seq.startsWith('\x1b')) return { name: 'unknown' };

  return { name: 'char', char: seq };
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Everything between the bracketed-paste markers is data, never keystrokes —
 * that is the whole point of the mode: a pasted newline must not act as enter.
 * Line endings are normalized and remaining control characters dropped so a
 * malicious paste cannot smuggle escape sequences into the editor either.
 */
function pasteKey(raw: string): Key {
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return { name: 'paste', text };
}

/**
 * A stateful chunk decoder: like `splitKeys`, but aware of bracketed paste,
 * which can span many stdin chunks — the state is the paste collected so far,
 * carried until the end marker arrives (even split across two chunks).
 */
export function createKeyDecoder(): (chunk: string) => Key[] {
  let paste: string | null = null;

  return (chunk) => {
    const keys: Key[] = [];
    let rest = chunk;

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
        keys.push(...splitKeys(rest));
        return keys;
      }
      if (start > 0) keys.push(...splitKeys(rest.slice(0, start)));
      paste = '';
      rest = rest.slice(start + PASTE_START.length);
    }

    return keys;
  };
}

/**
 * Split one raw stdin chunk into keys. A chunk can hold several keystrokes — a
 * fast typist, a held arrow key, or a paste — and an escape sequence must stay
 * whole or its letters would be typed into the input as `[A`.
 */
export function splitKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  const chars = [...chunk];
  let i = 0;

  while (i < chars.length) {
    if (chars[i] !== '\x1b') {
      keys.push(decodeKey(chars[i]));
      i += 1;
      continue;
    }

    // CSI/SS3 sequences run until a final byte in the @–~ range; anything else
    // after ESC is a lone escape key.
    let end = i + 1;
    if (chars[end] === '[' || chars[end] === 'O') {
      end += 1;
      while (end < chars.length && !/[@-~]/.test(chars[end])) end += 1;
      end += 1;
    } else if (
      chars[end] === 'b' ||
      chars[end] === 'd' ||
      chars[end] === 'f' ||
      chars[end] === '\x7f' ||
      chars[end] === '\b' ||
      chars[end] === '\r' ||
      chars[end] === '\n'
    ) {
      // Meta-letter, Meta-Backspace and Meta-Enter are two-byte sequences.
      end += 1;
    } else if (
      chars[end] === '\x1b' &&
      (chars[end + 1] === '[' || chars[end + 1] === 'O')
    ) {
      // Some terminals encode Alt+Arrow as ESC followed by a normal arrow.
      end += 2;
      while (end < chars.length && !/[@-~]/.test(chars[end])) end += 1;
      end += 1;
    }
    keys.push(decodeKey(chars.slice(i, end).join('')));
    i = end;
  }

  return keys;
}
