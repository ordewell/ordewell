import { Hono } from 'hono';
import { installedPlannerDetected, type OkResponse, type RunnersResponse } from '@ordewell/core';
import { OrchestratorPool } from '../pool/orchestratorPool';
import { failure, jsonObject, refuse } from './errors';

export function runnersRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', async (c) => {
    // getInstalledRunners re-probes the host first, so the state read after it
    // reflects the fresh answer rather than the stale default. A workspace's
    // own `.envrc` can choose the account, so the probe and the planner's
    // model are judged for the one that will plan rather than the daemon's cwd.
    try {
      const workspace = c.req.query('workspace');
      const runners = await pool.getInstalledRunners(workspace);
      await pool.discoverPlannerCatalogs(undefined, workspace);
      const state = pool.getRunnerState(workspace);
      return c.json({
        runners,
        orchestratorModel: state.orchestratorModel,
      } satisfies RunnersResponse);
    } catch (err) {
      return failure(c, err, 'list runners');
    }
  });

  router.put('/:id', async (c) => {
    try {
      // A toggle saves the enabled set it changes; built on the stale default,
      // it would save claude-code over the installed agents the probe finds.
      await installedPlannerDetected();
      const id = c.req.param('id');
      const { enabled } = await jsonObject<{ enabled?: unknown }>(c);
      // A missing value is not `false`: before this, `{}` disabled the runner
      // while answering 200.
      if (typeof enabled !== 'boolean') return refuse(c, 400, 'enabled must be true or false');
      pool.setRunnerEnabled(id, enabled);
      return c.json({ ok: true } satisfies OkResponse);
    } catch (err) {
      return failure(c, err, 'runner toggle', { fallback: 400 });
    }
  });

  return router;
}
