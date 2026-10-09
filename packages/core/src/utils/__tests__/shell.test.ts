import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../shell';

describe('stripAnsi', () => {
  it('removes CSI color/cursor sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m plain')).toBe('red plain');
    expect(stripAnsi('\x1b[2K\x1b[1Gspinner')).toBe('spinner');
  });

  it('removes OSC title sequences and carriage returns', () => {
    expect(stripAnsi('\x1b]0;window title\x07text\rline')).toBe('textline');
  });

  it('removes charset selection sequences', () => {
    expect(stripAnsi('\x1b(Bhello\x1b)0')).toBe('hello');
  });

  it('is stable across repeated calls (global regex state)', () => {
    const input = '\x1b[31mred\x1b[0m';
    expect(stripAnsi(input)).toBe('red');
    expect(stripAnsi(input)).toBe('red');
  });
});
