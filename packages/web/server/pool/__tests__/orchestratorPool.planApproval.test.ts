import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Hono } from 'hono';
import { flattenTasks, saveSession, type IRunner, type LegacyPlanState, type RunnerSpawnOptions, type Session } from '@ordewell/core';
import { FakeRunnerSession } from '@ordewell/core/testing';
import { OrchestratorPool } from '../orchestratorPool';
import { plansRoute } from '../../routes/plans';

/**
 * The daemon's side of a bug seen in VS Code: once the user pressed Execute,
 * a run that ended with failures or was stopped must leave the plan approved
 * for the planner's and the supervisor's starts, and so must a daemon restart
 * that adopts the saved session again (ADR-0029). The TUI and the headless CLI
 * reach the plan only through these routes.
 */
describe('the daemon keeps the user\'s plan approval across a run\'s end, a stop and a restart', () => {
  const PLANNER = { kind: 'planner-turn' } as const;
  let dir: string;
  let workspace: string;
  let saved: string | undefined;
  let pools: OrchestratorPool[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-approval-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-approval-ws-'));
    fs.mkdirSync(path.join(workspace, '.git'));
    saved = process.env.ORDEWELL_SETTINGS_PATH;
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    // Full, and no supervisor: its wake-up turns would need a planner this test has no use for.
    fs.writeFileSync(process.env.ORDEWELL_SETTINGS_PATH, JSON.stringify({ autonomousMode: true, supervisorLevel: 'off' }));
    pools = [];
  });

  afterEach(() => {
    for (const pool of pools) pool.destroyAll();
    if (saved === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

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
    const pool = new OrchestratorPool({ runner });
    pools.push(pool);
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));
    const post = (sessionId: string, action: 'execute' | 'stop') => app.request(`/api/plans/${sessionId}/${action}`, { method: 'POST' });
    const latest = (taskId: string) => spawned.filter((s) => s.taskId === taskId).at(-1)!;
    return { pool, post, latest };
  }

  function draft(): LegacyPlanState {
    const at = '2026-10-16T10:00:00.000Z';
    return {
      status: 'draft',
      runners: ['claude-code'],
      generatedAt: at,
      lastUpdated: at,
      tasks: [
        { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'pending', description: 'd', prompt: 'do it', dependencies: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits', subtasks: [] },
        { id: 't2', order: 2, title: 'Wire it up', type: 'ai', status: 'pending', description: 'd', prompt: 'then this', dependencies: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits', subtasks: [] },
      ],
    } as unknown as LegacyPlanState;
  }

  const status = (session: Session, taskId: string) => flattenTasks(session.planTasks).find((t) => t.id === taskId)?.status;

  it('lets the planner start the plan again after a run that ended with a failure, after Stop, and after a restart', async () => {
    const id = saveSession(draft(), 'Rate limiting', workspace, 'session-approval').id;
    const first = daemon();
    first.pool.adoptSavedSession(id, workspace);
    const session = first.pool.session(id, undefined);

    expect((await first.post(id, 'execute')).status).toBe(200);
    first.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    first.latest('t2').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => {
      expect(status(session, 't1')).toBe('failed');
      expect(status(session, 't2')).toBe('completed');
      expect(session.isExecuting).toBe(false);
    });

    expect(await session.execute({ command: 'run_plan' }, PLANNER)).toMatchObject({ ok: true });
    expect((await first.post(id, 'stop')).status).toBe(200);
    expect(await session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, PLANNER)).toMatchObject({ ok: true });
    expect((await first.post(id, 'stop')).status).toBe(200);
    first.pool.destroyAll();

    const restarted = daemon();
    restarted.pool.adoptSavedSession(id, workspace);
    expect(await restarted.pool.session(id, undefined).execute({ command: 'run_plan' }, PLANNER)).toMatchObject({ ok: true });
  });

  it('still refuses the planner a plan the user never executed', async () => {
    const id = saveSession(draft(), 'Rate limiting', workspace, 'session-unapproved').id;
    const { pool } = daemon();
    pool.adoptSavedSession(id, workspace);

    expect(await pool.session(id, undefined).execute({ command: 'run_plan' }, PLANNER))
      .toMatchObject({ ok: false, message: expect.stringMatching(/has not approved this plan/) });
  });
});
