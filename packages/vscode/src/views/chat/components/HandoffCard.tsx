import React from 'react';

export interface HandoffLandedTask {
  taskId: string;
  order: number;
  title: string;
}

interface HandoffCardProps {
  branch: string;
  baseRef: string;
  landed: HandoffLandedTask[];
  /** The run is settled, so every action here is available. */
  onAction: (action: 'reviewDiff' | 'merge' | 'discard' | 'cleanup') => void;
}

/**
 * The end of an isolated run (ADR-0013). Ordewell never merges into the
 * checked-out branch on its own, so this is where that irreversible step is
 * offered — next to the one artifact to review it with, the integration branch.
 */
export default function HandoffCard({ branch, baseRef, landed, onAction }: HandoffCardProps) {
  const sorted = [...landed].sort((a, b) => a.order - b.order);
  return (
    <div className="isolation-handoff">
      <div className="isolation-handoff-header">
        <span className="isolation-handoff-title">Run complete &mdash; review the integration branch</span>
        <code className="isolation-handoff-branch">{branch}</code>
      </div>
      <div className="isolation-handoff-base">
        {sorted.length} task{sorted.length === 1 ? '' : 's'} landed on top of <code>{baseRef.slice(0, 12)}</code>
      </div>
      {sorted.length > 0 && (
        <ul className="isolation-handoff-landed">
          {sorted.map((t) => (
            <li key={t.taskId}>
              <span className="isolation-handoff-order">{t.order}</span>
              {t.title}
            </li>
          ))}
        </ul>
      )}
      <div className="isolation-handoff-actions">
        <button className="task-action-btn" onClick={() => onAction('reviewDiff')}>Review diff</button>
        <button className="task-action-btn run" onClick={() => onAction('merge')}>Merge</button>
        <button className="task-action-btn skip" onClick={() => onAction('cleanup')}>Clean up</button>
        <button className="task-action-btn cancel" onClick={() => onAction('discard')}>Discard</button>
      </div>
    </div>
  );
}
