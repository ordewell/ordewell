import { describe, it, expect } from 'vitest';
import { classifyTaskEdit, parseTaskDraft, removalPrompt } from '../taskEdit';
import { createTask, type Task } from '@ordewell/core';

function chain(): Task[] {
  return [
    createTask({ id: 'a', order: 1, title: 'Setup' }),
    createTask({ id: 'b', order: 2, title: 'Build', dependencies: ['a'] }),
    createTask({ id: 'c', order: 3, title: 'Test', dependencies: ['a', 'b'] }),
  ];
}

describe('classifyTaskEdit', () => {
  it('reads a runner change', () => {
    expect(classifyTaskEdit(JSON.stringify({ runner: 'codex' }))).toEqual({ kind: 'runner', runner: 'codex' });
  });

  it('reads a model assignment', () => {
    const payload = { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', thinkingEffort: 'high', availableVariants: ['low', 'high'] };

    expect(classifyTaskEdit(JSON.stringify(payload))).toEqual({
      kind: 'model',
      assignment: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', thinkingEffort: 'high', availableVariants: ['low', 'high'] },
    });
  });

  it('carries a cleared thinking effort rather than dropping the key', () => {
    const payload = { modelId: 'o3', modelLabel: 'o3', thinkingEffort: undefined, availableVariants: [] };

    const edit = classifyTaskEdit(JSON.stringify(payload));

    expect(edit).toEqual({ kind: 'model', assignment: { modelId: 'o3', modelLabel: 'o3', thinkingEffort: undefined, availableVariants: [] } });
  });

  it('reads a mode change', () => {
    expect(classifyTaskEdit(JSON.stringify({ mode: 'plan' }))).toEqual({ kind: 'mode', mode: 'plan' });
  });

  it('reads a prompt change', () => {
    expect(classifyTaskEdit(JSON.stringify({ prompt: 'rewrite it' }))).toEqual({ kind: 'prompt', prompt: 'rewrite it' });
  });

  it('treats an emptied prompt as a prompt change, not a removal', () => {
    expect(classifyTaskEdit(JSON.stringify({ prompt: '' }))).toEqual({ kind: 'prompt', prompt: '' });
  });

  it('treats an empty payload as a task removal', () => {
    expect(classifyTaskEdit('')).toEqual({ kind: 'remove' });
  });

  it('treats unparseable text as a removal rather than guessing an edit', () => {
    expect(classifyTaskEdit('{not json')).toEqual({ kind: 'remove' });
  });

  it('does not mistake an empty mode for a task removal', () => {
    // A truthiness check on `mode` sent this down the remove-task branch, which
    // pops a destructive confirm for what was only a mode reset.
    expect(classifyTaskEdit(JSON.stringify({ mode: '' }))).toEqual({ kind: 'mode', mode: '' });
  });

  it('does not mistake an empty runner for a task removal', () => {
    expect(classifyTaskEdit(JSON.stringify({ runner: '' }))).toEqual({ kind: 'runner', runner: '' });
  });

  it('prefers the runner when a payload names both a runner and a model', () => {
    // The runner retarget derives its own model, so honouring the stale model
    // alongside it would immediately contradict the switch.
    const edit = classifyTaskEdit(JSON.stringify({ runner: 'codex', modelId: 'claude-sonnet-4-5', modelLabel: 'Claude' }));

    expect(edit).toEqual({ kind: 'runner', runner: 'codex' });
  });

  it('reads a dependency list', () => {
    expect(classifyTaskEdit(JSON.stringify({ dependencies: ['a', 'b'] }))).toEqual({
      kind: 'dependencies', dependencies: ['a', 'b'],
    });
  });

  it('does not mistake a cleared dependency list for a task removal', () => {
    expect(classifyTaskEdit(JSON.stringify({ dependencies: [] }))).toEqual({ kind: 'dependencies', dependencies: [] });
  });
});

describe('removalPrompt', () => {
  it('names the task', () => {
    expect(removalPrompt(chain(), 'c')).toBe('Remove "Test"?');
  });

  it('names the dependents that will silently lose the edge', () => {
    const prompt = removalPrompt(chain(), 'a');

    expect(prompt).toContain('Remove "Setup"?');
    expect(prompt).toContain('2 tasks depend on it');
    expect(prompt).toContain('#2 Build');
    expect(prompt).toContain('#3 Test');
  });

  it('agrees in number for a single dependent', () => {
    expect(removalPrompt(chain(), 'b')).toContain('1 task depends on it');
  });

  it('finds a subtask, whose dependents live in the same flattened graph', () => {
    const tasks = chain();
    tasks[0].subtasks = [createTask({ id: 'a1', order: 1, title: 'Nested' })];

    expect(removalPrompt(tasks, 'a1')).toBe('Remove "Nested"?');
  });

  it('stays answerable when the id is already gone', () => {
    expect(removalPrompt(chain(), 'ghost')).toBe('Remove this task?');
  });
});

describe('parseTaskDraft', () => {
  it('reads a filled-in form', () => {
    const draft = parseTaskDraft(JSON.stringify({
      title: 'Write docs',
      prompt: 'do it',
      assignedRunner: 'codex',
      assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex' },
      taskMode: 'agent',
      dependencies: ['a'],
    }));

    expect(draft).toEqual({
      title: 'Write docs',
      description: 'Write docs',
      prompt: 'do it',
      type: 'ai',
      dependencies: ['a'],
      assignedRunner: 'codex',
      assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex' },
      taskMode: 'agent',
    });
  });

  it('leaves the assignment unset so the session derives it', () => {
    const draft = parseTaskDraft(JSON.stringify({ title: 'Write docs' }));

    expect(draft).toMatchObject({ prompt: 'Write docs', dependencies: [] });
    expect(draft!.assignedRunner).toBeUndefined();
    expect(draft!.assignedModel).toBeUndefined();
    expect(draft!.taskMode).toBeUndefined();
  });

  it('refuses a draft with no usable title, rather than adding a nameless task', () => {
    expect(parseTaskDraft(JSON.stringify({ title: '   ' }))).toBeNull();
    expect(parseTaskDraft(JSON.stringify({ prompt: 'orphan' }))).toBeNull();
    expect(parseTaskDraft('')).toBeNull();
    expect(parseTaskDraft('{not json')).toBeNull();
  });

  it('never lets a caller inject system-owned fields', () => {
    const draft = parseTaskDraft(JSON.stringify({ title: 'X', id: 'hijack', status: 'completed', verdict: {} }));

    expect(draft).not.toHaveProperty('id');
    expect(draft).not.toHaveProperty('status');
    expect(draft).not.toHaveProperty('verdict');
  });
});
