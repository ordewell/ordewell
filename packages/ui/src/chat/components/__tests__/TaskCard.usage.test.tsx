import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import PlanCardGroup from '../PlanCardGroup';
import type { Task, AttemptUsage } from '@ordewell/core';
import { EMPTY_RUN } from '@ordewell/core/plan-utils';

const usage: AttemptUsage = { attempt: 1, runner: 'codex', startedAt: '', wallTimeMs: 5000, totals: { inputTokens: 12400, outputTokens: 3100, reportedCost: { USD: 0.42 } }, byModel: [{ source: 'codex', model: 'actual-model', totals: { inputTokens: 12400, outputTokens: 3100 } }], lastPromptTokens: 36000, contextWindow: 200000 };
const task = (over: Partial<Task> = {}): Task => ({ id: 't', order: 1, title: 'Work', description: '', type: 'ai', status: 'completed', dependencies: [], subtasks: [], assignedRunner: 'codex', ...over });

describe('task card usage', () => {
  it('shows the assigned runner and model without usage in a collapsed card header', () => {
    const { container } = render(<TaskCard task={task({ attemptUsage: [usage], assignedModel: { modelId: 'anthropic/claude-sonnet', modelLabel: 'Sonnet' } })} models={[]} />);
    expect(container.textContent).not.toMatch(/\$0\.42|ctx|12[,.]4/);
    expect(container.querySelector('.task-assignment')?.textContent).toBe('codex · Sonnet');
  });

  it('renders no usage on a subtask card', () => {
    const sub = task({ id: 'sub', attemptUsage: [usage] });
    const parent = task({ subtasks: [sub] });
    const { container } = render(<SubTaskCard task={sub} parentTask={parent} models={[]} />);
    expect(container.textContent).not.toMatch(/\$0\.42|ctx|12[,.]4/);
  });

  it('marks estimates and subscription equivalents in the plan total', () => {
    const estimate: AttemptUsage = { ...usage, runner: 'claude-code', totals: { reportedCost: { USD: 7.89 }, costProvenance: { USD: { kind: 'estimate', billing: 'subscription' } } } };
    const { container } = render(<PlanCardGroup run={EMPTY_RUN} tasks={[task({ attemptUsage: [estimate] })]} models={[]} />);
    expect(container.querySelector('.plan-usage')?.textContent).toBe('Tasks total: ≈$7.89 API-equivalent');
  });

  it('keeps the plan-wide Tasks total sum of all attempts', () => {
    const parent = task({ attemptUsage: [usage, { ...usage, attempt: 2 }] });
    const { container } = render(<PlanCardGroup run={EMPTY_RUN} tasks={[parent]} models={[]} />);
    expect(container.querySelector('.plan-usage')?.textContent).toBe('Tasks total: $0.84');
    expect(container.textContent).toContain('Tasks total');
  });
});
