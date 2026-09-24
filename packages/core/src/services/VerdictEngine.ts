import type { Task, Verdict, VerificationCheck } from '../models/Task';
import type { ITerminalSession } from '../interfaces/ITerminalRunner';
import { flattenTerminalOutput, renderTerminalOutput } from './terminalRender';

export type VerdictListener = (taskId: string, verdict: Verdict, output: string) => void;
export type CheckpointListener = (taskId: string, summary: string) => void;
/** Fires on every idleSince transition (null→timestamp on silence, timestamp→null on resume/teardown). */
export type IdleListener = (taskId: string, idleSince: string | null) => void;

const CHECKPOINT_RE = /<<<ORDEWELL_CHECKPOINT:\s*(.*?)>>>/gs;

/** Only the tail of the buffer is flattened per chunk — markers are short and
 *  recent, and re-flattening an unbounded buffer on every write is O(n²). */
const MARKER_SCAN_TAIL = 16384;

/** No output for this long marks a running task idle (advisory, UI-only). */
const IDLE_TIMEOUT_MS = 60_000;


export class VerdictEngine {
  private markerSeen = new Set<string>();
  private buffers = new Map<string, string>();
  private checkpointCounts = new Map<string, number>();
  private pausedSessions = new Map<string, ITerminalSession>();
  private listeners: VerdictListener[] = [];
  private checkpointListeners: CheckpointListener[] = [];
  private idleListeners: IdleListener[] = [];
  /**
   * Per-task generation counter. Incremented on every watch() and clear().
   * Stale callbacks (from a prior session whose generation doesn't match
   * the current one) bail out instead of delivering a verdict for the
   * wrong session.
   */
  private generations = new Map<string, number>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private idleSince = new Map<string, string | null>();

  onVerdict(listener: VerdictListener): void {
    this.listeners.push(listener);
  }

  onCheckpoint(listener: CheckpointListener): void {
    this.checkpointListeners.push(listener);
  }

  onIdleChange(listener: IdleListener): void {
    this.idleListeners.push(listener);
  }

  /** Advisory silence timestamp for a task, or null if it isn't idle. */
  getIdleSince(taskId: string): string | null {
    return this.idleSince.get(taskId) ?? null;
  }

  /** Restart the silence timer on fresh output; broadcasts the null transition if it was idle. */
  private touchIdle(taskId: string, gen: number): void {
    const existing = this.idleTimers.get(taskId);
    if (existing) clearTimeout(existing);
    if (this.idleSince.get(taskId)) {
      this.idleSince.set(taskId, null);
      for (const l of this.idleListeners) l(taskId, null);
    }
    this.idleTimers.set(taskId, setTimeout(() => {
      if (this.generations.get(taskId) !== gen) return;
      const now = new Date().toISOString();
      this.idleSince.set(taskId, now);
      for (const l of this.idleListeners) l(taskId, now);
    }, IDLE_TIMEOUT_MS));
  }

  /** Tear down idle tracking for a task; broadcasts the null transition if it was idle. */
  private clearIdle(taskId: string): void {
    const timer = this.idleTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(taskId);
    const wasIdle = this.idleSince.get(taskId);
    this.idleSince.delete(taskId);
    if (wasIdle) {
      for (const l of this.idleListeners) l(taskId, null);
    }
  }

  /**
   * Submit a synchronized resume token to the paused session. An interactive
   * TUI only accepts the Enter keystroke (`\r`) — a `\n` types the token into
   * its composer without sending it, leaving the agent paused until a human
   * presses Enter. A line-oriented piped session has no composer; it reads a
   * `\n`-terminated line, and the leading newline flushes a partial line.
   */
  private resumeToken(session: ITerminalSession, line: string): string {
    return session.interactive ? `${line}\r` : `\n${line}\n`;
  }

  approveCheckpoint(taskId: string): void {
    const session = this.pausedSessions.get(taskId);
    if (session) {
      session.write(this.resumeToken(session, 'ORDEWELL_CONTINUE'));
      this.pausedSessions.delete(taskId);
    }
  }

  rejectCheckpoint(taskId: string, reason: string): void {
    const session = this.pausedSessions.get(taskId);
    if (session) {
      session.write(this.resumeToken(session, `ORDEWELL_REJECT: ${reason}`));
      this.pausedSessions.delete(taskId);
    }
  }

  /**
   * Attach to a spawned session: buffer output, scan for the task's completion
   * marker (delivering a verdict immediately while leaving interactive sessions
   * open), scan for checkpoint markers, and on exit produce a failed verdict
   * when the marker was never observed.
   */
  watch(task: Task, session: ITerminalSession): void {
    const doneToken = `<<<ORDEWELL_DONE_${task.completionMarker}>>>`;
    const gen = (this.generations.get(task.id) ?? 0) + 1;
    this.generations.set(task.id, gen);
    this.buffers.set(task.id, '');
    this.checkpointCounts.set(task.id, 0);
    session.onOutput((text: string) => {
      if (this.generations.get(task.id) !== gen) return;
      this.touchIdle(task.id, gen);
      if (this.markerSeen.has(task.id)) return;
      const buf = (this.buffers.get(task.id) ?? '') + text;
      this.buffers.set(task.id, buf);
      const tail = buf.slice(-MARKER_SCAN_TAIL);
      const markerVisible = flattenTerminalOutput(tail).includes(doneToken)
        || flattenTerminalOutput(renderTerminalOutput(tail)).includes(doneToken);
      if (markerVisible) {
        this.markerSeen.add(task.id);
        // Deliver verdict immediately instead of killing the session.
        // The terminal stays open so the user can read output or keep chatting
        // with the AI runner. Bump the generation so the onExit callback
        // (which will fire when the terminal eventually closes) bails out.
        const output = buf;
        this.buffers.delete(task.id);
        this.checkpointCounts.delete(task.id);
        this.pausedSessions.delete(task.id);
        this.clearIdle(task.id);
        this.generations.set(task.id, gen + 1);
        const verdict = this.decide(task, 0);
        for (const l of this.listeners) l(task.id, verdict, output);
        return;
      }
      const matches = [...buf.matchAll(CHECKPOINT_RE)];
      const prevCount = this.checkpointCounts.get(task.id) ?? 0;
      for (let i = prevCount; i < matches.length; i++) {
        const summary = matches[i][1].trim();
        this.pausedSessions.set(task.id, session);
        for (const l of this.checkpointListeners) l(task.id, summary);
      }
      this.checkpointCounts.set(task.id, matches.length);
    });
    session.onExit((exitCode: number) => {
      if (this.generations.get(task.id) !== gen) return;
      const output = session.getOutput();
      const tail = output.slice(-MARKER_SCAN_TAIL);
      if (
        flattenTerminalOutput(tail).includes(doneToken)
        || flattenTerminalOutput(renderTerminalOutput(tail)).includes(doneToken)
      ) {
        this.markerSeen.add(task.id);
      }
      this.buffers.delete(task.id);
      this.checkpointCounts.delete(task.id);
      this.pausedSessions.delete(task.id);
      this.clearIdle(task.id);
      const verdict = this.decide(task, exitCode);
      for (const l of this.listeners) l(task.id, verdict, output);
    });
  }

  /** Manual "Mark complete" override: a pass verdict that bypasses evidence. */
  markComplete(task: Task): Verdict {
    this.markerSeen.delete(task.id);
    this.buffers.delete(task.id);
    this.checkpointCounts.delete(task.id);
    this.pausedSessions.delete(task.id);
    this.clearIdle(task.id);
    this.generations.set(task.id, (this.generations.get(task.id) ?? 0) + 1);
    return {
      outcome: 'pass',
      reason: 'Manually marked complete by user.',
      checks: [
        {
          name: 'manual',
          passed: true,
          skipped: false,
          detail: 'Task was manually marked complete by the user; no automatic verification was performed.',
        },
      ],
      decidedAt: new Date().toISOString(),
    };
  }

  /** Clear verification state for a task (used on retry). */
  clear(task: Task): void {
    this.markerSeen.delete(task.id);
    this.buffers.delete(task.id);
    this.checkpointCounts.delete(task.id);
    this.pausedSessions.delete(task.id);
    this.clearIdle(task.id);
    this.generations.set(task.id, (this.generations.get(task.id) ?? 0) + 1);
  }

  /** Drop all tracking state (used on stop / loadPlan). */
  reset(): void {
    this.markerSeen.clear();
    this.buffers.clear();
    this.checkpointCounts.clear();
    this.pausedSessions.clear();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.idleSince.clear();
    this.generations.clear();
  }

  private decide(task: Task, exitCode: number): Verdict {
    const normalized = exitCode == null ? 0 : exitCode;
    const markerWasSeen = this.markerSeen.has(task.id);
    if (markerWasSeen) this.markerSeen.delete(task.id);

    const checks: VerificationCheck[] = [];
    if (markerWasSeen) {
      checks.push({
        name: 'completion_marker',
        passed: true,
        skipped: false,
        detail: 'task completion marker was seen in agent output',
      });
      checks.push({
        name: 'exit_code',
        passed: true,
        skipped: true,
        detail: 'bypassed — completion marker was seen in agent output',
      });
      return {
        outcome: 'pass',
        reason: 'Verified: completion marker detected in agent output. Task completed successfully.',
        checks,
        decidedAt: new Date().toISOString(),
      };
    }

    const exitOk = normalized === 0;
    checks.push({
      name: 'completion_marker',
      passed: false,
      skipped: false,
      detail: 'agent exited before Ordewell detected the task completion marker',
    });
    checks.push({
      name: 'exit_code',
      passed: exitOk,
      skipped: false,
      detail: exitOk ? 'agent exited cleanly (code 0)' : `agent exited with code ${normalized}`,
    });

    return {
      outcome: 'fail',
      reason: exitOk
        ? 'Failed verification: agent exited cleanly but did not emit the completion marker.'
        : `Failed verification: completion marker missing; agent exited with code ${normalized}.`,
      checks,
      decidedAt: new Date().toISOString(),
    };
  }
}
