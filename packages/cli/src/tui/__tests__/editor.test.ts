import { describe, it, expect } from 'vitest';
import { emptyEditor, applyKey, commit, cursorPosition, type EditorState } from '../editor';

const at = (text: string, cursor = text.length): EditorState => ({
  ...emptyEditor(),
  text,
  cursor,
});

describe('applyKey — typing', () => {
  it('inserts a character at the cursor', () => {
    const next = applyKey(at('ab', 1), { name: 'char', char: 'X' });
    expect(next.text).toBe('aXb');
    expect(next.cursor).toBe(2);
  });

  it('deletes the character before the cursor on backspace', () => {
    const next = applyKey(at('abc', 2), { name: 'backspace' });
    expect(next.text).toBe('ac');
    expect(next.cursor).toBe(1);
  });

  it('does nothing on backspace at the start of the line', () => {
    expect(applyKey(at('abc', 0), { name: 'backspace' })).toEqual(at('abc', 0));
  });

  it('deletes the character under the cursor on delete', () => {
    const next = applyKey(at('abc', 1), { name: 'delete' });
    expect(next.text).toBe('ac');
    expect(next.cursor).toBe(1);
  });

  it('inserts a paste at the cursor, newlines and all', () => {
    const next = applyKey(at('ab', 1), { name: 'paste', text: 'one\ntwo' });
    expect(next.text).toBe('aone\ntwob');
    expect(next.cursor).toBe(8);
  });

  it('ignores an empty paste', () => {
    expect(applyKey(at('ab', 1), { name: 'paste', text: '' })).toEqual(at('ab', 1));
  });
});

describe('applyKey — shift-enter', () => {
  it('inserts a newline at the cursor', () => {
    const next = applyKey(at('ab', 1), { name: 'shift-enter' });
    expect(next.text).toBe('a\nb');
    expect(next.cursor).toBe(2);
  });

  it('inserts a newline at the start', () => {
    const next = applyKey(at('abc', 0), { name: 'shift-enter' });
    expect(next.text).toBe('\nabc');
    expect(next.cursor).toBe(1);
  });

  it('inserts a newline at the end', () => {
    const next = applyKey(at('abc', 3), { name: 'shift-enter' });
    expect(next.text).toBe('abc\n');
    expect(next.cursor).toBe(4);
  });
});

describe('applyKey — alt-enter', () => {
  it('inserts a newline at the cursor, same as shift-enter', () => {
    const next = applyKey(at('ab', 1), { name: 'alt-enter' });
    expect(next.text).toBe('a\nb');
    expect(next.cursor).toBe(2);
  });
});

describe('applyKey — cursor movement', () => {
  it('moves left and right without leaving the line', () => {
    expect(applyKey(at('abc', 1), { name: 'left' }).cursor).toBe(0);
    expect(applyKey(at('abc', 0), { name: 'left' }).cursor).toBe(0);
    expect(applyKey(at('abc', 2), { name: 'right' }).cursor).toBe(3);
    expect(applyKey(at('abc', 3), { name: 'right' }).cursor).toBe(3);
  });

  it('jumps to the start and end of the line', () => {
    expect(applyKey(at('abc', 2), { name: 'home' }).cursor).toBe(0);
    expect(applyKey(at('abc', 2), { name: 'ctrl-a' }).cursor).toBe(0);
    expect(applyKey(at('abc', 0), { name: 'end' }).cursor).toBe(3);
    expect(applyKey(at('abc', 0), { name: 'ctrl-e' }).cursor).toBe(3);
  });

  it('Alt+Left and Alt+Right move one whitespace-delimited word at a time', () => {
    const text = 'add  a login page';
    expect(applyKey(at(text, text.length), { name: 'alt-left' }).cursor).toBe(13);
    expect(applyKey(at(text, 13), { name: 'alt-left' }).cursor).toBe(7);
    expect(applyKey(at(text, 0), { name: 'alt-right' }).cursor).toBe(5);
    expect(applyKey(at(text, 5), { name: 'alt-right' }).cursor).toBe(7);
  });

  it('word movement stops at the start and end of the input', () => {
    expect(applyKey(at('one', 0), { name: 'alt-left' }).cursor).toBe(0);
    expect(applyKey(at('one', 3), { name: 'alt-right' }).cursor).toBe(3);
  });

  it('up and down move cursor vertically in multi-line text with cols', () => {
    const text = 'abc\ndef\nghi';
    const cols = 80;
    expect(applyKey(at(text, 5), { name: 'up' }, cols).cursor).toBe(1);
    expect(applyKey(at(text, 5), { name: 'down' }, cols).cursor).toBe(9);
  });

  it('up stays at cursor position when trying to move above first line', () => {
    const text = 'abc\ndef';
    const cols = 80;
    expect(applyKey(at(text, 1), { name: 'up' }, cols).cursor).toBe(1);
  });

  it('down stays at cursor when trying to move below last line', () => {
    const text = 'abc\ndef';
    const cols = 80;
    expect(applyKey(at(text, 6), { name: 'down' }, cols).cursor).toBe(6);
  });

  it('up and down move the cursor through a wrapped single-line draft with no literal newline', () => {
    const text = 'one two three four five six seven eight nine ten';
    const cols = 16;
    const end = at(text, text.length);
    const up = applyKey(end, { name: 'up' }, cols);
    expect(up.cursor).toBeLessThan(text.length);
    const backDown = applyKey(up, { name: 'down' }, cols);
    expect(backDown.cursor).toBe(text.length);
  });

  it('up without cols parameter uses history navigation even with multi-line text', () => {
    const s = { ...at('abc\ndef'), history: ['old line'], historyIndex: 1 };
    const up = applyKey(s, { name: 'up' });
    expect(up.text).toBe('old line');
    expect(up.cursor).toBe('old line'.length);
  });
});

describe('cursorPosition', () => {
  it('locates the cursor within an explicit newline-separated line', () => {
    const text = 'abc\ndef\nghi';
    expect(cursorPosition(text, 5, 80)).toEqual({ line: 1, col: 1 });
    expect(cursorPosition(text, 9, 80)).toEqual({ line: 2, col: 1 });
  });

  it('locates the cursor on a word-wrapped line, one extra char per break', () => {
    // wrap('one two three', 4) -> ['one', 'two', 'three'] — each break eats the space.
    expect(cursorPosition('one two three', 5, 4)).toEqual({ line: 1, col: 1 });
  });

  it('does not drift across a hard-split of an over-long word', () => {
    // wrap('abcdefghij', 4) -> ['abcd', 'efgh', 'ij'] — no source char is
    // consumed at a hard split, so the caret must land on the wrapped line
    // that actually holds the character, not one column past the previous one.
    expect(cursorPosition('abcdefghij', 4, 4)).toEqual({ line: 1, col: 0 });
    expect(cursorPosition('abcdefghij', 5, 4)).toEqual({ line: 1, col: 1 });
    expect(cursorPosition('abcdefghij', 8, 4)).toEqual({ line: 2, col: 0 });
  });

  it('places the cursor at the end of the text when it sits past every line', () => {
    const text = 'abc\ndef';
    expect(cursorPosition(text, text.length, 80)).toEqual({ line: 1, col: 3 });
  });
});

describe('applyKey — kill and word deletion', () => {
  it('ctrl-u clears everything before the cursor', () => {
    const next = applyKey(at('hello world', 6), { name: 'ctrl-u' });
    expect(next.text).toBe('world');
    expect(next.cursor).toBe(0);
  });

  it('ctrl-k clears everything from the cursor to the end', () => {
    const next = applyKey(at('hello world', 5), { name: 'ctrl-k' });
    expect(next.text).toBe('hello');
    expect(next.cursor).toBe(5);
  });

  it('ctrl-w deletes the word before the cursor', () => {
    const next = applyKey(at('add a login page'), { name: 'ctrl-w' });
    expect(next.text).toBe('add a login ');
    expect(next.cursor).toBe(12);
  });

  it('ctrl-w swallows the whitespace run before a word', () => {
    const next = applyKey(at('one two   '), { name: 'ctrl-w' });
    expect(next.text).toBe('one ');
  });

  it('Alt+Backspace deletes only the word before the cursor', () => {
    const next = applyKey(at('add a login page'), { name: 'alt-backspace' });
    expect(next.text).toBe('add a login ');
    expect(next.cursor).toBe(12);
  });

  it('Alt+Backspace works in the middle without touching the suffix', () => {
    const next = applyKey(at('alpha beta gamma', 11), { name: 'alt-backspace' });
    expect(next.text).toBe('alpha gamma');
    expect(next.cursor).toBe(6);
  });

  it('Alt+Delete deletes only the next word', () => {
    const fromWord = applyKey(at('alpha beta gamma', 6), { name: 'alt-delete' });
    expect(fromWord.text).toBe('alpha gamma');
    expect(fromWord.cursor).toBe(6);

    const fromSpace = applyKey(at('alpha beta gamma', 5), { name: 'alt-delete' });
    expect(fromSpace.text).toBe('alpha gamma');
    expect(fromSpace.cursor).toBe(5);
  });
});

describe('history', () => {
  const withHistory = (): EditorState => {
    let s = commit(applyKey(emptyEditor(), { name: 'char', char: 'first' }));
    s = commit(applyKey(s, { name: 'char', char: 'second' }));
    return s;
  };

  it('commit records the line and clears the editor', () => {
    const s = commit(applyKey(emptyEditor(), { name: 'char', char: 'hello' }));
    expect(s.text).toBe('');
    expect(s.cursor).toBe(0);
    expect(s.history).toEqual(['hello']);
  });

  it('commit ignores a blank line', () => {
    expect(commit(at('   ')).history).toEqual([]);
  });

  it('commit does not record an immediate duplicate', () => {
    const once = commit(at('same'));
    const twice = commit({ ...once, text: 'same', cursor: 4 });
    expect(twice.history).toEqual(['same']);
  });

  it('up walks backwards through history, most recent first', () => {
    let s = withHistory();
    s = applyKey(s, { name: 'up' });
    expect(s.text).toBe('second');
    s = applyKey(s, { name: 'up' });
    expect(s.text).toBe('first');
    s = applyKey(s, { name: 'up' });
    expect(s.text).toBe('first');
  });

  it('down walks forwards and restores the parked draft', () => {
    let s = { ...withHistory(), text: 'draft', cursor: 5 };
    s = applyKey(s, { name: 'up' });
    expect(s.text).toBe('second');
    s = applyKey(s, { name: 'down' });
    expect(s.text).toBe('draft');
    expect(s.cursor).toBe(5);
  });

  it('places the cursor at the end of a recalled line', () => {
    const s = applyKey(withHistory(), { name: 'up' });
    expect(s.cursor).toBe('second'.length);
  });
});
