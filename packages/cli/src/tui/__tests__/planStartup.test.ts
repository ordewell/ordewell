import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { TaskView, TuiState } from '../state';

/**
 * A whole-plan start is asynchronous in the daemon, so the TUI shows it at
 * once and then follows the run's own activity — never calling a start
 * "executing" before anything claims, and never leaving a spinner behind.
 */

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 'task-1', order: 1, title: 'Do the thing', type: 'ai', status: 'pending', dependencies: [], ...over,
});

const planned: Partial<TuiState> = { sessionId: 's1', tasks: [task()] };
const activity = (over: Partial<Record<'starting' | 'running' | 'scheduled' | 'resumable' | 'advancesOnItsOwn', boolean>> = {}) => ({
  starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false, ...over,
});

const planKey = () => reduce(initialState({ ...planned, focus: 'plan' }), { type: 'key', key: { name: 'char', char: 'E' } });

const slash = (text: string) => {
  const base = initialState({ ...planned, focus: 'chat' });
  return reduce({ ...base, editor: { ...base.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } });
};

describe('a whole-plan start in the TUI', () => {
  it('E and /run both say starting at once and start the run once', () => {
    const byKey = planKey();
    const byCommand = slash('/run');

    expect(byKey.effects).toEqual([{ type: 'execute', sessionId: 's1' }]);
    expect(byCommand.effects).toEqual([{ type: 'execute', sessionId: 's1' }]);
    expect(byKey.state.status).toBe('starting');
    expect(byCommand.state.status).toBe('starting');
  });

  it('a second E while the start is under way is not another run', () => {
    const once = planKey();
    const twice = reduce(once.state, { type: 'key', key: { name: 'char', char: 'E' } });

    expect(twice.effects).toEqual([]);
    expect(twice.state.status).toBe('starting');
  });

  it('a run already executing still takes E and /run as its join, without saying starting', () => {
    const running: TuiState = { ...initialState({ ...planned, focus: 'plan' }), status: 'executing' };

    const byKey = reduce(running, { type: 'key', key: { name: 'char', char: 'E' } });
    const base = initialState({ ...planned, focus: 'chat' });
    const byCommand = reduce(
      { ...base, status: 'executing', editor: { ...base.editor, text: '/run', cursor: 4 } },
      { type: 'key', key: { name: 'enter' } },
    );

    expect(byKey.effects).toEqual([{ type: 'execute', sessionId: 's1' }]);
    expect(byCommand.effects).toEqual([{ type: 'execute', sessionId: 's1' }]);
    expect(byKey.state.status).toBe('executing');
    expect(byCommand.state.status).toBe('executing');
  });

  it('follows the run\'s activity from starting to executing to idle', () => {
    const starting = reduce(planKey().state, {
      type: 'runMessage',
      message: { type: 'status_update', tasks: [], activity: activity({ starting: true, scheduled: true }) },
      sessionId: 's1',
    });
    expect(starting.state.status).toBe('starting');

    const running = reduce(starting.state, {
      type: 'runMessage',
      message: {
        type: 'status_update',
        tasks: [{ id: 'task-1', status: 'in_progress', verdict: null }],
        activity: activity({ running: true, scheduled: true }),
      },
      sessionId: 's1',
    });
    expect(running.state.status).toBe('executing');

    const finished = reduce(running.state, {
      type: 'runMessage',
      message: { type: 'status_update', tasks: [{ id: 'task-1', status: 'completed', verdict: null }], activity: activity() },
      sessionId: 's1',
    });
    expect(finished.state.status).toBe('idle');
  });

  it('settles the start when the daemon refuses it', () => {
    const failed = reduce(planKey().state, { type: 'failed', message: 'Could not start: every task completed.' });

    expect(failed.state.status).toBe('idle');
  });

  it('drops the start when another session is adopted', () => {
    const loaded = reduce(planKey().state, { type: 'sessionLoaded', sessionId: 's2', goal: 'other' });

    expect(loaded.state.status).toBe('idle');

    // A status tick from the session it left cannot start a spinner here.
    const late = reduce(loaded.state, {
      type: 'runMessage',
      message: { type: 'status_update', tasks: [], activity: activity({ starting: true, scheduled: true }) },
      sessionId: 's1',
    });
    expect(late.state.status).toBe('idle');
  });
});
