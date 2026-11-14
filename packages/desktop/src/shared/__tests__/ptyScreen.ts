/**
 * The lines a terminal would show for what a shell wrote to its pty, for tests
 * that type into a real shell and read back what a command printed.
 *
 * A shell surrounds its output with control sequences that differ by version:
 * bash 5 turns bracketed paste off before running a line and on again before
 * the next prompt (`\r\n\e[?2004l\rone two three\r\n\e[?2004h$ `), and bash 3.2
 * has no such mode (`\r\none two three\r\n$ `). Reading the output as a screen
 * rather than matching bytes takes both alike.
 *
 * Interpreted: carriage return, line feed, backspace, and the CSI cursor
 * forward/back (C/D), insert (@), delete (P) and erase to the end of the line
 * (K) a line editor redraws with. Every other escape sequence (modes, colours,
 * OSC titles) and C0 control is dropped, since none of them prints. Output is
 * read as if it began at column 0, so a slice taken after a prompt draws its
 * first line shifted by the prompt's width.
 */

const ESC = '\x1b';
const BEL = '\x07';

/** Where an escape sequence starting at `at` ends, and its CSI final byte and parameter if it is one. */
function escapeAt(text: string, at: number): { end: number; csi?: { final: string; n: number } } {
  const kind = text[at + 1];
  if (kind === '[') {
    let i = at + 2;
    while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x3f) i++;
    if (i >= text.length) return { end: text.length };
    const params = text.slice(at + 2, i);
    const n = /^\d+$/.test(params) ? Number(params) : 1;
    return { end: i + 1, csi: { final: text[i], n: Math.max(n, 1) } };
  }
  if (kind === ']' || kind === 'P' || kind === '_' || kind === '^') {
    // A string, ended by BEL or ST (ESC \).
    for (let i = at + 2; i < text.length; i++) {
      if (text[i] === BEL) return { end: i + 1 };
      if (text[i] === ESC && text[i + 1] === '\\') return { end: i + 2 };
    }
    return { end: text.length };
  }
  // ESC, any intermediates (0x20-0x2f), then one final byte: `ESC =`, `ESC ( B`.
  let i = at + 1;
  while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i++;
  return { end: Math.min(i + 1, text.length) };
}

export function screenLines(output: string): string[] {
  const lines: string[][] = [[]];
  let col = 0;
  const line = () => lines[lines.length - 1];
  for (let i = 0; i < output.length;) {
    const ch = output[i];
    if (ch === ESC) {
      const { end, csi } = escapeAt(output, i);
      i = end;
      if (!csi) continue;
      const row = line();
      while (row.length < col) row.push(' ');
      if (csi.final === 'C') col += csi.n;
      else if (csi.final === 'D') col = Math.max(0, col - csi.n);
      else if (csi.final === '@') row.splice(col, 0, ...' '.repeat(csi.n));
      else if (csi.final === 'P') row.splice(col, csi.n);
      else if (csi.final === 'K') row.length = Math.min(row.length, col);
      continue;
    }
    i++;
    if (ch === '\n') { lines.push([]); col = 0; }
    else if (ch === '\r') col = 0;
    else if (ch === '\b') col = Math.max(0, col - 1);
    else if (ch.charCodeAt(0) >= 0x20 && ch !== '\x7f') {
      const row = line();
      while (row.length < col) row.push(' ');
      row[col++] = ch;
    }
  }
  return lines.map((row) => row.join('').trimEnd());
}

/**
 * The first line starting with `start` that a line feed began and another
 * ended: a command's whole output line, not a prefix of it while it is still
 * arriving, and never the first line, which the slice may have started inside.
 */
export function completedLine(output: string, start: string): string | undefined {
  return screenLines(output).slice(1, -1).find((text) => text.startsWith(start));
}
