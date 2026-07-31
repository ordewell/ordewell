import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

/**
 * A runner change is not a field write: `Session.setTaskRunner` re-derives the
 * task's model, thinking effort and mode from the new runner's catalog. Routing
 * it through `updateTask` instead would persist a runner the task's model
 * cannot be spawned on.
 */
describe('PUT /:sessionId/tasks/:taskId with assignedRunner', () => {
  let app: Hono;
  let session: { updateTask: ReturnType<typeof vi.fn>; setTaskRunner: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    session = {
      updateTask: vi.fn().mockReturnValue({ tasks: [] }),
      setTaskRunner: vi.fn().mockResolvedValue({ tasks: [] }),
    };
    const pool = { session: vi.fn().mockReturnValue(session) } as unknown as OrchestratorPool;
    const { plansRoute } = await import('../../routes/plans');
    app = new Hono();
    app.route('/api/plans', plansRoute(pool));
  });

  function put(body: unknown) {
    return app.request('/api/plans/s1/tasks/t1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('routes a runner change to setTaskRunner, not updateTask', async () => {
    const res = await put({ assignedRunner: 'codex' });

    expect(res.status).toBe(200);
    expect(session.setTaskRunner).toHaveBeenCalledWith('t1', 'codex');
    expect(session.updateTask).not.toHaveBeenCalled();
  });

  it('applies the rest of the patch after the runner is retargeted', async () => {
    // Order matters: retargeting derives a model for the new runner, so an
    // explicit model in the same patch has to land last or it is overwritten.
    const res = await put({ assignedRunner: 'codex', prompt: 'rewritten' });

    expect(res.status).toBe(200);
    expect(session.setTaskRunner).toHaveBeenCalledWith('t1', 'codex');
    expect(session.updateTask).toHaveBeenCalledWith('t1', { prompt: 'rewritten' });
    expect(session.setTaskRunner.mock.invocationCallOrder[0])
      .toBeLessThan(session.updateTask.mock.invocationCallOrder[0]);
  });

  it('still goes through updateTask for a patch with no runner in it', async () => {
    const res = await put({ taskMode: 'plan' });

    expect(res.status).toBe(200);
    expect(session.setTaskRunner).not.toHaveBeenCalled();
    expect(session.updateTask).toHaveBeenCalledWith('t1', { taskMode: 'plan' });
  });

  it('404s when the task does not exist', async () => {
    session.setTaskRunner.mockResolvedValue(null);

    expect((await put({ assignedRunner: 'codex' })).status).toBe(404);
  });
});
