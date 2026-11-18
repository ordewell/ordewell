import { describe, it, expect, vi } from 'vitest';

// The composer wraps up to 8KB on every keystroke, and a pasted single-line
// blob reaches that cap as one word. Asking string-width about each character
// of an all-ASCII word costs far more than laying it out, so the wrap must not.
vi.mock('string-width', async (importOriginal) => {
  const actual = await importOriginal<typeof import('string-width')>();
  return { default: vi.fn(actual.default) };
});

import stringWidth from 'string-width';
import { width, wrapLines } from '../ansi';

describe('wrapping a long ASCII run', () => {
  it('does not measure the word one character at a time', () => {
    const measure = vi.mocked(stringWidth);
    measure.mockClear();

    wrapLines('x'.repeat(4_096), 40);

    expect(measure.mock.calls.length).toBeLessThan(500);
  });
});

describe('wrapping a line of words that are not ASCII', () => {
  it('measures each word once, not every candidate line again', () => {
    const measure = vi.mocked(stringWidth);
    const text = Array.from({ length: 2_000 }, (_, i) => `日本${i % 10}`).join(' ');
    measure.mockClear();

    wrapLines(text, 80);

    const measured = measure.mock.calls.reduce((sum, [arg]) => sum + String(arg).length, 0);
    // Re-measuring the candidate line costs about half a line per word: ~40 here.
    expect(measured).toBeLessThan(text.length * 3);
  });
});

describe('the wrap memo', () => {
  it('keeps every title of a plan of thousands of tasks', () => {
    const titles = Array.from({ length: 6_000 }, (_, i) => `Task ${i}: make the plan pane cheap to paint when it holds many rows`);
    const first = wrapLines(titles[0], 40);
    for (const title of titles) wrapLines(title, 40);

    expect(wrapLines(titles[0], 40)).toBe(first);
  });

  it('lets go of what it held once the text it holds grows past its bound', () => {
    const blob = (i: number) => `${i} ${'word '.repeat(40_000)}`;
    const first = wrapLines(blob(0), 40);
    for (let i = 1; i < 40; i++) wrapLines(blob(i), 40);

    expect(wrapLines(blob(0), 40)).not.toBe(first);
  });
});

describe('measuring a painted row', () => {
  it('asks string-width only about the glyphs that are not plain text', () => {
    const measure = vi.mocked(stringWidth);
    const row = `${'\x1b[32m✓\x1b[0m  4 \x1b[90m AI\x1b[0m Make the plan pane cheap to paint'.padEnd(80)}\x1b[K\x1b[76G\x1b[90m│\x1b[0m ${'Task 12 with a title of a few words'.padEnd(80)}`;
    measure.mockClear();

    width(row);

    const measured = measure.mock.calls.reduce((sum, [arg]) => sum + String(arg).length, 0);
    expect(measured).toBeLessThan(12);
  });
});
