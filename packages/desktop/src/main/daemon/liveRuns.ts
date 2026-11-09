import type { RouteId, RouteParams } from '../../shared/routes';

/** A live run, named the way a refusal or the quit dialog names it (ADR-0063 H3, H5). */
export interface LiveRun {
  sessionId: string;
  goal: string;
  workspace: string;
  /**
   * Another host holds it (ADR-0049), so it goes on whatever happens to this
   * app's daemon: a session joined in its holder's daemon (H8), a TUI's, an
   * editor's. Absent for a run this daemon holds, which stops with it.
   */
  elsewhere?: true;
}

export type DaemonGet = (routeId: RouteId, params?: RouteParams) => Promise<{ ok: boolean; data?: unknown }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a run this daemon holds is at work: the scheduler has something at
 * work or on its way. A snapshot with no activity is an older daemon's, taken
 * at its status word.
 */
function heldRunIsLive(run: Record<string, unknown>, status: unknown): boolean {
  if (!isRecord(run.activity)) return status === 'running';
  const a = run.activity;
  return a.starting === true || a.running === true || a.scheduled === true || a.advancesOnItsOwn === true;
}

/**
 * Every live run on the daemon, across the workspaces it has sessions in, or
 * undefined when any answer was missing: the caller refuses to stop a daemon
 * it could not check, so a partial answer must not read as "none".
 *
 * A run's plan is saved approved for as long as it lasts, so the saved status
 * cannot say one is at work: the list's `run` does (`SessionListEntry`). A row
 * an older daemon lists without one is taken at its status word, as before.
 * The session's own read then tells a run this daemon holds, whose snapshot
 * it carries, from one another host holds, which it does not.
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
      const listedLive = isRecord(meta.run) && meta.run.live === true;
      if (!listedLive && meta.status !== 'running') continue;
      const session = await get('sessions.get', { id: meta.id, workspace });
      if (!session.ok || !isRecord(session.data)) return undefined;
      const run = { sessionId: meta.id, goal: typeof meta.goal === 'string' ? meta.goal : meta.id, workspace };
      const held = session.data.run;
      if (isRecord(held)) {
        if (heldRunIsLive(held, meta.status)) live.push(run);
      } else if (listedLive) {
        live.push({ ...run, elsewhere: true });
      } else {
        // An older daemon's running plan with no snapshot to say otherwise.
        live.push(run);
      }
    }
  }
  return live;
}
