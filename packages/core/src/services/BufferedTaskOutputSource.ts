import type { IRunnerSession } from '../interfaces/IRunner';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { outputLines } from '../conversation/format';
import { storedHandoff, type StoredHandoff } from '../models/Handoff';
import { scriptHandoff } from '../models/DerivedHandoff';
import type { ScriptExit } from '../interfaces/IRunner';
import type { TaskCompleteArgs } from './mcp/tools';

/** Enough output for a summary tail and a live read, without holding a long run's whole log. */
const DEFAULT_MAX_BUFFER_CHARS = 256 * 1024;
const CUT_SEARCH_CHARS = 4096;

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
    if (capture) capture.attached = false;
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
    return this.captures.get(taskId)?.completion?.summary.trim() || undefined;
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
