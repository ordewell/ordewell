import type { Task, Verdict, VerificationCheck } from '../models/Task';
import type { ITerminalSession } from '../interfaces/ITerminalRunner';

export type VerdictListener = (taskId: string, verdict: Verdict, output: string) => void;
export type CheckpointListener = (taskId: string, summary: string) => void;
/** Fires on every idleSince transition (null→timestamp on silence, timestamp→null on resume/teardown). */
export type IdleListener = (taskId: string, idleSince: string | null) => void;

const CHECKPOINT_RE = /<<<ORDEWELL_CHECKPOINT:\s*(.*?)>>>/gs;

// eslint-disable-next-line no-control-regex
const ANSI_OR_CTRL_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][AB012]|\x1b[=>]|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Collapse terminal rendering out of raw PTY output: strip ANSI/OSC escape
 * sequences, box-drawing gutter characters, and ALL whitespace. Interactive
 * TUIs soft-wrap long lines, so a completion marker arrives split across
 * lines with escapes interleaved — a raw `includes()` never matches it.
 * Markers contain no whitespace, so this flattened view is safe to scan.
 */
export function flattenTerminalOutput(raw: string): string {
  return raw
    .replace(ANSI_OR_CTRL_RE, '')
    .replace(/[─-▟]/g, '') // box-drawing + block elements (TUI borders/gutters)
    .replace(/\s+/g, '');
}

/**
 * Reconstruct the small terminal screen represented by a PTY output tail.
 *
 * Full-screen TUIs do not emit answer text as one chronological stream. They
 * paint fragments at absolute cursor positions and repaint unrelated widgets
 * between those writes. OpenCode, for example, may emit:
 *
 *   row 9:  "<<<ORDEW"
 *   row 23: spinner repaint
 *   row 9:  "ELL_DONE_..."
 *
 * Flattening that byte stream inserts the spinner inside the marker. Rendering
 * the cursor-positioned writes first recovers the token the user actually sees.
 * This intentionally implements only the common cursor/erase subset used by
 * coding-agent TUIs; the chronological scanner remains the fallback for plain
 * output and soft-wrapped lines.
 */
export function renderTerminalOutput(raw: string): string {
  const rows = new Map<number, string[]>();
  let row = 1;
  let col = 1;
  let savedRow = 1;
  let savedCol = 1;

  const cells = (r: number): string[] => {
    let line = rows.get(r);
    if (!line) {
      line = [];
      rows.set(r, line);
    }
    return line;
  };
  const firstParam = (params: number[], fallback = 1): number => params[0] || fallback;
  const eraseLine = (mode: number): void => {
    const line = cells(row);
    if (mode === 2) {
      rows.set(row, []);
    } else if (mode === 1) {
      for (let c = 0; c < col; c++) line[c] = ' ';
    } else {
      line.length = Math.max(0, col - 1);
    }
  };

  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    if (ch === '\x1b') {
      const kind = raw[i + 1];
      if (kind === '[') {
        let end = i + 2;
        while (end < raw.length) {
          const code = raw.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) break;
          end++;
        }
        if (end >= raw.length) break;
        const final = raw[end];
        const body = raw.slice(i + 2, end).replace(/^[?<>=!]+/, '');
        const params = body.split(';').map((p) => Number.parseInt(p, 10) || 0);
        switch (final) {
          case 'H':
          case 'f':
            row = params[0] || 1;
            col = params[1] || 1;
            break;
          case 'G': col = firstParam(params); break;
          case 'd': row = firstParam(params); break;
          case 'A': row = Math.max(1, row - firstParam(params)); break;
          case 'B': row += firstParam(params); break;
          case 'C': col += firstParam(params); break;
          case 'D': col = Math.max(1, col - firstParam(params)); break;
          case 'E': row += firstParam(params); col = 1; break;
          case 'F': row = Math.max(1, row - firstParam(params)); col = 1; break;
          case 's': savedRow = row; savedCol = col; break;
          case 'u': row = savedRow; col = savedCol; break;
          case 'K': eraseLine(params[0] || 0); break;
          case 'J':
            if ((params[0] || 0) === 2 || (params[0] || 0) === 3) rows.clear();
            break;
          case 'X': {
            const line = cells(row);
            for (let c = 0; c < firstParam(params); c++) line[col - 1 + c] = ' ';
            break;
          }
          case 'P': {
            cells(row).splice(col - 1, firstParam(params));
            break;
          }
          case '@': {
            cells(row).splice(col - 1, 0, ...Array(firstParam(params)).fill(' '));
            break;
          }
          default:
            break;
        }
        i = end + 1;
        continue;
      }
      if (kind === ']' || kind === 'P' || kind === '^' || kind === '_') {
        let end = i + 2;
        while (end < raw.length && raw[end] !== '\x07' && !(raw[end] === '\x1b' && raw[end + 1] === '\\')) end++;
        if (end >= raw.length) break;
        i = raw[end] === '\x07' ? end + 1 : end + 2;
        continue;
      }
      if (kind === '7') {
        savedRow = row;
        savedCol = col;
      } else if (kind === '8') {
        row = savedRow;
        col = savedCol;
      } else if (kind === 'c') {
        rows.clear();
        row = 1;
        col = 1;
      }
      // Character-set selection sequences carry one extra byte.
      i += kind === '(' || kind === ')' ? 3 : 2;
      continue;
    }
    if (ch === '\r') {
      col = 1;
      i++;
      continue;
    }
    if (ch === '\n') {
      row++;
      i++;
      continue;
    }
    if (ch === '\b') {
      col = Math.max(1, col - 1);
      i++;
      continue;
    }
    if (ch === '\t') {
      col += 8 - ((col - 1) % 8);
      i++;
      continue;
    }
    if (ch < ' ' || ch === '\x7f') {
      i++;
      continue;
    }
    cells(row)[col - 1] = ch;
    col++;
    i++;
  }

  const populated = [...rows.keys()].sort((a, b) => a - b);
  return populated.map((r) => cells(r).join('')).join('\n');
}

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

  approveCheckpoint(taskId: string): void {
    const session = this.pausedSessions.get(taskId);
    if (session) {
      session.write('\nORDEWELL_CONTINUE\n');
      this.pausedSessions.delete(taskId);
    }
  }

  rejectCheckpoint(taskId: string, reason: string): void {
    const session = this.pausedSessions.get(taskId);
    if (session) {
      session.write(`\nORDEWELL_REJECT: ${reason}\n`);
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
