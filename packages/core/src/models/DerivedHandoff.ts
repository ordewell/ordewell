import type { ScriptExit } from '../interfaces/IRunner';
import { HANDOFF_LIMITS, storedHandoff, type StoredHandoff } from './Handoff';
import { secondsText } from './TaskLog';
import type { UserStep } from './Task';
import { redactAgentText } from '../utils/redactSecrets';

/*
 * The handoff of a task with no model to write one (ADR-0047): Ordewell
 * derives it from the evidence it holds, and does not parse that evidence into
 * findings it cannot vouch for.
 */

/** The end of a text within `max` characters, marked when the front was cut: a command says why it failed last. */
function endOf(text: string, max: number): string {
  if (max <= 1) return '…'.slice(0, Math.max(0, max));
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`;
}

/**
 * The exit and output tail in the summary, the bounded output in the report,
 * and the file of the whole output as an artifact (ADR-0047).
 */
export function scriptHandoff(exit: ScriptExit, durationMs: number, output: string): StoredHandoff | undefined {
  const took = secondsText(durationMs);
  let summary: string;
  switch (exit.outcome) {
    case 'passed':
      summary = `exited 0 in ${took}`;
      break;
    case 'failed': {
      const { code, signal, error } = exit.status;
      if (error !== undefined) {
        summary = `could not start: ${error}`;
      } else if (signal) {
        summary = `ended by ${signal} in ${took}`;
      } else {
        summary = `exited ${code ?? 'unknown'} in ${took}`;
      }
      break;
    }
    case 'timed-out':
      summary = `timed out in ${took}`;
      break;
    case 'stopped':
      return undefined;
  }
  // Redacted whole before the summary and report cut their ends from it.
  const text = redactAgentText(output);
  const tail = text.trim();
  const statusBudget = HANDOFF_LIMITS.summary - (tail ? 2 : 0);
  if (summary.length > statusBudget) summary = `${summary.slice(0, statusBudget - 1)}…`;
  if (tail) summary += `\n${endOf(tail, HANDOFF_LIMITS.summary - summary.length - 1)}`;
  return storedHandoff({
    summary,
    report: endOf(text, HANDOFF_LIMITS.report),
    ...(exit.fullOutput ? { artifacts: [{ kind: 'file', path: exit.fullOutput.file }] } : {}),
  });
}

/**
 * What a user task hands over: that the user completed it, and the steps they
 * were given, numbered as the plan has them. The surfaces let a task be marked
 * complete only with every step ticked, and marking it is the user vouching for
 * the rest, so each is listed as done.
 */
export function userTaskHandoff(steps: readonly UserStep[] = []): StoredHandoff | undefined {
  const report = [...steps].sort((a, b) => a.order - b.order).map((s) => `${s.order}. [x] ${s.instruction}`).join('\n');
  return storedHandoff({ summary: 'Completed by the user', ...(report ? { report: endOf(report, HANDOFF_LIMITS.report) } : {}) });
}
