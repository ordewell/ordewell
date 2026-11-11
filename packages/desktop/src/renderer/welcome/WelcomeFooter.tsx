import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@ordewell/ui/design';
import type { DaemonStatus } from '../../shared/bridge';
import { daemonLabel } from '../DaemonBar';

type Tone = 'idle' | 'passed' | 'attention' | 'failed';

function toneOf(status: DaemonStatus | undefined): Tone {
  switch (status?.state) {
    case undefined:
    case 'connecting': return 'idle';
    case 'connected': return 'passed';
    case 'reconnecting':
    case 'mismatch': return 'attention';
    default: return 'failed';
  }
}

function daemonLine(status: DaemonStatus | undefined): string {
  if (!status || status.state === 'connecting') return 'daemon: connecting …';
  if (status.state === 'connected') {
    return [`daemon :${status.port}`, status.owned ? 'owned' : 'attached', status.daemon.version].filter(Boolean).join(' · ');
  }
  return daemonLabel(status);
}

/** The welcome window's foot, drawn like a workspace's status bar (design W1). */
export function WelcomeFooter({ version, status }: { version: string | undefined; status: DaemonStatus | undefined }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const tone = toneOf(status);
  const retry = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.ordewell.daemon.retry();
    } finally {
      setBusy(false);
    }
  };
  return (
    <footer className="welcome-footer">
      <span className="welcome-footer-text" title={version ? `Ordewell ${version}` : 'Ordewell'}>{version ? `Ordewell ${version}` : 'Ordewell'}</span>
      <span className={`welcome-footer-daemon welcome-footer-${tone}`} role="status">
        <span className="welcome-footer-dot" aria-hidden="true" />
        <span className="welcome-footer-text" title={daemonLine(status)}>{daemonLine(status)}</span>
        {tone !== 'idle' && tone !== 'passed' && (
          <Button size="sm" variant="ghost" icon={RotateCw} disabled={busy} onClick={() => { void retry(); }}>Retry</Button>
        )}
      </span>
    </footer>
  );
}
