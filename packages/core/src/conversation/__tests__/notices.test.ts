import { describe, it, expect } from 'vitest';
import { runNotice, taskStartedNotice } from '../notices';
import { EMPTY_RUN, reduceRun } from '../../services/runView';
import type { RunInput, RunView, SerializedTask, SessionMessage } from '../../services/SessionMessage';

describe('task notices', () => {
  it('names the task and the runner it started on, by the runner\'s name', () => {
    expect(taskStartedNotice('Add a parser', 'claude-code')).toBe('Started "Add a parser" · Claude Code');
    expect(taskStartedNotice('Add a parser', 'opencode')).toBe('Started "Add a parser" · OpenCode');
  });

  it('keeps the id of a runner it has no name for', () => {
    expect(taskStartedNotice('Add a parser', 'my-runner')).toBe('Started "Add a parser" · my-runner');
  });

  it('leaves the runner out when none is known', () => {
    expect(taskStartedNotice('Add a parser')).toBe('Started "Add a parser"');
  });
});

function planned(id: string, order: number, over: Partial<SerializedTask> = {}): SerializedTask {
  return {
    id, order, title: `Task ${id}`, type: 'ai', status: 'pending', description: 'd', dependencies: [],
    assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: null, subtasks: [],
    userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined,
    ...over,
  };
}

function runOf(tasks: SerializedTask[]): RunView {
  const plan: RunInput = { type: 'plan_generated', plan: { tasks, runners: ['claude-code'], generatedAt: '2026-10-13T09:00:00.000Z' }, goal: 'g', runners: ['claude-code'] };
  return reduceRun(EMPTY_RUN, plan);
}

const started = (taskId: string, title = `Task ${taskId}`): SessionMessage => ({ type: 'task_started', taskId, order: 1, title, runner: 'claude-code' });

describe('runNotice', () => {
  describe('a task starting', () => {
    it('says the task started on its runner', () => {
      expect(runNotice(started('t1', 'Add a parser'), runOf([planned('t1', 1)]))).toBe('Started "Add a parser" · Claude Code');
    });

    it('says nothing for a task the run already shows at work', () => {
      const running = runOf([planned('t1', 1, { status: 'in_progress' })]);

      expect(runNotice(started('t1'), running)).toBeNull();
    });

    it('finds the running task among subtasks too', () => {
      const running = runOf([planned('t1', 1, { subtasks: [planned('t1.1', 1, { status: 'in_progress' })] })]);

      expect(runNotice(started('t1.1'), running)).toBeNull();
    });

    it('speaks again once a retry has put the task back to pending', () => {
      const retried = runOf([planned('t1', 1, { status: 'failed' })]);

      expect(runNotice(started('t1', 'Retry me'), retried)).toBe('Started "Retry me" · Claude Code');
    });

    it('speaks for a task the run does not hold yet, since nothing says it started before', () => {
      expect(runNotice(started('t9', 'New one'), EMPTY_RUN)).toBe('Started "New one" · Claude Code');
    });
  });

  describe('the plan awaiting review', () => {
    it('asks for the sign-off, pointing at the surface\'s own way to give it', () => {
      expect(runNotice({ type: 'review_needed', tasks: [] }, EMPTY_RUN, { approveWith: '/approve' })).toBe('Plan needs your sign-off: /approve to continue.');
    });

    it('stops at the ask on a surface whose button needs no pointing at', () => {
      expect(runNotice({ type: 'review_needed', tasks: [] }, EMPTY_RUN)).toBe('Plan needs your sign-off.');
    });

    it('says the plan was approved', () => {
      expect(runNotice({ type: 'review_approved' }, EMPTY_RUN)).toBe('Plan approved.');
    });
  });

  describe('the end of a run', () => {
    it('reports the tally the run came to', () => {
      const done = { type: 'execution_complete', summary: { total: 5, completed: 2, failed: 1, blocked: 2, skipped: 0 } } as const;

      expect(runNotice(done, EMPTY_RUN)).toBe('Execution finished: 2/5 tasks complete · 1 failed · 2 blocked.');
    });

    it('leaves out what is zero', () => {
      const done = { type: 'execution_complete', summary: { total: 2, completed: 2, failed: 0, blocked: 0, skipped: 0 } } as const;

      expect(runNotice(done, EMPTY_RUN)).toBe('Execution finished: 2/2 tasks complete.');
    });

    it('names skipped tasks', () => {
      const done = { type: 'execution_complete', summary: { total: 3, completed: 1, failed: 0, blocked: 0, skipped: 2 } } as const;

      expect(runNotice(done, EMPTY_RUN)).toBe('Execution finished: 1/3 tasks complete · 2 skipped.');
    });

    it('counts a stopped run from the statuses the run holds, as a stop sends no tally', () => {
      const halted = runOf([
        planned('t1', 1, { status: 'completed' }),
        planned('t2', 2, { status: 'failed' }),
        planned('t3', 3, { status: 'pending', dependencies: ['t2'] }),
        planned('t4', 4, { status: 'skipped' }),
      ]);

      expect(runNotice({ type: 'execution_stopped' }, halted)).toBe('Execution stopped: 1/4 tasks complete · 1 failed · 1 blocked · 1 skipped.');
    });

    it('counts the subtasks of a stopped run as the daemon\'s own tally does', () => {
      const halted = runOf([planned('t1', 1, { status: 'in_progress', subtasks: [planned('t1.1', 1, { status: 'completed' }), planned('t1.2', 2)] })]);

      expect(runNotice({ type: 'execution_stopped' }, halted)).toBe('Execution stopped: 1/3 tasks complete.');
    });
  });

  it('says nothing for a message that is not a run notice', () => {
    expect(runNotice({ type: 'run_closed' }, EMPTY_RUN)).toBeNull();
    expect(runNotice({ type: 'task_output', taskId: 't1', text: 'chatter' }, EMPTY_RUN)).toBeNull();
  });
});
