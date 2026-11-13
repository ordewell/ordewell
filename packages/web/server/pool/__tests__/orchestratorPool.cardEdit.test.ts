import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Hono } from 'hono';
import { flattenTasks, saveSession, type IRunner, type LegacyPlanState, type RunnerSpawnOptions } from '@ordewell/core';
import { FakeRunnerSession } from '@ordewell/core/testing';
import { OrchestratorPool } from '../orchestratorPool';
import { plansRoute } from '../../routes/plans';

/**
 * A task card edit reaches the daemon as `card-edit`, whose not-started
 * precondition the Session derives from its own run, so the desktop app is
 * held to the same rule as VS Code. The wider `PUT` is the direct edit of
 * every other client.
 */
describe('the daemon\'s card edit route', () => {
  let dir: string;
  let workspace: string;
  let saved: string | undefined;
  let pool: OrchestratorPool | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-cardedit-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-cardedit-ws-'));
    fs.mkdirSync(path.join(workspace, '.git'));
    saved = process.env.ORDEWELL_SETTINGS_PATH;
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    fs.writeFileSync(process.env.ORDEWELL_SETTINGS_PATH, JSON.stringify({ autonomousMode: true, supervisorLevel: 'off' }));
  });

  afterEach(() => {
    pool?.destroyAll();
    if (saved === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function plan(): LegacyPlanState {
    const at = '2026-10-16T10:00:00.000Z';
    const task = (id: string, order: number, dependencies: string[]) =>
      ({ id, order, title: id, type: 'ai', status: 'pending', description: 'd', prompt: `do ${id}`, dependencies, assignedRunner: 'claude-code', taskMode: 'acceptEdits', subtasks: [] });
    return { status: 'draft', runners: ['claude-code'], generatedAt: at, lastUpdated: at, tasks: [task('t1', 1, []), task('t2', 2, ['t1'])] } as unknown as LegacyPlanState;
  }

  function daemon() {
    const spawned: FakeRunnerSession[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        const s = new FakeRunnerSession(`s${spawned.length + 1}`, opts.taskId);
        spawned.push(s);
        return s;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    pool = new OrchestratorPool({ runner });
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));
    const send = (method: string, url: string, body: unknown) =>
      app.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { app, send, spawned };
  }

  it('refuses a card edit of a task the run has started and leaves it as it was, where the PUT still lands', async () => {
    const id = saveSession(plan(), 'Rate limiting', workspace, 'session-cardedit').id;
    const { app, send, spawned } = daemon();
    pool!.adoptSavedSession(id, workspace);
    const session = pool!.session(id, undefined);
    expect((await app.request(`/api/plans/${id}/execute`, { method: 'POST' })).status).toBe(200);
    await vi.waitFor(() => expect(spawned.some((s) => s.taskId === 't1')).toBe(true));
    const prompt = (taskId: string) => flattenTasks(session.planTasks).find((t) => t.id === taskId)?.prompt;

    const refused = await send('POST', `/api/plans/${id}/tasks/t1/card-edit`, { kind: 'prompt', prompt: 'changed under the run' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(prompt('t1')).toBe('do t1');

    expect((await send('POST', `/api/plans/${id}/tasks/t2/card-edit`, { kind: 'prompt', prompt: 'later' })).status).toBe(200);
    expect(prompt('t2')).toBe('later');
    expect((await send('PUT', `/api/plans/${id}/tasks/t1`, { prompt: 'direct edit' })).status).toBe(200);
    expect(prompt('t1')).toBe('direct edit');
  });

  it('refuses a body that is no card edit', async () => {
    const id = saveSession(plan(), 'Rate limiting', workspace, 'session-cardedit-bad').id;
    const { send } = daemon();
    pool!.adoptSavedSession(id, workspace);
    expect((await send('POST', `/api/plans/${id}/tasks/t1/card-edit`, { kind: 'remove' })).status).toBe(400);
  });
});
