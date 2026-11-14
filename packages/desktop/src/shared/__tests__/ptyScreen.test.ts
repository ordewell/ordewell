import { describe, expect, it } from 'vitest';
import { completedLine, screenLines } from './ptyScreen';

// What bash wrote to its pty after `echo one two three` was edited and run, as
// the word-movement tests record it from the end of the prompt on, and the chord
// test from the last key: 3.2 is macOS's /bin/bash, 5.2 Ubuntu's.
const BASH_3_2 = {
  arrows: 'echo one two three\b\b\b\b\b\x1b[1@X\r\none two Xthree\r\nword-test> ',
  // With its `$ ` prompt, which the redraws below count on.
  viChange: '$ echo one two three\b\b\b\b\b\b\b\b\b\b\x07\r\x1b[7@(arg: 1) echo one\r\x1b[7P$ echo one \r\x1b[7@(arg: 1) echo one \r(arg: 3) echo one \r\x1b[7P$ echo one \x1b[KX\r\none X\r\n$ ',
};
const BASH_5_2 = {
  arrows: 'echo one two three\b\b\b\b\b\x1b[1@X\r\n\x1b[?2004l\rone two Xthree\r\n\x1b[?2004hword-test> ',
  viWord: 'echo one two three\b\b\b\b\b\b\b\b\btwo\x1b[1@X\r\n\x1b[?2004l\rone twoX three\r\n\x1b[?2004hword-test> ',
  chord: 'XY\r\n\x1b[?2004l\rone two threeXY\r\n\x1b[?2004h$ ',
};

describe('screenLines', () => {
  it('reads the same command output whether or not bash switches bracketed paste around it', () => {
    expect(completedLine(BASH_3_2.arrows, 'one')).toBe('one two Xthree');
    expect(completedLine(BASH_5_2.arrows, 'one')).toBe('one two Xthree');
    expect(completedLine(BASH_5_2.viWord, 'one')).toBe('one twoX three');
    expect(completedLine(BASH_5_2.chord, 'one')).toBe('one two threeXY');
  });

  it('draws the edited line as the line editor redrew it', () => {
    expect(screenLines(BASH_5_2.arrows)).toEqual(['echo one two Xthree', 'one two Xthree', 'word-test>']);
    expect(screenLines(BASH_5_2.viWord)[0]).toBe('echo one twoX three');
    // vi mode's count prompt is drawn over the line, removed, and the rest erased.
    expect(screenLines(BASH_3_2.viChange)).toEqual(['$ echo one X', 'one X', '$']);
  });

  it('waits for the line feed that ends a line before it counts', () => {
    expect(completedLine('echo one\r\n\x1b[?2004l\rone two th', 'one')).toBeUndefined();
    expect(completedLine('echo one\r\n\x1b[?2004l\rone two three\r\n', 'one')).toBe('one two three');
    // The first line may be the tail of one drawn before the slice began.
    expect(completedLine('one two three\r\n', 'one')).toBeUndefined();
  });

  it('drops sequences that print nothing, OSC titles and keypad modes included', () => {
    expect(screenLines('\x1b]0;title\x07\x1b=\x1b(Bok\x1b]2;t\x1b\\\x1b[1;31m!\x1b[m')).toEqual(['ok!']);
  });

  it('moves and deletes in place on CSI C, D, P and K', () => {
    expect(screenLines('abcdef\x1b[3D\x1b[1PX\x1b[C\x1b[K')).toEqual(['abcXf']);
    expect(screenLines('ab\x1b[2Cc')).toEqual(['ab  c']);
  });

  it('keeps a sequence cut off at the end of what has arrived from printing', () => {
    expect(screenLines('one\x1b[?20')).toEqual(['one']);
    expect(screenLines('one\x1b]0;tit')).toEqual(['one']);
  });
});
