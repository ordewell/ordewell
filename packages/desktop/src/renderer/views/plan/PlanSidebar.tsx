import { useEffect, useState } from 'react';
import type { FrameApi, Unregister } from '../../frame/api';
import { parseSessions, type SessionRow } from '../../sessions';
import { useDaemonStatus } from '../../useDaemonStatus';

/**
 * The Plan sidebar's sessions, as the shell tracer listed them. Design slice 8
 * (W2–W4) owns this file: it becomes the plan outline and the session picker.
 */
function Sessions({ workspace }: { workspace: string }): JSX.Element {
  const connected = useDaemonStatus()?.state === 'connected';
  const [sessions, setSessions] = useState<SessionRow[] | string>();

  useEffect(() => {
    if (!connected) return;
    let live = true;
    void window.ordewell.daemon.call('sessions.list', { workspace }).then((result) => {
      if (!live) return;
      if (!result.ok) { setSessions(result.error); return; }
      setSessions(parseSessions(result.data) ?? 'The daemon sent a session list this app cannot read.');
    });
    return () => { live = false; };
  }, [workspace, connected]);

  if (!connected) return <p className="frame-empty">Waiting for the daemon…</p>;
  if (sessions === undefined) return <p className="frame-empty">Loading…</p>;
  if (typeof sessions === 'string') return <p className="frame-empty error">{sessions}</p>;
  if (sessions.length === 0) return <p className="frame-empty">No sessions in this workspace yet.</p>;
  return (
    <ul className="sessions">
      {sessions.map((session) => (
        <li key={session.id}>
          <span className="session-goal">{session.goal || session.id}</span>
          <span className="session-status">{session.status}</span>
          <span className="muted">{session.taskCount} {session.taskCount === 1 ? 'task' : 'tasks'}{session.updatedAt && ` · ${new Date(session.updatedAt).toLocaleString()}`}</span>
        </li>
      ))}
    </ul>
  );
}

export function register(api: FrameApi): Unregister {
  return api.registerSidebar({ activity: 'plan', id: 'sessions', title: 'Sessions', order: 10, render: () => <Sessions workspace={api.workspace} /> });
}
