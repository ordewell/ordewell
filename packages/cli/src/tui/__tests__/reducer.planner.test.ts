import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import type { StepperState } from '../reducers/stepper';
import type { SessionMessage } from '@ordewell/core';
import type { TuiState } from '../state';
import { lastMessage, messagesOf } from './chat';

/**
 * The `/planner` picker (ADR-0009): who researches the goal and writes the
 * plan. Coding agents appear alongside API providers because "what plans for
 * me?" is one question; the picker is where that shows.
 */

function run(text: string, overrides: Partial<TuiState> = {}) {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text, cursor: text.length } };
  return reduce(state, { type: 'key', key: { name: 'enter' } });
}

const installedAll: Partial<TuiState> = {
  runners: [
    { id: 'claude-code', name: 'Claude Code', enabled: true },
    { id: 'codex', name: 'Codex', enabled: true },
    { id: 'opencode', name: 'OpenCode', enabled: true },
  ],
};

function stepperOf(state: TuiState): StepperState {
  if (state.overlay?.kind !== 'stepper') throw new Error('expected a stepper overlay');
  return state.overlay.stepper;
}

const press = (state: TuiState, name: string): Step => reduce(state, { type: 'key', key: { name } });

/** Move the stepper's cursor onto `id`, then press enter. */
function choose(state: TuiState, id: string): Step {
  const stepper = stepperOf(state);
  const index = stepper.items.findIndex((i) => i.id === id);
  if (index < 0) throw new Error(`no row for "${id}"`);
  return press({ ...state, overlay: { kind: 'stepper', stepper: { ...stepper, index } } }, 'enter');
}

/** The step on screen and the row its cursor rests on. */
const at = (state: TuiState) => {
  const s = stepperOf(state);
  return { step: s.trail.find((t) => t.active)?.label, on: s.items[s.index]?.id };
};

describe('/planner', () => {
  const models = [
    { id: 'opus', label: 'Claude Opus 5.5', provider: 'anthropic', runners: ['claude-code'], variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    { id: 'haiku', label: 'Claude Haiku 5.5', provider: 'anthropic', runners: ['claude-code'], variants: [] },
    { id: 'gpt', label: 'GPT', provider: 'openai', runners: ['codex'], variants: [{ id: 'xhigh', label: 'Extra high' }] },
  ];
  const ready: Partial<TuiState> = {
    ...installedAll,
    models,
    orchestratorModels: [
      { id: 'deepseek/v4', label: 'DeepSeek V4', provider: 'openrouter' },
      { id: 'qwen/max', label: 'Qwen Max', provider: 'openrouter' },
    ],
    configuredProviders: ['openrouter'],
    plannerProvider: 'codex',
    orchestratorModel: 'gpt',
  };

  it('opens a stepper on the harness step, coding agents before API providers', () => {
    const { state } = run('/planner', ready);

    expect(at(state)).toEqual({ step: 'Harness', on: 'codex' });
    expect(stepperOf(state).items.map((i) => i.id)).toEqual(['claude-code', 'codex', 'opencode', 'openrouter']);
  });

  it('says a coding agent needs no API key', () => {
    const { state } = run('/planner', ready);
    expect(stepperOf(state).items.find((i) => i.id === 'claude-code')?.detail).toMatch(/no API key/i);
  });

  it('offers a signed-out agent, flags its row and names its own login', () => {
    const { state } = run('/planner', {
      ...ready,
      runners: [
        { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-out', loginCommand: ['claude', 'login'] } },
        { id: 'codex', name: 'Codex', enabled: true, auth: { state: 'signed-in' } },
        { id: 'opencode', name: 'OpenCode', enabled: true },
      ],
    });
    const items = stepperOf(state).items;
    const claude = items.find((i) => i.id === 'claude-code');
    expect(claude).toMatchObject({ warn: true, detail: 'not logged in · /login claude-code' });
    expect(claude?.disabled).toBeUndefined();
    expect(items.find((i) => i.id === 'codex')).toMatchObject({ detail: expect.stringMatching(/no API key/i) });
    expect(items.find((i) => i.id === 'codex')?.warn).toBeUndefined();
  });

  it('leaves an agent whose CLI is not installed off the list', () => {
    const opened = run('/planner', { ...ready, runners: [{ id: 'codex', name: 'Codex', enabled: true }] }).state;

    const ids = stepperOf(opened).items.map((i) => i.id);
    expect(ids).not.toContain('claude-code');
    expect(ids).toContain('codex');
  });

  it('names the agents to install when nothing can plan', () => {
    const { state } = run('/planner', { ...ready, runners: [], configuredProviders: [] });

    expect(stepperOf(state).items[0]?.detail).toContain('Claude Code, Codex, OpenCode, GitHub Copilot CLI or Qwen Code');
  });

  const saved = (provider: string, modelId: string, effort: string, notice: string, noticeLevel?: 'error') =>
    ({ type: 'setPlannerChoice', provider, modelId, effort, notice, ...(noticeLevel ? { noticeLevel } : {}) });

  /** Harness › Model › Effort, each confirmed with enter. */
  it('saves harness, model and effort as each is entered, moving on after each', () => {
    let out = choose(run('/planner', ready).state, 'claude-code');
    // The harness saves with the model and effort it would open on, so the planner is never half-switched.
    expect(out.effects).toEqual([saved('claude-code', 'opus', '', 'Planner: Claude Code · Claude Opus 5.5')]);
    expect(at(out.state).step).toBe('Model');

    out = choose(out.state, 'opus');
    expect(out.effects).toEqual([]);
    expect(at(out.state).step).toBe('Effort');
    expect(stepperOf(out.state).items.map((i) => i.label)).toEqual(['Runner default', 'Low', 'High']);

    const done = choose(out.state, 'high');
    expect(done.state.overlay).toBeNull();
    expect(done.effects).toEqual([saved('claude-code', 'opus', 'high', 'Planner: Claude Code · Claude Opus 5.5 · High effort')]);
  });

  it('names an effort whose catalog label already says "effort" once', () => {
    const catalog = [{ ...models[0], variants: [{ id: 'low', label: 'Low effort' }] }];
    const out = choose(choose(choose(run('/planner', { ...ready, models: catalog }).state, 'claude-code').state, 'opus').state, 'low');
    expect(out.effects).toEqual([saved('claude-code', 'opus', 'low', 'Planner: Claude Code · Claude Opus 5.5 · Low effort')]);
  });

  it('confirms a signed-out pick at error level, with the same words', () => {
    const out = choose(run('/planner', {
      ...ready,
      runners: [
        { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] } },
        { id: 'codex', name: 'Codex', enabled: true, auth: { state: 'signed-in' } },
        { id: 'opencode', name: 'OpenCode', enabled: true },
      ],
    }).state, 'claude-code');

    expect(out.effects).toEqual([saved('claude-code', 'opus', '', 'Planner: Claude Code · Claude Opus 5.5', 'error')]);
  });

  it('confirms a signed-in pick plainly', () => {
    const out = choose(run('/planner', {
      ...ready,
      runners: [
        { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in', loginCommand: ['claude', 'auth', 'login'] } },
        { id: 'codex', name: 'Codex', enabled: true },
        { id: 'opencode', name: 'OpenCode', enabled: true },
      ],
    }).state, 'claude-code');

    expect(out.effects).toEqual([saved('claude-code', 'opus', '', 'Planner: Claude Code · Claude Opus 5.5')]);
  });

  it('saves nothing and prints nothing for a step entered unchanged', () => {
    const opened = run('/planner', ready).state;
    const { state, effects } = choose(opened, 'codex');
    expect(effects).toEqual([]);
    expect(messagesOf(state)).toEqual(messagesOf(opened));
    expect(at(state)).toEqual({ step: 'Model', on: 'gpt' });
  });

  it('shows a saved harness as the current one on going back to it', () => {
    const state = press(choose(run('/planner', ready).state, 'claude-code').state, 'left').state;
    expect(at(state)).toEqual({ step: 'Harness', on: 'claude-code' });
    expect(stepperOf(state).items.find((i) => i.selected)?.id).toBe('claude-code');
  });

  it("keeps the saved choice marked when the daemon's answer lands", () => {
    const state = choose(run('/planner', ready).state, 'claude-code').state;
    const echoed = reduce(state, {
      type: 'settingsLoaded',
      settings: { aiProvider: 'claude-code', orchestratorModel: 'opus', plannerThinkingEffort: '', plannerModels: { 'claude-code': { model: 'opus' } } },
    }).state;
    expect(at(echoed)).toEqual({ step: 'Model', on: 'opus' });
    expect(stepperOf(echoed).items.find((i) => i.selected)?.id).toBe('opus');
  });

  it('skips the effort step for a model without variants', () => {
    let state = run('/planner', ready).state;
    state = choose(state, 'claude-code').state;
    expect(stepperOf(state).trail.map((t) => t.label)).toEqual(['Harness', 'Model', 'Effort']);

    const done = choose(state, 'haiku');
    expect(done.state.overlay).toBeNull();
    expect(done.effects).toEqual([saved('claude-code', 'haiku', '', 'Planner: Claude Code · Claude Haiku 5.5')]);
  });

  it('asks only harness and model for a vendor backend, from the vendor catalog', () => {
    const harness = choose(run('/planner', ready).state, 'openrouter');
    expect(harness.effects).toEqual([saved('openrouter', 'deepseek/v4', '', 'Planner: OpenRouter · DeepSeek V4')]);
    const state = harness.state;
    expect(stepperOf(state).trail.map((t) => t.label)).toEqual(['Harness', 'Model']);
    expect(stepperOf(state).items.map((i) => i.id)).toEqual(['deepseek/v4', 'qwen/max']);

    expect(choose(state, 'qwen/max').effects).toEqual([saved('openrouter', 'qwen/max', '', 'Planner: OpenRouter · Qwen Max')]);
  });

  it("lists the chosen harness's models, not the current planner's", () => {
    let state = run('/planner', ready).state;
    state = choose(state, 'claude-code').state;
    expect(stepperOf(state).items.map((i) => i.id)).toEqual(['opus', 'haiku']);

    // Back to the harness step and onto another one: the model step is rebuilt for it.
    state = press(state, 'shift-tab').state;
    state = choose(state, 'codex').state;
    expect(stepperOf(state).items.map((i) => i.id)).toEqual(['gpt']);
    expect(at(state).on).toBe('gpt');
  });

  it('pre-selects the model remembered for the chosen backend', () => {
    let state = run('/planner', { ...ready, plannerModels: { 'claude-code': { model: 'haiku' } } }).state;
    state = choose(state, 'claude-code').state;
    expect(at(state)).toEqual({ step: 'Model', on: 'haiku' });
  });

  it('pre-selects the current model when the backend is unchanged, and the first model otherwise', () => {
    const current = choose(run('/planner', { ...ready, plannerProvider: 'claude-code', orchestratorModel: 'haiku' }).state, 'claude-code').state;
    expect(at(current).on).toBe('haiku');

    const fresh = choose(run('/planner', ready).state, 'claude-code').state;
    expect(at(fresh).on).toBe('opus');
  });

  it('pre-selects the remembered effort while that model still declares it, else the runner default', () => {
    const remembered = { ...ready, plannerModels: { 'claude-code': { model: 'opus', effort: 'low' } } };
    let state = choose(run('/planner', remembered).state, 'claude-code').state;
    state = choose(state, 'opus').state;
    expect(at(state)).toEqual({ step: 'Effort', on: 'low' });

    const stale = { ...ready, plannerModels: { 'claude-code': { model: 'opus', effort: 'max' } } };
    state = choose(choose(run('/planner', stale).state, 'claude-code').state, 'opus').state;
    expect(stepperOf(state).items[stepperOf(state).index].label).toBe('Runner default');
  });

  it('pre-selects the current effort when the backend and model are unchanged', () => {
    const current = { ...ready, plannerProvider: 'claude-code', orchestratorModel: 'opus', plannerEffort: 'high' };
    const state = choose(choose(run('/planner', current).state, 'claude-code').state, 'opus').state;
    expect(at(state).on).toBe('high');
  });

  it('sends the runner default as an empty effort', () => {
    const current = { ...ready, plannerProvider: 'claude-code', orchestratorModel: 'opus', plannerEffort: 'high' };
    const state = press(run('/planner', current).state, 'tab').state;
    const { effects } = choose(press(state, 'tab').state, '__runner_default__');
    expect(effects).toEqual([saved('claude-code', 'opus', '', 'Planner: Claude Code · Claude Opus 5.5')]);
  });

  it('explains an empty catalog for the chosen harness, saving nothing until a model can go with it', () => {
    const { state, effects } = choose(run('/planner', { ...ready, models: [] }).state, 'claude-code');
    expect(effects).toEqual([]);
    expect(state.plannerProvider).toBe('codex');
    const row = stepperOf(state).items[0];
    expect(row.disabled).toBe(true);
    expect(row.label).toMatch(/No claude-code models discovered yet/);
    expect(row.detail).toContain('/refresh');
  });

  it('esc keeps what enter saved and changes nothing more, from any step', () => {
    const opened = run('/planner', ready).state;
    const first = press(opened, 'escape');
    expect(first.effects).toEqual([]);
    expect(first.state.overlay).toBeNull();
    expect(first.state.plannerProvider).toBe('codex');

    const state = press(choose(opened, 'claude-code').state, 'down').state;
    const closed = press(state, 'escape');
    expect(closed.effects).toEqual([]);
    expect(closed.state.overlay).toBeNull();
    expect(closed.state.plannerProvider).toBe('claude-code');
    expect(closed.state.orchestratorModel).toBe('opus');
  });

  it('fills in the preflight once runner discovery lands', () => {
    // The stepper can be opened before the daemon has answered; with no runners
    // yet no agent is offered, and the list fills once they land.
    const opened = run('/planner', { ...ready, runners: [] }).state;
    expect(stepperOf(opened).items.map((i) => i.id)).not.toContain('codex');

    const { state } = reduce(opened, { type: 'runnersLoaded', runners: [{ id: 'codex', name: 'Codex', enabled: true }] });
    expect(stepperOf(state).items.map((i) => i.id)).toContain('codex');
  });

  it('fills in the model step once the catalog lands', () => {
    const opened = choose(run('/planner', { ...ready, models: [] }).state, 'claude-code').state;
    const { state } = reduce(opened, { type: 'modelsLoaded', models });
    expect(stepperOf(state).items.map((i) => i.id)).toEqual(['opus', 'haiku']);
  });

  it('names a provider whose catalog failed in the model step, without offering it', () => {
    const state = run('/planner', {
      ...ready,
      plannerProvider: 'openrouter',
      orchestratorModel: 'deepseek/v4',
      providerErrors: { openai: 'Failed to fetch models: 401 Unauthorized' },
    }).state;
    const modelStep = press(state, 'enter').state;

    expect(stepperOf(modelStep).items[0]).toMatchObject({
      label: 'Some providers are unavailable',
      detail: expect.stringContaining('OpenAI'),
      disabled: true,
    });
    expect(stepperOf(modelStep).items.map((i) => i.id)).toContain('deepseek/v4');
  });

  it('/planner <id> switches directly, leaving the model to the daemon', () => {
    const { state, effects } = run('/planner opencode', installedAll);
    expect(effects).toEqual([{ type: 'setPlanner', provider: 'opencode' }]);
    expect(state.overlay).toBeNull();
  });

  it('/planner copilot-cli switches like any runner that plans', () => {
    const runners = [...(installedAll.runners ?? []), { id: 'copilot-cli', name: 'GitHub Copilot CLI', enabled: true }];
    const { state, effects } = run('/planner copilot-cli', { runners });
    expect(effects).toEqual([{ type: 'setPlanner', provider: 'copilot-cli' }]);
    expect(lastMessage(state)?.role).not.toBe('error');
  });

  it('rejects a provider it does not know', () => {
    const { state, effects } = run('/planner notaplanner');
    expect(effects).toEqual([]);
    expect(lastMessage(state)?.role).toBe('error');
  });

  it('tracks the planner the daemon reports', () => {
    const { state } = reduce(initialState(), { type: 'settingsLoaded', settings: { aiProvider: 'codex' } });
    expect(state.plannerProvider).toBe('codex');
  });

  it('tracks the per-backend model memory the daemon reports', () => {
    const plannerModels = { codex: { model: 'gpt', effort: 'xhigh' } };
    const { state } = reduce(initialState(), { type: 'settingsLoaded', settings: { plannerModels } });
    expect(state.plannerModels).toEqual(plannerModels);
  });
});

it('tracks the effort the daemon reports', () => {
  const { state } = reduce(initialState(), { type: 'settingsLoaded', settings: { plannerThinkingEffort: 'high' } });
  expect(state.plannerEffort).toBe('high');
});

describe('streamed planner text', () => {
  const send = (state: TuiState, action: Action) => reduce(state, action).state;
  const hear = (message: SessionMessage, sessionId = 's1'): Action => ({ type: 'sessionMessage', message, sessionId });
  const delta = (text: string): SessionMessage => ({ type: 'planner_text_delta', turnId: 'turn-1', segmentId: 'seg-1', text });
  const s1 = { ...initialState(), sessionId: 's1' };

  it('grows one streaming planner block as deltas arrive', () => {
    const state = [delta('Look'), delta('ing into it')].map((m) => hear(m)).reduce(send, s1);
    expect(messagesOf(state)).toMatchObject([{ role: 'planner', text: 'Looking into it', streaming: true }]);
  });

  it('settles that block in place when the turn\'s reply arrives', () => {
    const streamed = send(s1, hear(delta('Looking into it')));
    const state = send(streamed, hear({ type: 'planner_message', content: 'Looking into it.', timestamp: '', turnId: 'turn-1' }));

    expect(messagesOf(state)).toMatchObject([{ role: 'planner', text: 'Looking into it.', streaming: false }]);
  });

  it('ignores a delta from a session that /new has replaced', () => {
    const { state } = reduce({ ...s1, sessionId: 's2' }, hear(delta('stray'), 's1'));
    expect(messagesOf(state)).toHaveLength(0);
  });
});
