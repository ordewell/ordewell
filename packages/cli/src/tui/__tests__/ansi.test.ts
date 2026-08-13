import { describe, it, expect } from 'vitest';
import { paintOnly, sanitize, stripAnsi, width, truncate, pad, style, wrap } from '../ansi';

describe('stripAnsi', () => {
  it('removes colour codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
});

describe('width', () => {
  it('ignores colour codes', () => {
    expect(width('\x1b[31mred\x1b[0m')).toBe(3);
  });

  it('counts a wide CJK glyph as two columns', () => {
    expect(width('日本')).toBe(4);
  });

  it('counts an emoji as two columns', () => {
    expect(width('✅')).toBe(2);
  });

  it('keeps text-presentation symbols to one column', () => {
    expect(width('❯◐◆✓')).toBe(4);
  });
});

describe('truncate', () => {
  it('leaves a short string alone', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('cuts to the limit with an ellipsis', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(width(truncate('abcdefgh', 5))).toBe(5);
  });

  it('never splits a wide glyph across the boundary', () => {
    expect(width(truncate('日本語です', 5))).toBeLessThanOrEqual(5);
  });

  it('drops the text entirely when there is no room', () => {
    expect(truncate('abc', 0)).toBe('');
  });
});

describe('sanitize', () => {
  it('replaces a tab with a single space', () => {
    expect(sanitize('a\tb')).toBe('a b');
  });

  it('is why a tab would otherwise be measured as free width', () => {
    // string-width's own documented behaviour, and the reason a literal tab
    // slipping past `sanitize` renders wider than any layout math believes.
    expect(width('\t')).toBe(0);
  });

  it('drops the bell — the frame it lands in is repainted every 120ms', () => {
    expect(sanitize('done\x07!')).toBe('done!');
  });

  it('drops a whole CSI sequence, not only its ESC', () => {
    // Left as `[10Cmoved` it would read as text; left whole it shifts the rest
    // of the row — the pane divider with it — ten columns right.
    expect(sanitize('a\x1b[10Cb\x1b[2K\x1b[Hc')).toBe('abc');
    expect(sanitize('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('drops an OSC string, terminated by BEL or ST, and an unterminated one', () => {
    expect(sanitize('a\x1b]0;window title\x07b')).toBe('ab');
    expect(sanitize('a\x1b]52;c;Zm9v\x1b\\b')).toBe('ab');
    expect(sanitize('a\x1b]0;never ends')).toBe('a');
  });

  it('drops the two-character forms and a lone ESC', () => {
    expect(sanitize('a\x1b(Bb\x1b=c\x1b')).toBe('abc');
  });

  it('drops C1 introducers, which an 8-bit terminal reads as escapes', () => {
    expect(sanitize('a5Cb')).toBe('a5Cb');
  });

  it('normalizes carriage returns rather than gluing the halves together', () => {
    expect(sanitize('50%\r100%')).toBe('50%\n100%');
    expect(sanitize('one\r\ntwo')).toBe('one\ntwo');
  });

  it('keeps newlines — wrapping is built on them', () => {
    expect(sanitize('one\ntwo')).toBe('one\ntwo');
  });
});

describe('paintOnly', () => {
  it('keeps colour and the escapes the pane divider is anchored with', () => {
    expect(paintOnly('\x1b[90m│\x1b[0m')).toBe('\x1b[90m│\x1b[0m');
    expect(paintOnly('a\x1b[K\x1b[54Gb')).toBe('a\x1b[K\x1b[54Gb');
  });

  it('drops every escape this app does not paint with', () => {
    expect(paintOnly('a\x1b[10Cb\x1b]0;t\x07c\x1b(Bd')).toBe('abcd');
  });

  it('drops raw control characters, including the tab and newline `sanitize` keeps', () => {
    expect(paintOnly('a\x07b\rc\td\ne')).toBe('abcde');
  });

  it('leaves a row with nothing to strip untouched', () => {
    const line = 'plain text';
    expect(paintOnly(line)).toBe(line);
  });
});

describe('pad', () => {
  it('fills a string out to the given width', () => {
    expect(pad('ab', 5)).toBe('ab   ');
  });

  it('measures padding by visible width, not byte length', () => {
    expect(width(pad(style.dim('ab'), 5))).toBe(5);
  });

  it('truncates something too long to fit', () => {
    expect(width(pad('abcdefgh', 4))).toBe(4);
  });
});

describe('wrap', () => {
  it('breaks a long line on word boundaries', () => {
    expect(wrap('the quick brown fox', 10)).toEqual(['the quick', 'brown fox']);
  });

  it('hard-splits a word longer than the width', () => {
    expect(wrap('supercalifragilistic', 8)).toEqual(['supercal', 'ifragili', 'stic']);
  });

  it('keeps existing line breaks', () => {
    expect(wrap('one\ntwo', 10)).toEqual(['one', 'two']);
  });

  it('returns a single empty line for empty text', () => {
    expect(wrap('', 10)).toEqual(['']);
  });

  it('keeps leading indentation, which list rows rely on for alignment', () => {
    expect(wrap('   indented', 20)).toEqual(['   indented']);
  });

  it('keeps runs of spaces inside a line', () => {
    expect(wrap('a    b', 20)).toEqual(['a    b']);
  });

  it('keeps indentation on a line it has to wrap', () => {
    expect(wrap('   one two three', 9)[0]).toBe('   one');
  });
});

describe('style', () => {
  it('wraps text in a colour and resets afterwards', () => {
    expect(stripAnsi(style.cyan('hi'))).toBe('hi');
    expect(style.cyan('hi')).not.toBe('hi');
  });

  it('can be disabled for a non-colour terminal', () => {
    style.enabled = false;
    expect(style.cyan('hi')).toBe('hi');
    style.enabled = true;
  });
});
