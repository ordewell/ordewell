import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { TaskView, TuiState } from '../state';
import { runHint } from '../layout';
import { lastMessage } from './chat';

function task(over: Partial<TaskView> = {}): TaskView {
  return { id: 't1', order: 1, title: 'Add multiply', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code', ...over };
}

function running(): TuiState {
  return initialState({
    sessionId: 's1',
    status: 'executing',
    tasks: [task(), task({ id: 't2', title: 'Add reverse', assignedRunner: 'opencode' })],
  });
}

describe('what the plan pane says the run waits on', () => {
  it('logs a started task as a settled line, never a pending research step', () => {
    const { state } = reduce(running(), { type: 'taskStarted', taskId: 't1', title: 'Add multiply', runner: 'claude-code', sessionId: 's1' });

    expect(state.conversation.blocks.some((b) => b.type === 'tool')).toBe(false);
    expect(lastMessage(state)).toMatchObject({ role: 'system', text: 'Started "Add multiply" · Claude Code' });
  });

  it('names nothing while tasks are only running', () => {
    let { state } = reduce(running(), { type: 'taskStarted', taskId: 't1', title: 'Add multiply', runner: 'claude-code', sessionId: 's1' });
    ({ state } = reduce(state, { type: 'taskStarted', taskId: 't2', title: 'Add reverse', runner: 'opencode', sessionId: 's1' }));

    expect(runHint(state)).toBe('');
  });

  it('says the run is waiting on the user when a conflicted task is left', () => {
    const { state } = reduce(running(), { type: 'statusUpdate', tasks: [{ id: 't1', status: 'completed', verdict: null }, { id: 't2', status: 'awaiting_user', verdict: null }], sessionId: 's1' });

    expect(runHint(state)).toBe('1 task waits for you');
  });

  it('counts the tasks that wait', () => {
    const state = initialState({ tasks: [task({ status: 'awaiting_user' }), task({ id: 't2', status: 'awaiting_user' })] });

    expect(runHint(state)).toBe('2 tasks wait for you');
  });
});

describe('the run across a plan refresh mid-run', () => {
  it('stays executing when the plan arrives after the run snapshot, as a /load has it', () => {
    let { state } = reduce(running(), { type: 'taskStarted', taskId: 't1', title: 'Add multiply', runner: 'claude-code', sessionId: 's1' });
    const plan = { tasks: [task({ status: 'in_progress' }), task({ id: 't2', title: 'Add reverse', assignedRunner: 'opencode' })] };
    ({ state } = reduce(state, { type: 'planUpdated', plan, sessionId: 's1' }));

    expect(state.status).toBe('executing');
    expect(runHint(state)).toBe('');
  });
});
