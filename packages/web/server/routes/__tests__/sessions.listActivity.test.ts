import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { saveSession, type IRunner, type LegacyPlanState, type RunnerSpawnOptions, type SessionListResponse } from '@ordewell/core';
import { FakeRunnerSession } from '@ordewell/core/testing';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { sessionsRoute } from '../sessions';

// The lease's place as core's leaseRecord keeps it; spelled out here, since the test reads no core source past its exports.
const leaseFile = (id: string, ws: string): string => join(ws, '.ordewell', 'sessions', id, 'lease.json');

type SavedTask = Record<string, unknown>;
const task = (id: string, order: number, status: string, subtasks: SavedTask[] = []): SavedTask => ({
  id, order, title: `Task ${id}`, type: 'ai', status, description: 'd', dependencies: [], assignedRunner: 'claude-code', subtasks, prompt: 'do it',
});

function savedPlan(status: 'draft' | 'approved', tasks: SavedTask[] = [task('t1', 1, 'pending')]): LegacyPlanState {
  return { status, runners: ['claude-code'], generatedAt: '2026-10-17T10:00:00.000Z', tasks } as unknown as LegacyPlanState;
}

/** Another host's lease, as a VS Code window writes it; `pid` and `heartbeatAt` decide whether that host still lives. */
function writeLease(id: string, ws: string, lease: { pid: number; heartbeatAt?: string; runLive?: boolean }): void {
  const file = leaseFile(id, ws);
  mkdirSync(dirname(file), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(file, JSON.stringify({ hostId: 'other-host', host: { kind: 'vscode' }, since: now, heartbeatAt: now, runnerGroups: [], ...lease }));
}

describe('GET /api/sessions: whether each session is at work now', () => {
  let workspace: string; let other: string; let settingsDir: string; let savedSettingsPath: string | undefined;
  let pool: OrchestratorPool; let runs: FakeRunnerSession[];
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-route-listactivity-'));
    other = mkdtempSync(join(tmpdir(), 'ordewell-route-listactivity-other-'));
    mkdirSync(join(workspace, '.git'));
    mkdirSync(join(other, '.git'));
    settingsDir = mkdtempSync(join(tmpdir(), 'ordewell-route-listactivity-settings-'));
    savedSettingsPath = process.env.ORDEWELL_SETTINGS_PATH;
    process.env.ORDEWELL_SETTINGS_PATH = join(settingsDir, 'settings.json');
    writeFileSync(process.env.ORDEWELL_SETTINGS_PATH, JSON.stringify({ supervisorLevel: 'off' }));
    runs = [];
    const runner: IRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => { const s = new FakeRunnerSession(`r${runs.length + 1}`, opts.taskId); runs.push(s); return s; }),
      stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
    };
    pool = new OrchestratorPool({ runner });
  });
  afterEach(() => {
    pool.destroyAll();
    if (savedSettingsPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH; else process.env.ORDEWELL_SETTINGS_PATH = savedSettingsPath;
    for (const dir of [workspace, other, settingsDir]) rmSync(dir, { recursive: true, force: true });
  });

  async function list(ws = workspace): Promise<Record<string, SessionListResponse[number]>> {
    const app = new Hono();
    app.route('/api/sessions', sessionsRoute(pool));
    const response = await app.request(`/api/sessions?workspace=${encodeURIComponent(ws)}`);
    expect(response.status).toBe(200);
    return Object.fromEntries(((await response.json()) as SessionListResponse).map((m) => [m.id, m]));
  }

  it('says a held run is live, counted as the open plan counts it, and no longer once it settles', async () => {
    // Four rows behind a run: t2 skipped, t3 and its subtask passed, t1 still to go.
    const a = saveSession(savedPlan('approved', [
      task('t1', 1, 'pending'),
      task('t2', 2, 'skipped'),
      task('t3', 3, 'completed', [task('t3a', 1, 'completed')]),
    ]), 'Ship the parser', workspace, 'session-aaaa');
    const b = saveSession(savedPlan('draft'), 'Fix flaky CI', workspace, 'session-bbbb');
    pool.adoptSavedSession(a.id, workspace);
    pool.adoptSavedSession(b.id, workspace);

    expect((await list())[a.id].run).toBeUndefined();
    await pool.session(a.id, undefined).execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const during = await list();
    // The saved status cannot tell a run under way: it says approved throughout.
    expect(during[a.id].status).toBe('approved');
    expect(during[a.id].run).toEqual({ live: true, done: 3, total: 4 });
    expect(during[b.id].run).toBeUndefined();

    runs[0].emitExit(0);
    await vi.waitFor(async () => expect((await list())[a.id].run).toBeUndefined());
    expect((await list())[a.id].status).toBe('approved');
  });

  it("takes another host's run from its lease while that host lives, and not from a dead or stale one", async () => {
    const live = saveSession(savedPlan('approved'), 'Held by a VS Code window', workspace, 'session-cccc');
    const idle = saveSession(savedPlan('approved'), 'Open, nothing running', workspace, 'session-dddd');
    const stale = saveSession(savedPlan('approved'), 'Its holder stopped beating', workspace, 'session-eeee');
    const dead = saveSession(savedPlan('approved'), 'Its holder is gone', workspace, 'session-ffff');
    const history = saveSession(savedPlan('approved'), 'Nobody holds it', workspace, 'session-gggg');
    // The vitest worker's parent outlives this test; an exited child is a pid nobody holds.
    writeLease(live.id, workspace, { pid: process.ppid, runLive: true });
    writeLease(idle.id, workspace, { pid: process.ppid, runLive: false });
    writeLease(stale.id, workspace, { pid: process.ppid, runLive: true, heartbeatAt: new Date(Date.now() - 120_000).toISOString() });
    const exited = spawnSync(process.execPath, ['-e', '']).pid;
    writeLease(dead.id, workspace, { pid: exited, runLive: true });

    const rows = await list();
    expect(rows[live.id].run).toEqual({ live: true });
    expect(rows[idle.id].run).toBeUndefined();
    expect(rows[stale.id].run).toBeUndefined();
    expect(rows[dead.id].run).toBeUndefined();
    expect(rows[history.id].run).toBeUndefined();
    expect(Object.keys(rows)).toHaveLength(5);
  });

  it('a lease that cannot be read costs its row its activity, not the list', async () => {
    const odd = saveSession(savedPlan('approved'), 'Lease is a directory', workspace, 'session-hhhh');
    // A directory where the lease file goes: reading it fails with EISDIR, not ENOENT.
    mkdirSync(leaseFile(odd.id, workspace), { recursive: true });
    const rows = await list();
    expect(rows[odd.id].status).toBe('approved');
    expect(rows[odd.id].run).toBeUndefined();
  });

  it("does not lend one workspace's live run to a session of the same id in another", async () => {
    const mine = saveSession(savedPlan('approved'), 'Ship the parser', workspace, 'session-aaaa');
    saveSession(savedPlan('approved'), 'Same id, another project', other, 'session-aaaa');
    pool.adoptSavedSession(mine.id, workspace);
    await pool.session(mine.id, undefined).execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    expect((await list())[mine.id].run).toEqual({ live: true, done: 0, total: 1 });
    expect((await list(other))[mine.id].run).toBeUndefined();
    // That project's own holder speaks for it, though this daemon holds the id for another.
    writeLease(mine.id, other, { pid: process.ppid, runLive: true });
    expect((await list(other))[mine.id].run).toEqual({ live: true });
  });
});
