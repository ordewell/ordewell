import type { IRunnerSession } from '../interfaces/IRunner';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { outputLines } from '../conversation/format';

/** Enough output for a summary tail and a live read, without holding a long run's whole log. */
const DEFAULT_MAX_BUFFER_CHARS = 256 * 1024;
const CUT_SEARCH_CHARS = 4096;

interface Capture {
  readonly session: IRunnerSession;
  raw: string;
  /** Characters discarded from the front of `raw` to keep it bounded. */
  dropped: number;
  attached: boolean;
  exited: boolean;
  /** What the runner said it did in its `task_complete` call (ADR-0022, V4). */
  reported?: string;
  turnStart?: number;
}

function clean(raw: string): string {
  return outputLines(raw).map((line) => line.trimEnd()).join('\n').trim();
}

/** Owns one bounded output buffer per task attempt, fed from the attempt's session. */
export class BufferedTaskOutputSource implements TaskOutputSource {
  private captures = new Map<string, Capture>();
  private maxBufferChars: number;

  constructor(opts: { maxBufferChars?: number } = {}) {
    this.maxBufferChars = opts.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  }

  attach(taskId: string, session: IRunnerSession): void {
    const capture: Capture = { session, raw: '', dropped: 0, attached: true, exited: false };
    this.captures.set(taskId, capture);
    session.onOutput((text) => {
      if (capture.attached) this.append(capture, text);
    });
    session.onExit(() => {
      capture.exited = true;
    });
    session.onEvent((event) => {
      // A message read mid-turn starts the account of the work afresh, as a new turn does (ADR-0023).
      if (capture.attached && (event.type === 'turn_start' || event.type === 'message_delivered')) {
        capture.reported = undefined;
        capture.turnStart = capture.dropped + capture.raw.length;
      }
    });
    session.onTaskComplete(({ summary }) => {
      if (capture.attached) capture.reported = summary.trim() || undefined;
    });
  }

  detach(taskId: string): void {
    const capture = this.captures.get(taskId);
    if (capture) capture.attached = false;
  }

  reset(): void {
    for (const capture of this.captures.values()) capture.attached = false;
    this.captures.clear();
  }

  finalText(taskId: string): string {
    const capture = this.captures.get(taskId);
    if (!capture) return '';
    if (capture.reported) return capture.reported;
    return clean(capture.raw.slice(Math.max(0, (capture.turnStart ?? 0) - capture.dropped)));
  }

  liveTail(taskId: string, opts: LiveTailOptions): LiveTail | null {
    const capture = this.captures.get(taskId);
    if (!capture) return null;
    const total = capture.dropped + capture.raw.length;
    const from = Math.min(Math.max(0, (opts.sinceOffset ?? 0) - capture.dropped), capture.raw.length);
    const lines = clean(capture.raw.slice(from)).split('\n');
    const kept = opts.maxLines > 0 ? lines.slice(-opts.maxLines) : [];
    return {
      text: kept.join('\n'),
      nextOffset: total,
      running: capture.attached && !capture.exited,
    };
  }

  private append(capture: Capture, text: string): void {
    capture.raw += text;
    const excess = capture.raw.length - this.maxBufferChars;
    if (excess <= 0) return;
    // Cut on a nearby line boundary, so the oldest line kept is whole. Output
    // that rarely breaks lines must not cost most of the buffer, hence the
    // short search window.
    const newline = capture.raw.indexOf('\n', excess);
    const cut = newline >= 0 && newline - excess < CUT_SEARCH_CHARS && newline < capture.raw.length - 1 ? newline + 1 : excess;
    capture.raw = capture.raw.slice(cut);
    capture.dropped += cut;
  }
}
