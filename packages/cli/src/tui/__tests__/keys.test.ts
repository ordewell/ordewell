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

  it('reports an SGR mouse click (not the wheel) as unknown', () => {
    expect(decodeKey('\x1b[<0;12;5M').name).toBe('unknown');
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

  it('normalizes CRLF and lone CR to newlines and drops other control characters', () => {
    const decode = createKeyDecoder();
    const keys = decode(`${START}a\r\nb\rc\x07d\te${END}`);
    expect(keys[0].text).toBe('a\nb\ncd\te');
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
