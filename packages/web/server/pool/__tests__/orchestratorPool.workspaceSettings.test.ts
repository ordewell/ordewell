import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Hono } from 'hono';
import { ModelResolver, SettingsService, saveSession, type LegacyPlanState, type SettingsResponse, type SettingsUpdateResponse } from '@ordewell/core';
import { OrchestratorPool, SessionOpenElsewhereError } from '../orchestratorPool';
import { settingsRoute } from '../../routes/settings';

// One daemon serves workspaces A (its cwd) and B, whose `.ordewell/env` name
// different Claude accounts with different gateway models in their pickers.
// Whatever the planner's model is judged against for a request from B has to
// be B's catalog, the one B's planner is spawned with. Discovery is real for
// Claude Code alone, signed in with a synthetic key against a stubbed API, so
// no real credential, settings file or CLI is reached.

const ENV = ['ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'OPENROUTER_API_KEY'];
const MANAGED_SETTINGS = ['/Library/Application Support/ClaudeCode', 'C:\\Program Files\\ClaudeCode', '/etc/claude-code'];

function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['claude-code'],
    generatedAt: '2026-10-29T10:00:00.000Z',
    tasks: [
      { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'pending', description: 'd', dependencies: [], assignedRunner: 'claude-code', subtasks: [], prompt: 'do it' },
    ],
  } as unknown as LegacyPlanState;
}

// An admin's lineup in this machine's managed settings would replace both
// workspaces' own, which no test environment can move.
describe.skipIf(MANAGED_SETTINGS.some((dir) => fs.existsSync(dir)))('OrchestratorPool settings — per workspace', () => {
  let root: string;
  let workspaceA: string;
  let workspaceB: string;
  let pool: OrchestratorPool;
  const saved: Record<string, string | undefined> = {};

  function workspace(name: string, gatewayModel: string): string {
    const dir = path.join(root, name);
    const account = path.join(root, `${name}-claude`);
    fs.mkdirSync(path.join(dir, '.ordewell'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(account);
    fs.writeFileSync(path.join(account, 'settings.json'), JSON.stringify({ modelPicker: { options: [{ model: gatewayModel }] } }));
    fs.writeFileSync(path.join(dir, '.ordewell', 'env'), `CLAUDE_CONFIG_DIR=${account}\nANTHROPIC_API_KEY=synthetic-${name}\n`);
    return dir;
  }

  const ids = (models: { modelId: string }[] | undefined) => (models ?? []).map((m) => m.modelId);
  const newPool = () => new OrchestratorPool({ codexSandbox: { ensure: async () => undefined, refresh: async () => undefined } });

  beforeEach(async () => {
    for (const key of ENV) saved[key] = process.env[key];
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-workspace-settings-')));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(root, 'settings.json');
    for (const key of ENV.slice(1)) delete process.env[key];
    workspaceA = workspace('workspace-a', 'gproxy/a-only');
    workspaceB = workspace('workspace-b', 'gproxy/b-only');
    vi.spyOn(process, 'cwd').mockReturnValue(workspaceA);
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => (String(url).startsWith('https://api.anthropic.com/')
      ? new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }), { status: 200 })
      : new Response('not found', { status: 404 }))));
    const discover = ModelResolver.prototype.modelsForRunners;
    vi.spyOn(ModelResolver.prototype, 'modelsForRunners').mockImplementation(function (this: ModelResolver) {
      return discover.call(this, ['claude-code']);
    });
    vi.spyOn(ModelResolver.prototype, 'refresh').mockResolvedValue({});
    vi.spyOn(ModelResolver.prototype, 'pickerOptions').mockResolvedValue([]);
    pool = newPool();
    // As the TUI does on opening, each workspace asks for its catalog.
    const [a, b] = await Promise.all([pool.getProviderModels(workspaceA), pool.getProviderModels(workspaceB)]);
    expect(ids(a.modelsByRunner['claude-code'])).toContain('gproxy/a-only');
    expect(ids(b.modelsByRunner['claude-code'])).toContain('gproxy/b-only');
    expect(ids(b.modelsByRunner['claude-code'])).not.toContain('gproxy/a-only');
  });

  afterEach(() => {
    pool.destroyAll();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('re-discovers every workspace\'s runner catalog, each under its own account, after a credential change', async () => {
    const lineup = (name: string, model: string) => fs.writeFileSync(
      path.join(root, `${name}-claude`, 'settings.json'), JSON.stringify({ modelPicker: { options: [{ model }] } }));
    lineup('workspace-a', 'gproxy/a-later');
    lineup('workspace-b', 'gproxy/b-later');
    expect(ids((await pool.getProviderModels(workspaceB)).modelsByRunner['claude-code'])).not.toContain('gproxy/b-later');

    pool.updateSettings({ env: { OPENROUTER_API_KEY: 'sk-or-synthetic' } });

    const [a, b] = await Promise.all([pool.getProviderModels(workspaceA), pool.getProviderModels(workspaceB)]);
    expect(ids(a.modelsByRunner['claude-code'])).toContain('gproxy/a-later');
    expect(ids(a.modelsByRunner['claude-code'])).not.toContain('gproxy/b-later');
    expect(ids(b.modelsByRunner['claude-code'])).toContain('gproxy/b-later');
    expect(ids(b.modelsByRunner['claude-code'])).not.toContain('gproxy/a-later');
  });

  it('restores B\'s remembered Claude model on a switch made from B', () => {
    process.env.AI_PROVIDER = 'codex';
    new SettingsService().setPlannerModel('claude-code', { model: 'gproxy/b-only' });

    const fromB = pool.updateSettings({ env: { AI_PROVIDER: 'claude-code' } }, undefined, workspaceB);

    expect(fromB.switchRecall).toMatchObject({ model: 'gproxy/b-only', source: 'remembered' });
    expect(fromB.orchestratorModel).toBe('gproxy/b-only');
    expect(process.env.ORCHESTRATOR_MODEL).toBe('gproxy/b-only');
  });

  it('does not restore B\'s model on a switch made from A, whose account does not serve it', () => {
    process.env.AI_PROVIDER = 'codex';
    new SettingsService().setPlannerModel('claude-code', { model: 'gproxy/b-only' });

    const fromA = pool.updateSettings({ env: { AI_PROVIDER: 'claude-code' } }, undefined, workspaceA);

    expect(fromA.switchRecall?.source).toBe('catalog-default');
    expect(fromA.switchRecall?.model).not.toBe('gproxy/b-only');
  });

  it('reports the planner model each workspace plans with, in settings and the model catalog', async () => {
    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = 'gproxy/b-only';

    expect(pool.getSettings(undefined, workspaceB).orchestratorModel).toBe('gproxy/b-only');
    expect((await pool.getProviderModels(workspaceB)).orchestratorModel).toBe('gproxy/b-only');
    // A's account does not serve it, so A plans with its own default; so does
    // a request naming no workspace, which the daemon's cwd answers.
    expect(pool.getSettings(undefined, workspaceA).orchestratorModel).toBe('');
    expect(pool.getSettings().orchestratorModel).toBe('');
    expect((await pool.getProviderModels(workspaceA)).orchestratorModel).toBe('');
  });

  // A pick made in B is B's: A's account does not serve it, so A plans with
  // its own default rather than a model its planner cannot be spawned with.
  it('keeps a model picked in B to B', () => {
    process.env.AI_PROVIDER = 'claude-code';

    expect(pool.updateSettings({ env: { ORCHESTRATOR_MODEL: 'gproxy/b-only' } }, undefined, workspaceB).orchestratorModel).toBe('gproxy/b-only');

    expect(pool.getSettings(undefined, workspaceB).orchestratorModel).toBe('gproxy/b-only');
    expect(pool.getSettings(undefined, workspaceA).orchestratorModel).toBe('');
    expect(pool.getSettings().orchestratorModel).toBe('');
  });

  // Every client switches planners before it asks for models, so a switch can
  // be the first thing a workspace's catalog is needed for.
  describe('before any client has asked for a workspace\'s models', () => {
    let cold: OrchestratorPool;
    let app: Hono;

    beforeEach(() => {
      cold = newPool();
      app = new Hono().route('/api/settings', settingsRoute(cold));
    });

    afterEach(() => cold.destroyAll());

    it('restores B\'s remembered Claude model on a switch made from B', async () => {
      process.env.AI_PROVIDER = 'codex';
      new SettingsService().setPlannerModel('claude-code', { model: 'gproxy/b-only' });

      const res = await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: { AI_PROVIDER: 'claude-code' }, workspace: workspaceB }),
      });
      const body = (await res.json()) as SettingsUpdateResponse;

      expect(body.switchRecall).toMatchObject({ model: 'gproxy/b-only', source: 'remembered' });
      expect(body.orchestratorModel).toBe('gproxy/b-only');
      expect(process.env.ORCHESTRATOR_MODEL).toBe('gproxy/b-only');
    });

    it('reports the planner model B plans with', async () => {
      process.env.AI_PROVIDER = 'claude-code';
      process.env.ORCHESTRATOR_MODEL = 'gproxy/b-only';

      const body = (await (await app.request(`/api/settings?workspace=${encodeURIComponent(workspaceB)}`)).json()) as SettingsResponse;

      expect(body.orchestratorModel).toBe('gproxy/b-only');
    });
  });

  it('answers for an open session\'s own workspace, and refuses another workspace naming its id', () => {
    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = 'gproxy/b-only';
    const meta = saveSession(savedPlan(), 'session-b', workspaceB, 'session-b');
    pool.adoptSavedSession(meta.id, workspaceB);

    expect(pool.getSettings('session-b').orchestratorModel).toBe('gproxy/b-only');
    expect(pool.getSettings('session-b', workspaceB).orchestratorModel).toBe('gproxy/b-only');
    expect(pool.updateRunSettings({ autorun: true }, 'session-b').orchestratorModel).toBe('gproxy/b-only');
    // The id names B's session only for B: A's copy of it is not this one.
    expect(() => pool.getSettings('session-b', workspaceA)).toThrow(SessionOpenElsewhereError);
    expect(() => pool.updateRunSettings({ autorun: false }, 'session-b', workspaceA)).toThrow(SessionOpenElsewhereError);
  });
});
