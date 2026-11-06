import { paintOnly, palette, style, truncate, width, type Rgb } from './ansi';
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
// Normal tracking (1000) reports button/wheel events; button-event tracking
// (1002) adds motion reports, but only while a button is held — which is what a
// drag is, and the reason 1003 (any-motion) is not used: it would put an event
// on stdin for every cell the pointer crosses, held or not. SGR encoding (1006)
// is the format keys.ts's decodeMouse prefers, though it decodes the X10 and
// urxvt forms a terminal may answer with instead.
//
// On by default. It was opt-in for a while, on the grounds that capturing the
// mouse takes the terminal's own drag-select with it and Shift+drag is not the
// universal escape hatch it is claimed to be (Terminal.app wants Fn, iTerm2
// Option, tmux swallows it first). What sank that was where the opt-in lived:
// `ORDEWELL_TUI_MOUSE` in the workspace `.env`, so the wheel came back dead in
// every other project and read as the TUI randomly ignoring the mouse. `/mouse
// off` is the escape hatch for a session where selecting text matters more.
//
// Written only while raw mode is on. Windows' pseudo console passes a change to
// these modes on to the terminal only while the console reads VT input, which
// is what raw mode turns on there, and drops it otherwise (measured, ADR-0010):
// off after raw mode left the terminal reporting the mouse to the shell, and on
// before it left the wheel dead after a login.
const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_TRACKING_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';
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
// OSC 11: ask for the background colour, which the band is mixed from. A
// terminal that does not know it stays silent, so nothing waits on the reply.
const BACKGROUND_QUERY = '\x1b]11;?\x1b\\';
// eslint-disable-next-line no-control-regex
const BACKGROUND_REPLY = /\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?(?:\x07|\x1b\\)/i;

/**
 * Whether this Node's raw mode has the Windows console read VT input, which is
 * what carries mouse reports and bracketed-paste markers to the TUI there:
 * Node 22.17 and 24.2 onward (nodejs/node#58358). Before it, the console drops
 * the request for mouse reports and strips the paste markers (measured on Node
 * 20.20.2, ADR-0010). Node 23 never had it.
 */
export function rawModeReadsVtOnWindows(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  if (major === 22) return minor >= 17;
  if (major === 24) return minor >= 2;
  return major >= 25;
}

/** Said once at start on a Windows Node whose raw mode does not read VT input; null anywhere else. */
export function windowsInputNotice(platform: NodeJS.Platform = process.platform, version: string = process.version): string | null {
  if (platform !== 'win32' || rawModeReadsVtOnWindows(version)) return null;
  return `Node ${version} does not pass the mouse or a bracketed paste to the terminal UI on Windows: the wheel does nothing, and a line break in a paste sends the line. Node 22.17 or newer passes both.`;
}

/** Each channel of an `rgb:` reply is 1–4 hex digits wide, scaled to its own width. */
const channel = (hex: string): number => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);

/** The reply to `BACKGROUND_QUERY` cut out of a chunk of input, so the key decoder never sees it. */
export function takeBackgroundReply(chunk: string): { rest: string; background: Rgb | null } {
  const match = BACKGROUND_REPLY.exec(chunk);
  if (!match) return { rest: chunk, background: null };
  return {
    rest: chunk.slice(0, match.index) + chunk.slice(match.index + match[0].length),
    background: { r: channel(match[1]), g: channel(match[2]), b: channel(match[3]) },
  };
}

export interface TerminalOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Capture the mouse for wheel scrolling, at the cost of drag-select. On unless refused. */
  mouse?: boolean;
  onKey(key: Key): void;
  onResize(rows: number, cols: number): void;
  /** The palette changed under a frame already drawn — the terminal reported its background. */
  onRepaint?(): void;
}

export interface Terminal {
  size(): { rows: number; cols: number };
  draw(frame: string[]): void;
  /** Trade drag-select for wheel scrolling, or take it back. */
  setMouse(enabled: boolean): void;
  /**
   * Re-establish every mode this app owns. For resuming after Ctrl-Z, where the
   * shell got the terminal back and handed over a plain one — nothing above
   * this file needs to know which escapes that involves. Caller redraws after.
   */
  reset(): void;
  /**
   * Hand the tty to a child process: leave the alternate screen, show the
   * cursor, turn every mode off and stop reading input. Nothing above this
   * file needs to know which escapes that involves.
   */
  suspend(): void;
  /**
   * Take the tty back after `suspend()`: the modes `reset()` owns, raw mode and
   * input reading again, and a forced repaint of the frame `suspend()` left
   * behind.
   */
  resume(): void;
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
  // NO_COLOR takes colour only: inverse video is how the composer marks the
  // caret once the hardware cursor is hidden below, so it stays on a tty.
  style.attributes = output.isTTY === true;

  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  let mouse = options.mouse === true;

  /**
   * Every mode the app owns, in one string. Written at open and again by
   * `reset()`; all of it is idempotent, so re-sending it costs a few bytes and
   * settles whatever a tmux reattach or a Ctrl-Z left behind.
   */
  const modes = (): string =>
    ALT_SCREEN_ON + HIDE_CURSOR + PASTE_MODE_ON + KITTY_KEYBOARD_ON +
    ALT_SCROLL_SAVE + ALT_SCROLL_OFF + (mouse ? MOUSE_TRACKING_ON : '');

  output.write(modes() + CLEAR + (style.enabled ? BACKGROUND_QUERY : ''));

  let closed = false;
  // The tty belongs to a child process between suspend() and resume(). Nothing
  // here may write in between: the app keeps painting behind whatever effect
  // started the child, and those bytes would land on its screen.
  let suspended = false;
  // What the last frame actually put on the screen. A row whose rendered text
  // did not change costs no bytes at all; a resize, `reset()` and a palette
  // change clear the screen and force the next draw to repaint every row.
  let lastRaw: string[] = [];
  let lastPainted: string[] = [];
  let lastCols = 0;
  let fullRepaint = true;

  /** Re-arm every mode and wipe what is on the screen; the next draw repaints it all. */
  const reestablish = (): void => {
    output.write(modes() + CLEAR);
    fullRepaint = true;
  };

  const decode = createKeyDecoder();
  const onData = (chunk: string) => {
    const { rest, background } = takeBackgroundReply(chunk);
    if (background) {
      palette.background = background;
      // The band is mixed from the background, so every row that carries it
      // must be painted again — a diff against the old frame would keep the
      // colour the terminal no longer has.
      fullRepaint = true;
      options.onRepaint?.();
    }
    for (const key of decode(rest)) options.onKey(key);
  };
  const onResize = () => {
    // A resize while the child owns the screen is the child's to repaint; our
    // clear-and-rearm would wipe it. `resume()` asks for the size again.
    if (suspended) return;
    // A shrink leaves glyphs beyond the new frame that row-anchored erase
    // never touches (it only erases within each row the new frame writes);
    // start the next draw from a clean screen.
    //
    // Tracking is re-armed alongside, because the events that resize us are the
    // same ones that silently clear DEC private modes — a tmux detach and
    // reattach above all. Re-enabling a mode that is already on costs nothing;
    // believing we hold a mouse we lost costs the user their wheel until they
    // toggle `/mouse` off and on again.
    output.write(CLEAR + (mouse ? MOUSE_TRACKING_ON : ''));
    fullRepaint = true;
    const { rows, cols } = size();
    options.onResize(rows, cols);
  };

  input.on('data', onData);
  output.on('resize', onResize);

  function size(): { rows: number; cols: number } {
    return { rows: output.rows || 24, cols: output.columns || 80 };
  }

  return {
    size,
    draw(frame) {
      if (closed || suspended) return;
      // Row-anchored rather than home-and-blit: each changed row is positioned
      // absolutely and erased to end of line, so a row that renders wider
      // than measured only misplaces itself instead of shoving every row
      // below it down by one line. Unchanged rows are not written at all:
      // a spinner tick or a streamed log line touches a handful of rows, and
      // rewriting the other forty every frame is what made the pane lag while
      // several tasks ran at once.
      //
      // `paintOnly` runs on the way out for the same reason `clampToCols`
      // does: it is the last point every byte bound for the tty passes
      // through. Text the TUI did not write itself is sanitized where it
      // arrives (see `sanitize`), but a field that grows a new source of it
      // later must not be able to ring the bell on every spinner tick or move
      // the cursor out from under the pane divider — from here on, the only
      // escapes that reach the terminal are the ones this app painted.
      // With autowrap off the cursor stays on the last column after a full
      // row, so an erase there would take that column's character with it.
      const { cols } = size();
      const force = fullRepaint || cols !== lastCols;
      fullRepaint = false;
      const raw: string[] = [];
      const painted: string[] = [];
      let rows = '';
      for (const [i, line] of frame.entries()) {
        // A raw row that did not change paints the same as last time, so it
        // is not sanitized, measured or written again.
        const unchanged = !force && lastRaw[i] === line;
        const row = unchanged ? lastPainted[i] : clampToCols(paintOnly(line), cols);
        raw.push(line);
        painted.push(row);
        if (!unchanged) rows += `\x1b[${i + 1};1H${row}${width(row) < cols ? '\x1b[K' : ''}`;
      }
      lastRaw = raw;
      lastPainted = painted;
      lastCols = cols;
      if (rows) output.write(AUTOWRAP_OFF + rows + AUTOWRAP_ON);
    },
    setMouse(enabled) {
      if (closed || enabled === mouse) return;
      mouse = enabled;
      // Deferred while a child owns the tty: resume() re-arms whichever
      // tracking mode is current, and tracking the login's own mouse would
      // steal its clicks.
      if (!suspended) output.write(enabled ? MOUSE_TRACKING_ON : MOUSE_TRACKING_OFF);
    },
    reset() {
      if (closed || suspended) return;
      // The shell handed back a plain screen: nothing from the last frame is
      // on it any more.
      reestablish();
    },
    suspend() {
      if (closed || suspended) return;
      suspended = true;
      // The inverse of `modes()`, plus what `close()` also owns: a child handed
      // this tty must find autowrap and the cursor as a shell leaves them, and
      // stay on the main screen so its own output is what the user sees.
      output.write(
        MOUSE_TRACKING_OFF + ALT_SCROLL_RESTORE + KITTY_KEYBOARD_OFF + PASTE_MODE_OFF + AUTOWRAP_ON + SHOW_CURSOR + ALT_SCREEN_OFF,
      );
      // Paused rather than merely un-decoded: the child owns every byte typed
      // from here until it exits, and none may land in a frame behind it.
      if (input.isTTY) input.setRawMode(false);
      input.pause();
    },
    resume() {
      if (closed || !suspended) return;
      suspended = false;
      // Raw mode before the modes, which re-arm the mouse. Whatever the child
      // painted is now on the screen, so the frame kept for diffing is
      // worthless: `reestablish` clears and forces a full repaint.
      if (input.isTTY) input.setRawMode(true);
      reestablish();
      input.resume();
    },
    close() {
      if (closed) return;
      closed = true;
      input.off('data', onData);
      output.off('resize', onResize);
      // AUTOWRAP_ON here too, not just after each draw: a signal can land
      // between the AUTOWRAP_OFF and AUTOWRAP_ON of an in-flight draw if the
      // frame is large enough to split across OS writes. Before raw mode goes,
      // as in `suspend()`, so the mouse is handed back.
      output.write(
        MOUSE_TRACKING_OFF + ALT_SCROLL_RESTORE + KITTY_KEYBOARD_OFF + PASTE_MODE_OFF + AUTOWRAP_ON + SHOW_CURSOR + ALT_SCREEN_OFF,
      );
      if (input.isTTY) input.setRawMode(false);
      input.pause();
    },
  };
}
