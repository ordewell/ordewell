import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { openTerminal } from '../terminal';

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

    for (const mode of ['\x1b[?1049h', '\x1b[?25l', '\x1b[?2004h', '\x1b[>1u', '\x1b[?1007l', '\x1b[?1000h', '\x1b[?1006h']) {
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
    terminal.draw(['x'.repeat(50)]);
    const draw = output.writes.join('');
    // eslint-disable-next-line no-control-regex
    const row = /\x1b\[1;1H(.*?)\x1b\[K/.exec(draw)?.[1] ?? '';

    expect(row.length).toBeLessThanOrEqual(10);
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
