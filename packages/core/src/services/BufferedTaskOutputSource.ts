import type { ITerminalSession } from '../interfaces/ITerminalRunner';
import type {
  LiveTail,
  LiveTailOptions,
  TaskOutputAttempt,
  TaskOutputSource,
  TranscriptReader,
} from '../interfaces/TaskOutputSource';
import { renderCleanCapture } from './terminalRender';
import { HomeTranscriptReader } from './transcriptCapture';

/**
 * Enough raw output for the render to recover the last screen of a TUI and a
 * summary tail of a headless run, without holding a long run's whole log.
 */
const DEFAULT_MAX_BUFFER_CHARS = 256 * 1024;
const CUT_SEARCH_CHARS = 4096;

interface Capture {
  readonly session: ITerminalSession;
  /** Raw, un-stripped: the render needs the cursor escapes runners strip. */
  raw: string;
  /** Characters discarded from the front of `raw` to keep it bounded. */
  dropped: number;
  attached: boolean;
  exited: boolean;
}

/**
 * Owns one bounded raw buffer per task attempt, fed from the attempt's
 * session, and reads final answers from the agent's transcript through an
 * injected {@link TranscriptReader}.
 */
export class BufferedTaskOutputSource implements TaskOutputSource {
  private captures = new Map<string, Capture>();
  private transcripts: TranscriptReader;
  private maxBufferChars: number;

  constructor(opts: { transcripts?: TranscriptReader; maxBufferChars?: number } = {}) {
    this.transcripts = opts.transcripts ?? new HomeTranscriptReader();
    this.maxBufferChars = opts.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  }

  attach(taskId: string, session: ITerminalSession): void {
    const capture: Capture = { session, raw: '', dropped: 0, attached: true, exited: false };
    this.captures.set(taskId, capture);
    session.onOutput((text) => {
      if (capture.attached) this.append(capture, text);
    });
    session.onExit(() => {
      capture.exited = true;
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

  async finalText(attempt: TaskOutputAttempt, doneToken: string): Promise<string> {
    // The transcript is the agent's own structured record; the terminal
    // render only reconstructs what a TUI painted, so it is the fallback.
    if (attempt.cwd && attempt.completionMarker) {
      const transcript = await this.transcripts.finalAssistantText({
        runner: attempt.runner,
        cwd: attempt.cwd,
        startedAt: attempt.startedAt,
        marker: attempt.completionMarker,
      });
      if (transcript) return transcript;
    }
    const raw = this.captures.get(attempt.taskId)?.raw ?? '';
    // A marker on the first painted row leaves nothing above the cut; the
    // uncut render is still better than an empty summary.
    return renderCleanCapture(raw, doneToken) || renderCleanCapture(raw);
  }

  liveTail(taskId: string, opts: LiveTailOptions): LiveTail | null {
    const capture = this.captures.get(taskId);
    if (!capture) return null;
    const total = capture.dropped + capture.raw.length;
    const from = Math.min(Math.max(0, (opts.sinceOffset ?? 0) - capture.dropped), capture.raw.length);
    const lines = renderCleanCapture(capture.raw.slice(from)).split('\n');
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
    // Cut on a nearby line boundary: a cut inside an escape sequence would
    // render its parameters as text. A TUI that rarely emits newlines must not
    // cost most of the buffer, hence the short search window.
    const newline = capture.raw.indexOf('\n', excess);
    const cut = newline >= 0 && newline - excess < CUT_SEARCH_CHARS && newline < capture.raw.length - 1 ? newline + 1 : excess;
    capture.raw = capture.raw.slice(cut);
    capture.dropped += cut;
  }
}
