import type { RouteId, RouteParams } from '../../shared/routes';

/** A run that stopping its daemon would stop, named the way a refusal names it (ADR-0063 H3). */
export interface LiveRun {
  sessionId: string;
  goal: string;
  workspace: string;
}

export type DaemonGet = (routeId: RouteId, params?: RouteParams) => Promise<{ ok: boolean; data?: unknown }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a session's run would stop with its daemon. Only the run's own
 * activity says so: a plan marked running whose scheduler has nothing at work
 * and nothing on its way is a run that stopped, and an older daemon that
 * sends no activity is taken at its status word.
 */
function isLive(session: unknown): boolean {
  if (!isRecord(session) || !isRecord(session.meta) || session.meta.status !== 'running') return false;
  if (!isRecord(session.run) || !isRecord(session.run.activity)) return true;
  const a = session.run.activity;
  return a.starting === true || a.running === true || a.scheduled === true || a.advancesOnItsOwn === true;
}

/**
 * Every live run on the daemon, across the workspaces it has sessions in, or
 * undefined when any answer was missing: the caller refuses to stop a daemon
 * it could not check, so a partial answer must not read as "none".
 */
export async function findLiveRuns(get: DaemonGet): Promise<LiveRun[] | undefined> {
  const workspaces = await get('workspaces.list');
  if (!workspaces.ok || !isRecord(workspaces.data) || !Array.isArray(workspaces.data.workspaces)) return undefined;

  const live: LiveRun[] = [];
  for (const workspace of workspaces.data.workspaces) {
    if (typeof workspace !== 'string') return undefined;
    const list = await get('sessions.list', { workspace });
    if (!list.ok || !Array.isArray(list.data)) return undefined;
    for (const meta of list.data) {
      if (!isRecord(meta) || typeof meta.id !== 'string') return undefined;
      if (meta.status !== 'running') continue;
      const session = await get('sessions.get', { id: meta.id, workspace });
      if (!session.ok) return undefined;
      if (isLive(session.data)) live.push({ sessionId: meta.id, goal: typeof meta.goal === 'string' ? meta.goal : meta.id, workspace });
    }
  }
  return live;
}
