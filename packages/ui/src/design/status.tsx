import type { ReactNode } from 'react';
import type { TaskRowView } from '@ordewell/core';
import { STALLED_LABEL, blockedByLabel, elapsedSince, holdLabel, skippedLabel, type TaskStatusKind } from '@ordewell/core/plan-utils';
import { strokeFor, NeedsYouGlyph, type IconSize } from './glyphs';

/**
 * The words a task's state is drawn with, everywhere (docs/desktop/design.md,
 * Status vocabulary). Each has a shape as well as a colour, so no state is
 * told apart by colour alone.
 */
export type StatusId =
  | 'not-started' | 'running' | 'stalled' | 'needs-you' | 'passed'
  | 'failed' | 'blocked' | 'skipped' | 'waiting-for-merge';

/** The colour family a status is drawn in: `--ow-status-<tone>`. */
export type StatusTone = 'idle' | 'running' | 'attention' | 'passed' | 'failed' | 'blocked' | 'merge';

export interface StatusLook {
  id: StatusId;
  label: string;
  tone: StatusTone;
}

export const STATUSES: Readonly<Record<StatusId, StatusLook>> = {
  'not-started': { id: 'not-started', label: 'Not started', tone: 'idle' },
  running: { id: 'running', label: 'Running', tone: 'running' },
  stalled: { id: 'stalled', label: STALLED_LABEL, tone: 'running' },
  'needs-you': { id: 'needs-you', label: 'Needs you', tone: 'attention' },
  passed: { id: 'passed', label: 'Passed', tone: 'passed' },
  failed: { id: 'failed', label: 'Failed', tone: 'failed' },
  blocked: { id: 'blocked', label: 'Blocked', tone: 'blocked' },
  skipped: { id: 'skipped', label: 'Skipped', tone: 'idle' },
  'waiting-for-merge': { id: 'waiting-for-merge', label: 'Waiting for merge', tone: 'merge' },
};

/**
 * Core's reading of a task, as a status to draw. A done task whose landing is
 * not merged yet waits for merge: core cannot tell, so the caller says.
 */
export function statusOf(kind: TaskStatusKind, options: { unmerged?: boolean } = {}): StatusLook {
  switch (kind) {
    case 'todo': return STATUSES['not-started'];
    case 'running': return STATUSES.running;
    case 'quiet': return STATUSES.stalled;
    case 'awaiting': return STATUSES['needs-you'];
    case 'blocked': return STATUSES.blocked;
    case 'failed': return STATUSES.failed;
    case 'skipped': return STATUSES.skipped;
    case 'done': return options.unmerged ? STATUSES['waiting-for-merge'] : STATUSES.passed;
  }
}

/** A mark drawn over a filled disc: the page's own background, so it reads on any state colour. */
const KNOCKOUT = { stroke: 'var(--ow-bg)' };

const SHAPES: Record<Exclude<StatusId, 'needs-you'>, ReactNode> = {
  'not-started': <circle cx="12" cy="12" r="8" />,
  running: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </>
  ),
  stalled: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </>
  ),
  passed: (
    <>
      <circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />
      <path d="m8 12.5 2.75 2.75L16 10" style={KNOCKOUT} />
    </>
  ),
  failed: (
    <>
      <circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />
      <path d="m9 9 6 6m0-6-6 6" style={KNOCKOUT} />
    </>
  ),
  blocked: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="m6.35 6.35 11.3 11.3" />
    </>
  ),
  skipped: <circle cx="12" cy="12" r="8" strokeDasharray="3.1 3.2" />,
  'waiting-for-merge': (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </>
  ),
};

export interface StatusIndicatorProps {
  status: StatusId;
  /** 14 in rows and cards, 16 in the task tab's header, 12 in chips and the rail. */
  size?: IconSize;
  /** Words that say more than the status's own, such as "Stalled · quiet for 4m". */
  label?: string;
  /** Show the words beside the shape; without them they are still the shape's name for a screen reader. */
  showLabel?: boolean;
  className?: string;
}

/** A status as shape, colour and word. A running shape turns, unless the user asked for less motion. */
export function StatusIndicator({ status, size = 16, label, showLabel = false, className }: StatusIndicatorProps): JSX.Element {
  const look = STATUSES[status];
  const words = label ?? look.label;
  const classes = ['ow-status', `ow-status-${look.tone}`, status === 'running' ? 'ow-status-turning' : '', className].filter(Boolean).join(' ');
  const strokeWidth = (strokeFor(size) * 24) / size;
  const shape = status === 'needs-you'
    ? <NeedsYouGlyph size={size} dot="currentColor" aria-hidden />
    : (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {SHAPES[status]}
      </svg>
    );
  return (
    <span className={classes} data-status={status} title={showLabel ? undefined : words} {...(showLabel ? {} : { role: 'img', 'aria-label': words })}>
      {shape}
      {showLabel && <span className="ow-status-label">{words}</span>}
    </span>
  );
}

/** The qualifier a status word carries, in the order a row's badge picks one. */
function qualifierOf(row: TaskRowView): string | null {
  if (row.status === 'skipped') return row.skipReason ? skippedLabel(row.skipReason) : null;
  return row.awaiting ?? row.approvals ?? row.receipt ?? row.attaching
    ?? (row.holdReason ? holdLabel(row.holdReason) : null)
    ?? (row.blockedBy ? blockedByLabel(row.blockedBy) : null);
}

/**
 * The status word with its reason and, for a quiet task, how long it has been
 * quiet: a plan panel row's third line and a graph card's, so the two never
 * word one task differently (docs/desktop/design.md, Task row contents).
 */
export function statusLineOf(row: TaskRowView, look: StatusLook, idleSince?: string | null, now: Date = new Date()): string {
  const qualifier = qualifierOf(row);
  const quiet = row.status === 'quiet' ? elapsedSince(idleSince ?? undefined, now.getTime()) : '';
  const line = qualifier ? (qualifier.startsWith(look.label) ? qualifier : `${look.label} · ${qualifier}`) : look.label;
  return quiet ? `${line} · quiet for ${quiet}` : line;
}
