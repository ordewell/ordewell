import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Hono } from 'hono';
import {
  ModelResolver,
  RunnerInstallation,
  SettingsService,
  type ExecImpl,
  type IConfig,
  type RunnerManifest,
  type RunnerRegistry,
  type SettingsResponse,
  type SettingsUpdateResponse,
} from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { settingsRoute } from '../settings';

// A runner CLI can take seconds to list its models (`opencode models` boots a
// service first). Here every listing waits on a gate the test opens, so a
// request that waits on discovery stays pending until it does (ADR-0040).

function harnessManifest(name: string): RunnerManifest {
  return {
    name,
    displayName: name,
    runner: { command: name, args: [] },
    modelDiscovery: {
      method: 'command',
      discoveryCommands: [{ command: name, args: ['models'], parser: 'line-by-line' }],
      fallbackModels: [],
      variants: [{ id: 'high', label: 'High effort' }],
    },
  } as unknown as RunnerManifest;
}

const LISTINGS: Record<string, string> = {
  opencode: 'opencode/model-x Model X\nopencode/model-y Model Y\n',
  'claude-code': 'claude-a Claude A\ngproxy/listed Gateway\n',
};

const PENDING = Symbol('pending');

/** What `request` settled to, or PENDING if it is still waiting once a closed gate could have been its only hold-up. */
async function settled<T>(request: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([request, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 1_000))]);
}

const ENV = ['ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT', 'ORDEWELL_MAX_PARALLEL', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'];

describe('/api/settings while a runner is slow to list its models', () => {
  let dir: string;
  let app: Hono;
  let pool: OrchestratorPool;
  let listings: string[];
  let open: () => void;
  let fail: (err: Error) => void;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV) saved[key] = process.env[key];
    for (const key of ENV) delete process.env[key];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-settings-catalog-wait-'));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    listings = [];
    const gate = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
    gate.catch(() => {});
    const exec: ExecImpl = async (command) => {
      const runner = command.split(' ')[0];
      listings.push(runner);
      await gate;
      return { stdout: LISTINGS[runner] ?? '' };
    };
    const registry = { getManifest: (id: string) => (id in LISTINGS ? harnessManifest(id) : undefined) } as unknown as RunnerRegistry;
    const config = { getProviderBaseUrl: () => '', getProviderApiKey: () => '', setProviderModelLists: () => {} } as unknown as IConfig;
    // Every agent installed with its sign-in unread, which never refuses a
    // pick (ADR-0052): what these cases judge is the catalog, not this host's logins.
    vi.spyOn(RunnerInstallation.prototype, 'runnerUsability').mockResolvedValue({ usable: true, auth: { state: 'unknown' } });
    pool = new OrchestratorPool({ modelResolver: new ModelResolver(registry, config, { execImpl: exec }) });
    app = new Hono().route('/api/settings', settingsRoute(pool));
  });

  afterEach(() => {
    open();
    pool.destroyAll();
    vi.restoreAllMocks();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function patch(body: unknown): Promise<{ status: number; body: SettingsUpdateResponse }> {
    const res = await app.request('/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as SettingsUpdateResponse };
  }
  async function read(): Promise<SettingsResponse> {
    return (await (await app.request('/api/settings')).json()) as SettingsResponse;
  }

  it('applies an explicit model pick without waiting for the catalog', async () => {
    process.env.AI_PROVIDER = 'claude-code';

    const answer = await settled(patch({ env: { AI_PROVIDER: 'opencode', ORCHESTRATOR_MODEL: 'opencode/model-y', ORDEWELL_PLANNER_EFFORT: '' } }));

    expect(answer).toMatchObject({ status: 200, body: { aiProvider: 'opencode', orchestratorModel: 'opencode/model-y' } });
    expect(process.env.ORCHESTRATOR_MODEL).toBe('opencode/model-y');
  });

  it('applies a model named on its own without waiting for the catalog', async () => {
    process.env.AI_PROVIDER = 'opencode';

    const answer = await settled(patch({ orchestratorModel: 'opencode/model-x' }));

    expect(answer).toMatchObject({ status: 200, body: { aiProvider: 'opencode', orchestratorModel: 'opencode/model-x' } });
  });

  it('saves a key, an allowlist, a limit and run settings without asking any runner', async () => {
    process.env.AI_PROVIDER = 'opencode';
    process.env.ORCHESTRATOR_MODEL = 'opencode/model-x';

    const answers = await settled(Promise.all([
      patch({ env: { OPENROUTER_API_KEY: 'sk-or-new' } }),
      patch({ modelAllowlist: { opencode: ['opencode/model-x'] } }),
      patch({ env: { ORDEWELL_MAX_PARALLEL: '5' } }),
      patch({ run: { autorun: true } }),
    ]));

    expect(answers).not.toBe(PENDING);
    expect((answers as { status: number }[]).map((a) => a.status)).toEqual([200, 200, 200, 200]);
    expect(new SettingsService().getAll().modelAllowlist).toEqual({ opencode: ['opencode/model-x'] });
    expect(listings).toEqual([]);
  });

  it('answers a read whose planner model no catalog decides without asking any runner', async () => {
    process.env.AI_PROVIDER = 'opencode';

    const answer = await settled(read());

    expect(answer).toMatchObject({ aiProvider: 'opencode' });
    expect(listings).toEqual([]);
  });

  // An agent's model in the slug shape could be a vendor's left in the
  // environment: only the agent's own catalog can say it is not.
  it('waits for the catalog when a read\'s planner model is one only the catalog can place', async () => {
    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = 'gproxy/listed';

    const answer = read();
    expect(await settled(answer)).toBe(PENDING);

    open();
    expect(await answer).toMatchObject({ aiProvider: 'claude-code', orchestratorModel: 'gproxy/listed' });
    expect(listings).toEqual(['claude-code']);
  });

  it('restores the remembered model on a switch made before the catalog was listed', async () => {
    process.env.AI_PROVIDER = 'claude-code';
    new SettingsService().setPlannerModel('opencode', { model: 'opencode/model-y' });

    const answer = patch({ env: { AI_PROVIDER: 'opencode' } });
    expect(await settled(answer)).toBe(PENDING);

    open();
    expect((await answer).body).toMatchObject({ orchestratorModel: 'opencode/model-y', switchRecall: { model: 'opencode/model-y', source: 'remembered' } });
    expect(process.env.ORCHESTRATOR_MODEL).toBe('opencode/model-y');
  });

  it('lands a pick made while a switch waits after that switch, and holds back nothing else', async () => {
    process.env.AI_PROVIDER = 'claude-code';
    new SettingsService().setPlannerModel('opencode', { model: 'opencode/model-y' });

    const switched = patch({ env: { AI_PROVIDER: 'opencode' } });
    const picked = patch({ env: { AI_PROVIDER: 'claude-code', ORCHESTRATOR_MODEL: 'claude-a', ORDEWELL_PLANNER_EFFORT: '' } });
    expect(await settled(patch({ run: { autorun: true } }))).toMatchObject({ status: 200 });
    expect(await settled(picked)).toBe(PENDING);

    open();
    expect((await switched).body).toMatchObject({ aiProvider: 'opencode', orchestratorModel: 'opencode/model-y' });
    expect((await picked).body).toMatchObject({ aiProvider: 'claude-code', orchestratorModel: 'claude-a' });
    expect(process.env.AI_PROVIDER).toBe('claude-code');
    expect(process.env.ORCHESTRATOR_MODEL).toBe('claude-a');
  });

  it('still switches when the catalog cannot be listed, with no model to restore', async () => {
    process.env.AI_PROVIDER = 'claude-code';
    new SettingsService().setPlannerModel('opencode', { model: 'opencode/model-y' });

    const answer = patch({ env: { AI_PROVIDER: 'opencode' } });
    fail(new Error('opencode: service did not start'));

    expect(await answer).toMatchObject({ status: 200, body: { aiProvider: 'opencode', orchestratorModel: '', switchRecall: { source: 'none' } } });
    // The next switch does not wait on the CLI again: the failure is remembered briefly.
    const again = await settled(patch({ env: { AI_PROVIDER: 'opencode', ORCHESTRATOR_MODEL: '' } }));
    expect(again).not.toBe(PENDING);
  });
});
