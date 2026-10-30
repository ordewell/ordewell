import { describe, it, expect } from 'vitest';
import type { TaskRevertPreview } from '@ordewell/core';
import { initialState, reduce, type Step } from '../reducer';
import type { TaskView, TuiState } from '../state';
import { lastMessage } from './chat';
import { render } from '../render';
import { stripAnsi } from '../ansi';

/**
 * /revert (ADR-0054): the terminal asks core what a revert would take, shows
 * the user that list, and sends the yes with the ids it showed. It decides
 * nothing: what goes with the task, and every refusal, is core's answer.
 */

const enter = (state: TuiState): Step => reduce(state, { type: 'key', key: { name: 'enter' } });
const escape = (state: TuiState): Step => reduce(state, { type: 'key', key: { name: 'escape' } });
const slash = (state: TuiState, text: string): Step =>
  reduce({ ...state, editor: { ...state.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } });

function task(over: Partial<TaskView> = {}): TaskView {
  return { id: 't1', order: 1, title: 'Parse JSON', type: 'ai', status: 'completed', dependencies: [], ...over };
}

function chat(over: Partial<TuiState> = {}): TuiState {
  return initialState({ sessionId: 's1', focus: 'chat', tasks: [task(), task({ id: 't2', order: 2, title: 'Wire it up', dependencies: ['t1'] })], ...over });
}

const previewed = (state: TuiState, preview: TaskRevertPreview, taskId = 't1'): Step =>
  reduce(state, { type: 'revertPreviewed', sessionId: 's1', taskId, preview });

const goingWith: TaskRevertPreview = {
  revertible: true,
  tasks: [
    { taskId: 't2', order: 2, title: 'Wire it up', repos: ['.'], dependent: true },
    { taskId: 't1', order: 1, title: 'Parse JSON', repos: ['.'], dependent: false },
  ],
};

describe('/revert', () => {
  it('asks core what the revert would take, and changes nothing yet', () => {
    const asked = slash(chat(), '/revert 1');

    expect(asked.effects).toEqual([{ type: 'previewRevert', sessionId: 's1', taskId: 't1' }]);
    expect(asked.state.overlay).toBeNull();
  });

  it('needs a task that is in the plan', () => {
    expect(slash(chat(), '/revert').effects).toEqual([]);
    const missing = slash(chat(), '/revert 9');
    expect(missing.effects).toEqual([]);
    expect(lastMessage(missing.state)!.text).toContain('No task matching "9"');
  });

  it('lists the task and every dependent that goes with it, newest first', () => {
    const asked = previewed(chat(), goingWith);

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', title: 'Revert #1 Parse JSON?', action: { kind: 'revert-task', taskId: 't1', seen: ['t2', 't1'] } });
    const note = (asked.state.overlay as { note: string }).note;
    expect(note.indexOf('#2 Wire it up')).toBeGreaterThanOrEqual(0);
    expect(note.indexOf('#2 Wire it up')).toBeLessThan(note.indexOf('#1 Parse JSON'));
    expect(note).toContain('goes with it');
  });

  it('names the repos of a task that changed more than the workspace', () => {
    const asked = previewed(chat(), { revertible: true, tasks: [{ taskId: 't1', order: 1, title: 'Parse JSON', repos: ['api', 'web'], dependent: false }] });

    expect((asked.state.overlay as { note: string }).note).toContain('api, web');
  });

  it('draws the list on the screen', () => {
    const asked = previewed(chat(), goingWith).state;

    const screen = stripAnsi(render(asked).join('\n'));
    expect(screen).toContain('Revert #1 Parse JSON?');
    expect(screen).toContain('#2 Wire it up');
  });

  it('sends the yes with the ids it showed', () => {
    const asked = previewed(chat(), goingWith).state;

    const answered = enter(asked);

    expect(answered.effects).toEqual([{ type: 'revertTask', sessionId: 's1', taskId: 't1', seen: ['t2', 't1'] }]);
    expect(answered.state.overlay).toBeNull();
  });

  it('sends nothing when declined', () => {
    const declined = escape(previewed(chat(), goingWith).state);

    expect(declined.effects).toEqual([]);
    expect(declined.state.overlay).toBeNull();
  });

  it('does not open over another session that was loaded meanwhile', () => {
    const late = reduce(chat({ sessionId: 's2' }), { type: 'revertPreviewed', sessionId: 's1', taskId: 't1', preview: goingWith });

    expect(late.state.overlay).toBeNull();
  });

  it('keeps a task\'s title from painting on the screen', () => {
    const hostile = task({ title: 'Parse\x1b[31m JSON\x07' });
    const asked = previewed(chat({ tasks: [hostile] }), { revertible: true, tasks: [{ taskId: 't1', order: 1, title: 'Parse\x1b[31m JSON\x07', repos: ['.'], dependent: false }] });

    const overlay = asked.state.overlay as { note: string; title: string };
    expect(overlay.note).not.toContain('\x1b');
    expect(overlay.note).not.toContain('\x07');
    expect(overlay.title).not.toContain('\x1b');
    expect(overlay.title).not.toContain('\x07');
  });

  describe('refused', () => {
    const refused = (preview: TaskRevertPreview): string => {
      const step = previewed(chat(), preview);
      expect(step.effects).toEqual([]);
      expect(step.state.overlay).toBeNull();
      return lastMessage(step.state)!.text;
    };

    it('while a dependent is still live, naming it', () => {
      const text = refused({ revertible: false, reason: 'live-dependent', message: 'Task "Wire it up" depends on it and is still running or waiting on you, from a tip that holds this work. Nothing was reverted. Let it finish, or stop it, first.', tasks: [{ taskId: 't2', order: 2, title: 'Wire it up' }] });

      expect(text).toContain('Task "Wire it up" depends on it and is still running');
    });

    it('over a conflict with its files', () => {
      const text = refused({ revertible: false, reason: 'git', message: 'Reverting task "Parse JSON" conflicts with what landed after it: src/a.ts, src/b.ts. Nothing was reverted, and the integration branch is as it was.' });

      expect(text).toContain('src/a.ts, src/b.ts');
    });

    it('for work already in the branch, with the exact git revert command', () => {
      const text = refused({
        revertible: false,
        reason: 'in-branch',
        message: 'This work is already merged into your branch, which Ordewell never writes to. To undo it there, run this: git revert -m 1 abc1234',
        commands: [{ task: { taskId: 't1', order: 1, title: 'Parse JSON' }, repo: '.', commit: 'abc1234', command: 'git revert -m 1 abc1234' }],
      });

      expect(text).toContain('git revert -m 1 abc1234');
    });

    it('while a loop is still running', () => {
      const text = refused({ revertible: false, reason: 'in-a-loop', message: 'Task "Parse JSON" is in the loop of task "Check", which has not ended. Nothing was reverted. Let the loop end first.' });

      expect(text).toContain('Let the loop end first');
    });

    it('with nothing landed', () => {
      const text = refused({ revertible: false, reason: 'no-landing', message: 'Task "Parse JSON" landed nothing on the integration branch, so there is nothing to revert.' });

      expect(text).toContain('landed nothing');
    });

    it('without letting a runner\'s text paint on the screen', () => {
      const text = refused({ revertible: false, reason: 'git', message: 'Stopped in \x1b[2Jrepo\x07.' });

      expect(text).not.toContain('\x1b');
      expect(text).not.toContain('\x07');
    });
  });
});
