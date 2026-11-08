import { describe, it, expect } from 'vitest';
import { inspectRoutes } from 'hono/dev';
import { DAEMON_ROUTES, type RouteSpec, type UserGit, type WorkspaceReader } from '@ordewell/core';
import { createApp } from '../../app';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

/*
 * Core's route table is what the clients build their calls from (ADR-0063 H4),
 * so it must say what the daemon serves: a row with no route is a call that
 * 404s, and a route with no row is one no client can name. Building the app
 * only mounts the routers; nothing here is served.
 */

function served(): string[] {
  const app = createApp({} as unknown as OrchestratorPool, { port: 1, token: 't', tokenFile: 'token' }, {} as WorkspaceReader, {} as UserGit);
  return inspectRoutes(app).filter((route) => !route.isMiddleware).map((route) => `${route.method} ${route.path}`);
}

const rows: Array<[string, RouteSpec]> = Object.entries(DAEMON_ROUTES);

describe("core's daemon route table", () => {
  it('has a row for every route the daemon serves', () => {
    const tabled = new Set(rows.map(([, spec]) => `${spec.method} ${spec.path}`));
    expect(served().filter((route) => !tabled.has(route))).toEqual([]);
  });

  it('has a route the daemon serves for every row', () => {
    const routes = new Set(served());
    expect(rows.filter(([, spec]) => !routes.has(`${spec.method} ${spec.path}`)).map(([id]) => id)).toEqual([]);
  });

  it('gives each route one row', () => {
    const keys = rows.map(([, spec]) => `${spec.method} ${spec.path}`);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });
});
