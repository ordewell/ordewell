import { useEffect, useState } from 'react';
import { DAEMON_STILL_WAITING_MS, daemonStillWaitingLine, daemonWaitLine } from '@ordewell/core/plan-utils';
import type { DaemonStatus } from '../../shared/bridge';

/** Long enough that a start which answers at once shows nothing more than the dimmed frame. */
export const DAEMON_WAIT_CARD_DELAY_MS = 400;

type Phase = 'quiet' | 'card' | 'late';

/**
 * How far into a wait for the daemon this window is: nothing at first, the
 * card after a moment, the log line once the wait is as long as the one the
 * terminal names it after. Counted from when this window first saw the wait.
 */
function useWaitPhase(waiting: boolean): Phase {
  const [phase, setPhase] = useState<Phase>('quiet');
  useEffect(() => {
    setPhase('quiet');
    if (!waiting) return;
    const card = setTimeout(() => setPhase('card'), DAEMON_WAIT_CARD_DELAY_MS);
    const late = setTimeout(() => setPhase('late'), DAEMON_STILL_WAITING_MS);
    return () => { clearTimeout(card); clearTimeout(late); };
  }, [waiting]);
  return waiting ? phase : 'quiet';
}

/**
 * The wait for the daemon at the start of a project window, over the frame
 * it holds inert (design.md, Shared states: a load still pending after a
 * moment names what it loads). It names the wait in core's words, the same
 * line the welcome window gives, and after about five seconds where the
 * daemon's log is, as the terminal does. It has no action: nothing in the
 * frame can be used until the daemon answers, and nothing here changes that.
 */
export function DaemonWait({ daemon }: { daemon: DaemonStatus | undefined }): JSX.Element | null {
  const waiting = daemon?.state === 'connecting';
  const phase = useWaitPhase(waiting);
  if (!waiting || phase === 'quiet') return null;
  return (
    <div className="frame-wait">
      <div className="frame-wait-card" role="status" aria-live="polite">
        <p className="frame-wait-line">
          <span className="ow-loading-mark" aria-hidden="true" />
          <span>{daemonWaitLine(daemon.port, daemon.starting === true)}</span>
        </p>
        {phase === 'late' && daemon.logPath !== undefined && (
          <p className="frame-wait-log">{daemonStillWaitingLine(daemon.port, daemon.logPath)}</p>
        )}
      </div>
    </div>
  );
}
