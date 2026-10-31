import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RUN_SETTINGS_DEFAULTS, SettingsService, type SettingsResponse } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { settingsRoute } from '../settings';
import { plansRoute } from '../plans';

/** Run settings are the user's, saved machine-wide and changed through this route (ADR-0030). */
describe('run settings over /api/settings', () => {
  let dir: string;
  let pool: OrchestratorPool;
  let app: Hono;
  const savedPath = process.env.ORDEWELL_SETTINGS_PATH;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-run-settings-'));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    pool = new OrchestratorPool();
    app = new Hono().route('/api/settings', settingsRoute(pool)).route('/api/plans', plansRoute(pool));
  });

  afterEach(() => {
    pool.destroyAll();
    if (savedPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const patch = (body: unknown) => app.request('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it('answers the run settings, each at its default until the user sets it', async () => {
    const body = await (await app.request('/api/settings')).json() as SettingsResponse;

    expect(body.run).toEqual({ supervisorLevel: 'watch', mergeAtGatesAutomatically: false, plannedWithTrailer: true, autorun: false, supervisorRetryLimit: 2, wakeUpReadBudget: 12, delegationTokens: 0 });
  });

  it('saves a change for every session and answers the settings as they now stand', async () => {
    const res = await patch({ run: { supervisorLevel: 'act', autorun: true } });

    expect(res.status).toBe(200);
    expect((await res.json() as SettingsResponse).run).toMatchObject({ supervisorLevel: 'act', autorun: true });
    expect(new SettingsService().getRunSettings()).toMatchObject({ supervisorLevel: 'act', autorun: true });
  });

  it('turns the Planned-with line off for every later commit, and refuses anything but on or off', async () => {
    expect((await patch({ run: { plannedWithTrailer: false } })).status).toBe(200);
    expect(new SettingsService().getRunSettings().plannedWithTrailer).toBe(false);

    const refused = await patch({ run: { plannedWithTrailer: 'off' } });
    expect(refused.status).toBe(400);
    expect(new SettingsService().getRunSettings().plannedWithTrailer).toBe(false);
  });

  it('applies the change to the named session\'s run at once', async () => {
    let run = { ...RUN_SETTINGS_DEFAULTS };
    const applyRunSettings = vi.fn((changes: Partial<typeof RUN_SETTINGS_DEFAULTS>) => { run = { ...run, ...changes }; });
    (pool as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { runSettings: () => run, applyRunSettings, destroy: vi.fn() });

    const res = await patch({ run: { mergeAtGatesAutomatically: true }, sessionId: 's1' });

    expect(applyRunSettings).toHaveBeenCalledWith({ mergeAtGatesAutomatically: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SettingsResponse).run).toMatchObject({ mergeAtGatesAutomatically: true });
  });

  it('answers a live session with its own values, and an unknown or missing id with the file’s', async () => {
    const run = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act' as const, autorun: true };
    (pool as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { runSettings: () => run, destroy: vi.fn() });
    new SettingsService().updateRunSettings({ supervisorLevel: 'off' });

    const live = await (await app.request('/api/settings?sessionId=s1')).json() as SettingsResponse;
    const unknown = await (await app.request('/api/settings?sessionId=closed')).json() as SettingsResponse;
    const none = await (await app.request('/api/settings')).json() as SettingsResponse;

    expect(live.run).toMatchObject({ supervisorLevel: 'act', autorun: true });
    expect(unknown.run).toMatchObject({ supervisorLevel: 'off', autorun: false });
    expect(none.run).toMatchObject({ supervisorLevel: 'off', autorun: false });
  });

  it('answers the session\'s values even when the same write changes a global setting', async () => {
    const run = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act' as const };
    (pool as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { runSettings: () => run, destroy: vi.fn() });

    const res = await patch({ modelAllowlist: { opencode: ['a/b'] }, sessionId: 's1' });

    expect(res.status).toBe(200);
    expect(((await res.json()) as SettingsResponse).run).toMatchObject({ supervisorLevel: 'act' });
  });

  it('refuses a value outside its range, saving nothing and applying nothing', async () => {
    const applyRunSettings = vi.fn();
    (pool as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { applyRunSettings, destroy: vi.fn() });

    const res = await patch({ run: { supervisorLevel: 'act', supervisorRetryLimit: -1 }, sessionId: 's1' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/retry limit/i);
    expect(new SettingsService().getRunSettings().supervisorLevel).toBe('watch');
    expect(applyRunSettings).not.toHaveBeenCalled();
  });

  it('has no per-plan settings route any more', async () => {
    (pool as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { destroy: vi.fn() });
    const settings = await app.request('/api/plans/s1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"supervisorLevel":"act"}' });
    const lower = await app.request('/api/plans/s1/supervisor/lower', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"level":"off"}' });

    expect([settings.status, lower.status]).toEqual([404, 404]);
  });
});
