import { describe, it, expect } from 'vitest';
import { replayTaskLog } from '../taskLog';
import { activityLabel, taskActivity } from '../activity';
import type { TaskLogEvent } from '../../models/TaskLog';

const start: TaskLogEvent = { type: 'turn_start', message: 'Do the task' };

describe('activityLabel', () => {
  it('names an open thinking block', () => {
    expect(activityLabel(replayTaskLog([start, { type: 'thinking_delta', text: 'Hmm' }]))).toBe('Thinking…');
  });

  it('names a pending tool call by its headline', () => {
    const view = replayTaskLog([start, { type: 'tool_call', id: 'r1', name: 'Read', args: '{"file_path":"README.md"}' }]);
    expect(activityLabel(view)).toBe('Running Read(README.md)…');
  });

  it('is Working… when nothing is open', () => {
    expect(activityLabel(replayTaskLog([start]))).toBe('Working…');
  });
});

describe('activityLabel, further', () => {
  it('names a streaming message as Writing…', () => {
    expect(activityLabel(replayTaskLog([start, { type: 'text_delta', runId: 'a', text: 'Here' }]))).toBe('Writing…');
  });

  it('leaves a finished tool call and settled thinking behind', () => {
    const view = replayTaskLog([
      start,
      { type: 'thinking', text: 'Plan.' },
      { type: 'tool_call', id: 'r1', name: 'Read', args: '{"file_path":"a.ts"}' },
      { type: 'tool_result', id: 'r1', output: 'x', success: true },
    ]);
    expect(activityLabel(view)).toBe('Working…');
  });

  it('names the latest of several open things', () => {
    const view = replayTaskLog([
      start,
      { type: 'tool_call', id: 'r1', name: 'Read', args: '{"file_path":"a.ts"}' },
      { type: 'thinking_delta', text: 'next' },
    ]);
    expect(activityLabel(view)).toBe('Thinking…');
  });

  it('names a running subagent by its brief, and several by a count', () => {
    const one = replayTaskLog([start, { type: 'subagent_started', subagentId: 'a1', brief: 'Read the README' }]);
    expect(activityLabel(one)).toBe('Subagent: Read the README…');
    const two = replayTaskLog([
      start,
      { type: 'subagent_started', subagentId: 'a1', brief: 'Read the README' },
      { type: 'subagent_started', subagentId: 'a2', brief: 'Run the tests' },
    ]);
    expect(activityLabel(two)).toBe('2 subagents running…');
  });

  it('counts only the subagents still running', () => {
    const view = replayTaskLog([
      start,
      { type: 'subagent_started', subagentId: 'a1', brief: 'Read the README' },
      { type: 'subagent_finished', subagentId: 'a1', outcome: 'done', digest: 'ok' },
      { type: 'subagent_started', subagentId: 'a2', brief: 'Run the tests' },
    ]);
    expect(activityLabel(view)).toBe('Subagent: Run the tests…');
  });
});

describe('taskActivity', () => {
  const working = replayTaskLog([start, { type: 'thinking_delta', text: 'Hmm' }]);

  it('is busy while the task runs', () => {
    expect(taskActivity(working, { status: 'in_progress' })).toEqual({ label: 'Thinking…', busy: true });
  });

  it('goes static, worded as the plan pane words it, once the task is quiet', () => {
    expect(taskActivity(working, { status: 'in_progress', idleSince: '2026-08-18T00:00:00.000Z' })).toEqual({ label: 'Stalled', busy: false });
  });

  it('carries when the open turn began, so a surface can count from it (#81)', () => {
    const at = '2026-10-30T10:00:00.000Z';
    const dated = replayTaskLog([{ ...start, startedAt: at }, { type: 'thinking_delta', text: 'Hmm' }]);
    expect(taskActivity(dated, { status: 'in_progress' })).toEqual({ label: 'Thinking…', busy: true, since: at });
    // A quiet task keeps counting: the time is how long it has been silent.
    expect(taskActivity(dated, { status: 'in_progress', idleSince: '2026-10-30T10:05:00.000Z' })).toEqual({ label: 'Stalled', busy: false, since: at });
  });

  it('is absent while a runner request waits', () => {
    const asked = replayTaskLog([start, { type: 'approval_requested', approvalId: 'p1', tool: 'Bash', args: '{}', allowForTask: true }]);
    expect(taskActivity(asked, { status: 'in_progress' })).toBeNull();
    expect(taskActivity(working, { status: 'in_progress', awaitingApproval: 1 })).toBeNull();
  });

  it('is absent when the task is not running, as at a checkpoint', () => {
    expect(taskActivity(working, { status: 'awaiting_user' })).toBeNull();
    expect(taskActivity(working, { status: 'completed' })).toBeNull();
  });
});
