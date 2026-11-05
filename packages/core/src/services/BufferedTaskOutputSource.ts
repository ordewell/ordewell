import type { IRunnerSession } from '../interfaces/IRunner';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { outputLines } from '../conversation/format';
import { storedHandoff, type StoredHandoff } from '../models/Handoff';
import { scriptHandoff } from '../models/DerivedHandoff';
import type { ScriptExit } from '../interfaces/IRunner';
import type { TaskCompleteArgs } from './mcp/tools';
import { redactAgentText } from '../utils/redactSecrets';

/** Enough output for a summary tail and a live read, without holding a long run's whole log. */
const DEFAULT_MAX_BUFFER_CHARS = 256 * 1024;
const CUT_SEARCH_CHARS = 4096;
/** What an ended attempt keeps: its verdict has read the rest, and a plan outlives thousands of them. */
const ENDED_TAIL_CHARS = 16 * 1024;

interface Capture {
  raw: string;
  /** Characters discarded from the front of `raw` to keep it bounded. */
  dropped: number;
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
    return clean(capture.raw.slice(Math.max(0, (capture.turnStart ?? 0) - capture.dropped)));
  }

  report(taskId: string): string | undefined {
    const summary = this.captures.get(taskId)?.completion?.summary.trim();
    return summary ? redactAgentText(summary) : undefined;
  }

  handoff(taskId: string): StoredHandoff | undefined {
    const capture = this.captures.get(taskId);
    if (capture?.script) return scriptHandoff(capture.script.exit, capture.script.durationMs, clean(capture.raw));
    return capture?.completion && storedHandoff(capture.completion);
  }

  liveTail(taskId: string, opts: LiveTailOptions): LiveTail | null {
    const capture = this.captures.get(taskId);
    if (!capture) return null;
    const total = capture.dropped + capture.raw.length;
    const from = Math.min(Math.max(0, (opts.sinceOffset ?? 0) - capture.dropped), capture.raw.length);
    const lines = this.readFrom(capture.raw, from).split('\n');
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
   * is in the part already read.
   */
  private readFrom(raw: string, from: number): string {
    const start = from === 0 ? 0 : raw.lastIndexOf('\n', from - 1) + 1;
    if (start === from) return clean(raw.slice(from));
    const shown = plain(raw.slice(start, from));
    const line = redactAgentText(plain(raw.slice(start)));
    // Unless redacting the whole line changed the part already read, show only the rest of it.
    return (line.startsWith(shown) ? line.slice(shown.length) : line).trim();
  }

  private append(capture: Capture, text: string): void {
    capture.raw += text;
    this.cutTo(capture, this.maxBufferChars);
  }

  private cutTo(capture: Capture, maxChars: number): void {
    const excess = capture.raw.length - maxChars;
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
