import { useState } from 'react';
import { StatusIndicator, type StatusId } from '@ordewell/ui/design';
import type { DaemonStatus } from '../../shared/bridge';
import { daemonDetail, daemonLabel } from '../DaemonBar';
import { slotsFor, useFrameState } from './store';

/** The daemon's state in the status vocabulary, so it reads with the same shapes as a task's. */
function statusOf(status: DaemonStatus | undefined): StatusId {
  switch (status?.state) {
    case 'connected': return 'passed';
    case 'reconnecting': return 'stalled';
    case 'mismatch': return 'needs-you';
    case 'unauthorized':
    case 'port-taken':
    case 'failed': return 'failed';
    default: return 'not-started';
  }
}

const DETAIL_ID = 'frame-status-detail';

/**
 * The bottom row, one line: the daemon, and a newer version while one is known.
 * The daemon item says its version and port, or what needs the user; who
 * started it and the session's lease are in its detail, shown on hover or
 * focus. Usage and the runners' sign-in are the planner's and the task chats'
 * to show, so the row never outgrows a narrow or zoomed window.
 */
export function StatusBar({ daemon }: { daemon: DaemonStatus | undefined }): JSX.Element {
  const state = useFrameState();
  const [open, setOpen] = useState(false);
  const status = statusOf(daemon);
  const label = daemon ? daemonLabel(daemon) : 'Reading the daemon…';
  return (
    <footer className="frame-status" data-region="status">
      <span
        className="frame-status-daemon"
        data-status={status}
        tabIndex={0}
        aria-describedby={open ? DETAIL_ID : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
      >
        <StatusIndicator status={status} size={12} showLabel label={label} />
        {open && (
          <span id={DETAIL_ID} className="frame-status-detail" role="tooltip">
            <span>{daemon ? daemonDetail(daemon) : label}</span>
            {slotsFor(state, 'status.daemon').map((view) => <span key={view.id}>{view.render()}</span>)}
          </span>
        )}
      </span>
      <span className="frame-status-slot" data-slot="status.update">
        {slotsFor(state, 'status.update').map((view) => <span key={view.id}>{view.render()}</span>)}
      </span>
    </footer>
  );
}
