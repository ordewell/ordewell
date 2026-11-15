import { standingRecord, type DecisionRecordEntry, type DecisionRecordKind } from '@ordewell/core';

export const RECORD_EMPTY = 'Nothing recorded yet. The planner notes decisions, your constraints, what it rejected and what is still open as the conversation goes.';

const RECORD_SECTIONS: ReadonlyArray<[DecisionRecordKind, string]> = [
  ['decision', 'Decisions'],
  ['constraint', 'Constraints, in your words'],
  ['rejected', 'Rejected'],
  ['question', 'Open questions'],
];

export interface RecordViewEntry {
  id: string;
  /** A constraint is the user's words, so it is shown quoted. */
  text: string;
  why?: string;
  supersededBy?: string;
}

export interface RecordView {
  standing: number;
  hidden: number;
  sections: Array<{ heading: string; entries: RecordViewEntry[] }>;
}

/**
 * The decision record grouped by kind, for the TUI's sheet and `ordewell
 * decisions` alike, so the two cannot disagree about what stands. What a later
 * entry superseded is left out unless `all`: it no longer stands, and the
 * planner is not shown it either. Wrapping and styling stay with each surface.
 */
export function recordView(record: readonly DecisionRecordEntry[], all: boolean): RecordView {
  const standing = new Set(standingRecord(record).map((entry) => entry.id));
  const shown = all ? record : record.filter((entry) => standing.has(entry.id));
  const supersededBy = new Map(record.flatMap((entry) => (entry.supersedes ? [[entry.supersedes, entry.id] as const] : [])));
  const sections = RECORD_SECTIONS.flatMap(([kind, heading]) => {
    const entries = shown.filter((entry) => entry.kind === kind).map((entry): RecordViewEntry => ({
      id: entry.id,
      text: entry.kind === 'constraint' ? `"${entry.text}"` : entry.text,
      ...(entry.why ? { why: entry.why } : {}),
      ...(supersededBy.has(entry.id) ? { supersededBy: supersededBy.get(entry.id) } : {}),
    }));
    return entries.length > 0 ? [{ heading, entries }] : [];
  });
  return { standing: standing.size, hidden: record.length - standing.size, sections };
}
