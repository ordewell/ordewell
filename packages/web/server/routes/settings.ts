import { Hono } from 'hono';
import { RunSettingsError, containersOffered, installedPlannerDetected, type ContainerChange, type ContainerChangeResponse, type ContainerStatus, type GlobalRunSettings, type SettingsResponse, type SettingsUpdateResponse } from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';
import { failure, jsonObject, refuse } from './errors';

/** One change, so a surface cannot half-apply two; `changeContainers` judges what it holds. */
function containerChange(body: Record<string, unknown>): ContainerChange | null {
  const change = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'workspace'));
  if (Object.keys(change).length !== 1) return null;
  if (typeof change.on === 'boolean') return { on: change.on };
  if (typeof change.image === 'string') return { image: change.image };
  return 'login' in change ? { login: change.login } : null;
}

export function settingsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  // Not there at all in a build that does not offer containers (ADR-0059 L5):
  // the same answer as any other route it does not have.
  router.use('/containers', async (c, next) => {
    if (!containersOffered()) return refuse(c, 404, 'This build does not offer containers');
    return next();
  });

  router.get('/containers', async (c) => {
    try {
      const status: ContainerStatus = await pool.containerStatus(c.req.query('prove') === '1', c.req.query('workspace') || undefined);
      return c.json(status);
    } catch (err) {
      return failure(c, err, 'containers status');
    }
  });

  router.patch('/containers', async (c) => {
    try {
      const body = await jsonObject(c);
      const change = containerChange(body);
      if (!change) return refuse(c, 400, 'One of on, image or login is required');
      const { workspace } = body;
      const result: ContainerChangeResponse = await pool.changeContainers(change, typeof workspace === 'string' ? workspace || undefined : undefined);
      return c.json(result);
    } catch (err) {
      return failure(c, err, 'containers change', { fallback: 400 });
    }
  });

  // Both wait for the startup probe (ADR-0009): the TUI reads the planner from
  // here the moment it opens, and a /planner switch is judged against the
  // planner in effect, which the probe may be about to change.
  router.get('/', async (c) => {
    try {
      await installedPlannerDetected();
      // An open session answers with its own run settings; no id or an id it no
      // longer holds answers with the file's, which a new session starts from
      // (ADR-0030). The planner's model is judged against the runner catalog of
      // the session's workspace, else of the one the client is in, waited for
      // only where it decides that model (ADR-0040).
      const sessionId = c.req.query('sessionId') || undefined;
      const workspace = c.req.query('workspace') || undefined;
      await pool.discoverPlannerCatalogs(sessionId, workspace);
      const settings: SettingsResponse = pool.getSettings(sessionId, workspace);
      return c.json(settings);
    } catch (err) {
      return failure(c, err, 'read settings');
    }
  });

  router.patch('/', async (c) => {
    try {
      await installedPlannerDetected();
      const body = await jsonObject(c);
      // Every client names its workspace, which is not itself a change.
      if (Object.keys(body).every((key) => key === 'workspace')) {
        return refuse(c, 400, 'At least one setting field is required');
      }
      // Run settings (ADR-0030) are named fields under `run`, never environment
      // variables; `sessionId` is the session the change was made in, and
      // `workspace` the one the client is in, whose catalog a pick is judged by.
      const { run, sessionId: namedSession, workspace: namedWorkspace, ...rest } = body;
      if (namedSession !== undefined && typeof namedSession !== 'string') return refuse(c, 400, 'sessionId must be a string');
      if (namedWorkspace !== undefined && typeof namedWorkspace !== 'string') return refuse(c, 400, 'workspace must be a string');
      const sessionId = namedSession || undefined;
      const workspace = namedWorkspace || undefined;
      if (run !== undefined) {
        if (!run || typeof run !== 'object' || Array.isArray(run)) return refuse(c, 400, 'run must be an object of run settings');
        try {
          pool.updateRunSettings(run as Partial<GlobalRunSettings>, sessionId, workspace);
        } catch (err) {
          if (err instanceof RunSettingsError) return refuse(c, 400, err.message);
          throw err;
        }
      }
      // Only a planner switch waits for a catalog, the one it is judged
      // against, which no client has asked for yet when it switches (ADR-0040).
      const result: SettingsUpdateResponse = Object.keys(rest).length > 0
        ? await pool.writeSettings(rest, sessionId, workspace)
        : pool.getSettings(sessionId, workspace);
      return c.json(result);
    } catch (err) {
      return failure(c, err, 'settings update', { fallback: 400 });
    }
  });

  return router;
}
