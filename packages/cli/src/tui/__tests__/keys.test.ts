import { describe, it, expect } from 'vitest';
import { createKeyDecoder, decodeKey, splitKeys } from '../keys';

describe('decodeKey', () => {
  it('reads a printable character as itself', () => {
    expect(decodeKey('a')).toEqual({ name: 'char', char: 'a' });
  });

  it.each([
    ['\r', 'enter'],
    ['\n', 'enter'],
    ['\t', 'tab'],
    ['\x7f', 'backspace'],
    ['\b', 'backspace'],
    ['\x1b', 'escape'],
    ['\x03', 'ctrl-c'],
    ['\x04', 'ctrl-d'],
    ['\x0c', 'ctrl-l'],
    ['\x0e', 'ctrl-n'],
    ['\x10', 'ctrl-p'],
    ['\x01', 'ctrl-a'],
    ['\x05', 'ctrl-e'],
    ['\x15', 'ctrl-u'],
    ['\x0b', 'ctrl-k'],
    ['\x17', 'ctrl-w'],
  ])('maps control byte %j to %s', (seq, name) => {
    expect(decodeKey(seq).name).toBe(name);
  });

  it.each([
    ['\x1b[A', 'up'],
    ['\x1b[B', 'down'],
    ['\x1b[C', 'right'],
    ['\x1b[D', 'left'],
    ['\x1b[H', 'home'],
    ['\x1b[F', 'end'],
    ['\x1b[3~', 'delete'],
    ['\x1b[5~', 'pageup'],
    ['\x1b[6~', 'pagedown'],
    ['\x1b[Z', 'shift-tab'],
    ['\x1b[1;3C', 'alt-right'],
    ['\x1b[1;3D', 'alt-left'],
    ['\x1b[3;3~', 'alt-delete'],
    ['\x1bf', 'alt-right'],
    ['\x1bb', 'alt-left'],
    ['\x1bd', 'alt-delete'],
    ['\x1b\x7f', 'alt-backspace'],
    ['\x1b\x1b[C', 'alt-right'],
    ['\x1b\x1b[D', 'alt-left'],
    ['\x1bOM', 'shift-enter'],
    ['\x1b[2;2~', 'shift-enter'],
    ['\x1b[13;2u', 'shift-enter'],
    ['\x1b[13;2~', 'shift-enter'],
    ['\x1b\r', 'alt-enter'],
    ['\x1b\n', 'alt-enter'],
  ])('maps escape sequence %j to %s', (seq, name) => {
    expect(decodeKey(seq).name).toBe(name);
  });

  it('keeps multi-byte characters intact', () => {
    expect(decodeKey('é')).toEqual({ name: 'char', char: 'é' });
  });

  it('reports an unrecognised escape sequence as unknown rather than typing it', () => {
    expect(decodeKey('\x1b[200~').name).toBe('unknown');
  });

  it.each([
    ['\x1b[<64;12;5M', 'scrollup'],
    ['\x1b[<65;12;5M', 'scrolldown'],
  ])('maps SGR mouse wheel report %j to %s', (seq, name) => {
    expect(decodeKey(seq).name).toBe(name);
  });

  it('reads an SGR left press as mousedown at the cell under the pointer', () => {
    expect(decodeKey('\x1b[<0;12;5M')).toEqual({ name: 'mousedown', col: 12, row: 5 });
  });

  // The only thing separating a press from a release in SGR is the final byte,
  // and the button field is identical in both — read the `M`/`m` or the release
  // arrives as a second mousedown.
  it('splits an SGR press from a release on the final byte alone', () => {
    expect(decodeKey('\x1b[<0;12;5m')).toEqual({ name: 'mouseup', col: 12, row: 5 });
  });

  it.each([
    ['\x1b[<1;12;5M', 'middle'],
    ['\x1b[<2;12;5M', 'right'],
    ['\x1b[<33;12;5M', 'middle in motion'],
    ['\x1b[<34;12;5M', 'right in motion'],
  ])('leaves %j, a %s press, unhandled rather than reading it as the left button', (seq) => {
    expect(decodeKey(seq).name).toBe('unknown');
  });

  // 32 is the motion bit terminal.ts's 1002 buys: with the left button down it
  // marks the cells the pointer is dragged across, which is the selection.
  it('reads a held left button in motion as mousedrag', () => {
    expect(decodeKey('\x1b[<32;14;7M')).toEqual({ name: 'mousedrag', col: 14, row: 7 });
  });

  // Shift (4), Alt (8) and Ctrl (16) sit in the same byte as the button, so a
  // modifier held while dragging must not read as some other button.
  it.each([
    ['\x1b[<4;12;5M', 'mousedown', 'shift'],
    ['\x1b[<8;12;5M', 'mousedown', 'alt'],
    ['\x1b[<16;12;5M', 'mousedown', 'ctrl'],
    ['\x1b[<36;12;5M', 'mousedrag', 'shift'],
    ['\x1b[<40;12;5M', 'mousedrag', 'alt'],
    ['\x1b[<48;12;5M', 'mousedrag', 'ctrl'],
    ['\x1b[<20;12;5m', 'mouseup', 'ctrl+shift'],
  ])('maps %j to %s with the %s modifier held', (seq, name) => {
    expect(decodeKey(seq)).toEqual({ name, col: 12, row: 5 });
  });

  // The modifier bits (shift 4, alt 8, ctrl 16) and the motion bit (32) ride on
  // top of the wheel's own 64: a terminal that reports Ctrl+wheel as 80 is
  // still reporting a wheel notch.
  it.each([
    ['\x1b[<68;12;5M', 'scrollup', 'shift'],
    ['\x1b[<69;12;5M', 'scrolldown', 'shift'],
    ['\x1b[<72;12;5M', 'scrollup', 'alt'],
    ['\x1b[<73;12;5M', 'scrolldown', 'alt'],
    ['\x1b[<80;12;5M', 'scrollup', 'ctrl'],
    ['\x1b[<81;12;5M', 'scrolldown', 'ctrl'],
    ['\x1b[<96;12;5M', 'scrollup', 'motion'],
    ['\x1b[<97;12;5M', 'scrolldown', 'motion'],
  ])('maps %j to %s despite the %s bit', (seq, name) => {
    expect(decodeKey(seq).name).toBe(name);
  });

  // X10 / normal tracking: three raw bytes after `\x1b[M`, each offset by 32.
  // Terminals fall back to it whenever 1006 is not honored, and tmux forwards
  // it as-is.
  it.each([
    ['\x1b[M`\x30\x25', 'scrollup'],
    ['\x1b[Ma\x30\x25', 'scrolldown'],
  ])('maps X10 wheel report %j to %s', (seq, name) => {
    expect(decodeKey(seq).name).toBe(name);
  });

  // X10 button bytes, less their bias of 32: 0 is the left button, 32 is that
  // button in motion, and 3 is a release — the encoding has no way to say which
  // button was let go, so every release reads the same.
  it.each([
    ['\x1b[M \x2c\x25', 'mousedown'],
    ['\x1b[M@\x2c\x25', 'mousedrag'],
    ['\x1b[M#\x2c\x25', 'mouseup'],
  ])('maps X10 report %j to %s', (seq, name) => {
    expect(decodeKey(seq)).toEqual({ name, col: 12, row: 5 });
  });

  it('maps a urxvt-encoded wheel report, whose button is biased by 32', () => {
    expect(decodeKey('\x1b[96;12;5M').name).toBe('scrollup');
    expect(decodeKey('\x1b[97;12;5M').name).toBe('scrolldown');
  });

  // urxvt is X10's button byte written out as a decimal parameter, bias and
  // release code included, but always terminated by an uppercase `M`.
  it.each([
    ['\x1b[32;12;5M', 'mousedown'],
    ['\x1b[64;12;5M', 'mousedrag'],
    ['\x1b[35;12;5M', 'mouseup'],
  ])('maps urxvt report %j to %s', (seq, name) => {
    expect(decodeKey(seq)).toEqual({ name, col: 12, row: 5 });
  });

  it('drops a horizontal wheel notch without reporting it as an unknown key', () => {
    // `unknown` is "some key the app does not know", which every overlay reads
    // as a cue to close itself — a sideways nudge of the wheel must not do that.
    expect(decodeKey('\x1b[<66;12;5M').name).not.toBe('unknown');
    expect(decodeKey('\x1b[<66;12;5M').name).not.toBe('scrollup');
    expect(decodeKey('\x1b[<67;12;5M').name).not.toBe('scrolldown');
  });

  // Which pane the pointer is over is the only thing that makes the wheel feel
  // right when two panes are on screen, so the coordinates have to survive.
  it('carries the 1-based column and row of an SGR report', () => {
    expect(decodeKey('\x1b[<64;12;5M')).toEqual({ name: 'scrollup', col: 12, row: 5 });
  });

  it('carries the coordinates of an X10 report, each byte less its bias of 32', () => {
    expect(decodeKey('\x1b[M`\x30\x25')).toEqual({ name: 'scrollup', col: 16, row: 5 });
  });
});

describe('splitKeys', () => {
  it('yields one key per character', () => {
    expect(splitKeys('abc').map((k) => k.char)).toEqual(['a', 'b', 'c']);
  });

  it('keeps an escape sequence together instead of typing its letters', () => {
    expect(splitKeys('\x1b[A').map((k) => k.name)).toEqual(['up']);
  });

  it('separates an escape sequence from the text around it', () => {
    expect(splitKeys('a\x1b[Bb').map((k) => k.name)).toEqual(['char', 'down', 'char']);
  });

  it('handles a tilde-terminated sequence', () => {
    expect(splitKeys('\x1b[3~x').map((k) => k.name)).toEqual(['delete', 'char']);
  });

  it('keeps Alt+Arrow and Alt+Delete sequences together', () => {
    expect(splitKeys('\x1b[1;3D\x1b[1;3C\x1b[3;3~').map((k) => k.name))
      .toEqual(['alt-left', 'alt-right', 'alt-delete']);
  });

  it('keeps Meta-letter and Meta-Backspace sequences together', () => {
    expect(splitKeys('\x1bb\x1bf\x1bd\x1b\x7f').map((k) => k.name))
      .toEqual(['alt-left', 'alt-right', 'alt-delete', 'alt-backspace']);
  });

  it('reads a paste as the characters it contains', () => {
    expect(splitKeys('hi there')).toHaveLength(8);
  });

  it('keeps a multi-byte character in one piece', () => {
    expect(splitKeys('é✅').map((k) => k.char)).toEqual(['é', '✅']);
  });

  it('treats a lone escape as the escape key', () => {
    expect(splitKeys('\x1b').map((k) => k.name)).toEqual(['escape']);
  });

  it('keeps an SGR mouse report together instead of splitting on its digits', () => {
    expect(splitKeys('\x1b[<64;12;5Mx').map((k) => k.name)).toEqual(['scrollup', 'char']);
  });

  it('swallows the three coordinate bytes of an X10 report instead of typing them', () => {
    // `M` is a CSI final byte, so the generic scan ends the sequence there and
    // the coordinates land in the line editor as `0%x`.
    expect(splitKeys('\x1b[M`\x30\x25x').map((k) => k.name)).toEqual(['scrollup', 'char']);
  });

  it('keeps a whole drag together — a press, the motion reports, then the release', () => {
    // A drag arrives as one burst per stdin chunk, and the release ends it with
    // a lowercase final byte the CSI scan has to accept like any other.
    expect(splitKeys('\x1b[<0;3;1M\x1b[<32;4;1M\x1b[<32;5;1M\x1b[<0;5;1m').map((k) => k.name))
      .toEqual(['mousedown', 'mousedrag', 'mousedrag', 'mouseup']);
  });

  it('separates a mouse release from the text after it', () => {
    expect(splitKeys('\x1b[<0;5;1mx').map((k) => k.name)).toEqual(['mouseup', 'char']);
  });

  it('handles shift-enter in SS3 form', () => {
    expect(splitKeys('\x1bOM').map((k) => k.name)).toEqual(['shift-enter']);
  });

  it('handles shift-enter in CSI form', () => {
    expect(splitKeys('\x1b[2;2~').map((k) => k.name)).toEqual(['shift-enter']);
  });

  it('handles shift-enter in CSI-u form', () => {
    expect(splitKeys('\x1b[13;2u').map((k) => k.name)).toEqual(['shift-enter']);
  });

  it('handles shift-enter in CSI 13;2~ form', () => {
    expect(splitKeys('\x1b[13;2~').map((k) => k.name)).toEqual(['shift-enter']);
  });

  it('keeps shift-enter together with surrounding text', () => {
    expect(splitKeys('hello\x1bOMworld').map((k) => k.name))
      .toEqual(['char', 'char', 'char', 'char', 'char', 'shift-enter', 'char', 'char', 'char', 'char', 'char']);
  });

  it('handles multiple shift-enter sequences in one input', () => {
    expect(splitKeys('a\x1bOMb\x1b[2;2~c').map((k) => k.name))
      .toEqual(['char', 'shift-enter', 'char', 'shift-enter', 'char']);
  });

  it('keeps Alt+Enter together instead of splitting into escape and enter', () => {
    expect(splitKeys('\x1b\r').map((k) => k.name)).toEqual(['alt-enter']);
    expect(splitKeys('\x1b\n').map((k) => k.name)).toEqual(['alt-enter']);
  });

  it('keeps Alt+Enter together with surrounding text', () => {
    expect(splitKeys('hi\x1b\rthere').map((k) => k.name))
      .toEqual(['char', 'char', 'alt-enter', 'char', 'char', 'char', 'char', 'char']);
  });
});

describe('createKeyDecoder — bracketed paste', () => {
  const START = '\x1b[200~';
  const END = '\x1b[201~';

  it('decodes ordinary chunks exactly like splitKeys', () => {
    const decode = createKeyDecoder();
    expect(decode('a\x1b[Bb').map((k) => k.name)).toEqual(['char', 'down', 'char']);
  });

  it('turns a bracketed paste into one paste key — a newline inside never submits', () => {
    const decode = createKeyDecoder();
    const keys = decode(`a${START}line1\nline2${END}b`);
    expect(keys.map((k) => k.name)).toEqual(['char', 'paste', 'char']);
    expect(keys[1].text).toBe('line1\nline2');
  });

  it('buffers a paste that spans several stdin chunks', () => {
    const decode = createKeyDecoder();
    expect(decode(`${START}first `)).toEqual([]);
    expect(decode('half')).toEqual([]);
    const keys = decode(`done${END}x`);
    expect(keys).toEqual([
      { name: 'paste', text: 'first halfdone' },
      { name: 'char', char: 'x' },
    ]);
  });

  it('finds the end marker even when it is split across chunks', () => {
    const decode = createKeyDecoder();
    expect(decode(`${START}hello\x1b[201`)).toEqual([]);
    expect(decode('~z')).toEqual([
      { name: 'paste', text: 'hello' },
      { name: 'char', char: 'z' },
    ]);
  });

  it('normalizes CRLF and lone CR to newlines, drops other control characters, and turns a tab into a space', () => {
    const decode = createKeyDecoder();
    const keys = decode(`${START}a\r\nb\rc\x07d\te${END}`);
    // The tab is replaced, not dropped like \x07: a dropped tab would glue
    // 'd' and 'e' into one word. A real terminal expands a tab to its next
    // stop and shoves every column after it sideways — the bug this closes —
    // so it must never reach the editor buffer intact.
    expect(keys[0].text).toBe('a\nb\ncd e');
    expect(keys[0].text).not.toContain('\t');
  });

  it('handles shift-enter mixed with normal keys before a bracketed paste', () => {
    const decode = createKeyDecoder();
    const keys = decode(`a\x1bOMb${START}pasted${END}c`);
    expect(keys.map((k) => k.name)).toEqual(['char', 'shift-enter', 'char', 'paste', 'char']);
    expect(keys[3].text).toBe('pasted');
  });

  it('handles shift-enter mixed with normal keys after a bracketed paste', () => {
    const decode = createKeyDecoder();
    const keys = decode(`${START}pasted${END}\x1bOMx`);
    expect(keys.map((k) => k.name)).toEqual(['paste', 'shift-enter', 'char']);
    expect(keys[0].text).toBe('pasted');
  });
});

describe('createKeyDecoder — sequences split across stdin chunks', () => {
  it('yields exactly one scroll key, and no typed characters, for a wheel report split in two', () => {
    // Spinning the wheel fast is precisely when stdin hands over a half report:
    // the tail used to arrive in the next chunk and be typed as `;5M`.
    const decode = createKeyDecoder();
    expect(decode('\x1b[<64;12')).toEqual([]);
    expect(decode(';5M')).toEqual([{ name: 'scrollup', col: 12, row: 5 }]);
  });

  it('joins a split X10 report, whose payload runs past its final byte', () => {
    const decode = createKeyDecoder();
    expect(decode('\x1b[M`')).toEqual([]);
    expect(decode('\x30\x25').map((k) => k.name)).toEqual(['scrollup']);
  });

  it('joins an arrow key split after the CSI introducer', () => {
    const decode = createKeyDecoder();
    expect(decode('\x1b[')).toEqual([]);
    expect(decode('A').map((k) => k.name)).toEqual(['up']);
  });

  it('still reports a lone escape as the escape key', () => {
    const decode = createKeyDecoder();
    expect(decode('\x1b').map((k) => k.name)).toEqual(['escape']);
  });

  it('does not hold back an escape followed by ordinary text', () => {
    const decode = createKeyDecoder();
    expect(decode('\x1bx').map((k) => k.name)).toEqual(['escape', 'char']);
  });

  it('gives up on a runaway sequence rather than swallowing input forever', () => {
    const decode = createKeyDecoder();
    expect(decode(`\x1b[${'9'.repeat(40)}`).map((k) => k.name)).toEqual(['unknown']);
  });
});
