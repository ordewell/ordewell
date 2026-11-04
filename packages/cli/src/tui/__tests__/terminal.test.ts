import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { openTerminal, rawModeReadsVtOnWindows, takeBackgroundReply, windowsInputNotice } from '../terminal';

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode = vi.fn();
  resume = vi.fn();
  pause = vi.fn();
  setEncoding = vi.fn();
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  rows = 24;
  columns = 80;
  writes: string[] = [];
  write = vi.fn((text: string) => {
    this.writes.push(text);
    return true;
  });
}

/**
 * What a VT-style screen shows after `bytes`, as ECMA-48 and DEC define it:
 * cursor position (CUP), erase to end of line (EL 0, which clears the cell
 * under the cursor too), and autowrap (DECAWM) — off, a character written in
 * the last column leaves the cursor there. Colours are ignored.
 */
function screenAfter(bytes: string, rows: number, cols: number): string[] {
  const grid = Array.from({ length: rows }, () => Array<string>(cols).fill(' '));
  let row = 0;
  let col = 0;
  let autowrap = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === '\x1b' && bytes[i + 1] === '[') {
      // eslint-disable-next-line no-control-regex
      const m = /^\x1b\[([?\d;]*)([A-Za-z])/.exec(bytes.slice(i));
      if (!m) continue;
      const [, params, final] = m;
      if (final === 'H') {
        const [r, c] = params.split(';').map((n) => Number(n) || 1);
        row = (r ?? 1) - 1;
        col = (c ?? 1) - 1;
      } else if (final === 'K') {
        for (let c = col; c < cols; c++) grid[row][c] = ' ';
      } else if (params === '?7') {
        autowrap = final === 'h';
      }
      i += m[0].length - 1;
      continue;
    }
    if (col >= cols) {
      if (!autowrap) col = cols - 1;
      else { row++; col = 0; }
    }
    grid[row][col] = bytes[i];
    col = autowrap ? col + 1 : Math.min(col + 1, cols);
    if (!autowrap && col === cols) col = cols - 1;
  }
  return grid.map((r) => r.join('').trimEnd());
}

describe('openTerminal', () => {
  it('leaves the mouse to the terminal by default, so drag-select and copy still work', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    expect(output.writes.join('')).not.toContain('\x1b[?1000h');
    // Alternate scroll off, or the wheel would arrive as arrow keys and browse
    // the input history; saved and restored so the shell keeps its own setting.
    expect(output.writes.join('')).toContain('\x1b[?1007s');
    expect(output.writes.join('')).toContain('\x1b[?1007l');
    terminal.close();
    expect(output.writes.join('')).toContain('\x1b[?1007r');
  });

  it('captures the mouse when asked, and hands it back on request and on close', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      mouse: true,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    expect(output.writes.join('')).toContain('\x1b[?1000h');
    expect(output.writes.join('')).toContain('\x1b[?1006h');

    output.writes.length = 0;
    terminal.setMouse(true);
    expect(output.writes).toEqual([]);

    terminal.setMouse(false);
    expect(output.writes.join('')).toContain('\x1b[?1000l');
    expect(output.writes.join('')).toContain('\x1b[?1006l');

    output.writes.length = 0;
    terminal.close();
    expect(output.writes.join('')).toContain('\x1b[?1000l');
  });

  it('changes mouse tracking only while raw mode is on, since a Windows pseudo console drops it otherwise', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      mouse: true,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });
    /** Whether each write naming `mode` came while raw mode was on, by the calls' order. */
    const rawAtEachWrite = (mode: string): boolean[] => {
      const toggles = input.setRawMode.mock.calls.map(([on], i) => ({ on: on as boolean, at: input.setRawMode.mock.invocationCallOrder[i] }));
      return output.write.mock.calls.flatMap(([text], i) => {
        if (!String(text).includes(mode)) return [];
        const at = output.write.mock.invocationCallOrder[i];
        return [toggles.filter((toggle) => toggle.at < at).at(-1)?.on === true];
      });
    };

    terminal.suspend();
    terminal.resume();
    terminal.close();

    // Open and resume arm it, suspend and close hand it back: all four with raw mode on.
    expect(rawAtEachWrite('\x1b[?1006h')).toEqual([true, true]);
    expect(rawAtEachWrite('\x1b[?1006l')).toEqual([true, true]);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('asks for button-event tracking too, so a held button reports the motion a drag is made of', () => {
    // 1002, not 1003: motion only while a button is down. Any-motion tracking
    // would put an event on stdin for every pixel the pointer crosses.
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      mouse: true,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    expect(output.writes.join('')).toContain('\x1b[?1002h');
    expect(output.writes.join('')).not.toContain('\x1b[?1003h');

    output.writes.length = 0;
    terminal.setMouse(false);
    expect(output.writes.join('')).toContain('\x1b[?1002l');

    output.writes.length = 0;
    terminal.close();
    expect(output.writes.join('')).toContain('\x1b[?1002l');
  });

  it('re-arms tracking on a resize, since a tmux reattach drops the mode without telling us', () => {
    // The modes are DEC private state the terminal owns, and a detach/reattach,
    // a Ctrl-Z/fg, or another process writing to the tty clears them while this
    // app still believes it holds the mouse. Re-arming is idempotent, and a
    // resize is the one event those disruptions reliably produce.
    const input = new FakeInput();
    const output = new FakeOutput();
    openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      mouse: true,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    output.emit('resize');

    expect(output.writes.join('')).toContain('\x1b[?1000h');
    expect(output.writes.join('')).toContain('\x1b[?1002h');
    expect(output.writes.join('')).toContain('\x1b[?1006h');
  });

  it('writes no tracking sequence on a resize while the mouse is the terminal\'s', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    output.emit('resize');

    expect(output.writes.join('')).not.toContain('\x1b[?1000h');
  });

  it('reset() re-establishes every mode the app owns, so a suspended session resumes intact', () => {
    // Ctrl-Z drops the process without any chance to tidy up, and the shell
    // that gets the terminal back leaves it on the main screen with the cursor
    // shown and none of our modes set. SIGCONT is the only notice we get.
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      mouse: true,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    terminal.reset();
    const written = output.writes.join('');

    for (const mode of ['\x1b[?1049h', '\x1b[?25l', '\x1b[?2004h', '\x1b[>1u', '\x1b[?1007l', '\x1b[?1000h', '\x1b[?1002h', '\x1b[?1006h']) {
      expect(written).toContain(mode);
    }
  });

  it('reset() leaves the mouse to the terminal when that is what the user chose', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      mouse: true,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    terminal.setMouse(false);
    output.writes.length = 0;
    terminal.reset();

    expect(output.writes.join('')).not.toContain('\x1b[?1000h');
    expect(output.writes.join('')).toContain('\x1b[?1049h');
  });

  it('suspend() hands the tty to a child: alt screen off, cursor and modes restored, raw mode off, input paused', () => {
    // The login command a runner declares owns the terminal for as long as it
    // runs: it must not paint into a frame that will be erased, and the bytes
    // the user types must reach it, not this decoder.
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      mouse: true,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    terminal.suspend();
    const written = output.writes.join('');

    for (const off of ['\x1b[?1049l', '\x1b[?25h', '\x1b[?2004l', '\x1b[<u', '\x1b[?1000l', '\x1b[?1002l', '\x1b[?1006l', '\x1b[?1007r']) {
      expect(written, off).toContain(off);
    }
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.pause).toHaveBeenCalled();
  });

  it('resume() takes the tty back: modes on, screen cleared, raw mode on, input resumed, every row repainted', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      mouse: true,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    terminal.draw(['same', 'same']);
    terminal.suspend();
    output.writes.length = 0;
    input.setRawMode.mockClear();
    input.resume.mockClear();
    terminal.resume();
    const written = output.writes.join('');

    for (const on of ['\x1b[?1049h', '\x1b[?25l', '\x1b[?2004h', '\x1b[>1u', '\x1b[?1007s', '\x1b[?1007l', '\x1b[?1000h', '\x1b[?1002h', '\x1b[?1006h']) {
      expect(written, on).toContain(on);
    }
    expect(written).toContain('\x1b[2J');
    expect(input.setRawMode).toHaveBeenLastCalledWith(true);
    expect(input.resume).toHaveBeenCalled();

    // The child may have written anywhere on the screen, so the frame held
    // here is worthless: the next draw must paint every row, not diff it.
    output.writes.length = 0;
    terminal.draw(['same', 'same']);
    expect(output.writes.join('')).toContain('\x1b[1;1Hsame');
    expect(output.writes.join('')).toContain('\x1b[2;1Hsame');

    // And a later reset — a Ctrl-Z after the login — still behaves as before.
    output.writes.length = 0;
    terminal.reset();
    expect(output.writes.join('')).toContain('\x1b[?1049h');
    terminal.close();
  });

  it('draws nothing while suspended, so a login command keeps the screen it owns', () => {
    // The app keeps painting behind an effect — a spinner tick, a streamed
    // planner line — and one of those frames on the main screen would land in
    // the middle of the child's prompt. resume() forces the repaint instead.
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    terminal.suspend();
    output.writes.length = 0;
    terminal.draw(['frame']);
    output.emit('resize');
    terminal.setMouse(true);

    expect(output.writes).toEqual([]);
    terminal.resume();
    expect(output.writes.join('')).toContain('\x1b[?1000h');
    output.writes.length = 0;
    terminal.draw(['frame']);
    expect(output.writes.join('')).toContain('\x1b[1;1Hframe');
    terminal.close();
  });

  it('keeps the mouse captured across a resize and a redraw', () => {
    // Both write to the tty while tracking is on — the resize clears the
    // screen, every draw brackets itself with autowrap off/on — and neither
    // may turn 1000/1006 off. A draw does not re-arm them either: that would be
    // bytes down the wire on every keystroke for a mode nothing has disturbed.
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      mouse: true,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    output.emit('resize');
    terminal.draw(['a frame']);

    expect(output.writes.join('')).not.toContain('\x1b[?1000l');
    expect(output.writes.join('')).not.toContain('\x1b[?1006l');
  });

  it('pushes the Kitty keyboard disambiguation flag on open and pops it on close, so Shift+Enter is distinguishable from Enter', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    expect(output.writes.join('')).toContain('\x1b[>1u');
    terminal.close();
    expect(output.writes.join('')).toContain('\x1b[<u');
  });

  it('falls back to 24×80 when the tty does not report a size', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.rows = 0;
    output.columns = 0;
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    expect(terminal.size()).toEqual({ rows: 24, cols: 80 });
    terminal.close();
  });

  it('positions each row absolutely and erases to end of line, rather than homing and blitting the whole frame', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    terminal.draw(['first', 'second', 'third']);
    const draw = output.writes.join('');

    expect(draw).toContain('\x1b[1;1Hfirst\x1b[K');
    expect(draw).toContain('\x1b[2;1Hsecond\x1b[K');
    expect(draw).toContain('\x1b[3;1Hthird\x1b[K');
    // Never a bare home-and-join: a mis-measured row must only misplace
    // itself, not shove the rows after it.
    expect(draw).not.toContain('\x1b[H');
    terminal.close();
  });

  it('writes only the rows that changed since the last frame', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    terminal.draw(['same', 'old', 'same']);
    output.writes.length = 0;
    terminal.draw(['same', 'new', 'same']);
    const draw = output.writes.join('');

    expect(draw).toContain('\x1b[2;1Hnew');
    expect(draw).not.toContain('\x1b[1;1H');
    expect(draw).not.toContain('\x1b[3;1H');
    terminal.close();
  });

  it('repaints every row after a resize cleared the screen', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    terminal.draw(['same', 'old', 'same']);
    output.emit('resize');
    output.writes.length = 0;
    terminal.draw(['same', 'new', 'same']);
    const draw = output.writes.join('');

    expect(draw).toContain('\x1b[1;1Hsame');
    expect(draw).toContain('\x1b[2;1Hnew');
    expect(draw).toContain('\x1b[3;1Hsame');
    terminal.close();
  });

  it('repaints every row after a palette change, since the band has a new colour', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    terminal.draw(['same', 'same']);
    input.emit('data', '\x1b]11;rgb:ff/ff/ff\x07');
    output.writes.length = 0;
    terminal.draw(['same', 'same']);
    const draw = output.writes.join('');

    expect(draw).toContain('\x1b[1;1Hsame');
    expect(draw).toContain('\x1b[2;1Hsame');
    terminal.close();
  });

  it('repaints every row after reset() handed the screen back from the shell', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    terminal.draw(['same', 'same']);
    terminal.reset();
    output.writes.length = 0;
    terminal.draw(['same', 'same']);
    const draw = output.writes.join('');

    expect(draw).toContain('\x1b[1;1Hsame');
    expect(draw).toContain('\x1b[2;1Hsame');
    terminal.close();
  });

  it('disables autowrap for the draw and restores it right after, so an over-wide row clips instead of wrapping into the next line', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    terminal.draw(['row']);
    const draw = output.writes.join('');

    const off = draw.indexOf('\x1b[?7l');
    const on = draw.indexOf('\x1b[?7h');
    expect(off).toBeGreaterThanOrEqual(0);
    expect(on).toBeGreaterThan(off);
    terminal.close();
  });

  it('restores autowrap on close alongside the other mode restores', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    terminal.close();
    expect(output.writes.join('')).toContain('\x1b[?7h');
  });

  // render() pads every row to the full width, and the plan pane ends on the
  // last column: an erase after a full row took that column off every row.
  it('keeps the last column of a row that fills the terminal', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 10;
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    terminal.draw(['old row is long', 'second']);
    terminal.draw(['abcdefghij', 'x']);

    expect(screenAfter(output.writes.join(''), 2, 10)).toEqual(['abcdefghij', 'x']);
    terminal.close();
  });

  it('clamps a row wider than the terminal before writing it, even if render() did not', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 10;
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    terminal.draw(['x'.repeat(50), 'next']);

    expect(screenAfter(output.writes.join(''), 2, 10)).toEqual(['xxxxxxxxx…', 'next']);
    terminal.close();
  });

  it('never writes an escape it did not paint with, whatever reaches the frame', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    terminal.draw(['ring\x07 move\x1b[10C wipe\x1b[2J title\x1b]0;t\x07 back\r']);
    const draw = output.writes.join('');

    // The bell above all: a frame is repainted on every spinner tick, so one
    // left in it rings the terminal eight times a second for a whole run.
    expect(draw).not.toContain('\x07');
    expect(draw).not.toContain('\x1b[10C');
    expect(draw).not.toContain('\x1b[2J');
    expect(draw).not.toContain('\x1b]0;');
    expect(draw).not.toContain('\r');
    expect(draw).toContain('ring move wipe title back');
    terminal.close();
  });

  it('keeps the colour and the pane-divider anchor the frame does paint with', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    output.writes.length = 0;
    terminal.draw(['chat\x1b[K\x1b[44G\x1b[90m│\x1b[0mplan']);
    expect(output.writes.join('')).toContain('chat\x1b[K\x1b[44G\x1b[90m│\x1b[0mplan');
    terminal.close();
  });

  it('lets the grey band\'s 256-colour background through to the tty', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    const band = '\x1b[48;5;234m\x1b[36m❯ \x1b[0m\x1b[48;5;234mhi   \x1b[0m';
    output.writes.length = 0;
    terminal.draw([band]);
    expect(output.writes.join('')).toContain(`\x1b[1;1H${band}\x1b[K`);
    terminal.close();
  });

  it('ignores draws after close and restores the terminal only once', () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey: vi.fn(),
      onResize: vi.fn(),
    });

    terminal.close();
    terminal.close();
    const restores = output.writes.filter((w) => w.includes('\x1b[?1049l'));
    expect(restores).toHaveLength(1);

    const writesAfterClose = output.writes.length;
    terminal.draw(['line']);
    expect(output.writes).toHaveLength(writesAfterClose);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('skips raw mode for a non-tty input but still decodes its bytes', () => {
    const input = new FakeInput();
    input.isTTY = false;
    const output = new FakeOutput();
    const onKey = vi.fn();
    const terminal = openTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onKey,
      onResize: vi.fn(),
    });

    expect(input.setRawMode).not.toHaveBeenCalled();
    input.emit('data', 'a');
    expect(onKey).toHaveBeenCalledWith({ name: 'char', char: 'a' });
    terminal.close();
    expect(input.setRawMode).not.toHaveBeenCalled();
  });
});

describe('the background reply', () => {
  it('is cut out of the input and read at any channel width', () => {
    expect(takeBackgroundReply('a\x1b]11;rgb:1e1e/1e1e/2e2e\x07b')).toEqual({ rest: 'ab', background: { r: 30, g: 30, b: 46 } });
    expect(takeBackgroundReply('\x1b]11;rgb:ff/fa/00\x1b\\')).toEqual({ rest: '', background: { r: 255, g: 250, b: 0 } });
  });

  it('leaves input without one untouched', () => {
    expect(takeBackgroundReply('\x1b[A')).toEqual({ rest: '\x1b[A', background: null });
  });
});

describe('the Windows console and Node\'s raw mode', () => {
  // nodejs/node#58358: Node 22.17 and 24.2 have the console read VT input, which
  // carries mouse reports and paste markers; 20.20.2 was measured without it.
  it.each([
    ['v20.20.2', false],
    ['v22.16.0', false],
    ['v22.17.0', true],
    ['v22.17.1', true],
    ['v23.11.1', false],
    ['v24.1.0', false],
    ['v24.2.0', true],
    ['v25.0.0', true],
  ])('reads %s as passing VT input: %s', (version, reads) => {
    expect(rawModeReadsVtOnWindows(version)).toBe(reads);
  });

  it('says once at start, on Windows only, what an older Node costs the TUI', () => {
    expect(windowsInputNotice('win32', 'v20.20.2')).toMatch(/Node v20\.20\.2 .*wheel does nothing.*sends the line.*Node 22\.17 or newer/);
    expect(windowsInputNotice('win32', 'v22.17.1')).toBeNull();
    expect(windowsInputNotice('linux', 'v20.20.2')).toBeNull();
    expect(windowsInputNotice('darwin', 'v20.20.2')).toBeNull();
  });
});
