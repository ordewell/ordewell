import { describe, it, expect } from 'vitest';
import { planLayout, revealOffset } from '../layout';
import { initialState, type TaskView } from '../state';
import { reduce, type Action } from '../reducer';
import { createInbound } from '../inbound';
import type { WsEvent } from '../../apiClient';
import { stripAnsi } from '../ansi';
import type { AttemptUsage } from '@ordewell/core';

const usage: AttemptUsage = { attempt: 1, runner: 'codex', startedAt: '', wallTimeMs: 5000, totals: { inputTokens: 12400, outputTokens: 3100, reportedCost: { USD: 0.42 } }, byModel: [{ source: 'codex', model: 'actual-model', totals: { inputTokens: 12400 } }], lastPromptTokens: 36000, contextWindow: 200000 };
const TOTAL = 'Tasks total: $0.42';
const task = (over: Partial<TaskView> = {}): TaskView => ({ id: 't', order: 1, title: 'Work', type: 'ai', status: 'completed', dependencies: [], ...over });
const lines = (tasks: TaskView[]) => planLayout(initialState({ tasks, rows: 40, cols: 140 }), 40, 140).lines.map(stripAnsi).join('\n');

const expandedLines = (t: TaskView) => {
  const state = { ...initialState({ tasks: [t], rows: 40, cols: 140 }), expandedTaskId: t.id };
  return planLayout(state, 40, 140).lines.map(stripAnsi).join('\n');
};

describe('task row accounting', () => {
  it('keeps the plan total at the top and no usage on the row, collapsed or expanded', () => {
    const t = task({ attemptUsage: [usage] });
    const collapsed = lines([t]);
    expect(collapsed.split('\n')).toContain(TOTAL);
    expect(collapsed.replace(TOTAL, '')).not.toMatch(/12\.4k|ctx /);
    expect(expandedLines(t).replace(TOTAL, '')).not.toMatch(/12\.4k|ctx |actual-model: /);
  });

  it('keeps skills, effort and mode off a collapsed row and shows them expanded', () => {
    const t = task({ type: 'ai', skills: ['tdd'], taskMode: 'plan', assignedModel: { modelId: 'm', modelLabel: 'M', thinkingEffort: 'high' } });
    const collapsed = lines([t]);
    for (const hidden of ['skills:', 'effort:', 'mode:']) expect(collapsed).not.toContain(hidden);
    const expanded = expandedLines(t);
    expect(expanded).toContain('skills: tdd');
    expect(expanded).toContain('effort: high · mode: plan');
  });

  it('carries live usage from the daemon into the row even when status stays the same', () => {
    const actions: Action[] = [];
    const receive = createInbound((action) => actions.push(action), 's1').receive;
    const wire: unknown = { type: 'status_update', tasks: [{ id: 't', status: 'completed', verdict: null, attemptUsage: [usage] }] };
    receive(wire as WsEvent);
    const update = actions.find((a): a is Extract<Action, { type: 'statusUpdate' }> => a.type === 'statusUpdate');
    const state = initialState({ sessionId: 's1', tasks: [task()] });
    const updated = reduce(state, update!).state;
    expect(updated.tasks[0].attemptUsage).toEqual([usage]);
    expect(lines(updated.tasks).split('\n')).toContain(TOTAL);
  });

  it('applies nested usage updates without needing a status change', () => {
    const state = initialState({ tasks: [task({ id: 'parent', subtasks: [task()] })] });
    const updated = reduce(state, { type: 'statusUpdate', tasks: [{ id: 't', status: 'completed', verdict: null, attemptUsage: [usage] }] }).state;
    expect(updated.tasks[0].subtasks?.[0].attemptUsage).toEqual([usage]);
    expect(lines(updated.tasks)).toContain(TOTAL);
  });

  it('keeps usage and unmerged landings from the same status update visible', () => {
    const actions: Action[] = [];
    const receive = createInbound((action) => actions.push(action), 's1').receive;
    receive({
      type: 'status_update',
      tasks: [{ id: 't', status: 'completed', verdict: null, attemptUsage: [usage] }],
      runMerge: {
        waitingAtGate: false, paused: false, repos: [],
        landed: [{ taskId: 't', order: 1, title: 'Work' }],
      },
    });
    const update = actions.find((a): a is Extract<Action, { type: 'statusUpdate' }> => a.type === 'statusUpdate');
    const state = initialState({ sessionId: 's1', tasks: [task({ id: 'parent', subtasks: [task()] })] });
    const updated = reduce(state, update!).state;
    const layout = planLayout(updated, 4, 140);
    const text = layout.lines.map(stripAnsi).join('\n');

    expect(updated.tasks[0].subtasks?.[0].attemptUsage).toEqual([usage]);
    expect(updated.runMerge?.handoff.landed).toEqual([{ taskId: 't', order: 1, title: 'Work' }]);
    expect(text.split('\n')).toContain(TOTAL);
    expect(text).toContain('1 landed task not merged: /merge');
    expect(layout.rowSpans[0].start).toBe(3);
    const at = revealOffset(layout, layout.maxScroll, layout.rowSpans[0]);
    expect(layout.rowSpans[0].start).toBeGreaterThan(at);
    expect(layout.rowSpans[0].end).toBeLessThanOrEqual(at + layout.rows - 1);

    const cleared = reduce(updated, { type: 'statusUpdate', tasks: [] }).state;
    const clearedText = planLayout(cleared, 40, 140).lines.map(stripAnsi).join('\n');
    expect(clearedText).not.toContain('landed task');
    expect(clearedText.split('\n')).toContain(TOTAL);
  });
});

describe('the plan total', () => {
  it('marks a subscription estimate in the plan total', () => {
    const estimate: AttemptUsage = { ...usage, runner: 'claude-code', totals: { reportedCost: { USD: 7.89 }, costProvenance: { USD: { kind: 'estimate', billing: 'subscription' } } } };
    expect(lines([task({ attemptUsage: [estimate] })]).split('\n')).toContain('Tasks total: ≈$7.89 API-equivalent');
  });

  it('names the runner whose attempts reported no cost, beside the cost of the others', () => {
    const free: AttemptUsage = { ...usage, runner: 'codex', totals: { inputTokens: 5000 }, endedAt: '2026-10-19T10:00:05Z' };
    const paid: AttemptUsage = { ...usage, runner: 'claude-code' };
    expect(lines([task({ attemptUsage: [paid] }), task({ id: 'u', attemptUsage: [free] })]).split('\n')).toContain('Tasks total: $0.42 · codex reports no cost');
  });
});

describe('task row model name', () => {
  const running = (byModel: AttemptUsage['byModel'], over: Partial<TaskView> = {}) =>
    task({ status: 'running', assignedModel: { modelLabel: 'Sonnet 5.5' } as TaskView['assignedModel'], attemptUsage: [{ ...usage, byModel }], ...over });

  it('names the plan\'s assignment before usage reports anything', () => {
    const text = lines([running([])]);
    expect(text).toContain('Sonnet 5.5');
    expect(text).not.toContain('model unknown');
  });

  it('keeps the plan\'s assignment when usage reports another model', () => {
    const text = lines([running([{ source: 'claude-code', model: 'claude-sonnet-x', totals: { inputTokens: 1 } }])]);
    expect(text).toContain('Sonnet 5.5');
    expect(text).not.toContain('claude-sonnet-x');
  });
});
