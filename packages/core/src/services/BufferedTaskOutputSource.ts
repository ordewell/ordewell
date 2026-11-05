import type { IRunnerSession } from '../interfaces/IRunner';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { outputLines } from '../conversation/format';
import { storedHandoff, type StoredHandoff } from '../models/Handoff';
import { scriptHandoff } from '../models/DerivedHandoff';
import type { ScriptExit } from '../interfaces/IRunner';
import type { TaskCompleteArgs } from './mcp/tools';
import { openValueStart, redactAgentText } from '../utils/redactSecrets';
import { cutHead, redactUnder, tooLong } from '../utils/lineTail';

/** Enough output for a summary tail and a live read, without holding a long run's whole log. */
const DEFAULT_MAX_BUFFER_CHARS = 256 * 1024;
/** What an ended attempt keeps: its verdict has read the rest, and a plan outlives thousands of them. */
const ENDED_TAIL_CHARS = 16 * 1024;

interface Capture {
  raw: string;
  /** The line the last cut kept hidden above `raw`, for its redaction to read with ({@link cutHead}). */
  head: string;
  /**
   * Where `raw` starts in the output, in characters: what was discarded from
   * its front to keep it bounded, less the note that stands for a line too
   * long to keep.
   */
  dropped: number;
  /** Length of a newest line longer than the buffer, dropped whole while it is still being written. */
  skipped?: number;
  /** Length of the note `raw` opens with, for such a line now ended: a reader inside that line has seen the note. */
  noted?: number;
  attached: boolean;
  exited: boolean;
  /** The runner's `task_complete` call, whole: its handoff is what it said it did (ADR-0047). */
  completion?: TaskCompleteArgs;
  /** A script task's end and the time its steps took (ADR-0047): its handoff is derived from them. */
  script?: { exit: ScriptExit; durationMs: number };
  /** Time the script's steps ran so far, from the exit each reports. */
  stepsMs: number;
  turnStart?: number;
  /**
   * Redacts runner text, with the secrets Ordewell held for the attempt when
   * its session holds them: the one record every read of this capture redacts
   * with (ADR-0061, H1).
   */
  redact: (text: string) => string;
}

/** Output as a reader sees it, each line's trailing space dropped. */
function plain(raw: string): string {
  return outputLines(raw).map((line) => line.trimEnd()).join('\n');
}

/**
 * What every read of the output starts from: runner text, redacted whole
 * before any read cuts it to its lines or a report cuts it to its budget, as a
 * cut can keep a value and drop the name that marks it. Trimmed only after:
 * a trim is a cut too, and taking a quoted first line's leading space parts
 * it from the ` > ` the lines below it open with.
 */
function clean(capture: Capture, raw: string): string {
  return capture.redact(plain(raw)).trim();
}

/** Owns one bounded output buffer per task attempt, fed from the attempt's session. */
export class BufferedTaskOutputSource implements TaskOutputSource {
  private captures = new Map<string, Capture>();
  private maxBufferChars: number;

  constructor(opts: { maxBufferChars?: number } = {}) {
    this.maxBufferChars = opts.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  }

  attach(taskId: string, session: IRunnerSession): void {
    const secrets = session.secrets;
    const redact = secrets ? (text: string) => secrets.redact(text) : redactAgentText;
    const capture: Capture = { raw: '', head: '', dropped: 0, attached: true, exited: false, stepsMs: 0, redact };
    this.captures.set(taskId, capture);
    session.onOutput((text) => {
      if (capture.attached) this.append(capture, text);
    });
    session.onExit(() => {
      capture.exited = true;
    });
    session.onEvent((event) => {
      if (capture.attached && event.type === 'script_exit') capture.stepsMs += event.durationMs;
      // A message read mid-turn starts the account of the work afresh, as a new turn does (ADR-0023).
      // Ordewell's completion reminder asks for no new work, so the report before it stays.
      if (capture.attached && (event.type === 'turn_start' || event.type === 'message_delivered') && event.from !== 'ordewell') {
        capture.completion = undefined;
        capture.turnStart = capture.dropped + capture.raw.length;
      }
    });
    session.onTaskComplete((completion) => {
      if (capture.attached) capture.completion = completion;
    });
    session.onScriptExit((exit) => {
      if (capture.attached) capture.script = { exit, durationMs: capture.stepsMs };
    });
  }

  detach(taskId: string): void {
    const capture = this.captures.get(taskId);
    if (!capture) return;
    capture.attached = false;
    this.cutTo(capture, ENDED_TAIL_CHARS);
    // A slice keeps the string it was cut from alive, so only a copy frees the buffer.
    capture.raw = Buffer.from(capture.raw).toString();
    capture.head = Buffer.from(capture.head).toString();
  }

  reset(): void {
    for (const capture of this.captures.values()) capture.attached = false;
    this.captures.clear();
  }

  finalText(taskId: string): string {
    const capture = this.captures.get(taskId);
    if (!capture) return '';
    const reported = this.report(taskId);
    if (reported) return reported;
    return this.readFrom(capture, Math.min(Math.max(0, (capture.turnStart ?? 0) - capture.dropped), buffered(capture).length));
  }

  report(taskId: string): string | undefined {
    const capture = this.captures.get(taskId);
    const summary = capture?.completion?.summary.trim();
    return capture && summary ? capture.redact(summary) : undefined;
  }

  handoff(taskId: string): StoredHandoff | undefined {
    const capture = this.captures.get(taskId);
    if (capture?.script) return scriptHandoff(capture.script.exit, capture.script.durationMs, this.readFrom(capture, 0));
    return capture?.completion && storedHandoff(capture.completion, capture.redact);
  }

  liveTail(taskId: string, opts: LiveTailOptions): LiveTail | null {
    const capture = this.captures.get(taskId);
    if (!capture) return null;
    const total = capture.dropped + capture.raw.length;
    const since = Math.min(Math.max(0, (opts.sinceOffset ?? 0) - capture.dropped), capture.raw.length);
    const from = capture.noted !== undefined && since > 0 && since < capture.noted ? capture.noted : since;
    const lines = this.readFrom(capture, from).split('\n');
    const kept = opts.maxLines > 0 ? lines.slice(-opts.maxLines) : [];
    return {
      text: kept.join('\n'),
      nextOffset: total,
      running: capture.attached && !capture.exited,
    };
  }

  /**
   * The output from `from`, in the buffer, redacted with the start of its
   * line: the name of a value split across two chunks is in the part already
   * read. A value known only by a line above it, a private key's body or a
   * value below its name, is read from that line ({@link openValueStart}), or,
   * when the buffer's cut dropped it, from the head the cut kept hidden.
   */
  private readFrom(capture: Capture, from: number): string {
    const { head } = capture;
    const raw = head + buffered(capture);
    const at = head.length + from;
    const line = at === 0 ? 0 : raw.lastIndexOf('\n', at - 1) + 1;
    const start = openValueStart(raw, line) ?? line;
    if (start === at) return clean(capture, raw.slice(at));
    const shownFrom = Math.max(start, head.length);
    const shown = plain(raw.slice(shownFrom, at));
    const redacted = start < head.length
      ? redactUnder(plain(head), `\n${plain(raw.slice(head.length))}`, capture.redact)
      : capture.redact(plain(raw.slice(start)));
    // Unless redacting the whole line changed the part already read, show only the rest of it.
    return (redacted.startsWith(shown) ? redacted.slice(shown.length) : redacted).trim();
  }

  private append(capture: Capture, text: string): void {
    if (capture.skipped !== undefined) {
      const end = text.indexOf('\n');
      capture.dropped += end < 0 ? text.length : end;
      if (end < 0) {
        capture.skipped += text.length;
        return;
      }
      const note = tooLong(capture.skipped + end, 'keep');
      capture.raw = note;
      capture.dropped -= note.length;
      capture.skipped = undefined;
      capture.noted = note.length;
      text = text.slice(end);
    }
    capture.raw += text;
    this.cutTo(capture, this.maxBufferChars);
  }

  /**
   * Bound the buffer by whole lines, as LineTail does: a cut inside a
   * line can keep a value and drop the name that marks it, before any read
   * has redacted the two together.
   */
  private cutTo(capture: Capture, maxChars: number): void {
    const excess = capture.raw.length - maxChars;
    if (excess <= 0) return;
    const newest = capture.raw.lastIndexOf('\n') + 1;
    if (capture.raw.length - newest > maxChars) {
      // Only the newest line can outgrow the buffer on its own: keep none of it, and none of the lines before it.
      capture.head = cutHead(capture.head, capture.raw, newest);
      capture.skipped = capture.raw.length - newest;
      capture.dropped += capture.raw.length;
      capture.raw = '';
      capture.noted = undefined;
      return;
    }
    const cut = capture.raw.indexOf('\n', excess - 1) + 1;
    if (cut > 0) capture.head = cutHead(capture.head, capture.raw, cut);
    capture.raw = capture.raw.slice(cut);
    capture.dropped += cut;
    if (cut > 0) capture.noted = undefined;
  }
}

/** The output a read starts from: the buffer, and the note for a line it is dropping as it comes. */
function buffered(capture: Capture): string {
  return capture.skipped === undefined ? capture.raw : capture.raw + tooLong(capture.skipped, 'keep');
}
