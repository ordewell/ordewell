import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { IconButton, StatusIndicator, type StatusId } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { joinedShort } from '../../session/holder';
import { useSession } from '../../session/useSession';
import { parseSessions, type SessionRow } from '../../sessions';
import { useDaemonStatus } from '../../useDaemonStatus';
import { all } from '../Stub';
import { planProgress } from './PlanTab';

/** A session's status as the Sessions sidebar says it: a shape and a word (design, The Sessions sidebar). */
const SESSION_STATUS: Readonly<Record<string, { status: StatusId; word: string }>> = {
  planning: { status: 'not-started', word: 'Planning' },
  draft: { status: 'not-started', word: 'Draft' },
  approved: { status: 'not-started', word: 'Approved' },
  running: { status: 'running', word: 'Running' },
  completed: { status: 'passed', word: 'Settled' },
  settled: { status: 'passed', word: 'Settled' },
  failed: { status: 'failed', word: 'Failed' },
  rejected: { status: 'skipped', word: 'Rejected' },
};

export function sessionStatus(status: string): { status: StatusId; word: string } {
  return SESSION_STATUS[status] ?? { status: 'not-started', word: status ? status[0]!.toUpperCase() + status.slice(1) : 'Planning' };
}

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000], ['month', 30 * 86_400_000], ['week', 7 * 86_400_000],
  ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000],
];

export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const ago = now - at;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(ago) >= ms) return rtf.format(-Math.round(ago / ms), unit);
  }
  return 'now';
}

/** The workspace's sessions, newest first: a click opens one, taking its lease. */
export function Sessions({ host }: { host: DaemonHost }): JSX.Element {
  const connected = useDaemonStatus()?.state === 'connected';
  const { sessionId, goal, state, link } = useSession(host);
  const joined = link?.kind === 'joined' ? joinedShort(link.holder) : undefined;
  const planStatus = state.plan?.status;
  const [sessions, setSessions] = useState<SessionRow[] | string>();
  // The saved plan says Approved for as long as its run lasts, so the open session's row reads its live run instead.
  const progress = state.isExecuting || state.activity.advancesOnItsOwn ? planProgress(host) : undefined;
  const live = progress ? { status: 'running' as const, word: `Running ${progress.done}/${progress.total}` } : undefined;

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

  // The Reconnecting bar speaks for the daemon (W15): this list keeps what it last read, dimmed and inert, and claims no wait of its own.
  if (!connected && !Array.isArray(sessions)) return <p className="frame-empty">Sessions show here once the daemon is back.</p>;
  if (sessions === undefined) return <p className="frame-empty">Loading…</p>;
  if (typeof sessions === 'string') return <p className="frame-empty error">{sessions}</p>;
  if (sessions.length === 0) return <p className="frame-empty">No sessions yet. Describe a goal to the planner.</p>;
  return (
    <ul className="sessions" aria-disabled={connected ? undefined : 'true'}>
      {sessions.map((session) => {
        const { status, word } = (session.id === sessionId && live) || sessionStatus(session.status);
        const when = session.updatedAt ? relativeTime(session.updatedAt) : '';
        return (
          <li key={session.id}>
            <button
              type="button"
              className="session-row"
              aria-current={session.id === sessionId ? 'true' : undefined}
              disabled={!connected}
              title={session.goal || session.id}
              onClick={() => { if (session.id !== sessionId) void host.open(session.id); }}
            >
              <span className="session-goal">{session.goal || session.id}</span>
              <span className="session-meta">
                {joined && session.id === sessionId && <span className="session-joined" role="img" aria-label={`Joined · ${joined}`} title={`Joined · ${joined}`}>⇄</span>}
                <StatusIndicator status={status} size={12} />
                <span className="session-status">{word}</span>
                <span className="muted">· {session.taskCount} {session.taskCount === 1 ? 'task' : 'tasks'}{when && ` · ${when}`}</span>
              </span>
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
    api.registerSidebar({
      activity: 'sessions',
      id: 'sessions',
      title: 'Sessions',
      order: 10,
      actions: () => <IconButton icon={Plus} label="New session" onClick={() => host.newSession()} />,
      render: () => <Sessions host={host} />,
    }),
    api.registerCommand({ id: 'session.new', title: 'New session', enabled: () => !api.readOnly, run: () => host.newSession() }),
  );
}
