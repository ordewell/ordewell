import { describe, it, expect } from 'vitest';
import { renderCleanCapture } from '../terminalRender';

const MARKER = '<<<ORDEWELL_DONE_mk-1>>>';

/** Paint the way a screen-painting agent TUI does: content at an absolute
 *  position, then a spinner/status-bar repaint below it, then the marker. */
function paintedScreen(): string {
  return [
    'The migration is complete and all tests pass.',
    '\x1b[3;1HDone. 12 files changed.',           // answer row, absolute position
    `\x1b[14;1H${MARKER}`,
    '\x1b[20;1H────────────────────────────────', // border repaint
    '\x1b[21;1H✻ Cooked for 12m 49s · ctx: 215.0k', // spinner/status chrome
    '\x1b[22;1H⏵⏵ bypass permissions on',
  ].join('\r\n');
}

describe('renderCleanCapture', () => {
  it('cuts a painted screen at the marker row, dropping chrome below it', () => {
    const out = renderCleanCapture(paintedScreen(), MARKER);
    expect(out).toContain('Done. 12 files changed.');
    expect(out).not.toContain('Cooked for');
    expect(out).not.toContain('bypass permissions');
    expect(out).not.toContain('──────');
    expect(out).not.toContain('ORDEWELL');
  });

  it('keeps the marker row when no marker token is passed', () => {
    const out = renderCleanCapture(paintedScreen());
    expect(out).toContain('Done. 12 files changed.');
    expect(out).toContain('Cooked for'); // chrome remains without an anchor
  });

  it('falls back to the full render when the marker never appears', () => {
    const raw = 'partial output, task died\nmore output';
    expect(renderCleanCapture(raw, MARKER)).toContain('partial output, task died');
  });

  it('is a near-identity for plain headless stdout ( chronological text)', () => {
    const raw = 'line one\nline two';
    expect(renderCleanCapture(raw, MARKER)).toBe('line one\nline two');
  });

  it('finds a marker split across two rendered rows via the two-row window', () => {
    const raw = [
      'All checks passed.',
      '\x1b[9;1H<<<ORDEW',
      '\x1b[10;1HELL_DONE_mk-1>>>',
      '\x1b[21;1Hctx: 8.0% used',
    ].join('\r\n');
    const out = renderCleanCapture(raw, MARKER);
    expect(out).toContain('All checks passed.');
    expect(out).not.toContain('ctx: 8.0%');
  });
});