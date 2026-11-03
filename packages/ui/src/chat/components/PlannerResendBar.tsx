import React from 'react';
import type { PlannerResendState } from '@ordewell/core';
import { resumeTime } from '@ordewell/core/plan-utils';

/**
 * A planner turn that ended on the planner's usage limit is sent again at the
 * reset, with whatever was sent meanwhile. Drawn above the composer while it
 * waits, with the way to keep it for the next message instead.
 */
export default function PlannerResendBar({ resend, onCancel }: { resend?: PlannerResendState; onCancel: () => void }) {
  if (!resend?.at) return null;
  const whose = resend.runner ? `${resend.runner}'s` : 'the planner\'s';
  return (
    <div className="planner-resend" role="status">
      <span className="planner-resend-text">Resending at {resumeTime(new Date(resend.at))}, once {whose} usage limit resets</span>
      <button type="button" className="task-log-open-btn" onClick={onCancel}
        title="Keep it from going on its own: it goes with your next message">
        Don't resend
      </button>
    </div>
  );
}
