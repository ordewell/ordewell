import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

/**
 * A runner change is not a field write alone: the session moves the task with
 * the model, thinking effort and mode its runner scopes. The route hands it
 * over with the rest of the patch, as one edit the session lands in one save,
 * checked after it has discovered the new runner: split, the first save's
 * reschedule could start the task ahead of the rest, unchecked.
 */
describe('PUT /:sessionId/tasks/:taskId with assignedRunner', () => {
  let app: Hono;
  let session: { updateTask: ReturnType<typeof vi.fn>; setTaskRunner: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    session = {
      updateTask: vi.fn().mockResolvedValue({ tasks: [] }),
      setTaskRunner: vi.fn().mockResolvedValue({ tasks: [] }),
    };
    const pool = { session: vi.fn().mockReturnValue(session), refuseBlockedTaskRunner: vi.fn(async () => {}) } as unknown as OrchestratorPool;
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

  it('hands a runner change to updateTask with the rest of the patch, as one edit', async () => {
    const res = await put({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' }, prompt: 'rewritten' });

    expect(res.status).toBe(200);
    expect(session.updateTask).toHaveBeenCalledTimes(1);
    expect(session.updateTask).toHaveBeenCalledWith('t1', { assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' }, prompt: 'rewritten' });
    expect(session.setTaskRunner).not.toHaveBeenCalled();
  });

  it('404s when the task does not exist', async () => {
    session.updateTask.mockResolvedValue(null);

    expect((await put({ assignedRunner: 'codex' })).status).toBe(404);
  });
});
