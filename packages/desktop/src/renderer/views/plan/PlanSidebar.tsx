import { useEffect, useRef, useState } from 'react';
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
export function Sessions({ host }: { host: DaemonHost }): JSX.Element {
  const connected = useDaemonStatus()?.state === 'connected';
  const { sessionId, goal, state } = useSession(host);
  const planStatus = state.plan?.status;
  const [sessions, setSessions] = useState<SessionRow[] | string>();

  // Read again when the session changes, the planner names a new one's goal, or
  // the open plan moves on (approved, running, done): each is a row this list
  // lacks or shows stale.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void window.ordewell.daemon.call('sessions.list', { workspace: host.workspace }).then((result) => {
      if (!live) return;
      if (!result.ok) { setSessions(result.error); return; }
      setSessions(parseSessions(result.data) ?? 'The daemon sent a session list this app cannot read.');
    });
    return () => { live = false; };
  }, [host, connected, sessionId, goal, planStatus]);

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

/** A live task's "last seen" while the daemon is away: the view never infers progress it did not see. */
function useAgo(connected: boolean): number {
  const lastConnected = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (connected) {
      lastConnected.current = Date.now();
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [connected]);
  return connected ? 0 : Math.max(0, now - lastConnected.current);
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s ago`;
}

/** The plan as a compact tree: each task's status and title, opening its tab. */
function Tasks({ host }: { host: DaemonHost }): JSX.Element {
  const { state } = useSession(host);
  const connected = useDaemonStatus()?.state === 'connected';
  const elapsed = useAgo(connected);
  const tasks = state.plan?.tasks ?? [];
  if (tasks.length === 0) return <p className="frame-empty">No plan yet: tell the planner the goal.</p>;
  // The run carries each task's live status; the plan, what a task is when nothing has run it.
  const live = new Map([...walkPlan(state.run.tasks)].map((p) => [p.task.id, p.task]));
  return (
    <ul className="session-tree" aria-label="Tasks">
      {[...walkPlan(tasks)].map(({ task, label, ancestors }) => {
        const running = live.get(task.id);
        const status = statusOf(taskStatusKind(running ?? task));
        return (
          <li key={task.id} style={{ paddingInlineStart: `${ancestors.length * 12}px` }}>
            <button type="button" className="session-tree-row" onClick={() => host.openTask(task.id, 'details')}>
              <StatusIndicator status={status.id} size={12} />
              <span className="session-tree-label">#{label}</span>
              <span className="session-tree-title">{task.title}</span>
              {!connected && running?.status === 'in_progress' && <span className="muted">last seen {ago(elapsed)}</span>}
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
