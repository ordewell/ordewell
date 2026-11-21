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

    expect(row(state, 'Planner')).toMatch(/^\s*Planner\s+Claude Code · agent default\s+\/planner\s*$/);
    expect(row(state, 'Runners')).toMatch(/^\s*Runners\s+Claude Code\s+\/runners\s*$/);
    expect(rows(state).join('\n')).not.toMatch(NOTICE);
    expect(rows(state).join('\n')).not.toContain('Detecting');
  });

  // An agent with no model picked plans with its own default: a working state, not a warning.
  it('paints an agent planner\'s own default model plainly, and only a vendor\'s missing model in yellow', () => {
    style.enabled = true;
    try {
      const agent = render(after(settings('claude-code'), runners(['claude-code', 'Claude Code']))).find((l) => stripAnsi(l).trimStart().startsWith('Planner')) ?? '';
      expect(agent).toContain('agent default');
      expect(agent).not.toContain(style.yellow('agent default'));
      const vendor = render(after(settings('openai'), runners(['claude-code', 'Claude Code']), models(['openai']))).find((l) => stripAnsi(l).trimStart().startsWith('Planner')) ?? '';
      expect(vendor).toContain(style.yellow('no model'));
    } finally {
      style.enabled = false;
    }
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

/**
 * A key in the shell or saved in Ordewell does not take planning from the
 * detected agent (ADR-0076), so the first screen says, once, who plans and why.
 */
describe('the welcome when a key was found but the detected agent plans', () => {
  const keyPassedOver = (unusedPlanningKey?: AiProvider): Action => ({
    type: 'settingsLoaded',
    settings: { aiProvider: 'claude-code', orchestratorModel: '', plannerThinkingEffort: '', ...(unusedPlanningKey ? { unusedPlanningKey } : {}), maxParallel: 3, modelAllowlist: undefined, plannerModels: undefined, run: { ...RUN_SETTINGS_DEFAULTS } },
  });
  const LINE = 'Planning with Claude Code. An OpenAI key was found and is not used for planning; /planner changes that.';

  it('says which planner is active and which key it plans past, once', () => {
    const text = rows(after(keyPassedOver('openai'), runners(['claude-code', 'Claude Code']))).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain(LINE);
    expect(text.split(LINE)).toHaveLength(2);
  });

  it('says nothing when no key was passed over', () => {
    expect(rows(after(keyPassedOver(), runners(['claude-code', 'Claude Code']))).join(' ')).not.toContain('not used for planning');
  });
});
