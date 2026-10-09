import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SettingsService, type SettingsUpdateResponse } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { settingsRoute } from '../settings';

describe('settings route with persisted planner memory', () => {
  let dir: string;
  let pool: OrchestratorPool;
  let app: Hono;
  const keys = ['ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-settings-route-'));
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    process.env.AI_PROVIDER = 'claude-code';
    pool = new OrchestratorPool();
    app = new Hono().route('/api/settings', settingsRoute(pool));
  });

  afterEach(() => {
    pool.destroyAll();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function patch(changes: Record<string, unknown>): Promise<SettingsUpdateResponse> {
    const response = await app.request('/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<SettingsUpdateResponse>;
  }

  it.each(['top-level', 'env'])('keeps an explicit %s model when switching provider and remembers it', async (shape) => {
    new SettingsService().setPlannerModel('codex', { model: 'old-model' });
    const model = shape === 'env'
      ? { env: { AI_PROVIDER: 'codex', ORCHESTRATOR_MODEL: 'new-model', ORDEWELL_PLANNER_EFFORT: 'high' } }
      : { env: { AI_PROVIDER: 'codex' }, orchestratorModel: 'new-model', plannerThinkingEffort: 'high' };
    const result = await patch(model);
    expect(result.aiProvider).toBe('codex');
    expect(result.orchestratorModel).toBe('new-model');
    expect(result.plannerThinkingEffort).toBe('high');
    expect(result.switchRecall).toBeUndefined();
    expect(new SettingsService().getPlannerModel('codex')).toEqual({ model: 'new-model', effort: 'high' });
  });

  it('persists model memory but leaves active environment persistence to the client', async () => {
    await patch({ orchestratorModel: 'chosen-model', plannerThinkingEffort: 'high' });
    await patch({ env: { AI_PROVIDER: 'codex' } });
    expect(process.env.AI_PROVIDER).toBe('codex');
    pool.destroyAll();
    for (const key of keys.slice(1)) delete process.env[key];
    pool = new OrchestratorPool();
    const restarted = new Hono().route('/api/settings', settingsRoute(pool));
    const response = await restarted.request('/api/settings');
    const result = await response.json() as SettingsUpdateResponse;
    expect(result.orchestratorModel).toBe('');
    expect(result.aiProvider).not.toBe('codex');
    expect(result.plannerModels?.['claude-code']).toEqual({ model: 'chosen-model', effort: 'high' });
    expect(new SettingsService().getAll()).not.toHaveProperty('env');
  });
});
