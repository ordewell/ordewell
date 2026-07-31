import { describe, it, expect } from 'vitest';
import { retargetTaskRunner, runnerAssignment } from '../TaskRetarget';
import { createTask } from '../../models/Task';
import type { Task } from '../../models/Task';

const CODEX_MODELS = [
  { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
  { modelId: 'o3', modelLabel: 'o3', variants: [] },
];
const CODEX_MODES = [
  { id: 'agent', label: 'Agent', description: 'Edit files' },
  { id: 'plan', label: 'Plan', description: 'Read only' },
];

function claudeTask(overrides: Partial<Task> = {}): Task {
  return createTask({
    title: 'Refactor PlanStore',
    assignedRunner: 'claude-code',
    assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', thinkingEffort: 'adaptive', availableVariants: ['adaptive', 'low', 'high'] },
    taskMode: 'acceptEdits',
    ...overrides,
  });
}

describe('retargetTaskRunner', () => {
  it('reassigns model, effort and mode to the new runner catalog', () => {
    const changes = retargetTaskRunner(claudeTask(), 'codex', { models: CODEX_MODELS, modes: CODEX_MODES });

    expect(changes.assignedRunner).toBe('codex');
    expect(changes.assignedModel).toEqual({
      modelId: 'gpt-5-codex',
      modelLabel: 'GPT-5 Codex',
      // 'adaptive' is Claude-only; the ladder maps it to medium, then down to
      // the nearest rung Codex offers rather than discarding the intent.
      thinkingEffort: 'low',
      availableVariants: ['low', 'high'],
    });
    expect(changes.taskMode).toBe('agent');
  });

  it('keeps a model the new runner also offers, and keeps its effort', () => {
    const shared = claudeTask({
      assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', thinkingEffort: 'high', availableVariants: ['low', 'high'] },
    });

    const changes = retargetTaskRunner(shared, 'codex', { models: CODEX_MODELS, modes: CODEX_MODES });

    expect(changes.assignedModel).toEqual({
      modelId: 'gpt-5-codex',
      modelLabel: 'GPT-5 Codex',
      thinkingEffort: 'high',
      availableVariants: ['low', 'high'],
    });
  });

  it('keeps a mode the new runner also offers instead of snapping to its first', () => {
    const changes = retargetTaskRunner(claudeTask({ taskMode: 'plan' }), 'codex', { models: CODEX_MODELS, modes: CODEX_MODES });

    expect(changes.taskMode).toBe('plan');
  });

  it('clamps an effort the new model does not offer to the nearest rung it does', () => {
    const task = claudeTask({
      assignedModel: { modelId: 'x', modelLabel: 'X', thinkingEffort: 'xhigh', availableVariants: ['xhigh'] },
    });

    const changes = retargetTaskRunner(task, 'codex', { models: CODEX_MODELS, modes: CODEX_MODES });

    // Picks codex's preferred model, whose ladder tops out at 'high'.
    expect(changes.assignedModel?.thinkingEffort).toBe('high');
  });

  it('drops the effort when the new model offers no variants at all', () => {
    const changes = retargetTaskRunner(claudeTask(), 'opencode', {
      models: [{ modelId: 'zen/kimi', modelLabel: 'Kimi', variants: [] }],
      modes: [{ id: 'build', label: 'Build', description: '' }],
    });

    expect(changes.assignedModel).toEqual({
      modelId: 'zen/kimi',
      modelLabel: 'Kimi',
      thinkingEffort: undefined,
      availableVariants: [],
    });
  });

  it('mirrors the clamped effort onto the legacy top-level field', () => {
    const task = claudeTask({ thinkingEffort: 'adaptive' });

    const changes = retargetTaskRunner(task, 'codex', { models: CODEX_MODELS, modes: CODEX_MODES });

    expect(changes.thinkingEffort).toBe(changes.assignedModel?.thinkingEffort);
  });

  it('omits the model assignment when the new runner catalog is empty', () => {
    const changes = retargetTaskRunner(claudeTask(), 'aider', { models: [], modes: CODEX_MODES });

    expect(changes.assignedRunner).toBe('aider');
    expect(changes.taskMode).toBe('agent');
    expect('assignedModel' in changes).toBe(false);
  });

  it('omits the mode when the new runner declares no modes', () => {
    const changes = retargetTaskRunner(claudeTask(), 'aider', { models: CODEX_MODELS, modes: [] });

    expect('taskMode' in changes).toBe(false);
  });

  it('does not touch manual tasks', () => {
    const manual = createTask({ title: 'Rotate the API key', type: 'user', assignedRunner: 'claude-code', taskMode: 'acceptEdits' });

    const changes = retargetTaskRunner(manual, 'codex', { models: CODEX_MODELS, modes: CODEX_MODES });

    expect(changes).toEqual({});
  });

  it('is a no-op when the task is already on that runner', () => {
    const task = claudeTask({ assignedRunner: 'codex', assignedModel: { modelId: 'o3', modelLabel: 'o3' }, taskMode: 'plan' });

    const changes = retargetTaskRunner(task, 'codex', { models: CODEX_MODELS, modes: CODEX_MODES });

    expect(changes).toEqual({});
  });
});

describe('runnerAssignment', () => {
  it('gives a task with no assignment yet the runner preferred model and mode', () => {
    // Discovery sorts models by the manifest's preferredPatterns and modes[0] is
    // the manifest's own first choice, so "first" is the runner's opinion.
    const changes = runnerAssignment({ models: CODEX_MODELS, modes: CODEX_MODES });

    expect(changes.assignedModel).toEqual({
      modelId: 'gpt-5-codex',
      modelLabel: 'GPT-5 Codex',
      thinkingEffort: undefined,
      availableVariants: ['low', 'high'],
    });
    expect(changes.taskMode).toBe('agent');
  });

  it('keeps a model the caller already chose when the runner offers it', () => {
    const changes = runnerAssignment(
      { models: CODEX_MODELS, modes: CODEX_MODES },
      { assignedModel: { modelId: 'o3', modelLabel: 'o3' }, taskMode: 'plan' },
    );

    expect(changes.assignedModel!.modelId).toBe('o3');
    expect(changes.taskMode).toBe('plan');
  });

  it('assigns nothing at all when discovery came back empty', () => {
    expect(runnerAssignment({ models: [], modes: [] })).toEqual({});
  });

  it('mirrors the derived effort onto the legacy top-level field', () => {
    const changes = runnerAssignment(
      { models: CODEX_MODELS, modes: CODEX_MODES },
      { assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', thinkingEffort: 'high' }, taskMode: undefined },
    );

    expect(changes.thinkingEffort).toBe('high');
    expect(changes.assignedModel!.thinkingEffort).toBe('high');
  });
});
