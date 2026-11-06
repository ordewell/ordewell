import React from 'react';
import type { IsolationPreview } from '@ordewell/core';
import IsolationNotice from './IsolationNotice';
import PlanApprovalNote, { type HostRunSettings } from './PlanApprovalNote';
import { Button } from '../../design/Button';

interface PlanApprovalCardProps {
  tasks: readonly { assignedRunner?: string | null; subtasks?: readonly unknown[] }[];
  isolationPreview?: IsolationPreview | null;
  runSettings?: HostRunSettings | null;
  /** The run settings in words, as the plan's own bar says them. */
  settings?: React.ReactNode;
  onApprove(): void;
  onAskForChanges(): void;
  onEditSettings?(): void;
}

/**
 * The draft plan's approval, at the foot of the conversation where the person
 * is already reading (docs/desktop/design.md, W3): what approving it commits
 * to, then the two answers. Approve is the title bar's own action, so the view
 * still has one primary (checklist A2).
 */
export default function PlanApprovalCard({ tasks, isolationPreview, runSettings, settings, onApprove, onAskForChanges, onEditSettings }: PlanApprovalCardProps) {
  const runners = new Set(tasks.map((task) => task.assignedRunner).filter(Boolean)).size;
  const size = [
    `${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
    ...(runners > 0 ? [`${runners} runner${runners === 1 ? '' : 's'}`] : []),
  ].join(' · ');
  return (
    <section className="plan-approval-card" aria-label="Plan approval">
      <h3 className="plan-approval-title">Plan ready for approval <span className="plan-approval-size">· {size}</span></h3>
      <IsolationNotice preview={isolationPreview} />
      {settings && (
        <div className="plan-approval-settings">
          <span className="plan-approval-label">Run</span>
          <span className="plan-approval-settings-words">{settings}</span>
          {onEditSettings && <Button variant="ghost" size="sm" onClick={onEditSettings}>Edit</Button>}
        </div>
      )}
      <PlanApprovalNote runSettings={runSettings} />
      <div className="plan-approval-actions">
        <Button onClick={onAskForChanges}>Ask for changes</Button>
        <Button variant="primary" onClick={onApprove}><span aria-hidden="true">✓ </span>Approve plan</Button>
      </div>
    </section>
  );
}
