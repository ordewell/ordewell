import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { taskStatusKind, walkPlan } from '@ordewell/core/plan-utils';
import { IconButton, StatusIndicator, statusOf } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { useSession } from '../../session/useSession';
import { parseSessions, type SessionRow } from '../../sessions';
import { useDaemonStatus } from '../../useDaemonStatus';
import { all } from '../Stub';

/** The workspace's sessions, newest first: a click opens one, taking its lease; New session starts a blank one. */
function Sessions({ host }: { host: DaemonHost }): JSX.Element {
  const connected = useDaemonStatus()?.state === 'connected';
  const { sessionId, goal } = useSession(host);
  const [sessions, setSessions] = useState<SessionRow[] | string>();

  // Read again when the session changes or the planner names a new one's goal: either is a row this list lacks.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void window.ordewell.daemon.call('sessions.list', { workspace: host.workspace }).then((result) => {
      if (!live) return;
      if (!result.ok) { setSessions(result.error); return; }
      setSessions(parseSessions(result.data) ?? 'The daemon sent a session list this app cannot read.');
    });
    return () => { live = false; };
  }, [host, connected, sessionId, goal]);

  const list = (): JSX.Element => {
    if (!connected) return <p className="frame-empty">Waiting for the daemon…</p>;
    if (sessions === undefined) return <p className="frame-empty">Loading…</p>;
    if (typeof sessions === 'string') return <p className="frame-empty error">{sessions}</p>;
    if (sessions.length === 0) return <p className="frame-empty">No sessions in this workspace yet.</p>;
    return (
      <ul className="sessions">
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              className="session-row"
              aria-current={session.id === sessionId ? 'true' : undefined}
              onClick={() => { if (session.id !== sessionId) void host.open(session.id); }}
            >
              <span className="session-goal">{session.goal || session.id}</span>
              <span className="session-status">{session.status}</span>
              <span className="muted">{session.taskCount} {session.taskCount === 1 ? 'task' : 'tasks'}{session.updatedAt && ` · ${new Date(session.updatedAt).toLocaleString()}`}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="session-sessions">
      <div className="frame-toolbar">
        <IconButton icon={Plus} label="New session" onClick={() => host.newSession()} />
      </div>
      {list()}
    </div>
  );
}

/** The plan as a compact tree: each task's status and title, opening its tab. */
function Tasks({ host }: { host: DaemonHost }): JSX.Element {
  const { state } = useSession(host);
  const tasks = state.plan?.tasks ?? [];
  if (tasks.length === 0) return <p className="frame-empty">No plan yet: tell the planner the goal.</p>;
  // The run carries each task's live status; the plan, what a task is when nothing has run it.
  const live = new Map([...walkPlan(state.run.tasks)].map((p) => [p.task.id, p.task]));
  return (
    <ul className="session-tree" aria-label="Tasks">
      {[...walkPlan(tasks)].map(({ task, label, ancestors }) => {
        const status = statusOf(taskStatusKind(live.get(task.id) ?? task));
        return (
          <li key={task.id} style={{ paddingInlineStart: `${ancestors.length * 12}px` }}>
            <button type="button" className="session-tree-row" onClick={() => host.openTask(task.id, 'details')}>
              <StatusIndicator status={status.id} size={12} />
              <span className="session-tree-label">#{label}</span>
              <span className="session-tree-title">{task.title}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  return all(
    api.registerSidebar({ activity: 'plan', id: 'sessions', title: 'Sessions', order: 10, render: () => <Sessions host={host} /> }),
    api.registerSidebar({ activity: 'plan', id: 'tasks', title: 'Tasks', order: 20, render: () => <Tasks host={host} /> }),
    api.registerCommand({ id: 'session.new', title: 'New session', run: () => host.newSession() }),
  );
}
