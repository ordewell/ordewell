import { describe, it, expect } from 'vitest';
import { stripAnsi, width, truncate, pad, style, wrap } from '../ansi';

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
