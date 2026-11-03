import React from 'react';
import type { PlannerContextPause } from '@ordewell/core';

/**
 * The planner paused on its context (ADR-0002): its call could not be brought
 * inside its model's window, and the turn waits for the user. Why is in the
 * conversation, as the turn's failure; this offers the way on, Retry
 * compaction, and Stop, which drops the paused turn. Not drawn while a planner
 * turn runs: a retry in flight is the planner working.
 */
export default function PlannerPauseBar({ pause, busy, onRetry, onStop }: { pause?: PlannerContextPause; busy: boolean; onRetry: () => void; onStop: () => void }) {
  if (!pause || busy) return null;
  return (
    <div className="planner-resend planner-pause" role="status">
      <span className="planner-resend-text">Planner paused: its context does not fit {pause.model}'s window</span>
      <span className="planner-pause-actions">
        <button type="button" className="task-log-open-btn" onClick={onRetry}
          title="Condense the planner's context and try the paused turn again. If the planner cannot safely continue after commands ran, it stays paused">
          Retry compaction
        </button>
        <button type="button" className="task-log-open-btn" onClick={onStop}
          title="Drop the paused turn: what it was answering is not sent">
          Stop
        </button>
      </span>
    </div>
  );
}
