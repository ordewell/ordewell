import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Hono } from 'hono';
import {
  ModelResolver, RunnerInstallation, RunnerRegistry, getProviderMeta, PROVIDER_DETECT_PRIORITY, flattenTasks,
  recordRunnerAuth, resetInstalledPlanner, resetRunnerAuth, saveSession, signedOutFromFailure,
  type DiscoveredModel, type ErrorBody, type LegacyPlanState, type RunnersResponse,
} from '@ordewell/core';
import { WebConfig } from '../../adapters/WebConfig';
import { OrchestratorPool } from '../orchestratorPool';
import { runnersRoute } from '../../routes/runners';
import { settingsRoute } from '../../routes/settings';
import { plansRoute } from '../../routes/plans';

/**
 * ADR-0052's choice rule at the daemon's write boundary: a picker's list can
 * be stale, so a new planner pick, a runner switched on and a task moved onto
 * a runner are each judged again as they are written. A confirmed sign-out
 * refuses them with the way back; an unknown sign-in, an agent that runs on
 * its own default and a choice already made are never refused.
 */
describe('the daemon refuses a new pick of a runner that cannot run (ADR-0052)', () => {
  const saved = { ...process.env };
  let dir: string;
  let ws: string;
  let pool: OrchestratorPool | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-choice-readiness-'));
    ws = join(dir, 'ws');
    mkdirSync(join(ws, '.git'), { recursive: true });
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
    }
    process.env.AI_PROVIDER = 'copilot-cli';
    resetRunnerAuth();
  });

  afterEach(() => {
    pool?.destroyAll();
    pool = undefined;
    vi.restoreAllMocks();
    resetInstalledPlanner();
    resetRunnerAuth();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  type Answer = DiscoveredModel[] | 'signed-out' | null;

  /** Cursor and Copilot installed; each ACP handshake answers from its command's queue. */
  function daemon(answers: Record<'cursor-agent' | 'copilot', Answer[]>) {
    const registry = new RunnerRegistry();
    vi.spyOn(RunnerInstallation.prototype, 'isInstalled').mockImplementation(async (runner: string) => runner === 'cursor-agent' || runner === 'copilot-cli');
    const installation = new RunnerInstallation(registry, async () => ({ stdout: '2026.10.22' }), Date.now, { launch: { platform: 'linux' }, workspace: () => ws, env: async () => ({}) });
    const acpClient = vi.fn(async (command: string) => answers[command as 'cursor-agent' | 'copilot']?.shift() ?? null);
    const modelResolver = new ModelResolver(registry, new WebConfig(), { env: async () => ({}), acpClient, workspace: () => ws, execImpl: async () => ({ stdout: '' }) });
    pool = new OrchestratorPool({ runnerInstallation: installation, modelResolver, codexSandbox: { ensure: async () => undefined, refresh: async () => undefined } });
    pool.setRunnerEnabled('copilot-cli', true);
    const app = new Hono();
    app.route('/api/runners', runnersRoute(pool));
    app.route('/api/settings', settingsRoute(pool));
    app.route('/api/plans', plansRoute(pool));
    const send = (method: string, url: string, body?: unknown) =>
      app.request(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { pool, send, acpClient, modelResolver };
  }

  const cursor = () => new RunnerRegistry().getManifest('cursor-agent')!;
  const refuseCursor = () => recordRunnerAuth('cursor-agent', signedOutFromFailure(cursor(), 'Authentication required')!, ws);
  const pickPlanner = (send: ReturnType<typeof daemon>['send'], provider: string, model = 'auto') =>
    send('PATCH', '/api/settings', { env: { AI_PROVIDER: provider, ORCHESTRATOR_MODEL: model, ORDEWELL_PLANNER_EFFORT: '' }, workspace: ws });
  const list = async (send: ReturnType<typeof daemon>['send']) =>
    (await (await send('GET', `/api/runners?workspace=${encodeURIComponent(ws)}`)).json()) as RunnersResponse;

  it('ships each runner\'s readiness with its row: a sign-out as blocked, a session opened as ready', async () => {
    const { send, modelResolver } = daemon({ 'cursor-agent': [], copilot: [[]] });
    await modelResolver.modelsForRunners(['copilot-cli']);
    refuseCursor();

    const rows = (await list(send)).runners;
    expect(rows.find((r) => r.id === 'cursor-agent')?.readiness).toMatchObject({ kind: 'blocked', why: 'signed-out' });
    // Copilot offers no model over ACP but always takes its `auto` alias, so it has one to run on.
    expect(rows.find((r) => r.id === 'copilot-cli')?.readiness).toEqual({ kind: 'ready' });
  });

  it('refuses a new planner pick of a signed-out agent with its way in, and keeps the planner it had', async () => {
    const { send } = daemon({ 'cursor-agent': ['signed-out'], copilot: [] });
    refuseCursor();

    const res = await pickPlanner(send, 'cursor-agent');
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body).toMatchObject({ code: 'runner_not_ready', runnerNotReady: { runner: 'cursor-agent', readiness: { kind: 'blocked', why: 'signed-out' } } });
    expect(body.error).toBe('Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login. Then pick it again.');
    expect(process.env.AI_PROVIDER).toBe('copilot-cli');
  });

  it('judges a stale list again at the write: a sign-in done since lets the pick through', async () => {
    const { send } = daemon({ 'cursor-agent': [[{ modelId: 'auto', modelLabel: 'Auto', variants: [] }]], copilot: [] });
    refuseCursor();
    expect((await list(send)).runners.find((r) => r.id === 'cursor-agent')?.readiness?.kind).toBe('blocked');

    expect((await pickPlanner(send, 'cursor-agent')).status).toBe(200);
    expect(process.env.AI_PROVIDER).toBe('cursor-agent');
  });

  it('never refuses an unknown sign-in, nor an agent that runs on its own default', async () => {
    const { send, modelResolver } = daemon({ 'cursor-agent': [[]], copilot: [] });
    expect((await pickPlanner(send, 'cursor-agent')).status).toBe(200);

    await modelResolver.modelsForRunners(['cursor-agent']);
    expect((await list(send)).runners.find((r) => r.id === 'cursor-agent')?.readiness).toEqual({ kind: 'agent-default' });
    expect((await pickPlanner(send, 'copilot-cli')).status).toBe(200);
    expect((await pickPlanner(send, 'cursor-agent')).status).toBe(200);
  });

  it('keeps a planner chosen before its agent signed out: a model change on it is no new pick', async () => {
    process.env.AI_PROVIDER = 'cursor-agent';
    const { send } = daemon({ 'cursor-agent': ['signed-out'], copilot: [] });
    refuseCursor();

    expect((await pickPlanner(send, 'cursor-agent', 'gpt-5')).status).toBe(200);
    expect(process.env.AI_PROVIDER).toBe('cursor-agent');
  });

  it('refuses switching a signed-out runner on, but lets the user switch an enabled one off and keeps a saved one', async () => {
    const { send } = daemon({ 'cursor-agent': ['signed-out', 'signed-out'], copilot: [] });
    refuseCursor();

    const on = await send('PUT', `/api/runners/cursor-agent?workspace=${encodeURIComponent(ws)}`, { enabled: true });
    expect(on.status).toBe(409);
    expect(((await on.json()) as ErrorBody).code).toBe('runner_not_ready');
    expect((await list(send)).runners.find((r) => r.id === 'cursor-agent')?.enabled).toBe(false);

    // A runner the user enabled before its sign-out stays enabled, and can be switched off.
    pool!.setRunnerEnabled('cursor-agent', true);
    expect((await list(send)).runners.find((r) => r.id === 'cursor-agent')?.enabled).toBe(true);
    expect((await send('PUT', `/api/runners/cursor-agent?workspace=${encodeURIComponent(ws)}`, { enabled: true })).status).toBe(200);
    expect((await send('PUT', `/api/runners/cursor-agent?workspace=${encodeURIComponent(ws)}`, { enabled: false })).status).toBe(200);
    expect((await list(send)).runners.find((r) => r.id === 'cursor-agent')?.enabled).toBe(false);
  });

  function plan(): LegacyPlanState {
    const at = '2026-11-25T10:00:00.000Z';
    const task = (id: string, order: number, runner: string) =>
      ({ id, order, title: id, type: 'ai', status: 'pending', description: 'd', prompt: `do ${id}`, dependencies: [], assignedRunner: runner, taskMode: 'default', subtasks: [] });
    return { status: 'draft', runners: ['copilot-cli', 'cursor-agent'], generatedAt: at, lastUpdated: at, tasks: [task('t1', 1, 'copilot-cli'), task('t2', 2, 'cursor-agent')] } as unknown as LegacyPlanState;
  }

  it('refuses moving a task onto a signed-out runner, and leaves a task already on it alone', async () => {
    const { pool: daemonPool, send } = daemon({ 'cursor-agent': ['signed-out', 'signed-out'], copilot: [] });
    const id = saveSession(plan(), 'Readiness', ws, 'session-choice').id;
    daemonPool.adoptSavedSession(id, ws);
    refuseCursor();
    const runnerOf = (taskId: string) => flattenTasks(daemonPool.session(id, undefined).planTasks).find((t) => t.id === taskId)?.assignedRunner;
    const at = `?workspace=${encodeURIComponent(ws)}`;

    const moved = await send('PUT', `/api/plans/${id}/tasks/t1${at}`, { assignedRunner: 'cursor-agent' });
    expect(moved.status).toBe(409);
    expect(((await moved.json()) as ErrorBody).error).toMatch(/^Cursor is not signed in\. .*Then pick it again\.$/);
    expect(runnerOf('t1')).toBe('copilot-cli');

    const card = await send('POST', `/api/plans/${id}/tasks/t1/card-edit${at}`, { kind: 'runner', runner: 'cursor-agent' });
    expect(card.status).toBe(409);
    expect(runnerOf('t1')).toBe('copilot-cli');

    // The task already on Cursor is the user's earlier choice: another edit of it lands.
    expect((await send('PUT', `/api/plans/${id}/tasks/t2${at}`, { prompt: 'still on cursor' })).status).toBe(200);
    expect(runnerOf('t2')).toBe('cursor-agent');
  });
});
