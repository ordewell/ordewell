import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { PlanEditError } from '@ordewell/core';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

describe('task editing routes', () => {
  let app: Hono;
  let session: {
    updateTask: ReturnType<typeof vi.fn>;
    setTaskRunner: ReturnType<typeof vi.fn>;
    setTaskDependencies: ReturnType<typeof vi.fn>;
    addTask: ReturnType<typeof vi.fn>;
    removeTask: ReturnType<typeof vi.fn>;
    markTaskIncomplete: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    session = {
      updateTask: vi.fn().mockReturnValue({ tasks: [] }),
      setTaskRunner: vi.fn().mockResolvedValue({ tasks: [] }),
      setTaskDependencies: vi.fn().mockReturnValue({ tasks: [] }),
      addTask: vi.fn().mockResolvedValue({ tasks: [] }),
      removeTask: vi.fn().mockReturnValue({ tasks: [] }),
      markTaskIncomplete: vi.fn().mockResolvedValue(undefined),
    };
    const pool = { session: vi.fn().mockReturnValue(session) } as unknown as OrchestratorPool;
    const { plansRoute } = await import('../../routes/plans');
    app = new Hono();
    app.route('/api/plans', plansRoute(pool));
  });

  const put = (body: unknown) => app.request('/api/plans/s1/tasks/t1', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const post = (body: unknown) => app.request('/api/plans/s1/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  describe('PUT with dependencies', () => {
    it('routes the list to setTaskDependencies, which validates it', async () => {
      const res = await put({ dependencies: ['a', 'b'] });

      expect(res.status).toBe(200);
      expect(session.setTaskDependencies).toHaveBeenCalledWith('t1', ['a', 'b']);
      expect(session.updateTask).not.toHaveBeenCalled();
    });

    it('routes a cleared list too, rather than reading it as an absent field', async () => {
      const res = await put({ dependencies: [] });

      expect(res.status).toBe(200);
      expect(session.setTaskDependencies).toHaveBeenCalledWith('t1', []);
      expect(session.updateTask).not.toHaveBeenCalled();
    });

    it('reports a refused edit as a client error, with the reason', async () => {
      session.setTaskDependencies.mockImplementation(() => {
        throw new Error('"Setup" cannot depend on "Test", which comes after it in the plan');
      });

      const res = await put({ dependencies: ['t3'] });

      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/comes after it/);
    });

    it('applies the rest of the patch alongside the dependencies', async () => {
      const res = await put({ dependencies: ['a'], prompt: 'rewritten' });

      expect(res.status).toBe(200);
      expect(session.setTaskDependencies).toHaveBeenCalledWith('t1', ['a']);
      expect(session.updateTask).toHaveBeenCalledWith('t1', { prompt: 'rewritten' });
    });

    it('404s when the task does not exist', async () => {
      session.setTaskDependencies.mockReturnValue(null);

      expect((await put({ dependencies: [] })).status).toBe(404);
    });

    it('never lets a dependency list reach updateTask unvalidated', async () => {
      await put({ dependencies: ['a'], prompt: 'x' });

      expect(session.updateTask).not.toHaveBeenCalledWith('t1', expect.objectContaining({ dependencies: expect.anything() }));
    });
  });

  describe('POST /tasks', () => {
    it('awaits addTask, which derives the new task assignment from a runner catalog', async () => {
      const res = await post({ title: 'Docs', dependencies: ['a'] });

      expect(res.status).toBe(200);
      expect(session.addTask).toHaveBeenCalledWith({ title: 'Docs', dependencies: ['a'] });
    });

    it('404s when there is no session to add to', async () => {
      session.addTask.mockResolvedValue(null);

      expect((await post({ title: 'Docs' })).status).toBe(404);
    });

    it('reports a rejected add rather than resolving as success', async () => {
      session.addTask.mockRejectedValue(new Error('boom'));

      const res = await post({ title: 'Docs' });

      expect(res.status).toBe(500);
      expect((await res.json() as { error: string }).error).toBe('boom');
    });
  });

  describe('the retired reorder endpoint', () => {
    // Display order is not execution order, so no surface offers reordering any
    // more. A stale client must get a visible 404, not a silent partial write:
    // `/tasks/reorder` now falls through to PUT /tasks/:taskId as a task id.
    it('no longer reorders, and reports the miss', async () => {
      session.updateTask.mockReturnValue(null);

      const res = await app.request('/api/plans/s1/tasks/reorder', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: ['b', 'a'] }),
      });

      expect(res.status).toBe(404);
      expect(session.updateTask).toHaveBeenCalledWith('reorder', { taskIds: ['b', 'a'] });
    });
  });

  describe('POST /tasks/:taskId/uncomplete', () => {
    it('un-marks the task', async () => {
      const res = await app.request('/api/plans/s1/tasks/t1/uncomplete', { method: 'POST' });

      expect(res.status).toBe(200);
      expect(session.markTaskIncomplete).toHaveBeenCalledWith('t1');
    });

    it('404s when the session is gone', async () => {
      session.markTaskIncomplete.mockRejectedValue(new Error('Session not found'));

      const res = await app.request('/api/plans/s1/tasks/t1/uncomplete', { method: 'POST' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /tasks/:taskId', () => {
    it('removes the task', async () => {
      const res = await app.request('/api/plans/s1/tasks/t1', { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(session.removeTask).toHaveBeenCalledWith('t1');
    });

    it('404s when there is no plan to remove from', async () => {
      session.removeTask.mockReturnValue(null);

      expect((await app.request('/api/plans/s1/tasks/t1', { method: 'DELETE' })).status).toBe(404);
    });

    // The removal cancels a live runner first, so it can throw. An unhandled
    // throw here answered with no body at all, which every surface read as the
    // delete having silently done nothing.
    it('404s when the session is gone rather than throwing out of the route', async () => {
      session.removeTask.mockRejectedValue(new Error('Session not found'));

      const res = await app.request('/api/plans/s1/tasks/t1', { method: 'DELETE' });

      expect(res.status).toBe(404);
      expect((await res.json() as { error: string }).error).toBe('Session not found');
    });

    it('reports a refused removal as a client error, with the reason', async () => {
      session.removeTask.mockRejectedValue(new PlanEditError('"Build" cannot be removed'));

      const res = await app.request('/api/plans/s1/tasks/t1', { method: 'DELETE' });

      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/cannot be removed/);
    });
  });

  // A refusal and a fault are different answers. Collapsing them into 500 left
  // the TUI and VS Code with nothing to show but "Internal error".
  describe('refusals are told apart from faults', () => {
    it('reports a refused field patch as a client error', async () => {
      session.updateTask.mockRejectedValue(new PlanEditError('Unknown dependency "ghost"'));

      const res = await put({ prompt: 'x' });

      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/Unknown dependency/);
    });

    it('reports a refused add as a client error', async () => {
      session.addTask.mockRejectedValue(new PlanEditError('Task needs a title'));

      const res = await post({ prompt: 'x' });

      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/needs a title/);
    });

    it('still reports a genuine fault as a fault', async () => {
      session.updateTask.mockRejectedValue(new Error('disk on fire'));

      const res = await put({ prompt: 'x' });

      expect(res.status).toBe(500);
      expect((await res.json() as { error: string }).error).toBe('disk on fire');
    });
  });
});
