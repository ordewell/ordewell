import React, { useId, useState } from 'react';
import { REPORT_PREVIEW_LINES } from '@ordewell/core/plan-utils';

/**
 * A report drawn whole when short and folded when long: the fold says how
 * many lines it leaves out and opens on its own. A run update's research
 * reports (ADR-0037 R2) and a handoff's report read the same way.
 */
export default function ReportBody({ lines, className = 'chat-report-body' }: { lines: readonly string[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const folded = lines.length - REPORT_PREVIEW_LINES;
  return (
    <>
      <pre id={id} className={className}>{(open ? lines : lines.slice(0, REPORT_PREVIEW_LINES)).join('\n')}</pre>
      {folded > 0 && (
        <button type="button" className="cmd-row-more report-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less of the report' : `+${folded} line${folded === 1 ? '' : 's'} of the report`}
        </button>
      )}
    </>
  );
}
