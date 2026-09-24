import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import type { HandoffView, TaskView, TuiState } from '../state';

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));
const apply = (state: TuiState, action: Action): Step => reduce(state, action);

const handoff: HandoffView = {
  branch: 'ordewell/r1/integration',
  baseRef: 'abcdef1234567890',
  landed: [{ taskId: 't1', order: 1, title: 'Add the route' }, { taskId: 't2', order: 2, title: 'Write the tests' }],
};

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Add the route', type: 'ai', status: 'completed', dependencies: [], ...over,
});

const session = (over: Partial<TuiState> = {}): TuiState => initialState({ sessionId: 's1', rows: 30, cols: 80, ...over });
const withHandoff = (over: Partial<TuiState> = {}): TuiState => session({ handoff, ...over });
const lastMessage = (state: TuiState) => state.messages.at(-1);

function typed(state: TuiState, text: string): Step {
  return reduce({ ...state, editor: { ...state.editor, text, cursor: text.length } }, key('enter'));
}

describe('isolation_handoff', () => {
  it('records the handoff, says so, and opens the overlay on an otherwise quiet screen', () => {
    const { state } = apply(session(), { type: 'isolationHandoff', handoff, sessionId: 's1' });

    expect(state.handoff).toEqual(handoff);
    expect(state.overlay).toEqual({ kind: 'handoff', index: 0, diff: null });
    expect(lastMessage(state)?.content).toMatch(/ordewell\/r1\/integration — 2 tasks landed/);
  });

  it('does not take over a screen that already has an overlay', () => {
    const { state } = apply(session({ overlay: { kind: 'help' } }), { type: 'isolationHandoff', handoff, sessionId: 's1' });

    expect(state.overlay).toEqual({ kind: 'help' });
    expect(state.handoff).toEqual(handoff);
    expect(lastMessage(state)?.content).toMatch(/\/handoff/);
  });

  it("ignores another session's handoff", () => {
    const { state } = apply(session(), { type: 'isolationHandoff', handoff, sessionId: 'other' });

    expect(state.handoff).toBeNull();
    expect(state.overlay).toBeNull();
  });
});

describe('/handoff', () => {
  it('opens the overlay', () => {
    expect(typed(withHandoff(), '/handoff').state.overlay).toEqual({ kind: 'handoff', index: 0, diff: null });
  });

  it('says there is nothing to hand off when no run isolated', () => {
    const { state, effects } = typed(session(), '/handoff');

    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
    expect(lastMessage(state)).toMatchObject({ role: 'error', content: expect.stringMatching(/No isolated run/) });
  });

  it('review asks for the diff', () => {
    expect(typed(withHandoff(), '/handoff review').effects).toEqual([{ type: 'isolationReviewDiff', sessionId: 's1' }]);
  });

  it('merge and discard confirm first instead of acting', () => {
    for (const [arg, kind] of [['merge', 'merge-run'], ['discard', 'discard-run']] as const) {
      const { state, effects } = typed(withHandoff(), `/handoff ${arg}`);

      expect(effects).toEqual([]);
      expect(state.overlay).toMatchObject({ kind: 'confirm', action: { kind } });
    }
  });

  it('cleanup acts without a confirmation', () => {
    expect(typed(withHandoff(), '/handoff cleanup').effects).toEqual([
      { type: 'isolationCleanup', sessionId: 's1', branch: 'ordewell/r1/integration' },
    ]);
  });

  it('rejects an action it does not know', () => {
    const { effects, state } = typed(withHandoff(), '/handoff deploy');

    expect(effects).toEqual([]);
    expect(lastMessage(state)?.content).toMatch(/Usage: \/handoff/);
  });
});

describe('the handoff overlay', () => {
  const open = (): TuiState => session({ handoff, overlay: { kind: 'handoff', index: 0, diff: null } });

  it('moves the highlight and stays within the four actions', () => {
    let state = open();
    for (let i = 0; i < 6; i++) state = press(state, 'down').state;
    expect(state.overlay).toMatchObject({ index: 3 });
    for (let i = 0; i < 6; i++) state = press(state, 'up').state;
    expect(state.overlay).toMatchObject({ index: 0 });
  });

  it('enter on Review diff asks for the diff and keeps the overlay open', () => {
    const { state, effects } = press(open(), 'enter');

    expect(effects).toEqual([{ type: 'isolationReviewDiff', sessionId: 's1' }]);
    expect(state.overlay?.kind).toBe('handoff');
  });

  it('Merge never merges from the overlay alone: it asks, and only enter on the ask sends the effect', () => {
    const asked = press(press(open(), 'down').state, 'enter');

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', title: 'Merge into your branch?', action: { kind: 'merge-run' } });
    expect((asked.state.overlay as { message: string }).message).toContain('ordewell/r1/integration');

    const confirmed = press(asked.state, 'enter');
    expect(confirmed.effects).toEqual([{ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration' }]);
    expect(confirmed.state.overlay).toBeNull();
  });

  it('escape on the merge question merges nothing', () => {
    const asked = press(press(open(), 'down').state, 'enter');

    const { state, effects } = press(asked.state, 'escape');

    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
  });

  it('Discard confirms, then discards', () => {
    let state = open();
    for (let i = 0; i < 2; i++) state = press(state, 'down').state;
    const asked = press(state, 'enter');

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'discard-run' } });
    expect(press(asked.state, 'enter').effects).toEqual([{ type: 'isolationDiscard', sessionId: 's1', branch: 'ordewell/r1/integration' }]);
  });

  it('Clean up acts at once and closes', () => {
    let state = open();
    for (let i = 0; i < 3; i++) state = press(state, 'down').state;

    const { state: after, effects } = press(state, 'enter');

    expect(effects).toEqual([{ type: 'isolationCleanup', sessionId: 's1', branch: 'ordewell/r1/integration' }]);
    expect(after.overlay).toBeNull();
  });

  it('escape closes it', () => {
    expect(press(open(), 'escape').state.overlay).toBeNull();
  });
});

describe('the diff view', () => {
  const diff = Array.from({ length: 60 }, (_, i) => `+line ${i}`).join('\n');
  const viewing = (): TuiState => apply(session({ handoff, overlay: { kind: 'handoff', index: 0, diff: null } }), { type: 'handoffDiff', diff, sessionId: 's1' }).state;

  it('opens on the diff when it arrives', () => {
    const state = viewing();

    expect(state.overlay).toMatchObject({ kind: 'handoff', diff: { scroll: 0 } });
    expect((state.overlay as { diff: { lines: string[] } }).diff.lines).toHaveLength(60);
  });

  it('opens the overlay itself when the request came from /handoff review', () => {
    const { state } = apply(session({ handoff }), { type: 'handoffDiff', diff, sessionId: 's1' });

    expect(state.overlay).toMatchObject({ kind: 'handoff', diff: { scroll: 0 } });
  });

  it('scrolls within the diff, never past its end', () => {
    let state = viewing();
    state = press(state, 'down').state;
    expect((state.overlay as { diff: { scroll: number } }).diff.scroll).toBe(1);
    for (let i = 0; i < 20; i++) state = press(state, 'pagedown').state;
    const { scroll, lines } = (state.overlay as { diff: { scroll: number; lines: string[] } }).diff;
    expect(scroll).toBeGreaterThan(0);
    expect(scroll).toBeLessThan(lines.length);
    state = press(state, 'pageup').state;
    expect((state.overlay as { diff: { scroll: number } }).diff.scroll).toBeLessThan(scroll);
  });

  it('a wheel notch scrolls the diff, not the panes behind it', () => {
    const state = press(viewing(), 'scrolldown').state;

    expect((state.overlay as { diff: { scroll: number } }).diff.scroll).toBeGreaterThan(0);
    expect(state.scroll).toBe(0);
  });

  it('escape goes back to the actions, and a second escape closes', () => {
    const back = press(viewing(), 'escape').state;
    expect(back.overlay).toMatchObject({ kind: 'handoff', diff: null });
    expect(press(back, 'escape').state.overlay).toBeNull();
  });

  it('an empty diff is a notice, not a blank screen', () => {
    const { state } = apply(session({ handoff }), { type: 'handoffDiff', diff: '\n', sessionId: 's1' });

    expect(state.overlay).toBeNull();
    expect(lastMessage(state)?.content).toMatch(/Nothing differs from abcdef12/);
  });
});

describe('isolation_blocked', () => {
  const blocked = (): TuiState => apply(session(), { type: 'isolationBlocked', message: 'Tracked files have uncommitted changes', sessionId: 's1' }).state;

  it('asks how to go on, and says why', () => {
    const state = blocked();

    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'isolation-blocked' }, hint: 'Tracked files have uncommitted changes' } });
    expect((state.overlay as { picker: { items: { label: string }[] } }).picker.items.map((i) => i.label)).toEqual([
      'Stash and continue', 'Run without isolation', 'Cancel',
    ]);
  });

  it('Stash and continue replays the run after stashing', () => {
    const { state, effects } = press(blocked(), 'enter');

    expect(effects).toEqual([{ type: 'isolationContinue', sessionId: 's1', mode: 'stash' }]);
    expect(state.overlay).toBeNull();
  });

  it('Run without isolation replays it in the working tree', () => {
    const { effects } = press(press(blocked(), 'down').state, 'enter');

    expect(effects).toEqual([{ type: 'isolationContinue', sessionId: 's1', mode: 'shared' }]);
  });

  it('Cancel stops the parked run rather than leaving it swallowing the next /run', () => {
    let state = blocked();
    for (let i = 0; i < 2; i++) state = press(state, 'down').state;

    expect(press(state, 'enter').effects).toEqual([{ type: 'stopExecution', sessionId: 's1' }]);
  });

  it('escape is Cancel', () => {
    expect(press(blocked(), 'escape').effects).toEqual([{ type: 'stopExecution', sessionId: 's1' }]);
  });

  it("ignores another session's block", () => {
    expect(apply(session(), { type: 'isolationBlocked', message: 'm', sessionId: 'other' }).state.overlay).toBeNull();
  });
});

describe('discarding', () => {
  it('clears the handoff, the marks, and only its own overlay', () => {
    const before = withHandoff({
      tasks: [task({ isolation: { state: 'conflict', branch: 'b', worktree: 'w' } })],
      overlay: { kind: 'handoff', index: 2, diff: null },
    });

    const { state } = apply(before, { type: 'handoffDiscarded', sessionId: 's1' });

    expect(state.handoff).toBeNull();
    expect(state.tasks[0].isolation).toBeUndefined();
    expect(state.overlay).toBeNull();
  });
});

describe('per-task isolation on the plan', () => {
  const conflict = { state: 'conflict' as const, branch: 'ordewell/r1/2-t2', worktree: '/w/2-t2' };

  it('takes each task\'s isolation from the status stream', () => {
    const { state } = apply(session({ tasks: [task({ id: 't2', status: 'awaiting_user' })] }), {
      type: 'tasksStatus', sessionId: 's1', updates: { t2: { status: 'awaiting_user', isolation: conflict } },
    });

    expect(state.tasks[0].isolation).toEqual(conflict);
  });

  it('notices an isolation change even when the status did not', () => {
    const before = session({ tasks: [task({ id: 't2', status: 'awaiting_user', isolation: { state: 'active', branch: 'b', worktree: 'w' } })] });

    const { state } = apply(before, { type: 'tasksStatus', sessionId: 's1', updates: { t2: { status: 'awaiting_user', isolation: conflict } } });

    expect(state.tasks[0].isolation?.state).toBe('conflict');
  });

  it('keeps what the stream reported across a plan refresh that says nothing about isolation', () => {
    const before = session({ tasks: [task({ id: 't2', isolation: conflict })] });

    const { state } = apply(before, { type: 'planUpdated', sessionId: 's1', plan: { tasks: [{ id: 't2', order: 2, title: 'T2', type: 'ai', status: 'awaiting_user' }] } });

    expect(state.tasks[0].isolation).toEqual(conflict);
  });

  const savedPlan = {
    tasks: [{ id: 't2', order: 2, title: 'T2', type: 'ai', status: 'awaiting_user' }, { id: 't3', order: 3, title: 'T3', type: 'ai', status: 'pending' }],
    isolation: {
      resolvers: {},
      run: {
        id: 'r1', workspaceRoot: '/ws', baseRef: 'abc', integrationBranch: 'ordewell/r1/integration',
        tasks: { t2: { taskId: 't2', order: 2, title: 'T2', branch: 'ordewell/r1/2-t2', worktree: '/w/2-t2', status: 'conflict', linked: [] } },
      },
    },
  };

  it('reads a saved plan\'s run record, so a reloaded session shows its conflict and its handoff', () => {
    const { state } = apply(session(), { type: 'planUpdated', sessionId: 's1', plan: savedPlan });

    expect(state.tasks.map((t) => t.isolation?.state)).toEqual(['conflict', 'none']);
    expect(state.handoff).toMatchObject({ branch: 'ordewell/r1/integration', baseRef: 'abc', landed: [] });
  });

  it('a fork holds no run: switching to one drops the original\'s handoff and marks', () => {
    const original = withHandoff({ tasks: [task({ isolation: conflict })] });

    const forked = apply(original, { type: 'sessionForked', sessionId: 's2', goal: 'g' }).state;
    const { state } = apply(forked, { type: 'planUpdated', sessionId: 's2', plan: { tasks: [{ id: 't1', order: 1, title: 'T1', type: 'ai', status: 'completed' }] } });

    expect(state.handoff).toBeNull();
    expect(state.tasks[0].isolation).toBeUndefined();
  });

  it('a new or loaded session inherits nothing from the last one', () => {
    const before = withHandoff({ tasks: [task({ id: 't1', isolation: conflict })] });

    const started = apply(before, { type: 'sessionStarted', sessionId: 's9', goal: 'g' }).state;
    const { state } = apply(started, { type: 'planUpdated', sessionId: 's9', plan: { tasks: [{ id: 't1', order: 1, title: 'Other', type: 'ai', status: 'pending' }] } });

    expect(state.handoff).toBeNull();
    expect(state.tasks[0].isolation).toBeUndefined();
  });
});

describe('resolving a conflict', () => {
  const conflicted = (): TuiState => session({
    focus: 'plan',
    tasks: [task({ id: 't2', order: 2, status: 'awaiting_user', isolation: { state: 'conflict', branch: 'b', worktree: 'w' } })],
  });

  it('x on a conflicted task asks the daemon to add a resolver task', () => {
    expect(press(conflicted(), 'char', 'x').effects).toEqual([{ type: 'resolveConflict', sessionId: 's1', taskId: 't2' }]);
  });

  it('x does nothing on a task without a conflict', () => {
    const quiet = session({ focus: 'plan', tasks: [task({ isolation: { state: 'active', branch: 'b', worktree: 'w' } })] });

    expect(press(quiet, 'char', 'x').effects).toEqual([]);
  });
});
