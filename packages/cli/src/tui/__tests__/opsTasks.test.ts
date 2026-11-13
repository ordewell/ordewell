import { describe, it, expect, beforeAll } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import { runHint } from '../layout';
import type { RunMergeView, HandoffView, TaskView, TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));
const apply = (state: TuiState, action: Action): Step => reduce(state, action);
const frame = (state: TuiState): string => render(state).join('\n');

const handoff: HandoffView = {
  repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abcdef1234567890', landed: [{ taskId: 't1', order: 1, title: 'Bump the version' }] }],
  landed: [{ taskId: 't1', order: 1, title: 'Bump the version' }],
};
const runMerge: RunMergeView = { waitingAtGate: true, paused: true, handoff };
/** The run's merge view as the wire carries it: repos and landed flat, not nested under the handoff. */
const wireMerge = (m: RunMergeView) => ({ waitingAtGate: m.waitingAtGate, paused: m.paused, repos: m.handoff.repos, landed: m.handoff.landed });

const change = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Bump the version', type: 'ai', status: 'completed', dependencies: [], ...over,
});
const deploy = (over: Partial<TaskView> = {}): TaskView => ({
  id: 'o2', order: 2, title: 'Redeploy on dev', type: 'ai', status: 'pending', dependencies: ['t1'], ops: true, ...over,
});

const plan = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 40, cols: 100, focus: 'plan', tasks, ...over });

describe('ops tasks and merge gates in the TUI (ADR-0020)', () => {
  it('marks an ops task, and a task waiting at its merge gate', () => {
    const out = frame(plan([change(), deploy({ mergeGate: ['t1'] })]));

    expect(out).toContain('OPS Redeploy on dev');
    expect(out).toContain('⏸ waits for Merge all: #1');
  });

  it('takes the gate from a status update, and says the run is paused for Merge all', () => {
    const state = plan([change(), deploy()], { status: 'executing' });

    const next = apply(state, { type: 'runMessage', message: { type: 'status_update', runMerge: wireMerge(runMerge), tasks: [{ id: 'o2', status: 'pending', verdict: null, idleSince: null, mergeGate: ['t1'] }] }, sessionId: 's1' }).state;

    expect(next.runMerge).toEqual(runMerge);
    expect(next.tasks[1].mergeGate).toEqual(['t1']);
    expect(next.status).toBe('executing');
    expect(runHint(next)).toBe('paused for Merge all: /merge');

    const cleared = apply(next, { type: 'runMessage', message: { type: 'status_update', tasks: [{ id: 'o2', status: 'in_progress', verdict: null, idleSince: null }] }, sessionId: 's1' }).state;
    expect(cleared.runMerge).toBeNull();
    expect(cleared.tasks[1].mergeGate).toBeUndefined();
  });

  it('flips a task between change and ops with O', () => {
    const state = plan([change({ status: 'pending' })]);

    expect(press(state, 'char', 'O').effects).toEqual([{
      type: 'updateTask', sessionId: 's1', taskId: 't1', changes: { ops: true },
      message: 'Task #1 is an ops task: it runs in your checkout once the work it depends on is merged.',
    }]);
    expect(press(plan([deploy()]), 'char', 'O').effects).toMatchObject([{ changes: { ops: false } }]);
  });

  it('refuses O on a manual task', () => {
    const step = press(plan([change({ type: 'user' })]), 'char', 'O');
    expect(step.effects).toEqual([]);
  });

  it('asks before a force start passes a merge gate, naming what is not merged', () => {
    const state = plan([change(), deploy({ mergeGate: ['t1'] })], { selectedTask: 1 });

    const asked = press(state, 'char', 'f');

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'force-start-gated', taskId: 'o2' } });
    expect(asked.state.overlay?.kind === 'confirm' && asked.state.overlay.message).toContain('#1 Bump the version is not merged');
    expect(press(asked.state, 'enter').effects).toMatchObject([{ type: 'taskAction', taskId: 'o2', action: 'force-start' }]);
  });

  it('offers Merge all mid-run from the gate, and keeps the run when it merges', () => {
    const state = plan([change(), deploy({ mergeGate: ['t1'] })], { status: 'executing', runMerge, focus: 'chat' });

    const typed = reduce({ ...state, editor: { ...state.editor, text: '/merge', cursor: 6 } }, key('enter'));

    expect(typed.state.overlay).toMatchObject({ kind: 'confirm', title: 'Merge what has landed into your branch?' });
    expect(typed.state.overlay?.kind === 'confirm' && typed.state.overlay.message).toContain('The run goes on');
    expect(press(typed.state, 'enter').effects).toEqual([{ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration' }]);
  });

  it('offers /merge during a run without a gate, using the same confirmation', () => {
    const state = plan([change(), change({ id: 't2', order: 2, status: 'in_progress' })], {
      status: 'executing', runMerge: { ...runMerge, waitingAtGate: false, paused: false }, focus: 'chat',
    });
    const command = (s: TuiState) => reduce({ ...s, editor: { ...s.editor, text: '/merge', cursor: 6 } }, key('enter'));

    const asked = command(state);
    const gated = command({ ...state, runMerge });

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toEqual(gated.state.overlay);
    expect(press(asked.state, 'enter').effects).toEqual([{ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration' }]);
  });

  it('shows the unmerged landing count quietly and clears it without task status changes', () => {
    const state = plan([change(), change({ id: 't2', order: 2, status: 'in_progress' })], { status: 'executing' });
    const next = apply(state, { type: 'runMessage', message: { type: 'status_update', tasks: [], runMerge: wireMerge({ ...runMerge, waitingAtGate: false, paused: false }) } }).state;

    expect(frame(next)).toContain('1 landed task not merged');
    expect(frame(next)).not.toContain('paused for Merge all');
    expect(frame(next)).not.toContain('waits for Merge all');
    expect(next.overlay).toBeNull();

    const cleared = apply(next, { type: 'runMessage', message: { type: 'status_update', tasks: [] } }).state;
    expect(frame(cleared)).not.toContain('landed task');
  });

  it('does not offer a cached handoff mid-run after all landed work was merged', () => {
    const state = plan([change({ status: 'in_progress' })], { status: 'executing', handoff, focus: 'chat' });
    const asked = reduce({ ...state, editor: { ...state.editor, text: '/merge', cursor: 6 } }, key('enter'));

    expect(asked.state.overlay).toBeNull();
    expect(asked.effects).toEqual([]);
    expect(frame(asked.state)).toContain('No isolated run to merge');
  });
});

describe('a delegated task in the plan pane (ADR-0055 D20)', () => {
  const subtree: TaskView = { id: 'd', order: 3, title: 'Move the API', type: 'delegated', status: 'pending', dependencies: [], goal: 'The API serves v2' };

  it('tags the one row SUB, apart from AI', () => {
    const out = frame(plan([change(), subtree]));
    expect(out).toContain('SUB Move the API');
    expect(out).not.toMatch(/AI Move the API/);
  });
});

describe('script tasks in the plan pane (ADR-0035)', () => {
  const script = (over: Partial<TaskView> = {}): TaskView => ({
    id: 's2', order: 2, title: 'Tag the release', type: 'script', status: 'pending', dependencies: ['t1'],
    commands: [['git', 'tag', 'v1'], ['git', 'push', 'origin', 'v1']], timeoutMs: 90_000, ...over,
  });

  it('tags the row SCR, apart from OPS and AI', () => {
    const out = frame(plan([change(), deploy(), script()]));

    expect(out).toContain('SCR Tag the release');
    expect(out).toContain('OPS Redeploy on dev');
    expect(out).not.toMatch(/AI Tag the release/);
  });

  /** The plan pane's rows alone: the chat pane shares each screen row. */
  const planRows = (state: TuiState): string[] => render(state).map((line) => line.slice(line.indexOf('│') + 1).trim());

  it('shows the commands one to a line, and the time limit, where an ops task shows its prompt', () => {
    const rows = planRows(plan([change(), script()], { selectedTask: 1, expandedTaskId: 's2' }));

    const at = rows.indexOf('git tag v1');
    expect(rows).toContain('Script');
    expect(rows.slice(at, at + 4)).toEqual(['git tag v1', 'git push origin v1', '', 'Time limit: 90 seconds.']);
  });

  it('shows a script as written, its lines kept, and a control character spelled out rather than dropped', () => {
    const body = script({ commands: undefined, script: 'set -e\n\techo hi\x1b[2J', timeoutMs: undefined });
    const rows = planRows(plan([change(), body], { selectedTask: 1, expandedTaskId: 's2' }));

    const at = rows.indexOf('set -e');
    expect(rows.slice(at, at + 4)).toEqual(['set -e', 'echo hi<U+001B>[2J', '', 'Time limit: 10 minutes.']);
  });

  it('opens no prompt editor on right, and says the body is not edited here', () => {
    const state = plan([change(), script()], { selectedTask: 1 });

    const opened = press(state, 'right').state;

    expect(opened.expandedTaskId).toBe('s2');
    expect(opened.taskEditor).toBeNull();
    expect(frame(opened)).not.toContain('enter save');
    expect(frame(opened)).toContain('esc collapse');
    // Typing into the open row does not start an edit either.
    expect(press(opened, 'char', 'x').state.taskEditor).toBeNull();
  });

  it('offers no ops toggle, runner, model, mode, effort or skills for a script task', () => {
    const state = plan([change(), script()], { selectedTask: 1 });

    for (const letter of ['O', 'R', 'o', 'e', 'M', 'K']) {
      const step = press(state, 'char', letter);
      expect(step.effects, letter).toEqual([]);
      expect(step.state.overlay, letter).toBeNull();
    }
    expect(frame(press(state, 'char', 'O').state)).toContain('ops task already');
  });

  it('still approves/starts a script task with f and removes it with d', () => {
    const state = plan([change(), script()], { selectedTask: 1 });

    expect(press(state, 'char', 'f').effects).toMatchObject([{ type: 'taskAction', taskId: 's2', action: 'force-start' }]);
    expect(press(state, 'char', 'd').state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'remove-task', taskId: 's2' } });
  });

  it('names no model keys in the footer for a script task', () => {
    const out = frame(plan([change(), script()], { selectedTask: 1, rows: 40, cols: 140 }));

    expect(out).toContain('f start');
    expect(out).not.toContain('o model');
  });

  it('carries the body and time limit from the plan to the pane, unsanitized', () => {
    const state = reduce(initialState({ sessionId: 's1', rows: 30, cols: 100 }), {
      type: 'planUpdated',
      sessionId: 's1',
      plan: { tasks: [{ id: 's2', order: 1, title: 'Tag', type: 'script', status: 'pending', dependencies: [], commands: [['git', 'tag', 'v1']], timeoutMs: 5000 }] },
    }).state;

    expect(state.tasks[0]).toMatchObject({ type: 'script', commands: [['git', 'tag', 'v1']], timeoutMs: 5000 });
    expect(state.tasks[0].ops).toBeUndefined();
  });
});
