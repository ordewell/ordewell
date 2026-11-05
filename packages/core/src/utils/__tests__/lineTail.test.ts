import { describe, it, expect } from 'vitest';
import { LineTail, headLines } from '../lineTail';

const same = (text: string) => text;
const lines = (from: number, count: number) => Array.from({ length: count }, (_, i) => `line ${String(from + i).padStart(3, '0')}`).join('\n');

describe('LineTail', () => {
  it('shows all of a short tail, trimmed', () => {
    const tail = new LineTail({ keepChars: 100, showChars: 50 });
    tail.append('one\ntwo\n');
    expect(tail.read(same)).toBe('one\ntwo');
  });

  it('hands the redactor the whole retained text, and cuts only what it returns', () => {
    const tail = new LineTail({ keepChars: 1000, showChars: 30 });
    tail.append(`NAME=secret-value\n${lines(0, 10)}\n`);
    const seen: string[] = [];
    const shown = tail.read((text) => { seen.push(text); return text.replace('secret-value', '[gone]'); });
    expect(seen).toEqual([`NAME=secret-value\n${lines(0, 10)}\n`]);
    expect(shown.length).toBeLessThanOrEqual(30);
    expect(shown).toBe(lines(7, 3));
  });

  it('starts what it shows at a line, never inside one', () => {
    const tail = new LineTail({ keepChars: 1000, showChars: 20 });
    tail.append(lines(0, 10));
    // Each line is 8 chars and a newline, so 20 chars reach into the third line from the end.
    expect(tail.read(same)).toBe(lines(8, 2));
  });

  it('keeps the line the cut would start at when the cut falls right after a newline', () => {
    const tail = new LineTail({ keepChars: 1000, showChars: 17 });
    tail.append(lines(0, 10));
    expect(tail.read(same)).toBe(lines(8, 2));
    const exact = new LineTail({ keepChars: 1000, showChars: 26 });
    exact.append(lines(0, 10));
    expect(exact.read(same)).toBe(lines(7, 3));
  });

  it('shows the end of one redacted line longer than the tail, since nothing in it is secret any more', () => {
    const tail = new LineTail({ keepChars: 1000, showChars: 10 });
    tail.append('x'.repeat(40));
    expect(tail.read(same)).toBe('x'.repeat(10));
  });

  it('evicts whole lines from what it keeps, never part of one', () => {
    const tail = new LineTail({ keepChars: 30, showChars: 1000 });
    for (let i = 0; i < 20; i++) tail.append(`${lines(i, 1)}\n`);
    let kept = '';
    tail.read((text) => { kept = text; return text; });
    expect(kept.length).toBeLessThanOrEqual(30);
    expect(kept).toBe(`${lines(17, 3)}\n`);
  });

  it('joins a line written across several chunks before it judges it', () => {
    const tail = new LineTail({ keepChars: 1000, showChars: 1000 });
    tail.append('NA');
    tail.append('ME=sec');
    tail.append('ret\nnext');
    let kept = '';
    tail.read((text) => { kept = text; return text; });
    expect(kept).toBe('NAME=secret\nnext');
  });

  it('keeps no part of a line longer than it keeps, and says one was there', () => {
    const tail = new LineTail({ keepChars: 50, showChars: 1000 });
    tail.append('before\n');
    tail.append('y'.repeat(30));
    tail.append('y'.repeat(30));
    tail.append('y'.repeat(30) + '\nafter\n');
    const shown = tail.read(same);
    expect(shown).not.toContain('y');
    expect(shown).toBe('[a line of 90 chars, too long to keep]\nafter');
  });

  it('keeps the lines before a line too long to keep that is still being written', () => {
    const tail = new LineTail({ keepChars: 30, showChars: 1000 });
    tail.append('before\n' + 'z'.repeat(40));
    expect(tail.read(same)).toBe('before\n[a line of 40 chars, too long to keep]');
  });

  it('stays within what it keeps when one chunk holds many lines and then one too long', () => {
    const tail = new LineTail({ keepChars: 50, showChars: 1000 });
    tail.append('a\n'.repeat(100) + 'y'.repeat(100));
    let kept = '';
    tail.read((text) => { kept = text; return text; });
    expect(kept).toBe('a\n'.repeat(25) + '[a line of 100 chars, too long to keep]');
  });

  it('keeps a name and its value together wherever the eviction falls', () => {
    const line = 'MISTRAL_API_KEY="aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake"';
    const value = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
    const keep = 200;
    for (let offset = 0; offset <= line.length; offset++) {
      const tail = new LineTail({ keepChars: keep, showChars: keep });
      // Pad after the line so the oldest char the buffer could keep falls `offset` chars into it.
      const after = '\n' + 'p'.repeat(keep - (line.length - offset) - 1);
      tail.append(`head\n${line}`);
      tail.append(after);
      let kept = '';
      tail.read((text) => { kept = text; return text; });
      expect(kept.includes(line) || !kept.includes(value.slice(-8)), `offset ${offset}`).toBe(true);
      expect(kept.includes(line) || !kept.includes('MISTRAL'), `offset ${offset}`).toBe(true);
    }
  });
});

describe('headLines', () => {
  it('returns text within the limit unchanged', () => {
    expect(headLines('a\nb', 10)).toBe('a\nb');
  });

  it('keeps whole lines from the start, never part of one', () => {
    expect(headLines(lines(0, 10), 20)).toBe(lines(0, 2));
  });

  it('keeps the last line when the limit falls right after it', () => {
    expect(headLines(lines(0, 10), 17)).toBe(lines(0, 2));
  });

  it('says so when even the first line is longer than the limit', () => {
    expect(headLines('x'.repeat(40) + '\nnext', 10)).toBe('[a line of 40 chars, too long to show]');
  });
});
