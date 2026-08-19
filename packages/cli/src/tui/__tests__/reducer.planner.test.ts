import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action } from '../reducer';
import type { PickerItem, TuiState } from '../state';

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

function items(state: TuiState): PickerItem[] {
  if (state.overlay?.kind !== 'picker') throw new Error('expected a picker overlay');
  return state.overlay.picker.items;
}

/** Move the picker cursor onto `id`, then press enter. */
function pick(state: TuiState, id: string) {
  const index = items(state).findIndex((i) => i.id === id);
  if (index < 0) throw new Error(`no picker row for "${id}"`);
  const positioned: TuiState = state.overlay?.kind === 'picker'
    ? { ...state, overlay: { kind: 'picker', picker: { ...state.overlay.picker, index } } }
    : state;
  return reduce(positioned, { type: 'key', key: { name: 'enter' } });
}

const installedAll: Partial<TuiState> = {
  runners: [
    { id: 'claude-code', name: 'Claude Code', enabled: true },
    { id: 'codex', name: 'Codex', enabled: true },
    { id: 'opencode', name: 'OpenCode', enabled: true },
  ],
};

describe('/planner', () => {
  it('opens a picker listing the coding agents before the API providers', () => {
    const { state } = run('/planner', { ...installedAll, configuredProviders: ['openrouter'] });

    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'set-planner' } } });
    expect(items(state).map((i) => i.id)).toEqual(['claude-code', 'codex', 'opencode', 'openrouter']);
  });

  it('says a coding agent needs no API key', () => {
    const { state } = run('/planner', installedAll);
    expect(items(state).find((i) => i.id === 'claude-code')?.detail).toMatch(/no API key/i);
  });

  it('marks the current planner as selected', () => {
    const { state } = run('/planner', { ...installedAll, plannerProvider: 'codex' });
    expect(items(state).find((i) => i.id === 'codex')?.selected).toBe(true);
  });

  it('disables an agent whose CLI is not installed, with the reason', () => {
    const { state } = run('/planner', {
      runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }],
    });

    const codex = items(state).find((i) => i.id === 'codex')!;
    expect(codex.disabled).toBe(true);
    expect(codex.detail).toMatch(/not installed|PATH/);
    // Listed, not hidden — "why isn't Codex here?" is the worse question.
    expect(items(state).map((i) => i.id)).toContain('codex');
  });

  it('refuses to select a disabled agent and keeps the picker open', () => {
    const opened = run('/planner', { runners: [] }).state;
    const { state, effects } = pick(opened, 'codex');

    expect(effects).toEqual([]);
    expect(state.overlay?.kind).toBe('picker');
    expect(state.messages.at(-1)?.role).toBe('error');
  });

  it('selecting an agent persists the choice', () => {
    const opened = run('/planner', installedAll).state;
    const { state, effects } = pick(opened, 'claude-code');

    expect(effects[0]).toMatchObject({ type: 'setPlanner', provider: 'claude-code' });
    expect(state.overlay).toBeNull();
  });

  it('leaves the model decision to the daemon, whatever the old backend served', () => {
    // The daemon resolves the new backend's model (remembered, catalog
    // default, or nothing) — the reducer no longer guesses at it client-side.
    const opened = run('/planner', {
      ...installedAll,
      orchestratorModel: 'deepseek/deepseek-v4-flash',
      models: [{ id: 'sonnet', label: 'Sonnet', provider: 'anthropic', runners: ['claude-code'] }],
    }).state;

    expect(pick(opened, 'claude-code').effects[0]).toEqual({ type: 'setPlanner', provider: 'claude-code' });
  });

  it('/planner <id> sets it without opening the picker', () => {
    const { state, effects } = run('/planner opencode', installedAll);
    expect(effects).toEqual([{ type: 'setPlanner', provider: 'opencode' }]);
    expect(state.overlay).toBeNull();
  });

  it('rejects a provider it does not know', () => {
    const { state, effects } = run('/planner notaplanner');
    expect(effects).toEqual([]);
    expect(state.messages.at(-1)?.role).toBe('error');
  });

  it('fills in the preflight once runner discovery lands', () => {
    // The picker can be opened before the daemon has answered; every agent
    // would otherwise be stuck showing as missing.
    const opened = run('/planner', { runners: [] }).state;
    expect(items(opened).find((i) => i.id === 'codex')?.disabled).toBe(true);

    const { state } = reduce(opened, {
      type: 'runnersLoaded',
      runners: [{ id: 'codex', name: 'Codex', enabled: true }],
    });
    expect(items(state).find((i) => i.id === 'codex')?.disabled).toBe(false);
  });

  it('tracks the planner the daemon reports', () => {
    const { state } = reduce(initialState(), { type: 'settingsLoaded', settings: { aiProvider: 'codex' } });
    expect(state.plannerProvider).toBe('codex');
  });
});

describe('/model follows the planner backend', () => {
  const models = [
    { id: 'sonnet', label: 'Sonnet', provider: 'anthropic', runners: ['claude-code'], variants: [{ id: 'high', label: 'High' }] },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', provider: 'openai', runners: ['codex'] },
  ];

  it('offers a harness planner only that agent\'s own models', () => {
    const { state } = run('/model', {
      plannerProvider: 'claude-code',
      models,
      orchestratorModels: [{ id: 'deepseek/deepseek-v4-flash', label: 'V4 Flash', provider: 'openrouter' }],
    });

    expect(items(state).map((i) => i.id)).toEqual(['sonnet']);
  });

  it('offers a vendor planner the cross-provider catalog', () => {
    const { state } = run('/model', {
      plannerProvider: 'openrouter',
      models,
      orchestratorModels: [{ id: 'deepseek/deepseek-v4-flash', label: 'V4 Flash', provider: 'openrouter' }],
    });

    expect(items(state).map((i) => i.id)).toEqual(['deepseek/deepseek-v4-flash']);
  });

  it('explains an empty agent catalog instead of showing a blank list', () => {
    const { state } = run('/model', { plannerProvider: 'codex', models: [] });
    const row = items(state)[0];
    expect(row.disabled).toBe(true);
    expect(row.detail).toContain('/refresh');
  });
});

/**
 * `/planner-effort` (ADR-0009, story 8): the planning agent's thinking effort,
 * traded against latency and subscription tokens. The levels are the selected
 * model's own variants — never a fixed low/medium/high the agent may not have.
 */
describe('/planner-effort', () => {
  const models = [
    { id: 'sonnet', label: 'Sonnet', provider: 'anthropic', runners: ['claude-code'], variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    { id: 'haiku', label: 'Haiku', provider: 'anthropic', runners: ['claude-code'], variants: [] },
  ];
  const harness: Partial<TuiState> = { plannerProvider: 'claude-code', orchestratorModel: 'sonnet', models };

  it("lists the selected model's variants plus the runner default", () => {
    const { state } = run('/planner-effort', harness);
    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'set-planner-effort' } } });
    expect(items(state).map((i) => i.label)).toEqual(['Runner default', 'Low', 'High']);
  });

  it('marks the current effort as selected, and the default when none is set', () => {
    expect(items(run('/planner-effort', harness).state)[0].selected).toBe(true);
    const withEffort = run('/planner-effort', { ...harness, plannerEffort: 'high' }).state;
    expect(items(withEffort).find((i) => i.id === 'high')?.selected).toBe(true);
    expect(items(withEffort)[0].selected).toBe(false);
  });

  it('persists the chosen level', () => {
    const { effects, state } = pick(run('/planner-effort', harness).state, 'high');
    expect(effects).toEqual([{ type: 'setPlannerEffort', effort: 'high' }]);
    expect(state.overlay).toBeNull();
  });

  it('sends an empty effort for the runner default rather than a fake level', () => {
    const opened = run('/planner-effort', { ...harness, plannerEffort: 'high' }).state;
    expect(pick(opened, items(opened)[0].id).effects).toEqual([{ type: 'setPlannerEffort', effort: '' }]);
  });

  it('/planner-effort <level> sets it without opening the picker', () => {
    const { state, effects } = run('/planner-effort low', harness);
    expect(effects).toEqual([{ type: 'setPlannerEffort', effort: 'low' }]);
    expect(state.overlay).toBeNull();
  });

  it('rejects a level the model does not declare, naming the ones it does', () => {
    const { state, effects } = run('/planner-effort xhigh', harness);
    expect(effects).toEqual([]);
    expect(state.messages.at(-1)?.role).toBe('error');
    expect(state.messages.at(-1)?.content).toContain('low, high');
  });

  it('says so when the selected model exposes no effort levels', () => {
    const { state } = run('/planner-effort', { ...harness, orchestratorModel: 'haiku' });
    expect(items(state)[0].disabled).toBe(true);
    expect(items(state)[0].label).toMatch(/no effort levels/i);
  });

  it('explains that a vendor planner has no separate effort axis', () => {
    const { state } = run('/planner-effort', { plannerProvider: 'openrouter', models });
    expect(items(state)[0].disabled).toBe(true);
    expect(items(state)[0].detail).toContain('/planner');
  });

  it('tracks the effort the daemon reports', () => {
    const { state } = reduce(initialState(), { type: 'settingsLoaded', settings: { plannerThinkingEffort: 'high' } });
    expect(state.plannerEffort).toBe('high');
  });
});

describe('plannerToken', () => {
  const send = (state: TuiState, action: Action) => reduce(state, action).state;
  const s1 = { ...initialState(), sessionId: 's1' };

  it('opens a new streaming assistant entry when the tail is not already one', () => {
    const { state } = reduce(s1, { type: 'plannerToken', text: 'Look', sessionId: 's1' });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: 'assistant', content: 'Look', streaming: true });
  });

  it('appends a second token onto the same streaming entry', () => {
    const opened = send(s1, { type: 'plannerToken', text: 'Look', sessionId: 's1' });
    const { state } = reduce(opened, { type: 'plannerToken', text: 'ing into it', sessionId: 's1' });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ content: 'Looking into it', streaming: true });
  });

  it('a research step landing between two token bursts starts a fresh bubble after it', () => {
    const first = send(s1, { type: 'plannerToken', text: 'Checking the auth module', sessionId: 's1' });
    const researched = send(first, { type: 'researchStep', summary: 'read auth.ts', sessionId: 's1' });
    const { state } = reduce(researched, { type: 'plannerToken', text: 'Found it.', sessionId: 's1' });

    expect(state.messages.map((m) => m.role)).toEqual(['assistant', 'research', 'assistant']);
    expect(state.messages[0]).toMatchObject({ content: 'Checking the auth module', streaming: true });
    expect(state.messages[2]).toMatchObject({ content: 'Found it.', streaming: true });
  });

  it('plannerMessage settles a pending streaming entry in place instead of appending', () => {
    const streamed = send(s1, { type: 'plannerToken', text: 'Looking into it', sessionId: 's1' });
    const { state } = reduce(streamed, { type: 'plannerMessage', content: 'Looking into it.', sessionId: 's1' });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: 'assistant', content: 'Looking into it.' });
    expect(state.messages[0].streaming).toBeFalsy();
  });

  it('plannerMessage still appends when there is no pending streaming entry', () => {
    const { state } = reduce(s1, { type: 'plannerMessage', content: 'Hello.', sessionId: 's1' });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: 'assistant', content: 'Hello.' });
    expect(state.messages[0].streaming).toBeFalsy();
  });

  it('ignores a token from a session that /new has replaced', () => {
    const { state } = reduce({ ...s1, sessionId: 's2' }, { type: 'plannerToken', text: 'stray', sessionId: 's1' });
    expect(state.messages).toHaveLength(0);
  });
});
