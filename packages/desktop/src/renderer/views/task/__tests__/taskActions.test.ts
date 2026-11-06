import { describe, expect, it } from 'vitest';
import { taskTabActions } from '../taskActions';

const ai = { id: 't1', type: 'ai', status: 'pending' };
const labels = (...args: Parameters<typeof taskTabActions>) => taskTabActions(...args).map((a) => a.label);

describe('taskTabActions', () => {
  it('offers Run first on a task that has not run, and Remove while nothing executes', () => {
    expect(labels(ai, { actions: ['force-start'], revertible: false, status: 'todo' }, false)).toEqual(['Run', 'Remove…']);
    expect(taskTabActions(ai, { actions: [], revertible: false, status: 'todo' }, false)[0]!.message)
      .toEqual({ type: 'sendSystemCommand', command: 'runTask', taskId: 't1' });
  });

  it('lets a running plan start the task only past its gate, and never remove it', () => {
    expect(labels(ai, { actions: ['force-start', 'skip'], revertible: false, status: 'todo' }, true)).toEqual(['Start now', 'Skip']);
  });

  it('puts a failed task\'s retry ahead of everything, and its revert after the row\'s own', () => {
    expect(labels({ ...ai, status: 'failed' }, { actions: ['skip'], revertible: true, status: 'failed' }, false))
      .toEqual(['Retry', 'Skip', 'Revert…', 'Remove…']);
  });

  it('stops a running task, and has no Run or Retry for it', () => {
    expect(labels({ ...ai, status: 'in_progress' }, { actions: ['cancel'], revertible: false, status: 'running' }, true)).toEqual(['Stop']);
  });

  it('never runs a task of yours', () => {
    expect(labels({ ...ai, type: 'user', status: 'failed' }, { actions: ['complete'], revertible: false, status: 'awaiting' }, false))
      .toEqual(['Mark complete', 'Remove…']);
  });

  it('puts a signed-out agent\'s Log in before a same-failure Retry', () => {
    const signIn = { runner: 'codex', label: 'Codex', hint: 'Codex is not signed in.', action: 'login' as const };
    const actions = taskTabActions({ ...ai, status: 'failed' }, { actions: ['skip'], revertible: false, status: 'failed' }, false, signIn);
    expect(actions[0]).toEqual({ label: 'Log in', message: { type: 'loginPlanner', runner: 'codex' } });

    const key = taskTabActions(
      { ...ai, status: 'failed' },
      { actions: [], revertible: false, status: 'failed' },
      false,
      { runner: 'gemini-cli', label: 'Gemini CLI', hint: 'Run /key.', action: 'key', provider: 'google' },
    );
    expect(key[0]).toEqual({ label: 'Set API key…', message: { type: 'sendMessage', text: '/key google' } });
  });
});
