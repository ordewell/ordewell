import type { IRunner, IRunnerSession } from '../interfaces/IRunner';
import { defaultLogger, type ILogger } from '../interfaces/ILogger';
import { coalesceTaskLog, taskLogForSurface, toTaskLogEvent, type TaskLogEvent } from '../models/TaskLog';
import { openTaskLog, type TaskLogFile, type TaskLogLocation } from '../utils/taskLogStore';
import type { TaskSkillSnapshot } from '../models/Task';
import type { SessionBroadcaster } from './SessionMessage';

/** Long enough to gather a burst of deltas into one message, short enough to read as live. */
const DEFAULT_FLUSH_MS = 50;

const FLUSHED_AT_ONCE: ReadonlySet<TaskLogEvent['type']> = new Set(['turn_end', 'approval_requested', 'approval_decided', 'approval_withdrawn', 'message_undelivered', 'script_exit']);

export interface TaskLogRecorderDeps {
  broadcast: SessionBroadcaster;
  /** Where the session's logs go, read as each attempt starts: a session's id can change between plans. */
  location: () => TaskLogLocation;
  /** Opens an attempt's file, under the attempt's number when the spawn named one; tests pass one that never touches the disk. */
  open?: (location: TaskLogLocation, taskId: string, attempt?: number) => TaskLogFile;
  flushMs?: number;
  logger?: ILogger;
}

/**
 * Keeps each structured task's log (ADR-0018, P1): every event of an attempt
 * is appended to that attempt's file and broadcast as `task_log`, in the same
 * batches, so what a surface saw live and what it reloads are one sequence.
 *
 * It sits around the runner rather than inside the orchestrator, which stays
 * unaware of logs.
 */
export class TaskLogRecorder {
  private readonly open: (location: TaskLogLocation, taskId: string, attempt?: number) => TaskLogFile;
  private readonly flushMs: number;
  private readonly logger: ILogger;
  /** Each task's latest attempt, by the session it records: its log takes a {@link note} until the next attempt starts. */
  private readonly latest = new Map<string, { sessionId: string; note: (entry: TaskLogEvent) => void }>();

  constructor(private readonly deps: TaskLogRecorderDeps) {
    this.open = deps.open ?? openTaskLog;
    this.flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS;
    this.logger = deps.logger ?? defaultLogger;
  }

  wrap(runner: IRunner): IRunner {
    return {
      spawn: async (opts) => {
        const session = await runner.spawn(opts);
        // Before returning: the first turn's events are emitted on the next
        // macrotask, and a listener attached later would miss them.
        this.record(opts.taskId, session, opts.skills, opts.attempt);
        return session;
      },
      stop: (sessionId) => runner.stop(sessionId),
      stopAll: () => runner.stopAll(),
      get activeCount() { return runner.activeCount; },
    };
  }

  /**
   * An entry the session did not emit, written into the log of the attempt
   * that runs `sessionId` and sent at once: what Ordewell made of one of its
   * events once that settled. Dropped once the task's next attempt started.
   * With no session — a user task's completion has none — the entry opens an
   * attempt log of its own, so a reader of the task's logs finds it like any other.
   */
  note(sessionId: string | undefined, taskId: string, entry: TaskLogEvent): void {
    if (sessionId === undefined) {
      this.writeAlone(taskId, entry);
      return;
    }
    const attempt = this.latest.get(taskId);
    if (attempt?.sessionId === sessionId) attempt.note(entry);
  }

  private writeAlone(taskId: string, entry: TaskLogEvent): void {
    let file: TaskLogFile | null = null;
    try {
      file = this.open(this.deps.location(), taskId, undefined);
      file.append([entry]);
    } catch (err: unknown) {
      this.logger.warn('taskLog', `could not write the log of task ${taskId}; the entry is sent but not saved`, err);
    }
    this.deps.broadcast({ type: 'task_log', taskId, attempt: file?.attempt ?? 0, events: taskLogForSurface([entry]) });
  }

  /** Start a new attempt's log for `session`, opening with the skills it was given, and keep it until the session exits. */
  record(taskId: string, session: IRunnerSession, skills: readonly TaskSkillSnapshot[] = [], attemptNumber?: number): void {
    let file: TaskLogFile | null;
    try {
      file = this.open(this.deps.location(), taskId, attemptNumber);
    } catch (err: unknown) {
      this.logger.warn('taskLog', `could not create the log of task ${taskId}; it streams but is not saved`, err);
      file = null;
    }
    const attempt = file?.attempt ?? 0;
    let pending: TaskLogEvent[] = skills.length > 0 ? [{ type: 'task_skills', skills: [...skills] }] : [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let writeFailed = false;

    const flush = (): void => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending.length === 0) return;
      const events = coalesceTaskLog(pending);
      pending = [];
      if (file && !writeFailed) {
        try {
          file.append(events);
        } catch (err: unknown) {
          // Once: a full disk would otherwise warn on every batch.
          writeFailed = true;
          this.logger.warn('taskLog', `could not append to the log of task ${taskId}, attempt ${attempt}; it keeps streaming unsaved`, err);
        }
      }
      this.deps.broadcast({ type: 'task_log', taskId, attempt, events: taskLogForSurface(events) });
    };

    // Past the session's exit too: a note can settle after the process ended.
    this.latest.set(taskId, { sessionId: session.id, note: (entry) => { pending.push(entry); flush(); } });

    session.onEvent((event) => {
      const logged = toTaskLogEvent(event);
      if (!logged) return;
      // Dated here, where every runner's events meet the log, so a reload
      // knows when an open turn began (#81).
      const entry = logged.type === 'turn_start' || logged.type === 'command' ? { ...logged, startedAt: new Date().toISOString() } : logged;
      pending.push(entry);
      // A turn's end is what a surface shows "waiting for input" on, an
      // approval is someone's to answer, and a script step's end settles its
      // row, so these go out at once rather than after the batch window.
      if (FLUSHED_AT_ONCE.has(entry.type)) flush();
      else if (!timer) {
        timer = setTimeout(flush, this.flushMs);
        timer.unref?.();
      }
    });
    session.onExit(() => {
      pending.push({ type: 'runner_ended' });
      flush();
    });
  }
}
