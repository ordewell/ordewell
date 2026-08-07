import { style, truncate, width } from './ansi';
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
// the format keys.ts's decodeMouse expects. Off by default, and that is the
// whole point: an app that captures the mouse takes drag-select with it, and
// Shift+drag is not the universal escape hatch it is often claimed to be
// (Terminal.app wants Fn, iTerm2 Option, tmux swallows it first). Copying text
// out of the transcript matters more here than a three-line wheel notch, so the
// wheel is opt-in via `/mouse on`.
const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_TRACKING_OFF = '\x1b[?1000l\x1b[?1006l';
// Alternate scroll (1007) makes the terminal fake arrow keys for the wheel
// while the alt screen is up. With the mouse uncaptured that would land on the
// line editor, so a scroll would silently replace the draft with a history
// entry. Saved and restored rather than just cleared — it is a global DEC mode,
// and leaving it off would change how the user's pager scrolls after we quit.
const ALT_SCROLL_SAVE = '\x1b[?1007s';
const ALT_SCROLL_OFF = '\x1b[?1007l';
const ALT_SCROLL_RESTORE = '\x1b[?1007r';
const CLEAR = '\x1b[2J';
// DECAWM. Off for the duration of a draw so a row `render()` measured as
// exactly `cols` wide, but that the real terminal renders wider (an emoji, ZWJ
// sequence or CJK cluster it counts differently than `width()` does), gets
// clipped at the margin instead of wrapping and pushing every row below it
// down by one line — that shove, not a transient glitch, is what breaks the
// pane divider on paste. Bracketed per draw, not left off for the session, so
// nothing else writing to this tty (a shelled-out task terminal) inherits it.
const AUTOWRAP_OFF = '\x1b[?7l';
const AUTOWRAP_ON = '\x1b[?7h';

export interface TerminalOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Capture the mouse for wheel scrolling, at the cost of drag-select. Off unless asked for. */
  mouse?: boolean;
  onKey(key: Key): void;
  onResize(rows: number, cols: number): void;
}

export interface Terminal {
  size(): { rows: number; cols: number };
  draw(frame: string[]): void;
  /** Trade drag-select for wheel scrolling, or take it back. */
  setMouse(enabled: boolean): void;
  close(): void;
}

/**
 * Last-resort clamp: `render()` already sizes every row to `cols` via
 * `width()`, but that is the same measurement the real terminal might
 * disagree with. One clamp here, rather than one at every render call site,
 * catches whatever `width()` still under-measured before it reaches the tty.
 */
function clampToCols(line: string, cols: number): string {
  return width(line) > cols ? truncate(line, cols) : line;
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

  let mouse = options.mouse === true;

  output.write(
    ALT_SCREEN_ON + HIDE_CURSOR + PASTE_MODE_ON + KITTY_KEYBOARD_ON +
    ALT_SCROLL_SAVE + ALT_SCROLL_OFF + (mouse ? MOUSE_TRACKING_ON : '') + CLEAR,
  );

  const decode = createKeyDecoder();
  const onData = (chunk: string) => {
    for (const key of decode(chunk)) options.onKey(key);
  };
  const onResize = () => {
    // A shrink leaves glyphs beyond the new frame that row-anchored erase
    // never touches (it only erases within each row the new frame writes);
    // start the next draw from a clean screen.
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
      // Row-anchored rather than home-and-blit: each row is positioned
      // absolutely and erased to end of line, so a row that renders wider
      // than measured only misplaces itself instead of shoving every row
      // below it down by one line. Still not clear-and-redraw — that makes
      // the whole screen flicker on every keystroke — each row is erased,
      // not the frame.
      const { cols } = size();
      const rows = frame
        .map((line, i) => `\x1b[${i + 1};1H${clampToCols(line, cols)}\x1b[K`)
        .join('');
      output.write(AUTOWRAP_OFF + rows + AUTOWRAP_ON);
    },
    setMouse(enabled) {
      if (closed || enabled === mouse) return;
      mouse = enabled;
      output.write(enabled ? MOUSE_TRACKING_ON : MOUSE_TRACKING_OFF);
    },
    close() {
      if (closed) return;
      closed = true;
      input.off('data', onData);
      output.off('resize', onResize);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      // AUTOWRAP_ON here too, not just after each draw: a signal can land
      // between the AUTOWRAP_OFF and AUTOWRAP_ON of an in-flight draw if the
      // frame is large enough to split across OS writes.
      output.write(
        MOUSE_TRACKING_OFF + ALT_SCROLL_RESTORE + KITTY_KEYBOARD_OFF + PASTE_MODE_OFF + AUTOWRAP_ON + SHOW_CURSOR + ALT_SCREEN_OFF,
      );
    },
  };
}
