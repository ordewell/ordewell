import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { __setConfig, __resetConfig } from '../test/vscode.mock';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { SettingsService, PlannerModelMemory } from '@ordewell/core';
import { PlannerSelection } from '../PlannerSelection';

/**
 * `PlannerSelection.pick` is what `SlashParser` hands a model or effort pick
 * to. Exercised here with the real `VsCodeConfig` so the "against the
 * *current* provider" keying is proven against the live getter, not a stub.
 */
describe('a planner pick is remembered under the live config.aiProvider', () => {
  let dir: string;
  let memory: PlannerModelMemory;
  let config: VsCodeConfig;
  let pickModel: (model: string, effort?: string) => Promise<void>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-planner-recording-'));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    __resetConfig();
    memory = new PlannerModelMemory(new SettingsService());
    config = new VsCodeConfig();
    const selection = new PlannerSelection({
      config,
      modelResolver: { getRunnerUnlisted: () => ({}), plannerCatalog: async () => [] } as never,
      plannerModelMemory: memory,
      runnerInstallation: { plannerUsability: async () => ({ usable: true }) } as never,
      chatProvider: { setPlannerBackends: () => {} } as never,
      sendModelConfig: () => {},
      log: () => {},
    });
    pickModel = (model, effort) => selection.pick({ model, effort: effort ?? '' });
  });

  afterEach(() => {
    delete process.env.ORDEWELL_SETTINGS_PATH;
    __resetConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('picking a model records it against the current provider', async () => {
    __setConfig({ aiProvider: 'codex' });

    await pickModel('gpt-5-codex', 'high');

    expect(memory.recall('codex', [{ id: 'gpt-5-codex', variants: [{ id: 'high' }] }])).toEqual({
      model: 'gpt-5-codex', effort: 'high', source: 'remembered',
    });
  });

  it('does not leak a pick into a different provider than the one active at write time', async () => {
    __setConfig({ aiProvider: 'codex' });
    await pickModel('gpt-5-codex', 'high');

    // `PlannerSelection` calls `config.update('aiProvider', …)` on a switch,
    // which is what invalidates VsCodeConfig's memoized provider — mirror that
    // here rather than mutating the mock's raw config value underneath it.
    __setConfig({ aiProvider: 'claude-code' });
    await config.update('aiProvider', 'claude-code');
    await pickModel('claude-sonnet-4-5');

    expect(memory.recall('codex', [{ id: 'gpt-5-codex', variants: [{ id: 'high' }] }]).source).toBe('remembered');
    expect(memory.recall('claude-code', [{ id: 'claude-sonnet-4-5' }])).toEqual({
      model: 'claude-sonnet-4-5', effort: '', source: 'remembered',
    });
  });
});
