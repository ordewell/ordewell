import { claimFirstRunFeedback, type ExecutionSummary, type FirstRunFeedbackOptions } from '@ordewell/core';

const COUNTS = ['total', 'completed', 'failed', 'blocked', 'skipped'] as const;

/** A run's end as a page reports it, checked again here: a compromised page can send anything. */
function summaryOf(raw: unknown): ExecutionSummary | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const fields = raw as Record<string, unknown>;
  if (!COUNTS.every((key) => typeof fields[key] === 'number' && Number.isInteger(fields[key]))) return undefined;
  const [total, completed, failed, blocked, skipped] = COUNTS.map((key) => fields[key] as number);
  return { total, completed, failed, blocked, skipped };
}

/**
 * Whether the window that saw a run end shows the first-run feedback notice
 * (ADR-0075). Main holds the claim, as it holds the version check's file: core
 * keeps one record for the machine, which the TUI and VS Code read too.
 */
export function claimForWindow(raw: unknown, options: FirstRunFeedbackOptions): boolean {
  const summary = summaryOf(raw);
  return summary !== undefined && claimFirstRunFeedback(summary, options);
}
