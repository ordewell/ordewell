/**
 * Bounded text that is cut only between lines, so that redaction never sees
 * half of what it has to recognise. A credential's name and value share a
 * line; a cut inside that line can leave a value with no name, or the end of
 * a name a rule no longer matches, and each such cut once needed its own
 * patch. Cutting only whole lines from the raw text, redacting what is kept as
 * a whole, and cutting the redacted result for display removes that class of
 * leak instead: a part of redacted text cannot hold more than all of it.
 */

import { openValueStart } from './redactSecrets';

export interface LineTailLimits {
  /** Raw chars kept for redaction. Larger than `showChars`, so a line that will be shown is never one the buffer had to cut. */
  keepChars: number;
  /** Chars of redacted text {@link LineTail.read} returns. */
  showChars: number;
}

export const tooLong = (chars: number, verb: string) => `[a line of ${chars} chars, too long to ${verb}]`;

/**
 * Where to cut the oldest whole lines from `text` to keep `keepChars`. With no
 * line longer than that, a newline at or after `excess - 1` exists, and
 * cutting through it cuts enough.
 */
function oldestLinesEnd(text: string, keepChars: number): number {
  const excess = text.length - keepChars;
  return excess <= 0 ? 0 : text.indexOf('\n', excess - 1) + 1;
}

/**
 * The line a cut at `cut`, a line start in `text`, keeps hidden above what it
 * keeps (ADR-0061, C1). A whole-line cut keeps a name beside a value on its
 * line, but some values are known only by a line above them: a private key's
 * body by its BEGIN line, a YAML block or next-line value by the name that
 * ends the line above, a sibling `value` by the `name` field before it. A cut
 * between the two leaves a value that no rule marks. So a cut inside such an
 * open value keeps the line that names it, never shown, for the redaction of
 * what is left to read with ({@link redactUnder}).
 *
 * @param head The line the text's last cut kept hidden, which `text` starts after.
 */
export function cutHead(head: string, text: string, cut: number): string {
  const whole = head + text;
  const start = openValueStart(whole, head.length + cut);
  return start === undefined ? '' : whole.slice(start, whole.indexOf('\n', start) + 1);
}

/**
 * `text` redacted under `head`, the line its cut kept hidden: redacted with
 * it, then cut from what is returned. No rule joins two lines or splits one,
 * so the head is the first line of what comes back.
 */
export function redactUnder(head: string, text: string, redact: (text: string) => string): string {
  if (!head) return redact(text);
  const out = redact(head + text);
  const newline = out.indexOf('\n');
  return newline < 0 ? '' : out.slice(newline + 1);
}

export class LineTail {
  private text = '';
  /** The line the last cut kept hidden above `text` ({@link cutHead}). */
  private head = '';
  /** Length of a newest line longer than `keepChars`, dropped whole while it is still being written. */
  private skipped: number | undefined;

  constructor(private readonly limits: LineTailLimits) {}

  append(chunk: string): void {
    if (this.skipped !== undefined) {
      const end = chunk.indexOf('\n');
      if (end < 0) {
        this.skipped += chunk.length;
        return;
      }
      this.text += tooLong(this.skipped + end, 'keep');
      this.skipped = undefined;
      chunk = chunk.slice(end);
    }
    this.text += chunk;
    if (this.text.length <= this.limits.keepChars) return;
    const start = this.text.lastIndexOf('\n') + 1;
    if (this.text.length - start > this.limits.keepChars) {
      // Only the newest line can outgrow what is kept on its own: keep none of it, and the lines before it.
      this.skipped = this.text.length - start;
      this.text = this.text.slice(0, start);
    }
    const cut = oldestLinesEnd(this.text, this.limits.keepChars);
    if (cut === 0) return;
    this.head = cutHead(this.head, this.text, cut);
    this.text = this.text.slice(cut);
  }

  /**
   * Redact everything kept, then cut the redacted text to `showChars`,
   * starting at a line when one starts inside the cut.
   */
  read(redact: (text: string) => string): string {
    const kept = this.skipped === undefined ? this.text : this.text + tooLong(this.skipped, 'keep');
    const clean = redactUnder(this.head, kept, redact).trim();
    if (clean.length <= this.limits.showChars) return clean;
    const cut = clean.slice(-this.limits.showChars);
    if (clean[clean.length - cut.length - 1] === '\n') return cut;
    const newline = cut.indexOf('\n');
    return newline < 0 ? cut : cut.slice(newline + 1);
  }
}

/**
 * The longest run of whole lines from the start of `text` within `maxChars`,
 * for output that is cut before it is redacted: a cut between lines keeps
 * every credential's name beside its value.
 */
export function headLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const newline = text.lastIndexOf('\n', maxChars);
  if (newline >= 0) return text.slice(0, newline);
  const first = text.indexOf('\n');
  return tooLong(first < 0 ? text.length : first, 'show');
}
