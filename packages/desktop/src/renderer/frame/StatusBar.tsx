import type { DaemonStatus } from '../../shared/bridge';
import { daemonLabel } from '../DaemonBar';
import { slotsFor, useFrameState } from './store';

type Tone = 'passed' | 'attention' | 'failed' | 'idle';

function toneOf(status: DaemonStatus | undefined): Tone {
  switch (status?.state) {
    case 'connected': return 'passed';
    case 'reconnecting':
    case 'mismatch': return 'attention';
    case 'unauthorized':
    case 'port-taken':
    case 'failed': return 'failed';
    default: return 'idle';
  }
}

/** The bottom row: the daemon as main sees it, then the lease, runners and usage a later slice fills in. */
export function StatusBar({ daemon }: { daemon: DaemonStatus | undefined }): JSX.Element {
  const state = useFrameState();
  return (
    <footer className="frame-status">
      <span className={`frame-status-daemon frame-status-${toneOf(daemon)}`}>
        <span className="frame-status-dot" aria-hidden="true" />
        {daemon ? daemonLabel(daemon) : 'Reading the daemon…'}
      </span>
      {(['status.lease', 'status.runners', 'status.usage'] as const).map((slot) => (
        <span key={slot} className="frame-status-slot" data-slot={slot}>
          {slotsFor(state, slot).map((view) => <span key={view.id}>{view.render()}</span>)}
        </span>
      ))}
    </footer>
  );
}
