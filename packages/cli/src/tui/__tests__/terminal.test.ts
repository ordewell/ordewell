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
