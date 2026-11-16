import { describe, it, expect, beforeAll } from 'vitest';
import { RUN_SETTINGS_DEFAULTS, type AiProvider, type PlannerBackendId } from '@ordewell/core';
import { render } from '../render';
import { stripAnsi, style } from '../ansi';
import { initialState, type TuiState } from '../state';
import { reduce, type Action } from '../reducer';

beforeAll(() => {
  style.enabled = false;
});

/** The daemon's answers as the launch refresh dispatches them, applied in order. */
function after(...actions: Action[]): TuiState {
  return actions.reduce((state, action) => reduce(state, action).state, initialState({ rows: 40, cols: 100 }));
}

const rows = (state: TuiState): string[] => render(state).map(stripAnsi);
const row = (state: TuiState, name: string): string => rows(state).find((l) => l.trimStart().startsWith(name)) ?? '';
const NOTICE = /Install a coding agent|add an API key with \/key-set/;

const settings = (aiProvider: PlannerBackendId): Action => ({
  type: 'settingsLoaded',
  settings: { aiProvider, orchestratorModel: '', plannerThinkingEffort: '', maxParallel: 3, modelAllowlist: undefined, plannerModels: undefined, run: { ...RUN_SETTINGS_DEFAULTS } },
});
const runners = (...ids: Array<[string, string]>): Action => ({ type: 'runnersLoaded', runners: ids.map(([id, name]) => ({ id, name, enabled: true })) });
const models = (providers: AiProvider[] = []): Action => ({ type: 'modelsLoaded', models: [], providers });

/**
 * The first frames of a launch: the agent probe answers through the daemon's
 * settings and runner list, so until both land the welcome has not looked yet
 * and must not say nothing was found.
 */
describe('the welcome while the coding agents are detected', () => {
  it('says it is detecting, for the planner and the runners, with no notice, before the daemon answers', () => {
    const state = after();

    expect(row(state, 'Planner')).toMatch(/^\s*Planner\s+Detecting coding agents…\s+\/planner\s*$/);
    expect(row(state, 'Runners')).toMatch(/^\s*Runners\s+Detecting coding agents…\s+\/runners\s*$/);
    expect(rows(state).join('\n')).not.toMatch(NOTICE);
    expect(rows(state).join('\n')).not.toMatch(/not set|none enabled/);
  });

  it('keeps detecting until both the planner and the runner list are in', () => {
    for (const state of [after(settings('claude-code')), after(runners(['claude-code', 'Claude Code']))]) {
      expect(row(state, 'Planner')).toContain('Detecting coding agents…');
      expect(row(state, 'Runners')).toContain('Detecting coding agents…');
      expect(rows(state).join('\n')).not.toMatch(NOTICE);
    }
  });

  it('settles on the detected agent', () => {
    const state = after(settings('claude-code'), runners(['claude-code', 'Claude Code']));

    expect(row(state, 'Planner')).toMatch(/^\s*Planner\s+Claude Code · no model\s+\/planner\s*$/);
    expect(row(state, 'Runners')).toMatch(/^\s*Runners\s+Claude Code\s+\/runners\s*$/);
    expect(rows(state).join('\n')).not.toMatch(NOTICE);
    expect(rows(state).join('\n')).not.toContain('Detecting');
  });

  it('shows the notice once detection found nothing that can plan', () => {
    const state = after(settings('openrouter'), runners(), models());

    expect(row(state, 'Planner')).toMatch(/^\s*Planner\s+OpenRouter \(unavailable\)\s+\/planner\s*$/);
    expect(row(state, 'Runners')).toMatch(/^\s*Runners\s+none enabled\s+\/runners\s*$/);
    expect(rows(state).join('\n')).toMatch(NOTICE);
  });

  it('waits for the configured providers before saying a key is missing', () => {
    expect(rows(after(settings('openrouter'), runners())).join('\n')).not.toMatch(NOTICE);
    expect(rows(after(settings('openrouter'), runners(), models(['openrouter']))).join('\n')).not.toMatch(NOTICE);
  });
});
