import { describe, it, expect } from 'vitest';
import { DAEMON_ROUTES, type RouteSpec } from '../daemonRoutes';

// Whether each row names a route the daemon serves is packages/web's check;
// these are what a row must hold for a client to build a call from it.
const rows: Array<[string, RouteSpec]> = Object.entries(DAEMON_ROUTES);

describe('the daemon route table', () => {
  it('keeps every path under /api, with its query left to the row', () => {
    expect(rows.filter(([, spec]) => !/^\/api(\/[A-Za-z0-9:._-]+)*$/.test(spec.path)).map(([id]) => id)).toEqual([]);
  });

  // A client sends a live row to the host holding the session it names.
  it('names a live row its session by one of its own path params', () => {
    expect(rows.filter(([, spec]) => spec.live !== undefined && !spec.path.split('/').includes(`:${spec.live}`)).map(([id]) => id)).toEqual([]);
  });

  // The daemon keeps one session per id: without the caller's workspace it could not tell another project's from its own.
  it('lets a live row name the workspace it is asked from', () => {
    expect(rows.filter(([, spec]) => spec.live !== undefined && !(spec.query ?? []).includes('workspace')).map(([id]) => id)).toEqual([]);
  });

  it('never lets a query key shadow a path param', () => {
    const shadowed = rows.filter(([, spec]) => (spec.query ?? []).some((key) => spec.path.split('/').includes(`:${key}`)));
    expect(shadowed.map(([id]) => id)).toEqual([]);
  });
});
