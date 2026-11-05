import type { IRunnerSession } from '../interfaces/IRunner';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { outputLines } from '../conversation/format';
import { storedHandoff, type StoredHandoff } from '../models/Handoff';
import { scriptHandoff } from '../models/DerivedHandoff';
import type { ScriptExit } from '../interfaces/IRunner';
import type { TaskCompleteArgs } from './mcp/tools';
import { openPrivateKeyStart, redactAgentText } from '../utils/redactSecrets';
import { tooLong } from '../utils/lineTail';

/** Enough output for a summary tail and a live read, without holding a long run's whole log. */
const DEFAULT_MAX_BUFFER_CHARS = 256 * 1024;
/** What an ended attempt keeps: its verdict has read the rest, and a plan outlives thousands of them. */
const ENDED_TAIL_CHARS = 16 * 1024;

interface Capture {
  raw: string;
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
}

/** Output as a reader sees it, each line's trailing space dropped. */
function plain(raw: string): string {
  return outputLines(raw).map((line) => line.trimEnd()).join('\n');
}

/**
 * What every read of the output starts from: runner text, redacted whole
 * before any read cuts it to its lines or a report cuts it to its budget, as a
 * cut can keep a value and drop the name that marks it.
 */
function clean(raw: string): string {
  return redactAgentText(plain(raw).trim());
}

/** Owns one bounded output buffer per task attempt, fed from the attempt's session. */
export class BufferedTaskOutputSource implements TaskOutputSource {
  private captures = new Map<string, Capture>();
  private maxBufferChars: number;

  constructor(opts: { maxBufferChars?: number } = {}) {
    this.maxBufferChars = opts.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  }

  attach(taskId: string, session: IRunnerSession): void {
    const capture: Capture = { raw: '', dropped: 0, attached: true, exited: false, stepsMs: 0 };
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
    return clean(buffered(capture).slice(Math.max(0, (capture.turnStart ?? 0) - capture.dropped)));
  }

  report(taskId: string): string | undefined {
    const summary = this.captures.get(taskId)?.completion?.summary.trim();
    return summary ? redactAgentText(summary) : undefined;
  }

  handoff(taskId: string): StoredHandoff | undefined {
    const capture = this.captures.get(taskId);
    if (capture?.script) return scriptHandoff(capture.script.exit, capture.script.durationMs, clean(buffered(capture)));
    return capture?.completion && storedHandoff(capture.completion);
  }

  liveTail(taskId: string, opts: LiveTailOptions): LiveTail | null {
    const capture = this.captures.get(taskId);
    if (!capture) return null;
    const total = capture.dropped + capture.raw.length;
    const since = Math.min(Math.max(0, (opts.sinceOffset ?? 0) - capture.dropped), capture.raw.length);
    const from = capture.noted !== undefined && since > 0 && since < capture.noted ? capture.noted : since;
    const lines = this.readFrom(buffered(capture), from).split('\n');
    const kept = opts.maxLines > 0 ? lines.slice(-opts.maxLines) : [];
    return {
      text: kept.join('\n'),
      nextOffset: total,
      running: capture.attached && !capture.exited,
    };
  }

  /**
   * The output from `from`, a chunk's end the last read stopped at, redacted
   * with the start of its line: the name of a value split across two chunks
   * is in the part already read. A private key's body is known only by the
   * BEGIN line above it, so a read inside an open key starts at that line.
   */
  private readFrom(raw: string, from: number): string {
    const line = from === 0 ? 0 : raw.lastIndexOf('\n', from - 1) + 1;
    const start = openPrivateKeyStart(raw, line) ?? line;
    if (start === from) return clean(raw.slice(from));
    const shown = plain(raw.slice(start, from));
    const redacted = redactAgentText(plain(raw.slice(start)));
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
      capture.skipped = capture.raw.length - newest;
      capture.dropped += capture.raw.length;
      capture.raw = '';
      capture.noted = undefined;
      return;
    }
    const cut = capture.raw.indexOf('\n', excess - 1) + 1;
    capture.raw = capture.raw.slice(cut);
    capture.dropped += cut;
    if (cut > 0) capture.noted = undefined;
  }
}

/** The output a read starts from: the buffer, and the note for a line it is dropping as it comes. */
function buffered(capture: Capture): string {
  return capture.skipped === undefined ? capture.raw : capture.raw + tooLong(capture.skipped, 'keep');
}
