import { describe, expect, it } from 'vitest';
import type { RouteParams } from '../../../shared/routes';
import { findLiveRuns, type DaemonGet } from '../liveRuns';

type Answer = { ok: boolean; data?: unknown };

/** A daemon answering from a table keyed by route id and its params. */
function daemonGet(table: Record<string, Answer>): DaemonGet {
  return async (routeId, params?: RouteParams) => table[`${routeId} ${JSON.stringify(params ?? {})}`] ?? { ok: false };
}

const meta = (id: string, status: string, goal = `goal ${id}`) => ({ id, status, goal });

/** A row as a current daemon lists it mid-run: its plan saved approved, its run said by `run` (SessionListEntry). */
const listedLive = (id: string, goal: string, run: Record<string, unknown> = { live: true, done: 0, total: 2 }) => ({ id, status: 'approved', goal, run });
/** A session this daemon holds, as `sessions.get` answers it: the saved meta still approved, the run its snapshot. */
const heldRun = (activity: Record<string, unknown>) => ({
  meta: { status: 'approved' },
  run: { tasks: [], runMerge: null, handoff: null, mergeResult: null, activity: { starting: false, running: false, scheduled: false, advancesOnItsOwn: false, ...activity } },
});

describe('findLiveRuns', () => {
  it('names a run whose plan is saved approved, as every current daemon saves it', async () => {
    const get = daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: ['/a'] } },
      'sessions.list {"workspace":"/a"}': { ok: true, data: [listedLive('s1', 'Ship it'), meta('s2', 'approved'), meta('s3', 'draft')] },
      'sessions.get {"id":"s1","workspace":"/a"}': { ok: true, data: heldRun({ running: true, advancesOnItsOwn: true }) },
    });
    expect(await findLiveRuns(get)).toEqual([{ sessionId: 's1', goal: 'Ship it', workspace: '/a' }]);
  });

  it('names a run another host holds as going on elsewhere: this daemon holds no snapshot of it', async () => {
    const get = daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: ['/a'] } },
      // Another host's run is listed from its lease, so it carries no counts (SessionRunActivity).
      'sessions.list {"workspace":"/a"}': { ok: true, data: [listedLive('s1', 'Joined', { live: true })] },
      'sessions.get {"id":"s1","workspace":"/a"}': { ok: true, data: { meta: { status: 'approved' } } },
    });
    expect(await findLiveRuns(get)).toEqual([{ sessionId: 's1', goal: 'Joined', workspace: '/a', elsewhere: true }]);
  });

  it('does not count a run that settled, whether the list or the session read says so', async () => {
    const get = daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: ['/a'] } },
      // s1 is listed without a run: no session read is owed for it, and none is answered here.
      'sessions.list {"workspace":"/a"}': { ok: true, data: [meta('s1', 'approved'), listedLive('s2', 'Just ended')] },
      'sessions.get {"id":"s2","workspace":"/a"}': { ok: true, data: heldRun({}) },
    });
    expect(await findLiveRuns(get)).toEqual([]);
  });

  it('names the workspace the run is in, when another workspace has a session of the same id', async () => {
    const get = daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: ['/a', '/b'] } },
      'sessions.list {"workspace":"/a"}': { ok: true, data: [meta('s1', 'approved', 'Idle here')] },
      'sessions.list {"workspace":"/b"}': { ok: true, data: [listedLive('s1', 'At work there')] },
      'sessions.get {"id":"s1","workspace":"/b"}': { ok: true, data: heldRun({ running: true }) },
    });
    expect(await findLiveRuns(get)).toEqual([{ sessionId: 's1', goal: 'At work there', workspace: '/b' }]);
  });

  it('answers undefined when a listed run cannot be read back', async () => {
    expect(await findLiveRuns(daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: ['/a'] } },
      'sessions.list {"workspace":"/a"}': { ok: true, data: [listedLive('s1', 'Ship it')] },
    }))).toBeUndefined();
  });

  it('names each run whose scheduler still has work, across workspaces', async () => {
    const get = daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: ['/a', '/b'] } },
      'sessions.list {"workspace":"/a"}': { ok: true, data: [meta('s1', 'running', 'Ship it'), meta('s2', 'completed')] },
      'sessions.list {"workspace":"/b"}': { ok: true, data: [meta('s3', 'running')] },
      'sessions.get {"id":"s1","workspace":"/a"}': { ok: true, data: { meta: { status: 'running' }, run: { activity: { running: true } } } },
      'sessions.get {"id":"s3","workspace":"/b"}': { ok: true, data: { meta: { status: 'running' }, run: { activity: { scheduled: true } } } },
    });
    expect(await findLiveRuns(get)).toEqual([
      { sessionId: 's1', goal: 'Ship it', workspace: '/a' },
      { sessionId: 's3', goal: 'goal s3', workspace: '/b' },
    ]);
  });

  it('does not count a plan marked running whose scheduler has nothing at work', async () => {
    const get = daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: ['/a'] } },
      'sessions.list {"workspace":"/a"}': { ok: true, data: [meta('s1', 'running')] },
      'sessions.get {"id":"s1","workspace":"/a"}': {
        ok: true,
        data: { meta: { status: 'running' }, run: { activity: { starting: false, running: false, scheduled: false, advancesOnItsOwn: false } } },
      },
    });
    expect(await findLiveRuns(get)).toEqual([]);
  });

  it('takes an older daemon that sends no activity at its status word', async () => {
    const get = daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: ['/a'] } },
      'sessions.list {"workspace":"/a"}': { ok: true, data: [meta('s1', 'running')] },
      'sessions.get {"id":"s1","workspace":"/a"}': { ok: true, data: { meta: { status: 'running' } } },
    });
    expect(await findLiveRuns(get)).toHaveLength(1);
  });

  it('answers undefined, never "none", when any answer is missing', async () => {
    expect(await findLiveRuns(daemonGet({}))).toBeUndefined();
    expect(await findLiveRuns(daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: ['/a'] } },
    }))).toBeUndefined();
    expect(await findLiveRuns(daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: ['/a'] } },
      'sessions.list {"workspace":"/a"}': { ok: true, data: [meta('s1', 'running')] },
    }))).toBeUndefined();
    expect(await findLiveRuns(daemonGet({
      'workspaces.list {}': { ok: true, data: { workspaces: [7] } },
    }))).toBeUndefined();
  });

  it('answers none for a daemon with no workspaces', async () => {
    expect(await findLiveRuns(daemonGet({ 'workspaces.list {}': { ok: true, data: { workspaces: [] } } }))).toEqual([]);
  });
});
