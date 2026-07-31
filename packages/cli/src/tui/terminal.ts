import { style } from './ansi';
import { createKeyDecoder, type Key } from './keys';

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// Bracketed paste: the terminal wraps pastes in markers instead of replaying
// them as keystrokes, so a pasted newline cannot submit the input.
const PASTE_MODE_ON = '\x1b[?2004h';
const PASTE_MODE_OFF = '\x1b[?2004l';
// Kitty keyboard protocol "disambiguate" flag: without it, most terminals send
// Shift+Enter as the same bytes as plain Enter. Supporting terminals then emit
// the CSI-u form keys.ts decodes; others just ignore the unrecognized CSI.
const KITTY_KEYBOARD_ON = '\x1b[>1u';
const KITTY_KEYBOARD_OFF = '\x1b[<u';
// Normal tracking (1000) reports button/wheel events; SGR encoding (1006) is
// the format keys.ts's decodeMouse expects. Native click-drag text selection
// still works — hold Shift while dragging, the standard escape hatch every
// terminal offers once an app captures the mouse (vim, tmux, htop, ...).
const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_TRACKING_OFF = '\x1b[?1000l\x1b[?1006l';
const HOME = '\x1b[H';
const CLEAR = '\x1b[2J';

export interface TerminalOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  onKey(key: Key): void;
  onResize(rows: number, cols: number): void;
}

export interface Terminal {
  size(): { rows: number; cols: number };
  draw(frame: string[]): void;
  close(): void;
}

/**
 * Raw-mode terminal I/O: the alternate screen, keystroke decoding and resize
 * notifications. Everything above this file is pure, so this is the only piece
 * that touches the real tty.
 */
export function openTerminal(options: TerminalOptions): Terminal {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  style.enabled = output.isTTY === true && process.env.NO_COLOR === undefined;

  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  output.write(
    ALT_SCREEN_ON + HIDE_CURSOR + PASTE_MODE_ON + KITTY_KEYBOARD_ON + MOUSE_TRACKING_ON + CLEAR,
  );

  const decode = createKeyDecoder();
  const onData = (chunk: string) => {
    for (const key of decode(chunk)) options.onKey(key);
  };
  const onResize = () => {
    // A shrink leaves glyphs beyond the new frame that home-and-overwrite
    // never touches; start the next draw from a clean screen.
    output.write(CLEAR);
    const { rows, cols } = size();
    options.onResize(rows, cols);
  };

  input.on('data', onData);
  output.on('resize', onResize);

  function size(): { rows: number; cols: number } {
    return { rows: output.rows || 24, cols: output.columns || 80 };
  }

  let closed = false;

  return {
    size,
    draw(frame) {
      if (closed) return;
      // Home-and-overwrite rather than clear-and-redraw: clearing first makes
      // the whole screen flicker on every keystroke.
      output.write(HOME + frame.join('\n'));
    },
    close() {
      if (closed) return;
      closed = true;
      input.off('data', onData);
      output.off('resize', onResize);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write(
        MOUSE_TRACKING_OFF + KITTY_KEYBOARD_OFF + PASTE_MODE_OFF + SHOW_CURSOR + ALT_SCREEN_OFF,
      );
    },
  };
}
