import React from 'react';
import type { GlobalRunSettings } from '@ordewell/core';

/** The user's autonomy level and run settings (ADR-0030), as the host sends them. */
export interface HostRunSettings {
  autonomous: boolean;
  run: GlobalRunSettings;
}

/**
 * What the first screen promises about starting a plan. Autorun is the user's
 * setting, not a constant, so the note says nothing until the host has sent it:
 * a promise made before then could be false.
 *
 * The two states are one row in two colours, not two different blocks: the
 * marker on the left is the warning colour only while autorun really does start
 * a plan unasked, and neutral otherwise.
 */
export default function PlanApprovalNote({ runSettings }: { runSettings?: HostRunSettings | null }) {
  if (!runSettings) return null;
  if (!runSettings.run.autorun) {
    return (
      <div className="plan-approval-note" data-autorun="off">
        <p className="plan-approval-text">Nothing runs until you approve the plan.</p>
      </div>
    );
  }
  return (
    <div className="plan-approval-note warn" data-autorun="on">
      <p className="plan-approval-text">
        Autorun is on. A plan starts as soon as the planner submits it. Change it in{' '}
        <code className="command-token">/settings</code>.
      </p>
    </div>
  );
}
