import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_RUN, type RunTask, type RunView, type StoredHandoff } from '@ordewell/core';
import { style } from '../ansi';
import { reduce } from '../reducer';
import { render } from '../render';
import { initialState, type TuiState } from '../state';

/*
 * A fold rebuilds a task's view only when the task it came from changed: an
 * unchanged task keeps its view, and a change to anything a view carries must
 * still reach it. The oracle for "reaches it" is the same run folded into a
 * fresh state, which has no earlier view to reuse.
 */

beforeAll(() => {
  style.enabled = false;
});

const handoff: StoredHandoff = {
  summary: 'Added the route.',
  findings: [{ id: 'F1', severity: 'major', title: 'Missing auth', detail: 'Add a guard.', evidence: [{ kind: 'file', path: 'src/route.ts', line: 12 }] }],
  findingCount: 1,
  artifacts: [{ kind: 'file', path: 'src/route.ts' }],
};

function runTask(id: string, order: number, over: Partial<RunTask> = {}): RunTask {
  return {
    id, order, title: `Task ${order}`, description: `Do part ${order}`, prompt: `Prompt for part ${order}\nwith a second line`,
    type: 'ai', status: 'pending', dependencies: [], subtasks: [], ...over,
  } as RunTask;
}

function plan(): RunTask[] {
  return [
    runTask('t1', 1, {
      status: 'completed', assignedRunner: 'claude-code', taskMode: 'auto',
      assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'high' },
      attemptUsage: [{ attempt: 1, runner: 'claude-code', startedAt: '', wallTimeMs: 1000, totals: { inputTokens: 10 }, byModel: [] }],
      handoff, skills: ['tdd'],
    } as Partial<RunTask>),
    runTask('t2', 2, {
      status: 'in_progress', dependencies: ['t1'],
      subtasks: [runTask('t2.2', 2, { title: 'Second half' }), runTask('t2.1', 1, { title: 'First half' })],
    }),
    runTask('t3', 3, { status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: 'Which database?', holdReason: 'held for you' } as Partial<RunTask>),
    runTask('t4', 4, { type: 'script', script: 'npm test', timeoutMs: 1000 } as Partial<RunTask>),
  ];
}

const view = (tasks: RunTask[]): RunView => ({ ...EMPTY_RUN, tasks });
const snapshot = (state: TuiState, tasks: RunTask[]): TuiState => reduce(state, { type: 'runSnapshot', sessionId: 's', view: view(tasks) }).state;
const start = (): TuiState => initialState({ sessionId: 's', rows: 40, cols: 200, focus: 'plan' });

describe('folding a run keeps the views of tasks that did not change', () => {
  it('keeps every view, and the list, when the same tasks arrive again', () => {
    const tasks = plan();
    const first = snapshot(start(), tasks);
    const again = snapshot(first, tasks);
    expect(again.tasks).toBe(first.tasks);
  });

  it('keeps them when an equal copy arrives, as a parsed status update is', () => {
    const first = snapshot(start(), plan());
    const again = snapshot(first, structuredClone(plan()));
    expect(again.tasks).toBe(first.tasks);
    expect(again.tasks[1]?.subtasks?.[0]).toBe(first.tasks[1]?.subtasks?.[0]);
  });

  it('keeps them when the plan arrives whole over a run the stream folded', () => {
    const refreshed = (state: TuiState): TuiState => reduce(state, { type: 'planRefreshed', sessionId: 's', plan: { tasks: plan() } }).state;
    const planned = refreshed(start());
    // The run as the socket sends it: through JSON, so with no field set to `undefined`.
    const first = snapshot(planned, (JSON.parse(JSON.stringify(planned.run)) as RunView).tasks);
    expect(first.tasks).toBe(planned.tasks);
    // Core's plan refresh writes every status-only field, the absent ones as `undefined`.
    expect(refreshed(first).tasks).toBe(first.tasks);
  });

  it('rebuilds only the task that changed', () => {
    const first = snapshot(start(), plan());
    const tasks = plan();
    tasks[2] = { ...tasks[2]!, status: 'in_progress' };
    const next = snapshot(first, tasks);
    expect(next.tasks).not.toBe(first.tasks);
    expect(next.tasks[0]).toBe(first.tasks[0]);
    expect(next.tasks[1]).toBe(first.tasks[1]);
    expect(next.tasks[2]).not.toBe(first.tasks[2]);
    expect(next.tasks[2]?.status).toBe('in_progress');
  });
});

describe('a change to any field a view carries reaches it', () => {
  const at = (i: number, change: (t: RunTask) => RunTask) => (tasks: RunTask[]): RunTask[] => tasks.map((t, j) => (j === i ? change(t) : t));
  const changes: Array<[string, (tasks: RunTask[]) => RunTask[]]> = [
    ['title', at(0, (t) => ({ ...t, title: 'Renamed' }))],
    ['description', at(0, (t) => ({ ...t, description: 'Another description' }))],
    ['prompt', at(0, (t) => ({ ...t, prompt: 'A new prompt' }))],
    ['status', at(0, (t) => ({ ...t, status: 'failed' }))],
    ['model', at(0, (t) => ({ ...t, assignedModel: { ...t.assignedModel!, modelId: 'opus', modelLabel: 'Opus' } }))],
    ['effort, inside the model', at(0, (t) => ({ ...t, assignedModel: { ...t.assignedModel!, thinkingEffort: 'low' } }))],
    ['runner', at(0, (t) => ({ ...t, assignedRunner: 'codex' }))],
    ['usage, deep inside', at(0, (t) => ({ ...t, attemptUsage: [{ ...t.attemptUsage![0]!, totals: { inputTokens: 99 } }] }))],
    ['handoff summary', at(0, (t) => ({ ...t, handoff: { ...handoff, summary: 'Something else.' } }))],
    ['a finding', at(0, (t) => ({ ...t, handoff: { ...handoff, findings: [{ ...handoff.findings[0]!, title: 'Other' }] } }))],
    ['skills', at(0, (t) => ({ ...t, skills: ['tdd', 'review'] }))],
    ['dependencies', at(1, (t) => ({ ...t, dependencies: [] }))],
    ['a subtask title', at(1, (t) => ({ ...t, subtasks: [t.subtasks[0]!, { ...t.subtasks[1]!, title: 'Renamed half' }] }))],
    ['a subtask order', at(1, (t) => ({ ...t, subtasks: [{ ...t.subtasks[0]!, order: 0 }, t.subtasks[1]!] }))],
    ['a new subtask', at(1, (t) => ({ ...t, subtasks: [...t.subtasks, runTask('t2.3', 3)] }))],
    ['a field that was absent', at(1, (t) => ({ ...t, idleSince: '2026-01-01T00:00:00Z', attaching: 1 } as RunTask))],
    ['a field that goes away', at(2, ({ holdReason: _gone, ...t }) => t as RunTask)],
    ['checkpoint', at(2, (t) => ({ ...t, checkpoint: 'Which cache?' }))],
    ['script', at(3, (t) => ({ ...t, script: 'npm run lint' } as RunTask))],
    ['order', (tasks) => [tasks[1]!, tasks[0]!, ...tasks.slice(2)]],
    ['a task removed', (tasks) => tasks.slice(1)],
  ];

  it.each(changes)('%s', (_name, change) => {
    const changed = change(structuredClone(plan()));
    const folded = snapshot(snapshot(start(), plan()), changed);
    const fresh = snapshot(start(), changed);
    expect(folded.tasks).toEqual(fresh.tasks);
    for (const selectedTask of [0, 1, 2]) {
      expect(render({ ...folded, selectedTask })).toEqual(render({ ...fresh, selectedTask }));
    }
  });
});
