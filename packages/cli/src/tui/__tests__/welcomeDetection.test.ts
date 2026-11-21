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

  // The first frame can wait a while on a cold machine's probe: say what it is doing, once, under Setup (F4).
  it('says what the probe does while it runs, and drops the line once the agents are in', () => {
    const detail = 'Looking for coding agents on your PATH, then asking each one whether it is signed in.';
    expect(rows(after()).join(' ')).toContain(detail);
    expect(rows(after(settings('claude-code'), runners(['claude-code', 'Claude Code']))).join(' ')).not.toContain(detail);
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

  // First-run audit F2: OpenRouter is only the fallback name, never a choice the user made.
  it('says there is no planner yet, not a provider the user never chose, once detection found nothing that can plan', () => {
    const state = after(settings('openrouter'), runners(), models());

    expect(row(state, 'Planner')).toMatch(/^\s*Planner\s+none yet\s+\/planner\s*$/);
    expect(rows(state).join('\n')).not.toContain('OpenRouter');
    expect(row(state, 'Runners')).toMatch(/^\s*Runners\s+none enabled\s+\/runners\s*$/);
    expect(rows(state).join('\n')).toMatch(NOTICE);
  });

  it('gives both routes: each agent\'s install command and page, where signing in happens, /refresh, and /key-set', () => {
    // Read as one paragraph: a long line wraps at the pane's width.
    const text = rows(after(settings('openrouter'), runners(), models())).map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');

    const commands = process.platform === 'win32'
      ? ['irm https://claude.ai/install.ps1 | iex', 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"']
      : ['curl -fsSL https://claude.ai/install.sh | bash', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'];
    for (const expected of [
      'No planner yet. Install a coding agent (no API key needed), then run /refresh to detect it again:',
      commands[0], 'https://code.claude.com/docs/en/setup',
      commands[1], 'https://github.com/openai/codex',
      'Signing in happens in the agent itself: run claude or codex once in a terminal and follow its sign-in prompt.',
      'Or add an API key with /key-set, then pick its planner model.',
    ]) expect(text).toContain(expected);
  });

  it('keeps naming a planner that cannot plan while something else can', () => {
    const state = after(settings('openrouter'), runners(['claude-code', 'Claude Code']), models());
    expect(row(state, 'Planner')).toMatch(/^\s*Planner\s+OpenRouter \(unavailable\)\s+\/planner\s*$/);
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
