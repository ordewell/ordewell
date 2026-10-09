import { isStructuredSession, type ITerminalRunner, type ITerminalSession, type StructuredSessionCapability } from '../interfaces/ITerminalRunner';
import { defaultLogger, type ILogger } from '../interfaces/ILogger';
import { coalesceTaskLog, taskLogForSurface, toTaskLogEvent, type TaskLogEvent } from '../models/TaskLog';
import { openTaskLog, type TaskLogFile, type TaskLogLocation } from '../utils/taskLogStore';
import type { TaskSkillSnapshot } from '../models/Task';
import type { SessionBroadcaster } from './SessionMessage';

/** Long enough to gather a burst of deltas into one message, short enough to read as live. */
const DEFAULT_FLUSH_MS = 50;

const FLUSHED_AT_ONCE: ReadonlySet<TaskLogEvent['type']> = new Set(['turn_end', 'approval_requested', 'approval_decided', 'approval_withdrawn', 'message_undelivered']);

export interface TaskLogRecorderDeps {
  broadcast: SessionBroadcaster;
  /** Where the session's logs go, read as each attempt starts: a session's id can change between plans. */
  location: () => TaskLogLocation;
  /** Opens an attempt's file; tests pass one that never touches the disk. */
  open?: (location: TaskLogLocation, taskId: string) => TaskLogFile;
  flushMs?: number;
  logger?: ILogger;
}

/**
 * Keeps each structured task's log (ADR-0018, P1): every event of an attempt
 * is appended to that attempt's file and broadcast as `task_log`, in the same
 * batches, so what a surface saw live and what it reloads are one sequence.
 *
 * It sits around the runner rather than inside the orchestrator, which stays
 * unaware of logs; a terminal-transport session has no event stream and is
 * passed through untouched.
 */
export class TaskLogRecorder {
  private readonly open: (location: TaskLogLocation, taskId: string) => TaskLogFile;
  private readonly flushMs: number;
  private readonly logger: ILogger;

  constructor(private readonly deps: TaskLogRecorderDeps) {
    this.open = deps.open ?? openTaskLog;
    this.flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS;
    this.logger = deps.logger ?? defaultLogger;
  }

  wrap(runner: ITerminalRunner): ITerminalRunner {
    return {
      spawn: async (opts) => {
        const session = await runner.spawn(opts);
        // Before returning: the first turn's events are emitted on the next
        // macrotask, and a listener attached later would miss them.
        if (isStructuredSession(session)) this.record(opts.taskId, session, opts.skills);
        return session;
      },
      stop: (sessionId) => runner.stop(sessionId),
      stopAll: () => runner.stopAll(),
      get activeCount() { return runner.activeCount; },
    };
  }

  /** Start a new attempt's log for `session`, opening with the skills it was given, and keep it until the session exits. */
  record(taskId: string, session: ITerminalSession & StructuredSessionCapability, skills: readonly TaskSkillSnapshot[] = []): void {
    let file: TaskLogFile | null;
    try {
      file = this.open(this.deps.location(), taskId);
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

    session.onEvent((event) => {
      const entry = toTaskLogEvent(event);
      if (!entry) return;
      pending.push(entry);
      // A turn's end is what a surface shows "waiting for input" on, and an
      // approval is someone's to answer, so these go out at once rather than
      // after the batch window.
      if (FLUSHED_AT_ONCE.has(entry.type)) flush();
      else if (!timer) {
        timer = setTimeout(flush, this.flushMs);
        timer.unref?.();
      }
    });
    session.onExit(() => flush());
  }
}
