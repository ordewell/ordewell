import { StatusIndicator, type StatusId } from '@ordewell/ui/design';
import type { DaemonStatus } from '../../shared/bridge';
import { daemonLabel } from '../DaemonBar';
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

/** The bottom row: the daemon as main sees it, then the lease, runners and usage a later slice fills in. */
export function StatusBar({ daemon }: { daemon: DaemonStatus | undefined }): JSX.Element {
  const state = useFrameState();
  const status = statusOf(daemon);
  return (
    <footer className="frame-status" data-region="status">
      <span className="frame-status-daemon" data-status={status}>
        <StatusIndicator status={status} size={12} showLabel label={daemon ? daemonLabel(daemon) : 'Reading the daemon…'} />
        {slotsFor(state, 'status.daemon').map((view) => <span key={view.id}>{view.render()}</span>)}
      </span>
      {(['status.lease', 'status.runners', 'status.usage'] as const).map((slot) => (
        <span key={slot} className="frame-status-slot" data-slot={slot}>
          {slotsFor(state, slot).map((view) => <span key={view.id}>{view.render()}</span>)}
        </span>
      ))}
    </footer>
  );
}
