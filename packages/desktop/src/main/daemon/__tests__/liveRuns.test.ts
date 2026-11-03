import { describe, expect, it } from 'vitest';
import type { RouteParams } from '../../../shared/routes';
import { findLiveRuns, type DaemonGet } from '../liveRuns';

type Answer = { ok: boolean; data?: unknown };

/** A daemon answering from a table keyed by route id and its params. */
function daemonGet(table: Record<string, Answer>): DaemonGet {
  return async (routeId, params?: RouteParams) => table[`${routeId} ${JSON.stringify(params ?? {})}`] ?? { ok: false };
}

const meta = (id: string, status: string, goal = `goal ${id}`) => ({ id, status, goal });

describe('findLiveRuns', () => {
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
