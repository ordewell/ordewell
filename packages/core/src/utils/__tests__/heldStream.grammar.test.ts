import { describe, expect, it } from 'vitest';
import { heldStream, hideHeld, withoutTerminalEscapes } from '../redactSecrets';

// Fake values, of the shape a held key has.
const HELD = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
const SHORT = 'Zq9Zq9Zq';

const streamed = (text: string, held: Iterable<string>, size: (i: number) => number): string => {
  const pipe = heldStream(held);
  let out = '';
  for (let i = 0; i < text.length; ) {
    const n = size(i);
    out += pipe.write(text.slice(i, i + n));
    i += n;
  }
  return out + pipe.end();
};

describe('heldStream reads escapes as hideHeld does, at the edges of the grammar (ADR-0061, H1)', () => {
  it('a CSI is bounded at 128 params and 16 intermediates, an OSC at 4096 payload chars', () => {
    expect(withoutTerminalEscapes(`a\x1b[${'1'.repeat(128)}mb`)).toBe('ab');
    expect(withoutTerminalEscapes(`a\x1b[${'1'.repeat(129)}mb`)).toBe(`a\x1b[${'1'.repeat(129)}mb`);
    expect(withoutTerminalEscapes(`a\x1b[${' '.repeat(16)}mb`)).toBe('ab');
    expect(withoutTerminalEscapes(`a\x1b[${' '.repeat(17)}mb`)).toBe(`a\x1b[${' '.repeat(17)}mb`);
    expect(withoutTerminalEscapes(`a\x1b]${'p'.repeat(4096)}\x07b`)).toBe('ab');
    expect(withoutTerminalEscapes(`a\x1b]${'p'.repeat(4097)}\x07b`)).toBe('ap\x07b');
  });

  it('text past an escape\'s bound is shown as it comes, not held back as an escape', () => {
    const pipe = heldStream([HELD]);
    const text = `x \x1b[${'2'.repeat(200)}`;
    expect(pipe.write(text)).toBe(text);
    const osc = `\x1b]${'p'.repeat(5000)}`;
    expect(pipe.write(osc).length).toBeGreaterThanOrEqual(osc.length - 4096 - 2);
  });

  it('split anywhere, a stream shows what the whole text shows, malformed and bounded escapes among values', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
    const pieces = [
      HELD, HELD.slice(0, 9), HELD.slice(3, 17), HELD.slice(-9), HELD.slice(0, 7), SHORT, SHORT.slice(0, 5), ' ', '\n', 'w', 'm', 'B', 'F',
      '\x1b', '\x1b[', '\x1b]', '\x1b(', '\x1b[1', '\x1b[1;2', '\x1b[1 ', '\x1b[ 1m', '\x1b\x1b[0m', '\x1b]0;', '\x07', '\x1b\\', '\x1b[0m',
      '\x1b(B', '\x1b=', '\x1b]8;;x\x1b\\',
      `\x1b[${'1'.repeat(128)}m`, `\x1b[${'1'.repeat(129)}m`, `\x1b[${' '.repeat(16)}m`, `\x1b[${' '.repeat(17)}m`,
      `\x1b]${'p'.repeat(4096)}\x07`, `\x1b]${'p'.repeat(4097)}\x07`, `\x1b]${'p'.repeat(4096)}`, `\x1b]${'p'.repeat(4095)}\x1b`,
    ];
    const failures: string[] = [];
    for (let n = 0; n < 1500 && failures.length < 3; n++) {
      let text = '';
      for (let k = 1 + Math.floor(random() * 14); k > 0; k--) text += pick(pieces);
      const held = random() < 0.5 ? [HELD] : [HELD, SHORT];
      const most = pick([1, 3, 9, 200, 5000]);
      if (streamed(text, held, () => 1 + Math.floor(random() * most)) !== hideHeld(text, held)) failures.push(JSON.stringify(text.slice(0, 300)));
    }
    expect(failures).toEqual([]);
  });

  it('a value held after the stream started is hidden from then on, and a stream ended can be written again', () => {
    const held = new Set<string>();
    const pipe = heldStream(held);
    expect(pipe.write('a \x1b[3')).toBe('a \x1b[3');
    held.add(HELD);
    expect(pipe.write(`1m ${HELD} x`)).toBe('1m [REDACTED secret: 36 chars] x');
    expect(pipe.end()).toBe('');
    expect(pipe.write(`again ${HELD.slice(0, 4)}`) + pipe.end(`${HELD.slice(4)}\n`)).toBe('again [REDACTED secret: 36 chars]\n');
  });

  it('a set of held values that gains one is read afresh, not from what was derived before', () => {
    const held = new Set([HELD]);
    expect(hideHeld(`y ${SHORT}`, held)).toBe(`y ${SHORT}`);
    held.add(SHORT);
    expect(hideHeld(`y ${SHORT}`, held)).toBe('y [REDACTED secret: 8 chars]');
  });
});
