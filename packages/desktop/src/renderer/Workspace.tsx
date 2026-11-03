import { useEffect, useState } from 'react';
import { parseSessions, type SessionRow } from './sessions';

/** A workspace window: in this slice, the sessions the daemon has for it. */
export function Workspace({ path, connected }: { path: string; connected: boolean }): JSX.Element {
  const [sessions, setSessions] = useState<SessionRow[] | string>();

  useEffect(() => {
    if (!connected) return;
    let live = true;
    void window.ordewell.daemon.call('sessions.list', { workspace: path }).then((result) => {
      if (!live) return;
      if (!result.ok) { setSessions(result.error); return; }
      setSessions(parseSessions(result.data) ?? 'The daemon sent a session list this app cannot read.');
    });
    return () => { live = false; };
  }, [path, connected]);

  return (
    <div className="workspace">
      <header className="workspace-head">
        <h1>{path.split(/[\\/]/).filter(Boolean).pop() ?? path}</h1>
        <p className="muted">{path}</p>
      </header>
      <section>
        <h2>Sessions</h2>
        {!connected && <p className="muted">Waiting for the daemon…</p>}
        {connected && sessions === undefined && <p className="muted">Loading…</p>}
        {typeof sessions === 'string' && <p className="error">{sessions}</p>}
        {Array.isArray(sessions) && sessions.length === 0 && <p className="muted">No sessions in this workspace yet.</p>}
        {Array.isArray(sessions) && sessions.length > 0 && (
          <ul className="sessions">
            {sessions.map((session) => (
              <li key={session.id}>
                <span className="session-goal">{session.goal || session.id}</span>
                <span className={`session-status status-${session.status}`}>{session.status}</span>
                <span className="muted">{session.taskCount} {session.taskCount === 1 ? 'task' : 'tasks'} · {new Date(session.updatedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
