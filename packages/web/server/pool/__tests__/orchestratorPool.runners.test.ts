import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ModelResolver, Session, SettingsService, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';
import { withReadyPlanner } from '../../__tests__/readyPlanner';

withReadyPlanner();

/**
 * The pool holds no runner state of its own, so "reopening Ordewell" is just a
 * second pool over the same settings file — which is exactly what these assert.
 */
describe('OrchestratorPool enabled runners', () => {
  let dir: string;
  let savedPath: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-runners-'));
    savedPath = process.env.ORDEWELL_SETTINGS_PATH;
    savedEnv = process.env.ORDEWELL_ENABLED_RUNNERS;
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    process.env.ORDEWELL_ENABLED_RUNNERS = 'claude-code';
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = savedPath;
    if (savedEnv === undefined) delete process.env.ORDEWELL_ENABLED_RUNNERS;
    else process.env.ORDEWELL_ENABLED_RUNNERS = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the environment until the user chooses', () => {
    expect(new OrchestratorPool().getRunnerState().enabledRunners).toEqual(['claude-code']);
  });

  it('a later pool sees the choice, not the environment default', () => {
    const pool = new OrchestratorPool();
    pool.setRunnerEnabled('opencode', true);
    pool.setRunnerEnabled('claude-code', false);
    expect(new OrchestratorPool().getRunnerState().enabledRunners).toEqual(['opencode']);
  });

  it('remembers that every runner was disabled rather than reinstating the default', () => {
    const pool = new OrchestratorPool();
    pool.setRunnerEnabled('claude-code', false);
    expect(new OrchestratorPool().getRunnerState().enabledRunners).toEqual([]);
  });

  it('enabling a runner twice does not duplicate it', () => {
    const pool = new OrchestratorPool();
    pool.setRunnerEnabled('opencode', true);
    pool.setRunnerEnabled('opencode', true);
    expect(new OrchestratorPool().getRunnerState().enabledRunners).toEqual(['claude-code', 'opencode']);
  });

  it("keeps another process's runner choice made in the same mtime tick as the daemon's last write", () => {
    const file = process.env.ORDEWELL_SETTINGS_PATH as string;
    const pool = new OrchestratorPool();
    pool.setRunnerEnabled('opencode', true);
    const tick = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, tick, tick);
    pool.getRunnerState();

    // The TUI's own process (or an extension host) saves its choice without the daemon hearing of it.
    new SettingsService(file).setEnabledRunners(['codex']);
    fs.utimesSync(file, tick, tick);

    expect(pool.getRunnerState().enabledRunners).toEqual(['codex']);
    pool.setRunnerEnabled('opencode', true);
    expect(new OrchestratorPool().getRunnerState().enabledRunners).toEqual(['codex', 'opencode']);
  });

  it('a session already open sees a runner enabled after it started', async () => {
    const workspace = path.join(dir, 'ws');
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);
    const discoverSpy = vi.spyOn(ModelResolver.prototype, 'modelsForRunners').mockResolvedValue({});
    const pool = new OrchestratorPool();
    try {
      await pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);

      pool.setRunnerEnabled('opencode', true);

      expect((await pool.session('s1', undefined).liveCatalog()).runners).toEqual(['claude-code', 'opencode']);
    } finally {
      startSpy.mockRestore();
      discoverSpy.mockRestore();
      pool.destroyAll();
    }
  });
});
