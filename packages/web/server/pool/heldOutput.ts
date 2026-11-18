import type { SessionMessage } from '@ordewell/core';

type Output = Extract<SessionMessage, { type: 'task_output' }>;

/**
 * A socket holding more than this unsent is not keeping up: its client's event
 * loop is busy or its link is slow. A frame is a few kilobytes and a status
 * update with a large plan some tens, so this is dozens of frames behind,
 * never a client that is merely mid-burst, and a quiet session never reaches
 * it. Output is merged only once one socket of a session is past it.
 */
export const SLOW_SOCKET_BYTES = 1024 * 1024;

/** How long a run of output gathers: long enough to fold a busy runner's chunks, short enough to read as live. */
const WINDOW_MS = 250;

interface Run {
  workspace: string | undefined;
  taskId: string;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The output of one task that no frame carries yet, per session. The run is a
 * single `task_output` once told, numbered when it goes out, so the numbers a
 * client sees stay unbroken and it appends the bytes in the order they came.
 */
export class HeldOutput {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly tell: (sessionId: string, workspace: string | undefined, message: Output) => void) {}

  /** Whether `message` is held: it joins the run it continues, or starts one when `behind` says a socket needs it. */
  hold(sessionId: string, workspace: string | undefined, message: Output, behind: () => boolean): boolean {
    const run = this.runs.get(sessionId);
    if (run && run.taskId === message.taskId && run.workspace === workspace) {
      run.text += message.text;
      return true;
    }
    // Another task's output, or another workspace's: the run before it is over.
    if (run) this.flush(sessionId);
    if (!behind()) return false;
    const timer = setTimeout(() => this.flush(sessionId), WINDOW_MS);
    timer.unref?.();
    this.runs.set(sessionId, { workspace, taskId: message.taskId, text: message.text, timer });
    return true;
  }

  /** Tells the run, if any. Called before anything else of the session is, so nothing passes the output. */
  flush(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    clearTimeout(run.timer);
    this.runs.delete(sessionId);
    this.tell(sessionId, run.workspace, { type: 'task_output', taskId: run.taskId, text: run.text });
  }
}
