import { Hono, type Context } from 'hono';
import { PlanEditError } from '@ordewell/core';
import { OrchestratorPool } from '../pool/orchestratorPool';

/**
 * The three answers a task edit can have. A refusal is the request being wrong
 * (400), a missing session is 404, and only a real fault is 500 — collapsing
 * all three into 404/500 gave the TUI and VS Code nothing to show but "Internal
 * error", which reads as the edit having silently done nothing.
 */
function editFailure(c: Context, err: unknown) {
  const e = err as Error;
  if (e.message === 'Session not found') return c.json({ error: e.message }, 404);
  if (e instanceof PlanEditError) return c.json({ error: e.message }, 400);
  console.error('[plans] task edit failed:', err);
  return c.json({ error: e.message || 'Internal error' }, 500);
}

export function plansRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.post('/:sessionId/generate', async (c) => {
    try {
      const { goal, runners, workspace, model } = await c.req.json();
      if (!goal) return c.json({ error: 'goal is required' }, 400);
      const ws = workspace || c.req.query('workspace') || process.cwd();
      const queryRunners = c.req.query('runners');
      // No runners in the request means "whatever is enabled", not claude-code:
      // a hard-coded default here contradicts the /runners toggle state and
      // fails planning for anyone who disabled claude-code.
      const runnerList: string[] = Array.isArray(runners) ? runners : (runners ? [runners] : (queryRunners ? queryRunners.split(',').map(s => s.trim()).filter(Boolean) : pool.getRunnerState().enabledRunners));
      const plan = await pool.generatePlan(c.req.param('sessionId'), goal, runnerList, ws, model);
      const { models, modelsByRunner } = await pool.getProviderModels();
      return c.json({ plan, models, modelsByRunner });
    } catch (err) {
      // Log before returning: the message alone travels to the client, so an
      // unexpected throw in here (a research tool crashing the whole turn, say)
      // left no stack anywhere — server.log showed nothing and the CLI showed
      // one line. Diagnosing that cost far more than this console.error.
      console.error('[plans] generate failed:', err);
      return c.json({ error: err instanceof Error ? (err as Error).message : 'Plan generation failed' }, 500);
    }
  });

  router.post('/:sessionId/execute', async (c) => {
    try {
      await pool.session(c.req.param('sessionId')).executePlan();
      return c.json({ status: 'running' });
    } catch (err) {
      const e = err as Error;
      const status = e.message === 'Session not found' ? 404 : e.message === 'No plan to execute' ? 400 : e.message === 'Session already executing' ? 409 : 500;
      return c.json({ error: e.message }, status as Parameters<typeof c.json>[1]);
    }
  });

  router.post('/:sessionId/stop', (c) => {
    if (pool.hasSession(c.req.param('sessionId'))) pool.session(c.req.param('sessionId')).stopExecution();
    return c.json({ status: 'stopped' });
  });

  // Distinct from the stop route above, which halts *execution* (running
  // tasks). This aborts a planning turn in flight — a harmless no-op, not a
  // 404, when the session simply isn't planning right now.
  router.post('/:sessionId/planning/stop', (c) => {
    const cancelled = pool.cancelPlanning(c.req.param('sessionId'));
    return c.json({ cancelled });
  });

  router.post('/:sessionId/tasks/:taskId/complete', async (c) => {
    try {
      await pool.session(c.req.param('sessionId')).markTaskComplete(c.req.param('taskId'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? (err as Error).message : 'Not found' }, 404);
    }
  });

  router.post('/:sessionId/tasks/:taskId/uncomplete', async (c) => {
    try {
      await pool.session(c.req.param('sessionId')).markTaskIncomplete(c.req.param('taskId'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? (err as Error).message : 'Not found' }, 404);
    }
  });

  // Orchestrator controls — these spawn or kill runner processes, so they are
  // deliberately separate from the generic `PUT tasks/:taskId` status patch.
  for (const [segment, run] of [
    ['run', (s: ReturnType<typeof pool.session>, id: string) => s.runTask(id)],
    ['force-start', (s: ReturnType<typeof pool.session>, id: string) => s.forceStartTask(id)],
    ['retry', (s: ReturnType<typeof pool.session>, id: string) => s.retryTask(id)],
    ['cancel', (s: ReturnType<typeof pool.session>, id: string) => s.cancelTask(id)],
  ] as const) {
    router.post(`/:sessionId/tasks/:taskId/${segment}`, async (c) => {
      try {
        await run(pool.session(c.req.param('sessionId')), c.req.param('taskId'));
        return c.json({ ok: true });
      } catch (err) {
        const status = (err as Error).message === 'Session not found' ? 404 : 500;
        return c.json({ error: (err as Error).message }, status as never);
      }
    });
  }

  router.put('/:sessionId/tasks/:taskId', async (c) => {
    try {
      const { assignedRunner, dependencies, ...rest } = await c.req.json();
      const session = pool.session(c.req.param('sessionId'));
      const taskId = c.req.param('taskId');

      // Two fields are not field writes. A runner change carries the task's
      // model, effort and mode with it, and a dependency list has to be
      // validated against the whole graph — each has one owner on the session.
      // The runner goes first: its retarget derives a model, and an explicit
      // model in the same patch must win over that derived one.
      const hasRunner = typeof assignedRunner === 'string';
      const hasDeps = Array.isArray(dependencies);

      let result = null;
      if (hasRunner) result = await session.setTaskRunner(taskId, assignedRunner);
      if (hasDeps) {
        try {
          result = await session.setTaskDependencies(taskId, dependencies.map(String));
        } catch (err) {
          // A rejected dependency edit is the client's mistake, not a fault.
          return c.json({ error: (err as Error).message }, 400);
        }
      }
      // An empty patch still reaches updateTask — that is how a caller asks
      // whether the task exists at all.
      if (Object.keys(rest).length > 0 || (!hasRunner && !hasDeps)) result = await session.updateTask(taskId, rest);

      if (!result) return c.json({ error: 'Task not found' }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return editFailure(c, err);
    }
  });

  router.delete('/:sessionId/tasks/:taskId', async (c) => {
    try {
      const result = await pool.session(c.req.param('sessionId')).removeTask(c.req.param('taskId'));
      if (!result) return c.json({ error: 'Task not found' }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return editFailure(c, err);
    }
  });

  router.post('/:sessionId/tasks', async (c) => {
    try {
      const body = await c.req.json();
      const result = await pool.session(c.req.param('sessionId')).addTask(body);
      if (!result) return c.json({ error: 'Session not found' }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return editFailure(c, err);
    }
  });

  router.post('/:sessionId/review/approve', async (c) => {
    try {
      const plan = await pool.session(c.req.param('sessionId')).approveReview();
      return c.json({ plan });
    } catch (err) {
      const e = err as Error;
      const status = e.message === 'Session not found' ? 404
        : e.message === 'No plan to review' ? 400
        : 500;
      return c.json({ error: e.message }, status as Parameters<typeof c.json>[1]);
    }
  });

  router.post('/:sessionId/tasks/merge', async (c) => {
    try {
      const { taskIds } = await c.req.json();
      if (!taskIds || !Array.isArray(taskIds) || taskIds.length < 2) {
        return c.json({ error: 'taskIds array with at least two ids is required' }, 400);
      }
      const plan = await pool.session(c.req.param('sessionId')).requestMerge(taskIds);
      return c.json({ plan });
    } catch (err) {
      const e = err as Error;
      const status = e.message === 'Session not found' ? 404 : 400;
      return c.json({ error: e.message }, status as Parameters<typeof c.json>[1]);
    }
  });

  router.post('/:sessionId/tasks/:taskId/split', async (c) => {
    try {
      const plan = await pool.session(c.req.param('sessionId')).requestSplit(c.req.param('taskId'));
      return c.json({ plan });
    } catch (err) {
      const e = err as Error;
      const status = e.message === 'Session not found' ? 404 : 400;
      return c.json({ error: e.message }, status as Parameters<typeof c.json>[1]);
    }
  });

  // Conversational planning (ADR-0002): start the planner dialogue. The
  // response's plan carries conversationHistory; when tasks are non-empty the
  // planner committed the plan.
  router.post('/:sessionId/converse/start', async (c) => {
    try {
      const { goal, runners, workspace, model } = await c.req.json();
      if (!goal) return c.json({ error: 'goal is required' }, 400);
      const ws = workspace || c.req.query('workspace') || process.cwd();
      const runnerList: string[] = Array.isArray(runners) ? runners : (runners ? [runners] : pool.getRunnerState().enabledRunners);
      const plan = await pool.startPlanning(c.req.param('sessionId'), goal, runnerList, ws, model);
      return c.json({ plan });
    } catch (err) {
      return c.json({ error: err instanceof Error ? (err as Error).message : 'Planning failed' }, 500);
    }
  });

  // One branch for every user reply — grill-me answers, PRD accept/adjust,
  // outline confirm. The planner decides what happens next.
  router.post('/:sessionId/converse/message', async (c) => {
    try {
      const { message } = await c.req.json();
      if (!message) return c.json({ error: 'message is required' }, 400);
      const plan = await pool.continuePlanning(c.req.param('sessionId'), message);
      return c.json({ plan });
    } catch (err) {
      const e = err as Error;
      const status = e.message === 'Session not found' ? 404 : 500;
      return c.json({ error: e.message }, status as Parameters<typeof c.json>[1]);
    }
  });

  // Drain queued structural edits between task batches. The orchestrator pauses
  // fan-out while a message is queued (so an edit can't race a spawn) and emits
  // `queue_ready` once no task is active; a surface calls this to apply the edit
  // via the planner and resume scheduling. Without a route the TUI/CLI could
  // never clear the queue, permanently suppressing dependents after one edit.
  router.post('/:sessionId/process-queued', async (c) => {
    try {
      await pool.session(c.req.param('sessionId')).processQueuedMessages();
      return c.json({ ok: true });
    } catch (err) {
      const e = err as Error;
      const status = e.message === 'Session not found' ? 404 : 500;
      return c.json({ error: e.message }, status as Parameters<typeof c.json>[1]);
    }
  });

  router.get('/:sessionId/prd', (c) => {
    const plan = pool.getPlan(c.req.param('sessionId'));
    if (!plan?.prdMarkdown) return c.json({ error: 'No PRD found' }, 404);
    return c.json({ prdMarkdown: plan.prdMarkdown });
  });

  return router;
}
