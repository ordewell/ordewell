import React, { useState } from 'react';
import { standingRecord } from '@ordewell/core/plan-utils';
import type { DecisionRecordEntry, DecisionRecordKind } from '@ordewell/core';

const SECTIONS: ReadonlyArray<[DecisionRecordKind, string]> = [
  ['decision', 'Decisions'],
  ['constraint', 'Constraints, in your words'],
  ['rejected', 'Rejected'],
  ['question', 'Open questions'],
];

/**
 * The planner's decision record (ADR-0067), read-only: what it decided and why,
 * your constraints in your words, what it rejected, and what is still open.
 * Collapsed, since the planner keeps it for itself first; what a later entry
 * superseded no longer stands, so it is listed only when asked for.
 */
export default function DecisionRecordPanel({ record }: { record?: readonly DecisionRecordEntry[] }) {
  const [all, setAll] = useState(false);
  if (!record || record.length === 0) return null;
  const standing = new Set(standingRecord(record).map((entry) => entry.id));
  const superseded = record.length - standing.size;
  const supersededBy = new Map(record.flatMap((entry) => (entry.supersedes ? [[entry.supersedes, entry.id] as const] : [])));
  const shown = all ? record : record.filter((entry) => standing.has(entry.id));
  return (
    <details className="decision-record">
      <summary className="decision-record-summary">
        Decision record <span className="decision-record-count">{standing.size} standing</span>
      </summary>
      <div className="decision-record-body">
        {SECTIONS.map(([kind, heading]) => {
          const entries = shown.filter((entry) => entry.kind === kind);
          if (entries.length === 0) return null;
          return (
            <section key={kind} className="decision-record-section" data-kind={kind}>
              <h4 className="decision-record-heading">{heading}</h4>
              <ul className="decision-record-list">
                {entries.map((entry) => (
                  <li key={entry.id} className={`decision-record-entry${standing.has(entry.id) ? '' : ' superseded'}`}>
                    <span className="decision-record-id">{entry.id}</span>{' '}
                    <span className="decision-record-text">{entry.kind === 'constraint' ? `“${entry.text}”` : entry.text}</span>
                    {supersededBy.has(entry.id) && <span className="decision-record-note"> (superseded by {supersededBy.get(entry.id)})</span>}
                    {entry.why && <span className="decision-record-why"> Why: {entry.why}</span>}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {superseded > 0 && (
          <label className="decision-record-toggle">
            <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} /> Show {superseded} superseded
          </label>
        )}
      </div>
    </details>
  );
}
