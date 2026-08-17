import { describe, it, expect, beforeAll } from 'vitest';
import { render } from '../render';
import { style } from '../ansi';
import { initialState, type ModeView, type TaskView, type TuiState } from '../state';

beforeAll(() => {
  style.enabled = false;
});

const screen = (over: Partial<TuiState> = {}): string[] =>
  render(initialState({ rows: 24, cols: 160, focus: 'plan', ...over }));

const text = (over: Partial<TuiState> = {}): string => screen(over).join('\n');

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Ship the fix', type: 'ai', status: 'pending',
  dependencies: [], assignedRunner: 'claude-code', taskMode: 'bypassPermissions', ...over,
});

const modes: Record<string, ModeView[]> = {
  'claude-code': [
    { id: 'default', label: 'Ask before edits' },
    { id: 'bypassPermissions', label: 'Auto mode', autonomous: true },
  ],
};

describe('plan pane — autonomous task marking', () => {
  it('marks a task whose resolved mode is tagged autonomous in the manifest', () => {
    const out = text({ tasks: [task()], modesByRunner: modes });
    expect(out).toContain('mode: bypassPermissions ⚡');
  });

  it('names the setting that controls autonomy once the task is expanded', () => {
    const out = text({ tasks: [task()], modesByRunner: modes, expandedTaskId: 't1' });
    expect(out).toContain('Autonomy');
    expect(out).toContain('/auto');
  });

  it('shows no marking for a task whose mode carries no autonomous tag', () => {
    const out = text({ tasks: [task({ taskMode: 'default' })], modesByRunner: modes, expandedTaskId: 't1' });
    expect(out).not.toContain('⚡');
    expect(out).not.toContain('Autonomy');
  });

  it('shows no marking when the manifest is not loaded yet (no tag data available)', () => {
    const out = text({ tasks: [task()], modesByRunner: {}, expandedTaskId: 't1' });
    expect(out).not.toContain('⚡');
    expect(out).not.toContain('Autonomy');
  });

  it('never marks a manual task, even if its taskMode string collides with an autonomous id elsewhere', () => {
    const out = text({
      tasks: [task({ type: 'user', taskMode: 'bypassPermissions' })],
      modesByRunner: modes,
      expandedTaskId: 't1',
    });
    expect(out).not.toContain('⚡');
    expect(out).not.toContain('Autonomy');
  });
});
