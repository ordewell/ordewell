import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Hono } from 'hono';
import { ModelResolver, type ExecImpl, type IConfig, type ModelsResponse, type RunnerManifest, type RunnerRegistry } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { modelsRoute } from '../models';

// A runner CLI that cannot start its service (`opencode` beside another
// home's, here) fails each listing only after tens of seconds. Every listing
// here waits on a gate the test opens, so a read that spawns one is seen to.

function harnessManifest(name: string): RunnerManifest {
  return {
    name,
    displayName: name,
    runner: { command: name, args: [] },
    modelDiscovery: {
      method: 'command',
      discoveryCommands: [{ command: name, args: ['models'], parser: 'line-by-line' }],
      fallbackModels: [],
    },
  } as unknown as RunnerManifest;
}

const LISTINGS: Record<string, string> = {
  opencode: 'opencode/model-x Model X\n',
  'claude-code': 'claude-a Claude A\n',
};

const ENV = ['ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'];

describe('GET /api/models?cached=1', () => {
  let dir: string;
  let app: Hono;
  let pool: OrchestratorPool;
  let listings: string[];
  let open: () => void;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV) saved[key] = process.env[key];
    for (const key of ENV) delete process.env[key];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-models-cached-'));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    listings = [];
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const exec: ExecImpl = async (command) => {
      const runner = command.split(' ')[0];
      listings.push(runner);
      await gate;
      return { stdout: LISTINGS[runner] ?? '' };
    };
    const registry = { getManifest: (id: string) => (id in LISTINGS ? harnessManifest(id) : undefined) } as unknown as RunnerRegistry;
    const config = { getProviderBaseUrl: () => '', getProviderApiKey: () => '', setProviderModelLists: () => {} } as unknown as IConfig;
    pool = new OrchestratorPool({
      modelResolver: new ModelResolver(registry, config, { execImpl: exec, fetchImpl: async () => new Response('{}', { status: 500 }) }),
      codexSandbox: { ensure: async () => {}, refresh: async () => {} },
    });
    app = new Hono().route('/api/models', modelsRoute(pool));
  });

  afterEach(() => {
    open();
    pool.destroyAll();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function models(query = ''): Promise<{ status: number; body: ModelsResponse }> {
    const res = await app.request(`/api/models${query}`);
    return { status: res.status, body: (await res.json()) as ModelsResponse };
  }

  it('answers from what discovery holds, asking no runner, on a daemon that has discovered nothing yet', async () => {
    const answer = await models('?cached=1');

    expect(answer.status).toBe(200);
    expect(listings).toEqual([]);
    expect(answer.body.modelsByRunner.opencode).toEqual([]);
  });

  it('offers what an earlier discovery found, and asks no runner again', async () => {
    const full = models();
    await expect.poll(() => listings.length).toBeGreaterThan(0);
    open();
    await full;
    const asked = listings.length;

    const answer = await models('?cached=1');

    expect(listings).toHaveLength(asked);
    expect(answer.body.modelsByRunner.opencode?.map((m) => m.modelId)).toEqual(['opencode/model-x']);
    expect(answer.body.modelsByRunner['claude-code']?.map((m) => m.modelId)).toEqual(['claude-a']);
  });
});
