import { describe, it, expect } from 'vitest';
import { addAttemptUsage, startAttemptUsage, endAttemptUsage, planUsage, modelCostTitle, usageLine, isMeasured, addPlannerUsage, taskUsageSummary } from '../Usage';
import { createTask, keepExecutionState, type Task } from '../Task';
import { PlanStore } from '../../services/PlanStore';

const start = '2026-10-11T10:00:00Z';
const end = '2026-10-11T10:00:05Z';

describe('attempt usage', () => {
  it('folds calls and subagents exactly once, retaining the models and currencies', () => {
    let usage = startAttemptUsage(1, 'codex', start);
    usage = addAttemptUsage(usage, { source: 'codex', model: 'a', inputTokens: 10, outputTokens: 2, reportedCost: { amount: 1, currency: 'USD' } }, end);
    usage = addAttemptUsage(usage, { source: 'codex', model: 'b', inputTokens: 20, reportedCost: { amount: 2, currency: 'EUR' }, subagentId: 'child' }, end);
    expect(usage.totals).toEqual({ inputTokens: 30, outputTokens: 2, reportedCost: { USD: 1, EUR: 2 } });
    expect(usage.byModel).toEqual([
      { source: 'codex', model: 'a', totals: { inputTokens: 10, outputTokens: 2, reportedCost: { USD: 1 } } },
      { source: 'codex', model: 'b', totals: { inputTokens: 20, reportedCost: { EUR: 2 } } },
    ]);
    expect(usage.wallTimeMs).toBe(5000);
    expect(usage.bySubagent?.child.inputTokens).toBe(20);
  });

  it('counts a call made outside the agent\'s turns in the totals on a row of its own, without moving the context meter', () => {
    let usage = startAttemptUsage(1, 'opencode', start);
    usage = addAttemptUsage(usage, { source: 'opencode', model: 'p/big', inputTokens: 500, outputTokens: 20, contextWindow: 1000, reportedCost: { amount: 0.5, currency: 'USD' } }, end);
    usage = addAttemptUsage(usage, { source: 'opencode', aggregate: true, purpose: 'title', inputTokens: 9000, outputTokens: 12, reportedCost: { amount: 0.25, currency: 'USD' } }, end);
    usage = addAttemptUsage(usage, { source: 'opencode', aggregate: true, purpose: 'title', inputTokens: 1000, reportedCost: { amount: 0.25, currency: 'USD' } }, end);
    expect(usage.totals).toEqual({ inputTokens: 10_500, outputTokens: 32, reportedCost: { USD: 1 } });
    expect(usage.byModel).toEqual([
      { source: 'opencode', model: 'p/big', totals: { inputTokens: 500, outputTokens: 20, reportedCost: { USD: 0.5 } } },
      { source: 'opencode', purpose: 'title', totals: { inputTokens: 10_000, outputTokens: 12, reportedCost: { USD: 0.5 } } },
    ]);
    expect(usageLine(usage).contextFill).toEqual({ usedTokens: 500, windowTokens: 1000 });
    expect(modelCostTitle(usage.byModel ?? [])).toBe('opencode / p/big: $0.50\nopencode / unattributed (title): $0.50');

    const other = addAttemptUsage(startAttemptUsage(2, 'opencode', start), { source: 'opencode', aggregate: true, purpose: 'title', inputTokens: 5 }, end);
    const total = planUsage([createTask({ attemptUsage: [usage, other] })]);
    expect(total.byModel.find((m) => m.purpose === 'title')?.totals).toEqual({ inputTokens: 10_005, outputTokens: 12, reportedCost: { USD: 0.5 } });
    expect(total.byModel).toHaveLength(2);
  });

  it('clears the old context on a model switch, including switches back to a previous model', () => {
    let usage = startAttemptUsage(1, 'codex', start);
    usage = addAttemptUsage(usage, { source: 'codex', model: 'a', inputTokens: 80, contextWindow: 100 }, end);
    expect(usageLine(usage).contextFill).toEqual({ usedTokens: 80, windowTokens: 100 });
    usage = addAttemptUsage(usage, { source: 'codex', model: 'b', outputTokens: 5 }, end);
    expect(usageLine(usage).contextFill).toBeUndefined();
    expect(usage.byModel?.[1].totals).toEqual({ outputTokens: 5 });
    usage = addAttemptUsage(usage, { source: 'codex', model: 'b', inputTokens: 10, contextWindow: 200 }, end);
    expect(usageLine(usage).contextFill).toEqual({ usedTokens: 10, windowTokens: 200 });
    usage = addAttemptUsage(usage, { source: 'codex', model: 'a', outputTokens: 1 }, end);
    expect(usageLine(usage).contextFill).toBeUndefined();
  });

  it('clears context for a cost-only call on a new model, but ignores session breakdowns for context', () => {
    const first = addAttemptUsage(startAttemptUsage(1, 'runner', start), { source: 'runner', model: 'a', inputTokens: 80, contextWindow: 100 }, end);
    const breakdown = addAttemptUsage(first, { source: 'runner', model: 'b', aggregate: true, reportedCost: { amount: 1, currency: 'USD' } }, end);
    expect(usageLine(breakdown).contextFill).toEqual({ usedTokens: 80, windowTokens: 100 });
    const switched = addAttemptUsage(first, { source: 'runner', model: 'b', reportedCost: { amount: 1, currency: 'USD' } }, end);
    expect(usageLine(switched).contextFill).toBeUndefined();
    expect(switched.model).toBe('b');
    expect(switched.byModel?.[1].totals).toEqual({ reportedCost: { USD: 1 } });
  });

  it('keeps unknown measures absent and a reported zero measured', () => {
    const usage = endAttemptUsage(startAttemptUsage(1, 'other', start), end);
    expect(usage.totals).toEqual({});
    expect(isMeasured(usage.totals)).toBe(false);
    expect(usage.byModel).toEqual([]);
    const zero = addAttemptUsage(usage, { source: 'other', outputTokens: 0 }, end);
    expect(isMeasured(zero.totals)).toBe(true);
    expect(zero.byModel?.[0].model).toBeUndefined();
    expect(zero.totals.inputTokens).toBeUndefined();
  });

  it('rolls up every attempt, including subtasks, without adding subagent shares twice', () => {
    const first = addAttemptUsage(startAttemptUsage(1, 'codex', start), { source: 'codex', model: 'a', inputTokens: 10, subagentId: 'child' }, end);
    const second = addAttemptUsage(startAttemptUsage(2, 'codex', start), { source: 'codex', model: 'b', outputTokens: 5 }, end);
    const child = addAttemptUsage(startAttemptUsage(1, 'codex', start), { source: 'codex', model: 'a', inputTokens: 20 }, end);
    const tasks = [createTask({ attemptUsage: [first, second], subtasks: [createTask({ attemptUsage: [child] })] })];
    const total = planUsage(tasks);
    expect(total.totals).toEqual({ inputTokens: 30, outputTokens: 5 });
    expect(total.attempts).toBe(3);
    expect(total.wallTimeMs).toBe(15000);
    expect(total.byModel).toHaveLength(2);
    expect(total.byModel.find((m) => m.model === 'a')?.totals).toEqual({ inputTokens: 30 });
  });

  it('detaches persisted snapshots and preserves execution usage across planner rewrites', () => {
    const store = new PlanStore();
    const task = createTask({ id: 'task' });
    store.load([task], ['claude-code']);
    store.startAttemptUsage(task.id, 1, 'claude-code', start);
    const saved = store.snapshot();
    store.recordAttemptUsage(task.id, 1, { source: 'claude-code', model: 'a', inputTokens: 10 }, end);
    expect(saved[0].attemptUsage?.[0].totals).toEqual({});
    const updated = store.snapshot();
    const rewritten = keepExecutionState(updated, [createTask({ id: 'task', title: 'Edited' })]);
    expect(rewritten[0].attemptUsage).toEqual(updated[0].attemptUsage);
  });

  it('keeps a billing fact and cost provenance through a save and a reload', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'task' })], ['claude-code']);
    store.startAttemptUsage('task', 1, 'claude-code', start);
    store.recordAttemptUsage('task', 1, {
      source: 'claude-code', model: 'opus', inputTokens: 10,
      sessionBilling: { type: 'subscription', plan: 'max' },
      reportedCost: { amount: 1, currency: 'USD', kind: 'estimate', basis: 'list' },
    }, end);
    const saved = JSON.parse(JSON.stringify(store.snapshot())) as Task[];
    const reloaded = new PlanStore();
    reloaded.load(saved, ['claude-code']);

    const [usage] = reloaded.get('task')!.attemptUsage!;
    expect(usage.sessionBilling).toEqual({ type: 'subscription', plan: 'max' });
    expect(usage.totals.costProvenance).toEqual({ USD: { kind: 'estimate', billing: 'subscription', basis: 'list' } });
  });

  it('applies the same model attribution and context reset to planner usage', () => {
    const first = addPlannerUsage({ totals: {} }, { source: 'openai', model: 'a', inputTokens: 10, contextWindow: 100 });
    const switched = addPlannerUsage(first, { source: 'openai', model: 'b', outputTokens: 2 });
    expect(usageLine(switched).contextFill).toBeUndefined();
    expect(switched.byModel).toHaveLength(2);
    const subagent = addPlannerUsage(first, { source: 'openai', model: 'b', inputTokens: 20, contextWindow: 200, subagentId: 'child' });
    expect(usageLine(subagent).contextFill).toEqual({ usedTokens: 10, windowTokens: 100 });
  });

  it('sums a task across every attempt and model while the meter follows the latest attempt', () => {
    const first = addAttemptUsage(startAttemptUsage(1, 'claude-code', start), { source: 'claude-code', model: 'opus', inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, reportedCost: { amount: 1.5, currency: 'USD' }, contextWindow: 1000 }, end);
    const second = addAttemptUsage(startAttemptUsage(2, 'claude-code', start), { source: 'claude-code', model: 'sonnet', inputTokens: 50, outputTokens: 5, reportedCost: { amount: 0.25, currency: 'USD' }, contextWindow: 200 }, end);
    const summary = taskUsageSummary(createTask({ attemptUsage: [first, second] }));
    expect(summary.totals).toEqual({ inputTokens: 150, outputTokens: 15, cachedInputTokens: 40, reportedCost: { USD: 1.75 } });
    expect(summary.contextFill).toEqual({ usedTokens: 50, windowTokens: 200 });
    expect(summary.attempts).toBe(2);
  });

  it('reads a task with no attempts as nothing reported, and keeps an unreported cost absent', () => {
    expect(taskUsageSummary(createTask({}))).toEqual({ totals: {}, attempts: 0 });
    const noCost = addAttemptUsage(startAttemptUsage(1, 'codex', start), { source: 'codex', inputTokens: 3 }, end);
    expect(taskUsageSummary(createTask({ attemptUsage: [noCost] })).totals.reportedCost).toBeUndefined();
  });
});
