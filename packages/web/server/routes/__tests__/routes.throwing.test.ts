import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { OrchestratorPool } from '../../pool/orchestratorPool';
import { modelsRoute } from '../models';
import { plansRoute } from '../plans';
import { runnersRoute } from '../runners';
import { sessionsRoute } from '../sessions';
import { settingsRoute } from '../settings';
import { workspacesRoute } from '../workspaces';

// Disk reads are what fail for real (a corrupt file, an unreadable directory),
// so the ones a route makes are the ones that throw here.
vi.mock('@ordewell/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ordewell/core')>()),
  installedPlannerDetected: vi.fn(async () => undefined),
  loadSession: vi.fn(() => { throw new Error('disk fault'); }),
  listTaskLogAttempts: vi.fn(() => { throw new Error('disk fault'); }),
  readTaskLog: vi.fn(() => { throw new Error('disk fault'); }),
}));
vi.mock('../../pool/orchestratorPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pool/orchestratorPool')>()),
  getSessionList: vi.fn(() => { throw new Error('disk fault'); }),
  scanWorkspaces: vi.fn(() => { throw new Error('disk fault'); }),
}));

const fault = () => { throw new Error('pool fault'); };
const faultAsync = async () => { throw new Error('pool fault'); };

// Every other route answers a throw with the ErrorBody every client reads;
// one without that wrapper gave a text/plain 500 the CLI showed as noise.
describe('a route whose call throws', () => {
  const pool = {
    getInstalledRunners: vi.fn(faultAsync),
    getProviderModels: vi.fn(faultAsync),
    discoverPlannerCatalogs: vi.fn(faultAsync),
    getSettings: vi.fn(fault),
    holds: vi.fn().mockReturnValue(true),
    close: vi.fn(faultAsync),
    cancelPlanning: vi.fn(fault),
  } as unknown as OrchestratorPool;

  const app = new Hono()
    .route('/api/runners', runnersRoute(pool))
    .route('/api/models', modelsRoute(pool))
    .route('/api/settings', settingsRoute(pool))
    .route('/api/sessions', sessionsRoute(pool))
    .route('/api/plans', plansRoute(pool))
    .route('/api/workspaces', workspacesRoute(pool));

  it.each([
    ['GET', '/api/runners', 'pool fault'],
    ['GET', '/api/models', 'pool fault'],
    ['GET', '/api/settings', 'pool fault'],
    ['POST', '/api/sessions/s1/close', 'pool fault'],
    ['POST', '/api/plans/s1/planning/stop', 'pool fault'],
    ['GET', '/api/sessions', 'disk fault'],
    ['GET', '/api/sessions/s1', 'disk fault'],
    ['GET', '/api/sessions/s1/tasks/t1/log', 'disk fault'],
    ['GET', '/api/sessions/s1/tasks/t1/log/1', 'disk fault'],
    ['GET', '/api/workspaces', 'disk fault'],
  ])('%s %s answers a JSON ErrorBody', async (method, path, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request(path, { method });

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: message });
  });
});
