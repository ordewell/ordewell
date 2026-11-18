import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { stripAnsi, width, wrapLines } from '../ansi';

// `width` answers the common text without asking string-width. Whatever it
// skips, it must answer exactly as string-width would: one column off shifts
// every column of the row to its right, the pane divider with it.

/** A small seeded generator, so a failure names a string that comes back. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));

const ALPHABETS: string[][] = [
  range(0x20, 0x7e),
  // Latin-1, the punctuation block and Latin Extended: mostly one column, with
  // the few string-width measures otherwise (soft hyphen, ©, ®, ‼, ⁉, a zero-width space).
  range(0xa0, 0x17f),
  range(0x2000, 0x206f),
  // CJK, kana, Hangul and fullwidth forms: two columns.
  [...range(0x4e00, 0x4e40), ...range(0x3040, 0x3060), ...range(0xac00, 0xac20), ...range(0xff01, 0xff20)],
  // Combining marks, alone and after a base.
  [...range(0x300, 0x36f), 'é', 'ạ̈', '⃝', '️', '‍'],
  ['👍', '👍🏽', '👨‍👩‍👧', '⚠️', '⚠', '🇮🇹', '❤', '❤️', '#️⃣', '✅', '❯', '◐', '✓', '🧑‍💻', '☺'],
  ['\x1b[31m', '\x1b[0m', '\x1b[1;38;5;31m', '\x1b]0;title\x07', '\x1b[2K', '\x1b(B', '\x1b[10C'],
  ['\x07', '\x00', '\x7f', '\x85', '\x9b', '\x9b31m', '\t', '\n', ' '],
  // A prepended mark joins whatever follows it, the space between two words included.
  ['\u0600', '\u0605', '\u06dd', 'x\u0600', '\u0e40'],
];

function sample(next: () => number): string {
  const length = Math.floor(next() * 24);
  let out = '';
  // Most strings stay inside one or two alphabets, as real titles do, so the
  // fast path is taken often enough to be the thing tested.
  const own = [ALPHABETS[Math.floor(next() * ALPHABETS.length)], ALPHABETS[0]];
  for (let i = 0; i < length; i++) {
    const pool = next() < 0.85 ? own[Math.floor(next() * own.length)] : ALPHABETS[Math.floor(next() * ALPHABETS.length)];
    out += pool[Math.floor(next() * pool.length)];
  }
  return out;
}

const reference = (text: string): number => stringWidth(stripAnsi(text));

describe('width', () => {
  it('measures every code point below U+3000 as string-width does', () => {
    const wrong = range(0x20, 0x2fff).filter((ch) => width(ch) !== reference(ch));
    expect(wrong.map((ch) => ch.codePointAt(0)!.toString(16))).toEqual([]);
  });

  it('measures generated text mixing scripts, marks, emoji and escapes as string-width does', () => {
    const next = random(294);
    const wrong: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const text = sample(next);
      if (width(text) !== reference(text)) wrong.push(JSON.stringify(text));
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });
});

/**
 * The word wrap as it was before it kept a running width: it measured the whole
 * candidate line for every word, so it is the slow but plain statement of what
 * a wrap must produce.
 */
function wrapByRemeasuring(text: string, max: number): { line: string; start: number }[] {
  if (max <= 0) return [{ line: '', start: 0 }];
  const out: { line: string; start: number }[] = [];
  let pos = 0;
  for (const paragraph of text.split('\n')) {
    let current = '';
    let currentStart = pos;
    let first = true;
    let wordPos = pos;
    for (const piece of paragraph.split(' ')) {
      // A word wider than the line is cut by the wrap itself; the remeasuring
      // only concerns where whole words go, so long words stay out of the samples.
      if (reference(piece) > max) throw new Error('sample has a word wider than the line');
      const candidate = first ? piece : `${current} ${piece}`;
      const candidateStart = first ? wordPos : currentStart;
      first = false;
      if (reference(candidate) > max) {
        out.push({ line: current, start: currentStart });
        current = piece;
        currentStart = wordPos;
      } else {
        current = candidate;
        currentStart = candidateStart;
      }
      wordPos += piece.length + 1;
    }
    out.push({ line: current, start: currentStart });
    pos += paragraph.length + 1;
  }
  return out.length > 0 ? out : [{ line: '', start: 0 }];
}

describe('wrapLines', () => {
  it('breaks generated text where measuring each whole candidate line would', () => {
    const next = random(1141);
    let compared = 0;
    for (let i = 0; i < 4_000; i++) {
      const max = 6 + Math.floor(next() * 30);
      const words = Array.from({ length: 1 + Math.floor(next() * 14) }, () => sample(next).replace(/[ \n]/g, ''));
      const text = words.filter((w) => reference(w) <= max).join(next() < 0.1 ? '\n' : ' ');
      expect(wrapLines(text, max), JSON.stringify({ text, max })).toEqual(wrapByRemeasuring(text, max));
      compared++;
    }
    expect(compared).toBe(4_000);
  });
});
