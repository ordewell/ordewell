import React from 'react';
import type { HandoffDigest, StoredHandoff } from '@ordewell/core';
import { DELEGATION_OFFERED, handoffFindingsText, handoffReferenceText, savedPatchViews, severityLabel, subtreeView, worstSeverity } from '@ordewell/core/plan-utils';
import type { SubtreeItemView } from '@ordewell/core/plan-utils';
import { useOpenPatch } from '../openPatch';
import ReportBody from './ReportBody';

function SubtreeItems({ title, items }: { title: string; items: SubtreeItemView[] }) {
  if (items.length === 0) return null;
  return (
    <div className="task-handoff-subtree-items">
      <div className="task-handoff-heading">{title}</div>
      {items.map((item, i) => (
        <div key={i} className="task-handoff-finding">
          <div className="task-handoff-finding-heading">{item.heading}</div>
          {item.detail && <div className="task-handoff-detail">{item.detail}</div>}
          {item.reference && <div className="task-handoff-evidence">{item.reference}</div>}
        </div>
      ))}
    </div>
  );
}

/** The same handoff in expanded task details and an attempt log (ADR-0047); only the log carries the report. */
export default function TaskHandoff({ handoff, taskName, onReadFull }: {
  handoff: HandoffDigest | StoredHandoff;
  taskName?: (id: string) => string | undefined;
  onReadFull?: () => void;
}) {
  const severity = worstSeverity(handoff.findings);
  const report = 'report' in handoff ? handoff.report : undefined;
  const more = handoff.findingCount - handoff.findings.length;
  // A patch gets its own block below (ADR-0050); the artifacts list keeps the
  // author's references, which stay one line each.
  const artifacts = handoff.artifacts?.filter((a) => a.kind !== 'patch') ?? [];
  const patches = savedPatchViews(handoff);
  const openPatch = useOpenPatch();
  return (
    <section className="task-handoff" aria-label="Handoff">
      <div className="task-handoff-heading">Handoff · {handoffFindingsText(handoff.findingCount)}{severity ? ` · ${severityLabel(severity)}` : ''}</div>
      {handoff.commit && (
        <div className="task-handoff-commit">
          <div className="task-handoff-commit-subject">Commit: {handoff.commit.subject}</div>
          {handoff.commit.body && <div className="task-handoff-commit-body">{handoff.commit.body}</div>}
        </div>
      )}
      {handoff.summary && <div className="task-handoff-summary">{handoff.summary}</div>}
      {handoff.findings.map((finding) => (
        <div key={finding.id} className="task-handoff-finding" data-severity={finding.severity}>
          <div className="task-handoff-finding-heading">{finding.id} · {severityLabel(finding.severity)} · {finding.title}</div>
          {finding.detail && <div className="task-handoff-detail">{finding.detail}</div>}
          {finding.evidence?.length ? (
            <div className="task-handoff-evidence">Evidence: {finding.evidence.map((ref) => handoffReferenceText(ref, taskName)).join('; ')}</div>
          ) : null}
        </div>
      ))}
      {handoff.subtree && DELEGATION_OFFERED && (() => {
        const view = subtreeView(handoff.subtree);
        return (
          <div className="task-handoff-subtree">
            <div className="task-handoff-heading">Subtree</div>
            <div className="task-handoff-summary">{view.summary}</div>
            {view.outsideScope && <div className="task-handoff-patch-flag">{view.outsideScope}</div>}
            <SubtreeItems title="Open, for you to decide" items={view.open} />
            <SubtreeItems title="Passed up by its subplanner" items={view.promoted} />
          </div>
        );
      })()}
      {more > 0 && <div className="task-handoff-more">+{more} more finding{more === 1 ? '' : 's'}, in the attempt's log</div>}
      {artifacts.length ? (
        <div className="task-handoff-artifacts">
          <div className="task-handoff-heading">Artifacts</div>
          {artifacts.map((ref, i) => <div key={i}>{handoffReferenceText(ref, taskName)}</div>)}
        </div>
      ) : null}
      {patches.map((patch) => (
        <div key={patch.path} className="task-handoff-patch">
          <div className="task-handoff-heading">Patch · {patch.changes}</div>
          <div className="task-handoff-patch-saved">{patch.saved}</div>
          <div className="task-handoff-patch-base">{patch.base}</div>
          {patch.flags.map((flag) => <div key={flag} className="task-handoff-patch-flag">{flag}</div>)}
          {openPatch && <button type="button" className="task-log-open-btn" onClick={() => openPatch(patch.path)}>Open patch</button>}
        </div>
      ))}
      {report && (
        <div className="chat-report">
          <div className="chat-report-head">Report</div>
          <ReportBody lines={report.replace(/\n+$/, '').split('\n')} className="chat-report-body task-handoff-report" />
        </div>
      )}
      {onReadFull && <button type="button" className="task-log-open-btn" onClick={onReadFull}>Read full handoff</button>}
    </section>
  );
}
