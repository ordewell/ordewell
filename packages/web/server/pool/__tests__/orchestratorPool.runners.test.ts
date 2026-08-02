import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OrchestratorPool } from '../orchestratorPool';

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
});
