import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import type { HandoffView, TaskView, TuiState } from '../state';
import { lastMessage } from './chat';

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));
const apply = (state: TuiState, action: Action): Step => reduce(state, action);

const handoff: HandoffView = {
  repos: [{
    path: '.',
    integrationBranch: 'ordewell/r1/integration',
    baseRef: 'abcdef1234567890',
    baseBranch: 'main',
    landed: [{ taskId: 't1', order: 1, title: 'Add the route' }, { taskId: 't2', order: 2, title: 'Write the tests' }],
  }],
  landed: [{ taskId: 't1', order: 1, title: 'Add the route' }, { taskId: 't2', order: 2, title: 'Write the tests' }],
};

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Add the route', type: 'ai', status: 'completed', dependencies: [], ...over,
});

const session = (over: Partial<TuiState> = {}): TuiState => initialState({ sessionId: 's1', rows: 30, cols: 80, ...over });
const withHandoff = (over: Partial<TuiState> = {}): TuiState => session({ handoff, ...over });

function typed(state: TuiState, text: string): Step {
  return reduce({ ...state, editor: { ...state.editor, text, cursor: text.length } }, key('enter'));
}

describe('isolation_handoff', () => {
  it('records the handoff, says so, and opens the overlay on an otherwise quiet screen', () => {
    const { state } = apply(session(), { type: 'isolationHandoff', handoff, sessionId: 's1' });

    expect(state.handoff).toEqual(handoff);
    expect(state.overlay).toEqual({ kind: 'handoff', index: 0, diff: null });
    expect(lastMessage(state)?.text).toMatch(/ordewell\/r1\/integration: 2 tasks landed/);
  });

  it('does not take over a screen that already has an overlay', () => {
    const { state } = apply(session({ overlay: { kind: 'help' } }), { type: 'isolationHandoff', handoff, sessionId: 's1' });

    expect(state.overlay).toEqual({ kind: 'help' });
    expect(state.handoff).toEqual(handoff);
    expect(lastMessage(state)?.text).toMatch(/\/handoff/);
  });

  it('stores a handoff deferred to the supervisor and says so, without opening the overlay', () => {
    const deferred: HandoffView = { ...handoff, deferredTo: 'supervisor' };

    const { state } = apply(session(), { type: 'isolationHandoff', handoff: deferred, sessionId: 's1' });

    expect(state.handoff).toEqual(deferred);
    expect(state.overlay).toBeNull();
    expect(lastMessage(state)?.text).toBe(
      'Run finished on ordewell/r1/integration: 2 tasks landed. The supervisor may merge it; /handoff to review it yourself.',
    );
  });

  it('keeps /handoff working while the handoff is deferred', () => {
    const deferred = withHandoff({ handoff: { ...handoff, deferredTo: 'supervisor' } });

    expect(typed(deferred, '/handoff').state.overlay).toEqual({ kind: 'handoff', index: 0, diff: null });
    expect(typed(deferred, '/handoff merge').state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'merge-run' } });
  });

  it('opens the overlay when the unmarked handoff for the same run follows, and says the supervisor left it', () => {
    const deferred = session({ handoff: { ...handoff, deferredTo: 'supervisor' } });

    const { state } = apply(deferred, { type: 'isolationHandoff', handoff, sessionId: 's1' });

    expect(state.handoff).toEqual(handoff);
    expect(state.overlay).toEqual({ kind: 'handoff', index: 0, diff: null });
    expect(lastMessage(state)?.text).toBe(
      'The supervisor left ordewell/r1/integration to you: 2 tasks landed. /handoff to review and land it.',
    );
  });

  it('leaves an overlay that is already open alone when the unmarked handoff follows', () => {
    const deferred = session({ handoff: { ...handoff, deferredTo: 'supervisor' }, overlay: { kind: 'help' } });

    const { state } = apply(deferred, { type: 'isolationHandoff', handoff, sessionId: 's1' });

    expect(state.overlay).toEqual({ kind: 'help' });
  });

  it('tells a new run\'s unmarked handoff apart from the deferred run before it', () => {
    const other: HandoffView = {
      ...handoff,
      repos: [{ ...handoff.repos[0], integrationBranch: 'ordewell/r2/integration' }],
    };
    const deferred = session({ handoff: { ...handoff, deferredTo: 'supervisor' } });

    const { state } = apply(deferred, { type: 'isolationHandoff', handoff: other, sessionId: 's1' });

    expect(lastMessage(state)?.text).toMatch(/^Run finished on ordewell\/r2\/integration/);
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
    expect(lastMessage(state)).toMatchObject({ role: 'error', text: expect.stringMatching(/No isolated run/) });
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
    expect(lastMessage(state)?.text).toMatch(/Usage: \/handoff/);
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
    expect((asked.state.overlay as { message: string }).message).toContain('ordewell/r1/integration into main.');
    expect((asked.state.overlay as { message: string }).message).toContain('Nothing is merged unless main is checked out.');
    expect((asked.state.overlay as { message: string }).message).toContain("Once it has merged, the run's worktrees and branches are removed unless a task still has work in its worktree that has not landed: then the run stays, and so does that work.");

    const confirmed = press(asked.state, 'enter');
    expect(confirmed.effects).toEqual([{ type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration' }]);
    expect(confirmed.state.overlay).toBeNull();
  });

  it('carries a repaired landed task on the merge effect, so the result can name it too (ADR-0015)', () => {
    const repaired = { ...handoff, landed: [{ ...handoff.landed[0], repairedFiles: ['a.ts'] }, handoff.landed[1]] };
    const asked = press(press(session({ handoff: repaired, overlay: { kind: 'handoff', index: 0, diff: null } }), 'down').state, 'enter');

    expect(press(asked.state, 'enter').effects).toEqual([
      { type: 'isolationMerge', sessionId: 's1', branch: 'ordewell/r1/integration', repaired: [{ ...handoff.landed[0], repairedFiles: ['a.ts'] }] },
    ]);
  });

  it('names a task that only landed after a conflict repair, before asking to merge (ADR-0015)', () => {
    const repaired = { ...handoff, landed: [{ ...handoff.landed[0], repairedFiles: ['a.ts'] }, handoff.landed[1]] };
    const asked = press(press(session({ handoff: repaired, overlay: { kind: 'handoff', index: 0, diff: null } }), 'down').state, 'enter');

    expect((asked.state.overlay as { message: string }).message).toContain('Add the route (a.ts) landed through a conflict repair.');
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
    expect(lastMessage(state)?.text).toMatch(/Nothing differs from main @ abcdef12\./);
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

describe('the run closing', () => {
  it('clears the handoff, the marks, and only its own overlay', () => {
    const before = withHandoff({
      tasks: [task({ isolation: { state: 'conflict', branch: 'b', worktree: 'w', repos: [] } })],
      overlay: { kind: 'handoff', index: 2, diff: null },
    });

    const { state } = apply(before, { type: 'runClosed', sessionId: 's1' });

    expect(state.handoff).toBeNull();
    expect(state.tasks[0].isolation).toBeUndefined();
    expect(state.overlay).toBeNull();
  });

  it('leaves an overlay opened since alone', () => {
    const { state } = apply(withHandoff({ overlay: { kind: 'help' } }), { type: 'runClosed', sessionId: 's1' });

    expect(state.overlay).toEqual({ kind: 'help' });
  });
});

describe('a Merge all that leaves the run open', () => {
  const landing = { state: 'integrated' as const, branch: 'ordewell/r1/1-t1', worktree: '/w/1', repos: ['.'] };

  it('keeps every task\'s isolation, and drops what it merged from the handoff, its overlay and the merge view', () => {
    const before = withHandoff({
      tasks: [task({ isolation: landing })],
      runMerge: { waitingAtGate: true, paused: false, handoff },
      overlay: { kind: 'handoff', index: 0, diff: null },
    });

    const { state } = apply(before, { type: 'isolationMerged', result: { outcome: 'merged' }, sessionId: 's1' });

    expect(state.tasks[0].isolation).toEqual(landing);
    expect(state.handoff).toBeNull();
    expect(state.runMerge).toBeNull();
    expect(state.overlay).toBeNull();
  });
});

describe('a merge while the handoff is deferred', () => {
  it('clears the handoff and closes the overlay, as a merge from any source does', () => {
    const before = withHandoff({
      handoff: { ...handoff, deferredTo: 'supervisor' },
      overlay: { kind: 'handoff', index: 0, diff: null },
    });

    const { state } = apply(before, { type: 'runClosed', sessionId: 's1' });

    expect(state.handoff).toBeNull();
    expect(state.overlay).toBeNull();
  });
});

describe('per-task isolation on the plan', () => {
  const conflict = { state: 'conflict' as const, branch: 'ordewell/r1/2-t2', worktree: '/w/2-t2', repos: [] };

  it('takes each task\'s isolation from the status stream', () => {
    const { state } = apply(session({ tasks: [task({ id: 't2', status: 'awaiting_user' })] }), {
      type: 'statusUpdate', sessionId: 's1', tasks: [{ id: 't2', status: 'awaiting_user', verdict: null, isolation: conflict }],
    });

    expect(state.tasks[0].isolation).toEqual(conflict);
  });

  it('notices a repair attempt or its repaired files changing even when the state did not (ADR-0015)', () => {
    const repairing = { state: 'repairing' as const, branch: 'b', worktree: 'w', repos: [], repair: { attempt: 1, limit: 2 } };
    const before = session({ tasks: [task({ id: 't2', status: 'in_progress', isolation: repairing })] });

    const { state } = apply(before, {
      type: 'statusUpdate', sessionId: 's1',
      tasks: [{ id: 't2', status: 'in_progress', verdict: null, isolation: { ...repairing, repair: { attempt: 2, limit: 2 } } }],
    });

    expect(state.tasks[0].isolation).toEqual({ ...repairing, repair: { attempt: 2, limit: 2 } });
  });

  it('notices an isolation change even when the status did not', () => {
    const before = session({ tasks: [task({ id: 't2', status: 'awaiting_user', isolation: { state: 'active', branch: 'b', worktree: 'w', repos: [] } })] });

    const { state } = apply(before, { type: 'statusUpdate', sessionId: 's1', tasks: [{ id: 't2', status: 'awaiting_user', verdict: null, isolation: conflict }] });

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

  it('takes isolation from the Session\'s run view, not from the run record a saved plan carries', () => {
    const planned = apply(session(), { type: 'planUpdated', sessionId: 's1', plan: savedPlan }).state;
    expect(planned.tasks.map((t) => t.isolation)).toEqual([undefined, undefined]);
    expect(planned.handoff).toBeNull();

    const view = {
      ...planned.run,
      tasks: planned.run.tasks.map((t) => (t.id === 't2' ? { ...t, isolation: conflict } : t)),
      handoff: { ...handoff, deferredTo: 'supervisor' as const },
    };
    const { state } = apply(planned, { type: 'runSnapshot', view, sessionId: 's1' });

    expect(state.tasks.map((t) => t.isolation?.state)).toEqual(['conflict', undefined]);
    expect(state.handoff).toMatchObject({ deferredTo: 'supervisor' });
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
    tasks: [task({ id: 't2', order: 2, status: 'awaiting_user', isolation: { state: 'conflict', branch: 'b', worktree: 'w', repos: [] } })],
  });

  it('x on a conflicted task asks the daemon to add a resolver task', () => {
    expect(press(conflicted(), 'char', 'x').effects).toEqual([{ type: 'resolveConflict', sessionId: 's1', taskId: 't2', watch: true }]);
  });

  it('opens no second stream for the resolver in a run that holds one', () => {
    expect(press({ ...conflicted(), status: 'executing' }, 'char', 'x').effects).toEqual([{ type: 'resolveConflict', sessionId: 's1', taskId: 't2' }]);
  });

  it('asks the daemon even on a repair waiting to start, so the refusal says how to take it back', () => {
    const waiting = session({ focus: 'plan', tasks: [task({ id: 't2', order: 2, status: 'pending', isolation: { state: 'conflict', branch: 'b', worktree: 'w', repos: [], repairWaits: 'slot' } })] });

    expect(press(waiting, 'char', 'x').effects).toEqual([expect.objectContaining({ type: 'resolveConflict', taskId: 't2' })]);
  });

  it('c on a repair waiting to start stops it', () => {
    const waiting = session({ focus: 'plan', tasks: [task({ id: 't2', order: 2, status: 'pending', isolation: { state: 'conflict', branch: 'b', worktree: 'w', repos: [], repairWaits: 'slot' } })] });

    expect(press(waiting, 'char', 'c').effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't2', action: 'cancel' }]);
  });

  it('x does nothing on a task without a conflict', () => {
    const quiet = session({ focus: 'plan', tasks: [task({ isolation: { state: 'active', branch: 'b', worktree: 'w', repos: [] } })] });

    expect(press(quiet, 'char', 'x').effects).toEqual([]);
  });
});

describe('a run over a repo group', () => {
  const t = (order: number) => ({ taskId: `t${order}`, order, title: `Task ${order}` });
  const branch = 'ordewell/r1/integration';
  const group: HandoffView = {
    repos: [
      { path: 'api', integrationBranch: branch, baseRef: 'aaaaaaaa', baseBranch: 'main', landed: [t(1), t(2)] },
      { path: 'web', integrationBranch: branch, baseRef: 'bbbbbbbb', baseBranch: 'main', landed: [t(2)] },
      { path: 'infra', integrationBranch: branch, baseRef: 'cccccccc', landed: [] },
    ],
    landed: [t(1), t(2)],
  };
  const inGroup = (over: Partial<TuiState> = {}): TuiState => session({ handoff: group, ...over });

  it('says which repos the run finished in when it arrives', () => {
    const { state } = apply(session(), { type: 'isolationHandoff', handoff: group, sessionId: 's1' });

    expect(lastMessage(state)?.text).toBe(`Run finished on ${branch} in api, web, infra: 2 tasks landed. /handoff to review and land it.`);
  });

  it('asks before Merge all, naming the repos it will merge and that it merges none unless all can', () => {
    const { state, effects } = typed(inGroup(), '/handoff merge');

    expect(effects).toEqual([]);
    const overlay = state.overlay as { title: string; message: string; action: { kind: string } };
    expect(overlay.title).toBe('Merge all into your branches?');
    expect(overlay.message).toContain('into main in each of api, web.');
    expect(overlay.message).toContain('Nothing is merged unless each repository is on the branch it started on.');
    expect(overlay.message).not.toContain('infra');
    expect(overlay.message).toMatch(/unless every repository can take it/);
    expect(overlay.message).toContain("Once every repository has merged, the run's worktrees and branches are removed unless a task still has work in its worktree that has not landed: then the run stays, and so does that work.");
    expect(overlay.action).toEqual({ kind: 'merge-run' });
  });

  it('sends the merge with the group marked, so its answer is worded for a group', () => {
    const asked = typed(inGroup(), '/handoff merge');

    expect(press(asked.state, 'enter').effects).toEqual([{ type: 'isolationMerge', sessionId: 's1', branch, group: true }]);
  });

  it('asks before discarding, naming every repo', () => {
    const { state } = typed(inGroup(), '/handoff discard');

    expect((state.overlay as { message: string }).message).toContain('in api, web, infra');
  });

  it('cleans up with the branch, as for one repo', () => {
    expect(typed(inGroup(), '/handoff cleanup').effects).toEqual([{ type: 'isolationCleanup', sessionId: 's1', branch }]);
  });

  it('names the dirty repos in the stash choice, which stashes all of them', () => {
    const { state } = apply(session(), { type: 'isolationBlocked', message: 'dirty in api, web', repos: ['api', 'web'], sessionId: 's1' });

    const items = (state.overlay as { picker: { items: { id: string; detail?: string }[] } }).picker.items;
    expect(items.find((i) => i.id === 'stash')?.detail).toBe('git stash the tracked changes in api, web, then run in worktrees');
    expect(items.find((i) => i.id === 'shared')?.detail).toBe('this run only, in your working tree');
  });
});
