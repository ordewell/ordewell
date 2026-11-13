import { expect, it } from 'vitest';
import { EMPTY_TASK_LOG_FOLLOW, type AccountLimitSnapshot } from '@ordewell/core';
import type { WsEvent } from '../../apiClient';
import { createInbound } from '../inbound';
import { reduce } from '../reducer';
import { initialState, type TuiState } from '../state';
import { chatLayout } from '../layout';
import { stripAnsi, width } from '../ansi';
import { render } from '../render';

const codex: AccountLimitSnapshot = {
  harness: 'codex', label: 'Codex', status: 'fresh', readAt: '2026-10-26T10:00:00Z',
  buckets: [{ id: 'account', windows: [
    { slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: null },
    { slot: 'secondary', usedPercent: null, durationMinutes: 10080, resetsAt: null },
  ] }],
};
const go: AccountLimitSnapshot = { ...codex, harness: 'opencode', label: 'OpenCode Go', provider: 'opencode-go' };
const footer = (state: TuiState, cols = 200) => chatLayout(state, 24, cols).footer.map(stripAnsi);

it('carries a live quota frame into one planner footer without touching chat or scroll', () => {
  let state = initialState({ sessionId: 's', plannerProvider: 'codex', orchestratorModel: 'gpt-5', scroll: 3 });
  state = reduce(state, { type: 'sessionMessage', sessionId: 's', message: {
    type: 'planner_usage', totals: { reportedCost: { USD: 0.42 } }, byModel: [],
    contextFill: { usedTokens: 61000, windowTokens: 1000000 },
  } }).state;
  const before = state;
  const receive = createInbound((action) => { state = reduce(state, action).state; }, 's').receive;
  receive({ type: 'account_limits', sessionId: 's', stream: 'daemon', revision: 1, limits: [codex] } as unknown as WsEvent);
  expect(footer(state)).toEqual(['Planner ctx 61k (6%) · Codex 5h 24% used · $0.42']);
  expect(state.conversation).toBe(before.conversation);
  expect(state.scroll).toBe(before.scroll);
});

it('places only the assigned runner limits between the task context and reported cost', () => {
  const state = initialState({
    sessionId: 's', accountLimits: [codex, { ...codex, harness: 'claude-code', label: 'Claude Code' }],
    tasks: [{ id: 't', order: 1, title: 'Work', type: 'ai', status: 'completed', dependencies: [], assignedRunner: 'codex',
      attemptUsage: [{ attempt: 1, runner: 'codex', startedAt: '', wallTimeMs: 0, byModel: [], lastPromptTokens: 36000, contextWindow: 200000, totals: { reportedCost: { USD: 0.42 } } }],
    }],
    taskView: { ...EMPTY_TASK_LOG_FOLLOW, taskId: 't', attempt: 1, loaded: true, queuedIndex: null },
  });
  expect(footer(state)).toEqual(['ctx 36k (18%) · Codex 5h 24% used · $0.42']);
});

it('follows the latest main model serving a task while old attempts are viewed, then respects reassignment', () => {
  let state = initialState({
    sessionId: 's', accountLimits: [go],
    tasks: [{ id: 't', order: 1, title: 'Work', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'opencode', assignedModel: { modelId: 'opencode/zen', modelLabel: 'Zen' } }],
    taskView: { ...EMPTY_TASK_LOG_FOLLOW, taskId: 't', attempt: 2, attempts: [1, 2], loaded: true, queuedIndex: null },
  });
  expect(footer(state)).toEqual([]);
  state = reduce(state, { type: 'taskLog', sessionId: 's', taskId: 't', attempt: 2, events: [
    { type: 'usage', record: { source: 'opencode', model: 'opencode-go/kimi', inputTokens: 1000 } },
    { type: 'usage', record: { source: 'opencode', model: 'third-party/subagent', inputTokens: 2000, subagentId: 'sub' } },
  ] }).state;
  expect(footer(state)).toEqual(['ctx 1k · OpenCode Go 5h 24% used']);
  state = reduce(state, { type: 'key', key: { name: 'alt-left' } }).state;
  state = reduce(state, { type: 'taskLogLoaded', sessionId: 's', taskId: 't', attempt: 1, events: [
    { type: 'usage', record: { source: 'opencode', model: 'third-party/old', inputTokens: 500 } },
  ] }).state;
  expect(footer(state).join(' ')).toContain('OpenCode Go 5h 24% used');
  state = reduce(state, { type: 'runMessage', message: { type: 'task_updated', taskId: 't', changes: { assignedModel: { modelId: 'third-party/new', modelLabel: 'New' } } }, sessionId: 's' }).state;
  expect(footer(state).join(' ')).not.toContain('OpenCode Go');
});

it('keeps context first and exact frame geometry with wide labels and narrow dimensions', () => {
  let state = initialState({ sessionId: 's', plannerProvider: 'codex', accountLimits: [{ ...codex, label: '配額\nCodex' }] });
  state = reduce(state, { type: 'sessionMessage', message: { type: 'planner_usage', totals: { inputTokens: 61000 }, byModel: [], contextFill: { usedTokens: 61000 } } }).state;
  expect(footer(state)[0]).toBe('Planner ctx 61k · 配額 Codex 5h 24% used');
  for (const rows of [1, 4, 12, 24]) for (const cols of [1, 12, 25, 80]) {
    const frame = render({ ...state, rows, cols });
    expect(frame).toHaveLength(rows);
    expect(frame.every((line) => !line.includes('\n') && width(line) <= cols)).toBe(true);
  }
  expect(footer(state, 15)).toEqual(['Planner ctx 61…']);
});

it('adopts quota greetings independently of run stamps, including those that arrive while a session opens', async () => {
  let state = initialState({ sessionId: 's', plannerProvider: 'codex' });
  const inbound = createInbound((action) => { state = reduce(state, action).state; }, 's');
  const receive = inbound.receive;
  receive({ type: 'run_snapshot', sessionId: 's', stream: 'daemon', seq: 100, view: state.run });
  receive({ type: 'account_limits', sessionId: 's', stream: 'daemon', revision: 1, limits: [codex] });
  expect(footer(state)).toEqual(['Codex 5h 24% used']);
  const opening = inbound.openFrom(async () => ({ apply: () => {} }));
  receive({ type: 'account_limits', sessionId: 's', stream: 'daemon', revision: 2, limits: [] });
  expect(footer(state)).toEqual(['Codex 5h 24% used']);
  await opening;
  expect(footer(state)).toEqual([]);
  receive({ type: 'account_limits', sessionId: 's', stream: 'daemon', revision: 1, limits: [codex] });
  expect(footer(state)).toEqual([]);
  receive({ type: 'account_limits', sessionId: 'other', stream: 'daemon', revision: 3, limits: [codex] });
  expect(footer(state)).toEqual([]);
});

it('filters planner limits by the selected harness and model before any context is measured', () => {
  let state = initialState({ sessionId: 's', plannerProvider: 'opencode', orchestratorModel: 'opencode-go/kimi', accountLimits: [codex, go] });
  expect(footer(state)).toEqual(['OpenCode Go 5h 24% used']);
  state = reduce(state, { type: 'settingsLoaded', settings: { orchestratorModel: 'opencode/zen' } }).state;
  expect(footer(state)).toEqual([]);
  state = reduce(state, { type: 'settingsLoaded', settings: { aiProvider: 'codex' } }).state;
  expect(footer(state)).toEqual(['Codex 5h 24% used']);
  for (const plannerProvider of ['openrouter', 'openai', 'unknown']) expect(footer({ ...state, plannerProvider })).toEqual([]);
  for (const status of ['unknown', 'signed_out', 'unsupported', 'not_installed'] as const) {
    expect(footer({ ...state, accountLimits: [{ ...codex, status }] })).toEqual([]);
  }
  expect(footer({ ...state, accountLimits: [{ ...codex, status: 'stale' }] })).toEqual(['Codex 5h 24% used (stale)']);
  state = reduce(state, { type: 'sessionLoaded', sessionId: 'other', goal: 'New' }).state;
  expect(footer(state)).toEqual([]);
});

it('preserves historical attempt and task total accounting and attaches live limits once', () => {
  const attempt = (n: number, cost: number, prompt: number) => ({ attempt: n, runner: 'codex', startedAt: '', wallTimeMs: 0, totals: { reportedCost: { USD: cost } }, byModel: [], lastPromptTokens: prompt, contextWindow: 200000 });
  const state = initialState({
    sessionId: 's', accountLimits: [codex],
    tasks: [{ id: 't', order: 1, title: 'Work', type: 'ai', status: 'completed', dependencies: [], assignedRunner: 'codex', attemptUsage: [attempt(1, 1, 36000), attempt(2, 0.5, 100000)] }],
    taskView: { ...EMPTY_TASK_LOG_FOLLOW, taskId: 't', attempts: [1, 2], attempt: 1, followLatest: false, loaded: true, queuedIndex: null },
  });
  expect(footer(state)).toEqual(['attempt 1: ctx 36k (18%) · $1.00', 'task total: ctx 100k (50%) · Codex 5h 24% used · $1.50']);
  expect(render({ ...state, rows: 12, cols: 30 })).toHaveLength(12);
});

it('joins only the known parts around the limits when the context or the cost is missing, as VS Code does', () => {
  let planner = initialState({ sessionId: 's', plannerProvider: 'codex', accountLimits: [codex] });
  planner = reduce(planner, { type: 'sessionMessage', message: { type: 'planner_usage', totals: { reportedCost: { USD: 0.42 } }, byModel: [] } }).state;
  expect(footer(planner)).toEqual(['Codex 5h 24% used · $0.42']);

  const attempt = (n: number, totals: { reportedCost?: Record<string, number> }, prompt?: number) => ({ attempt: n, runner: 'codex', startedAt: '', wallTimeMs: 0, totals, byModel: [], ...(prompt ? { lastPromptTokens: prompt } : {}) });
  const task = (attemptUsage: ReturnType<typeof attempt>[], viewed: number) => initialState({
    sessionId: 's', accountLimits: [codex],
    tasks: [{ id: 't', order: 1, title: 'Work', type: 'ai', status: 'completed', dependencies: [], assignedRunner: 'codex', attemptUsage }],
    taskView: { ...EMPTY_TASK_LOG_FOLLOW, taskId: 't', attempts: attemptUsage.map((a) => a.attempt), attempt: viewed, followLatest: false, loaded: true, queuedIndex: null },
  });
  expect(footer(task([attempt(1, {}, 13000)], 1))).toEqual(['ctx 13k · Codex 5h 24% used']);
  expect(footer(task([attempt(1, { reportedCost: { USD: 0.42 } })], 1))).toEqual(['Codex 5h 24% used · $0.42']);
  expect(footer(task([attempt(1, { reportedCost: { USD: 0.5 } }), attempt(2, { reportedCost: { USD: 1 } })], 1)))
    .toEqual(['attempt 1: $0.50', 'Codex 5h 24% used · task total: $1.50']);
});
