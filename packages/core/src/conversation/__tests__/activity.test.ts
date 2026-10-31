import { describe, it, expect } from 'vitest';
import { replayTaskLog } from '../taskLog';
import { activityLabel, taskActivity } from '../activity';
import type { StructuredTurnEnd } from '../../interfaces/IRunner';
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

  it('is absent between turns, and for an earlier attempt left open', () => {
    for (const reason of ['completed', 'interrupted', 'failed'] as const) {
      expect(taskActivity(replayTaskLog([start, { type: 'thinking_delta', text: 'Hmm' }, { type: 'turn_end', reason }]), { status: 'in_progress' })).toBeNull();
    }
    expect(working.working).toBe(true);
    expect(taskActivity({ ...working, archived: true }, { status: 'in_progress' })).toBeNull();
    expect(taskActivity({ ...working, archived: true }, { status: 'in_progress', idleSince: '2026-08-18T00:00:00.000Z' })).toBeNull();
  });

  it('keeps a background subagent that outlives the turn', () => {
    const view = replayTaskLog([start, { type: 'subagent_started', subagentId: 's1', brief: 'Scan the repo' }, { type: 'turn_end', reason: 'completed' }]);
    expect(view.working).toBe(false);
    expect(taskActivity(view, { status: 'in_progress' })).toEqual({ label: 'Subagent: Scan the repo…', busy: true });
  });

  it('stays busy for a log that streams without having seen its turn start', () => {
    for (const events of [
      [{ type: 'thinking_delta', text: 'Hmm' }],
      [{ type: 'text_delta', runId: 'a', text: 'Here' }],
      [{ type: 'tool_call', id: 'r1', name: 'Read', args: '{"file_path":"a.ts"}' }],
    ] satisfies TaskLogEvent[][]) {
      const view = replayTaskLog(events);
      expect(view.working).toBe(false);
      expect(taskActivity(view, { status: 'in_progress' })).toMatchObject({ busy: true });
    }
    // Sealed by a turn's end, the same blocks leave nothing open.
    expect(taskActivity(replayTaskLog([{ type: 'thinking_delta', text: 'Hmm' }, { type: 'turn_end', reason: 'completed' }]), { status: 'in_progress' })).toBeNull();
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

describe('taskActivity on a script task (ADR-0035)', () => {
  const running = { status: 'in_progress' };

  it('names the step still running: its log is what it printed, so the line is true', () => {
    const view = replayTaskLog([{ type: 'script_run', argv: ['npm', 'test'] }, { type: 'script_output', text: 'ok\n' }]);
    expect(taskActivity(view, running)).toEqual({ label: 'Running Run(npm test)…', busy: true });
  });

  it('names an inline script the same way', () => {
    const view = replayTaskLog([{ type: 'script_run', script: 'npm ci' }]);
    expect(taskActivity(view, running)?.label).toBe('Running Script(npm ci)…');
  });

  it('has no line once the step has ended, nor between steps', () => {
    const view = replayTaskLog([{ type: 'script_run', argv: ['npm', 'test'] }, { type: 'script_exit', code: 0, signal: null, durationMs: 10 }]);
    expect(taskActivity(view, running)).toBeNull();
  });
});

describe('taskActivity, the whole rule', () => {
  // A line shows if a turn is open, or a subagent is running, or the log has seen
  // no turn end and holds an open block. Once a turn has ended, a tool, message or
  // thinking left open is not a turn. Each cell is read as both surfaces read it:
  // the TUI hands over the whole view, the webview only the blocks, the turn flag
  // and `lastTurnEnd` (null in its status when absent).
  const OPEN: Record<string, TaskLogEvent[]> = {
    tool: [{ type: 'tool_call', id: 'r1', name: 'Bash', args: '{"command":"npm test"}' }],
    message: [{ type: 'text_delta', runId: 'a', text: 'Here' }],
    thinking: [{ type: 'thinking_delta', text: 'Hmm' }],
    subagent: [{ type: 'subagent_started', subagentId: 's1', brief: 'Scan the repo' }],
    none: [],
  };
  const ENDS: Array<StructuredTurnEnd | undefined> = [undefined, 'completed', 'interrupted', 'failed'];

  const cases = [true, false].flatMap((working) => ENDS.flatMap((lastTurnEnd) => Object.keys(OPEN).flatMap((open) => [false, true].map((archived) => ({ working, lastTurnEnd, open, archived })))));

  it.each(cases)('working $working, last turn end $lastTurnEnd, open $open, archived $archived', ({ working, lastTurnEnd, open, archived }) => {
    // Replayed without a turn end, so the blocks are left open whatever the flags below say.
    const logged = replayTaskLog(OPEN[open]);
    const shows = !archived && (working || open === 'subagent' || (lastTurnEnd === undefined && open !== 'none'));
    const tui = taskActivity({ ...logged, working, lastTurnEnd, archived }, { status: 'in_progress' });
    const webview = taskActivity({ blocks: logged.blocks, turnStartedAt: undefined, working, lastTurnEnd: lastTurnEnd ?? undefined, archived }, { status: 'in_progress' });
    for (const activity of [tui, webview]) {
      if (shows) expect(activity).toMatchObject({ busy: true });
      else expect(activity).toBeNull();
    }
    expect(webview).toEqual(tui);
  });

  it('is absent for a finished turn that left a tool call pending, or took a late delta', () => {
    const dangling = replayTaskLog([start, ...OPEN.tool, { type: 'turn_end', reason: 'completed' }]);
    expect(dangling.blocks.some((b) => b.type === 'tool' && b.status === 'pending')).toBe(true);
    expect(taskActivity(dangling, { status: 'in_progress' })).toBeNull();
    const straggler = replayTaskLog([start, { type: 'turn_end', reason: 'completed' }, ...OPEN.message]);
    expect(straggler.working).toBe(false);
    expect(taskActivity(straggler, { status: 'in_progress' })).toBeNull();
  });
});
