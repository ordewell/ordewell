import { useEffect, useRef, useState } from 'react';
import type { DaemonCallResult } from '../../../shared/bridge';
import { parseSessions, type SessionRow } from '../../sessions';

/** How soon the list is read again while a session not open here has a run live: its row should settle soon after the run does. */
export const LIVE_LIST_MS = 5_000;
/** How soon otherwise: a run another window or host starts in a session not open here sends this one no frame to say so. */
export const IDLE_LIST_MS = 15_000;

/** The rows, or why there are none to show; undefined until the first answer. */
export type SessionList = SessionRow[] | string | undefined;

const UNREADABLE = 'The daemon sent a session list this app cannot read.';

function withoutRun(row: SessionRow): SessionRow {
  const saved = { ...row };
  delete saved.run;
  return saved;
}

/**
 * The workspace's sessions, as GET /api/sessions lists them, kept fresh for
 * the rows whose session is not open here. The daemon has no workspace-wide
 * event, and a socket per row would be a socket per session, so this is one
 * timer and one read at a time per list: sooner while another row is live, and
 * none while the window is hidden or the daemon away. `changed` is the open
 * session's own news (a new id, a goal, a plan status) and reads again at once.
 */
export function useSessionList(workspace: string, connected: boolean, openId: string | undefined, changed: string): SessionList {
  const [listed, setListed] = useState<{ workspace: string; sessions: SessionList }>();
  const openRef = useRef(openId);
  const readRef = useRef<() => void>();

  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let inFlight = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let otherLive = false;

    const schedule = (): void => {
      clearTimeout(timer);
      if (disposed || document.visibilityState === 'hidden') return;
      timer = setTimeout(read, otherLive ? LIVE_LIST_MS : IDLE_LIST_MS);
    };
    const settle = (answer: SessionRow[] | string): void => {
      inFlight = false;
      // Another workspace's list, or one read for a list no longer shown, is no answer for this one.
      if (disposed) return;
      setListed((prev) => {
        if (Array.isArray(answer) || prev?.workspace !== workspace || !Array.isArray(prev.sessions)) return { workspace, sessions: answer };
        // A read that failed keeps the rows it had, which are still saved as they say, but no run it can no longer vouch for.
        return { workspace, sessions: prev.sessions.map(withoutRun) };
      });
      otherLive = Array.isArray(answer) && answer.some((s) => s.run && s.id !== openRef.current);
      if (again) { again = false; read(); } else schedule();
    };
    function read(): void {
      clearTimeout(timer);
      if (inFlight) { again = true; return; }
      inFlight = true;
      void window.ordewell.daemon.call('sessions.list', { workspace }).then(
        (result: DaemonCallResult) => settle(result.ok ? parseSessions(result.data) ?? UNREADABLE : result.error),
        (err: unknown) => settle(err instanceof Error ? err.message : String(err)),
      );
    }
    const onVisibility = (): void => { if (document.visibilityState === 'visible') read(); else clearTimeout(timer); };

    readRef.current = read;
    document.addEventListener('visibilitychange', onVisibility);
    read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      readRef.current = undefined;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [workspace, connected]);

  const seen = useRef(changed);
  useEffect(() => {
    openRef.current = openId;
    if (seen.current === changed) return;
    seen.current = changed;
    readRef.current?.();
  }, [openId, changed]);

  return listed?.workspace === workspace ? listed.sessions : undefined;
}
